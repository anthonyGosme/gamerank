import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  dashboardSummary,
  importCandidates,
  listDuplicateEmails,
  listPendingSiteCandidates,
  listProspects,
  createExtractionRun,
  finishExtractionRun,
  latestExtractionRun,
  markSiteAnalysisFinished,
  markSiteAnalysisStarted,
  openDatabase,
  purgeOutreachData,
  registerEmailOccurrence,
  setProspectMessageSent,
} from '../src/database.js';

function payload() {
  return {
    version: 1,
    source: 'https://www.reddit.com/r/playmygame/',
    capturedAt: '2026-07-24T10:00:00.000Z',
    posts: [
      {
        redditId: 'site1',
        postUrl: 'https://www.reddit.com/r/playmygame/comments/site1/',
        title: 'Hosted game',
        body: 'Template Game Title: Actual Game Name Playable Link: https://game.example/play Platform: Web',
        candidateLinks: [
          {
            url: 'https://game.example/play',
            kind: 'website',
            score: 50,
            text: 'Play',
            source: 'anchor',
          },
        ],
      },
      {
        redditId: 'platform1',
        postUrl: 'https://www.reddit.com/r/playmygame/comments/platform1/',
        title: 'Itch game',
        candidateLinks: [
          {
            url: 'https://author.itch.io/game',
            kind: 'game_platform',
            score: 45,
            text: 'Game',
            source: 'anchor',
          },
        ],
      },
      {
        redditId: 'review1',
        postUrl: 'https://www.reddit.com/r/playmygame/comments/review1/',
        title: 'Missing link',
        candidateLinks: [],
      },
    ],
  };
}

test('importe et classe les prospects dans SQLite', () => {
  const database = openDatabase(':memory:');
  const data = payload();
  const result = importCandidates(database, data, {
    contentHash: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    sourcePath: '/tmp/candidates.json',
  });

  assert.deepEqual(result.statuses, {
    needs_review: 1,
    platform_only: 1,
    site_found: 1,
  });
  assert.equal(result.candidateLinks, 2);
  assert.equal(
    database.prepare('SELECT host FROM candidate_links WHERE reddit_id = ?').get('site1').host,
    'game.example',
  );
  assert.equal(listProspects(database, { query: 'hosted game' })[0].gameTitle, 'Actual Game Name');
  assert.equal(listProspects(database, { query: 'actual game name' })[0].redditId, 'site1');
  database.close();
});

test('purge tous les imports et leurs données dérivées', () => {
  const database = openDatabase(':memory:');
  const data = payload();
  importCandidates(database, data, {
    contentHash: 'purge-content',
    sourcePath: '/tmp/candidates.json',
  });

  const deleted = purgeOutreachData(database);

  assert.equal(deleted.imports, 1);
  assert.equal(deleted.prospects, 3);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM imports').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prospects').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM candidate_links').get().count, 0);
  database.close();
});

test('mémorise et permet d’annuler le statut envoyé', () => {
  const database = openDatabase(':memory:');
  importCandidates(database, payload(), {
    contentHash: 'message-status-content',
    sourcePath: '/tmp/candidates.json',
  });

  const sent = setProspectMessageSent(database, 'site1', true);
  assert.equal(sent.messageStatus, 'sent');
  assert.match(sent.messageSentAt, /^20\d{2}-/);
  assert.equal(listProspects(database, { query: 'site1' })[0].messageStatus, 'sent');

  const cancelled = setProspectMessageSent(database, 'site1', false);
  assert.deepEqual({ ...cancelled }, {
    messageStatus: 'not_sent',
    messageSentAt: null,
  });
  database.close();
});

test('reclasse les plateformes connues même avec un ancien export', () => {
  const database = openDatabase(':memory:');
  const data = {
    version: 1,
    posts: [
      {
        redditId: 'crazy1',
        postUrl: 'https://www.reddit.com/r/playmygame/comments/crazy1/',
        title: 'Crazy game',
        candidateLinks: [
          {
            url: 'https://www.crazygames.com/game/example',
            kind: 'website',
            score: 50,
          },
        ],
      },
      {
        redditId: 'itch1',
        postUrl: 'https://www.reddit.com/r/playmygame/comments/itch1/',
        title: 'Itch game from old export',
        candidateLinks: [
          {
            url: 'https://studio.itch.io/example',
            kind: 'website',
            score: 50,
          },
        ],
      },
    ],
  };
  const result = importCandidates(database, data, {
    contentHash: 'crazygames-content',
    sourcePath: '/tmp/candidates.json',
  });

  assert.deepEqual(result.statuses, { platform_only: 2 });
  assert.equal(listPendingSiteCandidates(database).length, 0);
  assert.equal(
    database.prepare(`SELECT kind FROM candidate_links WHERE reddit_id = 'crazy1'`).get().kind,
    'game_platform',
  );
  assert.equal(
    database.prepare(`SELECT kind FROM candidate_links WHERE reddit_id = 'itch1'`).get().kind,
    'game_platform',
  );
  database.close();
});

