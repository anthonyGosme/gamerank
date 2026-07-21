// Site public (épic 5) : home, listes, catégories, fiches, /go,
// méthodologie, sitemap. Rendu serveur pur (SEO).
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { config } from './config.js';
import { CATEGORIES, categoryLabel, isCategory } from './categories.js';
import { CATEGORY_EMOJI, escapeHtml, shell } from './layout.js';

const PAGE_SIZE = 30;
const NEW_GAME_DAYS = 31;

const PUBLIC_GAME = `g.id, g.name, g.short_description AS "shortDescription",
  g.description, g.category, g.thumbnail_url AS "thumbnailUrl", g.url, g.status,
  g.current_score AS "currentScore", g.current_rank AS "currentRank",
  g.created_at AS "createdAt"`;

interface PublicGame {
  id: string;
  name: string;
  shortDescription: string;
  description: string;
  category: string;
  thumbnailUrl: string;
  url: string;
  status: string;
  currentScore: number | null;
  currentRank: number | null;
  createdAt: string;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'game'
  );
}

function gamePath(game: PublicGame): string {
  return `/g/${game.id}/${slugify(game.name)}`;
}

// `compact` = pas de texte sous la carte (utilisé pour les classements Top).
function card(game: PublicGame, options?: { rank?: number; compact?: boolean }): string {
  const score =
    game.currentScore != null
      ? `<span class="scoreBadge">${Math.round(game.currentScore)}</span>`
      : '<span class="scoreBadge new">NEW</span>';
  // Sans vignette : l'emoji de catégorie remplit la case plutôt qu'un vide.
  const thumb = game.thumbnailUrl
    ? `<img src="${escapeHtml(game.thumbnailUrl)}" alt="${escapeHtml(game.name)}" loading="lazy">`
    : `<div class="thumbFallback">${CATEGORY_EMOJI[game.category] ?? '🎮'}</div>`;
  const rank = options?.rank ? `<span class="rankBadge">#${options.rank}</span>` : '';
  const body = options?.compact
    ? `<div class="cardBody"><strong>${escapeHtml(game.name)}</strong></div>`
    : `<div class="cardBody">
        <strong>${escapeHtml(game.name)}</strong>
        <p>${escapeHtml(game.shortDescription)}</p>
        <span class="cat">${CATEGORY_EMOJI[game.category] ?? '🎮'} ${escapeHtml(categoryLabel(game.category))}</span>
      </div>`;
  return `<a class="card" href="${gamePath(game)}">
    <div class="thumbWrap">${thumb}${rank}${score}</div>
    ${body}
  </a>`;
}

// Un jeu dont l'intégration n'est pas vérifiée n'est listé nulle part
// (ni classements, ni catégories, ni sitemap) : sans snippet installé, il
// n'est pas mesurable, et le laisser visible ouvrirait la porte au spam.
const LISTABLE = `g.status NOT IN ('hidden', 'awaiting_snippet')`;

async function query(where: string, order: string, limit: number, offset = 0, params: unknown[] = []) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_GAME} FROM games g
      WHERE ${LISTABLE} ${where}
      ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return rows as PublicGame[];
}

