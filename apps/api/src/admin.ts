import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { clickhouse } from './clickhouse.js';
import { config } from './config.js';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { currentDeveloper } from './auth.js';
import { runPipeline } from './scoring/score.js';
import { uploadsDir } from './games.js';

async function isAdmin(request: Parameters<typeof currentDeveloper>[0]): Promise<boolean> {
  const developer = await currentDeveloper(request);
  return !!developer && config.adminEmails.includes(developer.email);
}

const NOT_FOUND = { error: 'not found' };

// Observabilité interne (US-8.0) : réservée aux emails de ADMIN_EMAILS.
// Réponse 404 (et non 403) pour ne pas révéler l'existence de la route.
export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/overview', async (request, reply) => {
    if (!(await isAdmin(request))) {
      return reply.code(404).send({ error: 'not found' });
    }

    const { rows: games } = await pool.query(
      `SELECT g.id, g.name, g.domain, g.status, g.last_event_at AS "lastEventAt",
              g.current_score AS "currentScore", g.current_rank AS "currentRank",
              g.created_at AS "createdAt", d.email AS "developerEmail"
         FROM games g
         JOIN developers d ON d.id = g.developer_id
        ORDER BY g.current_rank NULLS LAST, g.created_at DESC`,
    );

    const { rows: runs } = await pool.query(
      `SELECT id, started_at AS "startedAt", duration_ms AS "durationMs",
              status, error, games_count AS "gamesCount"
         FROM score_runs ORDER BY started_at DESC LIMIT 20`,
    );

    let stats: unknown[] = [];
    let recent: unknown[] = [];
    try {
      const statsResult = await clickhouse.query({
        query: `
          SELECT toString(game_id)        AS "gameId",
                 toString(count())        AS events,
                 toString(uniqExact(visitor_id)) AS visitors,
                 toString(sum(active_ms)) AS "activeMs"
            FROM events
           WHERE ts > now() - INTERVAL 1 DAY
           GROUP BY game_id`,
        format: 'JSONEachRow',
      });
      stats = await statsResult.json();

      const recentResult = await clickhouse.query({
        query: `
          SELECT toString(ts) AS ts, toString(game_id) AS "gameId", event_type AS type,
                 visitor_id AS "visitorId", session_id AS "sessionId",
                 active_ms AS "activeMs", ip, sdk_version AS "sdkVersion"
            FROM events
           ORDER BY ts DESC
           LIMIT 30`,
        format: 'JSONEachRow',
      });
      recent = await recentResult.json();
    } catch (err) {
      request.log.warn({ err }, 'clickhouse unavailable for admin overview');
    }

    return { games, stats, recent, runs };
  });

  // Détail d'un jeu pour l'admin (email dev, votes, clics) — alimente le
  // panneau admin injecté sur la page publique du jeu (US-8.1).
  app.get('/api/admin/games/:id', async (request, reply) => {
    if (!(await isAdmin(request))) return reply.code(404).send(NOT_FOUND);
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send(NOT_FOUND);
    const { rows } = await pool.query(
      `SELECT g.status, g.play_clicks AS "playClicks", d.email AS "developerEmail",
              count(v.*) FILTER (WHERE v.value = 1)::int AS "votesUp",
              count(v.*) FILTER (WHERE v.value = -1)::int AS "votesDown"
         FROM games g
         JOIN developers d ON d.id = g.developer_id
         LEFT JOIN votes v ON v.game_id = g.id
        WHERE g.id = $1
        GROUP BY g.id, d.email`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send(NOT_FOUND);
    return rows[0];
  });

  // Masquer un jeu du site public (réversible) — US-8.2.
  app.post('/api/admin/games/:id/hide', async (request, reply) => {
    if (!(await isAdmin(request))) return reply.code(404).send(NOT_FOUND);
    const { id } = request.params as { id: string };
    const { rowCount } = await pool.query(`UPDATE games SET status = 'hidden' WHERE id = $1`, [id]);
    return rowCount ? { ok: true } : reply.code(404).send(NOT_FOUND);
  });

  // Supprimer n'importe quel jeu (admin) — vignette et votes partent en cascade.
  app.delete('/api/admin/games/:id', async (request, reply) => {
    if (!(await isAdmin(request))) return reply.code(404).send(NOT_FOUND);
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `DELETE FROM games WHERE id = $1 RETURNING thumbnail_url AS "thumbnailUrl"`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send(NOT_FOUND);
    const thumbnailUrl: string = rows[0].thumbnailUrl ?? '';
    if (thumbnailUrl.startsWith('/uploads/')) {
      await unlink(path.join(uploadsDir, path.basename(thumbnailUrl))).catch(() => {});
    }
    return { ok: true };
  });

  // Recalcul à la demande (épic 7) — la durée mesurée aide à régler la cadence.
  app.post('/api/admin/recompute', async (request, reply) => {
    if (!(await isAdmin(request))) {
      return reply.code(404).send({ error: 'not found' });
    }
    const summary = await runPipeline();
    if (!summary) return reply.code(409).send({ error: 'a pipeline run is already in progress' });
    return summary;
  });
}