test('réimporter le même fichier ne crée aucun doublon', () => {
  const database = openDatabase(':memory:');
  const data = payload();
  const metadata = {
    contentHash: 'same-content',
    sourcePath: '/tmp/candidates.json',
  };
  importCandidates(database, data, metadata);
  const second = importCandidates(database, data, metadata);

  assert.equal(second.alreadyImported, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prospects').get().count, 3);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM imports').get().count, 1);
  database.close();
});

test('la liste des prospects est filtrable par statut et domaine', () => {
  const database = openDatabase(':memory:');
  const data = payload();
  importCandidates(database, data, {
    contentHash: 'list-content',
    sourcePath: '/tmp/candidates.json',
  });

  assert.deepEqual(
    listProspects(database, { status: 'site_found' }).map((row) => row.redditId),
    ['site1'],
  );
  assert.match(listProspects(database, { status: 'site_found' })[0].importedAt, /^20\d{2}-/);
  assert.deepEqual(
    listProspects(database, { query: 'itch.io' }).map((row) => row.redditId),
    ['platform1'],
  );
  database.close();
});

test('un e-mail déjà retenu est tracé comme doublon sans second contact', () => {
  const database = openDatabase(':memory:');
  const data = payload();
  importCandidates(database, data, {
    contentHash: 'email-content',
    sourcePath: '/tmp/candidates.json',
  });

  const first = registerEmailOccurrence(database, {
    redditId: 'site1',
    email: 'Studio@Example.com',
    sourceUrl: 'https://game.example/contact',
  });
  const duplicate = registerEmailOccurrence(database, {
    redditId: 'platform1',
    email: 'studio@example.com',
    sourceUrl: 'https://author.itch.io/game',
  });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(dashboardSummary(database).emails, 1);
  assert.equal(dashboardSummary(database).duplicateEmails, 1);
  const duplicates = listDuplicateEmails(database).map((row) => ({ ...row }));
  assert.deepEqual(duplicates, [
    {
      email: 'Studio@Example.com',
      retainedFor: 'site1',
      duplicateFor: 'platform1',
      sourceUrl: 'https://author.itch.io/game',
      reason: 'email_already_retained',
      discoveredAt: duplicates[0].discoveredAt,
    },
  ]);
  database.close();
});

test('suit une analyse de site et met à jour le statut du prospect', () => {
  const database = openDatabase(':memory:');
  const data = payload();
  importCandidates(database, data, {
    contentHash: 'extraction-content',
    sourcePath: '/tmp/candidates.json',
  });
  const [candidate] = listPendingSiteCandidates(database, 10);
  const run = createExtractionRun(database, 1);
  markSiteAnalysisStarted(database, run.id, candidate);
  markSiteAnalysisFinished(database, run.id, candidate, {
    emails: [{ email: 'hello@game.example' }],
    contactFormUrl: null,
    contactPageUrl: 'https://game.example/contact',
    pagesScanned: 2,
    method: 'html',
    error: null,
  });
  finishExtractionRun(database, run.id);

  assert.equal(
    listProspects(database, { query: 'hosted game' })[0].status,
    'contact_found',
  );
  assert.equal(
    listProspects(database, { query: 'hosted game' })[0].emailSearchStatus,
    'searched',
  );
  assert.equal(
    listProspects(database, { query: 'hosted game' })[0].contactPageUrl,
    'https://game.example/contact',
  );
  assert.equal(listPendingSiteCandidates(database).length, 0);
  assert.equal(
    listProspects(database, { emailSearchStatus: 'searched' }).length,
    1,
  );
  assert.deepEqual({ ...latestExtractionRun(database) }, {
    id: run.id,
    status: 'completed',
    requestedCount: 1,
    processedCount: 1,
    emailsFound: 1,
    formsFound: 0,
    errorCount: 0,
    startedAt: latestExtractionRun(database).startedAt,
    finishedAt: latestExtractionRun(database).finishedAt,
  });
  database.close();
});