async function count(where: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM games g WHERE ${LISTABLE} ${where}`,
    params,
  );
  return rows[0].n;
}

const LISTS = {
  top: {
    where: 'AND g.current_score IS NOT NULL',
    order: 'g.current_rank ASC',
    label: 'Top 50',
    heading: 'Top games',
    ranked: true,
    compact: true,
    description: 'The highest-rated web games, ranked by real measured play time.',
  },
  new: {
    where: `AND g.current_score IS NOT NULL AND g.created_at > now() - interval '${NEW_GAME_DAYS} days'`,
    order: 'g.current_score DESC',
    label: 'Top new games',
    heading: 'Top new games',
    ranked: true,
    compact: false,
    description: 'The best web games released recently, ranked by how much people actually play them.',
  },
  latest: {
    where: '',
    order: 'g.created_at DESC',
    label: 'Latest arrivals',
    heading: 'Latest arrivals',
    ranked: false,
    compact: false,
    description: 'The newest web games submitted to WebGameRank.',
  },
} as const;

type ListKey = keyof typeof LISTS;

function pager(base: string, page: number, totalPages: number): string {
  if (totalPages <= 1) return '';
  return `<div class="pager">
    ${page > 1 ? `<a href="${base}page=${page - 1}">← Previous</a>` : ''}
    <span class="muted">Page ${page} of ${totalPages}</span>
    ${page < totalPages ? `<a href="${base}page=${page + 1}">Next →</a>` : ''}
  </div>`;
}

export function registerPublicRoutes(app: FastifyInstance): void {
  app.get('/', async (_request, reply) => {
    const [top, topNew, latest] = await Promise.all([
      query(LISTS.top.where, LISTS.top.order, 24),
      query(LISTS.new.where, LISTS.new.order, 12),
      query(LISTS.latest.where, LISTS.latest.order, 12),
    ]);
    const section = (key: ListKey, games: PublicGame[]) =>
      games.length === 0
        ? ''
        : `<h2><a class="title" href="/${key}">${LISTS[key].heading}</a>
             <a class="more" href="/${key}">See all →</a></h2>
           <div class="grid">${games
             .map((game, index) =>
               // Sur la home, toutes les cartes sont compactes (visuel homogène) ;
               // les descriptions/catégories restent sur les pages dédiées.
               card(game, { rank: LISTS[key].ranked ? index + 1 : undefined, compact: true }),
             )
             .join('')}</div>`;

    const body = `
      <h1>Web games, ranked by how long people actually play</h1>
      <p class="lead">No installs, no hype — just the games that keep players coming back.</p>
      ${section('top', top)}
      ${section('new', topNew)}
      ${section('latest', latest)}
      ${top.length + latest.length === 0 ? '<p>No games yet — <a href="/games/new">be the first to submit yours</a>.</p>' : ''}`;
    return reply.type('text/html').send(
      shell({
        title: 'WebGameRank — web games ranked by real play time',
        description:
          'Discover the best web games, ranked by measured play time, player retention and verified votes.',
        path: '/',
        body,
      }),
    );
  });

  // Pages de liste dédiées : /top, /new, /latest (paginées).
  for (const key of Object.keys(LISTS) as ListKey[]) {
    app.get(`/${key}`, async (request, reply) => {
      const definition = LISTS[key];
      const { page = '1' } = request.query as { page?: string };
      const pageNumber = Math.max(1, parseInt(page, 10) || 1);
      const [games, total] = await Promise.all([
        query(definition.where, definition.order, PAGE_SIZE, (pageNumber - 1) * PAGE_SIZE),
        count(definition.where),
      ]);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const body = `
        <h1>${definition.heading}</h1>
        <p class="lead">${definition.description}</p>
        <div class="grid">${games
          .map((game, index) =>
            card(game, {
              rank: definition.ranked ? (pageNumber - 1) * PAGE_SIZE + index + 1 : undefined,
              compact: definition.compact,
            }),
          )
          .join('')}</div>
        ${games.length === 0 ? '<p class="muted">Nothing here yet.</p>' : ''}
        ${pager(`/${key}?`, pageNumber, totalPages)}`;
      return reply.type('text/html').send(
        shell({
          title: `${definition.heading} — WebGameRank`,
          description: definition.description,
          path: `/${key}`,
          activeCategory: `@${key}`,
          body,
        }),
      );
    });
  }

  app.get('/c/:category', async (request, reply) => {
    const { category } = request.params as { category: string };
    if (!isCategory(category)) {
      return reply
        .code(404)
        .type('text/html')
        .send(shell({ title: 'Not found — WebGameRank', body: '<h1>Category not found</h1>' }));
    }
    const { sort = 'top', page = '1' } = request.query as { sort?: string; page?: string };
    const activeSort = (Object.keys(LISTS).includes(sort) ? sort : 'top') as ListKey;
    const definition = LISTS[activeSort];
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const where = `AND g.category = $1 ${definition.where}`;

    const [games, total] = await Promise.all([
      query(where, definition.order, PAGE_SIZE, (pageNumber - 1) * PAGE_SIZE, [category]),
      count(where, [category]),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const label = categoryLabel(category);
    const tabs = (Object.keys(LISTS) as ListKey[])
      .map(
        (key) =>
          `<a class="${key === activeSort ? 'active' : ''}" href="/c/${category}?sort=${key}">${LISTS[key].label}</a>`,
      )
      .join('');
    const body = `
      <h1>${CATEGORY_EMOJI[category]} ${escapeHtml(label)} web games</h1>
      <p class="lead">Best ${escapeHtml(label.toLowerCase())} games on the web, ranked by real play time.</p>
      <div class="tabs">${tabs}</div>
      <div class="grid">${games
        .map((game, index) =>
          card(game, {
            rank: definition.ranked ? (pageNumber - 1) * PAGE_SIZE + index + 1 : undefined,
            compact: false,
          }),
        )
        .join('')}</div>
      ${games.length === 0 ? `<p class="muted">No ${escapeHtml(label.toLowerCase())} games here yet.</p>` : ''}
      ${pager(`/c/${category}?sort=${activeSort}&`, pageNumber, totalPages)}`;
    return reply.type('text/html').send(
      shell({
        title: `${label} web games — WebGameRank`,
        description: `Best ${label.toLowerCase()} web games ranked by real play time and player votes.`,
        path: `/c/${category}`,
        activeCategory: category,
        body,
      }),
    );
  });

  app.get('/g/:id/:slug?', async (request, reply) => {
    const { id } = request.params as { id: string; slug?: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return reply
        .code(404)
        .type('text/html')
        .send(shell({ title: 'Not found — WebGameRank', body: '<h1>Game not found</h1>' }));
    }
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_GAME} FROM games g WHERE g.id = $1 AND g.status <> 'hidden'`,
      [id],
    );
    const game = rows[0] as PublicGame | undefined;
    if (!game) {
      return reply
        .code(404)
        .type('text/html')
        .send(shell({ title: 'Not found — WebGameRank', body: '<h1>Game not found</h1>' }));
    }

    const { rows: scoreRows } = await pool.query(
      `SELECT gs.g, gs.q FROM game_scores gs
        JOIN score_runs r ON r.id = gs.run_id
       WHERE gs.game_id = $1 AND r.status = 'ok'
       ORDER BY r.started_at DESC LIMIT 1`,
      [id],
    );
    const subScores = scoreRows[0] as { g: number; q: number } | undefined;

    // Rang dans la catégorie (le rang global est déjà sur le jeu).
    let categoryRank: number | null = null;
    if (game.currentScore != null) {
      const { rows: catRows } = await pool.query(
        `SELECT count(*)::int + 1 AS rank FROM games
          WHERE category = $1 AND status NOT IN ('hidden', 'awaiting_snippet')
            AND current_score > $2`,
        [game.category, game.currentScore],
      );
      categoryRank = catRows[0].rank;
    }

    // Fiche encore accessible avant vérification (le badge que le dev vient
    // d'installer pointe dessus) mais désindexée et signalée comme non listée.
    const unlisted = game.status === 'awaiting_snippet';
    const bar = (label: string, value: number) => `
      <div style="margin:.6rem 0">
        <div style="display:flex;justify-content:space-between;max-width:22rem;font-size:.9rem">
          <strong>${label}</strong><span class="muted">${Math.round(value)} / 100</span></div>
        <div style="background:#e2e8f0;border-radius:.3rem;height:.55rem;max-width:22rem">
          <span style="display:block;height:100%;border-radius:.3rem;background:var(--accent);width:${Math.round(value)}%"></span></div>
      </div>`;

    const body = `
      ${
        unlisted
          ? `<p class="notice">This game is not listed publicly yet — its developer still has to
             verify the WebGameRank snippet on the game page.</p>`
          : ''
      }
      ${
        game.thumbnailUrl
          ? `<img src="${escapeHtml(game.thumbnailUrl)}" alt="${escapeHtml(game.name)}"
               style="max-width:100%;max-height:28rem;width:auto;height:auto;
                      border-radius:.8rem;display:block;margin-bottom:1.2rem">`
          : ''
      }
      <div class="panel">
        <p style="margin:0">
          ${
            categoryRank != null
              ? `<a class="chip" href="/c/${escapeHtml(game.category)}" style="font-weight:700">${CATEGORY_EMOJI[game.category] ?? '🎮'} #${categoryRank} in ${escapeHtml(categoryLabel(game.category))}</a>
                 <span class="muted" style="margin-left:.5rem">#${game.currentRank} global</span>`
              : `<a class="chip" href="/c/${escapeHtml(game.category)}">${CATEGORY_EMOJI[game.category] ?? '🎮'} ${escapeHtml(categoryLabel(game.category))}</a>
                 <span class="muted" style="margin-left:.5rem">unranked</span>`
          }
        </p>
        <h1 style="margin:.5rem 0">${escapeHtml(game.name)}</h1>
        <p class="muted" style="margin:0 0 1rem">${escapeHtml(game.shortDescription)}</p>
        <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap">
          <div>
            <div style="font-size:3.4rem;font-weight:800;line-height:1;color:var(--ink)">${game.currentScore != null ? Math.round(game.currentScore) : 'NEW'}</div>
            <div class="muted" style="font-size:.8rem">WebGameRank score</div>
          </div>
          <a href="/go/${game.id}" rel="nofollow" style="background:var(--accent);color:var(--ink);font-weight:800;font-size:1.05rem;padding:.85rem 2rem;border-radius:.6rem;text-decoration:none">▶ Play now</a>
        </div>
      </div>
      <div id="admin-panel"></div>
      <script>
        // Panneau admin injecté côté client (page publique cachable pour tous ;
        // les contrôles n'apparaissent que si /api/admin renvoie 200).
        fetch('/api/admin/games/${game.id}').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (info) {
            if (!info) return;
            var votes = info.votesUp + info.votesDown;
            var round = function (n, d) { return n == null ? '—' : (+n).toFixed(d || 0); };
            var s = info.score, m = s && s.metrics, c = m && m.corrected;
            // « observé (n=échantillon) → corrigé », ou « prior » si pas de donnée.
            var shrunk = function (observed, sample, corrected, unit) {
              if (!sample) return 'no data → prior ' + round(corrected, 1) + unit;
              return round(observed, 1) + unit + ' (n=' + sample + ') → ' + round(corrected, 1) + unit;
            };
            var scoreRows = s
              ? '<table style="margin-top:.8rem">' +
                  '<tr><th>Axis</th><th>0–100</th><th>Raw metric</th></tr>' +
                  '<tr><td><strong>Score</strong> (rank #' + s.rank + ')</td><td><strong>' + round(s.score, 1) + '</strong></td><td class="muted">v1 score A: ' + round(s.scoreA, 1) + '</td></tr>' +
                  '<tr><td>Popularity (G)</td><td>' + round(s.g, 1) + '</td><td class="muted">' + round(m.weightedVisitors, 1) + ' weighted visitors · ' + round(m.activeMs / 3600000, 1) + ' active h</td></tr>' +
                  '<tr><td>Quality (Q)</td><td>' + round(s.q, 1) + '</td><td class="muted">—</td></tr>' +
                  '<tr><td>· Fidelity (cohort)</td><td>' + round(c.fidelity * 100, 1) + '%</td><td class="muted">' + shrunk((m.fidelity || 0) * 100, m.fidelitySample, c.fidelity * 100, '%') + '</td></tr>' +
                  '<tr><td>· Median session</td><td>' + round(c.median / 60000, 1) + ' min</td><td class="muted">' + (m.sessionSample ? round(m.medianSessionMs / 60000, 1) + ' min (n=' + m.sessionSample + ' sessions)' : 'no session yet → prior') + '</td></tr>' +
                  '<tr><td>· Approval (Wilson)</td><td>' + round(c.approval * 100, 1) + '%</td><td class="muted">' + (votes ? info.votesUp + '/' + votes + ' votes (Wilson lower bound)' : 'no vote → prior') + '</td></tr>' +
                  '<tr><td>· Engagement</td><td>' + round(c.engagement * 100, 1) + '%</td><td class="muted">' + shrunk(0, m.loads, c.engagement * 100, '%') + ' · ' + round(m.loads, 0) + ' loads</td></tr>' +
                  '<tr><td>Peer (P)</td><td>' + round(s.p, 1) + '</td><td class="muted">default (no jury yet)</td></tr>' +
                '</table>' +
                '<p class="muted" style="font-size:.82rem">« prior » = neutral fallback shown when there is not enough data to measure (shrinkage).</p>'
              : '<p class="muted">No score computed yet.</p>';
            var el = document.getElementById('admin-panel');
            el.innerHTML =
              '<div class="panel" style="margin-top:1.2rem;border-color:var(--accent)">' +
              '<h2 style="margin-top:0">Admin</h2>' +
              '<p>Developer: <strong></strong></p>' +
              '<p>Status: <code></code> · Play clicks: <strong>' + info.playClicks + '</strong>' +
              ' · Last event: <span class="muted">' + (info.lastEventAt ? new Date(info.lastEventAt).toLocaleString() : 'never') + '</span></p>' +
              '<p>Votes: <strong>' + info.votesUp + '</strong> up · <strong>' + info.votesDown +
              '</strong> down' + (votes ? ' (' + Math.round(info.votesUp / votes * 100) + '% positive)' : '') + '</p>' +
              scoreRows +
              '<p style="margin-top:1rem"><button id="adm-hide" class="ghost">Hide from site</button> ' +
              '<button id="adm-del" style="background:#b91c1c;border-color:#b91c1c;color:#fff">Delete game</button></p>' +
              '</div>';
            el.querySelector('strong').textContent = info.developerEmail;
            el.querySelector('code').textContent = info.status;
            document.getElementById('adm-hide').onclick = function () {
              if (!confirm('Hide this game from the public site?')) return;
              fetch('/api/admin/games/${game.id}/hide', { method: 'POST' }).then(function () { location.href = '/'; });
            };
            document.getElementById('adm-del').onclick = function () {
              if (!confirm('Permanently delete this game and its data?')) return;
              fetch('/api/admin/games/${game.id}', { method: 'DELETE' }).then(function () { location.href = '/'; });
            };
          }).catch(function () {});
      </script>
      ${
        subScores
          ? `<h2>Score breakdown</h2>${bar('Popularity', subScores.g)}${bar('Quality', subScores.q)}
             <p class="muted" style="font-size:.9rem">Developer jury — coming soon.</p>`
          : '<p class="muted" style="margin-top:1.5rem">This game is being evaluated — its score appears once enough play data comes in.</p>'
      }
      <h2>About ${escapeHtml(game.name)}</h2>
      <p style="max-width:46rem">${escapeHtml(game.description)}</p>
      <p class="muted" style="font-size:.9rem">Scores come from real, verified play time — <a href="/methodology">how it works</a>.</p>`;
    return reply.type('text/html').send(
      shell({
        title: `${game.name} — score & ranking on WebGameRank`,
        description: game.shortDescription || game.description.slice(0, 150),
        path: gamePath(game),
        activeCategory: game.category,
        noindex: unlisted,
        og: {
          title: game.name,
          description: game.shortDescription,
          type: 'website',
          ...(game.thumbnailUrl ? { image: game.thumbnailUrl } : {}),
        },
        body,
      }),
    );
  });

  // Le clic « Play » est compté puis redirigé vers le site du développeur.
  app.get('/go/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send();
    const { rows } = await pool.query(
      `UPDATE games SET play_clicks = play_clicks + 1
        WHERE id = $1 AND status <> 'hidden' RETURNING url`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send();
    return reply.redirect(rows[0].url);
  });

  app.get('/methodology', async (_request, reply) => {
    const body = `
      <h1>How WebGameRank works</h1>
      <p class="lead">Most game rankings measure hype. WebGameRank measures play.</p>
      <div style="max-width:46rem">
        <h2>Real play time, not page views</h2>
        <p>Every ranked game embeds our lightweight SDK. It only counts time when the game is
        actually on screen <em>and</em> the player is actually playing. A tab left open in the
        background counts for nothing, and automated traffic is filtered out by design.</p>
        <h2>Quality can beat size</h2>
        <p>A small game that players love — they come back day after day, play long sessions,
        vote it up — can outrank a heavily promoted game that players abandon after a minute.
        Every score balances <strong>popularity</strong> (how many people really play) with
        <strong>quality</strong> (what players do once they arrive).</p>
        <h2>Votes you can trust</h2>
        <p>You can only vote on a game after really playing it, once per game. And a handful of
        enthusiastic votes never outweighs a hundred genuine ones.</p>
        <h2>Fresh by design</h2>
        <p>Recent activity counts more than last month's. A rising game climbs fast; an abandoned
        one fades. New games are visible from day one in <a href="/new">Top new games</a> and
        <a href="/latest">Latest arrivals</a>.</p>
        <h2>Developer jury — coming soon</h2>
        <p>Every developer who submits a game will play and review recent submissions from other
        developers: expert eyes on every game, from day one.</p>
        <p class="muted">Free for players and developers.
        <a href="/games/new">Submit your game</a> in two minutes.</p>
      </div>`;
    return reply.type('text/html').send(
      shell({
        title: 'How WebGameRank works — real play time, verified votes',
        description:
          'WebGameRank ranks web games by measured play time, player retention and verified votes — not marketing budgets.',
        path: '/methodology',
        body,
      }),
    );
  });

  app.get('/sitemap.xml', async (_request, reply) => {
    const games = await query('', 'g.created_at DESC', 5000);
    const urls = [
      '/',
      '/top',
      '/new',
      '/latest',
      '/methodology',
      ...CATEGORIES.map((category) => `/c/${category}`),
      ...games.map((game) => gamePath(game)),
    ];
    const host = config.appUrl;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${host}${url}</loc></url>`).join('\n')}
</urlset>`;
    return reply.type('application/xml').send(xml);
  });

  app.get('/robots.txt', async (_request, reply) =>
    reply
      .type('text/plain')
      .send(`User-agent: *\nAllow: /\nDisallow: /go/\nSitemap: ${config.appUrl}/sitemap.xml\n`),
  );
}
