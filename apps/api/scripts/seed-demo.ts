// Injecteur des jeux de démo : enregistre les 10 mini-jeux pour un
// développeur, génère une vignette par jeu, injecte une activité et des
// votes réalistes, et écrit apps/demo-game/games.json pour le serveur local.
//
//   npm run seed:demo            (depuis la racine du repo)
//
// Idempotent : la clé SDK et l'URL sont déterministes par jeu, donc rejouer
// le script met à jour au lieu de dupliquer.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../src/db.js';
import { clickhouse, ensureClickhouseSchema } from '../src/clickhouse.js';
import { runPipeline } from '../src/scoring/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(here, '../../demo-game');
const uploadsDir = path.resolve(here, '../uploads');
const DAY_MS = 86_400_000;

interface SeedGame {
  slug: string;
  title: string;
  emoji: string;
  category: string;
  color: string;
  short: string;
  description: string;
  visitors: number;
  retentionPct: number;
  avgSessionSec: number;
  votesUp: number;
  votesDown: number;
}

// IP déterministe (pas de Math.random) pour un seed reproductible.
function ip(seed: number): string {
  return `77.${seed % 240}.${(seed * 7) % 240}.${((seed * 13) % 240) + 1}`;
}

// Vignette 16/9 générée : la couleur du jeu, une lueur claire en diagonale,
// et un gros emoji centré (le titre est déjà affiché par la carte).
function thumbnailSvg(game: SeedGame): string {
  const gid = `g-${game.slug}`; // id unique par vignette (évite les collisions)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <defs><radialGradient id="${gid}" cx="0.3" cy="0.25" r="0.9">
    <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.25"/>
  </radialGradient></defs>
  <rect width="320" height="180" fill="${game.color}"/>
  <rect width="320" height="180" fill="url(#${gid})"/>
  <text x="160" y="118" text-anchor="middle" font-size="86">${game.emoji}</text>
</svg>`;
}

async function upsertDeveloper(email: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO developers (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [email],
  );
  return rows[0].id;
}

// Aucune donnée factice (visites ET votes) n'est injectée par défaut : les
// scores doivent naître de vraies parties et de vrais votes via le SDK.
// SEED_SAMPLE=1 réinjecte des données d'exemple pour une démo bien remplie.
const SEED_SAMPLE = process.env.SEED_SAMPLE === '1';

async function seedActivity(gameId: string, game: SeedGame): Promise<void> {
  // Toujours nettoyer les fausses données d'un run précédent, puis n'en
  // réinjecter que si explicitement demandé.
  await clickhouse.command({ query: `DELETE FROM daily_activity WHERE game_id = '${gameId}'` });
  await clickhouse.command({
    query: `DELETE FROM events WHERE game_id = '${gameId}' AND visitor_id LIKE 'dv-%'`,
  });
  if (!SEED_SAMPLE) return;
  const today = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  const returning = Math.round((game.visitors * game.retentionPct) / 100);
  for (let i = 0; i < game.visitors; i++) {
    // Premier jour entre 7 et 21 jours (dans la fenêtre de cohorte fidélité).
    const firstAge = 7 + (i % 15);
    const visitorId = `dv-${game.slug}-${i}`;
    const jitter = 0.7 + ((i % 7) / 10);
    const activeMs = Math.round(game.avgSessionSec * 1000 * jitter);
    const push = (age: number) =>
      rows.push({
        game_id: gameId,
        visitor_id: visitorId,
        day: new Date(today - age * DAY_MS).toISOString().slice(0, 10),
        active_ms: activeMs,
        sessions: 1,
        loads: 1 + (i % 3),
        ip: ip(i),
        ver: 1,
      });
    push(firstAge);
    if (i < returning) push(Math.max(0, firstAge - 1 - (i % 5))); // journée de retour
  }
  for (let i = 0; i < rows.length; i += 2000) {
    await clickhouse.insert({ table: 'daily_activity', values: rows.slice(i, i + 2000), format: 'JSONEachRow' });
  }
}

async function seedVotes(gameId: string, game: SeedGame): Promise<void> {
  // Nettoie toujours les votes de démo ; ne les réinjecte que sur SEED_SAMPLE.
  await pool.query(`DELETE FROM votes WHERE game_id = $1 AND visitor_id LIKE 'dvote-%'`, [gameId]);
  if (!SEED_SAMPLE) return;
  const total = game.votesUp + game.votesDown;
  const values: string[] = [];
  const params: unknown[] = [gameId];
  for (let i = 0; i < total; i++) {
    const value = i < game.votesUp ? 1 : -1;
    params.push(`dvote-${game.slug}-${i}`, value, ip(i + 1000));
    const base = params.length;
    values.push(`($1, $${base - 2}, $${base - 1}, $${base})`);
  }
  if (values.length > 0) {
    await pool.query(
      `INSERT INTO votes (game_id, visitor_id, value, ip) VALUES ${values.join(',')}
       ON CONFLICT (game_id, visitor_id) DO UPDATE SET value = EXCLUDED.value`,
      params,
    );
  }
}

async function main(): Promise<void> {
  await ensureClickhouseSchema();
  await mkdir(uploadsDir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(demoDir, 'seed.json'), 'utf8')) as {
    developerEmail: string;
    baseUrl: string;
    games: SeedGame[];
  };

  const developerId = await upsertDeveloper(manifest.developerEmail);
  const gamesConfig: Record<string, { key: string; gameId: string }> = {};

  // Répartition des statuts pour une démo réaliste (épic 3) : la première
  // moitié « ranked » (peuplent le classement), le reste « awaiting_jury »
  // (le pool que les nouveaux inscrits jugeront).
  const rankedCount = Math.ceil(manifest.games.length / 2);

  for (const [index, game] of manifest.games.entries()) {
    const status = index < rankedCount ? 'ranked' : 'awaiting_jury';
    const url = `${manifest.baseUrl}/${game.slug}`;
    const sdkKey = `gr_demo_${game.slug}`;
    const thumbName = `demo-${game.slug}.svg`;
    await writeFile(path.join(uploadsDir, thumbName), thumbnailSvg(game));

    const { rows } = await pool.query(
      `INSERT INTO games (developer_id, name, url, domain, description, short_description,
              category, thumbnail_url, sdk_key, is_local, badge_color,
              integration_verified_at, status)
       VALUES ($1, $2, $3, 'localhost', $4, $5, $6, $7, $8, true, $9, now(), $10)
       ON CONFLICT (url) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         short_description = EXCLUDED.short_description, category = EXCLUDED.category,
         thumbnail_url = EXCLUDED.thumbnail_url, badge_color = EXCLUDED.badge_color,
         integration_verified_at = now(), status = EXCLUDED.status
       RETURNING id`,
      [
        // badge_color reste sombre (visible sur toute page) ; la couleur de
        // page du jeu (game.color) sert au fond du jeu, pas au badge.
        developerId, game.title, url, game.description, game.short, game.category,
        `/uploads/${thumbName}`, sdkKey, '#1d1039', status,
      ],
    );
    const gameId: string = rows[0].id;

    await seedActivity(gameId, game);
    await seedVotes(gameId, game);
    gamesConfig[game.slug] = { key: sdkKey, gameId };
    console.log(
      `  ✓ ${game.title.padEnd(18)} ${game.visitors} visitors · ${game.votesUp}+/${game.votesDown}- votes`,
    );
  }

  await writeFile(path.join(demoDir, 'games.json'), `${JSON.stringify(gamesConfig, null, 2)}\n`);
  console.log('\nComputing scores…');
  const summary = await runPipeline();
  console.log(`Pipeline done in ${summary?.durationMs}ms (${summary?.gamesCount} games).`);
  console.log(`Seeded ${manifest.games.length} games for ${manifest.developerEmail}.`);

  await clickhouse.close();
  await pool.end();
}

await main();
