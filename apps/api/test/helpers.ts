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
