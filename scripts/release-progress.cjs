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
const { exec, spawnSync } = require('child_process');
const path = require('path');

const PORT = 8765;
const ROOT = path.resolve(__dirname, '..');
// Generous cap — auto-recovery is allowed to keep trying when each failure
// is a DIFFERENT error (e.g. fix one issue, hit another, fix that, etc.).
// The "same error twice in a row" guard below stops infinite loops when a
// fix actually didn't work, so this number rarely gets reached in practice.
const MAX_RECOVERY = 5;

let recoveryAttempts = 0;
let autoRecover = false;
let recoveryInFlight = false;
let lastFailureSignature = ''; // step name + first error line — to detect repeated failures

let state = {
  version: '',
  startedAt: 0,
  win: { status: 'pending', detail: 'Ожидание…', percent: 0, url: '' },
  mac: { status: 'pending', detail: 'Ожидание тэга…', percent: 0, url: '' },
  site: { status: 'pending', detail: 'Ожидание…', percent: 0, url: 'https://stratamixer.net' },
};

let pollHandle = null;
let serverHandle = null;
let pollConfig = null;
let exitTimer = null;

// ── Public API ─────────────────────────────────────────────────────────────

function start(version, pollOpts, opts = {}) {
  state.version = version;
  state.startedAt = Date.now();
  pollConfig = pollOpts;
  // Auto-recovery is enabled by default — the dashboard attempts to fix
  // known failures (npm lockfile sync, transient CI flakes) without
  // bothering the user. Pass { autoRecover: false } only for diagnostic
  // monitor sessions where you explicitly want to inspect failures by hand.
  autoRecover = opts.autoRecover !== false;

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

    const runUrl = run ? run.html_url : `https://github.com/${sourceOwner}/${sourceRepo}/actions`;
    if (!run) {
      set('mac', { status: 'pending', detail: 'Ожидание запуска CI…', percent: 5, url: runUrl });
    } else if (run.status === 'queued') {
      set('mac', { status: 'building', detail: 'В очереди GitHub Actions…', percent: 10, url: runUrl });
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
      set('mac', { status: 'building', detail, percent, url: runUrl });
    } else if (run.status === 'completed') {
      if (run.conclusion !== 'success') {
        // Find the failed step name for diagnostics + recovery decisions.
        let failedStepName = '';
        try {
          const jobs = (await ghFetch(
            `https://api.github.com/repos/${sourceOwner}/${sourceRepo}/actions/runs/${run.id}/jobs`
          )).jobs || [];
          const failed = jobs[0]?.steps?.find(s => s.conclusion === 'failure');
          if (failed) failedStepName = failed.name;
        } catch {}

        // Try auto-recovery first if enabled. Stops if:
        //   (a) MAX_RECOVERY attempts have happened, OR
        //   (b) Same error signature 2 times in a row — fix didn't work.
        const signature = failedStepName + '|' + (run.id ? '' : '');
        const sameAsLast = lastFailureSignature && lastFailureSignature === signature;
        if (autoRecover && !recoveryInFlight && recoveryAttempts < MAX_RECOVERY && !sameAsLast) {
          recoveryInFlight = true;
          lastFailureSignature = signature;
          const fix = await attemptRecovery(run, failedStepName);
          recoveryInFlight = false;
          if (fix.ok) {
            // Wait a beat so GitHub registers the new tag push, then poll again.
            set('mac', {
              status: 'building',
              detail: `🔧 Авто-фикс (${recoveryAttempts}/${MAX_RECOVERY}): ${fix.description}`,
              percent: 5,
              url: runUrl,
            });
            return;
          }
          // Fix attempt failed — fall through to failed state below.
          set('mac', {
            status: 'failed',
            detail: `Авто-фикс не помог: ${fix.reason}. Упал шаг: "${failedStepName}"`,
            percent: 100,
            url: runUrl,
          });
          shutdownIfDone();
          return;
        }
        if (sameAsLast) {
          set('mac', {
            status: 'failed',
            detail: `Та же ошибка 2 раза подряд (шаг: "${failedStepName}") — авто-фикс не помог. Нужна ручная починка.`,
            percent: 100,
            url: runUrl,
          });
          shutdownIfDone();
          return;
        }

        set('mac', {
          status: 'failed',
          detail: `CI: ${run.conclusion}${failedStepName ? ` (упал шаг: "${failedStepName}")` : ''}`,
          percent: 100,
          url: runUrl,
        });
      } else {
        // Verify Mac .dmg is actually in the release assets.
        try {
          const release = await ghFetch(
            `https://api.github.com/repos/${releasesOwner}/${releasesRepo}/releases/tags/${tag}`
          );
          const macAsset = (release.assets || []).find(a => /\.dmg$/i.test(a.name));
          if (macAsset) {
            set('mac', { status: 'done', detail: `${macAsset.name} загружен`, percent: 100, url: release.html_url });
          } else {
            set('mac', { status: 'failed', detail: 'CI зелёный, но .dmg нет в релизе (вероятно конфликт типов publish)', percent: 100, url: runUrl });
          }
        } catch (e) {
          set('mac', { status: 'failed', detail: 'Не удалось прочитать релиз: ' + e.message, percent: 100, url: runUrl });
        }
      }
      shutdownIfDone();
    }
  } catch (e) {
    // Don't crash on transient API errors; just keep the previous state.
  }
}

