import { createHash, randomBytes } from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { uniqueId } from './helpers.js';

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  await app.close();
  await pool.end();
});

// Insère directement un token valide (comme le ferait la demande de magic
// link) pour tester la vérification sans dépendre du SMTP.
async function insertToken(email: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO magic_link_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')`,
    [email, hash],
  );
  return token;
}

test('un email invalide est refusé', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/magic-link',
    payload: { email: 'pas-un-email' },
  });
  assert.equal(response.statusCode, 400);
});

test('le lien crée le compte, ouvre une session, et est à usage unique', async () => {
  const email = `${uniqueId('auth')}@test.local`;
  const token = await insertToken(email);

  const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  assert.equal(verify.statusCode, 302);
  assert.equal(verify.headers.location, '/dashboard');
  const session = verify.cookies.find((cookie) => cookie.name === 'gr_session');
  assert.ok(session, 'cookie de session attendu');

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { gr_session: session!.value },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().email, email);

  // Réutilisation du même lien : refusée.
  const reuse = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  assert.equal(reuse.headers.location, '/login?error=invalid');

  // Reconnexion : même compte, pas de doublon.
  const secondToken = await insertToken(email);
  await app.inject({ method: 'GET', url: `/api/auth/verify?token=${secondToken}` });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM developers WHERE email = $1', [
    email,
  ]);
  assert.equal(rows[0].n, 1);
});

test('le logout révoque la session', async () => {
  const email = `${uniqueId('auth')}@test.local`;
  const token = await insertToken(email);
  const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const session = verify.cookies.find((cookie) => cookie.name === 'gr_session')!;

  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    cookies: { gr_session: session.value },
  });
  assert.equal(logout.statusCode, 204);

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { gr_session: session.value },
  });
  assert.equal(me.statusCode, 401);
});

test('un token expiré est refusé', async () => {
  const email = `${uniqueId('auth')}@test.local`;
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO magic_link_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, now() - interval '1 minute')`,
    [email, hash],
  );
  const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  assert.equal(verify.headers.location, '/login?error=invalid');
});
