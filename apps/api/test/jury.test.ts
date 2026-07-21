import { createHash, randomBytes } from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { clickhouse } from '../src/clickhouse.js';
import { runScoring } from '../src/scoring/score.js';
import { createDeveloper, createGame, cleanupCreated } from './helpers.js';

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

// Pool de jeux à juger : appartenant à d'AUTRES développeurs, awaiting_jury.
async function poolGame(): Promise<string> {
  const owner = await createDeveloper();
  const game = await createGame(owner.id);
  await pool.query(`UPDATE games SET status = 'awaiting_jury' WHERE id = $1`, [game.id]);
  return game.id;
}

test('flux jury complet : jouer, élire, transitions de statut', async () => {
  // Garantit qu'au moins 2 jeux jugeables existent (d'autres peuvent exister).
  await poolGame();
  await poolGame();
  const juror = await createDeveloper();
  const ownGame = await createGame(juror.id);
  await pool.query(`UPDATE games SET status = 'awaiting_peer_review' WHERE id = $1`, [ownGame.id]);
  const cookie = await sessionFor(juror.id);

  // Assignation : le juré reçoit des jeux awaiting_jury, jamais les siens.
  const assign = await app.inject({ method: 'GET', url: '/api/jury/assignment', cookies: { gr_session: cookie } });
  assert.equal(assign.statusCode, 200);
  const games = assign.json().games as Array<{ gameId: string }>;
  assert.ok(games.length >= 2);
  assert.ok(!games.some((g) => g.gameId === ownGame.id), 'ne doit pas s’auto-assigner');

  // Soumettre sans avoir joué : refusé.
  const tooSoon = await app.inject({
    method: 'POST', url: '/api/jury/submit', cookies: { gr_session: cookie },
    payload: { elected: games.slice(0, config.scoring.juryElections).map((g) => g.gameId) },
  });
  assert.equal(tooSoon.statusCode, 403);

  // Marquer chaque jeu comme joué le minimum requis.
  for (const g of games) {
    await app.inject({
      method: 'POST', url: '/api/jury/played', cookies: { gr_session: cookie },
      payload: { gameId: g.gameId, playedMs: config.scoring.juryMinPlayMs + 1000 },
    });
  }

  // Élire 2 : accepté.
  const elected = games.slice(0, config.scoring.juryElections).map((g) => g.gameId);
  const submit = await app.inject({
    method: 'POST', url: '/api/jury/submit', cookies: { gr_session: cookie },
    payload: { elected },
  });
  assert.equal(submit.statusCode, 200);

  // Les jeux jugés ont reçu une présentation ; les élus sont marqués.
  const { rows: presented } = await pool.query(
    `SELECT id, jury_presentations FROM games WHERE id = ANY($1::uuid[])`,
    [games.map((g) => g.gameId)],
  );
  assert.ok(presented.every((r) => r.jury_presentations >= 1));
  const { rows: electedRows } = await pool.query(
    `SELECT count(*)::int AS n FROM jury_reviews WHERE juror_id = $1 AND elected`,
    [juror.id],
  );
  assert.equal(electedRows[0].n, config.scoring.juryElections);

  // Le devoir est fait : le jeu du juré passe awaiting_peer_review → awaiting_jury.
  const { rows: own } = await pool.query('SELECT status FROM games WHERE id = $1', [ownGame.id]);
  assert.equal(own[0].status, 'awaiting_jury');
  const { rows: dev } = await pool.query('SELECT jury_completed_at FROM developers WHERE id = $1', [juror.id]);
  assert.notEqual(dev[0].jury_completed_at, null);
});

test('P reflète les élections reçues (barème sur 7)', async () => {
  // Un jeu élu par 3 jurés distincts doit avoir un P plus élevé qu'un jeu élu 0 fois.
  const owner = await createDeveloper();
  const winner = await createGame(owner.id);
  const loser = await createGame(owner.id);
  await pool.query(`UPDATE games SET status = 'awaiting_jury' WHERE id = ANY($1::uuid[])`, [
    [winner.id, loser.id],
  ]);
  // 3 jurés présentés aux deux, élisant le winner.
  for (let i = 0; i < 3; i++) {
    const juror = await createDeveloper();
    await pool.query(
      `INSERT INTO jury_reviews (juror_id, game_id, batch_id, played_ms, elected, completed_at)
       VALUES ($1, $2, gen_random_uuid(), 30000, true, now()),
              ($1, $3, gen_random_uuid(), 30000, false, now())`,
      [juror.id, winner.id, loser.id],
    );
  }

  const summary = await runScoring();
  const { rows } = await pool.query(
    `SELECT game_id, p FROM game_scores WHERE run_id = $1 AND game_id = ANY($2::uuid[])`,
    [summary.runId, [winner.id, loser.id]],
  );
  const p = new Map(rows.map((r) => [r.game_id, r.p]));
  // winner : 3 élections / 7 ≈ 42,9 ; loser : 0 / 7 = 0.
  assert.ok(p.get(winner.id)! > 40, `winner P attendu > 40, obtenu ${p.get(winner.id)}`);
  assert.ok(p.get(loser.id)! < 5, `loser P attendu ~0, obtenu ${p.get(loser.id)}`);
});
