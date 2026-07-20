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

// Ces tests créent leurs développeurs via le flux de connexion lui-même
// (pas via createDeveloper), donc ils nettoient leurs propres emails.
const createdEmails: string[] = [];

after(async () => {
  if (createdEmails.length > 0) {
    await pool.query('DELETE FROM developers WHERE email = ANY($1::text[])', [createdEmails]);
    await pool.query('DELETE FROM magic_link_tokens WHERE email = ANY($1::text[])', [createdEmails]);
  }
  await app.close();
  await pool.end();
});

// Insère directement un token valide (comme le ferait la demande de magic
// link) pour tester la vérification sans dépendre du SMTP.
async function insertToken(email: string): Promise<string> {
  if (!createdEmails.includes(email)) createdEmails.push(email);
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
  createdEmails.push(email);
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
  createdEmails.push(email);
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

test('après connexion, on revient sur la page demandée (next)', async () => {
  const email = `${uniqueId('auth')}@test.local`;
  createdEmails.push(email);
  // Une page protégée redirige vers le login en mémorisant sa propre URL.
  const gate = await app.inject({ method: 'GET', url: '/games/new' });
  assert.equal(gate.statusCode, 302);
  assert.equal(gate.headers.location, '/login?next=%2Fgames%2Fnew');

  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO magic_link_tokens (email, token_hash, expires_at, redirect_to)
     VALUES ($1, $2, now() + interval '15 minutes', '/games/new')`,
    [email, createHash('sha256').update(token).digest('hex')],
  );
  const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  assert.equal(verify.headers.location, '/games/new');
});

test('une redirection externe est refusée (pas d’open redirect)', async () => {
  const email = `${uniqueId('auth')}@test.local`;
  createdEmails.push(email);
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO magic_link_tokens (email, token_hash, expires_at, redirect_to)
     VALUES ($1, $2, now() + interval '15 minutes', 'https://evil.example.com/')`,
    [email, createHash('sha256').update(token).digest('hex')],
  );
  const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  assert.equal(verify.headers.location, '/dashboard');
});

test('/signout révoque la session et renvoie à l’accueil', async () => {
  const email = `${uniqueId('auth')}@test.local`;
  createdEmails.push(email);
  const token = await insertToken(email);
  const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
  const session = verify.cookies.find((cookie) => cookie.name === 'gr_session')!;

  const signout = await app.inject({
    method: 'GET',
    url: '/signout',
    cookies: { gr_session: session.value },
  });
  assert.equal(signout.statusCode, 302);
  assert.equal(signout.headers.location, '/');
  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { gr_session: session.value },
  });
  assert.equal(me.statusCode, 401);
});

test('un token expiré est refusé', async () => {
  const email = `${uniqueId('auth')}@test.local`;
  createdEmails.push(email);
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