// ── Auto-recovery ─────────────────────────────────────────────────────────
// When Mac CI fails, this is called once per attempt. It looks at which
// step failed, applies a known fix if it can, then force-retags so the
// workflow runs again. If the fix needs a code change, it's committed +
// pushed (always in a small, traceable commit named "fix: auto-…").

function gitRun(args, opts = {}) {
  return spawnSync('git', args, { cwd: ROOT, stdio: 'pipe', shell: true, ...opts });
}
function npmRun(args, opts = {}) {
  return spawnSync('npm', args, { cwd: ROOT, stdio: 'pipe', shell: true, ...opts });
}

async function attemptRecovery(run, failedStepName) {
  recoveryAttempts++;
  const tag = pollConfig.tag;

  // Pattern 1: package-lock.json out of sync with package.json
  //   Symptom: install step fails with "npm error code EUSAGE … `npm ci` can
  //   only install packages when your package.json and package-lock.json …"
  //   Fix: run `npm install` locally, commit + push the updated lockfile.
  if (/install|dependencies|deps/i.test(failedStepName)) {
    console.log('\n🔧 Auto-fix: syncing package-lock.json…');
    const inst = npmRun(['install']);
    if (inst.status !== 0) {
      return { ok: false, reason: 'npm install failed' };
    }
    // Commit the lockfile (and only the lockfile) if it changed.
    const diff = gitRun(['diff', '--quiet', 'package-lock.json']);
    if (diff.status !== 0) {
      gitRun(['add', 'package-lock.json']);
      const commit = gitRun(['commit', '-m', 'fix: auto-sync package-lock.json (release-doctor)']);
      if (commit.status !== 0) {
        return { ok: false, reason: 'git commit failed' };
      }
      const push = gitRun(['push', 'origin', 'main']);
      if (push.status !== 0) {
        return { ok: false, reason: 'git push failed' };
      }
    }
    return retagAndPush(tag, `auto-fix: package-lock sync`);
  }

  // Pattern 2: generic / transient — just retry. GitHub Actions network
  // hiccups, ffmpeg download flake, etc. We don't change any code, just
  // re-tag so the workflow runs again.
  console.log('\n🔄 Auto-retry (no code change) for transient CI flake');
  return retagAndPush(tag, `auto-retry attempt ${recoveryAttempts}`);
}

