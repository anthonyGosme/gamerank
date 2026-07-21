import { createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { config } from './config.js';
import { sendMagicLink } from './mailer.js';

const SESSION_COOKIE = 'gr_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CurrentDeveloper {
  id: string;
  email: string;
  createdAt: string;
}

export async function currentDeveloper(request: FastifyRequest): Promise<CurrentDeveloper | null> {
  const cookie = request.cookies[SESSION_COOKIE];
  if (!cookie) return null;
  const { rows } = await pool.query(
    `SELECT d.id, d.email, d.created_at
       FROM sessions s
       JOIN developers d ON d.id = s.developer_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hash(cookie)],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, email: rows[0].email, createdAt: rows[0].created_at };
}

// Une destination de retour n'est acceptée que si elle est interne
// (chemin relatif simple) — sinon on offrirait une redirection ouverte.
export function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value.slice(0, 200);
}

// Crée (avec throttle) et envoie un magic link. Silencieux si email invalide
// ou déjà demandé récemment — pas d'énumération d'adresses.
async function issueMagicLink(
  email: unknown,
  next: unknown,
  ip: string,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized || !EMAIL_RE.test(normalized) || normalized.length > 254) return false;
  const { rows: recent } = await pool.query(
    `SELECT 1 FROM magic_link_tokens
      WHERE email = $1 AND created_at > now() - make_interval(secs => $2)`,
    [normalized, config.magicLinkThrottleSeconds],
  );
  if (recent.length === 0) {
    const token = newToken();
    await pool.query(
      `INSERT INTO magic_link_tokens (email, token_hash, request_ip, expires_at, redirect_to)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)`,
      [normalized, hash(token), ip, config.magicLinkTtlMinutes, safeRedirect(next)],
    );
    // L'envoi ne doit jamais faire échouer la requête (sinon 500 + énumération
    // d'emails, et en dev le tunnel SMTP peut être coupé). On log et on continue :
    // le token est déjà créé, le lien reste valable (tracé en dev).
    try {
      await sendMagicLink(normalized, `${config.appUrl}/api/auth/verify?token=${token}`);
    } catch (err) {
      log.error({ err, email: normalized }, 'magic link send failed');
    }
  }
  return true;
}

const sentPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your email — WebGameRank</title>
<style>body{font-family:system-ui,sans-serif;background:#2e1a5c;color:#f3f0fb;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#3a2470;border:1px solid #4d3488;border-radius:.8rem;padding:2rem;max-width:26rem;text-align:center}
a{color:#f59e0b}</style></head><body><div class="card">
<h1>Check your email</h1><p>If that address is valid, a login link is on its way. It expires in 15 minutes.</p>
<p><a href="/">← Back to WebGameRank</a></p></div></body></html>`;

export function registerAuthRoutes(app: FastifyInstance): void {
  // Version JSON (fetch) — répond toujours 204 : pas d'énumération d'emails.
  app.post('/api/auth/magic-link', async (request, reply) => {
    const { email, next } = (request.body ?? {}) as { email?: string; next?: string };
    const ok = await issueMagicLink(email, next, request.ip, request.log);
    return reply.code(ok ? 204 : 400).send(ok ? undefined : { error: 'invalid email' });
  });

  // Version formulaire classique (application/x-www-form-urlencoded) : une
  // vraie soumission permet au navigateur d'enregistrer l'email pour l'autofill.
  app.post('/login', async (request, reply) => {
    const { email, next } = (request.body ?? {}) as { email?: string; next?: string };
    await issueMagicLink(email, next, request.ip, request.log);
    return reply.type('text/html').send(sentPage);
  });

  // Vérifie le lien : usage unique, crée le compte à la première connexion.
  app.get('/api/auth/verify', async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) return reply.redirect('/login?error=invalid');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: tokens } = await client.query(
        `UPDATE magic_link_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING email, redirect_to AS "redirectTo"`,
        [hash(token)],
      );
      if (tokens.length === 0) {
        await client.query('ROLLBACK');
        return reply.redirect('/login?error=invalid');
      }

      // signup_ip n'est renseignée qu'à la création (signal CDC §4 / §7.4)
      const { rows: devs } = await client.query(
        `INSERT INTO developers (email, signup_ip) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [tokens[0].email, request.ip],
      );

      const sessionToken = newToken();
      await client.query(
        `INSERT INTO sessions (developer_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))`,
        [devs[0].id, hash(sessionToken), config.sessionTtlDays],
      );
      await client.query('COMMIT');

      setSessionCookie(reply, sessionToken);
      return reply.redirect(safeRedirect(tokens[0].redirectTo) ?? '/dashboard');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/api/me', async (request, reply) => {
    const developer = await currentDeveloper(request);
    if (!developer) return reply.code(401).send({ error: 'not signed in' });
    return developer;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await revokeSession(request, reply);
    return reply.code(204).send();
  });

  // Déconnexion par simple lien (bandeau latéral).
  app.get('/signout', async (request, reply) => {
    await revokeSession(request, reply);
    return reply.redirect('/');
  });
}

async function revokeSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cookie = request.cookies[SESSION_COOKIE];
  if (cookie) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hash(cookie)]);
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.sessionTtlDays * 24 * 3600,
  });
}
