/**
 * Release progress dashboard — local HTTP server + auto-opened browser UI
 * showing real-time status of the 3 release targets:
 *   1. Windows installer (local build → GitHub release)
 *   2. macOS .dmg files (GitHub Actions CI in the cloud)
 *   3. Marketing site (Cloudflare Pages deploy)
 *
 * Imported by release.cjs. The script keeps the dashboard server alive
 * until all three targets reach a terminal state (done / failed), then
 * exits cleanly so the parent process can finish.
 *
 * No external deps — pure node http + fetch.
 */

const http = require('http');
const { exec } = require('child_process');

const PORT = 8765;

let state = {
  version: '',
  startedAt: 0,
  win: { status: 'pending', detail: 'Ожидание…', percent: 0 },
  mac: { status: 'pending', detail: 'Ожидание тэга…', percent: 0 },
  site: { status: 'pending', detail: 'Ожидание…', percent: 0 },
};

let pollHandle = null;
let serverHandle = null;
let pollConfig = null;
let exitTimer = null;

// ── Public API ─────────────────────────────────────────────────────────────

function start(version, pollOpts) {
  state.version = version;
  state.startedAt = Date.now();
  pollConfig = pollOpts;

  serverHandle = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtml());
    } else if (req.url === '/api/state') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(state));
    } else {
      res.writeHead(404); res.end();
    }
  });

  serverHandle.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🖥  Dashboard: ${url}`);
    openBrowser(url);
  });

  // Start polling Mac CI in the background.
  if (pollConfig) {
    pollMacCI();                         // first tick immediately
    pollHandle = setInterval(pollMacCI, 8000);
  }
}

function set(target, patch) {
  state[target] = { ...state[target], ...patch };
}

function shutdownIfDone() {
  const allDone = ['win', 'mac', 'site'].every(t =>
    state[t].status === 'done' || state[t].status === 'failed'
  );
  if (!allDone) return false;
  if (exitTimer) return true;
  // Keep dashboard alive 8 sec so the user sees the final state.
  exitTimer = setTimeout(() => {
    if (pollHandle) clearInterval(pollHandle);
    if (serverHandle) serverHandle.close();
    process.exit(0);
  }, 8000);
  return true;
}

// Force-shutdown — used if release.cjs explicitly wants to stop early.
function stop() {
  if (pollHandle) clearInterval(pollHandle);
  if (serverHandle) serverHandle.close();
}

// ── Internals ──────────────────────────────────────────────────────────────

function openBrowser(url) {
  try {
    if (process.platform === 'win32') exec(`start "" "${url}"`);
    else if (process.platform === 'darwin') exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
  } catch {}
}

async function ghFetch(url) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'strata-release-progress',
  };
  if (process.env.GH_TOKEN) headers['Authorization'] = 'Bearer ' + process.env.GH_TOKEN;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function pollMacCI() {
  if (!pollConfig) return;
  const { sourceOwner, sourceRepo, releasesOwner, releasesRepo, tag } = pollConfig;
  try {
    // 1) Find the workflow run for the tag.
    const runsRes = await ghFetch(
      `https://api.github.com/repos/${sourceOwner}/${sourceRepo}/actions/runs?per_page=5`
    );
    const run = (runsRes.workflow_runs || []).find(r => r.head_branch === tag) || null;

    if (!run) {
      set('mac', { status: 'pending', detail: 'Ожидание запуска CI…', percent: 5 });
    } else if (run.status === 'queued') {
      set('mac', { status: 'building', detail: 'В очереди GitHub Actions…', percent: 10 });
    } else if (run.status === 'in_progress') {
      // Estimate progress from job steps.
      let percent = 30;
      let detail = 'Сборка в облаке…';
      try {
        const jobs = (await ghFetch(
          `https://api.github.com/repos/${sourceOwner}/${sourceRepo}/actions/runs/${run.id}/jobs`
        )).jobs || [];
        const job = jobs[0];
        if (job && job.steps?.length) {
          const total = job.steps.length;
          const finished = job.steps.filter(s => s.conclusion).length;
          percent = Math.min(85, 30 + Math.round((finished / total) * 50));
          const cur = job.steps.find(s => !s.conclusion);
          if (cur) detail = `Шаг: ${cur.name}`;
        }
      } catch {}
      set('mac', { status: 'building', detail, percent });
    } else if (run.status === 'completed') {
      if (run.conclusion !== 'success') {
        set('mac', { status: 'failed', detail: `CI: ${run.conclusion}`, percent: 100 });
      } else {
        // Verify Mac .dmg is actually in the release assets.
        try {
          const release = await ghFetch(
            `https://api.github.com/repos/${releasesOwner}/${releasesRepo}/releases/tags/${tag}`
          );
          const macAsset = (release.assets || []).find(a => /\.dmg$/i.test(a.name));
          if (macAsset) {
            set('mac', { status: 'done', detail: `${macAsset.name} загружен`, percent: 100 });
          } else {
            set('mac', { status: 'failed', detail: 'CI зелёный, но .dmg нет в релизе', percent: 100 });
          }
        } catch (e) {
          set('mac', { status: 'failed', detail: 'Не удалось прочитать релиз: ' + e.message, percent: 100 });
        }
      }
      shutdownIfDone();
    }
  } catch (e) {
    // Don't crash on transient API errors; just keep the previous state.
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Strata Mixer — Release Progress</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(180deg,#0d0e14,#15171f);color:#e8e9ed;min-height:100vh;padding:40px 20px;display:flex;justify-content:center}
  .wrap{width:100%;max-width:560px}
  h1{font-size:22px;font-weight:800;letter-spacing:.01em;margin-bottom:6px}
  h1 .ver{background:linear-gradient(135deg,#ff8a00,#ff4e35);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .sub{color:#8a90a0;font-size:13px;margin-bottom:24px}
  .card{padding:18px 20px;border-radius:16px;background:linear-gradient(180deg,#1c1e26,#15161c);border:1px solid rgba(255,255,255,.06);box-shadow:0 8px 24px rgba(0,0,0,.3);margin-bottom:14px;transition:border-color .3s}
  .card.done{border-color:rgba(64,210,140,.4)}
  .card.failed{border-color:rgba(255,80,80,.45)}
  .card.active{border-color:rgba(255,138,0,.4);box-shadow:0 8px 24px rgba(0,0,0,.3),0 0 16px rgba(255,138,0,.12)}
  .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .title{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:800}
  .badge{font-size:11px;font-weight:700;color:#8a90a0;text-transform:uppercase;letter-spacing:.06em}
  .badge.done{color:#3ddc91}
  .badge.failed{color:#ff6766}
  .badge.active{color:#ff8a00}
  .bar{height:8px;border-radius:99px;background:rgba(255,255,255,.05);overflow:hidden;margin-bottom:10px}
  .bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#ff8a00,#ff4e35);transition:width .6s cubic-bezier(.2,.9,.25,1)}
  .card.done .bar i{background:linear-gradient(90deg,#3ddc91,#28c8b0)}
  .card.failed .bar i{background:linear-gradient(90deg,#ff6766,#e23f3f)}
  .detail{font-size:12px;color:#8a90a0;line-height:1.5}
  .icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.04);font-size:14px}
  .footer{display:flex;justify-content:space-between;align-items:center;margin-top:18px;padding:14px 18px;border-radius:12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04)}
  .summary{font-size:13px;color:#cbd0d8}
  .summary b{color:#fff}
  .elapsed{font-size:12px;color:#8a90a0;font-variant-numeric:tabular-nums}
  .pulse{display:inline-block;width:7px;height:7px;border-radius:99px;background:#ff8a00;margin-right:6px;animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.3}}
  .pending .badge{color:#5a6071}
</style>
</head>
<body>
<div class="wrap">
  <h1>🚀 Release <span class="ver" id="ver">…</span></h1>
  <div class="sub">Live статус сборки и публикации. Окно закроется автоматически когда всё готово.</div>

  <div id="card-win" class="card pending">
    <div class="head">
      <div class="title"><span class="icon">🪟</span> Windows</div>
      <div class="badge" id="badge-win">PENDING</div>
    </div>
    <div class="bar"><i id="bar-win" style="width:0%"></i></div>
    <div class="detail" id="detail-win">—</div>
  </div>

  <div id="card-mac" class="card pending">
    <div class="head">
      <div class="title"><span class="icon">🍎</span> macOS (GitHub Actions)</div>
      <div class="badge" id="badge-mac">PENDING</div>
    </div>
    <div class="bar"><i id="bar-mac" style="width:0%"></i></div>
    <div class="detail" id="detail-mac">—</div>
  </div>

  <div id="card-site" class="card pending">
    <div class="head">
      <div class="title"><span class="icon">🌐</span> Site (Cloudflare Pages)</div>
      <div class="badge" id="badge-site">PENDING</div>
    </div>
    <div class="bar"><i id="bar-site" style="width:0%"></i></div>
    <div class="detail" id="detail-site">—</div>
  </div>

  <div class="footer">
    <div class="summary"><b id="done-count">0</b>/3 готово</div>
    <div class="elapsed" id="elapsed">0:00</div>
  </div>
</div>

<script>
const TARGETS = ['win', 'mac', 'site'];
const BADGE = { pending: 'PENDING', building: 'BUILDING', updating: 'UPDATING', publishing: 'PUBLISHING', deploying: 'DEPLOYING', done: '✓ DONE', failed: '✗ FAILED' };
let startMs = 0;

function fmt(sec) {
  const m = Math.floor(sec / 60); const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function applyState(s) {
  document.getElementById('ver').textContent = 'v' + s.version;
  if (!startMs) startMs = s.startedAt;
  let done = 0;
  for (const t of TARGETS) {
    const st = s[t];
    const card = document.getElementById('card-' + t);
    const badge = document.getElementById('badge-' + t);
    const bar = document.getElementById('bar-' + t);
    const detail = document.getElementById('detail-' + t);
    card.className = 'card ' + (st.status === 'done' ? 'done' : st.status === 'failed' ? 'failed' : st.status === 'pending' ? 'pending' : 'active');
    badge.className = 'badge ' + (st.status === 'done' ? 'done' : st.status === 'failed' ? 'failed' : st.status === 'pending' ? '' : 'active');
    badge.innerHTML = (st.status !== 'pending' && st.status !== 'done' && st.status !== 'failed' ? '<span class="pulse"></span>' : '') + (BADGE[st.status] || st.status.toUpperCase());
    bar.style.width = (st.percent || 0) + '%';
    detail.textContent = st.detail || '—';
    if (st.status === 'done' || st.status === 'failed') done++;
  }
  document.getElementById('done-count').textContent = done;
  if (startMs) document.getElementById('elapsed').textContent = fmt(Math.floor((Date.now() - startMs) / 1000));
}

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (r.ok) applyState(await r.json());
  } catch {}
}
setInterval(poll, 1500);
setInterval(() => { if (startMs) document.getElementById('elapsed').textContent = fmt(Math.floor((Date.now() - startMs) / 1000)); }, 1000);
poll();
</script>
</body>
</html>`;
}

module.exports = { start, set, shutdownIfDone, stop };
