import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { clickhouse, ensureClickhouseSchema } from '../src/clickhouse.js';
import { pool } from '../src/db.js';
import { createDeveloper, createGame, uniqueId , cleanupCreated} from './helpers.js';

let app: FastifyInstance;
let game: { id: string; sdkKey: string; domain: string };

before(async () => {
  await ensureClickhouseSchema();
  app = await buildApp({ logger: false });
  const developer = await createDeveloper();
  game = await createGame(developer.id);
});

after(async () => {
  await cleanupCreated();
  await app.close();
  await clickhouse.close();
  await pool.end();
});

async function eventsFor(visitorId: string): Promise<Array<{ event_type: string; active_ms: number }>> {
  const result = await clickhouse.query({
    query: `SELECT event_type, active_ms FROM events WHERE visitor_id = {visitorId:String} ORDER BY event_type`,
    query_params: { visitorId },
    format: 'JSONEachRow',
  });
  return result.json();
}

function ingest(payload: unknown, origin?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify(payload),
  });
}

test('un batch valide est stocké et met à jour last_event_at', async () => {
  const visitorId = uniqueId('vis');
  const response = await ingest(
    {
      key: game.sdkKey,
      sdkVersion: '0.1.0',
      events: [
        { type: 'session_start', visitorId, sessionId: 'ses-1' },
        { type: 'heartbeat', visitorId, sessionId: 'ses-1', activeMs: 15000 },
      ],
    },
    `https://${game.domain}`,
  );
  assert.equal(response.statusCode, 204);

  const stored = await eventsFor(visitorId);
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((event) => event.event_type),
    ['heartbeat', 'session_start'],
  );

  const { rows } = await pool.query('SELECT last_event_at FROM games WHERE id = $1', [game.id]);
  assert.notEqual(rows[0].last_event_at, null);
});

test("une origine ne correspondant pas au domaine déclaré est rejetée en silence", async () => {
  const visitorId = uniqueId('vis');
  const response = await ingest(
    { key: game.sdkKey, events: [{ type: 'heartbeat', visitorId, sessionId: 's', activeMs: 1000 }] },
    'https://autre-site.example.net',
  );
  assert.equal(response.statusCode, 204);
  assert.equal((await eventsFor(visitorId)).length, 0);
});

test('une origine absente est rejetée en silence', async () => {
  const visitorId = uniqueId('vis');
  const response = await ingest({
    key: game.sdkKey,
    events: [{ type: 'heartbeat', visitorId, sessionId: 's', activeMs: 1000 }],
  });
  assert.equal(response.statusCode, 204);
  assert.equal((await eventsFor(visitorId)).length, 0);
});

test('un sous-domaine du domaine déclaré est accepté', async () => {
  const visitorId = uniqueId('vis');
  await ingest(
    { key: game.sdkKey, events: [{ type: 'load', visitorId, sessionId: 's' }] },
    `https://www.${game.domain}`,
  );
  assert.equal((await eventsFor(visitorId)).length, 1);
});

test('une clé SDK inconnue est rejetée en silence', async () => {
  const visitorId = uniqueId('vis');
  const response = await ingest(
    { key: 'gr_inconnue', events: [{ type: 'load', visitorId, sessionId: 's' }] },
    `https://${game.domain}`,
  );
  assert.equal(response.statusCode, 204);
  assert.equal((await eventsFor(visitorId)).length, 0);
});

test('les types inconnus sont filtrés et activeMs est plafonné', async () => {
  const visitorId = uniqueId('vis');
  await ingest(
    {
      key: game.sdkKey,
      events: [
        { type: 'hack', visitorId, sessionId: 's' },
        { type: 'heartbeat', visitorId, sessionId: 's', activeMs: 99_999_999 },
      ],
    },
    `https://${game.domain}`,
  );
  const stored = await eventsFor(visitorId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].event_type, 'heartbeat');
  assert.equal(stored[0].active_ms, 150_000);
});

test('un corps text/plain (sendBeacon) est accepté', async () => {
  const visitorId = uniqueId('vis');
  const response = await app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { 'content-type': 'text/plain', origin: `https://${game.domain}` },
    payload: JSON.stringify({
      key: game.sdkKey,
      events: [{ type: 'load', visitorId, sessionId: 's' }],
    }),
  });
  assert.equal(response.statusCode, 204);
  assert.equal((await eventsFor(visitorId)).length, 1);
});
