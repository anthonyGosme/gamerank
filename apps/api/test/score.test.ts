import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clickhouse, ensureClickhouseSchema } from '../src/clickhouse.js';
import { pool } from '../src/db.js';
import { runScoring } from '../src/scoring/score.js';
import { createDeveloper, createGame, uniqueId, cleanupCreated, printTable } from './helpers.js';

// Scénarios synthétiques (CDC §9) : chaque test vérifie une propriété de la
// formule sur des jeux fabriqués, injectés directement dans daily_activity.

let games: Record<string, { id: string }>;
let scores: Map<string, { score: number; g: number; q: number; rank: number; metrics: any }>;

// Description des entrées de chaque scénario, affichée avec les résultats.
const INPUTS: Record<string, string> = {
  bigMediocre: '50 visiteurs/j × 30 j (jamais les mêmes), 60 s chacun, 3 chargements/visiteur, votes 12+/18−',
  smallExcellent: '10 visiteurs fidèles revenant 20 j, 300 s chacun, 1 chargement, votes 25+/1−',
  botnet: '400 « visiteurs » en 1 jour, tous dans 10.1.1.0/24, 60 s chacun',
  honest: '100 visiteurs en 1 jour, IP dispersées sur 50 blocs /8, 60 s chacun',
  fresh: '20 visiteurs AUJOURD’HUI, 120 s chacun',
  stale: '20 visiteurs IL Y A 40 JOURS, 120 s chacun (activité identique à « fresh »)',
  fewVotes: '20 visiteurs, 60 s chacun, votes 3+/0− (100 % mais 3 votants)',
  manyVotes: '20 visiteurs, 60 s chacun, votes 90+/10− (90 % sur 100 votants)',
};

const LABELS: Record<string, string> = {
  bigMediocre: 'gros médiocre',
  smallExcellent: 'petit excellent',
  botnet: 'botnet /24',
  honest: 'honnête dispersé',
  fresh: 'frais (J0)',
  stale: 'ancien (J−40)',
  fewVotes: 'peu de votes',
  manyVotes: 'beaucoup de votes',
};

const one = (value: number, digits = 1) => value.toFixed(digits);
const pct = (value: number | null) => (value == null ? '—' : `${(value * 100).toFixed(1)} %`);

const day = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

async function insertActivity(
  gameId: string,
  rows: Array<{ visitorId: string; day: string; ip: string; activeMs: number; loads?: number }>,
): Promise<void> {
  await clickhouse.insert({
    table: 'daily_activity',
    values: rows.map((row) => ({
      game_id: gameId,
      visitor_id: row.visitorId,
      day: row.day,
      active_ms: row.activeMs,
      sessions: 1,
      loads: row.loads ?? 1,
      ip: row.ip,
      ver: 1,
    })),
    format: 'JSONEachRow',
  });
}

async function insertSessions(
  gameId: string,
  rows: Array<{ day: string; activeMs: number }>,
): Promise<void> {
  await clickhouse.insert({
    table: 'daily_sessions',
    values: rows.map((row, index) => ({
      game_id: gameId,
      session_id: `s-${gameId}-${index}`,
      day: row.day,
      active_ms: row.activeMs,
      ver: 1,
    })),
    format: 'JSONEachRow',
  });
}

async function insertVotes(gameId: string, positive: number, negative: number): Promise<void> {
  for (let i = 0; i < positive + negative; i++) {
    await pool.query(
      `INSERT INTO votes (game_id, visitor_id, value) VALUES ($1, $2, $3)`,
      [gameId, uniqueId('sv'), i < positive ? 1 : -1],
    );
  }
}

