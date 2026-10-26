import {
  createExtractionRun,
  finishExtractionRun,
  listPendingSiteCandidates,
  markSiteAnalysisFinished,
  markSiteAnalysisStarted,
  registerEmailOccurrence,
} from './database.js';
import { crawlContactSite, createPlaywrightRenderer } from './contact-extractor.js';

let activeExtraction = null;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function startSiteExtraction(database, options = {}) {
  if (activeExtraction) return activeExtraction.summary;
  const candidates = listPendingSiteCandidates(database, options.limit ?? null);
  if (!candidates.length) return { started: false, reason: 'no_pending_site' };

  const run = createExtractionRun(database, candidates.length);
  if (run.alreadyRunning) {
    return { started: false, reason: 'already_running', runId: run.id };
  }

  const summary = { started: true, runId: run.id, requestedCount: candidates.length };
  const promise = runExtraction(database, run.id, candidates, options)
    .catch((error) => {
      console.error('Extraction de contacts interrompue :', error);
    })
    .finally(() => {
      if (activeExtraction?.summary.runId === run.id) activeExtraction = null;
    });
  activeExtraction = { summary, promise };
  return summary;
}

async function runExtraction(database, runId, candidates, options) {
  let renderer = null;
  try {
    try {
      renderer = await createPlaywrightRenderer();
    } catch {
      // L'extraction HTML reste fonctionnelle si Chrome est indisponible.
    }

    for (const candidate of candidates) {
      markSiteAnalysisStarted(database, runId, candidate);
      const result = await crawlContactSite(candidate.url, {
        renderPage: renderer ? (url) => renderer.render(url) : null,
        maximumContactPages: 4,
        delayMs: 250,
      });
      for (const contact of result.emails) {
        registerEmailOccurrence(database, {
          redditId: candidate.redditId,
          email: contact.email,
          sourceUrl: contact.sourceUrl,
        });
      }
      markSiteAnalysisFinished(database, runId, candidate, result);
      if (options.betweenSitesMs !== 0) await wait(options.betweenSitesMs ?? 750);
    }
    finishExtractionRun(database, runId, 'completed');
  } catch (error) {
    finishExtractionRun(database, runId, 'failed');
    throw error;
  } finally {
    await renderer?.close().catch(() => {});
  }
}

export function activeSiteExtraction() {
  return activeExtraction?.summary ?? null;
}

export async function waitForActiveSiteExtraction() {
  await activeExtraction?.promise;
}
