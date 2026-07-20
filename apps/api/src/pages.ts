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
  <style>
    form label { display: block; font-weight: 600; font-size: .9rem; margin: .9rem 0 .25rem; }
    .hint { color: #667; font-size: .85rem; margin: .2rem 0 0; }
  </style>
  <form id="form">
    <label for="name">Game name</label>
    <input id="name" placeholder="My awesome game" required maxlength="100" autofocus>
    <label for="url">Game URL</label>
    <input id="url" type="url" placeholder="https://mygame.example.com" required>
    <p class="hint">Example: <code>http://localhost:8000</code> for local testing.</p>
    <p class="hint"><label style="display:inline;font-weight:400">
      <input type="checkbox" id="isLocal" style="width:auto;margin:0 .3rem 0 0;vertical-align:middle">
      This is a local address (localhost or IP), not an internet domain name</label></p>
    <label for="description">Description</label>
    <textarea id="description" placeholder="What makes your game fun?" rows="4" required></textarea>
    <label for="thumbnail">Thumbnail (PNG, JPEG, WebP or GIF — 2 MB max)</label>
    <input id="thumbnail" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required>
    <img id="thumb-preview" alt="" hidden style="max-width:12rem;max-height:8rem;border-radius:.5rem;display:block;margin:.5rem 0 1rem">
    <button type="submit">Register and get my SDK key</button>
  </form>
  <script>
    const thumbInput = document.getElementById('thumbnail');
    const thumbPreview = document.getElementById('thumb-preview');
    thumbInput.addEventListener('change', () => {
      const file = thumbInput.files[0];
      if (file) {
        thumbPreview.src = URL.createObjectURL(file);
        thumbPreview.hidden = false;
      } else {
        thumbPreview.hidden = true;
      }
    });
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = new FormData();
      body.append('name', document.getElementById('name').value);
      body.append('url', document.getElementById('url').value);
      body.append('description', document.getElementById('description').value);
      body.append('isLocal', document.getElementById('isLocal').checked ? 'true' : 'false');
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
      const data = await res.json();
      const { games, stats, recent } = data;
      const byGame = Object.fromEntries(stats.map((s) => [s.gameId, s]));
      const names = Object.fromEntries(games.map((g) => [g.id, g.name]));
      const zone = document.getElementById('zone');
      zone.innerHTML = '<h2>Games</h2><table id="games"><tr><th>Rank</th><th>Score</th><th>Name</th>'
        + '<th>Developer</th><th>Domain</th><th>Status</th><th>Last event</th><th>Events 24h</th>'
        + '<th>Visitors 24h</th><th>Active min 24h</th></tr></table>'
        + '<h2>Last 20 score runs <button id="recompute">Recompute now</button> '
        + '<span id="recompute-status" class="muted"></span></h2>'
        + '<table id="runs"><tr><th>Started</th><th>Duration</th><th>Status</th><th>Games</th><th>Error</th></tr></table>'
        + '<h2>Last 30 events</h2><table id="events"><tr><th>Time (UTC)</th><th>Game</th>'
        + '<th>Type</th><th>Visitor</th><th>Session</th><th>Active ms</th><th>IP</th><th>SDK</th></tr></table>';
      const runsTable = document.getElementById('runs');
      for (const run of data.runs ?? []) {
        const row = document.createElement('tr');
        cell(row, new Date(run.startedAt).toLocaleString());
        cell(row, run.durationMs != null ? run.durationMs + ' ms' : '…');
        cell(row, run.status);
        cell(row, run.gamesCount != null ? String(run.gamesCount) : '');
        cell(row, run.error || '');
        runsTable.append(row);
      }
      document.getElementById('recompute').addEventListener('click', async () => {
        const status = document.getElementById('recompute-status');
        status.textContent = 'running…';
        const res = await fetch('/api/admin/recompute', { method: 'POST' });
        if (res.ok) {
          const summary = await res.json();
          status.textContent = 'done in ' + summary.durationMs + ' ms (' + summary.gamesCount + ' games)';
          load();
        } else {
          status.textContent = 'failed';
        }
      });
      const gamesTable = document.getElementById('games');
      for (const game of games) {
        const s = byGame[game.id];
        const row = document.createElement('tr');
        cell(row, game.currentRank != null ? '#' + game.currentRank : '—');
        cell(row, game.currentScore != null ? String(Math.round(game.currentScore)) : '—');
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
        + '<p><a id="url" target="_blank" rel="noopener"></a> <span class="badge" id="status"></span> '
        + '<span class="badge" id="score-badge" hidden></span></p>'
        + '<p id="description"></p>'
        + '<h2>Integration</h2>'
        + '<p>Paste this snippet in your game page. The first line measures real play time '
        + '(required) ; the <code>&lt;div&gt;</code> shows the badge and lets players vote '
        + '(remove it if you do not want the badge):</p>'
        + '<p><code id="snippet"></code> <button id="copy">Copy</button></p>'
        + '<p id="verify-zone"></p>'
        + '<p id="events-status" class="muted"></p>'
        + '<p>Badge preview: <img id="badge-preview" width="180" height="40" alt="" style="vertical-align:middle"> '
        + '<label class="muted">color <input type="color" id="badge-color" style="width:3rem;padding:0;vertical-align:middle"></label></p>'
        + '<p class="muted">Events whose origin does not match <strong id="domain"></strong> will be rejected.</p>'
        + '<p style="margin-top:2.5rem"><button id="delete-btn" style="color:#b91c1c;border-color:#b91c1c">Delete this game</button></p>';
      zone.querySelector('h1').textContent = game.name;
      const thumb = document.getElementById('thumb');
      if (game.thumbnailUrl) thumb.src = game.thumbnailUrl; else thumb.remove();
      const url = document.getElementById('url');
      url.textContent = game.url; url.href = game.url;
      document.getElementById('status').textContent = STATUS[game.status] ?? game.status;
      if (game.currentScore != null) {
        const scoreBadge = document.getElementById('score-badge');
        scoreBadge.hidden = false;
        scoreBadge.textContent = 'Score ' + Math.round(game.currentScore) + ' · rank #' + game.currentRank;
      }
      document.getElementById('description').textContent = game.description || '';
      const snippet = '<script src="' + location.origin + '/sdk.js" data-key="' + game.sdkKey + '" async><\\/script>\\n'
        + '<div style="position:relative;display:inline-block;width:180px;height:40px">'
        + '<script src="' + location.origin + '/widget.js" data-key="' + game.sdkKey + '" async><\\/script>'
        + '<a href="' + location.origin + '/g/' + game.id + '">'
        + '<img src="' + location.origin + '/games/' + game.id + '/badge.svg" width="180" height="40" alt="' + game.name.replaceAll('"', '') + ' on GameRank"></a></div>';
      document.getElementById('snippet').textContent = snippet;
      document.getElementById('copy').addEventListener('click', () =>
        navigator.clipboard.writeText(snippet));
      const preview = document.getElementById('badge-preview');
      const refreshPreview = () => {
        preview.src = '/games/' + game.id + '/badge.svg?arrows=1&t=' + Date.now();
      };
      refreshPreview();
      const colorInput = document.getElementById('badge-color');
      colorInput.value = game.badgeColor || '#111827';
      colorInput.addEventListener('change', async () => {
        const res = await fetch('/api/games/' + game.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ badgeColor: colorInput.value }),
        });
        if (res.ok) refreshPreview();
      });
      document.getElementById('domain').textContent = game.domain;
      renderVerifyZone(game);
      renderEventsStatus(game);
      setInterval(refreshEventsStatus, 10000, id);
      document.getElementById('delete-btn').addEventListener('click', async () => {
        if (!confirm('Delete "' + game.name + '"? Its stats and votes will be lost. This cannot be undone.')) return;
        const res = await fetch('/api/games/' + game.id, { method: 'DELETE' });
        if (res.status === 204) { location.href = '/dashboard'; return; }
        alert('Could not delete this game.');
      });
    }
    function renderVerifyZone(game) {
      const zone = document.getElementById('verify-zone');
      const verified = !!game.integrationVerifiedAt;
      zone.innerHTML = verified
        ? '<span style="color:#15803d;font-weight:600">Integration verified ✓</span> '
          + '<span class="muted" id="verify-date"></span> '
          + '<button id="verify-btn">Recheck the integration</button> '
          + '<span id="verify-error" style="color:#b91c1c"></span>'
        : '<span style="color:#b91c1c;font-weight:600">⚠ Verify your integration</span> '
          + '<button id="verify-btn">Verify code</button> '
          + '<span id="verify-error" style="color:#b91c1c"></span>';
      if (verified) {
        document.getElementById('verify-date').textContent =
          new Date(game.integrationVerifiedAt).toLocaleString();
      }
      document.getElementById('verify-btn').addEventListener('click', async () => {
        const btn = document.getElementById('verify-btn');
        btn.disabled = true; btn.textContent = 'Checking…';
        const res = await fetch('/api/games/' + game.id + '/verify', { method: 'POST' });
        if (res.ok) { renderVerifyZone(await res.json()); return; }
        const message = (await res.json()).error;
        game.integrationVerifiedAt = null;
        renderVerifyZone(game);
        document.getElementById('verify-error').textContent = message;
      });
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
