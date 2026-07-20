import { pool } from '../db.js';
import { clickhouse } from '../clickhouse.js';
import { config } from '../config.js';
import { runAggregation } from './aggregate.js';
import {
  absoluteLinear,
  absoluteLog,
  clamp,
  effectiveVisitors,
  mean,
  percentileRanks,
  shrink,
  wilsonLowerBound,
} from './math.js';

const DAY_MS = 24 * 3600 * 1000;

interface GameMetrics {
  weightedVisitors: number;
  activeMs: number;
  loads: number;
  voters: number;
  positiveVotes: number;
  wilson: number | null;
  fidelity: number | null;
  fidelitySample: number;
  medianSessionMs: number | null;
  sessionSample: number;
}

async function chRows<T>(query: string): Promise<T[]> {
  const result = await clickhouse.query({ query, format: 'JSONEachRow' });
  return result.json<T>();
}

// Âge en jours calendaires : aujourd'hui = 0, hier = 1…
// (floor et non round, sinon les buckets vieillissent d'un jour à midi UTC
// et tous les scores décrochent de 5 % au milieu de la journée.)
function ageInDays(day: string, today: number): number {
  return Math.max(0, Math.floor((today - Date.parse(day)) / DAY_MS));
}

// Étage 2 + 3 : collecte les métriques par jeu (cumuls à décroissance
// exponentielle recalculés depuis les 45 j d'agrégats — auto-réparant),
// applique les corrections, normalise, et écrit le classement.
async function collectMetrics(gameIds: string[]): Promise<Map<string, GameMetrics>> {
  const s = config.scoring;
  const today = Date.now();
  const decay = (day: string) => Math.pow(s.decayFactor, ageInDays(day, today));

  const metrics = new Map<string, GameMetrics>();
  for (const id of gameIds) {
    metrics.set(id, {
      weightedVisitors: 0,
      activeMs: 0,
      loads: 0,
      voters: 0,
      positiveVotes: 0,
      wilson: null,
      fidelity: null,
      fidelitySample: 0,
      medianSessionMs: null,
      sessionSample: 0,
    });
  }

  // Visiteurs qualifiés par (jeu, jour, IP) → poids dégressif par préfixe (§4.1).
  const qualifiedRows = await chRows<{ g: string; day: string; ip: string; n: string }>(`
    SELECT toString(game_id) AS g, toString(day) AS day, ip, toString(uniqExact(visitor_id)) AS n
      FROM daily_activity FINAL
     WHERE active_ms >= ${s.qualifiedVisitorMs}
     GROUP BY g, day, ip
  `);
  const perGameDay = new Map<string, Map<string, Map<string, number>>>();
  for (const row of qualifiedRows) {
    if (!metrics.has(row.g)) continue;
    const days = perGameDay.get(row.g) ?? new Map();
    perGameDay.set(row.g, days);
    const ips = days.get(row.day) ?? new Map();
    days.set(row.day, ips);
    ips.set(row.ip, (ips.get(row.ip) ?? 0) + Number(row.n));
  }
  for (const [gameId, days] of perGameDay) {
    const metric = metrics.get(gameId)!;
    for (const [day, ipCounts] of days) {
      metric.weightedVisitors += effectiveVisitors(ipCounts, s.prefixLevels) * decay(day);
    }
  }

  // Temps actif et chargements, décroissants.
  const volumeRows = await chRows<{ g: string; day: string; am: string; ld: string }>(`
    SELECT toString(game_id) AS g, toString(day) AS day,
           toString(sum(active_ms)) AS am, toString(sum(loads)) AS ld
      FROM daily_activity FINAL
     GROUP BY g, day
  `);
  for (const row of volumeRows) {
    const metric = metrics.get(row.g);
    if (!metric) continue;
    metric.activeMs += Number(row.am) * decay(row.day);
    metric.loads += Number(row.ld) * decay(row.day);
  }

  // Fidélisation par cohorte (§7.2) : parmi les visiteurs arrivés il y a
  // ≥ cohortDays, part revenue un autre jour (≥ 2 journées actives).
  const fidelityRows = await chRows<{ g: string; fd: string; ad: string }>(`
    SELECT toString(game_id) AS g, toString(min(day)) AS fd,
           toString(countIf(active_ms >= ${s.activeDayMs})) AS ad
      FROM daily_activity FINAL
     GROUP BY g, visitor_id
  `);
  const cohorts = new Map<string, { eligible: number; returned: number }>();
  for (const row of fidelityRows) {
    if (!metrics.has(row.g)) continue;
    if (ageInDays(row.fd, today) < s.cohortDays) continue;
    const cohort = cohorts.get(row.g) ?? { eligible: 0, returned: 0 };
    cohort.eligible += 1;
    if (Number(row.ad) >= 2) cohort.returned += 1;
    cohorts.set(row.g, cohort);
  }
  for (const [gameId, cohort] of cohorts) {
    const metric = metrics.get(gameId)!;
    metric.fidelitySample = cohort.eligible;
    metric.fidelity = cohort.eligible > 0 ? cohort.returned / cohort.eligible : null;
  }

  // Durée médiane des sessions actives sur 30 j (§7.2).
  const medianRows = await chRows<{ g: string; med: string; cnt: string }>(`
    SELECT toString(game_id) AS g,
           toString(quantileExact(0.5)(active_ms)) AS med, toString(count()) AS cnt
      FROM daily_sessions FINAL
     WHERE day >= today() - ${s.medianWindowDays} AND active_ms > 0
     GROUP BY g
  `);
  for (const row of medianRows) {
    const metric = metrics.get(row.g);
    if (!metric) continue;
    metric.medianSessionMs = Number(row.med);
    metric.sessionSample = Number(row.cnt);
  }

  // Votes (PostgreSQL) : Wilson pour l'approbation, votants pour Gx.
  const { rows: voteRows } = await pool.query(
    `SELECT game_id AS g, count(*)::int AS total,
            count(*) FILTER (WHERE value = 1)::int AS pos
       FROM votes GROUP BY game_id`,
  );
  for (const row of voteRows as Array<{ g: string; total: number; pos: number }>) {
    const metric = metrics.get(row.g);
    if (!metric) continue;
    metric.voters = row.total;
    metric.positiveVotes = row.pos;
    metric.wilson = wilsonLowerBound(row.pos, row.total);
  }

  return metrics;
}

