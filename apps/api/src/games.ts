import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { config } from './config.js';
import { currentDeveloper, type CurrentDeveloper } from './auth.js';

const GAME_COLUMNS = `id, name, url, domain, description, thumbnail_url AS "thumbnailUrl",
  sdk_key AS "sdkKey", status, last_event_at AS "lastEventAt", created_at AS "createdAt"`;

const THUMBNAIL_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const uploadsDir = path.resolve(config.uploadsDir);

interface MultipartValue {
  value?: unknown;
  mimetype?: string;
  toBuffer?: () => Promise<Buffer>;
}

async function requireDeveloper(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CurrentDeveloper | null> {
  const developer = await currentDeveloper(request);
  if (!developer) {
    await reply.code(401).send({ error: 'not signed in' });
    return null;
  }
  return developer;
}

function parseGameUrl(raw: string): { url: string; domain: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // localhost accepté : indispensable pour tester une intégration SDK en local.
  if (parsed.hostname !== 'localhost' && !parsed.hostname.includes('.')) return null;
  return { url: parsed.href, domain: parsed.hostname.toLowerCase() };
}

export function registerGameRoutes(app: FastifyInstance): void {
  app.post('/api/games', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;

    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'multipart form required (thumbnail must be uploaded)' });
    }
    const body = (request.body ?? {}) as Record<string, MultipartValue | undefined>;
    const field = (key: string): string | undefined => {
      const value = body[key]?.value;
      return typeof value === 'string' ? value : undefined;
    };

    const name = field('name')?.trim();
    if (!name || name.length > 100) {
      return reply.code(400).send({ error: 'name required (100 characters max)' });
    }
    const rawUrl = field('url')?.trim();
    const location = rawUrl ? parseGameUrl(rawUrl) : null;
    if (!location) {
      return reply.code(400).send({ error: 'invalid URL (http(s) with a domain required)' });
    }
    const description = field('description')?.trim().slice(0, 2000);
    if (!description) {
      return reply.code(400).send({ error: 'description required' });
    }

    const thumbnail = body.thumbnail;
    if (!thumbnail?.mimetype || typeof thumbnail.toBuffer !== 'function') {
      return reply.code(400).send({ error: 'thumbnail required' });
    }
    const extension = THUMBNAIL_TYPES[thumbnail.mimetype];
    if (!extension) {
      return reply.code(400).send({ error: 'unsupported thumbnail format (PNG, JPEG, WebP or GIF)' });
    }
    const imageBytes = await thumbnail.toBuffer();
    if (imageBytes.length === 0) {
      return reply.code(400).send({ error: 'thumbnail required' });
    }

    const { rows: counts } = await pool.query(
      'SELECT count(*)::int AS n FROM games WHERE developer_id = $1',
      [developer.id],
    );
    if (counts[0].n >= config.maxGamesPerDeveloper) {
      return reply
        .code(400)
        .send({ error: `limit of ${config.maxGamesPerDeveloper} games per account reached` });
    }

    const thumbnailUrl = `/uploads/${randomUUID()}.${extension}`;
    await writeFile(path.join(uploadsDir, path.basename(thumbnailUrl)), imageBytes);

    const sdkKey = `gr_${randomBytes(18).toString('base64url')}`;
    try {
      const { rows } = await pool.query(
        `INSERT INTO games (developer_id, name, url, domain, description, thumbnail_url, sdk_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${GAME_COLUMNS}`,
        [developer.id, name, location.url, location.domain, description, thumbnailUrl, sdkKey],
      );
      return reply.code(201).send(rows[0]);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'a game is already registered at this URL' });
      }
      throw err;
    }
  });

  app.get('/api/games', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { rows } = await pool.query(
      `SELECT ${GAME_COLUMNS} FROM games WHERE developer_id = $1 ORDER BY created_at DESC`,
      [developer.id],
    );
    return rows;
  });

  app.get('/api/games/:id', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `SELECT ${GAME_COLUMNS} FROM games WHERE id = $1 AND developer_id = $2`,
      [id, developer.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'game not found' });
    return rows[0];
  });
}
