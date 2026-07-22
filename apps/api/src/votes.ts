import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { clickhouse } from './clickhouse.js';
import { config } from './config.js';
import { matchesDeclaredDomain } from './ingest.js';

// Jeton de vote one-shot : stocké haché (un vol de la base ne donne pas de jetons
// utilisables).
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const escapeXml = escapeHtml;

async function publicGame(id: string): Promise<Record<string, string> | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT id, name, url, domain, description, thumbnail_url AS "thumbnailUrl", status,
            badge_color AS "badgeColor", current_score AS "currentScore"
       FROM games WHERE id = $1 AND status <> 'hidden'`,
    [id],
  );
  return rows[0] ?? null;
}

// Couleur de texte lisible sur la couleur principale choisie (luminance YIQ).
function contrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 140 ? '#111827' : '#ffffff';
}

// Temps actif total du visiteur sur ce jeu (fenêtre = rétention brute CH).
async function visitorActiveMs(gameId: string, visitorId: string): Promise<number> {
  const result = await clickhouse.query({
    query: `SELECT sum(active_ms) AS total FROM events
             WHERE game_id = {gameId:String} AND visitor_id = {visitorId:String}`,
    query_params: { gameId, visitorId },
    format: 'JSONEachRow',
  });
  const [row] = await result.json<{ total: string | null }>();
  return Number(row?.total ?? 0);
}

export function registerVoteRoutes(app: FastifyInstance): void {
  // Badge SVG public (US-4.3) : taille fixe, score « NEW » tant que le
  // scoring (épic 7) n'existe pas. Fonctionne sans JavaScript.
  // ?arrows=1 dessine les flèches (préview + widget après 5 s de jeu) ;
  // ?voted=1|-1 met en avant la flèche votée. Couleurs dérivées de la
  // couleur principale du jeu pour garantir le contraste.
  app.get('/games/:id/badge.svg', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { arrows, voted, bg, fg } = request.query as {
      arrows?: string;
      voted?: string;
      bg?: string;
      fg?: string;
    };
    const game = await publicGame(id);
    if (!game) return reply.code(404).send();

    // Le webmaster peut forcer les couleurs via ?bg= / ?fg= (hex sans #) dans
    // l'URL de l'image ; sinon la couleur choisie par le dev ; sinon un fond
    // sombre par défaut qui reste visible sur n'importe quelle page.
    const hex = (value?: string) =>
      value && /^[0-9a-fA-F]{6}$/.test(value) ? `#${value}` : null;
    const background = hex(bg) ?? game.badgeColor ?? '#111827';
    const foreground = hex(fg) ?? contrastColor(background);
    // Score affiché dès qu'il existe ; « NEW » tant qu'aucun calcul n'a eu lieu.
    const score =
      game.currentScore != null ? String(Math.round(Number(game.currentScore))) : 'NEW';

    let arrowsSvg = '';
    if (arrows === '1') {
      const arrow = (x: number, glyph: string, isVoted: boolean) =>
        (isVoted ? `<circle cx="${x}" cy="20" r="11" fill="${foreground}" opacity="0.18"/>` : '') +
        `<text x="${x}" y="24" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="${foreground}" opacity="${isVoted ? '1' : '0.55'}">${glyph}</text>`;
      arrowsSvg = arrow(18, '▼', voted === '-1') + arrow(162, '▲', voted === '1');
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40" viewBox="0 0 180 40" role="img" aria-label="WebGameRank rating of ${escapeXml(game.name)}">
  <rect width="180" height="40" rx="7" fill="${background}"/>
  <text x="90" y="14" text-anchor="middle" font-family="system-ui,sans-serif" font-size="7" letter-spacing="1.5" fill="${foreground}" opacity="0.6">WEBGAMERANK</text>
  <text x="90" y="30" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="${foreground}">${score}</text>
  ${arrowsSvg}
</svg>`;
    return reply
      .type('image/svg+xml')
      .header('Cache-Control', 'public, max-age=300')
      .send(svg);
  });

  // La fiche publique /g/:id est servie par public.ts (épic 5).

  // Vote 👍/👎 (US-4.3) : un par visiteur et par jeu, le dernier remplace.
  // Émission d'un jeton one-shot. Le SDK ne l'appelle qu'au clic RÉEL sur le
  // widget → un vote légitime = un clic. Casse curl/Postman (il faut 2 requêtes
  // et un jeton frais par vote) et le replay.
  app.post('/api/vote-token', async (request, reply) => {
    const raw = request.body;
    let body: { key?: unknown };
    try {
      body = typeof raw === 'string' ? JSON.parse(raw) : ((raw ?? {}) as typeof body);
    } catch {
      return reply.code(400).send({ error: 'invalid body' });
    }
    const key = typeof body.key === 'string' ? body.key : null;
    if (!key) return reply.code(400).send({ error: 'invalid request' });

    const { rows: games } = await pool.query(
      `SELECT id, domain FROM games WHERE sdk_key = $1 AND status <> 'hidden'`,
      [key],
    );
    if (games.length === 0) return reply.code(404).send({ error: 'unknown game' });
    const game = games[0] as { id: string; domain: string };
    if (!matchesDeclaredDomain(request, game.domain)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }

    // Purge opportuniste des jetons expirés (table bornée, index sur expires_at).
    await pool.query('DELETE FROM vote_tokens WHERE expires_at < now()');

    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO vote_tokens (token_hash, game_id, request_ip, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [hashToken(token), game.id, request.ip, config.voteTokenTtlSeconds],
    );
    return { token };
  });

  app.post('/api/vote', async (request, reply) => {
    const raw = request.body;
    let body: { key?: unknown; visitorId?: unknown; value?: unknown; token?: unknown };
    try {
      body = typeof raw === 'string' ? JSON.parse(raw) : ((raw ?? {}) as typeof body);
    } catch {
      return reply.code(400).send({ error: 'invalid body' });
    }

    const key = typeof body.key === 'string' ? body.key : null;
    const visitorId =
      typeof body.visitorId === 'string' && body.visitorId.length > 0 && body.visitorId.length <= 64
        ? body.visitorId
        : null;
    const value = body.value === 1 || body.value === -1 ? body.value : null;
    if (!key || !visitorId || !value) return reply.code(400).send({ error: 'invalid vote' });

    const { rows: games } = await pool.query(
      `SELECT id, domain FROM games WHERE sdk_key = $1 AND status <> 'hidden'`,
      [key],
    );
    if (games.length === 0) return reply.code(404).send({ error: 'unknown game' });
    const game = games[0] as { id: string; domain: string };

    if (!matchesDeclaredDomain(request, game.domain)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }

    // Jeton one-shot exigé (anti-triche couche 1). Consommation atomique :
    // usage unique, lié à CE jeu, non expiré. Échoue si absent/réutilisé/périmé.
    const token = typeof body.token === 'string' ? body.token : null;
    if (!token) return reply.code(403).send({ error: 'missing vote token' });
    const consumed = await pool.query(
      `UPDATE vote_tokens SET used_at = now()
        WHERE token_hash = $1 AND game_id = $2 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token), game.id],
    );
    if (consumed.rowCount === 0) {
      return reply.code(403).send({ error: 'invalid or expired vote token' });
    }

    // Éligibilité : temps de jeu actif vérifié par le SDK (CDC §7.2).
    const activeMs = await visitorActiveMs(game.id, visitorId);
    if (activeMs < config.voteMinActiveMs) {
      return reply.code(403).send({ error: 'keep playing before voting' });
    }

    // Changement de vote : au plus une fois par période de refroidissement.
    const { rows: existing } = await pool.query(
      `SELECT value,
              updated_at > now() - make_interval(hours => $3) AS in_cooldown,
              ceil(extract(epoch FROM updated_at + make_interval(hours => $3) - now()) / 3600) AS hours_left
         FROM votes WHERE game_id = $1 AND visitor_id = $2`,
      [game.id, visitorId, config.voteChangeCooldownHours],
    );
    if (existing.length > 0) {
      if (existing[0].value === value) return { ok: true, value }; // même vote : idempotent
      if (existing[0].in_cooldown) {
        return reply
          .code(429)
          .send({ error: `you can change your vote in ${existing[0].hours_left}h` });
      }
    } else if (config.voteOnePerIp) {
      // Nouveau visitorId : refuse si une AUTRE identité de la même IP a déjà
      // voté ce jeu (re-vote après reset du localStorage). ⚠️ IP partagée = 1 vote.
      const { rows: sameNet } = await pool.query(
        `SELECT 1 FROM votes
          WHERE game_id = $1 AND host(ip) = host($2::inet) AND visitor_id <> $3 LIMIT 1`,
        [game.id, request.ip, visitorId],
      );
      if (sameNet.length > 0) {
        return reply.code(409).send({ error: 'a vote from your network is already counted' });
      }
    }

    await pool.query(
      `INSERT INTO votes (game_id, visitor_id, value, ip)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (game_id, visitor_id)
       DO UPDATE SET value = EXCLUDED.value, ip = EXCLUDED.ip, updated_at = now()`,
      [game.id, visitorId, value, request.ip],
    );
    return { ok: true, value };
  });
}
