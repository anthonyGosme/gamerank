// Jury des pairs (épic 3, CDC §7.4). À l'inscription, un développeur joue les
// N derniers jeux en attente de jury et en élit K. Vérification par chronomètre
// (option B) : le temps de jeu est chronométré côté page de jury, pas via le SDK.
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { config } from './config.js';
import { currentDeveloper, type CurrentDeveloper } from './auth.js';
import { slugify } from './public.js';

async function requireDeveloper(
  request: Parameters<typeof currentDeveloper>[0],
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): Promise<CurrentDeveloper | null> {
  const developer = await currentDeveloper(request);
  if (!developer) {
    await reply.code(401).send({ error: 'not signed in' });
    return null;
  }
  return developer;
}

// Les jeux à juger : les N derniers `awaiting_jury`, hors ceux du développeur.
async function poolForJuror(developerId: string) {
  const { rows } = await pool.query(
    `SELECT id, name, url, category, thumbnail_url AS "thumbnailUrl",
            short_description AS "shortDescription"
       FROM games
      WHERE status = 'awaiting_jury' AND developer_id <> $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [developerId, config.scoring.juryGamesToJudge],
  );
  return rows as Array<{
    id: string;
    name: string;
    url: string;
    category: string;
    thumbnailUrl: string;
    shortDescription: string;
  }>;
}

export function registerJuryRoutes(app: FastifyInstance): void {
  // État du devoir de jury du développeur connecté (pour le dashboard/onboarding).
  app.get('/api/jury/status', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { rows } = await pool.query(
      `SELECT jury_completed_at AS "completedAt" FROM developers WHERE id = $1`,
      [developer.id],
    );
    const pool5 = await poolForJuror(developer.id);
    return {
      completedAt: rows[0]?.completedAt ?? null,
      poolSize: pool5.length,
      gamesToJudge: config.scoring.juryGamesToJudge,
      elections: config.scoring.juryElections,
    };
  });

  // Récupère (ou crée) le lot de jeux à juger pour ce développeur.
  app.get('/api/jury/assignment', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;

    // Déjà un lot en cours (non terminé) ? On le renvoie tel quel.
    const { rows: existing } = await pool.query(
      `SELECT jr.game_id AS "gameId", jr.played_ms AS "playedMs", jr.elected,
              g.name, g.url, g.category, g.thumbnail_url AS "thumbnailUrl",
              g.short_description AS "shortDescription"
         FROM jury_reviews jr JOIN games g ON g.id = jr.game_id
        WHERE jr.juror_id = $1 AND jr.completed_at IS NULL
        ORDER BY jr.assigned_at`,
      [developer.id],
    );
    if (existing.length > 0) {
      return { minPlayMs: config.scoring.juryMinPlayMs, elections: config.scoring.juryElections, games: existing };
    }

    // Sinon on assigne un nouveau lot depuis le pool.
    const games = await poolForJuror(developer.id);
    if (games.length < 2) {
      return reply.code(409).send({ error: 'not enough games to review yet — check back soon' });
    }
    const { rows: batchRow } = await pool.query(`SELECT gen_random_uuid() AS id`);
    const batchId = batchRow[0].id;
    for (const game of games) {
      await pool.query(
        `INSERT INTO jury_reviews (juror_id, game_id, batch_id) VALUES ($1, $2, $3)
         ON CONFLICT (juror_id, game_id) DO NOTHING`,
        [developer.id, game.id, batchId],
      );
    }
    return {
      minPlayMs: config.scoring.juryMinPlayMs,
      elections: config.scoring.juryElections,
      games: games.map((g) => ({ gameId: g.id, playedMs: 0, elected: false, ...g })),
    };
  });

  // Enregistre le temps joué sur un jeu du lot (chronomètre, option B).
  app.post('/api/jury/played', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { gameId, playedMs } = (request.body ?? {}) as { gameId?: string; playedMs?: number };
    if (!gameId || typeof playedMs !== 'number') {
      return reply.code(400).send({ error: 'gameId and playedMs required' });
    }
    await pool.query(
      `UPDATE jury_reviews SET played_ms = greatest(played_ms, $3)
        WHERE juror_id = $1 AND game_id = $2 AND completed_at IS NULL`,
      [developer.id, gameId, Math.min(Math.max(0, Math.round(playedMs)), 3_600_000)],
    );
    return { ok: true };
  });

  // Soumet les élections, clôt le devoir, met à jour les statuts.
  app.post('/api/jury/submit', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { elected } = (request.body ?? {}) as { elected?: string[] };
    if (!Array.isArray(elected) || elected.length !== config.scoring.juryElections) {
      return reply.code(400).send({ error: `elect exactly ${config.scoring.juryElections} games` });
    }

    const { rows: reviews } = await pool.query(
      `SELECT game_id AS "gameId", played_ms AS "playedMs"
         FROM jury_reviews WHERE juror_id = $1 AND completed_at IS NULL`,
      [developer.id],
    );
    if (reviews.length === 0) return reply.code(409).send({ error: 'no pending review' });
    // Tous les jeux doivent avoir été joués le minimum requis.
    const notPlayed = reviews.filter((r) => r.playedMs < config.scoring.juryMinPlayMs);
    if (notPlayed.length > 0) {
      return reply.code(403).send({ error: 'play each game a bit longer before voting' });
    }
    const validElected = elected.filter((id) => reviews.some((r) => r.gameId === id));
    if (validElected.length !== config.scoring.juryElections) {
      return reply.code(400).send({ error: 'elected games must be from your assignment' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE jury_reviews SET elected = (game_id = ANY($2::uuid[])), completed_at = now()
          WHERE juror_id = $1 AND completed_at IS NULL`,
        [developer.id, validElected],
      );
      // Chaque jeu jugé reçoit une présentation ; à N il passe « ranked ».
      await client.query(
        `UPDATE games SET jury_presentations = jury_presentations + 1
          WHERE id = ANY($1::uuid[])`,
        [reviews.map((r) => r.gameId)],
      );
      await client.query(
        `UPDATE games SET status = 'ranked'
          WHERE id = ANY($1::uuid[]) AND status = 'awaiting_jury'
            AND jury_presentations >= $2`,
        [reviews.map((r) => r.gameId), config.scoring.juryPresentationsToRank],
      );
      // Le développeur a fait son devoir : ses jeux passent en attente de jury.
      await client.query(
        `UPDATE developers SET jury_completed_at = now() WHERE id = $1`,
        [developer.id],
      );
      await client.query(
        `UPDATE games SET status = 'awaiting_jury'
          WHERE developer_id = $1 AND status = 'awaiting_peer_review'`,
        [developer.id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { ok: true };
  });
}

// Chemin public d'un jeu (repris du site public) pour les liens.
export function publicGamePath(id: string, name: string): string {
  return `/g/${id}/${slugify(name)}`;
}
