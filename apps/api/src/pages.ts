// Minimal HTML pages exercising the flows (US-1, US-2.1, US-6.0).
// The real front-end (apps/web) will come with US 5-6; user data is
// injected via textContent (no innerHTML) to avoid XSS.

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — GameRank</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.4rem; }
    input, textarea, button { font-size: 1rem; padding: .5rem .75rem; }
    input, textarea { width: 100%; box-sizing: border-box; margin-bottom: .75rem; }
    button { cursor: pointer; }
    a { color: #1a56db; }
    .notice { padding: .75rem; border-radius: .5rem; background: #eef6ee; margin: 1rem 0; }
    .error { background: #fdeaea; }
    .muted { color: #667; font-size: .9rem; }
    .game { display: flex; justify-content: space-between; align-items: center; gap: 1rem;
            padding: .75rem 0; border-bottom: 1px solid #eee; }
    .badge { font-size: .8rem; padding: .15rem .5rem; border-radius: 1rem; background: #eef; white-space: nowrap; }
    .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
    code { background: #f4f4f4; padding: .2rem .4rem; border-radius: .3rem; word-break: break-all; }
  </style>
</head>
<body>${body}</body>
</html>`;

const STATUS_LABELS = `{
  awaiting_jury: 'Awaiting jury',
  in_evaluation: 'In evaluation',
  ranked: 'Ranked',
  hidden: 'Hidden'
}`;

export const loginPage = layout('Login', `
  <h1>Login</h1>
  <div id="zone">
    <form id="form">
      <input type="email" id="email" placeholder="you@example.com" required autofocus>
      <button type="submit">Send me a login link</button>
    </form>
  </div>
  <script>
    if (new URLSearchParams(location.search).get('error')) {
      document.getElementById('zone').insertAdjacentHTML('beforebegin',
        '<p class="notice error">Invalid or expired link. Request a new one.</p>');
    }
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      document.getElementById('zone').innerHTML = res.ok
        ? '<p class="notice">If this address is valid, a login link is on its way. It expires in 15 minutes.</p>'
        : '<p class="notice error">Invalid email address.</p>';
    });
  </script>
`);

export const dashboardPage = layout('Dashboard', `
  <div class="topbar">
    <h1>My games</h1>
    <span><span id="who" class="muted"></span> <button id="logout">Log out</button></span>
  </div>
  <p><a href="/games/new">+ Add a game</a></p>
  <div id="games"><p class="muted">Loading…</p></div>
  <script>
    const STATUS = ${STATUS_LABELS};
    async function load() {
      const me = await fetch('/api/me');
      if (!me.ok) { location.href = '/login'; return; }
      document.getElementById('who').textContent = (await me.json()).email;
      const games = await (await fetch('/api/games')).json();
      const zone = document.getElementById('games');
      zone.innerHTML = '';
      if (games.length === 0) {
        zone.innerHTML = '<p class="notice">No games yet. Start by '
          + '<a href="/games/new">declaring your game</a> — you will receive its SDK key.</p>';
        return;
      }
      for (const game of games) {
        const row = document.createElement('div');
        row.className = 'game';
        const link = document.createElement('a');
        link.href = '/games/' + game.id;
        link.textContent = game.name;
        const url = document.createElement('span');
        url.className = 'muted';
        url.textContent = game.domain;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = STATUS[game.status] ?? game.status;
        const left = document.createElement('span');
        if (game.thumbnailUrl) {
          const thumb = document.createElement('img');
          thumb.src = game.thumbnailUrl;
          thumb.alt = '';
          thumb.style.cssText = 'width:2.5rem;height:2.5rem;object-fit:cover;border-radius:.4rem;vertical-align:middle;margin-right:.5rem';
          left.append(thumb);
        }
        left.append(link, ' ', url);
        row.append(left, badge);
        zone.append(row);
      }
    }
    document.getElementById('logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      location.href = '/login';
    });
    load();
  </script>
`);

export const newGamePage = layout('Add a game', `
  <p><a href="/dashboard">← My games</a></p>
  <h1>Declare a game</h1>
  <div id="zone"></div>
  <form id="form">
    <input id="name" placeholder="Game name" required maxlength="100" autofocus>
    <input id="url" type="url" placeholder="https://mygame.example.com" required>
    <textarea id="description" placeholder="Description" rows="4" required></textarea>
    <label>Thumbnail (PNG, JPEG, WebP or GIF — 2 MB max)
      <input id="thumbnail" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required>
    </label>
    <button type="submit">Register and get my SDK key</button>
  </form>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = new FormData();
      body.append('name', document.getElementById('name').value);
      body.append('url', document.getElementById('url').value);
      body.append('description', document.getElementById('description').value);
      body.append('thumbnail', document.getElementById('thumbnail').files[0]);
      const res = await fetch('/api/games', { method: 'POST', body });
      if (res.status === 401) { location.href = '/login'; return; }
      if (res.ok) { location.href = '/games/' + (await res.json()).id; return; }
      const { error } = await res.json();
      const zone = document.getElementById('zone');
      zone.innerHTML = '<p class="notice error"></p>';
      zone.firstChild.textContent = error;
    });
  </script>
`);

export const adminPage = layout('Admin', `
  <style>body { max-width: 72rem; } table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eee; font-size: .85rem; }
    th { color: #667; font-weight: 600; }</style>
  <div class="topbar">
    <h1>Admin — ingestion overview</h1>
    <a href="/dashboard">← Dashboard</a>
  </div>
  <div id="zone"><p class="muted">Loading…</p></div>
  <script>
    const STATUS = ${STATUS_LABELS};
    function cell(row, text) {
      const td = document.createElement('td');
      td.textContent = text ?? '';
      row.append(td);
      return td;
    }
    async function load() {
      const res = await fetch('/api/admin/overview');
      if (!res.ok) { location.href = '/dashboard'; return; }
      const { games, stats, recent } = await res.json();
      const byGame = Object.fromEntries(stats.map((s) => [s.gameId, s]));
      const names = Object.fromEntries(games.map((g) => [g.id, g.name]));
      const zone = document.getElementById('zone');
      zone.innerHTML = '<h2>Games</h2><table id="games"><tr><th>Name</th><th>Developer</th>'
        + '<th>Domain</th><th>Status</th><th>Last event</th><th>Events 24h</th>'
        + '<th>Visitors 24h</th><th>Active min 24h</th></tr></table>'
        + '<h2>Last 30 events</h2><table id="events"><tr><th>Time (UTC)</th><th>Game</th>'
        + '<th>Type</th><th>Visitor</th><th>Session</th><th>Active ms</th><th>IP</th><th>SDK</th></tr></table>';
      const gamesTable = document.getElementById('games');
      for (const game of games) {
        const s = byGame[game.id];
        const row = document.createElement('tr');
        cell(row, game.name);
        cell(row, game.developerEmail);
        cell(row, game.domain);
        cell(row, STATUS[game.status] ?? game.status);
        cell(row, game.lastEventAt ? new Date(game.lastEventAt).toLocaleString() : '—');
        cell(row, s ? s.events : '0');
        cell(row, s ? s.visitors : '0');
        cell(row, s ? Math.round(Number(s.activeMs) / 60000) : '0');
        gamesTable.append(row);
      }
      const eventsTable = document.getElementById('events');
      for (const event of recent) {
        const row = document.createElement('tr');
        cell(row, event.ts);
        cell(row, names[event.gameId] ?? event.gameId);
        cell(row, event.type);
        cell(row, event.visitorId);
        cell(row, event.sessionId);
        cell(row, String(event.activeMs));
        cell(row, event.ip);
        cell(row, event.sdkVersion);
        eventsTable.append(row);
      }
    }
    load();
  </script>
`);

export const gamePage = layout('Game', `
  <p><a href="/dashboard">← My games</a></p>
  <div id="zone"><p class="muted">Loading…</p></div>
  <script>
    const STATUS = ${STATUS_LABELS};
    async function load() {
      const id = location.pathname.split('/').pop();
      const res = await fetch('/api/games/' + id);
      if (res.status === 401) { location.href = '/login'; return; }
      if (!res.ok) {
        document.getElementById('zone').innerHTML = '<p class="notice error">Game not found.</p>';
        return;
      }
      const game = await res.json();
      const zone = document.getElementById('zone');
      zone.innerHTML = '<h1></h1>'
        + '<p><img id="thumb" alt="" style="max-width:12rem;border-radius:.5rem"></p>'
        + '<p><a id="url" target="_blank" rel="noopener"></a> <span class="badge" id="status"></span></p>'
        + '<p id="description"></p>'
        + '<h2>Integration</h2>'
        + '<p>Paste this snippet in your game page — it measures real play time:</p>'
        + '<p><code id="snippet"></code> <button id="copy">Copy</button></p>'
        + '<p id="events-status" class="muted"></p>'
        + '<p class="muted">Events whose origin does not match <strong id="domain"></strong> will be rejected.</p>';
      zone.querySelector('h1').textContent = game.name;
      const thumb = document.getElementById('thumb');
      if (game.thumbnailUrl) thumb.src = game.thumbnailUrl; else thumb.remove();
      const url = document.getElementById('url');
      url.textContent = game.url; url.href = game.url;
      document.getElementById('status').textContent = STATUS[game.status] ?? game.status;
      document.getElementById('description').textContent = game.description || '';
      const snippet = '<script src="' + location.origin + '/sdk.js" data-key="' + game.sdkKey + '" async><\\/script>';
      document.getElementById('snippet').textContent = snippet;
      document.getElementById('copy').addEventListener('click', () =>
        navigator.clipboard.writeText(snippet));
      document.getElementById('domain').textContent = game.domain;
      renderEventsStatus(game);
      setInterval(refreshEventsStatus, 10000, id);
    }
    function renderEventsStatus(game) {
      document.getElementById('events-status').textContent = game.lastEventAt
        ? 'Events received ✓ — last: ' + new Date(game.lastEventAt).toLocaleString()
        : 'No events received yet. Install the snippet, then play your game to check.';
    }
    async function refreshEventsStatus(id) {
      const res = await fetch('/api/games/' + id);
      if (res.ok) renderEventsStatus(await res.json());
    }
    load();
  </script>
`);
