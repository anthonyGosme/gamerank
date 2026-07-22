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

async function getToken(key: string, origin?: string): Promise<string | null> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/vote-token',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify({ key }),
  });
  return res.statusCode === 200 ? (res.json().token as string) : null;
}

// IP unique par appel (chaque « visiteur » de test vote depuis une IP distincte,
// sinon la règle « 1 vote par IP » bloquerait des tests indépendants).
let ipSeq = 0;
const nextIp = (): string => `198.51.100.${(ipSeq++ % 250) + 1}`;

// Reproduit le flux SDK : récupère un jeton one-shot (si possible) puis vote.
async function vote(payload: Record<string, unknown>, origin?: string, ip: string = nextIp()) {
  let body: Record<string, unknown> = payload;
  if (typeof payload.key === 'string' && payload.token === undefined) {
    const token = await getToken(payload.key, origin);
    if (token) body = { ...payload, token };
  }
  return app.inject({
    method: 'POST',
    url: '/api/vote',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(origin ? { origin } : {}) },
    payload: JSON.stringify(body),
  });
}

// Vote « brut » sans passer par le jeton (pour tester le gate token).
function rawVote(payload: Record<string, unknown>, origin?: string, ip: string = nextIp()) {
  return app.inject({
    method: 'POST',
    url: '/api/vote',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(origin ? { origin } : {}) },
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

test('vote sans jeton → refusé (anti curl/Postman)', async () => {
  const visitorId = uniqueId('voter');
  await givePlaytime(visitorId, 90_000);
  const res = await rawVote({ key: game.sdkKey, visitorId, value: 1 }, `https://${game.domain}`);
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /token/);
  assert.equal(await storedVote(visitorId), null);
});

test('jeton one-shot : réutilisé → refusé', async () => {
  const v1 = uniqueId('voter');
  const v2 = uniqueId('voter');
  await givePlaytime(v1, 90_000);
  await givePlaytime(v2, 90_000);
  const token = await getToken(game.sdkKey, `https://${game.domain}`);
  assert.ok(token);

  const first = await rawVote({ key: game.sdkKey, visitorId: v1, value: 1, token }, `https://${game.domain}`);
  assert.equal(first.statusCode, 200);
  // Même jeton, 2ᵉ usage → refusé.
  const reuse = await rawVote({ key: game.sdkKey, visitorId: v2, value: 1, token }, `https://${game.domain}`);
  assert.equal(reuse.statusCode, 403);
  assert.match(reuse.json().error, /token/);
  assert.equal(await storedVote(v2), null);
});

test('jeton émis pour un autre jeu → refusé', async () => {
  const dev2 = await createDeveloper();
  const other = await createGame(dev2.id);
  const otherToken = await getToken(other.sdkKey, `https://${other.domain}`);
  assert.ok(otherToken);

  const visitorId = uniqueId('voter');
  await givePlaytime(visitorId, 90_000);
  // Jeton d'`other` utilisé pour voter sur `game` → refusé (lié au game_id).
  const res = await rawVote(
    { key: game.sdkKey, visitorId, value: 1, token: otherToken },
    `https://${game.domain}`,
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /token/);
});

test('2ᵉ vote depuis la même IP (localStorage vidé) → refusé', async () => {
  const ip = '203.0.113.99';
  const v1 = uniqueId('voter');
  const v2 = uniqueId('voter');
  await givePlaytime(v1, 90_000);
  await givePlaytime(v2, 90_000);

  const first = await vote({ key: game.sdkKey, visitorId: v1, value: 1 }, `https://${game.domain}`, ip);
  assert.equal(first.statusCode, 200);
  // Même IP, nouvelle identité (localStorage vidé) → refusé.
  const second = await vote({ key: game.sdkKey, visitorId: v2, value: 1 }, `https://${game.domain}`, ip);
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /network/);
  assert.equal(await storedVote(v2), null);
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