function retagAndPush(tag, why) {
  console.log(`📌 Re-tagging ${tag} (${why})…`);
  // Delete local + remote tag, recreate, push.
  gitRun(['tag', '-d', tag]);
  gitRun(['push', 'origin', `:refs/tags/${tag}`]);
  const create = gitRun(['tag', '-a', tag, '-m', `${tag} ${why}`]);
  if (create.status !== 0) {
    return { ok: false, reason: 'git tag failed' };
  }
  const push = gitRun(['push', 'origin', tag]);
  if (push.status !== 0) {
    return { ok: false, reason: 'git push tag failed' };
  }
  return { ok: true, description: why };
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
  /* Global status banner — shown at top of page when any target fails or
     when all targets reach done. Hidden by default. */
  .banner{padding:14px 18px;border-radius:14px;margin-bottom:16px;display:none;animation:bannerIn .35s cubic-bezier(.2,.9,.25,1)}
  .banner.show{display:flex;align-items:center;gap:12px}
  .banner.success{background:linear-gradient(135deg,#163828,#194b34);border:1px solid rgba(64,210,140,.45)}
  .banner.error{background:linear-gradient(135deg,#3a1418,#4a1a20);border:1px solid rgba(255,80,80,.55)}
  .banner-icon{font-size:22px;flex-shrink:0}
  .banner-content{flex:1;min-width:0}
  .banner-title{font-size:14px;font-weight:800;margin-bottom:2px}
  .banner-detail{font-size:12px;color:#cbd0d8;line-height:1.45}
  .banner.error .banner-title{color:#ffafaf}
  .banner.success .banner-title{color:#9eecbe}
  @keyframes bannerIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
  /* Per-card clickable link to the relevant GitHub/Site URL. */
  .link{display:inline-flex;align-items:center;gap:5px;margin-top:8px;font-size:11.5px;color:#7a90b4;text-decoration:none;transition:color .15s}
  .link:hover{color:#a5c0e6;text-decoration:underline}
  .link.failed-link{color:#ff8888}
  .link.failed-link:hover{color:#ffaaaa}
</style>
</head>
<body>
<div class="wrap">
  <h1>🚀 Release <span class="ver" id="ver">…</span></h1>
  <div class="sub">Live статус сборки и публикации. Окно закроется автоматически когда всё готово.</div>

  <div id="banner" class="banner">
    <div class="banner-icon" id="banner-icon">⚠️</div>
    <div class="banner-content">
      <div class="banner-title" id="banner-title"></div>
      <div class="banner-detail" id="banner-detail"></div>
    </div>
  </div>

  <div id="card-win" class="card pending">
    <div class="head">
      <div class="title"><span class="icon">🪟</span> Windows</div>
      <div class="badge" id="badge-win">PENDING</div>
    </div>
    <div class="bar"><i id="bar-win" style="width:0%"></i></div>
    <div class="detail" id="detail-win">—</div>
    <a class="link" id="link-win" target="_blank" style="display:none"></a>
  </div>

  <div id="card-mac" class="card pending">
    <div class="head">
      <div class="title"><span class="icon">🍎</span> macOS (GitHub Actions)</div>
      <div class="badge" id="badge-mac">PENDING</div>
    </div>
    <div class="bar"><i id="bar-mac" style="width:0%"></i></div>
    <div class="detail" id="detail-mac">—</div>
    <a class="link" id="link-mac" target="_blank" style="display:none"></a>
  </div>

  <div id="card-site" class="card pending">
    <div class="head">
      <div class="title"><span class="icon">🌐</span> Site (Cloudflare Pages)</div>
      <div class="badge" id="badge-site">PENDING</div>
    </div>
    <div class="bar"><i id="bar-site" style="width:0%"></i></div>
    <div class="detail" id="detail-site">—</div>
    <a class="link" id="link-site" target="_blank" style="display:none"></a>
  </div>

  <div class="footer">
    <div class="summary"><b id="done-count">0</b>/3 готово</div>
    <div class="elapsed" id="elapsed">0:00</div>
  </div>
</div>

<script>
const TARGETS = ['win', 'mac', 'site'];
const TARGET_LABEL = { win: 'Windows', mac: 'macOS', site: 'Site' };
const LINK_LABEL = { win: 'Открыть релиз на GitHub →', mac: 'Открыть лог CI →', site: 'Открыть stratamixer.net →' };
const BADGE = { pending: 'PENDING', building: 'BUILDING', updating: 'UPDATING', publishing: 'PUBLISHING', deploying: 'DEPLOYING', done: '✓ DONE', failed: '✗ FAILED' };
let startMs = 0;
let lastStatus = { win: null, mac: null, site: null };
let notifGranted = false;

// Ask for desktop notification permission once on load.
if ('Notification' in window) {
  if (Notification.permission === 'granted') notifGranted = true;
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { notifGranted = (p === 'granted'); });
  }
}

function fmt(sec) {
  const m = Math.floor(sec / 60); const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function beep(success) {
  // Tiny WebAudio beep — sine wave 600ms. No external sound file.
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.value = success ? 880 : 220;
    g.gain.value = 0.12;
    o.start();
    if (success) {
      // Two ascending tones for success
      setTimeout(() => { o.frequency.value = 1320; }, 180);
      setTimeout(() => { o.stop(); ctx.close(); }, 480);
    } else {
      // Two descending tones for failure
      setTimeout(() => { o.frequency.value = 160; }, 240);
      setTimeout(() => { o.stop(); ctx.close(); }, 600);
    }
  } catch {}
}

function notify(title, body) {
  if (notifGranted) {
    try { new Notification(title, { body, icon: undefined }); } catch {}
  }
}

function applyState(s) {
  document.getElementById('ver').textContent = 'v' + s.version;
  if (!startMs) startMs = s.startedAt;
  let done = 0, failedTargets = [];
  for (const t of TARGETS) {
    const st = s[t];
    const card = document.getElementById('card-' + t);
    const badge = document.getElementById('badge-' + t);
    const bar = document.getElementById('bar-' + t);
    const detail = document.getElementById('detail-' + t);
    const link = document.getElementById('link-' + t);
    card.className = 'card ' + (st.status === 'done' ? 'done' : st.status === 'failed' ? 'failed' : st.status === 'pending' ? 'pending' : 'active');
    badge.className = 'badge ' + (st.status === 'done' ? 'done' : st.status === 'failed' ? 'failed' : st.status === 'pending' ? '' : 'active');
    badge.innerHTML = (st.status !== 'pending' && st.status !== 'done' && st.status !== 'failed' ? '<span class="pulse"></span>' : '') + (BADGE[st.status] || st.status.toUpperCase());
    bar.style.width = (st.percent || 0) + '%';
    detail.textContent = st.detail || '—';

    if (st.url) {
      link.style.display = 'inline-flex';
      link.href = st.url;
      link.textContent = LINK_LABEL[t] || 'Открыть →';
      link.className = 'link' + (st.status === 'failed' ? ' failed-link' : '');
    } else {
      link.style.display = 'none';
    }

    if (st.status === 'done' || st.status === 'failed') done++;
    if (st.status === 'failed') failedTargets.push(TARGET_LABEL[t]);

    // Fire notification + sound when a target transitions to a terminal state.
    if (lastStatus[t] !== st.status) {
      if (st.status === 'failed') {
        notify('Strata Mixer release: ' + TARGET_LABEL[t] + ' упал', st.detail || '');
        beep(false);
      } else if (st.status === 'done' && lastStatus[t] !== null) {
        // Don't beep for "already done at start" states — only real transitions.
        notify('Strata Mixer release: ' + TARGET_LABEL[t] + ' готов', st.detail || '');
        beep(true);
      }
      lastStatus[t] = st.status;
    }
  }
  document.getElementById('done-count').textContent = done;
  if (startMs) document.getElementById('elapsed').textContent = fmt(Math.floor((Date.now() - startMs) / 1000));

  // Top banner: any failure → red. All done → green. Else hidden.
  const banner = document.getElementById('banner');
  const allDone = TARGETS.every(t => s[t].status === 'done');
  if (failedTargets.length) {
    banner.className = 'banner show error';
    document.getElementById('banner-icon').textContent = '⚠️';
    document.getElementById('banner-title').textContent = 'Падение сборки: ' + failedTargets.join(', ');
    document.getElementById('banner-detail').textContent = 'Открой ссылку в карточке чтобы посмотреть лог. Скажи Claude чтобы пофиксил и перезапустил CI.';
    document.title = '✗ Release failed';
  } else if (allDone) {
    banner.className = 'banner show success';
    document.getElementById('banner-icon').textContent = '✅';
    document.getElementById('banner-title').textContent = 'Релиз v' + s.version + ' опубликован';
    document.getElementById('banner-detail').textContent = 'Все 3 цели готовы. Окно закроется автоматически через несколько секунд.';
    document.title = '✓ Release done';
  } else {
    banner.className = 'banner';
    document.title = '🚀 Release v' + s.version + ' (' + done + '/3)';
  }
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
