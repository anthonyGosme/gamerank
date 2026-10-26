import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const GAME_PLATFORM_HOSTS = ['itch.io', 'gamejolt.com', 'newgrounds.com', 'crazygames.com'];

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE,
    source_path TEXT NOT NULL,
    source_url TEXT,
    captured_at TEXT,
    imported_at TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    post_count INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prospects (
    reddit_id TEXT PRIMARY KEY,
    post_url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    game_title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    posted_at TEXT,
    flair TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    captured_at TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    email_search_status TEXT NOT NULL DEFAULT 'not_searched',
    message_status TEXT NOT NULL DEFAULT 'not_sent',
    message_sent_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_import_id INTEGER NOT NULL REFERENCES imports(id)
  );

  CREATE TABLE IF NOT EXISTS candidate_links (
    id INTEGER PRIMARY KEY,
    reddit_id TEXT NOT NULL REFERENCES prospects(reddit_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    host TEXT NOT NULL,
    kind TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    link_text TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'anchor',
    review_status TEXT NOT NULL DEFAULT 'new',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (reddit_id, url)
  );

  CREATE TABLE IF NOT EXISTS email_contacts (
    id INTEGER PRIMARY KEY,
    normalized_email TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    primary_reddit_id TEXT NOT NULL REFERENCES prospects(reddit_id) ON DELETE CASCADE,
    primary_source_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_occurrences (
    id INTEGER PRIMARY KEY,
    email_contact_id INTEGER NOT NULL REFERENCES email_contacts(id) ON DELETE CASCADE,
    reddit_id TEXT NOT NULL REFERENCES prospects(reddit_id) ON DELETE CASCADE,
    source_url TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
    duplicate_reason TEXT,
    discovered_at TEXT NOT NULL,
    UNIQUE (email_contact_id, reddit_id, source_url)
  );

  CREATE TABLE IF NOT EXISTS site_analyses (
    id INTEGER PRIMARY KEY,
    candidate_link_id INTEGER NOT NULL UNIQUE REFERENCES candidate_links(id) ON DELETE CASCADE,
    reddit_id TEXT NOT NULL REFERENCES prospects(reddit_id) ON DELETE CASCADE,
    site_url TEXT NOT NULL,
    status TEXT NOT NULL,
    extraction_method TEXT,
    pages_scanned INTEGER NOT NULL DEFAULT 0,
    contact_page_url TEXT,
    contact_form_url TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS extraction_runs (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    requested_count INTEGER NOT NULL,
    processed_count INTEGER NOT NULL DEFAULT 0,
    emails_found INTEGER NOT NULL DEFAULT 0,
    forms_found INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
  CREATE INDEX IF NOT EXISTS idx_candidate_links_reddit_id ON candidate_links(reddit_id);
  CREATE INDEX IF NOT EXISTS idx_candidate_links_host ON candidate_links(host);
  CREATE INDEX IF NOT EXISTS idx_email_occurrences_contact ON email_occurrences(email_contact_id);
  CREATE INDEX IF NOT EXISTS idx_email_occurrences_reddit ON email_occurrences(reddit_id);
  CREATE INDEX IF NOT EXISTS idx_site_analyses_reddit ON site_analyses(reddit_id);
  CREATE INDEX IF NOT EXISTS idx_extraction_runs_status ON extraction_runs(status);
`;

function validatePayload(payload) {
  if (!payload || payload.version !== 1 || !Array.isArray(payload.posts)) {
    throw new Error('Le fichier doit être un export Gamerank de version 1.');
  }
  for (const [index, post] of payload.posts.entries()) {
    if (!post?.redditId || !post?.postUrl || !Array.isArray(post.candidateLinks)) {
      throw new Error(`Publication invalide à l’index ${index}.`);
    }
  }
}

function candidateHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function inferredStatus(candidateLinks) {
  if (candidateLinks.some((link) => candidateKind(link) === 'website')) return 'site_found';
  if (candidateLinks.some((link) => ['game_platform', 'store'].includes(candidateKind(link)))) {
    return 'platform_only';
  }
  return 'needs_review';
}

function candidateKind(link) {
  const host = candidateHost(link.url);
  if (GAME_PLATFORM_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return 'game_platform';
  }
  return link.kind;
}

export function extractGameTitle(value) {
  const body = String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  const match = body.match(
    /(?:\*{1,2}|_{1,2})?\s*game\s*title\s*(?:\*{1,2}|_{1,2})?\s*:\s*(?:\*{1,2}|_{1,2})?\s*(.+?)(?=\s+(?:\*{0,2}|_{0,2})?(?:playable\s*link|platform|description|genre|status)\s*(?:\*{0,2}|_{0,2})?\s*:|$)/i,
  );
  return String(match?.[1] ?? '')
    .replace(/(?:\*{1,2}|_{1,2})+$/g, '')
    .trim()
    .slice(0, 200);
}

export function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
  database.exec(SCHEMA);
  const prospectColumns = database.prepare('PRAGMA table_info(prospects)').all();
  if (!prospectColumns.some((column) => column.name === 'game_title')) {
    database.exec(`ALTER TABLE prospects ADD COLUMN game_title TEXT NOT NULL DEFAULT ''`);
  }
  if (!prospectColumns.some((column) => column.name === 'email_search_status')) {
    database.exec(
      `ALTER TABLE prospects ADD COLUMN email_search_status TEXT NOT NULL DEFAULT 'not_searched'`,
    );
    database.exec(`
      UPDATE prospects
         SET email_search_status = 'searched'
       WHERE EXISTS (
         SELECT 1 FROM site_analyses analysis
          WHERE analysis.reddit_id = prospects.reddit_id
            AND analysis.status <> 'running'
       )
    `);
  }
  if (!prospectColumns.some((column) => column.name === 'message_status')) {
    database.exec(
      `ALTER TABLE prospects ADD COLUMN message_status TEXT NOT NULL DEFAULT 'not_sent'`,
    );
  }
  if (!prospectColumns.some((column) => column.name === 'message_sent_at')) {
    database.exec(`ALTER TABLE prospects ADD COLUMN message_sent_at TEXT`);
  }
  const analysisColumns = database.prepare('PRAGMA table_info(site_analyses)').all();
  if (!analysisColumns.some((column) => column.name === 'contact_page_url')) {
    database.exec(`ALTER TABLE site_analyses ADD COLUMN contact_page_url TEXT`);
  }
  database.exec(`
    UPDATE site_analyses
       SET contact_page_url = COALESCE(
         contact_form_url,
         (
           SELECT occurrence.source_url
             FROM email_occurrences occurrence
            WHERE occurrence.reddit_id = site_analyses.reddit_id
              AND occurrence.source_url <> site_analyses.site_url
            ORDER BY occurrence.id LIMIT 1
         )
       )
     WHERE contact_page_url IS NULL
  `);
  const updateGameTitle = database.prepare(
    `UPDATE prospects SET game_title = ? WHERE reddit_id = ?`,
  );
  for (const prospect of database
    .prepare(`SELECT reddit_id AS redditId, body FROM prospects WHERE game_title = ''`)
    .all()) {
    updateGameTitle.run(extractGameTitle(prospect.body), prospect.redditId);
  }
  const platformConditions = GAME_PLATFORM_HOSTS.flatMap(() => [
    'host = ?',
    'host LIKE ?',
  ]).join(' OR ');
  const platformParameters = GAME_PLATFORM_HOSTS.flatMap((host) => [host, `%.${host}`]);
  database
    .prepare(`UPDATE candidate_links SET kind = 'game_platform' WHERE ${platformConditions}`)
    .run(...platformParameters);
  database.exec(`
    UPDATE prospects
       SET status = 'platform_only'
     WHERE status <> 'email_sent'
       AND NOT EXISTS (
         SELECT 1 FROM candidate_links link
          WHERE link.reddit_id = prospects.reddit_id AND link.kind = 'website'
       )
       AND EXISTS (
         SELECT 1 FROM candidate_links link
          WHERE link.reddit_id = prospects.reddit_id
            AND link.kind IN ('game_platform', 'store')
       )
  `);
  return database;
}

export function importCandidates(database, payload, metadata) {
  validatePayload(payload);
  const now = new Date().toISOString();
  const existingImport = database
    .prepare('SELECT id FROM imports WHERE content_hash = ?')
    .get(metadata.contentHash);
  if (existingImport) {
    return {
      alreadyImported: true,
      importId: existingImport.id,
      posts: payload.posts.length,
    };
  }

  const insertImport = database.prepare(`
    INSERT INTO imports (
      content_hash, source_path, source_url, captured_at, imported_at, format_version, post_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertProspect = database.prepare(`
    INSERT INTO prospects (
      reddit_id, post_url, title, game_title, author, posted_at, flair, body, captured_at,
      status, first_seen_at, last_seen_at, last_import_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reddit_id) DO UPDATE SET
      post_url = excluded.post_url,
      title = excluded.title,
      game_title = CASE
        WHEN excluded.game_title <> '' THEN excluded.game_title
        ELSE prospects.game_title
      END,
      author = excluded.author,
      posted_at = excluded.posted_at,
      flair = excluded.flair,
      body = excluded.body,
      captured_at = excluded.captured_at,
      status = CASE
        WHEN prospects.status IN ('new', 'needs_review', 'site_found', 'platform_only')
          THEN excluded.status
        ELSE prospects.status
      END,
      last_seen_at = excluded.last_seen_at,
      last_import_id = excluded.last_import_id
  `);
  const upsertCandidate = database.prepare(`
    INSERT INTO candidate_links (
      reddit_id, url, host, kind, score, link_text, source,
      review_status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
    ON CONFLICT(reddit_id, url) DO UPDATE SET
      host = excluded.host,
      kind = excluded.kind,
      score = excluded.score,
      link_text = excluded.link_text,
      source = excluded.source,
      last_seen_at = excluded.last_seen_at
  `);

  database.exec('BEGIN IMMEDIATE');
  try {
    const importResult = insertImport.run(
      metadata.contentHash,
      metadata.sourcePath,
      payload.source ?? null,
      payload.capturedAt ?? null,
      now,
      payload.version,
      payload.posts.length,
    );
    const importId = Number(importResult.lastInsertRowid);

    for (const post of payload.posts) {
      upsertProspect.run(
        post.redditId,
        post.postUrl,
        post.title ?? '',
        post.gameTitle ?? extractGameTitle(post.body),
        post.author ?? '',
        post.postedAt ?? null,
        post.flair ?? '',
        post.body ?? '',
        post.capturedAt ?? payload.capturedAt ?? null,
        inferredStatus(post.candidateLinks),
        now,
        now,
        importId,
      );
      for (const link of post.candidateLinks) {
        const host = candidateHost(link.url);
        if (!host) continue;
        upsertCandidate.run(
          post.redditId,
          link.url,
          host,
          candidateKind(link) ?? 'unknown',
          Number.isFinite(link.score) ? link.score : 0,
          link.text ?? '',
          link.source ?? 'anchor',
          now,
          now,
        );
      }
    }

    database.exec('COMMIT');
    return {
      alreadyImported: false,
      importId,
      posts: payload.posts.length,
      statuses: Object.fromEntries(
        database
          .prepare('SELECT status, COUNT(*) AS count FROM prospects GROUP BY status ORDER BY status')
          .all()
          .map((row) => [row.status, row.count]),
      ),
      candidateLinks: database.prepare('SELECT COUNT(*) AS count FROM candidate_links').get().count,
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function importCandidatesFile(database, sourcePath) {
  const content = readFileSync(sourcePath);
  const payload = JSON.parse(content.toString('utf8'));
  return importCandidates(database, payload, {
    contentHash: createHash('sha256').update(content).digest('hex'),
    sourcePath,
  });
}

export function purgeOutreachData(database) {
  const deleted = {
    imports: database.prepare('SELECT COUNT(*) AS count FROM imports').get().count,
    prospects: database.prepare('SELECT COUNT(*) AS count FROM prospects').get().count,
    candidateLinks: database.prepare('SELECT COUNT(*) AS count FROM candidate_links').get().count,
    analyses: database.prepare('SELECT COUNT(*) AS count FROM site_analyses').get().count,
    emails: database.prepare('SELECT COUNT(*) AS count FROM email_contacts').get().count,
    runs: database.prepare('SELECT COUNT(*) AS count FROM extraction_runs').get().count,
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      DELETE FROM extraction_runs;
      DELETE FROM prospects;
      DELETE FROM imports;
    `);
    database.exec('COMMIT');
    return deleted;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function setProspectMessageSent(database, redditId, sent) {
  const result = database
    .prepare(`
      UPDATE prospects
         SET message_status = ?,
             message_sent_at = ?,
             last_seen_at = ?
       WHERE reddit_id = ?
    `)
    .run(
      sent ? 'sent' : 'not_sent',
      sent ? new Date().toISOString() : null,
      new Date().toISOString(),
      redditId,
    );
  if (!result.changes) throw new Error('Prospect introuvable.');
  return database
    .prepare(`
      SELECT message_status AS messageStatus, message_sent_at AS messageSentAt
        FROM prospects WHERE reddit_id = ?
    `)
    .get(redditId);
}

export function registerEmailOccurrence(database, occurrence) {
  const normalizedEmail = String(occurrence.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('Adresse e-mail invalide.');
  }
  const sourceUrl = String(occurrence.sourceUrl ?? '');
  const now = new Date().toISOString();
  const existingContact = database
    .prepare('SELECT id FROM email_contacts WHERE normalized_email = ?')
    .get(normalizedEmail);
  let contactId = existingContact?.id;
  const isPrimary = !existingContact;

  database.exec('BEGIN IMMEDIATE');
  try {
    if (!contactId) {
      const inserted = database
        .prepare(`
          INSERT INTO email_contacts (
            normalized_email, email, primary_reddit_id, primary_source_url, created_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          normalizedEmail,
          String(occurrence.email).trim(),
          occurrence.redditId,
          sourceUrl,
          now,
          now,
        );
      contactId = Number(inserted.lastInsertRowid);
    } else {
      database
        .prepare('UPDATE email_contacts SET last_seen_at = ? WHERE id = ?')
        .run(now, contactId);
    }

    const alreadyRecorded = database
      .prepare(`
        SELECT id, is_primary AS isPrimary
          FROM email_occurrences
         WHERE email_contact_id = ? AND reddit_id = ? AND source_url = ?
      `)
      .get(contactId, occurrence.redditId, sourceUrl);
    if (!alreadyRecorded) {
      database
        .prepare(`
          INSERT INTO email_occurrences (
            email_contact_id, reddit_id, source_url, is_primary, duplicate_reason, discovered_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          contactId,
          occurrence.redditId,
          sourceUrl,
          isPrimary ? 1 : 0,
          isPrimary ? null : 'email_already_retained',
          now,
        );
    }
    database.exec('COMMIT');
    return {
      contactId,
      duplicate: alreadyRecorded ? !alreadyRecorded.isPrimary : !isPrimary,
      alreadyRecorded: Boolean(alreadyRecorded),
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function dashboardSummary(database) {
  const statuses = Object.fromEntries(
    database
      .prepare('SELECT status, COUNT(*) AS count FROM prospects GROUP BY status ORDER BY status')
      .all()
      .map((row) => [row.status, row.count]),
  );
  return {
    prospects: database.prepare('SELECT COUNT(*) AS count FROM prospects').get().count,
    candidateLinks: database.prepare('SELECT COUNT(*) AS count FROM candidate_links').get().count,
    emails: database.prepare('SELECT COUNT(*) AS count FROM email_contacts').get().count,
    duplicateEmails: database
      .prepare('SELECT COUNT(*) AS count FROM email_occurrences WHERE is_primary = 0')
      .get().count,
    pendingSites: database
      .prepare(`
        SELECT COUNT(DISTINCT link.reddit_id) AS count
          FROM candidate_links link
          JOIN prospects prospect ON prospect.reddit_id = link.reddit_id
         WHERE link.kind = 'website' AND link.review_status = 'new'
           AND prospect.status = 'site_found'
           AND prospect.email_search_status = 'not_searched'
      `)
      .get().count,
    statuses,
  };
}

export function listProspects(database, options = {}) {
  const status = String(options.status ?? '').trim();
  const emailSearchStatus = String(options.emailSearchStatus ?? '').trim();
  const query = String(options.query ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const conditions = [];
  const parameters = [];
  if (status) {
    conditions.push('p.status = ?');
    parameters.push(status);
  }
  if (emailSearchStatus) {
    conditions.push('p.email_search_status = ?');
    parameters.push(emailSearchStatus);
  }
  if (query) {
    conditions.push(
      `(lower(p.game_title) LIKE ? OR lower(p.title) LIKE ? OR lower(p.author) LIKE ?
        OR lower(p.reddit_id) LIKE ?
        OR EXISTS (
          SELECT 1 FROM candidate_links search_link
           WHERE search_link.reddit_id = p.reddit_id AND lower(search_link.host) LIKE ?
        ))`,
    );
    const pattern = `%${query}%`;
    parameters.push(pattern, pattern, pattern, pattern, pattern);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return database
    .prepare(`
      SELECT p.reddit_id AS redditId, p.post_url AS postUrl, p.title,
             p.game_title AS gameTitle, p.author,
             p.posted_at AS postedAt, p.first_seen_at AS importedAt, p.status,
             p.email_search_status AS emailSearchStatus,
             p.message_status AS messageStatus, p.message_sent_at AS messageSentAt,
             (
               SELECT link.url FROM candidate_links link
                WHERE link.reddit_id = p.reddit_id
                ORDER BY link.score DESC, link.id ASC LIMIT 1
             ) AS candidateUrl,
             (
               SELECT link.host FROM candidate_links link
                WHERE link.reddit_id = p.reddit_id
                ORDER BY link.score DESC, link.id ASC LIMIT 1
             ) AS candidateHost,
             (
               SELECT COUNT(*) FROM candidate_links link WHERE link.reddit_id = p.reddit_id
             ) AS candidateCount,
             (
               SELECT COUNT(*) FROM email_occurrences occurrence
                WHERE occurrence.reddit_id = p.reddit_id
                  AND occurrence.is_primary = 1
             ) AS emailCount,
             (
               SELECT group_concat(contact.email, ', ')
                FROM email_occurrences occurrence
                 JOIN email_contacts contact ON contact.id = occurrence.email_contact_id
                WHERE occurrence.reddit_id = p.reddit_id
                  AND occurrence.is_primary = 1
             ) AS emailPreview,
             (
               SELECT contact.email
                 FROM email_occurrences occurrence
                 JOIN email_contacts contact ON contact.id = occurrence.email_contact_id
                WHERE occurrence.reddit_id = p.reddit_id
                  AND occurrence.is_primary = 1
                ORDER BY occurrence.is_primary DESC, occurrence.id ASC LIMIT 1
             ) AS emailAddress,
             (
               SELECT COALESCE(analysis.contact_page_url, analysis.contact_form_url)
                 FROM site_analyses analysis
                WHERE analysis.reddit_id = p.reddit_id
                ORDER BY analysis.id DESC LIMIT 1
             ) AS contactPageUrl
        FROM prospects p
        ${where}
       ORDER BY p.posted_at DESC, p.reddit_id
       LIMIT ?
    `)
    .all(...parameters, limit);
}

export function getProspectForEmail(database, redditId) {
  return database
    .prepare(`
      SELECT p.reddit_id AS redditId, p.game_title AS gameTitle,
             p.message_status AS messageStatus,
             (
               SELECT contact.email
                 FROM email_occurrences occurrence
                 JOIN email_contacts contact ON contact.id = occurrence.email_contact_id
                WHERE occurrence.reddit_id = p.reddit_id
                  AND occurrence.is_primary = 1
                ORDER BY occurrence.id ASC LIMIT 1
             ) AS emailAddress,
             (
               SELECT link.url FROM candidate_links link
                WHERE link.reddit_id = p.reddit_id
                ORDER BY link.score DESC, link.id ASC LIMIT 1
             ) AS candidateUrl
        FROM prospects p
       WHERE p.reddit_id = ?
    `)
    .get(String(redditId));
}

export function listImports(database) {
  return database
    .prepare(`
      SELECT id, source_path AS sourcePath, source_url AS sourceUrl,
             captured_at AS capturedAt, imported_at AS importedAt, post_count AS postCount
        FROM imports ORDER BY imported_at DESC LIMIT 20
    `)
    .all();
}

export function listDuplicateEmails(database) {
  return database
    .prepare(`
      SELECT contact.email, contact.primary_reddit_id AS retainedFor,
             occurrence.reddit_id AS duplicateFor,
             occurrence.source_url AS sourceUrl,
             occurrence.duplicate_reason AS reason,
             occurrence.discovered_at AS discoveredAt
        FROM email_occurrences occurrence
        JOIN email_contacts contact ON contact.id = occurrence.email_contact_id
       WHERE occurrence.is_primary = 0
       ORDER BY occurrence.discovered_at DESC
       LIMIT 500
    `)
    .all();
}

export function listPendingSiteCandidates(database, limit = null) {
  const safeLimit = limit == null ? null : Math.max(Number(limit) || 1, 1);
  const limitClause = safeLimit == null ? '' : 'LIMIT ?';
  const statement = database.prepare(`
      SELECT link.id AS candidateLinkId, link.reddit_id AS redditId,
             link.url, link.host, prospect.title
        FROM candidate_links link
        JOIN prospects prospect ON prospect.reddit_id = link.reddit_id
       WHERE link.kind = 'website'
         AND link.review_status = 'new'
         AND prospect.status = 'site_found'
         AND prospect.email_search_status = 'not_searched'
         AND link.id = (
           SELECT best.id FROM candidate_links best
            WHERE best.reddit_id = link.reddit_id AND best.kind = 'website'
              AND best.review_status = 'new'
            ORDER BY best.score DESC, best.id ASC LIMIT 1
         )
       ORDER BY prospect.posted_at DESC, link.id
       ${limitClause}
    `);
  return safeLimit == null ? statement.all() : statement.all(safeLimit);
}

export function createExtractionRun(database, requestedCount) {
  const active = database
    .prepare(`SELECT id FROM extraction_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`)
    .get();
  if (active) return { id: active.id, alreadyRunning: true };
  const result = database
    .prepare(`
      INSERT INTO extraction_runs (status, requested_count, started_at)
      VALUES ('running', ?, ?)
    `)
    .run(requestedCount, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), alreadyRunning: false };
}

export function markSiteAnalysisStarted(database, runId, candidate) {
  const now = new Date().toISOString();
  database
    .prepare(`UPDATE candidate_links SET review_status = 'analyzing' WHERE id = ?`)
    .run(candidate.candidateLinkId);
  database
    .prepare(`UPDATE prospects SET email_search_status = 'searching' WHERE reddit_id = ?`)
    .run(candidate.redditId);
  database
    .prepare(`
      INSERT INTO site_analyses (
        candidate_link_id, reddit_id, site_url, status, started_at
      ) VALUES (?, ?, ?, 'running', ?)
      ON CONFLICT(candidate_link_id) DO UPDATE SET
        status = 'running', error = NULL, started_at = excluded.started_at, finished_at = NULL
    `)
    .run(candidate.candidateLinkId, candidate.redditId, candidate.url, now);
  return runId;
}

export function markSiteAnalysisFinished(database, runId, candidate, result) {
  const now = new Date().toISOString();
  const status = result.error
    ? 'extraction_failed'
    : result.emails.length
      ? 'contact_found'
      : result.contactFormUrl
        ? 'contact_form_only'
        : 'no_public_contact';

  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(`
        UPDATE site_analyses SET
          status = ?, extraction_method = ?, pages_scanned = ?,
          contact_page_url = ?, contact_form_url = ?, error = ?, finished_at = ?
        WHERE candidate_link_id = ?
      `)
      .run(
        status,
        result.method ?? null,
        result.pagesScanned ?? 0,
        result.contactPageUrl ?? null,
        result.contactFormUrl ?? null,
        result.error ?? null,
        now,
        candidate.candidateLinkId,
      );
    database
      .prepare(`UPDATE candidate_links SET review_status = ? WHERE id = ?`)
      .run(result.error ? 'failed' : 'analyzed', candidate.candidateLinkId);
    database
      .prepare(`
        UPDATE prospects
           SET status = ?, email_search_status = 'searched', last_seen_at = ?
         WHERE reddit_id = ?
      `)
      .run(status, now, candidate.redditId);
    database
      .prepare(`
        UPDATE extraction_runs SET
          processed_count = processed_count + 1,
          emails_found = emails_found + ?,
          forms_found = forms_found + ?,
          error_count = error_count + ?
        WHERE id = ?
      `)
      .run(
        result.emails.length,
        result.contactFormUrl ? 1 : 0,
        result.error ? 1 : 0,
        runId,
      );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return status;
}

export function finishExtractionRun(database, runId, status = 'completed') {
  database
    .prepare(`UPDATE extraction_runs SET status = ?, finished_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), runId);
}

export function latestExtractionRun(database) {
  return (
    database
      .prepare(`
        SELECT id, status, requested_count AS requestedCount,
               processed_count AS processedCount, emails_found AS emailsFound,
               forms_found AS formsFound, error_count AS errorCount,
               started_at AS startedAt, finished_at AS finishedAt
          FROM extraction_runs ORDER BY id DESC LIMIT 1
      `)
      .get() ?? null
  );
}

export function recoverInterruptedExtractions(database) {
  const now = new Date().toISOString();
  database
    .prepare(`
      UPDATE extraction_runs SET status = 'interrupted', finished_at = ?
       WHERE status = 'running'
    `)
    .run(now);
  database
    .prepare(`
      UPDATE candidate_links SET review_status = 'new' WHERE review_status = 'analyzing'
    `)
    .run();
  database
    .prepare(`
      UPDATE prospects SET email_search_status = 'not_searched'
       WHERE email_search_status = 'searching'
    `)
    .run();
  database
    .prepare(`
      UPDATE site_analyses
         SET status = 'interrupted', error = 'Extraction interrompue', finished_at = ?
       WHERE status = 'running'
    `)
    .run(now);
}
