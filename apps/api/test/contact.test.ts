import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { registerContactRoutes } from '../src/contact.js';
import type { ContactMessage } from '../src/mailer.js';

const app = Fastify({ logger: false });
await app.register(formbody);

const sent: ContactMessage[] = [];
registerContactRoutes(app, async (message) => {
  sent.push(message);
});

after(async () => {
  await app.close();
});

test('GET /contact affiche le formulaire public', async () => {
  const response = await app.inject({ method: 'GET', url: '/contact' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<h1>Contact<\/h1>/);
  assert.match(response.body, /action="\/contact"/);
  assert.match(response.body, /Send Anthony a message/);
  assert.match(response.body, /maxlength="5000"/);
});

test('POST /contact valide puis transmet le message', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/contact',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      name: 'Ada Lovelace',
      email: 'ADA@example.com',
      subject: 'My game',
      message: 'Could you help me with my listing?',
    }).toString(),
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/contact?sent=1');
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { ...sent[0], ip: undefined },
    {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      subject: 'My game',
      message: 'Could you help me with my listing?',
      ip: undefined,
    },
  );
});

test('POST /contact refuse les champs invalides sans envoyer de mail', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/contact',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      name: 'Ada',
      email: 'not-an-email',
      subject: 'Question',
      message: 'Hello',
    }).toString(),
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body, /Please check every field/);
  assert.equal(sent.length, 1);
});

test('POST /contact ignore silencieusement le champ antispam', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/contact',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      name: 'Bot',
      email: 'bot@example.com',
      subject: 'Spam',
      message: 'Spam',
      website: 'https://spam.example.com',
    }).toString(),
  });

  assert.equal(response.statusCode, 302);
  assert.equal(sent.length, 1);
});
