import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dashboardSummary,
  getProspectForEmail,
  importCandidates,
  listDuplicateEmails,
  listImports,
  listProspects,
  latestExtractionRun,
  openDatabase,
  purgeOutreachData,
  recoverInterruptedExtractions,
  setProspectMessageSent,
} from './database.js';
import { activeSiteExtraction, startSiteExtraction } from './site-analysis.js';
import { createOutreachMessage } from './message-template.js';
import { sendOutreachEmail, sendOutreachTestEmail } from './outreach-mailer.js';

const applicationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(applicationDirectory, '../..');
const publicDirectory = resolve(applicationDirectory, 'public');
const databasePath = resolve(
  process.env.OUTREACH_DATABASE_PATH ?? resolve(repositoryDirectory, 'data/outreach.sqlite'),
);
const port = Number(process.env.OUTREACH_PORT ?? 3100);
const host = '127.0.0.1';
const maximumImportBytes = 10 * 1024 * 1024;
const emailSendsInProgress = new Set();

mkdirSync(dirname(databasePath), { recursive: true });
const database = openDatabase(databasePath);
recoverInterruptedExtractions(database);

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function sendFile(response, path) {
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
  };
  try {
    const body = readFileSync(path);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'not found' });
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumImportBytes) throw new Error('Fichier trop volumineux (10 Mo maximum).');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeFileName(request) {
  const encoded = String(request.headers['x-file-name'] ?? 'import.json');
  try {
    return decodeURIComponent(encoded).replaceAll(/[^\p{L}\p{N}_. ()-]/gu, '_').slice(0, 200);
  } catch {
    return 'import.json';
  }
}

function isTrustedLocalMutation(request) {
  const origin = String(request.headers.origin ?? '');
  const fetchSite = String(request.headers['sec-fetch-site'] ?? '');
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  if (origin && !allowedOrigins.has(origin)) return false;
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
      return sendJson(response, 200, {
        summary: dashboardSummary(database),
        imports: listImports(database),
        duplicateEmails: listDuplicateEmails(database),
        extractionRun: latestExtractionRun(database),
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/prospects') {
      const prospects = listProspects(database, {
        status: url.searchParams.get('status'),
        emailSearchStatus: url.searchParams.get('emailSearchStatus'),
        query: url.searchParams.get('q'),
        limit: url.searchParams.get('limit'),
      }).map((prospect) => ({
        ...prospect,
        preparedMessage: createOutreachMessage(prospect),
      }));
      return sendJson(
        response,
        200,
        prospects,
      );
    }

    if (request.method === 'POST' && url.pathname === '/api/import') {
      if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
        return sendJson(response, 415, { error: 'Le fichier doit être au format JSON.' });
      }
      const content = await readBody(request);
      const payload = JSON.parse(content);
      const result = importCandidates(database, payload, {
        contentHash: createHash('sha256').update(content).digest('hex'),
        sourcePath: safeFileName(request),
      });
      return sendJson(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/api/extraction/start') {
      const result = startSiteExtraction(database);
      return sendJson(response, result.started ? 202 : 409, result);
    }

    if (request.method === 'POST' && url.pathname === '/api/database/purge') {
      if (activeSiteExtraction()) {
        return sendJson(response, 409, {
          error: 'Impossible de purger la base pendant une analyse.',
        });
      }
      const content = await readBody(request);
      const confirmation = content ? JSON.parse(content) : {};
      if (confirmation.confirm !== 'PURGER') {
        return sendJson(response, 400, { error: 'Confirmation de purge invalide.' });
      }
      return sendJson(response, 200, { deleted: purgeOutreachData(database) });
    }

    if (request.method === 'POST' && url.pathname === '/api/email/test') {
      if (!isTrustedLocalMutation(request)) {
        return sendJson(response, 403, { error: 'Origine de la requête refusée.' });
      }
      const result = await sendOutreachTestEmail();
      return sendJson(response, 200, {
        ...result,
        gameTitle: 'test game',
        candidateUrl: 'https://test.com/',
      });
    }

    const emailSendMatch = url.pathname.match(
      /^\/api\/prospects\/([^/]+)\/send-email$/,
    );
    if (request.method === 'POST' && emailSendMatch) {
      if (!isTrustedLocalMutation(request)) {
        return sendJson(response, 403, { error: 'Origine de la requête refusée.' });
      }
      const redditId = decodeURIComponent(emailSendMatch[1]);
      if (emailSendsInProgress.has(redditId)) {
        return sendJson(response, 409, { error: 'Un envoi est déjà en cours pour ce prospect.' });
      }
      const prospect = getProspectForEmail(database, redditId);
      if (!prospect) return sendJson(response, 404, { error: 'Prospect introuvable.' });
      if (prospect.messageStatus === 'sent') {
        return sendJson(response, 409, { error: 'Ce prospect est déjà marqué comme envoyé.' });
      }
      if (!prospect.emailAddress) {
        return sendJson(response, 400, {
          error: 'Aucune adresse e-mail unique n’a été retenue pour ce prospect.',
        });
      }

      emailSendsInProgress.add(redditId);
      try {
        const delivery = await sendOutreachEmail({
          to: prospect.emailAddress,
          prospect,
        });
        const status = setProspectMessageSent(database, redditId, true);
        return sendJson(response, 200, { ...delivery, ...status });
      } finally {
        emailSendsInProgress.delete(redditId);
      }
    }

    const messageStatusMatch = url.pathname.match(
      /^\/api\/prospects\/([^/]+)\/message-status$/,
    );
    if (request.method === 'POST' && messageStatusMatch) {
      const content = await readBody(request);
      const payload = JSON.parse(content || '{}');
      if (typeof payload.sent !== 'boolean') {
        return sendJson(response, 400, { error: 'Le statut envoyé est invalide.' });
      }
      const redditId = decodeURIComponent(messageStatusMatch[1]);
      return sendJson(
        response,
        200,
        setProspectMessageSent(database, redditId, payload.sent),
      );
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendFile(response, resolve(publicDirectory, 'index.html'));
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return response.end();
    }
    if (request.method === 'GET' && ['/app.js', '/styles.css'].includes(url.pathname)) {
      return sendFile(response, resolve(publicDirectory, url.pathname.slice(1)));
    }
    return sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const clientError =
      error instanceof SyntaxError ||
      /version 1|Publication invalide|format JSON|trop volumineux/i.test(message);
    return sendJson(response, clientError ? 400 : 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Gamerank Outreach : http://${host}:${port}`);
  console.log(`Base SQLite : ${databasePath}`);
});

function close() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
