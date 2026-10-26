import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latestExtractionRun,
  openDatabase,
  recoverInterruptedExtractions,
} from '../src/database.js';
import { startSiteExtraction, waitForActiveSiteExtraction } from '../src/site-analysis.js';

const requestedLimit = Number(process.argv[2]);
const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : null;
const databasePath = resolve(
  process.env.OUTREACH_DATABASE_PATH ??
    fileURLToPath(new URL('../../../data/outreach.sqlite', import.meta.url)),
);
const database = openDatabase(databasePath);

try {
  recoverInterruptedExtractions(database);
  const started = startSiteExtraction(database, { limit });
  if (!started.started) {
    console.log(JSON.stringify(started, null, 2));
  } else {
    await waitForActiveSiteExtraction();
    console.log(JSON.stringify(latestExtractionRun(database), null, 2));
  }
} finally {
  database.close();
}