export interface ScoreRunSummary {
  runId: string;
  durationMs: number;
  gamesCount: number;
}

export async function runScoring(): Promise<ScoreRunSummary> {
  const s = config.scoring;
  const startedAt = Date.now();
  const { rows: runRows } = await pool.query(
    `INSERT INTO score_runs DEFAULT VALUES RETURNING id`,
  );
  const runId: string = runRows[0].id;

  try {
    const { rows: gameRows } = await pool.query(
      `SELECT id FROM games WHERE status <> 'hidden'`,
    );
    const gameIds = (gameRows as Array<{ id: string }>).map((row) => row.id);
    const metrics = await collectMetrics(gameIds);

    // Priors empiriques globaux (moyenne des jeux mesurés, CDC §7.3).
    const observed = [...metrics.values()];
    const fidelityPrior = mean(observed.filter((m) => m.fidelity !== null).map((m) => m.fidelity!)) || 0.1;
    const medianPrior =
      mean(observed.filter((m) => m.medianSessionMs !== null).map((m) => m.medianSessionMs!)) || 60_000;
    const wilsonPrior = mean(observed.filter((m) => m.wilson !== null).map((m) => m.wilson!)) || 0.5;
    const engagementOf = (m: GameMetrics) =>
      m.loads > 0 ? clamp(m.weightedVisitors / m.loads, 0, 1) : null;
    const engagementPrior = mean(
      observed.map(engagementOf).filter((v): v is number => v !== null),
    ) || 0.3;

    // Corrections par jeu.
    const corrected = new Map<
      string,
      { fidelity: number; median: number; approval: number; engagement: number }
    >();
    for (const [gameId, m] of metrics) {
      corrected.set(gameId, {
        fidelity: shrink(m.fidelity ?? fidelityPrior, m.fidelitySample, fidelityPrior, s.shrinkSamples.fidelity),
        median: shrink(m.medianSessionMs ?? medianPrior, m.sessionSample, medianPrior, s.shrinkSamples.session),
        approval: m.wilson ?? wilsonPrior,
        engagement: shrink(engagementOf(m) ?? engagementPrior, m.loads, engagementPrior, s.shrinkSamples.engagement),
      });
    }

    // Normalisation 50 % échelle absolue + 50 % percentile (CDC §6).
    const pct = (extract: (gameId: string) => number) =>
      percentileRanks(gameIds.map((id) => [id, extract(id)]));
    const pVisitors = pct((id) => metrics.get(id)!.weightedVisitors);
    const pActive = pct((id) => metrics.get(id)!.activeMs);
    const pVoters = pct((id) => metrics.get(id)!.voters);
    const pFidelity = pct((id) => corrected.get(id)!.fidelity);
    const pMedian = pct((id) => corrected.get(id)!.median);
    const pApproval = pct((id) => corrected.get(id)!.approval);
    const pEngagement = pct((id) => corrected.get(id)!.engagement);
    // Score A (proposition legacy, percentiles purs — comparaison interne §9).
    const pPositive = pct((id) => metrics.get(id)!.positiveVotes);
    const pRawFidelity = pct((id) => metrics.get(id)!.fidelity ?? 0);
    const pRawMedian = pct((id) => metrics.get(id)!.medianSessionMs ?? 0);
    const pPosRate = pct((id) => {
      const m = metrics.get(id)!;
      return m.voters > 0 ? m.positiveVotes / m.voters : 0;
    });

    const b = s.referenceBounds;
    const results = gameIds.map((id) => {
      const m = metrics.get(id)!;
      const c = corrected.get(id)!;
      const sub = (absolute: number, percentile: number) => 0.5 * absolute + 0.5 * percentile;

      const gv = sub(absoluteLog(m.weightedVisitors, b.visitors), pVisitors.get(id)!);
      const gt = sub(absoluteLog(m.activeMs / 3_600_000, b.activeHours), pActive.get(id)!);
      const gx = sub(absoluteLog(m.voters, b.voters), pVoters.get(id)!);
      const qr = sub(absoluteLinear(c.fidelity, b.fidelity), pFidelity.get(id)!);
      const qs = sub(absoluteLog(c.median / 60_000, b.medianMinutes), pMedian.get(id)!);
      const qv = sub(absoluteLinear(c.approval, 1), pApproval.get(id)!);
      const qe = sub(absoluteLinear(c.engagement, b.engagement), pEngagement.get(id)!);

      const g = s.weights.g.v * gv + s.weights.g.t * gt + s.weights.g.x * gx;
      const q = s.weights.q.r * qr + s.weights.q.s * qs + s.weights.q.v * qv + s.weights.q.e * qe;
      const p = s.peerDefaultRatio * 100; // épic 3 : sera remplacé par le vrai score jury
      const score = s.weights.final.g * g + s.weights.final.q * q + s.weights.final.p * p;

      const scoreA =
        (mean([pVisitors.get(id)!, pActive.get(id)!, pPositive.get(id)!]) +
          mean([pRawFidelity.get(id)!, pRawMedian.get(id)!, pPosRate.get(id)!])) /
        2;

      return { id, g, q, p, score, scoreA, metrics: { ...m, corrected: c } };
    });

    results.sort((a, b2) => b2.score - a.score);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        // WHERE EXISTS : un jeu supprimé pendant la passe est simplement
        // ignoré, au lieu de faire échouer tout le run sur la clé étrangère.
        await client.query(
          `INSERT INTO game_scores (run_id, game_id, score, g, q, p, score_a, rank, metrics)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
            WHERE EXISTS (SELECT 1 FROM games WHERE id = $2)`,
          [runId, r.id, r.score, r.g, r.q, r.p, r.scoreA, i + 1, JSON.stringify(r.metrics)],
        );
        await client.query(
          `UPDATE games SET current_score = $1, current_rank = $2 WHERE id = $3`,
          [r.score, i + 1, r.id],
        );
      }
      const durationMs = Date.now() - startedAt;
      await client.query(
        `UPDATE score_runs SET finished_at = now(), duration_ms = $1, status = 'ok', games_count = $2
          WHERE id = $3`,
        [durationMs, results.length, runId],
      );
      await client.query('COMMIT');
      return { runId, durationMs, gamesCount: results.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    await pool.query(
      `UPDATE score_runs SET finished_at = now(), duration_ms = $1, status = 'error', error = $2
        WHERE id = $3`,
      [Date.now() - startedAt, String((err as Error).message ?? err), runId],
    );
    throw err;
  }
}

let pipelineRunning = false;

// Agrégation puis scoring, avec garde anti-chevauchement (une passe à la fois).
export async function runPipeline(): Promise<ScoreRunSummary | null> {
  if (pipelineRunning) return null;
  pipelineRunning = true;
  try {
    await runAggregation();
    return await runScoring();
  } finally {
    pipelineRunning = false;
  }
}
