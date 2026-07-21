import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { mailerHealth, verifyMailTransport } from './mailer.js';

// Au-delà de ce nombre d'échecs d'envoi consécutifs, /health/email passe en 503
// même si la sonde SMTP répond (les envois réels priment sur la sonde).
const MAX_CONSECUTIVE_FAILURES = 3;

// La sonde SMTP (verify) ouvre une connexion + auth : on met le résultat en
// cache pour ne pas marteler Poste.io si le moniteur ping souvent.
const PROBE_CACHE_MS = 60_000;

const iso = (ts: number | null): string | null => (ts === null ? null : new Date(ts).toISOString());

let probeCache: { at: number; ok: boolean; error?: string } | null = null;

async function probeSmtp(): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_CACHE_MS) {
    return { ok: probeCache.ok, error: probeCache.error };
  }
  const result = await verifyMailTransport();
  probeCache = { at: now, ok: result.ok, error: result.error };
  return result;
}

export function registerHealthRoutes(app: FastifyInstance): void {
  // Liveness — ultra léger : « le process répond ». Cible du ping Uptime Kuma.
  app.get('/health', async () => ({ ok: true }));

  // Readiness — l'app + sa dépendance critique (PostgreSQL).
  app.get('/health/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, db: true };
    } catch (err) {
      reply.code(503);
      return { ok: false, db: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Santé email — connexion+auth SMTP (sonde, cache 60s) + stats des vrais
  // envois. 503 si la sonde échoue ou si les envois enchaînent les erreurs.
  // Uptime Kuma : surveiller le code HTTP ET le mot-clé "ok":true.
  app.get('/health/email', async (_request, reply) => {
    const probe = await probeSmtp();
    const ok = probe.ok && mailerHealth.consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
    if (!ok) reply.code(503);
    return {
      ok,
      smtp: { reachable: probe.ok, ...(probe.error ? { error: probe.error } : {}) },
      sends: {
        lastSuccessAt: iso(mailerHealth.lastSuccessAt),
        lastErrorAt: iso(mailerHealth.lastErrorAt),
        lastError: mailerHealth.lastError,
        consecutiveFailures: mailerHealth.consecutiveFailures,
        totalSent: mailerHealth.totalSent,
        totalFailed: mailerHealth.totalFailed,
      },
    };
  });
}
