import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';

export async function createDeveloper(
  email = `test-${randomUUID()}@test.local`,
): Promise<{ id: string; email: string }> {
  const { rows } = await pool.query(
    'INSERT INTO developers (email) VALUES ($1) RETURNING id, email',
    [email],
  );
  return rows[0];
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
  return rows[0];
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
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
