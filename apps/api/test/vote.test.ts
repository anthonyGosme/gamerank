import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
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

// Simule un visiteur ayant du temps de jeu vérifié.
async function givePlaytime(visitorId: string, activeMs: number): Promise<void> {
  await clickhouse.insert({
    table: 'events',
    values: [
      {
        game_id: game.id,
        visitor_id: visitorId,
        session_id: 's',
        event_type: 'heartbeat',
        active_ms: activeMs,
        ip: '127.0.0.1',
        user_agent: 'test',
        sdk_version: 'test',
      },
    ],
    format: 'JSONEachRow',
  });
}

function vote(payload: unknown, origin?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/vote',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify(payload),
  });
}

async function storedVote(visitorId: string): Promise<number | null> {
  const { rows } = await pool.query(
    'SELECT value FROM votes WHERE game_id = $1 AND visitor_id = $2',
    [game.id, visitorId],
  );
  return rows[0]?.value ?? null;
}

test('vote, idempotence, délai de 24 h avant changement', async () => {
  const visitorId = uniqueId('voter');
  await givePlaytime(visitorId, 90_000);

  const first = await vote({ key: game.sdkKey, visitorId, value: 1 }, `https://${game.domain}`);
  assert.equal(first.statusCode, 200);
  assert.equal(await storedVote(visitorId), 1);

  // Même vote : idempotent.
  const same = await vote({ key: game.sdkKey, visitorId, value: 1 }, `https://${game.domain}`);
  assert.equal(same.statusCode, 200);

  // Changement immédiat : refusé (délai de refroidissement).
  const tooSoon = await vote({ key: game.sdkKey, visitorId, value: -1 }, `https://${game.domain}`);
  assert.equal(tooSoon.statusCode, 429);
  assert.match(tooSoon.json().error, /change your vote in/);
  assert.equal(await storedVote(visitorId), 1);

  // Après le délai (simulé) : changement accepté, une seule ligne.
  await pool.query(
    `UPDATE votes SET updated_at = now() - interval '25 hours'
      WHERE game_id = $1 AND visitor_id = $2`,
    [game.id, visitorId],
  );
  const afterCooldown = await vote(
    { key: game.sdkKey, visitorId, value: -1 },
    `https://${game.domain}`,
  );
  assert.equal(afterCooldown.statusCode, 200);
  assert.equal(await storedVote(visitorId), -1);
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM votes WHERE game_id = $1 AND visitor_id = $2',
    [game.id, visitorId],
  );
  assert.equal(rows[0].n, 1);
});

test('un visiteur sans temps de jeu suffisant est refusé', async () => {
  const visitorId = uniqueId('voter');
  await givePlaytime(visitorId, Math.max(config.voteMinActiveMs - 5_000, 0));
  const response = await vote({ key: game.sdkKey, visitorId, value: 1 }, `https://${game.domain}`);
  assert.equal(response.statusCode, 403);
  assert.equal(await storedVote(visitorId), null);
});

test("un vote depuis une autre origine est refusé même avec du temps de jeu", async () => {
  const visitorId = uniqueId('voter');
  await givePlaytime(visitorId, 90_000);
  const response = await vote(
    { key: game.sdkKey, visitorId, value: 1 },
    'https://voleur.example.net',
  );
  assert.equal(response.statusCode, 403);
  assert.equal(await storedVote(visitorId), null);
});

test('clé inconnue ou valeur invalide refusées', async () => {
  const visitorId = uniqueId('voter');
  const unknownKey = await vote({ key: 'gr_nope', visitorId, value: 1 }, `https://${game.domain}`);
  assert.equal(unknownKey.statusCode, 404);
  const badValue = await vote({ key: game.sdkKey, visitorId, value: 5 }, `https://${game.domain}`);
  assert.equal(badValue.statusCode, 400);
});

test('le badge SVG affiche NEW sans score, puis le score dès qu’il existe', async () => {
  await pool.query('UPDATE games SET current_score = NULL WHERE id = $1', [game.id]);
  const blank = await app.inject({ method: 'GET', url: `/games/${game.id}/badge.svg` });
  assert.equal(blank.statusCode, 200);
  assert.match(blank.headers['content-type'] as string, /image\/svg\+xml/);
  assert.match(blank.body, /GAMERANK/);
  assert.match(blank.body, /NEW/);

  await pool.query('UPDATE games SET current_score = 73.4 WHERE id = $1', [game.id]);
  const scored = await app.inject({ method: 'GET', url: `/games/${game.id}/badge.svg` });
  assert.match(scored.body, />73</);
});

test('le webmaster peut forcer la couleur du badge via ?bg= (hex valide)', async () => {
  const forced = await app.inject({ method: 'GET', url: `/games/${game.id}/badge.svg?bg=0ea5e9` });
  assert.match(forced.body, /rx="7" fill="#0ea5e9"/);
  // Une valeur non-hex est ignorée (pas d'injection dans le SVG).
  const bad = await app.inject({ method: 'GET', url: `/games/${game.id}/badge.svg?bg=zzz` });
  assert.doesNotMatch(bad.body, /zzz/);
});

test('la fiche publique /g/:id est servie sans authentification', async () => {
  const response = await app.inject({ method: 'GET', url: `/g/${game.id}` });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Play /);
});
