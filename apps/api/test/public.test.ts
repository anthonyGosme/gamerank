import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { clickhouse } from '../src/clickhouse.js';
import { createDeveloper, createGame, cleanupCreated } from './helpers.js';
import { slugify } from '../src/public.js';
import { config } from '../src/config.js';

let app: FastifyInstance;
let ranked: { id: string };
let fresh: { id: string };

before(async () => {
  app = await buildApp({ logger: false });
  const developer = await createDeveloper();
  ranked = await createGame(developer.id);
  fresh = await createGame(developer.id);
  await pool.query(
    `UPDATE games SET name = 'Super Puzzle Quest', category = 'puzzle',
            short_description = 'Match wits with the toughest puzzle on the web.',
            current_score = 71.4, current_rank = 1, status = 'ranked'
      WHERE id = $1`,
    [ranked.id],
  );
  await pool.query(
    `UPDATE games SET name = 'Brand New Shooter', category = 'shooter',
            short_description = 'Fresh out of the oven.',
            status = 'awaiting_peer_review'
      WHERE id = $1`,
    [fresh.id],
  );
});

after(async () => {
  await cleanupCreated();
  await app.close();
  await clickhouse.close();
  await pool.end();
});

test('la home est publique : Top + Latest, sans authentification', async () => {
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Top games/);
  assert.match(response.body, /Latest arrivals/);
  assert.match(response.body, /Super Puzzle Quest/); // classé → Top
  assert.match(response.body, /Brand New Shooter/); // sans score → Latest
  assert.match(response.body, /For developers/);
  // Les titres de section mènent aux pages dédiées.
  assert.match(response.body, /href="\/top"/);
  assert.match(response.body, /href="\/new"/);
  assert.match(response.body, /href="\/latest"/);
});

test('les pages de liste dédiées répondent', async () => {
  for (const path of ['/top', '/new', '/latest']) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200, `${path} doit répondre 200`);
  }
  const top = await app.inject({ method: 'GET', url: '/top' });
  assert.match(top.body, /Super Puzzle Quest/);
  const latest = await app.inject({ method: 'GET', url: '/latest' });
  assert.match(latest.body, /Brand New Shooter/);
});

test('page de catégorie : contenu, tris et pagination', async () => {
  const top = await app.inject({ method: 'GET', url: '/c/puzzle' });
  assert.equal(top.statusCode, 200);
  assert.match(top.body, /Super Puzzle Quest/);
  assert.match(top.body, /sort=latest/); // les trois onglets de tri
  // Le pagineur ne s'affiche qu'au-delà d'une page.
  assert.doesNotMatch(top.body, /Page 1 of/);

  const latest = await app.inject({ method: 'GET', url: '/c/shooter?sort=latest' });
  assert.match(latest.body, /Brand New Shooter/);

  // Un jeu sans score n'apparaît pas dans le tri « top » de sa catégorie.
  const topShooter = await app.inject({ method: 'GET', url: '/c/shooter?sort=top' });
  assert.doesNotMatch(topShooter.body, /Brand New Shooter/);

  const unknown = await app.inject({ method: 'GET', url: '/c/nonexistent' });
  assert.equal(unknown.statusCode, 404);
});

test('fiche publique : SEO (canonical, og) et score', async () => {
  const slug = slugify('Super Puzzle Quest');
  const response = await app.inject({ method: 'GET', url: `/g/${ranked.id}/${slug}` });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Super Puzzle Quest/);
  assert.match(response.body, new RegExp(`canonical" href="/g/${ranked.id}/${slug}`));
  assert.match(response.body, /og:title/);
  assert.match(response.body, />71</); // score arrondi affiché
  assert.match(response.body, /#1 global/); // rang global affiché

  // L'id seul (sans slug) fonctionne aussi.
  const noSlug = await app.inject({ method: 'GET', url: `/g/${ranked.id}` });
  assert.equal(noSlug.statusCode, 200);
});

