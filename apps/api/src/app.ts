import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { currentDeveloper, registerAuthRoutes } from './auth.js';
import { registerGameRoutes, uploadsDir } from './games.js';
import { registerIngestRoutes } from './ingest.js';
import { registerVoteRoutes } from './votes.js';
import { registerJuryRoutes } from './jury.js';
import { registerPublicRoutes } from './public.js';
import { registerAdminRoutes } from './admin.js';
import { registerHealthRoutes } from './health.js';
import { loginPage, dashboardPage, newGamePage, gamePage, adminPage, juryPage } from './pages.js';

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true });

  await mkdir(uploadsDir, { recursive: true });
  await app.register(cookie);
  // Formulaire de login classique (application/x-www-form-urlencoded) : une
  // vraie soumission permet au navigateur d'enregistrer l'email → autofill.
  await app.register(formbody);
  // L'ingestion est appelée cross-origin depuis les sites des jeux ; la
  // validation d'origine réelle se fait dans le handler (clé SDK + domaine).
  await app.register(cors, { origin: true });
  // sendBeacon émet souvent en text/plain : le corps arrive en chaîne brute.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, payload, done) =>
    done(null, payload),
  );
  await app.register(multipart, {
    attachFieldsToBody: true,
    limits: { fileSize: config.maxThumbnailBytes, files: 1 },
  });
  await app.register(fastifyStatic, { root: uploadsDir, prefix: '/uploads/' });

  app.setErrorHandler((err: Error & { code?: string }, _request, reply) => {
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: `thumbnail too large (max ${Math.round(config.maxThumbnailBytes / 1024 / 1024)} MB)`,
      });
    }
    throw err;
  });

  registerAuthRoutes(app);
  registerGameRoutes(app);
  registerIngestRoutes(app);
  registerVoteRoutes(app);
  registerJuryRoutes(app);
  registerPublicRoutes(app); // sert aussi la home publique « / »
  registerAdminRoutes(app);
  registerHealthRoutes(app); // /health, /health/ready, /health/email

  app.get('/login', async (_request, reply) => reply.type('text/html').send(loginPage));

  // Pages développeur : la connexion est exigée AVANT l'affichage, sinon un
  // formulaire rempli serait perdu au moment de l'envoi (US-2.1).
  const authed = (path: string, page: string) =>
    app.get(path, async (request, reply) => {
      if (!(await currentDeveloper(request))) {
        return reply.redirect(`/login?next=${encodeURIComponent(request.url)}`);
      }
      return reply.type('text/html').send(page);
    });
  authed('/dashboard', dashboardPage);
  authed('/games/new', newGamePage);
  authed('/games/:id', gamePage);
  authed('/admin', adminPage);
  authed('/jury', juryPage);

  // Fichiers buildés par packages/sdk (npm run build:sdk).
  for (const file of ['sdk.js', 'widget.js']) {
    const filePath = path.resolve(`../../packages/sdk/dist/${file}`);
    app.get(`/${file}`, async (_request, reply) => {
      try {
        const js = await readFile(filePath);
        return reply
          .type('application/javascript; charset=utf-8')
          .header('Cache-Control', 'public, max-age=300')
          .send(js);
      } catch {
        return reply.code(404).type('application/javascript').send('// not built: npm run build:sdk');
      }
    });
  }

  return app;
}
