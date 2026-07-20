// Coquille commune à TOUT le site (public + login/dashboard/admin) :
// une seule identité visuelle, un seul header, une seule feuille de style.
import { CATEGORIES, categoryLabel } from './categories.js';

export const CATEGORY_EMOJI: Record<string, string> = {
  action: '💥',
  puzzle: '🧩',
  arcade: '👾',
  strategy: '♟️',
  sports: '⚽',
  racing: '🏎️',
  rpg: '🗡️',
  'idle-clicker': '⏳',
  'card-board': '🃏',
  shooter: '🎯',
  platformer: '🦘',
  other: '🎲',
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Marque : tuile sombre + barres ascendantes = classement, lisible à 16 px.
export const LOGO_SVG = `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
  <rect width="32" height="32" rx="8" fill="#f59e0b"/>
  <rect x="6.5" y="17.5" width="4.5" height="8" rx="2" fill="#111827" opacity=".45"/>
  <rect x="13.75" y="12.5" width="4.5" height="13" rx="2" fill="#111827" opacity=".72"/>
  <rect x="21" y="6.5" width="4.5" height="19" rx="2" fill="#111827"/>
</svg>`;

const STYLES = `
  :root {
    --accent: #f59e0b; --bg: #2e1a5c; --panel: #3a2470; --panel2: #271650;
    --line: #4d3488; --ink: #f3f0fb; --muted: #b2a4d8; --dark: #1d1039;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--ink); background: var(--bg); }
  a { color: inherit; }

  header.top { position: sticky; top: 0; z-index: 10; background: var(--dark);
    border-bottom: 1px solid var(--line); display: flex; align-items: center;
    gap: 1.5rem; padding: .7rem 1.5rem; flex-wrap: wrap; }
  header.top .brand { display: flex; align-items: center; gap: .55rem; text-decoration: none;
    color: #fff; font-weight: 800; font-size: 1.25rem; letter-spacing: -.02em; }
  header.top .brand b { color: var(--accent); }
  header.top .right { margin-left: auto; display: flex; align-items: center; gap: 1rem; }
  header.top .cta { background: var(--accent); color: var(--dark); font-weight: 700;
    padding: .45rem 1rem; border-radius: .5rem; text-decoration: none; }

  .shell { display: flex; align-items: flex-start; width: 100%; }
  aside.side { position: sticky; top: 3.4rem; flex: 0 0 15rem; align-self: flex-start;
    background: var(--panel2); border-right: 1px solid var(--line);
    min-height: calc(100vh - 3.4rem); padding: 1.2rem .8rem; }
  aside.side h3 { font-size: .72rem; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 1.4rem 0 .5rem .6rem; }
  aside.side h3:first-child { margin-top: 0; }
  aside.side a { display: flex; align-items: center; gap: .7rem; padding: .5rem .6rem;
    border-radius: .5rem; text-decoration: none; font-size: .95rem; font-weight: 500;
    color: var(--ink); }
  aside.side a:hover { background: #3d2779; }
  aside.side a.active { background: var(--accent); color: var(--dark); font-weight: 700; }
  aside.side a .emo { font-size: 1.1rem; line-height: 1; }
  aside.side .sep { border-top: 1px solid var(--line); margin: 1.2rem .4rem; }
  main.content { flex: 1 1 auto; min-width: 0; padding: 1.6rem 2rem 4rem; }
  main.narrow { max-width: 34rem; margin: 0 auto; }

  h1 { font-size: 2rem; letter-spacing: -.02em; margin: .2rem 0 .4rem; }
  .lead { color: var(--muted); font-size: 1.05rem; margin: 0 0 1.6rem; max-width: 46rem; }
  h2 { font-size: 1.25rem; margin: 2.2rem 0 .9rem; display: flex; align-items: baseline; gap: .7rem; }
  h2 a.more { font-size: .85rem; font-weight: 500; color: var(--accent); text-decoration: none; }
  h2 > a.title { text-decoration: none; }
  h2 > a.title:hover { text-decoration: underline; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); gap: 1.1rem; }
  .card { display: flex; flex-direction: column; background: var(--panel);
    border: 1px solid var(--line); border-radius: .75rem; overflow: hidden;
    text-decoration: none; color: inherit; transition: .12s; }
  .card:hover { border-color: var(--accent); transform: translateY(-2px); }
  /* 16/9 imposé : l'image est positionnée en absolu puis recadrée au centre,
     quelles que soient ses dimensions d'origine. */
  .thumbWrap { position: relative; width: 100%; padding-top: 56.25%;
    overflow: hidden; background: #271650; }
  .thumbWrap img, .thumbFallback { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; object-position: center; display: block; }
  .thumbFallback { display: flex; align-items: center; justify-content: center;
    font-size: 3rem; background: linear-gradient(140deg,#442a83,#2b1857); }
  .rankBadge { position: absolute; top: .5rem; left: .5rem; background: rgba(20,10,45,.88);
    color: #fff; font-weight: 800; font-size: .95rem; padding: .15rem .55rem; border-radius: .45rem; }
  .scoreBadge { position: absolute; bottom: .5rem; right: .5rem; background: var(--accent);
    color: var(--dark); font-weight: 800; font-size: 1.35rem; line-height: 1;
    padding: .35rem .6rem; border-radius: .5rem; }
  .scoreBadge.new { background: #10b981; color: #06281d; font-size: .95rem; padding: .45rem .6rem; }
  .cardBody { padding: .7rem .8rem .9rem; }
  .cardBody strong { display: block; font-size: 1rem; line-height: 1.25; }
  .cardBody p { margin: .35rem 0 0; font-size: .85rem; color: var(--muted); line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cardBody .cat { display: inline-block; margin-top: .5rem; font-size: .75rem; color: var(--muted); }

  .tabs { display: flex; gap: .5rem; margin: 1.2rem 0; flex-wrap: wrap; }
  .tabs a { text-decoration: none; padding: .4rem 1rem; border-radius: 2rem;
    background: var(--panel); border: 1px solid var(--line); font-size: .92rem; color: var(--muted); }
  .tabs a.active { background: var(--accent); color: var(--dark); border-color: var(--accent); font-weight: 700; }
  .pager { display: flex; gap: 1.2rem; align-items: center; margin: 2rem 0; }
  .muted { color: var(--muted); }

  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: .75rem; padding: 1.4rem; }
  input, textarea, select, button { font: inherit; padding: .55rem .8rem; border-radius: .5rem;
    border: 1px solid var(--line); background: var(--panel2); color: var(--ink); }
  input, textarea, select { width: 100%; margin-bottom: .8rem; }
  input::placeholder, textarea::placeholder { color: #6f6c8c; }
  button { cursor: pointer; background: var(--accent); color: var(--dark);
    border-color: var(--accent); font-weight: 700; }
  button.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
  form label { display: block; font-weight: 600; font-size: .9rem; margin: .9rem 0 .3rem; }
  .notice { padding: .8rem 1rem; border-radius: .6rem; background: #1d3a2f; margin: 1rem 0; }
  .notice.error { background: #3a1d22; }
  code { background: var(--panel2); padding: .15rem .4rem; border-radius: .35rem;
    font-size: .85rem; word-break: break-all; color: #e5c07b; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid var(--line); font-size: .88rem; }
  th { color: var(--muted); font-weight: 600; }
  .chip { font-size: .78rem; padding: .15rem .55rem; border-radius: 1rem;
    background: #2f2c48; color: #c7c3e8; text-decoration: none; }
  @media (max-width: 52rem) {
    aside.side { display: none; }
    main.content { padding: 1.2rem 1rem 3rem; }
    h1 { font-size: 1.5rem; }
  }
`;

function sidebar(activeCategory?: string): string {
  const items = CATEGORIES.map(
    (category) => `<a href="/c/${category}" class="${category === activeCategory ? 'active' : ''}">
      <span class="emo">${CATEGORY_EMOJI[category] ?? '🎮'}</span>${escapeHtml(categoryLabel(category))}</a>`,
  ).join('');
  return `<aside class="side">
    <h3>Browse</h3>
    <a href="/top" class="${activeCategory === '@top' ? 'active' : ''}"><span class="emo">🏆</span>Top 50</a>
    <a href="/new" class="${activeCategory === '@new' ? 'active' : ''}"><span class="emo">✨</span>Top new games</a>
    <a href="/latest" class="${activeCategory === '@latest' ? 'active' : ''}"><span class="emo">🕘</span>Latest arrivals</a>
    <h3>Categories</h3>
    ${items}
    <div class="sep"></div>
    <a href="/methodology" class="${activeCategory === '@how' ? 'active' : ''}"><span class="emo">💡</span>How it works</a>
    <a href="/dashboard" class="${activeCategory === '@dev' ? 'active' : ''}"><span class="emo">🛠️</span>For developers</a>
    <a href="/login" id="gr-auth"><span class="emo" id="gr-auth-emo">🔑</span><span id="gr-auth-label">Log in</span></a>
    <script>
      // Bascule Log in ↔ Sign out selon la session. L'état par défaut est
      // « Log in » : les pages publiques restent identiques pour tous
      // (donc cachables), le JS ne fait que corriger si session il y a.
      fetch('/api/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
        if (!me) return;
        document.getElementById('gr-auth').href = '/signout';
        document.getElementById('gr-auth-emo').textContent = '🚪';
        document.getElementById('gr-auth-label').textContent = 'Sign out';
      }).catch(function () {});
    </script>
  </aside>`;
}

export function shell(options: {
  title: string;
  description?: string;
  path?: string;
  body: string;
  og?: Record<string, string>;
  activeCategory?: string;
  withSidebar?: boolean;
  narrow?: boolean;
  noindex?: boolean;
}): string {
  const og = Object.entries(options.og ?? {})
    .map(([property, content]) => `<meta property="og:${property}" content="${escapeHtml(content)}">`)
    .join('\n  ');
  const favicon = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  ${options.description ? `<meta name="description" content="${escapeHtml(options.description)}">` : ''}
  ${options.noindex ? '<meta name="robots" content="noindex">' : ''}
  ${options.path ? `<link rel="canonical" href="${escapeHtml(options.path)}">` : ''}
  <link rel="icon" href="${favicon}">
  ${og}
  <style>${STYLES}</style>
</head>
<body>
  <header class="top">
    <a class="brand" href="/">${LOGO_SVG}<span>WebGame<b>Rank</b></span></a>
    <div class="right">
      <a class="cta" href="/games/new">Submit your game</a>
    </div>
  </header>
  <div class="shell">
    ${options.withSidebar === false ? '' : sidebar(options.activeCategory)}
    <main class="content${options.narrow ? ' narrow' : ''}">${options.body}</main>
  </div>
</body>
</html>`;
}