test('/go : referer same-site → site du jeu (clic compté) ; sinon → fiche interne (pas de clic)', async () => {
  await pool.query('UPDATE games SET play_clicks = 0 WHERE id = $1', [ranked.id]);
  const internal = `/g/${ranked.id}/${slugify('Super Puzzle Quest')}`;
  const sameSiteRef = `${config.appUrl}/g/${ranked.id}/x`;

  // Sans referer → fiche interne (SEO), pas de clic compté.
  const cold = await app.inject({ method: 'GET', url: `/go/${ranked.id}` });
  assert.equal(cold.statusCode, 302);
  assert.equal(cold.headers.location, internal);

  // Referer externe (autre site) → fiche interne, pas de clic.
  const ext = await app.inject({
    method: 'GET',
    url: `/go/${ranked.id}`,
    headers: { referer: 'https://google.com/search' },
  });
  assert.equal(ext.headers.location, internal);

  // Referer same-site → vrai clic : site du jeu (URL absolue) + clic compté.
  const real = await app.inject({
    method: 'GET',
    url: `/go/${ranked.id}`,
    headers: { referer: sameSiteRef },
  });
  assert.equal(real.statusCode, 302);
  assert.match(real.headers.location as string, /^https?:\/\//);
  assert.doesNotMatch(real.headers.location as string, /^\/g\//);

  const { rows } = await pool.query('SELECT play_clicks FROM games WHERE id = $1', [ranked.id]);
  assert.equal(rows[0].play_clicks, 1); // seul le hit same-site a compté
});

test('methodology, sitemap et robots sont servis', async () => {
  const methodology = await app.inject({ method: 'GET', url: '/methodology' });
  assert.equal(methodology.statusCode, 200);
  assert.match(methodology.body, /real play/i);
  assert.doesNotMatch(methodology.body, /Wilson|0,95|exponent/i); // pas de science précise

  const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml' });
  assert.equal(sitemap.statusCode, 200);
  assert.match(sitemap.body, new RegExp(`/g/${ranked.id}/`));
  assert.match(sitemap.body, /\/c\/puzzle/);

  const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
  assert.match(robots.body, /Sitemap:/);
});

test("un jeu sans snippet vérifié n'est listé nulle part", async () => {
  const developer = await createDeveloper();
  const unverified = await createGame(developer.id); // statut par défaut : awaiting_snippet
  await pool.query(
    `UPDATE games SET name = 'Unverified Spam Game', category = 'puzzle' WHERE id = $1`,
    [unverified.id],
  );

  for (const path of ['/', '/latest', '/c/puzzle?sort=latest', '/sitemap.xml']) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.doesNotMatch(
      response.body,
      /Unverified Spam Game|Unverified/,
      `${path} ne doit pas lister un jeu non vérifié`,
    );
  }

  // Sa fiche reste joignable (le badge fraîchement installé pointe dessus)
  // mais elle est désindexée et signalée comme non listée.
  const page = await app.inject({ method: 'GET', url: `/g/${unverified.id}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /robots" content="noindex/);
  assert.match(page.body, /not listed publicly yet/);
});

test('un jeu masqué disparaît du public (fiche, /go, sitemap)', async () => {
  await pool.query(`UPDATE games SET status = 'hidden' WHERE id = $1`, [fresh.id]);
  assert.equal((await app.inject({ method: 'GET', url: `/g/${fresh.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/go/${fresh.id}` })).statusCode, 404);
  const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml' });
  assert.doesNotMatch(sitemap.body, new RegExp(fresh.id));
});

test('la déclaration exige catégorie et description courte', async () => {
  const { multipartGame } = await import('./helpers.js');
  const { createHash, randomBytes } = await import('node:crypto');
  const developer = await createDeveloper();
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (developer_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [developer.id, createHash('sha256').update(token).digest('hex')],
  );
  const attempt = (fields: Record<string, string>) => {
    const { payload, headers } = multipartGame({
      name: 'Missing fields',
      url: `https://missing-${Date.now()}.test.local/`,
      description: 'long enough',
      isLocal: 'false',
      ...fields,
    });
    return app.inject({
      method: 'POST',
      url: '/api/games',
      cookies: { gr_session: token },
      headers,
      payload,
    });
  };
  const badCategory = await attempt({ category: 'not-a-category' });
  assert.equal(badCategory.statusCode, 400);
  assert.match(badCategory.json().error, /category/);
  const noShort = await attempt({ shortDescription: '' });
  assert.equal(noShort.statusCode, 400);
  assert.match(noShort.json().error, /short description/);
});