before(async () => {
  await ensureClickhouseSchema();
  const developer = await createDeveloper();
  games = {
    bigMediocre: await createGame(developer.id),
    smallExcellent: await createGame(developer.id),
    botnet: await createGame(developer.id),
    honest: await createGame(developer.id),
    fresh: await createGame(developer.id),
    stale: await createGame(developer.id),
    fewVotes: await createGame(developer.id),
    manyVotes: await createGame(developer.id),
  };

  // Gros jeu médiocre : 50 visiteurs/jour sur 30 j, jamais de retour,
  // sessions courtes, approbation 40 %.
  const big: Parameters<typeof insertActivity>[1] = [];
  for (let d = 0; d < 30; d++) {
    for (let i = 0; i < 50; i++) {
      big.push({
        visitorId: `big-${d}-${i}`,
        day: day(d),
        ip: `9.${d % 200}.${i}.${(d + i) % 250}`,
        activeMs: 60_000,
        loads: 3,
      });
    }
  }
  await insertActivity(games.bigMediocre.id, big);
  await insertSessions(games.bigMediocre.id, Array.from({ length: 60 }, (_, i) => ({ day: day(i % 25), activeMs: 90_000 })));
  await insertVotes(games.bigMediocre.id, 12, 18);

  // Petit jeu excellent : 10 fidèles qui reviennent 20 jours, longues
  // sessions, approbation 25/26.
  const small: Parameters<typeof insertActivity>[1] = [];
  for (let d = 0; d < 20; d++) {
    for (let i = 0; i < 10; i++) {
      small.push({
        visitorId: `small-${i}`,
        day: day(d),
        ip: `30.${i}.7.${i}`,
        activeMs: 300_000,
        loads: 1,
      });
    }
  }
  await insertActivity(games.smallExcellent.id, small);
  await insertSessions(games.smallExcellent.id, Array.from({ length: 60 }, (_, i) => ({ day: day(i % 20), activeMs: 300_000 })));
  await insertVotes(games.smallExcellent.id, 25, 1);

  // Botnet : 400 « visiteurs » le même jour, tous dans la même /24.
  await insertActivity(
    games.botnet.id,
    Array.from({ length: 400 }, (_, i) => ({
      visitorId: `bot-${i}`,
      day: day(1),
      ip: `10.1.1.${i % 250}`,
      activeMs: 60_000,
    })),
  );
  // Jeu honnête : 100 visiteurs le même jour, IP dispersées.
  await insertActivity(
    games.honest.id,
    Array.from({ length: 100 }, (_, i) => ({
      visitorId: `honest-${i}`,
      day: day(1),
      ip: `${20 + (i % 50)}.${i}.${(i * 7) % 200}.9`,
      activeMs: 60_000,
    })),
  );

  // Même activité brute, aujourd'hui vs il y a 40 jours (décroissance).
  const sameDay = (gameDay: string, prefix: string) =>
    Array.from({ length: 20 }, (_, i) => ({
      visitorId: `${prefix}-${i}`,
      day: gameDay,
      ip: `${60 + i}.2.3.4`,
      activeMs: 120_000,
    }));
  await insertActivity(games.fresh.id, sameDay(day(0), 'fresh'));
  await insertActivity(games.stale.id, sameDay(day(40), 'stale'));

  // Wilson : 3/3 votes contre 90/100, activité identique par ailleurs.
  const flat = (prefix: string) =>
    Array.from({ length: 20 }, (_, i) => ({
      visitorId: `${prefix}-${i}`,
      day: day(2),
      ip: `${80 + i}.5.6.7`,
      activeMs: 60_000,
    }));
  await insertActivity(games.fewVotes.id, flat('few'));
  await insertActivity(games.manyVotes.id, flat('many'));
  await insertVotes(games.fewVotes.id, 3, 0);
  await insertVotes(games.manyVotes.id, 90, 10);

  const summary = await runScoring();
  const { rows } = await pool.query(
    `SELECT game_id, score, g, q, rank, metrics FROM game_scores WHERE run_id = $1`,
    [summary.runId],
  );
  scores = new Map(rows.map((row) => [row.game_id, row]));

  printTable(
    'ENTRÉES DES SCÉNARIOS',
    ['jeu', 'données injectées'],
    Object.keys(INPUTS).map((key) => [LABELS[key], INPUTS[key]]),
  );

  printTable(
    `RÉSULTATS (${summary.gamesCount} jeux classés au total, passe en ${summary.durationMs} ms)`,
    ['jeu', 'Gv pondéré', 'Gt (h)', 'fidélité', 'médiane', 'approb.', 'G', 'Q', 'Score', 'rang'],
    Object.keys(INPUTS).map((key) => {
      const row = scores.get(games[key].id)!;
      const m = row.metrics;
      return [
        LABELS[key],
        one(m.weightedVisitors),
        one(m.activeMs / 3_600_000),
        `${pct(m.fidelity)} → ${pct(m.corrected.fidelity)}`,
        `${one(m.medianSessionMs / 60_000, 1)} min`,
        `${pct(m.wilson)}`,
        one(row.g),
        one(row.q),
        one(row.score),
        `#${row.rank}`,
      ];
    }),
  );
  console.log(
    '\n  Lecture : « fidélité » affiche observée → corrigée (shrinkage) ;' +
      '\n  « approb. » est la borne de Wilson, pas le taux brut.\n',
  );
});

