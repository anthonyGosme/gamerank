// Serveur des jeux de démo — sert plusieurs mini-jeux pour alimenter
// GameRank en données réelles (classement, catégories, jury).
//
// Chaque jeu est un fragment HTML dans games/<slug>.html : le serveur
// l'habille d'une coquille commune et y injecte le snippet GameRank du jeu
// correspondant, lu dans games.json (créé vide au premier lancement).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 4600);
const api = process.env.GAMERANK_API || 'http://localhost:3000';
// Base path public : derrière Caddy le demo est monté sous /demo. Le serveur
// accepte les requêtes AVEC ou SANS ce préfixe, et émet TOUS ses liens avec.
// Mettre DEMO_BASE_PATH='' pour servir à la racine.
const basePath = (process.env.DEMO_BASE_PATH ?? '/demo').replace(/\/+$/, '');
const gamesDir = path.join(__dirname, 'games');
const configPath = path.join(__dirname, 'games.json');

function loadGames() {
  const games = [];
  for (const file of fs.readdirSync(gamesDir).filter((f) => f.endsWith('.html'))) {
    const slug = file.replace(/\.html$/, '');
    const source = fs.readFileSync(path.join(gamesDir, file), 'utf8');
    const meta = /^<!--meta:(.*?)-->/s.exec(source);
    games.push({
      slug,
      ...(meta ? JSON.parse(meta[1]) : { title: slug, category: 'other', short: '' }),
      body: source.replace(/^<!--meta:.*?-->\s*/s, ''),
    });
  }
  return games.sort((a, b) => a.title.localeCompare(b.title));
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

// Crée/complète games.json pour que les clés soient faciles à renseigner.
function syncConfig(games) {
  const config = loadConfig();
  let changed = false;
  for (const game of games) {
    if (!config[game.slug]) {
      config[game.slug] = { key: '', gameId: '' };
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function snippetFor(slug, config) {
  const entry = config[slug];
  if (!entry || !entry.key) {
    return `<p class="warn">Not connected to WebGameRank yet — register
      <code>${escapeHtml(publicUrl(slug))}</code> on ${escapeHtml(api)}, then put its SDK key
      in <code>apps/demo-game/games.json</code>.</p>`;
  }
  const badge = entry.gameId
    ? `<div style="position:relative;display:inline-block;width:180px;height:40px;margin-top:1rem">
        <script src="${api}/widget.js" data-key="${entry.key}" async><\/script>
        <a href="${api}/g/${entry.gameId}"><img src="${api}/games/${entry.gameId}/badge.svg"
           width="180" height="40" alt="on WebGameRank"></a>
      </div>`
    : '';
  return `<script src="${api}/sdk.js" data-key="${entry.key}" async><\/script>${badge}`;
}

function publicUrl(slug) {
  return `http://localhost:${port}${basePath}/${slug}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const SHELL = (title, body, bg) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --accent:#f59e0b; --bg:${bg || '#2e1a5c'}; --panel:rgba(255,255,255,.07);
    --line:rgba(255,255,255,.16); --ink:#f7f5ff; --muted:#d9d2f0; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,sans-serif; background:var(--bg); color:var(--ink);
    min-height:100vh; display:flex; flex-direction:column; align-items:center; padding:1.5rem 1rem 3rem; }
  a { color:var(--accent); }
  h1 { margin:.2rem 0 .3rem; font-size:1.6rem; }
  .hud { display:flex; gap:1.5rem; margin:.6rem 0 1rem; font-size:1.05rem; }
  .hud b { color:var(--accent); font-size:1.25rem; }
  .stage { background:var(--panel); border:1px solid var(--line); border-radius:.8rem; padding:1rem; }
  button { font:inherit; font-weight:700; padding:.5rem 1.1rem; border-radius:.5rem;
    border:0; background:var(--accent); color:#1d1039; cursor:pointer; }
  .warn { background:#5b2330; padding:.7rem 1rem; border-radius:.6rem; font-size:.85rem; max-width:34rem; }
  .back { position:absolute; left:1rem; top:1rem; font-size:.9rem; }
  .msg { min-height:1.5rem; margin-top:.8rem; color:var(--muted); }
  code { background:#271650; padding:.1rem .35rem; border-radius:.3rem; font-size:.85em; }
</style>
</head><body>
<a class="back" href="${basePath}/">← All demo games</a>
${body}
</body></html>`;

http
  .createServer((req, res) => {
    const games = loadGames();
    const config = syncConfig(games);
    // Retire le préfixe /demo s'il est présent (Caddy peut le transmettre ou non),
    // puis extrait le slug.
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (basePath && (reqPath === basePath || reqPath.startsWith(`${basePath}/`))) {
      reqPath = reqPath.slice(basePath.length) || '/';
    }
    const slug = reqPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.html$/, '');

    if (!slug) {
      const list = games
        .map(
          (game) => `<li><a href="${basePath}/${game.slug}">${escapeHtml(game.title)}</a>
            <span style="color:var(--muted)">— ${escapeHtml(game.category)}${
              config[game.slug] && config[game.slug].key ? '' : ' · not connected'
            }</span></li>`,
        )
        .join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        SHELL(
          'WebGameRank demo games',
          `<h1>Demo games</h1>
           <p style="color:var(--muted)">Local playground to feed WebGameRank with real data.</p>
           <ul style="line-height:2">${list}</ul>`,
        ),
      );
    }

    const game = games.find((candidate) => candidate.slug === slug);
    if (!game) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(SHELL('Not found', '<h1>Game not found</h1>'));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SHELL(game.title, `${game.body}\n${snippetFor(game.slug, config)}`, game.color));
  })
  .listen(port, () => {
    const games = loadGames();
    syncConfig(games);
    console.log(`demo games on http://localhost:${port}`);
    for (const game of games) console.log(`  · ${publicUrl(game.slug)}  [${game.category}]`);
  });
