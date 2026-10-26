import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCandidatesFile, openDatabase } from '../src/database.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDatabasePath = resolve(packageDirectory, '../../data/outreach.sqlite');
const [sourceArgument, databaseArgument] = process.argv.slice(2);

if (!sourceArgument) {
  console.error(
    'Usage: npm run import:candidates -w apps/outreach -- <candidates.json> [outreach.sqlite]',
  );
  process.exitCode = 1;
} else {
  const sourcePath = resolve(sourceArgument);
  const databasePath = resolve(databaseArgument ?? defaultDatabasePath);
  mkdirSync(dirname(databasePath), { recursive: true });

  const database = openDatabase(databasePath);
  try {
    const result = importCandidatesFile(database, sourcePath);
    console.log(JSON.stringify({ databasePath, ...result }, null, 2));
  } finally {
    database.close();
  }
}
