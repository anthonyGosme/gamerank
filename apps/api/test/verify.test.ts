import http from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { clickhouse } from '../src/clickhouse.js';
import { createDeveloper, createGame } from './helpers.js';

let app: FastifyInstance;
let developer: { id: string; email: string };
let sessionCookie: string;
let fakeSite: http.Server;
let fakeSiteUrl: string;
let fakeSiteHtml = '';

before(async () => {
  app = await buildApp({ logger: false });
  developer = await createDeveloper();
  // Session directe en base pour appeler les routes authentifiées.
  const { createHash, randomBytes } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (developer_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [developer.id, createHash('sha256').update(token).digest('hex')],
  );
  sessionCookie = token;

  fakeSite = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fakeSiteHtml);
  });
  await new Promise<void>((resolve) => fakeSite.listen(0, '127.0.0.1', resolve));
  fakeSiteUrl = `http://127.0.0.1:${(fakeSite.address() as AddressInfo).port}/`;
});

after(async () => {
  fakeSite.close();
  await app.close();
  await clickhouse.close();
  await pool.end();
});

function verify(gameId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/verify`,
    cookies: { gr_session: sessionCookie },
  });
}

test('jeu local sans événement : vérification refusée', async () => {
  const game = await createGame(developer.id);
  await pool.query('UPDATE games SET is_local = true WHERE id = $1', [game.id]);
  const response = await verify(game.id);
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /no events received/);
});

test('jeu local avec événements : vérification acceptée', async () => {
  const game = await createGame(developer.id);
  await pool.query('UPDATE games SET is_local = true, last_event_at = now() WHERE id = $1', [
    game.id,
  ]);
  const response = await verify(game.id);
  assert.equal(response.statusCode, 200);
  assert.notEqual(response.json().integrationVerifiedAt, null);
});

test('NDD : balise présente sur la page → vérifié', async () => {
  const game = await createGame(developer.id);
  await pool.query('UPDATE games SET url = $1 WHERE id = $2', [`${fakeSiteUrl}with-snippet`, game.id]);
  fakeSiteHtml = `<html><head><script src="http://localhost:3000/sdk.js" data-key="${game.sdkKey}" async></script></head><body>hi</body></html>`;
  const response = await verify(game.id);
  assert.equal(response.statusCode, 200);
  assert.notEqual(response.json().integrationVerifiedAt, null);
});

test('NDD : balise absente → refusé avec message', async () => {
  const game = await createGame(developer.id);
  await pool.query('UPDATE games SET url = $1 WHERE id = $2', [`${fakeSiteUrl}without-snippet`, game.id]);
  fakeSiteHtml = '<html><body>no snippet here</body></html>';
  const response = await verify(game.id);
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /snippet not found/);
});

test('recheck : un jeu vérifié dont la balise disparaît redevient non vérifié', async () => {
  const game = await createGame(developer.id);
  await pool.query('UPDATE games SET url = $1 WHERE id = $2', [`${fakeSiteUrl}recheck`, game.id]);
  fakeSiteHtml = `<html><head><script src="/sdk.js" data-key="${game.sdkKey}"></script></head></html>`;
  assert.equal((await verify(game.id)).statusCode, 200);

  fakeSiteHtml = '<html><body>snippet removed</body></html>';
  const recheck = await verify(game.id);
  assert.equal(recheck.statusCode, 400);
  const { rows } = await pool.query(
    'SELECT integration_verified_at FROM games WHERE id = $1',
    [game.id],
  );
  assert.equal(rows[0].integration_verified_at, null);
});

test("la création refuse localhost sans la case « adresse locale »", async () => {
  const boundary = 'x'.repeat(20);
  const part = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const filePart =
    `--${boundary}\r\nContent-Disposition: form-data; name="thumbnail"; filename="t.png"\r\n` +
    `Content-Type: image/png\r\n\r\nPNGDATA\r\n`;
  const payload =
    part('name', 'Local sans case') +
    part('url', 'http://localhost:8000/') +
    part('description', 'test') +
    part('isLocal', 'false') +
    filePart +
    `--${boundary}--\r\n`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/games',
    cookies: { gr_session: sessionCookie },
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /local address/);
});