after(async () => {
  await cleanupCreated();
  await clickhouse.close();
  await pool.end();
});

test('le run est historisé avec sa durée et les scores courants sont posés', async () => {
  const { rows } = await pool.query(
    `SELECT duration_ms, status, games_count FROM score_runs ORDER BY started_at DESC LIMIT 1`,
  );
  assert.equal(rows[0].status, 'ok');
  assert.ok(rows[0].duration_ms >= 0);
  const { rows: current } = await pool.query(
    `SELECT current_score, current_rank FROM games WHERE id = $1`,
    [games.smallExcellent.id],
  );
  assert.notEqual(current[0].current_score, null);
  assert.notEqual(current[0].current_rank, null);
});

test('un petit jeu excellent dépasse un gros jeu médiocre', () => {
  const small = scores.get(games.smallExcellent.id)!;
  const big = scores.get(games.bigMediocre.id)!;
  console.log(
    `    petit excellent : G=${one(small.g)} Q=${one(small.q)} → score ${one(small.score)} (#${small.rank})\n` +
      `    gros médiocre   : G=${one(big.g)} Q=${one(big.q)} → score ${one(big.score)} (#${big.rank})\n` +
      `    écart de ${one(small.score - big.score)} points en faveur de la qualité` +
      ` (le gros jeu garde l'avantage sur G : ${one(big.g)} vs ${one(small.g)})`,
  );
  assert.ok(small.score > big.score, `attendu ${one(small.score)} > ${one(big.score)}`);
});

test('un botnet concentré sur une /24 pèse moins que des visiteurs dispersés', () => {
  const botnet = scores.get(games.botnet.id)!.metrics.weightedVisitors;
  const honest = scores.get(games.honest.id)!.metrics.weightedVisitors;
  console.log(
    `    botnet   : 400 visiteurs bruts (même /24) → ${one(botnet)} comptés` +
      ` (${one((botnet / 400) * 100)} % retenus)\n` +
      `    honnête  : 100 visiteurs bruts (dispersés) → ${one(honest)} comptés` +
      ` (${one((honest / 100) * 100)} % retenus)\n` +
      `    le botnet a 4× plus de « visiteurs » mais pèse ${one(honest / botnet)}× moins`,
  );
  assert.ok(botnet < honest, `attendu botnet ${one(botnet)} < honnête ${one(honest)}`);
});

test('Wilson : 90/100 votes bat 3/3 votes', () => {
  const few = scores.get(games.fewVotes.id)!;
  const many = scores.get(games.manyVotes.id)!;
  console.log(
    `    3+/0−    : taux brut 100,0 % → Wilson ${pct(few.metrics.wilson)}\n` +
      `    90+/10−  : taux brut  90,0 % → Wilson ${pct(many.metrics.wilson)}\n` +
      `    scores finaux : ${one(few.score)} vs ${one(many.score)}`,
  );
  assert.ok(
    many.metrics.corrected.approval > few.metrics.corrected.approval,
    `attendu 90/100 > 3/3`,
  );
});

test("la décroissance : la même activité pèse moins 40 jours plus tard", () => {
  const fresh = scores.get(games.fresh.id)!.metrics;
  const stale = scores.get(games.stale.id)!.metrics;
  console.log(
    `    activité brute identique : 20 visiteurs × 120 s = 40 min\n` +
      `    frais (J0)    : ${one(fresh.activeMs / 60_000)} min pondérées,` +
      ` ${one(fresh.weightedVisitors)} visiteurs\n` +
      `    ancien (J−40) : ${one(stale.activeMs / 60_000)} min pondérées` +
      ` → ${one((stale.activeMs / fresh.activeMs) * 100)} % conservés (théorie : 0,95^40 = 12,9 %)`,
  );
  // L'activité du jour ne doit subir AUCUNE décroissance (âge = 0 jour).
  assert.equal(
    Math.round(fresh.weightedVisitors),
    20,
    'les 20 visiteurs du jour doivent compter pour 20, sans décroissance',
  );
  assert.ok(stale.activeMs < fresh.activeMs * 0.25, `attendu ancien ≪ frais`);
});
