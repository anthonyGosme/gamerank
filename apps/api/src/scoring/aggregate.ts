import { clickhouse } from '../clickhouse.js';

// Étage 1 (CDC §11) : événements bruts (TTL 3 j) → agrégats quotidiens
// (TTL 45 j). Ré-agrège toute la fenêtre des événements à chaque passe :
// idempotent grâce à ReplacingMergeTree (la dernière version gagne).
export async function runAggregation(): Promise<void> {
  await clickhouse.command({
    query: `
      INSERT INTO daily_activity
      SELECT game_id,
             visitor_id,
             toDate(ts)                                AS day,
             sum(active_ms)                            AS active_ms,
             countIf(event_type = 'session_start')     AS sessions,
             countIf(event_type = 'load')              AS loads,
             any(ip)                                   AS ip,
             toUInt32(now())                           AS ver
        FROM events
       GROUP BY game_id, visitor_id, day
    `,
  });

  await clickhouse.command({
    query: `
      INSERT INTO daily_sessions
      SELECT game_id,
             session_id,
             toDate(min(ts))  AS day,
             sum(active_ms)   AS active_ms,
             toUInt32(now())  AS ver
        FROM events
       WHERE session_id <> ''
       GROUP BY game_id, session_id
    `,
  });
}
