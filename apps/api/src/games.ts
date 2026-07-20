import { randomBytes, randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { config } from './config.js';
import { currentDeveloper, type CurrentDeveloper } from './auth.js';

const GAME_COLUMNS = `id, name, url, domain, description, thumbnail_url AS "thumbnailUrl",
  sdk_key AS "sdkKey", status, badge_color AS "badgeColor", last_event_at AS "lastEventAt",
  is_local AS "isLocal", integration_verified_at AS "integrationVerifiedAt",
  created_at AS "createdAt"`;

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

function isLocalAddress(hostname: string): boolean {
  return hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function parseGameUrl(
  raw: string,
  declaredLocal: boolean,
): { url: string; domain: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'invalid URL (http(s) with a domain required)' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'invalid URL (http(s) with a domain required)' };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isLocalAddress(hostname)) {
    // localhost / IP : indispensable pour tester une intégration en local,
    // mais le dev doit l'assumer explicitement (case à cocher).
    if (!declaredLocal) {
      return { error: 'localhost or IP addresses require the "local address" checkbox' };
    }
  } else if (!hostname.includes('.')) {
    return { error: 'invalid URL (http(s) with a domain required)' };
  }
  return { url: parsed.href, domain: hostname };
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
    const isLocal = field('isLocal') === 'true';
    const rawUrl = field('url')?.trim();
    const location = rawUrl
      ? parseGameUrl(rawUrl, isLocal)
      : { error: 'invalid URL (http(s) with a domain required)' };
    if ('error' in location) {
      return reply.code(400).send({ error: location.error });
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
        `INSERT INTO games (developer_id, name, url, domain, description, thumbnail_url, sdk_key, is_local)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${GAME_COLUMNS}`,
        [developer.id, name, location.url, location.domain, description, thumbnailUrl, sdkKey, isLocal],
      );
      return reply.code(201).send(rows[0]);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'you already registered a game at this URL' });
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

  // Vérification d'intégration (US-2.2) :
  //  - jeu local : prouvée par la réception d'événements SDK ;
  //  - NDD internet : le backend télécharge la page et cherche la balise.
  app.post('/api/games/:id/verify', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `SELECT id, url, sdk_key, is_local, last_event_at FROM games
        WHERE id = $1 AND developer_id = $2`,
      [id, developer.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'game not found' });
    const game = rows[0] as {
      id: string;
      url: string;
      sdk_key: string;
      is_local: boolean;
      last_event_at: Date | null;
    };

    // Un échec (y compris lors d'un recheck) repasse le jeu en non-vérifié.
    const fail = async (message: string) => {
      await pool.query('UPDATE games SET integration_verified_at = NULL WHERE id = $1', [game.id]);
      return reply.code(400).send({ error: message });
    };

    if (game.is_local) {
      if (!game.last_event_at) {
        return fail(
          'no events received yet — open your game with the snippet installed, play a few seconds, then retry',
        );
      }
    } else {
      let html: string;
      try {
        const response = await fetch(game.url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'GameRankBot/1.0 (+integration check)' },
        });
        if (!response.ok) {
          return fail(`your page answered HTTP ${response.status}`);
        }
        html = (await response.text()).slice(0, 1_000_000);
      } catch {
        return fail('could not fetch your page — is it online?');
      }
      if (!html.includes('/sdk.js') || !html.includes(game.sdk_key)) {
        return fail('snippet not found on your page — paste it, deploy, then retry');
      }
    }

    const { rows: updated } = await pool.query(
      `UPDATE games SET integration_verified_at = now() WHERE id = $1 RETURNING ${GAME_COLUMNS}`,
      [game.id],
    );
    return updated[0];
  });

  app.patch('/api/games/:id', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { id } = request.params as { id: string };
    const { badgeColor } = (request.body ?? {}) as { badgeColor?: string };
    if (!badgeColor || !/^#[0-9a-f]{6}$/i.test(badgeColor)) {
      return reply.code(400).send({ error: 'badgeColor must be a #rrggbb hex color' });
    }
    const { rows } = await pool.query(
      `UPDATE games SET badge_color = $1 WHERE id = $2 AND developer_id = $3
       RETURNING ${GAME_COLUMNS}`,
      [badgeColor.toLowerCase(), id, developer.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'game not found' });
    return rows[0];
  });

  // Suppression par le propriétaire uniquement (WHERE developer_id) :
  // deux comptes ayant déclaré la même URL ont chacun leur propre jeu.
  app.delete('/api/games/:id', async (request, reply) => {
    const developer = await requireDeveloper(request, reply);
    if (!developer) return;
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `DELETE FROM games WHERE id = $1 AND developer_id = $2
       RETURNING thumbnail_url AS "thumbnailUrl"`,
      [id, developer.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'game not found' });
    const thumbnailUrl: string = rows[0].thumbnailUrl ?? '';
    if (thumbnailUrl.startsWith('/uploads/')) {
      await unlink(path.join(uploadsDir, path.basename(thumbnailUrl))).catch(() => {});
    }
    return reply.code(204).send();
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
