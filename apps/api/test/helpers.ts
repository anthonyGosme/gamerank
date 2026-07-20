import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';
import { clickhouse } from '../src/clickhouse.js';

// Développeurs et jeux créés par CE fichier de test (un processus par
// fichier), pour un nettoyage ciblé qui ne touche pas les données des autres.
const createdDevelopers: string[] = [];
const createdGames: string[] = [];

export async function createDeveloper(
  email = `test-${randomUUID()}@test.local`,
): Promise<{ id: string; email: string }> {
  const { rows } = await pool.query(
    'INSERT INTO developers (email) VALUES ($1) RETURNING id, email',
    [email],
  );
  createdDevelopers.push(rows[0].id);
  return rows[0];
}

// À appeler dans after() : supprime en cascade jeux, votes et scores de
// test (PostgreSQL) ET leurs agrégats ClickHouse — sinon les lignes
// fantômes des runs précédents polluent le partage inter-jeux (§4.1).
export async function cleanupCreated(): Promise<void> {
  if (createdGames.length > 0) {
    const ids = createdGames.map((id) => `'${id}'`).join(',');
    for (const table of ['events', 'daily_activity', 'daily_sessions']) {
      await clickhouse
        .command({ query: `DELETE FROM ${table} WHERE game_id IN (${ids})` })
        .catch(() => {});
    }
    createdGames.length = 0;
  }
  if (createdDevelopers.length === 0) return;
  await pool.query('DELETE FROM developers WHERE id = ANY($1::uuid[])', [createdDevelopers]);
  createdDevelopers.length = 0;
}

export async function createGame(
  developerId: string,
): Promise<{ id: string; sdkKey: string; domain: string }> {
  const slug = randomUUID().slice(0, 8);
  const domain = `${slug}.test.local`;
  const { rows } = await pool.query(
    `INSERT INTO games (developer_id, name, url, domain, description, thumbnail_url, sdk_key)
     VALUES ($1, $2, $3, $4, 'test game', '', $5)
     RETURNING id, sdk_key AS "sdkKey", domain`,
    [developerId, `Test ${slug}`, `https://${domain}/`, domain, `gr_test_${randomBytes(12).toString('base64url')}`],
  );
  createdGames.push(rows[0].id);
  return rows[0];
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

// Affiche un tableau aligné dans la sortie des tests, pour que les
// scénarios soient lisibles et pas seulement « ✔ ».
export function printTable(title: string, headers: string[], rows: string[][]): void {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    '  ' + cells.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ');
  console.log(`\n${title}`);
  console.log(line(headers));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

// Corps multipart minimal pour POST /api/games via app.inject().
export function multipartGame(fields: Record<string, string>): {
  payload: string;
  headers: { 'content-type': string };
} {
  const boundary = 'testboundary'.padEnd(24, 'x');
  let payload = '';
  for (const [name, value] of Object.entries(fields)) {
    payload += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  payload +=
    `--${boundary}\r\nContent-Disposition: form-data; name="thumbnail"; filename="t.png"\r\n` +
    `Content-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`;
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
