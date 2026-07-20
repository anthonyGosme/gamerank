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

  // Agrégats quotidiens (CDC §11 : rétention 40-45 j). ReplacingMergeTree :
  // la ré-agrégation est idempotente, la dernière version (ver) gagne.
  await clickhouse.command({
    query: `
      CREATE TABLE IF NOT EXISTS daily_activity (
        game_id    UUID,
        visitor_id String,
        day        Date,
        active_ms  UInt64,
        sessions   UInt32,
        loads      UInt32,
        ip         String,
        ver        UInt32
      )
      ENGINE = ReplacingMergeTree(ver)
      ORDER BY (game_id, visitor_id, day)
      TTL day + INTERVAL 45 DAY
    `,
  });
  await clickhouse.command({
    query: `
      CREATE TABLE IF NOT EXISTS daily_sessions (
        game_id    UUID,
        session_id String,
        day        Date,
        active_ms  UInt64,
        ver        UInt32
      )
      ENGINE = ReplacingMergeTree(ver)
      ORDER BY (game_id, session_id, day)
      TTL day + INTERVAL 45 DAY
    `,
  });
}
