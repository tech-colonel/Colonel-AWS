/**
 * ui.js — the app window, as one self-contained HTML page (no external files, so
 * it survives being packaged into the .exe). It polls /api/state and posts to the
 * actions in app.js. Kept free of backticks so it can live in this template string.
 */

module.exports = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Colonel Tally Connector</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #ffffff; --line: #e2e5ea; --text: #16191f; --muted: #667085;
    --accent: #1f4fd8; --accent-text: #ffffff; --ok: #12824c; --ok-bg: #e4f5ec;
    --bad: #c0362c; --bad-bg: #fbe9e7; --wait: #8a6100; --wait-bg: #fdf1d3; --idle-bg: #eceef2;
    --field: #ffffff; --log-bg: #10141b; --log-text: #cfd6e4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1218; --card: #181c24; --line: #2a303b; --text: #e8ebf1; --muted: #98a2b3;
      --accent: #5b86f5; --accent-text: #0b0e14; --ok: #4cc38a; --ok-bg: #12301f;
      --bad: #f0857b; --bad-bg: #3a1a17; --wait: #e9b949; --wait-bg: #3a2e0f; --idle-bg: #232833;
      --field: #10141b; --log-bg: #0a0d12; --log-text: #b9c2d3;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 20px 16px 32px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  header h1 { font-size: 20px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  header .ver { color: var(--muted); font-size: 12px; }
  header .grow { flex: 1; }
  .pill { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--idle-bg); color: var(--muted); }
  .pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .pill.ok { background: var(--ok-bg); color: var(--ok); }
  .pill.bad { background: var(--bad-bg); color: var(--bad); }
  .pill.wait { background: var(--wait-bg); color: var(--wait); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .grid .card { margin-bottom: 0; }
  .grid { margin-bottom: 14px; }
  .card h2 { font-size: 14px; margin: 0; font-weight: 650; }
  .card .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
  .detail { color: var(--muted); font-size: 13px; margin: 0 0 12px; overflow-wrap: anywhere; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 0 0 4px; }
  input[type=text], input[type=email], input[type=password], input[type=number], select {
    width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--field); color: var(--text); font: inherit;
  }
  input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: flex; gap: 10px; margin-bottom: 10px; }
  .row > div { flex: 1; min-width: 0; }
  .row > .narrow { flex: 0 0 110px; }
  button { font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button:disabled { opacity: 0.55; cursor: default; }
  button.link { border: 0; background: none; padding: 0; color: var(--accent); font-weight: 600; }
  .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .err { color: var(--bad); font-size: 13px; margin: 10px 0 0; overflow-wrap: anywhere; }
  .notice { background: var(--wait-bg); color: var(--wait); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px; }
  .co { display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-top: 1px solid var(--line); }
  .co:first-child { border-top: 0; padding-top: 0; }
  .co input { margin-top: 3px; }
  .co .name { font-weight: 600; overflow-wrap: anywhere; }
  .co .sub { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .co .sub.bad { color: var(--bad); }
  .co .sub.ok { color: var(--ok); }
  .facts { display: flex; gap: 22px; flex-wrap: wrap; margin-bottom: 12px; }
  .facts div span { display: block; font-size: 12px; color: var(--muted); }
  .facts div b { font-weight: 600; font-variant-numeric: tabular-nums; }
  pre { margin: 10px 0 0; background: var(--log-bg); color: var(--log-text); border-radius: 8px; padding: 10px 12px; font: 12px/1.5 Consolas, "Cascadia Mono", monospace; height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .hide { display: none !important; }
  details summary { cursor: pointer; color: var(--muted); font-size: 12.5px; margin: 4px 0 10px; }
  footer { color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Colonel Tally Connector</h1>
    <span class="ver" id="ver"></span>
    <span class="grow"></span>
    <span class="pill" id="overall">Starting</span>
  </header>

  <div class="notice hide" id="notice"></div>

  <div class="grid">
    <section class="card">
      <div class="head"><h2>agent.accountant</h2><span class="pill" id="cloudPill">Not logged in</span></div>
      <div id="loggedIn" class="hide">
        <p class="detail" id="cloudDetail"></p>
        <div class="actions"><button id="logoutBtn">Log out</button></div>
      </div>
      <form id="loginForm" class="hide" autocomplete="on">
        <div class="row"><div><label for="email">Admin email</label><input type="email" id="email" autocomplete="username" required></div></div>
        <div class="row"><div><label for="password">Password</label><input type="password" id="password" autocomplete="current-password" required></div></div>
        <details><summary>Server address</summary>
          <div class="row"><div><label for="serverUrl">agent.accountant address</label><input type="text" id="serverUrl" spellcheck="false"></div></div>
        </details>
        <div class="actions"><button class="primary" id="loginBtn" type="submit">Log in</button></div>
        <p class="err hide" id="loginErr"></p>
      </form>
    </section>

    <section class="card">
      <div class="head"><h2>Tally</h2><span class="pill" id="tallyPill">Not checked</span></div>
      <p class="detail" id="tallyDetail"></p>
      <form id="tallyForm">
        <div class="row">
          <div><label for="host">Host (PC or server Tally runs on)</label><input type="text" id="host" spellcheck="false" required></div>
          <div class="narrow"><label for="port">Port</label><input type="number" id="port" min="1" max="65535" required></div>
        </div>
        <div class="actions"><button id="tallyBtn" type="submit">Test and save</button></div>
        <p class="err hide" id="tallyErr"></p>
      </form>
    </section>
  </div>

  <section class="card">
    <div class="head"><h2>Companies to sync</h2><span class="detail" style="margin:0" id="coHint"></span></div>
    <div id="companies"></div>
    <p class="err hide" id="coErr"></p>
  </section>

  <section class="card">
    <div class="head"><h2>Sync</h2><span class="pill" id="syncPill">Idle</span></div>
    <div class="facts">
      <div><span>Last sync</span><b id="lastSync">Never</b></div>
      <div><span>Next sync</span><b id="nextSync">Not scheduled</b></div>
      <div><span>Every</span>
        <select id="interval" aria-label="Sync interval">
          <option value="5">5 minutes</option><option value="15">15 minutes</option>
          <option value="30">30 minutes</option><option value="60">1 hour</option>
        </select>
      </div>
    </div>
    <div class="actions"><button class="primary" id="syncBtn">Sync now</button><span class="detail" style="margin:0" id="syncLine"></span></div>
    <pre id="log" aria-label="Activity log"></pre>
  </section>

  <footer>
    <span id="foot"></span>
    <span><button class="link" id="quitBtn">Quit connector</button></span>
  </footer>
</div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var first = true, coSig = '', gone = false, misses = 0;

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Colonel-UI': '1' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Something went wrong'); return j; });
  }
  function pill(el, kind, text) { el.className = 'pill' + (kind ? ' ' + kind : ''); el.textContent = text; }
  function show(el, on) { el.classList.toggle('hide', !on); }
  function err(el, msg) { el.textContent = msg || ''; show(el, !!msg); }
  function when(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    return d.toLocaleDateString() === new Date().toLocaleDateString() ? d.toLocaleTimeString() : d.toLocaleString();
  }

  function renderCompanies(s) {
    var names = s.open_companies.map(function (c) { return c.name; });
    s.companies.forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    var results = {};
    ((s.status && s.status.companies) || []).forEach(function (c) { results[c.name] = c; });
    var sig = JSON.stringify([names, s.companies, results, s.tally.ok]);
    if (sig === coSig) return;
    coSig = sig;
    var box = $('companies');
    box.textContent = '';
    if (!names.length) {
      var p = document.createElement('p');
      p.className = 'detail'; p.style.margin = '0';
      p.textContent = s.tally.ok ? 'No company is open in Tally. Open one in Tally and it will appear here.' : 'Connect to Tally to see its open companies.';
      box.appendChild(p);
    }
    names.forEach(function (name) {
      var open = s.open_companies.filter(function (c) { return c.name === name; })[0];
      var row = document.createElement('label'); row.className = 'co';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = name;
      cb.checked = !s.companies.length || s.companies.indexOf(name) >= 0;
      cb.addEventListener('change', saveCompanies);
      var text = document.createElement('div');
      var n = document.createElement('div'); n.className = 'name'; n.textContent = name;
      var sub = document.createElement('div'); sub.className = 'sub';
      var r = results[name];
      if (r) { sub.textContent = r.detail; sub.className = 'sub ' + (r.ok ? 'ok' : 'bad'); }
      else if (!open) { sub.textContent = 'Not open in Tally right now'; sub.className = 'sub bad'; }
      else sub.textContent = 'Open in Tally' + (open.books_from ? ', books from ' + open.books_from : '');
      text.appendChild(n); text.appendChild(sub);
      row.appendChild(cb); row.appendChild(text);
      box.appendChild(row);
    });
    $('coHint').textContent = names.length ? (s.companies.length ? s.companies.length + ' selected' : 'All open companies') : '';
  }

  function saveCompanies() {
    var boxes = [].slice.call(document.querySelectorAll('#companies input'));
    var picked = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    if (!picked.length) { err($('coErr'), 'Keep at least one company selected.'); coSig = ''; refresh(); return; }
    err($('coErr'), '');
    post('/api/settings', { companies: picked.length === boxes.length ? [] : picked }).then(refresh, function (e) { err($('coErr'), e.message); });
  }

  function render(s) {
    $('ver').textContent = 'v' + s.version;
    if (first) {
      $('host').value = s.tally_host || ''; $('port').value = s.tally_port || 9002;
      $('email').value = s.user_email || ''; $('serverUrl').value = s.server_url || '';
      first = false;
    }
    if (document.activeElement !== $('interval')) {
      var sel = $('interval'), v = String(s.interval_minutes);
      if (![].some.call(sel.options, function (o) { return o.value === v; })) {
        var o = document.createElement('option'); o.value = v; o.textContent = v + ' minutes'; sel.appendChild(o);
      }
      sel.value = v;
    }

    var cloud = s.status && s.status.cloud;
    show($('loginForm'), !s.logged_in); show($('loggedIn'), s.logged_in);
    if (!s.logged_in) pill($('cloudPill'), '', 'Not logged in');
    else if (cloud && cloud.ok === false && cloud.detail) pill($('cloudPill'), 'bad', 'Not connected');
    else pill($('cloudPill'), 'ok', cloud ? 'Connected' : 'Logged in');
    $('cloudDetail').textContent = s.logged_in
      ? ((cloud && cloud.detail) ? cloud.detail : 'Logged in as ' + (s.user_email || 'admin')) + ' at ' + s.server_url
      : '';

    if (s.tally.ok === true) pill($('tallyPill'), 'ok', 'Connected');
    else if (s.tally.ok === false) pill($('tallyPill'), 'bad', 'Not connected');
    else pill($('tallyPill'), '', 'Checking');
    $('tallyDetail').textContent = s.tally_host + ':' + s.tally_port + ' — ' + s.tally.detail;

    renderCompanies(s);

    pill($('syncPill'), s.syncing ? 'wait' : '', s.syncing ? 'Syncing' : 'Idle');
    $('lastSync').textContent = when(s.last_sync_at) || 'Never';
    $('nextSync').textContent = s.syncing ? 'Running now' : (when(s.next_sync_at) || 'Not scheduled');
    $('syncBtn').disabled = s.syncing || !s.logged_in;
    $('syncLine').textContent = s.logged_in ? '' : 'Log in to agent.accountant to start syncing.';

    var log = $('log'), atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    var txt = s.logs.join('\\n');
    if (log.textContent !== txt) { log.textContent = txt; if (atEnd) log.scrollTop = log.scrollHeight; }

    show($('notice'), !!s.notice); $('notice').textContent = s.notice || '';
    $('foot').textContent = 'This PC: ' + s.machine_name + '. Syncing continues while this window is closed. Logs: ' + (s.log_dir || '');

    var failed = s.status && s.status.companies.some(function (c) { return !c.ok; });
    if (s.syncing) pill($('overall'), 'wait', 'Syncing');
    else if (!s.logged_in) pill($('overall'), '', 'Log in to start');
    else if (s.tally.ok === false) pill($('overall'), 'bad', 'Tally not connected');
    else if (cloud && cloud.ok === false && cloud.detail) pill($('overall'), 'bad', 'agent.accountant not connected');
    else if (failed) pill($('overall'), 'bad', 'Sync problem');
    else if (s.status) pill($('overall'), 'ok', 'Connected');
    else pill($('overall'), '', 'Ready');
  }

  function refresh() {
    if (gone) return Promise.resolve();
    // The app can be busy for several seconds reading a large Tally answer, so one
    // missed poll means nothing; only a run of them means it has really stopped.
    return fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) { misses = 0; render(s); }, function () {
      if (++misses >= 8) pill($('overall'), 'bad', 'Connector not running');
    });
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); err($('loginErr'), ''); $('loginBtn').disabled = true;
    post('/api/login', { email: $('email').value, password: $('password').value, server_url: $('serverUrl').value })
      .then(function () { $('password').value = ''; }, function (x) { err($('loginErr'), x.message); })
      .then(function () { $('loginBtn').disabled = false; return refresh(); });
  });
  $('logoutBtn').addEventListener('click', function () { post('/api/logout').then(refresh, refresh); });
  $('tallyForm').addEventListener('submit', function (e) {
    e.preventDefault(); err($('tallyErr'), ''); $('tallyBtn').disabled = true; $('tallyBtn').textContent = 'Testing';
    post('/api/tally', { host: $('host').value, port: Number($('port').value) })
      .then(null, function (x) { err($('tallyErr'), x.message); })
      .then(function () { $('tallyBtn').disabled = false; $('tallyBtn').textContent = 'Test and save'; return refresh(); });
  });
  $('interval').addEventListener('change', function () { post('/api/settings', { interval_minutes: Number($('interval').value) }).then(refresh, refresh); });
  $('syncBtn').addEventListener('click', function () { $('syncBtn').disabled = true; post('/api/sync').then(refresh, refresh); });
  $('quitBtn').addEventListener('click', function () {
    if (!confirm('Quit the connector? Tally will stop syncing to agent.accountant until you start it again.')) return;
    gone = true;
    post('/api/quit').then(function () { pill($('overall'), '', 'Stopped'); window.close(); }, function () { gone = false; });
  });

  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>
`;
