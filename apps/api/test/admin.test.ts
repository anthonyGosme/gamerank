import { createHash, randomBytes } from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { clickhouse } from '../src/clickhouse.js';
import { createDeveloper, createGame, cleanupCreated } from './helpers.js';

let app: FastifyInstance;
let adminCookie: string;
const adminEmail = config.adminEmails[0] ?? 'admin@test.local';

before(async () => {
  app = await buildApp({ logger: false });
  // Développeur admin (email présent dans ADMIN_EMAILS) + session.
  const { rows } = await pool.query(
    `INSERT INTO developers (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [adminEmail],
  );
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (developer_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [rows[0].id, createHash('sha256').update(token).digest('hex')],
  );
  adminCookie = token;
});

after(async () => {
  await cleanupCreated();
  await app.close();
  await clickhouse.close();
  await pool.end();
});

test('un non-admin ne voit pas les routes admin (404)', async () => {
  const developer = await createDeveloper();
  const game = await createGame(developer.id);
  const anon = await app.inject({ method: 'GET', url: `/api/admin/games/${game.id}` });
  assert.equal(anon.statusCode, 404);
});

test("l'admin voit le détail d'un jeu : email dev et votes", async () => {
  const developer = await createDeveloper('owner-detail@test.local');
  const game = await createGame(developer.id);
  await pool.query(`INSERT INTO votes (game_id, visitor_id, value) VALUES ($1,'a',1),($1,'b',1),($1,'c',-1)`, [
    game.id,
  ]);
  const res = await app.inject({
    method: 'GET',
    url: `/api/admin/games/${game.id}`,
    cookies: { gr_session: adminCookie },
  });
  assert.equal(res.statusCode, 200);
  const info = res.json();
  assert.equal(info.developerEmail, 'owner-detail@test.local');
  assert.equal(info.votesUp, 2);
  assert.equal(info.votesDown, 1);
});

test("l'admin peut masquer puis supprimer n'importe quel jeu", async () => {
  const developer = await createDeveloper();
  const game = await createGame(developer.id);

  const hide = await app.inject({
    method: 'POST',
    url: `/api/admin/games/${game.id}/hide`,
    cookies: { gr_session: adminCookie },
  });
  assert.equal(hide.statusCode, 200);
  const { rows: hidden } = await pool.query('SELECT status FROM games WHERE id = $1', [game.id]);
  assert.equal(hidden[0].status, 'hidden');

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/admin/games/${game.id}`,
    cookies: { gr_session: adminCookie },
  });
  assert.equal(del.statusCode, 200);
  const { rows: gone } = await pool.query('SELECT 1 FROM games WHERE id = $1', [game.id]);
  assert.equal(gone.length, 0);
});
