import { createHash, randomBytes } from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { clickhouse } from '../src/clickhouse.js';
import { createDeveloper, createGame, multipartGame, uniqueId , cleanupCreated} from './helpers.js';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await cleanupCreated();
  await app.close();
  await clickhouse.close();
  await pool.end();
});

async function sessionFor(developerId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (developer_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [developerId, createHash('sha256').update(token).digest('hex')],
  );
  return token;
}

function createGameRequest(cookie: string, url: string) {
  const { payload, headers } = multipartGame({
    name: uniqueId('Jeu'),
    url,
    description: 'test',
    isLocal: 'false',
  });
  return app.inject({
    method: 'POST',
    url: '/api/games',
    cookies: { gr_session: cookie },
    headers,
    payload,
  });
}

test('une URL déjà enregistrée est refusée, même à un autre compte', async () => {
  const url = `https://${uniqueId('unique')}.test.local/`;
  const first = await createDeveloper();
  const second = await createDeveloper();

  // Premier arrivé : accepté.
  assert.equal((await createGameRequest(await sessionFor(first.id), url)).statusCode, 201);
  // Même compte : refusé.
  const sameDev = await createGameRequest(await sessionFor(first.id), url);
  assert.equal(sameDev.statusCode, 409);
  assert.match(sameDev.json().error, /already registered/);
  // Autre compte : refusé aussi (une URL = un seul jeu).
  const otherDev = await createGameRequest(await sessionFor(second.id), url);
  assert.equal(otherDev.statusCode, 409);
});

test('le propriétaire peut supprimer son jeu, pas les autres', async () => {
  const owner = await createDeveloper();
  const stranger = await createDeveloper();
  const game = await createGame(owner.id);

  // Un autre compte ne peut pas supprimer (404 : le jeu ne lui appartient pas).
  const denied = await app.inject({
    method: 'DELETE',
    url: `/api/games/${game.id}`,
    cookies: { gr_session: await sessionFor(stranger.id) },
  });
  assert.equal(denied.statusCode, 404);

  // Le propriétaire supprime : 204, le jeu et ses votes disparaissent.
  await pool.query(
    `INSERT INTO votes (game_id, visitor_id, value) VALUES ($1, 'v-test', 1)`,
    [game.id],
  );
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/games/${game.id}`,
    cookies: { gr_session: await sessionFor(owner.id) },
  });
  assert.equal(deleted.statusCode, 204);

  const { rows: games } = await pool.query('SELECT 1 FROM games WHERE id = $1', [game.id]);
  assert.equal(games.length, 0);
  const { rows: votes } = await pool.query('SELECT 1 FROM votes WHERE game_id = $1', [game.id]);
  assert.equal(votes.length, 0);

  // Supprimer un jeu inexistant : 404.
  const again = await app.inject({
    method: 'DELETE',
    url: `/api/games/${game.id}`,
    cookies: { gr_session: await sessionFor(owner.id) },
  });
  assert.equal(again.statusCode, 404);
});
