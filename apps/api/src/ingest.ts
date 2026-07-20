import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { clickhouse } from './clickhouse.js';

const EVENT_TYPES = new Set(['load', 'session_start', 'heartbeat', 'session_end']);
const MAX_EVENTS_PER_BATCH = 50;
const MAX_ID_LENGTH = 64;
// Plafond par événement, calé sur l'intervalle max du heartbeat SDK (135 s)
// + marge ; la cohérence fine (temps déclaré ≤ temps écoulé) est re-vérifiée
// à l'agrégation (CDC §2).
const MAX_ACTIVE_MS = 150_000;

interface IncomingEvent {
  type?: unknown;
  visitorId?: unknown;
  sessionId?: unknown;
  activeMs?: unknown;
}

interface IngestBody {
  key?: unknown;
  sdkVersion?: unknown;
  events?: unknown;
}

function originHostname(request: FastifyRequest): string | null {
  const source = request.headers.origin ?? request.headers.referer;
  if (typeof source !== 'string') return null;
  try {
    return new URL(source).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Réponse 204 systématique : un émetteur invalide n'apprend rien (US-4.4).
export function registerIngestRoutes(app: FastifyInstance): void {
  app.post('/api/ingest', async (request, reply) => {
    try {
      await handleBatch(request);
    } catch (err) {
      request.log.warn({ err }, 'ingest failed');
    }
    return reply.code(204).send();
  });
}

async function handleBatch(request: FastifyRequest): Promise<void> {
  // sendBeacon envoie souvent en text/plain : accepter les deux formes.
  const raw = request.body;
  const body: IngestBody =
    typeof raw === 'string' ? (JSON.parse(raw) as IngestBody) : ((raw ?? {}) as IngestBody);

  const key = typeof body.key === 'string' ? body.key : null;
  if (!key || !Array.isArray(body.events) || body.events.length === 0) return;

  const { rows: games } = await pool.query(
    `SELECT id, domain FROM games WHERE sdk_key = $1 AND status <> 'hidden'`,
    [key],
  );
  if (games.length === 0) return;
  const game = games[0] as { id: string; domain: string };

  // Contrôle d'origine : l'événement doit venir du domaine déclaré (US-2.2).
  const hostname = originHostname(request);
  if (!hostname || (hostname !== game.domain && !hostname.endsWith(`.${game.domain}`))) {
    return;
  }

  const sdkVersion = typeof body.sdkVersion === 'string' ? body.sdkVersion.slice(0, 32) : '';
  const userAgent = (request.headers['user-agent'] ?? '').slice(0, 256);

  const rows = (body.events as IncomingEvent[])
    .slice(0, MAX_EVENTS_PER_BATCH)
    .filter(
      (event) =>
        typeof event?.type === 'string' &&
        EVENT_TYPES.has(event.type) &&
        typeof event.visitorId === 'string' &&
        event.visitorId.length > 0 &&
        event.visitorId.length <= MAX_ID_LENGTH &&
        typeof event.sessionId === 'string' &&
        event.sessionId.length > 0 &&
        event.sessionId.length <= MAX_ID_LENGTH,
    )
    .map((event) => ({
      game_id: game.id,
      visitor_id: event.visitorId as string,
      session_id: event.sessionId as string,
      event_type: event.type as string,
      active_ms: Math.min(Math.max(Number(event.activeMs) || 0, 0), MAX_ACTIVE_MS),
      ip: request.ip,
      user_agent: userAgent,
      sdk_version: sdkVersion,
    }));
  if (rows.length === 0) return;

  await clickhouse.insert({ table: 'events', values: rows, format: 'JSONEachRow' });
  await pool.query('UPDATE games SET last_event_at = now() WHERE id = $1', [game.id]);
}
