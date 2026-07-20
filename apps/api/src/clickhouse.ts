import { createClient } from '@clickhouse/client';
import { config } from './config.js';

export const clickhouse = createClient({
  url: config.clickhouseUrl,
  username: config.clickhouseUser,
  password: config.clickhousePassword,
  database: config.clickhouseDb,
});

// Schéma idempotent, appliqué au démarrage (CDC §11 : rétention brute 2-3 j via TTL).
export async function ensureClickhouseSchema(): Promise<void> {
  await clickhouse.command({
    query: `
      CREATE TABLE IF NOT EXISTS events (
        game_id     UUID,
        visitor_id  String,
        session_id  String,
        event_type  LowCardinality(String),
        active_ms   UInt32,
        ip          String,
        user_agent  String,
        sdk_version LowCardinality(String),
        ts          DateTime DEFAULT now()
      )
      ENGINE = MergeTree
      ORDER BY (game_id, ts)
      TTL ts + INTERVAL 3 DAY
    `,
  });
}
