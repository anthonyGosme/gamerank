import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { clickhouse } from './clickhouse.js';
import { config } from './config.js';
import { currentDeveloper } from './auth.js';

// Observabilité interne (US-8.0) : réservée aux emails de ADMIN_EMAILS.
// Réponse 404 (et non 403) pour ne pas révéler l'existence de la route.
export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/overview', async (request, reply) => {
    const developer = await currentDeveloper(request);
    if (!developer || !config.adminEmails.includes(developer.email)) {
      return reply.code(404).send({ error: 'not found' });
    }

    const { rows: games } = await pool.query(
      `SELECT g.id, g.name, g.domain, g.status, g.last_event_at AS "lastEventAt",
              g.created_at AS "createdAt", d.email AS "developerEmail"
         FROM games g
         JOIN developers d ON d.id = g.developer_id
        ORDER BY g.created_at DESC`,
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

    return { games, stats, recent };
  });
}
