const { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, nativeImage, screen, Notification } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const archiver = require('archiver');
const extractZip = require('extract-zip');

// Volume taper for exports: matches the renderer's volumeCurve. Piecewise —
// fine quiet control below 50 % (5 % ≈ −46 dB, 1 % ≈ −74 dB), linear from
// 50 – 100 %, cubic boost above 100 %. The master loudnorm downstream keeps
// the overall export at -16 LUFS so quieting one layer doesn't drop the
// whole mix's perceived level.
function volumeCurve(percent) {
  const v = Math.max(0, Number(percent) || 0) / 100;
  if (v <= 0.5) return 2 * v * v;
  if (v <= 1) return v;
  return v * v * v;
}

let mainWindow = null;
let splashWindow = null;
let splashShownAt = 0;
const activeProcs = new Set(); // Set of all in-flight ffmpeg processes — Stop kills the whole set, not just the last spawned one.
let stopRequested = false;
let tray = null;
let isQuitting = false;
// Renderer-reported dirty flag — set via 'project:set-dirty' IPC. Used by
// before-quit and update:install to decide whether to prompt for a save.
let rendererDirty = false;
let _quitCleared = false;
let savePromptInFlight = false;
// Track every in-flight tmp file (reverse pre-renders, drawtext temp .txt
// files, etc.) so app quit cleans them up even if individual flows leaked.
const liveTmpFiles = new Set();

// Single-instance lock: relaunching while minimized to tray just reveals
// the existing window instead of spawning a duplicate process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// ── .smproj file-open handling ─────────────────────────────────────────────
// When the user double-clicks a project file in Explorer/Finder, the OS
// either launches us with the path as an argv entry (Windows / Linux) or
// fires the `open-file` event (macOS). We stash the path here and push it
// into the renderer once the main window's webContents finishes loading.
let pendingProjectFile = null;
function extractProjectPath(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    if (typeof a === 'string' && /\.smproj$/i.test(a)) {
      try { if (fs.existsSync(a)) return a; } catch {}
    }
  }
  return null;
}
function dispatchPendingProject() {
  if (!pendingProjectFile || !mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const send = async () => {
    if (!pendingProjectFile) return;
    const filePath = pendingProjectFile;
    pendingProjectFile = null;
    try {
      // Shared loader: ZIP bundle (extract + rewrite) or legacy plain JSON.
      const res = await loadProjectFile(filePath);
      wc.send('project:open-from-file', res);
    } catch (e) {
      wc.send('project:open-from-file', { ok: false, error: String(e.message || e) });
    }
  };
  if (wc.isLoading()) wc.once('did-finish-load', send);
  else send();
}
// Capture argv at startup (first launch from Explorer with a .smproj path).
pendingProjectFile = extractProjectPath(process.argv);
// macOS opens files via this event — fires BEFORE whenReady() resolves when
// the app was launched by a double-click, and afterwards for subsequent ones.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (filePath && /\.smproj$/i.test(filePath)) {
    pendingProjectFile = filePath;
    dispatchPendingProject();
  }
});

// Persisted UI theme — written by the renderer so the splash window (which
// shows before the app loads) can pick the matching light/dark cube.
function themeFilePath() {
  try { return path.join(app.getPath('userData'), 'theme'); } catch { return null; }
}
function readTheme() {
  try {
    const p = themeFilePath();
    return p && fs.readFileSync(p, 'utf8').trim() === 'light' ? 'light' : 'dark';
  } catch { return 'dark'; }
}
function writeTheme(theme) {
  try {
    const p = themeFilePath();
    if (p) fs.writeFileSync(p, theme === 'light' ? 'light' : 'dark', 'utf8');
  } catch {}
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);

function resourcePath(...parts) {
  if (app.isPackaged) return path.join(process.resourcesPath, ...parts);
  return path.join(__dirname, '..', ...parts);
}

function appPath(...parts) {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app', ...parts);
  return path.join(__dirname, '..', ...parts);
}

// Any path that points INSIDE app.asar must be rewritten to app.asar.unpacked
// before being handed to child_process.spawn — Electron's asar fs hooks make
// fs.existsSync() return true for files inside the archive, but the OS cannot
// execute a binary that doesn't physically exist on disk. This was the cause
// of the ENOENT users hit after upgrading to the electron-builder packaging.
function unpackAsar(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.includes('app.asar.unpacked')) return p;
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function findFfmpeg() {
  // On macOS we ship both arm64 and x64 binaries side-by-side so a single
  // universal .dmg works on Intel + Apple Silicon. Pick the one for the
  // current process arch at runtime. On Windows / Linux we ship a single
  // binary named `ffmpeg.exe` / `ffmpeg` (one .exe / one Linux build).
  const macBin = `ffmpeg-darwin-${process.arch}`;
  let ffmpegStatic = '';
  try { ffmpegStatic = require('ffmpeg-static') || ''; } catch {}

  const candidates = [
    process.platform === 'darwin' ? appPath('bin', macBin) : null,
    appPath('bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    resourcePath('ffmpeg.exe'),
    resourcePath('ffmpeg'),
    process.platform === 'darwin' ? resourcePath(macBin) : null,
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ffmpegStatic
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const c = unpackAsar(raw);
    // existsSync on an asar.unpacked path checks the real filesystem, which is
    // exactly what spawn() will hit — so this stays honest.
    if (fs.existsSync(c)) {
      if (!findFfmpeg._loggedPath || findFfmpeg._loggedPath !== c) {
        console.log('[strata] ffmpeg resolved to:', c);
        findFfmpeg._loggedPath = c;
      }
      return c;
    }
  }
  console.warn('[strata] ffmpeg NOT found on disk — falling back to PATH lookup (will likely fail with ENOENT)');
  return 'ffmpeg';
}


const packageInfo = require('../package.json');
const CURRENT_APP_VERSION = packageInfo.updateVersion || packageInfo.version || '1.4.0';
const CURRENT_DISPLAY_VERSION = packageInfo.publicVersion || `v${CURRENT_APP_VERSION}`;
const UPDATE_VERSION_URL = 'https://stratamixer.net/version.json';
const UPDATE_CHECK_TIMEOUT_MS = 12000;

function normalizeVersion(value) {
  const raw = String(value || '').trim().toLowerCase()
    .replace(/^v/, '')
    .replace(/\s+/g, '')
    .replace(/_/g, '.')
    .replace(/beta/g, '-beta');
  const match = raw.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [
    Number(match[1] || 0),
    Number(match[2] || 0),
    Number(match[3] || 0)
  ];
}

function isRemoteNewerVersion(remoteVersion, currentVersion) {
  const remote = normalizeVersion(remoteVersion);
  const current = normalizeVersion(currentVersion);
  for (let i = 0; i < 3; i += 1) {
    if (remote[i] > current[i]) return true;
    if (remote[i] < current[i]) return false;
  }
  return false;
}

function getUpdateUrl(data) {
  if (process.platform === 'darwin') {
    return data?.macUrl || data?.macos?.url || 'https://stratamixer.net/download/';
  }
  return data?.windowsUrl || data?.windows?.url || 'https://stratamixer.net/download/';
}

async function fetchVersionJson() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`${UPDATE_VERSION_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function showRequiredUpdateDialog(data) {
  const updateUrl = getUpdateUrl(data);
  const displayVersion = data?.displayVersion || data?.latest || 'новая версия';
  const notes = data?.notes ? `\n\nЧто изменилось:\n${data.notes}` : '';

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Доступно обязательное обновление',
    message: `Доступна ${displayVersion}`,
    detail:
      `Установленная версия: ${CURRENT_DISPLAY_VERSION}\n` +
      `Новая версия: ${data?.latest || displayVersion}\n\n` +
      'Эта версия Strata Mixer больше не может использоваться. Чтобы продолжить работу, скачай и установи обновление.' +
      notes,
    buttons: ['Скачать обновление', 'Закрыть программу'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  if (result.response === 0) {
    await shell.openExternal(updateUrl);
  }
}

async function showUpdateCheckFailedDialog(error) {
  await dialog.showMessageBox({
    type: 'error',
    title: 'Проверка обновлений',
    message: 'Не удалось проверить актуальную версию Strata Mixer.',
    detail:
      'Для запуска программы нужна проверка обновлений через интернет.\n\n' +
      'Проверь подключение к интернету и попробуй открыть программу снова.\n\n' +
      `Техническая ошибка: ${error?.message || String(error || 'unknown')}`,
    buttons: ['Закрыть программу'],
    defaultId: 0,
    noLink: true
  });
}


function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let updateWindow = null;
let updateWindowCanClose = false;

function createUpdateWindow(data) {
  closeSplash();
  updateWindowCanClose = false;
  const displayVersion = escapeHtml(data?.displayVersion || data?.latest || 'новая версия');
  updateWindow = new BrowserWindow({
    width: 520,
    height: 330,
    minWidth: 520,
    minHeight: 330,
    maxWidth: 620,
    maxHeight: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Обновление Strata Mixer',
    autoHideMenuBar: true,
    backgroundColor: '#060913',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  updateWindow.on('close', (event) => {
    if (!updateWindowCanClose) {
      event.preventDefault();
      dialog.showMessageBox(updateWindow, {
        type: 'info',
        title: 'Обновление обязательно',
        message: 'Чтобы закрыть обновление, закрой установщик после его запуска или завершите программу.',
        buttons: ['Понятно'],
        noLink: true
      });
    }
  });

  updateWindow.on('closed', () => {
    updateWindow = null;
  });

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Обновление Strata Mixer</title>
<style>
:root{font-family:Inter,Segoe UI,Arial,sans-serif;background:#060913;color:#f6f8ff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 78% 10%,rgba(163,60,255,.18),transparent 32%),radial-gradient(circle at 18% 0%,rgba(255,138,0,.14),transparent 34%),#060913}
.card{width:100%;height:100%;padding:28px;display:flex;flex-direction:column;justify-content:center}
.badge{width:max-content;padding:7px 10px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.06);color:#bfc8dc;font-size:12px;font-weight:800;margin-bottom:18px}
h1{font-size:26px;line-height:1.05;letter-spacing:-.05em;margin:0 0 10px}
p{color:#aeb8ca;line-height:1.5;margin:0 0 22px;font-size:14px}
.progress{height:16px;border-radius:999px;background:#0b1423;border:1px solid rgba(126,146,189,.25);overflow:hidden}
.bar{height:100%;width:0;background:linear-gradient(90deg,#ff8a00,#ff4e35,#d33ee0,#8f38ff);box-shadow:0 0 22px rgba(211,62,224,.55);border-radius:999px;transition:width .2s ease}
.meta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;color:#8e99af;font-size:12px;font-weight:800}
.small{margin-top:18px;font-size:12px;color:#7f8ba0}
</style>
</head>
<body>
<div class="card">
  <div class="badge">Strata Mixer · обязательное обновление</div>
  <h1 id="title">Доступна ${displayVersion}</h1>
  <p id="detail">Скачиваем обновление. После загрузки запустится установщик.</p>
  <div class="progress"><div id="bar" class="bar"></div></div>
  <div class="meta"><span id="status">Подготовка...</span><span id="percent">0%</span></div>
  <div class="small">Не закрывай окно до запуска установщика.</div>
</div>
<script>
window.setUpdateStatus = function(payload){
  const p = payload || {};
  document.getElementById('title').textContent = p.title || 'Обновление Strata Mixer';
  document.getElementById('detail').textContent = p.detail || '';
  document.getElementById('status').textContent = p.status || '';
  const percent = Math.max(0, Math.min(100, Number(p.percent || 0)));
  document.getElementById('bar').style.width = percent + '%';
  document.getElementById('percent').textContent = Math.round(percent) + '%';
};
</script>
</body>
</html>`;

  updateWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  updateWindow.once('ready-to-show', () => updateWindow?.show());
  return updateWindow;
}

function setUpdateWindowStatus(payload) {
  if (!updateWindow || updateWindow.isDestroyed()) return;
  const safe = JSON.stringify(payload || {});
  updateWindow.webContents.executeJavaScript(`window.setUpdateStatus(${safe})`).catch(() => {});
  if (typeof payload?.percent === 'number') {
    updateWindow.setProgressBar(Math.max(0, Math.min(1, payload.percent / 100)));
  }
}

function getInstallerFileName(url) {
  try {
    const u = new URL(url);
    const base = path.basename(decodeURIComponent(u.pathname));
    if (base && /\.exe$/i.test(base)) return base;
  } catch {}
  return 'StrataMixer_Update.exe';
}

async function downloadUpdateInstaller(url, onProgress) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('Некорректная ссылка обновления.');
  }

  const updatesDir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(updatesDir, { recursive: true });

  const fileName = getInstallerFileName(url);
  const outPath = path.join(updatesDir, fileName);
  const tmpPath = outPath + '.download';

  fs.rmSync(tmpPath, { force: true });
  fs.rmSync(outPath, { force: true });

  const controller = new AbortController();
  // INACTIVITY timeout, reset on every received chunk — NOT an absolute cap.
  // The old `setTimeout(abort, 10min)` was a hard wall: a big (.dmg ≈300MB)
  // download on a slow/VPN link reached only ~60-70% by the 10-min mark, got
  // aborted, and fell back to the browser. Now only a genuine stall (no bytes
  // for IDLE_MS) aborts; a slow-but-steady download runs to completion.
  const IDLE_MS = 90 * 1000;
  let idleTimer = setTimeout(() => controller.abort(), IDLE_MS);
  const kickIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), IDLE_MS); };

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'accept': 'application/octet-stream,*/*'
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка скачивания: HTTP ${response.status}`);
    }

    const total = Number(response.headers.get('content-length') || 0);
    const reader = response.body?.getReader?.();
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, outPath);
      onProgress?.(100, buffer.length, buffer.length);
      return outPath;
    }

    const file = fs.createWriteStream(tmpPath);
    let downloaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        kickIdle();   // got data → push the stall deadline forward
        const chunk = Buffer.from(value);
        downloaded += chunk.length;
        if (!file.write(chunk)) {
          await new Promise(resolve => file.once('drain', resolve));
        }
        const percent = total > 0 ? Math.min(99, (downloaded / total) * 100) : 0;
        onProgress?.(percent, downloaded, total);
      }
    } finally {
      await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()));
    }

    fs.renameSync(tmpPath, outPath);
    onProgress?.(100, downloaded, total || downloaded);
    return outPath;
  } finally {
    clearTimeout(idleTimer);
  }
}

function formatDownloadSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

async function downloadAndRunRequiredUpdate(data) {
  if (process.platform !== 'win32') return false;

  const updateUrl = getUpdateUrl(data);
  if (!/\.exe(\?|$)/i.test(updateUrl)) return false;

  createUpdateWindow(data);

  try {
    setUpdateWindowStatus({
      title: `Доступна ${data?.displayVersion || data?.latest || 'новая версия'}`,
      detail: 'Скачиваем обновление. После загрузки автоматически запустится установщик.',
      status: 'Подключаемся...',
      percent: 0
    });

    const installerPath = await downloadUpdateInstaller(updateUrl, (percent, downloaded, total) => {
      const sizeText = total ? `${formatDownloadSize(downloaded)} / ${formatDownloadSize(total)}` : formatDownloadSize(downloaded);
      setUpdateWindowStatus({
        title: `Доступна ${data?.displayVersion || data?.latest || 'новая версия'}`,
        detail: 'Скачиваем обновление. После загрузки автоматически запустится установщик.',
        status: sizeText,
        percent
      });
    });

    setUpdateWindowStatus({
      title: 'Обновление скачано',
      detail: 'Запускаем установщик. Strata Mixer сейчас закроется.',
      status: 'Готово',
      percent: 100
    });

    await new Promise(resolve => setTimeout(resolve, 900));

    const child = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    updateWindowCanClose = true;
    app.quit();
    return true;
  } catch (error) {
    updateWindowCanClose = true;
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.close();
    }

    await dialog.showMessageBox({
      type: 'error',
      title: 'Автообновление',
      message: 'Не удалось скачать обновление автоматически.',
      detail:
        'Сейчас откроется страница скачивания вручную.\n\n' +
        `Техническая ошибка: ${error?.message || String(error || 'unknown')}`,
      buttons: ['Скачать вручную'],
      defaultId: 0,
      noLink: true
    });

    await shell.openExternal(updateUrl);
    return true;
  }
}


async function checkRequiredUpdateBeforeStart() {
  // Только для разработки: можно запустить локально без проверки.
  // В собранной программе этот флаг не отключает обязательную проверку.
  if (!app.isPackaged && process.env.STRATA_SKIP_UPDATE_CHECK === '1') {
    return false;
  }

  let data;
  try {
    data = await fetchVersionJson();
  } catch (error) {
    await showUpdateCheckFailedDialog(error);
    return true;
  }

  if (!data || !data.latest) {
    await showUpdateCheckFailedDialog(new Error('version.json не содержит latest'));
    return true;
  }

  const required = data.required !== false;
  if (required && isRemoteNewerVersion(data.latest, CURRENT_APP_VERSION)) {
    // v1.3 beta: Windows обновляется без ручного скачивания.
    // Программа сама скачивает installer из version.json и запускает его.
    const autoStarted = await downloadAndRunRequiredUpdate(data);
    if (autoStarted) return true;

    // Fallback для macOS/других случаев.
    await showRequiredUpdateDialog(data);
    return true;
  }

  return false;
}


function getSafeWindowBounds() {
  const display = screen.getPrimaryDisplay();
  const workArea = display?.workAreaSize || { width: 1366, height: 768 };

  // The previous fixed 1480x980 window could be taller than some screens.
  // That made the bottom Start/Stop panel appear missing. Keep the window inside the visible work area.
  const width = Math.min(1600, Math.max(1200, Math.floor(workArea.width * 0.98)));
  const height = Math.min(1020, Math.max(800, Math.floor(workArea.height * 0.97)));

  const minWidth = Math.min(1200, Math.max(1080, width - 160));
  const minHeight = Math.min(860, Math.max(760, height - 100));

  return { width, height, minWidth, minHeight };
}

function createSplashWindow() {
  const theme = readTheme();
  splashWindow = new BrowserWindow({
    width: 300,
    height: 332,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: theme === 'light' ? '#ebf1f8' : '#020202',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  splashShownAt = Date.now();
  splashWindow.loadFile(appPath('assets', 'splash.html'), {
    hash: encodeURIComponent(theme + '|' + CURRENT_DISPLAY_VERSION)
  });
  splashWindow.once('ready-to-show', () => { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show(); });
  splashWindow.on('closed', () => { splashWindow = null; });
  return splashWindow;
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

// Bring the main window back from the tray (or recreate it if gone).
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// System tray — the window hides here on close instead of quitting.
function createTray() {
  if (tray) return tray;
  const iconPath = appPath('assets', process.platform === 'darwin' ? 'strata_mixer_v1_2_4.icns' : 'strata_mixer_v1_2_4.ico');
  try {
    let image = null;
    try { image = nativeImage.createFromPath(iconPath); } catch {}
    tray = new Tray(image && !image.isEmpty() ? image : iconPath);
  } catch {
    return null;
  }
  tray.setToolTip('Strata Mixer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Strata Mixer', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  return tray;
}

function createWindow() {
  Menu.setApplicationMenu(null);
  const bounds = getSafeWindowBounds();
  const icon = appPath('assets', process.platform === 'darwin' ? 'strata_mixer_v1_2_4.icns' : 'strata_mixer_v1_2_4.ico');
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    center: true,
    title: 'Strata Mixer',
    frame: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(icon) ? icon : undefined,
    backgroundColor: '#060913',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: app.isPackaged || process.env.STRATA_SKIP_UPDATE_CHECK !== '1'
    }
  });

  // Keep the small splash visible until the main window has painted, then
  // swap to it. A minimum on-screen time lets the splash animation play.
  mainWindow.once('ready-to-show', () => {
    const wait = Math.max(0, 2200 - (Date.now() - splashShownAt));
    setTimeout(() => {
      closeSplash();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    }, wait);
  });

  // Closing the window (incl. the custom titlebar ✕) hides to the tray
  // instead of quitting. A real quit goes through the tray menu / app.quit(),
  // which fires before-quit — the save-prompt lives there.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (!app.isPackaged && process.env.STRATA_SKIP_UPDATE_CHECK === '1') {
    const devPort = process.env.VITE_DEV_PORT || 5173;
    mainWindow.loadURL(`http://localhost:${devPort}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ──────────────────────────────────────────────────────────────────────
// Auto-update (electron-updater) + in-app notifications feed.
// Update artifacts (latest.yml / installer / blockmap) and notifications.json
// are hosted on Cloudflare R2 — see package.json "build.publish".
// ──────────────────────────────────────────────────────────────────────
const { autoUpdater } = require('electron-updater');
const NOTIFICATIONS_URL = 'https://raw.githubusercontent.com/genagenagena15-prog/strata-mixer-releases/main/notifications.json';

let updateState = { status: 'idle', version: null, percent: 0, error: null };
let notificationsCache = [];

function pushUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  send('update:state', updateState);
}

function setupAutoUpdater() {
  // electron-updater needs a packaged app (app-update.yml is embedded at build).
  if (!app.isPackaged) return;
  // On macOS the DMG is unsigned (no Apple Developer cert), so electron-updater
  // can't actually install anything. We fall back to a GitHub-Releases-API
  // poll that just notifies the user and opens the download page on demand.
  if (process.platform === 'darwin') return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // forced install on next restart
    autoUpdater.on('checking-for-update', () => pushUpdateState({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => pushUpdateState({ status: 'downloading', version: info?.version || null, percent: 0, error: null }));
    autoUpdater.on('update-not-available', () => pushUpdateState({ status: 'idle', error: null }));
    autoUpdater.on('download-progress', (p) => pushUpdateState({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p?.percent || 0))) }));
    autoUpdater.on('update-downloaded', (info) => pushUpdateState({ status: 'downloaded', version: info?.version || updateState.version, percent: 100, error: null }));
    autoUpdater.on('error', (err) => pushUpdateState({ status: 'error', error: String(err?.message || err || 'unknown') }));
  } catch {}
}

function checkForUpdatesSafe() {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') { checkMacUpdate(); return; }
  try { autoUpdater.checkForUpdates().catch(() => {}); } catch {}
}

// macOS-only update check: hit the GitHub Releases API, find the latest tag,
// and if it's newer than CURRENT_APP_VERSION surface a notify-only update card
// in the bell. The "install" button just opens the DMG download URL.
const MAC_RELEASES_API = 'https://api.github.com/repos/genagenagena15-prog/strata-mixer-releases/releases/latest';
async function checkMacUpdate() {
  if (!app.isPackaged) return;
  if (process.platform !== 'darwin') return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${MAC_RELEASES_API}?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) return;
    const data = await res.json();
    const tag = String(data.tag_name || '').replace(/^v/, '').trim();
    if (!tag) return;
    if (!isRemoteNewerVersion(tag, CURRENT_APP_VERSION)) {
      pushUpdateState({ status: 'idle', error: null });
      return;
    }
    const dmgAsset = (data.assets || []).find(a => /\.dmg$/i.test(a.name));
    const downloadUrl = dmgAsset?.browser_download_url || data.html_url;
    pushUpdateState({ status: 'mac-available', version: tag, downloadUrl, error: null });
  } catch { /* silent — try again later */ }
  finally { clearTimeout(timer); }
}

async function fetchNotifications() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${NOTIFICATIONS_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'accept': 'application/json' }
    });
    if (!response.ok) return;
    const data = await response.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
    notificationsCache = list
      .filter((m) => m && m.id != null)
      .map((m) => ({
        id: String(m.id),
        type: m.type === 'update' ? 'update' : 'info',
        title: String(m.title || ''),
        body: String(m.body || ''),
        version: m.version != null ? String(m.version) : null,
        date: m.date != null ? String(m.date) : null
      }));
    send('notifications:data', notificationsCache);
  } catch {
    // offline / not yet hosted — keep the last cache silently
  } finally {
    clearTimeout(timer);
  }
}

function startUpdateAndNotificationCycle() {
  setupAutoUpdater();
  setTimeout(() => { checkForUpdatesSafe(); fetchNotifications(); }, 4000);
  setInterval(checkForUpdatesSafe, 30 * 60 * 1000);
  setInterval(fetchNotifications, 10 * 60 * 1000);
}

ipcMain.handle('app:version', () => CURRENT_DISPLAY_VERSION);
ipcMain.handle('update:getState', () => updateState);
ipcMain.handle('update:check', () => { checkForUpdatesSafe(); return updateState; });
ipcMain.handle('update:install', async () => {
  // Mac: no in-place auto-install (DMG is unsigned). But we still mirror the
  // Windows experience as closely as possible — download the .dmg with a live
  // progress window, then open it so the user just drags the app into
  // Applications. Falls back to opening the browser download if anything fails.
  if (process.platform === 'darwin' && updateState.status === 'mac-available' && updateState.downloadUrl) {
    const verText = updateState.version ? `v${updateState.version}` : 'новая версия';
    const detail = 'Скачиваем обновление. Когда загрузка завершится, откроется установщик — перетащи Strata Mixer в папку «Программы».';
    try {
      createUpdateWindow({ displayVersion: verText });
      setUpdateWindowStatus({ title: `Загрузка ${verText}`, detail, status: 'Подключаемся…', percent: 0 });
      const dmgPath = await downloadUpdateInstaller(updateState.downloadUrl, (percent, downloaded, total) => {
        const sizeText = total ? `${formatDownloadSize(downloaded)} / ${formatDownloadSize(total)}` : formatDownloadSize(downloaded);
        setUpdateWindowStatus({ title: `Загрузка ${verText}`, detail, status: sizeText, percent });
      });
      setUpdateWindowStatus({ title: 'Загрузка завершена', detail: 'Открываем установщик (.dmg). Перетащи Strata Mixer в «Программы».', status: 'Готово', percent: 100 });
      await new Promise((r) => setTimeout(r, 700));
      updateWindowCanClose = true;
      try { updateWindow?.close(); } catch {}
      try { await shell.openPath(dmgPath); } catch { try { shell.openExternal(updateState.downloadUrl); } catch {} }
    } catch (e) {
      updateWindowCanClose = true;
      try { updateWindow?.close(); } catch {}
      try { shell.openExternal(updateState.downloadUrl); } catch {}
    }
    return true;
  }
  // Ask to save unsaved work before restarting for the install.
  const proceed = await maybePromptSaveProject(
    'Установить обновление?',
    'Программа будет перезапущена для установки обновления. У вас есть несохранённые изменения — сохранить проект?'
  );
  if (!proceed) return false;
  try { autoUpdater.quitAndInstall(true, true); } catch {}
  return true;
});
// Roll back to the previous published version: find the release immediately
// older than the one running, download its installer and run it (Windows) or
// open the DMG (macOS). This is the "Скачать предыдущую версию" action.
const RELEASES_LIST_API = 'https://api.github.com/repos/genagenagena15-prog/strata-mixer-releases/releases?per_page=40';
ipcMain.handle('update:rollback', async () => {
  try {
    const res = await fetch(`${RELEASES_LIST_API}&t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    // Releases strictly older than the running version, newest-first.
    const older = (Array.isArray(list) ? list : [])
      .map((r) => ({ r, ver: String(r.tag_name || '').replace(/^v/, '').trim() }))
      .filter((x) => /^\d+\.\d+\.\d+/.test(x.ver) && isRemoteNewerVersion(CURRENT_APP_VERSION, x.ver))
      .sort((a, b) => (isRemoteNewerVersion(a.ver, b.ver) ? -1 : 1));
    if (!older.length) {
      await dialog.showMessageBox(mainWindow, { type: 'info', buttons: ['ОК'], title: 'Откат версии', message: 'Предыдущая версия не найдена', detail: 'На сервере нет релиза старше текущего.' });
      return { ok: false, error: 'no previous release' };
    }
    const prev = older[0];
    const isMac = process.platform === 'darwin';
    const wantExt = isMac ? /\.dmg$/i : /\.exe$/i;
    const asset = (prev.r.assets || []).find((a) => wantExt.test(a.name) && !/blockmap/i.test(a.name));
    if (!asset) {
      await dialog.showMessageBox(mainWindow, { type: 'error', buttons: ['ОК'], title: 'Откат версии', message: `Установщик для v${prev.ver} не найден`, detail: `Нет ${isMac ? '.dmg' : '.exe'} в релизе v${prev.ver}.` });
      return { ok: false, error: 'no installer asset' };
    }
    const url = asset.browser_download_url;

    // Confirm — this closes the app and runs an older installer.
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [`Откатиться на v${prev.ver}`, 'Отмена'],
      defaultId: 0, cancelId: 1, noLink: true,
      title: 'Откат на предыдущую версию',
      message: `Откатиться на v${prev.ver}?`,
      detail: isMac
        ? `Скачаем v${prev.ver} и откроем DMG — установишь вручную (перетащи в Applications).`
        : `Программа закроется, скачается v${prev.ver} и запустится установщик. Несохранённую работу сначала сохрани.`,
    });
    if (choice.response !== 0) return { ok: false, canceled: true };

    if (isMac) {
      // No auto-install on Mac — download the DMG then open it.
      const dmgPath = await downloadUpdateInstaller(url);
      try { await shell.openPath(dmgPath); } catch { try { shell.openExternal(url); } catch {} }
      return { ok: true, version: prev.ver };
    }

    // Windows: show the download window, fetch the installer, run it, quit.
    createUpdateWindow({ displayVersion: `v${prev.ver}` });
    setUpdateWindowStatus({ title: `Откат на v${prev.ver}`, detail: 'Скачиваем предыдущую версию. После загрузки запустится установщик.', status: 'Подключаемся...', percent: 0 });
    const installerPath = await downloadUpdateInstaller(url, (percent, downloaded, total) => {
      const sizeText = total ? `${formatDownloadSize(downloaded)} / ${formatDownloadSize(total)}` : formatDownloadSize(downloaded);
      setUpdateWindowStatus({ title: `Откат на v${prev.ver}`, detail: 'Скачиваем предыдущую версию. После загрузки запустится установщик.', status: sizeText, percent });
    });
    setUpdateWindowStatus({ title: 'Загрузка завершена', detail: 'Запускаем установщик. Strata Mixer закроется.', status: 'Готово', percent: 100 });
    await new Promise((r) => setTimeout(r, 800));
    const child = spawn(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    updateWindowCanClose = true;
    isQuitting = true;
    app.quit();
    return { ok: true, version: prev.ver };
  } catch (e) {
    try {
      await dialog.showMessageBox(mainWindow, { type: 'error', buttons: ['ОК'], title: 'Откат версии', message: 'Не удалось скачать предыдущую версию', detail: String(e?.message || e) });
    } catch {}
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('notifications:get', () => notificationsCache);
ipcMain.handle('notifications:refresh', async () => { await fetchNotifications(); return notificationsCache; });

app.on('second-instance', (_event, argv) => {
  showMainWindow();
  const proj = extractProjectPath(argv);
  if (proj) {
    pendingProjectFile = proj;
    dispatchPendingProject();
  }
});
app.on('before-quit', (event) => {
  // If the renderer has unsaved work, intercept the quit and ask the user.
  // _quitCleared is set after the user has answered (or there was nothing
  // to save) so the second app.quit() goes through to actual cleanup.
  if (rendererDirty && !_quitCleared) {
    event.preventDefault();
    (async () => {
      const proceed = await maybePromptSaveProject('Сохранить проект перед выходом?');
      if (proceed) {
        _quitCleared = true;
        isQuitting = true;
        app.quit();
      } else {
        // Cancelled — stay open, stop the quit chain.
        isQuitting = false;
      }
    })();
    return;
  }
  isQuitting = true;
  // Best-effort sweep of orphaned temps. Fast and synchronous because the
  // process is exiting; lost files would otherwise stay until the OS cleans
  // %TEMP% (which on Windows is rarely).
  for (const f of liveTmpFiles) { try { fs.unlinkSync(f); } catch {} }
  liveTmpFiles.clear();
});

// Bound the proxy cache so it doesn't grow forever. Runs in the background
// at startup — deletes oldest files (by mtime) when the dir is bigger than
// PROXY_CACHE_MAX bytes. Active proxies keep themselves alive via their
// mtime being newer than the source file, so freshly-used ones survive.
const PROXY_CACHE_MAX = 2 * 1024 * 1024 * 1024; // 2 GB ceiling
function pruneProxyCache() {
  const dir = path.join(app.getPath('temp'), 'strata-proxy');
  fs.promises.readdir(dir).then(async (names) => {
    const entries = [];
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        const st = await fs.promises.stat(full);
        entries.push({ full, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
    let total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= PROXY_CACHE_MAX) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const e of entries) {
      if (total <= PROXY_CACHE_MAX) break;
      try { await fs.promises.unlink(e.full); total -= e.size; } catch {}
    }
  }).catch(() => {});
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  if (process.platform === 'win32') app.setAppUserModelId('com.stratamixer.app.1.1beta');

  createSplashWindow();
  createWindow();
  createTray();
  startUpdateAndNotificationCycle();
  pruneProxyCache();

  // If we were launched with a .smproj path in argv (or via macOS open-file
  // queued before whenReady), push it into the renderer as soon as it loads.
  dispatchPendingProject();

  app.on('activate', () => showMainWindow());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('theme:save', (_e, theme) => { writeTheme(theme); });

ipcMain.handle('files:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери видео',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('image:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери картинку для водяного знака',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  });
  if (result.canceled) return '';
  return result.filePaths[0] || '';
});

ipcMain.handle('media:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Импорт медиа',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Медиа', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'] }]
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('audio:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери аудио или видео файл',
    properties: ['openFile'],
    filters: [{ name: 'Audio / Video', extensions: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'mp4', 'mov', 'mkv', 'avi'] }]
  });
  if (result.canceled) return '';
  return result.filePaths[0] || '';
});

ipcMain.handle('saveas:pick', async (_event, defaultName, format) => {
  let filters;
  if (format === 'webm') filters = [{ name: 'WebM Video', extensions: ['webm'] }];
  else if (format === 'mp3') filters = [{ name: 'MP3 Audio', extensions: ['mp3'] }];
  else filters = [{ name: 'Video', extensions: ['mp4', 'mov'] }];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Сохранить как',
    defaultPath: defaultName || 'output.mp4',
    filters
  });
  if (result.canceled) return '';
  return result.filePath || '';
});

// ── Project file (.smproj) save/open ────────────────────────────────────────
// Plain JSON: { version, savedAt, state: { layers, totalDuration, ... } }.
// Media paths are stored absolute — easiest, but breaks if the user moves the
// source files. On open we check fs.existsSync for every layer's file and tag
// missing ones with `_missing: true` so the UI can flag them.
// ── Self-contained project bundling (.smproj = ZIP) ────────────────────────
// A saved project is a ZIP archive: `project.json` (the state with media paths
// rewritten to repo-relative `media/<n>_<name>`) plus a `media/` folder holding
// a copy of every referenced video/audio/image. This lets a user forward ONE
// file and have it open identically on another machine. Legacy plain-JSON
// projects still open (detected by the absence of the ZIP magic bytes).

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.equals(ZIP_MAGIC);
  } catch { return false; }
}

function sanitizeMediaName(p) {
  const base = path.basename(String(p || 'file'));
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80) || 'file';
}

// Walk the project state and return every absolute media path it references
// (main video + each layer's .file). Deduped, existing files only.
function collectProjectMedia(state) {
  const files = new Set();
  const add = (f) => { if (f && typeof f === 'string') files.add(f); };
  if (state) {
    add(state.file);
    if (Array.isArray(state.layers)) state.layers.forEach((l) => add(l && l.file));
  }
  return [...files].filter((f) => { try { return fs.existsSync(f); } catch { return false; } });
}

// Build the ZIP. Returns a promise that resolves when the archive is fully
// flushed to disk. Streams files in (no whole-file buffering) so multi-GB
// projects don't blow up memory.
function bundleProjectToZip(payload, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const state = payload && payload.state ? payload.state : {};
    const media = collectProjectMedia(state);

    // original absolute path → archived relative name (deduped, collision-safe).
    const pathMap = new Map();
    media.forEach((abs, i) => {
      pathMap.set(abs, `media/${i}_${sanitizeMediaName(abs)}`);
    });

    // Pre-compute total bytes for a stable progress bar (sum of media file
    // sizes; the JSON entry is negligible). Failures fall back to 0 (then
    // the bar just runs on archiver's own byte count).
    let totalBytes = 0;
    for (const abs of media) {
      try { totalBytes += fs.statSync(abs).size; } catch {}
    }
    const emit = (extra) => {
      try { onProgress && onProgress(extra); } catch {}
    };

    // Deep-ish clone of state with media paths rewritten to the archived names.
    // Missing files keep their original path (they'll flag as _missing on open).
    const remap = (f) => (f && pathMap.has(f) ? pathMap.get(f) : f);
    const newState = {
      ...state,
      file: remap(state.file),
      layers: Array.isArray(state.layers)
        ? state.layers.map((l) => (l && l.file ? { ...l, file: remap(l.file) } : l))
        : state.layers,
    };
    const wrapper = {
      version: 2,
      app: 'strata-mixer',
      bundled: true,
      savedAt: new Date().toISOString(),
      state: newState,
    };

    const output = fs.createWriteStream(filePath);
    const archive = archiver('zip', { store: true }); // store: media is already compressed
    let settled = false;
    const done = (err) => {
      if (settled) return; settled = true;
      if (err) { reject(err); return; }
      emit({ phase: 'done', percent: 100, processed: totalBytes, total: totalBytes, fileName: '' });
      resolve({ ok: true, path: filePath, mediaCount: media.length });
    };

    output.on('close', () => done());
    output.on('error', done);
    archive.on('error', done);
    archive.on('warning', (w) => { if (w.code !== 'ENOENT') done(w); });
    // Per-entry add (file name shown in the UI).
    archive.on('entry', (entry) => {
      const name = entry?.name || '';
      if (!/^media\//.test(name)) return; // skip the project.json entry
      emit({ phase: 'add', fileName: name.replace(/^media\/\d+_/, '') });
    });
    // Byte-level progress (drives the percent number).
    archive.on('progress', (p) => {
      const processed = p?.fs?.processedBytes || 0;
      const total = totalBytes || p?.fs?.totalBytes || 0;
      const percent = total > 0 ? Math.min(99, Math.round((processed / total) * 100)) : 0;
      emit({ phase: 'progress', percent, processed, total });
    });

    emit({ phase: 'start', percent: 0, processed: 0, total: totalBytes, mediaCount: media.length });

    archive.pipe(output);
    archive.append(JSON.stringify(wrapper, null, 2), { name: 'project.json' });
    for (const abs of media) {
      archive.file(abs, { name: pathMap.get(abs) });
    }
    archive.finalize().catch(done);
  });
}

// Unique, stable-ish cache dir for an opened bundle so re-opening the same file
// reuses extracted media instead of piling up copies.
function bundleCacheDir(filePath) {
  let stamp = '0';
  try { stamp = String(fs.statSync(filePath).mtimeMs | 0); } catch {}
  const key = sanitizeMediaName(filePath) + '-' + stamp;
  return path.join(app.getPath('userData'), 'opened-projects', key);
}

// Shared loader for BOTH the open-dialog handler and the double-click /
// open-from-file flow. Detects ZIP vs legacy JSON, extracts media to cache,
// rewrites archived paths back to absolute, and flags any missing files.
async function loadProjectFile(filePath) {
  if (isZipFile(filePath)) {
    const cacheDir = bundleCacheDir(filePath);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(cacheDir, { recursive: true });
    await extractZip(filePath, { dir: cacheDir });
    const jsonPath = path.join(cacheDir, 'project.json');
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!data || typeof data !== 'object' || !data.state) {
      return { ok: false, error: 'Файл проекта повреждён или имеет несовместимый формат.' };
    }
    // Rewrite media/... → absolute path inside the cache dir.
    const abs = (f) => {
      if (f && typeof f === 'string' && f.startsWith('media/')) {
        const p = path.join(cacheDir, f);
        return fs.existsSync(p) ? p : f;
      }
      return f;
    };
    const s = data.state;
    s.file = abs(s.file);
    if (Array.isArray(s.layers)) {
      s.layers = s.layers.map((l) => {
        if (!l || !l.file) return l;
        const resolved = abs(l.file);
        return fs.existsSync(resolved) ? { ...l, file: resolved } : { ...l, file: resolved, _missing: true };
      });
    }
    return { ok: true, path: filePath, data };
  }
  // Legacy plain-JSON project.
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !data.state) {
    return { ok: false, error: 'Файл проекта повреждён или имеет несовместимый формат.' };
  }
  if (Array.isArray(data.state.layers)) {
    data.state.layers = data.state.layers.map((l) =>
      l && l.file && !fs.existsSync(l.file) ? { ...l, _missing: true } : l
    );
  }
  return { ok: true, path: filePath, data };
}

ipcMain.handle('project:save', async (_event, projectData) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить проект',
      defaultPath: (projectData && projectData.suggestedName) || 'project.smproj',
      filters: [{ name: 'Strata Mixer Project', extensions: ['smproj'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    // Drop the `suggestedName` hint before writing — it's a transient field
    // used only to seed the save dialog.
    const { suggestedName, ...payload } = projectData || {};
    // Always bundle: write a self-contained ZIP with all media inside, so the
    // .smproj can be forwarded and opened 1:1 on another machine.
    // Stream progress events to the renderer for the save modal.
    await bundleProjectToZip(payload, result.filePath, (info) => {
      try { mainWindow?.webContents?.send('project:save-progress', info); } catch {}
    });
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Renderer pushes its dirty flag here whenever it changes.
ipcMain.on('project:set-dirty', (_event, dirty) => {
  rendererDirty = !!dirty;
});

// Ask the renderer to perform a Save (it owns the project state and the
// IPC saveProject() flow). Resolves with whatever the renderer reports.
function requestRendererSave() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve({ ok: false, error: 'no window' });
    const handler = (_event, res) => {
      ipcMain.removeListener('project:save-response', handler);
      resolve(res || { ok: false, error: 'no response' });
    };
    ipcMain.on('project:save-response', handler);
    try { mainWindow.webContents.send('project:save-request', {}); }
    catch (e) {
      ipcMain.removeListener('project:save-response', handler);
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

// Ask the renderer to show its custom in-app save-prompt modal and resolve
// with 'save' | 'dont-save' | 'cancel'. Falls back to the native dialog if
// the renderer isn't reachable for any reason.
function requestRendererSavePrompt(message, detail) {
  return new Promise((resolve) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!win) return resolve('cancel');
    const handler = (_event, choice) => {
      ipcMain.removeListener('project:save-prompt-response', handler);
      clearTimeout(timeoutId);
      resolve(choice || 'cancel');
    };
    ipcMain.on('project:save-prompt-response', handler);
    // Safety net: if the renderer somehow never responds (crashed mid-modal),
    // fall back to "cancel" after 60 s so the app doesn't hang.
    const timeoutId = setTimeout(() => {
      ipcMain.removeListener('project:save-prompt-response', handler);
      resolve('cancel');
    }, 60000);
    try { win.webContents.send('project:save-prompt-request', { message, detail }); }
    catch {
      ipcMain.removeListener('project:save-prompt-response', handler);
      clearTimeout(timeoutId);
      resolve('cancel');
    }
  });
}

// Returns true if the caller should proceed with the destructive action
// (quit / update install). False if the user cancelled or the save failed.
async function maybePromptSaveProject(message, detail) {
  if (!rendererDirty) return true;
  if (savePromptInFlight) return false;
  savePromptInFlight = true;
  try {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!win) return true;
    if (!win.isVisible()) { try { win.show(); } catch {} }
    try { win.focus(); } catch {}
    const choice = await requestRendererSavePrompt(
      message,
      detail || 'У вас есть несохранённые изменения. Хотите сохранить проект?'
    );
    if (choice === 'cancel') return false;
    if (choice === 'dont-save') return true;
    // choice === 'save'
    const saveRes = await requestRendererSave();
    if (saveRes && saveRes.canceled) return false;
    if (saveRes && saveRes.ok) return true;
    // Save error: fall back to native error dialog so the user definitely sees it.
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['ОК'],
      title: 'Strata Mixer',
      message: 'Не удалось сохранить проект',
      detail: (saveRes && saveRes.error) || 'Неизвестная ошибка',
    });
    return false;
  } finally {
    savePromptInFlight = false;
  }
}

ipcMain.handle('project:open', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Открыть проект',
      properties: ['openFile'],
      filters: [{ name: 'Strata Mixer Project', extensions: ['smproj'] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
    const file = result.filePaths[0];
    // Shared loader handles both ZIP bundles (extract media to cache + rewrite
    // paths) and legacy plain-JSON projects.
    return await loadProjectFile(file);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Preview proxy generator: re-encodes a video (commonly HEVC/AV1 that
// Chromium can't decode) to H.264 + AAC at original resolution so the editor
// preview works. The original file path is still used for the final export.
// Throttle parallel proxy transcodes so importing N videos at once doesn't
// fire N ffmpeg processes simultaneously (saturates disk/GPU and OS scheduler).
const PROXY_CONCURRENCY = 2;
let _proxyInflight = 0;
const _proxyQueue = [];
function _acquireProxySlot() {
  return new Promise(resolve => {
    if (_proxyInflight < PROXY_CONCURRENCY) {
      _proxyInflight++;
      resolve();
    } else {
      _proxyQueue.push(resolve);
    }
  });
}
function _releaseProxySlot() {
  _proxyInflight--;
  const next = _proxyQueue.shift();
  if (next) { _proxyInflight++; next(); }
}

ipcMain.handle('editor:makeProxy', async (event, payload) => {
  const { file, force } = payload || {};
  if (!file) return { ok: false, error: 'no file' };
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ok: false, error: 'FFmpeg не найден' };

  // Probe first so we don't waste time/disk on files Chromium already plays.
  if (!force) {
    try {
      const probe = await probeMediaInfo(ffmpeg, file);
      const raw = String(probe.raw || '');
      const needsProxy = /\b(hevc|av1)\b/i.test(raw) || /h\.?265/i.test(raw) || /\bprores\b/i.test(raw);
      if (!needsProxy) {
        return { ok: true, proxyPath: null, supported: true };
      }
    } catch {} // if probe fails, fall through and attempt the proxy anyway
  }

  // Stable cache key based on file path so multiple layers reusing the same
  // source share one proxy, and re-opening the project reuses it too.
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(file).digest('hex').slice(0, 12);
  const tmpDir = path.join(app.getPath('temp'), 'strata-proxy');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const proxyPath = path.join(tmpDir, `proxy-${hash}.mp4`);

  // Reuse if proxy already exists and is newer than source.
  try {
    const srcStat = fs.statSync(file);
    const dstStat = fs.statSync(proxyPath);
    if (dstStat.mtimeMs >= srcStat.mtimeMs && dstStat.size > 1024) {
      return { ok: true, proxyPath, cached: true };
    }
  } catch {}

  const args = [
    '-y', '-i', file,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    proxyPath,
  ];

  await _acquireProxySlot();
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = ''; let totalDur = 0;
    proc.stderr.on('data', d => {
      const s = d.toString(); stderr += s;
      if (!totalDur) {
        const dm = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (dm) totalDur = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
      }
      const tm = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (tm && totalDur > 0) {
        const t = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
        try { event.sender.send('editor:proxy-progress', { file, percent: Math.min(99, (t / totalDur) * 100) }); } catch {}
      }
    });
    proc.on('error', e => { _releaseProxySlot(); resolve({ ok: false, error: String(e.message || e) }); });
    proc.on('close', code => {
      _releaseProxySlot();
      if (code === 0) resolve({ ok: true, proxyPath, cached: false });
      else resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-300)}` });
    });
  });
});

// Concatenate multiple clips (possibly from different source files) into one
// normalised MP4/MP3, returning the temp path so the editor can replace the
// selection with a single layer pointing at the merged file.
ipcMain.handle('editor:concatClips', async (event, payload) => {
  const { clips = [], w = 1080, h = 1920, isAudio = false } = payload || {};
  if (clips.length < 2) return { ok: false, error: 'нужно минимум 2 клипа' };
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ok: false, error: 'FFmpeg не найден' };

  // Probe each source to know if it has audio (so we can substitute silence).
  const probes = await Promise.all(clips.map(c => probeMediaInfo(ffmpeg, c.file).catch(() => ({}))));

  const inputArgs = [];
  const filterParts = [];
  const outPairs = [];

  clips.forEach((c, i) => {
    inputArgs.push('-i', c.file);
    const srcStart = Math.max(0, Number(c.srcStart) || 0);
    const speed = Math.max(0.1, (c.speed || 100) / 100);
    const len = Math.max(0.1, Number(c.length) || 1);
    const srcEnd = srcStart + len * speed;
    const hasAud = !!probes[i]?.hasAudio;

    // Build atempo chain (atempo only accepts 0.5..2.0, chain if needed).
    let r = speed; const atempos = [];
    while (r > 2) { atempos.push('atempo=2.0'); r /= 2; }
    while (r < 0.5) { atempos.push('atempo=0.5'); r *= 2; }
    atempos.push(`atempo=${r.toFixed(4)}`);

    if (isAudio) {
      filterParts.push(`[${i}:a]atrim=start=${srcStart.toFixed(3)}:end=${srcEnd.toFixed(3)},asetpts=PTS-STARTPTS,${atempos.join(',')}[a${i}]`);
      outPairs.push(`[a${i}]`);
    } else {
      // Normalise video to target canvas: trim, retime, scale-fit + pad, format.
      filterParts.push(`[${i}:v]trim=start=${srcStart.toFixed(3)}:end=${srcEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(${w}-iw)/2:(${h}-ih)/2,setsar=1,format=yuv420p[v${i}]`);
      if (hasAud) {
        filterParts.push(`[${i}:a]atrim=start=${srcStart.toFixed(3)}:end=${srcEnd.toFixed(3)},asetpts=PTS-STARTPTS,${atempos.join(',')}[a${i}]`);
      } else {
        // Generate silent track of the right output duration.
        filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${len.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      }
      outPairs.push(`[v${i}][a${i}]`);
    }
  });

  let mapArgs;
  if (isAudio) {
    filterParts.push(`${outPairs.join('')}concat=n=${clips.length}:v=0:a=1[outa]`);
    mapArgs = ['-map', '[outa]', '-c:a', 'libmp3lame', '-b:a', '192k'];
  } else {
    filterParts.push(`${outPairs.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`);
    mapArgs = ['-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  }

  // Generate temp output path so renderer doesn't need filesystem access.
  const ext = isAudio ? 'mp3' : 'mp4';
  const tmpDir = path.join(app.getPath('temp'), 'strata-merge');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const outPath = path.join(tmpDir, `merge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);

  const args = ['-y', ...inputArgs, '-filter_complex', filterParts.join(';'), ...mapArgs, outPath];

  // Total output duration for progress (sum of post-tempo durations = sum of len).
  const totalDur = clips.reduce((s, c) => s + Math.max(0.1, Number(c.length) || 0), 0);

  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => {
      const s = d.toString(); stderr += s;
      const tm = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (tm && totalDur > 0) {
        const t = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
        try { event.sender.send('editor:merge-progress', { percent: Math.min(99, (t / totalDur) * 100) }); } catch {}
      }
    });
    proc.on('error', e => resolve({ ok: false, error: String(e.message || e) }));
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true, path: outPath });
      else resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-400)}` });
    });
  });
});

ipcMain.handle('video:edit', async (_event, payload) => {
  const { outWidth, outHeight, bgColor = '#000000', fadeIn = 0, fadeOut = 0, outPath, format = 'mp4', quality = 'normal' } = payload;
  let file = payload.file;
  let videoStart = payload.videoStart || 0;
  let videoEnd   = payload.videoEnd   || 0;
  let totalDuration = payload.totalDuration || 0;
  let layers = payload.layers || [];

  if (!file || !outPath) return { ok: false, error: 'No file or output path' };
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ok: false, error: 'FFmpeg not found' };

  // Probe the source so the export can cap the output size relative to it.
  const srcProbe = await probeMediaInfo(ffmpeg, payload.file).catch(() => ({}));
  const srcDurReal = Math.max(0.5, srcProbe.duration || totalDuration || 1);
  const srcMbReal = fileSizeMb(payload.file);

  // Probe every file the filter graph will reference. We need both:
  //  - hasAudio: skip [idx:a] for silent sources or the graph fails to parse.
  //  - width/height: clamp srcCrop coords for maskedVideo so ffmpeg's crop
  //    filter doesn't bail when the renderer guessed dimensions wrong (e.g.
  //    HEVC proxy wasn't loaded yet at Apply time).
  const mediaProbeMap = new Map();
  mediaProbeMap.set(payload.file, srcProbe || {});
  await Promise.all(
    (payload.layers || []).filter(l => l && l.file && (l.type === 'videoOverlay' || l.type === 'maskedVideo' || l.type === 'audio'))
      .map(async (l) => {
        if (mediaProbeMap.has(l.file)) return;
        try { const p = await probeMediaInfo(ffmpeg, l.file); mediaProbeMap.set(l.file, p || {}); }
        catch { mediaProbeMap.set(l.file, {}); }
      })
  );
  const audioProbeMap = new Map();
  for (const [f, info] of mediaProbeMap.entries()) audioProbeMap.set(f, !!info.hasAudio);

  // ── Pre-process reversed layers (separate FFmpeg pass to avoid PTS issues) ──
  const tmpRevFiles = [];
  const reverseClip = async (srcFile, clipStart, clipDuration) => {
    const tmpOut = path.join(os.tmpdir(), `smrev_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    tmpRevFiles.push(tmpOut);
    const dur = Math.max(0.1, clipDuration);
    const tryWith = (withAudio) => new Promise((res, rej) => {
      const args = ['-y', '-ss', String(clipStart), '-t', String(dur), '-i', srcFile, '-vf', 'reverse'];
      if (withAudio) args.push('-af', 'areverse'); else args.push('-an');
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15', tmpOut);
      const p = spawn(ffmpeg, args);
      p.on('close', c => c === 0 ? res(tmpOut) : rej(new Error('exit ' + c)));
      p.on('error', rej);
    });
    return tryWith(true).catch(() => tryWith(false));
  };

  const mvLayer = payload.mainVideo;
  if (mvLayer?.reversed) {
    try {
      const clipDur = Math.max(0.1, videoEnd - videoStart);
      file = await reverseClip(file, videoStart, clipDur);
      videoStart = 0; videoEnd = clipDur;
    } catch(e) {
      tmpRevFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      return { ok: false, error: 'Реверс видео не удался: ' + e.message };
    }
  }

  const processedLayers = [];
  for (const layer of layers) {
    if (layer.type === 'videoOverlay' && layer.reversed) {
      try {
        // Reverse the clip's actual source segment — split clips have a
        // non-zero srcStart, and speed scales how much source it consumes.
        const sp = Math.max(0.1, (layer.speed || 100) / 100);
        const clipDur = Math.max(0.1, (layer.endTime ?? totalDuration) - (layer.startTime || 0));
        const revFile = await reverseClip(layer.file, layer.srcStart || 0, clipDur * sp);
        processedLayers.push({ ...layer, file: revFile, reversed: false, srcStart: 0 });
      } catch(e) { processedLayers.push(layer); }
    } else {
      processedLayers.push(layer);
    }
  }
  layers = processedLayers;
  const mainVideoForFilter = { ...(mvLayer || {}), reversed: false };
  // ─────────────────────────────────────────────────────────────────────────────

  return new Promise((resolve) => {
    const tmpFiles = [...tmpRevFiles];
    // Async drawtext-text writes collected here; flushed in parallel before
    // spawn so the build doesn't sit on N sequential sync writes.
    const pendingTextWrites = [];
    // Track every temp file globally so app quit purges any that escaped
    // the per-call cleanup (e.g. when a sync error aborted the filter-graph
    // builder before spawn).
    tmpFiles.forEach(f => liveTmpFiles.add(f));
    // Per-render isolated font dirs (one font file each) — see subtitle loop.
    // Cleaned up recursively alongside the temp files.
    const tmpFontDirs = [];
    const cleanupTmps = () => {
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} liveTmpFiles.delete(f); });
      tmpFontDirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
    };
    try {
    const filterParts = [];
    const inputArgs = ['-i', file];
    let videoStream = '[0:v]';
    let inputIdx = 1;

    const evenW = Math.ceil(outWidth / 2) * 2;
    const evenH = Math.ceil(outHeight / 2) * 2;
    const clipLen = Math.max(0.1, videoEnd - videoStart);
    const padAfter = Math.max(0, totalDuration - videoEnd);
    const totalDur = Math.max(0.1, totalDuration);
    // Preview-proxy partial render: only output the [start,end] window of the
    // composition (used to buffer AHEAD of the playhead first). Output -ss/-t.
    const _pr = (payload.previewRange && Number(payload.previewRange.end) > Number(payload.previewRange.start))
      ? { start: Math.max(0, Number(payload.previewRange.start)), end: Math.min(totalDur, Number(payload.previewRange.end)) }
      : null;
    const renderDur = _pr ? Math.max(0.1, _pr.end - _pr.start) : totalDur;
    const bgHex = (bgColor || '#000000').replace('#', '0x');
    const isAudioOnly = format === 'mp3';
    // Declared at executor scope so the audio-mixing block below can read it
    // even when isAudioOnly skipped the video graph entirely.
    const videoOverlayInputs = [];
    // Same scope reasoning for mainVideo source-position info — the audio
    // block also needs mvSrc/mvSp to trim [0:a] correctly when a head-trim
    // was applied to the main clip.
    const mvSrc = (mvLayer && Number(mvLayer.srcStart)) || 0;
    const mvSp = Math.max(0.1, ((mvLayer && mvLayer.speed) || 100) / 100);

    if (!isAudioOnly) {
      const mv = mainVideoForFilter;
      // The clip on the timeline runs from videoStart..videoEnd, but the
      // SOURCE pixels played in that window start from mvLayer.srcStart in
      // the input file. Honour both — otherwise trimming the head of a clip
      // gets lost in the export (preview shows trimmed, export shows raw).
      const mvClipDur = Math.max(0.01, videoEnd - videoStart);
      const mvSrcEnd = (mvSrc + mvClipDur * mvSp).toFixed(3);
      // Colour correction for the main video — must match the preview's
      // CSS filter: brightness() is a MULTIPLIER (100% = unchanged, 150% =
      // 1.5x), so we model it via colorchannelmixer (per-channel scaling)
      // instead of eq.brightness which is additive in [-1,1].
      const mvCcB = (mvLayer && Number(mvLayer.ccB)) || 0;
      const mvCcC = (mvLayer && mvLayer.ccC != null) ? Number(mvLayer.ccC) : 100;
      const mvCcS = (mvLayer && mvLayer.ccS != null) ? Number(mvLayer.ccS) : 100;
      const mvCcH = (mvLayer && Number(mvLayer.ccH)) || 0;
      const mvBMult = 1 + mvCcB / 100;
      const mvCmPart = mvBMult !== 1
        ? `,colorchannelmixer=rr=${mvBMult.toFixed(3)}:gg=${mvBMult.toFixed(3)}:bb=${mvBMult.toFixed(3)}`
        : '';
      const mvEqPart = (mvCcC !== 100 || mvCcS !== 100)
        ? `,eq=contrast=${(mvCcC/100).toFixed(3)}:saturation=${(mvCcS/100).toFixed(3)}`
        : '';
      const mvHuePart = mvCcH !== 0 ? `,hue=h=${mvCcH.toFixed(2)}` : '';
      const mvCcPart = mvCmPart + mvEqPart + mvHuePart;

      if (mvLayer) {
        // Mirror the preview's getLayerPx(mainVideo) EXACTLY so the export
        // matches what the user sees: the video fills the canvas WIDTH at
        // `size`%, its height follows the source aspect, it's centred at
        // (x,y), and any overflow is cropped by the canvas ("cover"). The old
        // code only did this when size+aspect were explicitly set, otherwise
        // it fell back to a "contain" scale+pad that added black bars — which
        // is the bug being fixed here. Defaults match the preview: size=100,
        // aspect from the source probe (videoWidth/videoHeight), x=y=50.
        const mvAspect = (Number(mv.aspect) > 0)
          ? Number(mv.aspect)
          : ((srcProbe.width > 0 && srcProbe.height > 0) ? srcProbe.width / srcProbe.height : evenW / evenH);
        const mvSize = (mv.size != null && Number(mv.size) > 0) ? Number(mv.size) : 100;
        const mvW = Math.max(2, Math.round((mvSize / 100) * evenW));
        const mvH = Math.max(2, Math.round(mvW / mvAspect));
        const mvX = Math.round(((mv.x == null ? 50 : mv.x) / 100) * evenW - mvW / 2);
        const mvY = Math.round(((mv.y == null ? 50 : mv.y) / 100) * evenH - mvH / 2);
        if (mvLayer.hidden) {
          // Hidden main video: don't draw its picture. The base canvas is just
          // bgColor. [0:a] stays untouched so the audio block can still mix it
          // (audio follows `muted`, not `hidden`). [0:v] simply goes unused.
          filterParts.push(`color=c=${bgHex}:s=${evenW}x${evenH}:r=30:d=${totalDur.toFixed(3)}[vscaled]`);
        } else {
          filterParts.push(`color=c=${bgHex}:s=${evenW}x${evenH}:r=30:d=${totalDur.toFixed(3)}[smbg]`);
          filterParts.push(`[0:v]trim=start=${mvSrc.toFixed(3)}:end=${mvSrcEnd},setpts=(PTS-STARTPTS)/${mvSp}+${videoStart}/TB,scale=${mvW}:${mvH},setsar=1${mvCcPart}[smmv]`);
          filterParts.push(`[smbg][smmv]overlay=${mvX}:${mvY}:eof_action=pass:enable='between(t,${videoStart},${videoEnd})'[vscaled]`);
        }
      } else {
        // No "main video" — the bottom-most visible layer in the renderer was
        // an image (or there are no video overlays). Start with a synthetic
        // colour canvas so every layer goes through the overlay chain strictly
        // in z-order. Input [0]'s video stream (if any) is ignored here; the
        // same file is listed in `layers` and renders via its videoOverlay
        // branch at the correct z-position.
        filterParts.push(`color=c=${bgHex}:s=${evenW}x${evenH}:r=30:d=${totalDur.toFixed(3)}[vscaled]`);
      }
      videoStream = '[vscaled]';

      // Multiple clipping masks must UNION (each is its own cookie-cutter hole),
      // not chain destructively. The old per-mask approach gave each mask the
      // pristine base for its "outside shape" region, so the 2nd mask's outside
      // area overwrote the 1st mask's hole with base → the 1st mask vanished on
      // render (intersection instead of union). We now build ONE combined alpha
      // from every mask's shape (each gated by its own time window) and cut
      // once. Pre-split off a single pristine-base copy here; the heavy lifting
      // happens at the first mask in the forEach below.
      const maskLayersAll = (layers || []).filter(l => l.type === 'mask' && !l.hidden);
      const totalMaskCount = maskLayersAll.length;
      let vmaskBaseLbl = null;
      if (totalMaskCount > 0) {
        filterParts.push(`${videoStream}split=2[vscaledSeq][vmaskBase]`);
        videoStream = '[vscaledSeq]';
        vmaskBaseLbl = '[vmaskBase]';
      }

      let blurCount = 0, imgCount = 0, vidovCount = 0, txtCount = 0, zoomCount = 0, maskCount = 0, transCount = 0;
      (layers || []).forEach((layer) => {
        if (layer.type === 'transition') {
          const i = transCount++;
          const ts = Number(layer.startTime) || 0;
          const te = Number(layer.endTime) || ts + 0.3;
          const span = Math.max(0.05, te - ts);
          const kind = layer.kind || 'shake';
          const enableExpr = `enable='between(t,${ts.toFixed(3)},${te.toFixed(3)})'`;

          if (kind === 'shake') {
            // Camera shake (exp-decay) + tblend motion blur + short bloom flash.
            const ampPx = Number(layer.amp) || 30;
            const flashMax = Math.max(0, Math.min(1, layer.flash ?? 0.85));
            const margin = Math.max(0.06, ampPx / Math.min(evenW, evenH) + 0.02);
            const sxScale = (1 + margin * 2);
            const bigW = Math.round(evenW * sxScale);
            const bigH = Math.round(evenH * sxScale);
            // Exponential decay = energetic punch + fast falloff
            const decay = `exp(-3.2*max(0,t-${ts})/${span})`;
            const xExpr = `(${bigW}-${evenW})/2 + (sin((t-${ts})*113)*0.6 + sin((t-${ts})*187)*0.4) * ${ampPx} * ${decay}`;
            const yExpr = `(${bigH}-${evenH})/2 + (cos((t-${ts})*97)*0.6 + cos((t-${ts})*151)*0.4) * ${ampPx} * ${decay}`;
            filterParts.push(`${videoStream}split[trM${i}][trS${i}]`);
            // tblend averages current with previous frame → free motion blur during fast shakes
            filterParts.push(`[trS${i}]scale=${bigW}:${bigH},crop=${evenW}:${evenH}:'${xExpr}':'${yExpr}',tblend=all_mode=average[trShaken${i}]`);
            filterParts.push(`[trM${i}][trShaken${i}]overlay=0:0:${enableExpr}[trAfterShake${i}]`);
            videoStream = `[trAfterShake${i}]`;
            // Punchy short flash (45% of span) with sharp rise and tail
            const flashDur = Math.max(0.05, span * 0.45);
            const fadeIn = Math.max(0.02, flashDur * 0.18);
            const fadeOut = Math.max(0.02, flashDur - fadeIn);
            filterParts.push(`color=c=white:s=${evenW}x${evenH}:r=30:d=${flashDur.toFixed(3)},format=rgba,fade=t=in:st=0:d=${fadeIn.toFixed(3)}:alpha=1,fade=t=out:st=${fadeIn.toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1,setpts=PTS-STARTPTS+${ts.toFixed(3)}/TB,colorchannelmixer=aa=${flashMax.toFixed(3)}[trFlash${i}]`);
            filterParts.push(`${videoStream}[trFlash${i}]overlay=0:0:enable='between(t,${ts.toFixed(3)},${(ts+flashDur).toFixed(3)})'[trDone${i}]`);
            videoStream = `[trDone${i}]`;
          } else if (kind === 'whippan') {
            // Horizontal whip with directional smear + chromatic aberration
            // + tblend motion blur from the fast frame-to-frame displacement.
            const shiftPct = Math.max(0, Math.min(150, Number(layer.shift) || 60));
            const blurSigma = Math.max(0, Number(layer.blur) || 22);
            // Scale wider than canvas so the crop can scroll past the centre.
            const bigW = Math.round(evenW * (1 + shiftPct / 100 * 1.4));
            const xCenter = (bigW - evenW) / 2;
            // sin(0)=0, sin(pi/2)=1, sin(pi)=0 → peak in the middle
            const xExpr = `${xCenter.toFixed(2)} + ${(shiftPct / 100 * evenW).toFixed(2)} * sin((t-${ts})/${span}*${Math.PI.toFixed(5)})`;
            // boxblur=lumaRadius x lumaPower : chromaRadius x chromaPower
            // Big horizontal radius, 0 vertical = directional smear.
            const blurH = Math.max(1, Math.round(blurSigma));
            filterParts.push(`${videoStream}split[trM${i}][trS${i}]`);
            // rgbashift = R/B channel offset (chromatic aberration) before smear,
            // then tblend averages with previous frame for true motion blur during the sweep.
            filterParts.push(`[trS${i}]scale=${bigW}:${evenH},crop=${evenW}:${evenH}:'${xExpr}':0,rgbashift=rh=8:bh=-8:gh=0,boxblur=${blurH}:1:0:0,tblend=all_mode=average[trWhip${i}]`);
            filterParts.push(`[trM${i}][trWhip${i}]overlay=0:0:${enableExpr}[trDone${i}]`);
            videoStream = `[trDone${i}]`;
          } else if (kind === 'zoom') {
            // Zoom punch — pre-scaled copy crossfaded over base, heavy blur
            // + chromatic aberration + brief white impact flash at the peak.
            const scaleMax = Math.max(1.05, Number(layer.scale) || 2);
            const blurSigma = Math.max(4, Number(layer.blur) || 14);
            const zw = Math.round(evenW * scaleMax);
            const zh = Math.round(evenH * scaleMax);
            const halfSpan = span / 2;
            filterParts.push(`${videoStream}split[trM${i}][trS${i}]`);
            filterParts.push(`[trS${i}]scale=${zw}:${zh},crop=${evenW}:${evenH},gblur=sigma=${blurSigma.toFixed(2)},rgbashift=rh=10:bh=-10:gh=0,format=rgba,fade=t=in:st=${ts.toFixed(3)}:d=${halfSpan.toFixed(3)}:alpha=1,fade=t=out:st=${(ts+halfSpan).toFixed(3)}:d=${halfSpan.toFixed(3)}:alpha=1[trZoom${i}]`);
            filterParts.push(`[trM${i}][trZoom${i}]overlay=0:0:${enableExpr}[trAfterZoom${i}]`);
            videoStream = `[trAfterZoom${i}]`;
            // Impact flash: short white pulse centred on the peak
            const flashSpan = Math.max(0.05, span * 0.22);
            const flashStart = ts + (span - flashSpan) / 2;
            filterParts.push(`color=c=white:s=${evenW}x${evenH}:r=30:d=${flashSpan.toFixed(3)},format=rgba,fade=t=in:st=0:d=${(flashSpan*0.4).toFixed(3)}:alpha=1,fade=t=out:st=${(flashSpan*0.4).toFixed(3)}:d=${(flashSpan*0.6).toFixed(3)}:alpha=1,setpts=PTS-STARTPTS+${flashStart.toFixed(3)}/TB,colorchannelmixer=aa=0.32[trZoomFlash${i}]`);
            filterParts.push(`${videoStream}[trZoomFlash${i}]overlay=0:0:enable='between(t,${flashStart.toFixed(3)},${(flashStart+flashSpan).toFixed(3)})'[trDone${i}]`);
            videoStream = `[trDone${i}]`;
          } else if (kind === 'blur') {
            // Blur burst with faux-bloom: heavy gaussian + curves lift on
            // midtones/highlights + saturation pump for that "dreamy glow" feel.
            const blurSigma = Math.max(8, Number(layer.blur) || 30);
            const halfSpan = span / 2;
            filterParts.push(`${videoStream}split[trM${i}][trS${i}]`);
            // gblur (heavy), then curves lift midtone 0.5→0.65 (highlights pop without crushing shadows), then +40% saturation
            filterParts.push(`[trS${i}]gblur=sigma=${blurSigma.toFixed(2)},curves=all='0/0 0.5/0.65 1/1',eq=saturation=1.4,format=rgba,fade=t=in:st=${ts.toFixed(3)}:d=${halfSpan.toFixed(3)}:alpha=1,fade=t=out:st=${(ts+halfSpan).toFixed(3)}:d=${halfSpan.toFixed(3)}:alpha=1[trBlur${i}]`);
            filterParts.push(`[trM${i}][trBlur${i}]overlay=0:0:${enableExpr}[trDone${i}]`);
            videoStream = `[trDone${i}]`;
          } else if (kind === 'seamzoom') {
            // Seamless zoom: per-frame scale ramps 1× → max → 1× via a sine.
            // Implemented with `zoompan` (the one filter whose `z` accepts a
            // time-based expression for video input). `tblend` averages adjacent
            // frames → free radial motion blur from the fast zoom. `rgbashift`
            // gives chromatic aberration. A short white flash centred on the
            // peak hides the actual cut between the two clips.
            const scaleMax = Math.max(1.5, Number(layer.scale) || 4.5);
            const rgb = Math.max(0, Math.round(Number(layer.rgb) || 9));
            const flashMax = Math.max(0, Math.min(1, layer.flash ?? 0.28));
            const K = (scaleMax - 1).toFixed(3);
            const env = `sin((time-${ts})/${span}*${Math.PI.toFixed(5)})`;
            // max(1,...) clamps to no-zoom outside the window (zoompan's z must
            // be ≥ 1; outside the enable, the overlay hides this stream anyway).
            const zExpr = `max(1,1+${K}*${env})`;
            filterParts.push(`${videoStream}split[trM${i}][trS${i}]`);
            filterParts.push(`[trS${i}]zoompan=z='${zExpr}':d=1:s=${evenW}x${evenH}:fps=30:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',rgbashift=rh=${rgb}:bh=${-rgb}:gh=0,tblend=all_mode=average[trSZ${i}]`);
            filterParts.push(`[trM${i}][trSZ${i}]overlay=0:0:${enableExpr}[trAfterSZ${i}]`);
            videoStream = `[trAfterSZ${i}]`;
            // Brief white flash centred on the peak (~25% of span).
            const flashSpan = Math.max(0.05, span * 0.25);
            const flashStart = ts + (span - flashSpan) / 2;
            const fIn = flashSpan * 0.4, fOut = flashSpan - fIn;
            filterParts.push(`color=c=white:s=${evenW}x${evenH}:r=30:d=${flashSpan.toFixed(3)},format=rgba,fade=t=in:st=0:d=${fIn.toFixed(3)}:alpha=1,fade=t=out:st=${fIn.toFixed(3)}:d=${fOut.toFixed(3)}:alpha=1,setpts=PTS-STARTPTS+${flashStart.toFixed(3)}/TB,colorchannelmixer=aa=${flashMax.toFixed(3)}[trSZFlash${i}]`);
            filterParts.push(`${videoStream}[trSZFlash${i}]overlay=0:0:enable='between(t,${flashStart.toFixed(3)},${(flashStart + flashSpan).toFixed(3)})'[trDone${i}]`);
            videoStream = `[trDone${i}]`;
          }
        } else if (layer.type === 'mask') {
          // Hidden layer → no audio for masks, so skip its visual entirely.
          if (layer.hidden) return;
          // ALL clipping masks are composited together at the FIRST mask layer
          // so they UNION (each cuts its own hole) instead of chaining (where
          // the 2nd mask's pristine-base "outside" region erased the 1st mask's
          // hole). Subsequent mask layers are handled here → no-op.
          if (maskCount > 0) { maskCount++; return; }
          maskCount++;
          // vfull = the composite below the masks (base + overlays). Split into
          // two: [vfullUncut] is shown OUTSIDE every mask's time window (overlays
          // uncut); [vfullClip] gets clipped to the union of active shapes.
          filterParts.push(`${videoStream}split=2[vfullUncut][vfullClip]`);
          // Build the combined alpha: start fully black (rgba), then overlay each
          // mask's white shape gated by its own enable window. Result is white
          // inside ANY currently-active shape, black elsewhere — the union.
          filterParts.push(`color=c=black:s=${evenW}x${evenH}:r=30:d=${totalDur.toFixed(3)},format=rgba[mcomb0]`);
          let accAlpha = '[mcomb0]';
          maskLayersAll.forEach((m, k) => {
            const mw = Math.max(2, Math.round((m.width / 100) * evenW));
            const mh = Math.max(2, Math.round((m.height / 100) * evenH));
            const cxPx = Math.round((m.x / 100) * evenW);
            const cyPx = Math.round((m.y / 100) * evenH);
            const x0 = cxPx - mw / 2, y0 = cyPx - mh / 2;
            const x1 = cxPx + mw / 2, y1 = cyPx + mh / 2;
            // no \, escaping inside the single-quoted geq expr.
            let alphaExpr;
            if (m.shape === 'circle') {
              const rx = mw / 2, ry = mh / 2;
              alphaExpr = `if(lte(pow((X-${cxPx})/${rx},2)+pow((Y-${cyPx})/${ry},2),1),255,0)`;
            } else {
              const rPct = m.shape === 'rounded' ? Math.max(0, m.radius || 0) : 0;
              const R = Math.min(mw, mh) / 2 * (rPct / 100);
              const ix0 = x0 + R, iy0 = y0 + R, ix1 = x1 - R, iy1 = y1 - R;
              alphaExpr = `if(lte(pow(X-clip(X,${ix0},${ix1}),2)+pow(Y-clip(Y,${iy0},${iy1}),2),${R * R}),255,0)`;
            }
            const en = `enable='between(t,${m.startTime},${m.endTime})'`;
            // White shape with alpha = shape (transparent outside) so overlaying
            // it onto the accumulator only paints inside the shape.
            filterParts.push(`color=c=white:s=${evenW}x${evenH}:r=30:d=${totalDur.toFixed(3)},format=rgba[mwhite${k}]`);
            filterParts.push(`color=c=black:s=${evenW}x${evenH}:r=30:d=${totalDur.toFixed(3)},format=gray,geq=lum='${alphaExpr}'[mae${k}]`);
            filterParts.push(`[mwhite${k}][mae${k}]alphamerge[mshape${k}]`);
            filterParts.push(`${accAlpha}[mshape${k}]overlay=0:0:${en}[mcomb${k + 1}]`);
            accAlpha = `[mcomb${k + 1}]`;
          });
          // Combined alpha as grayscale (white=255 inside union, black=0 outside).
          filterParts.push(`${accAlpha}format=gray[mcombGray]`);
          // Reveal overlays only inside the union of active shapes.
          filterParts.push(`[vfullClip][mcombGray]alphamerge[mrevealed]`);
          // Cut look = pristine base outside the shapes + revealed overlays inside.
          filterParts.push(`${vmaskBaseLbl}[mrevealed]overlay=0:0[mcut]`);
          // Outside EVERY mask's time window → uncut composite; inside any window → cut look.
          const enUnion = `enable='gt(${maskLayersAll.map(m => `between(t,${m.startTime},${m.endTime})`).join('+')},0)'`;
          filterParts.push(`[vfullUncut][mcut]overlay=0:0:${enUnion}[vmaskFinal]`);
          videoStream = '[vmaskFinal]';
        } else if (layer.type === 'blur') {
          // Hidden layer → blur has no audio, skip its visual entirely.
          if (layer.hidden) return;
          const i = blurCount++;
          // Centre-based coordinates matching getLayerPx in the preview
          const bw = Math.max(2, Math.round((layer.width / 100) * evenW));
          const bh = Math.max(2, Math.round((layer.height / 100) * evenH));
          const x = Math.max(0, Math.round((layer.x / 100) * evenW - bw / 2));
          const y = Math.max(0, Math.round((layer.y / 100) * evenH - bh / 2));
          const w = Math.min(evenW - x, bw);
          const h = Math.min(evenH - y, bh);
          const enable = `enable='between(t,${layer.startTime},${layer.endTime})'`;
          filterParts.push(`${videoStream}split[vb${i}main][vb${i}copy]`);
          filterParts.push(`[vb${i}copy]crop=${w}:${h}:${x}:${y},gblur=sigma=${layer.strength}[vb${i}blurred]`);
          filterParts.push(`[vb${i}main][vb${i}blurred]overlay=${x}:${y}:${enable}[vblur${i}]`);
          videoStream = `[vblur${i}]`;
        } else if (layer.type === 'image') {
          // Hidden layer → image has no audio, skip it entirely (don't even
          // register an ffmpeg input — nothing references it).
          if (layer.hidden) return;
          const i = imgCount++;
          inputArgs.push('-i', layer.file);
          const idx = inputIdx++;
          const x = `(W*${layer.x / 100}-w/2)`;
          const y = `(H*${layer.y / 100}-h/2)`;
          const scaleW = Math.max(2, Math.round((layer.size / 100) * evenW));
          const scaleH = layer.aspect ? Math.max(2, Math.round(scaleW / layer.aspect)) : -1;
          const alpha = layer.opacity / 100;
          const enable = `enable='between(t,${layer.startTime},${layer.endTime})'`;
          filterParts.push(`[${idx}:v]scale=${scaleW}:${scaleH},format=rgba,colorchannelmixer=aa=${alpha}[img${i}]`);
          filterParts.push(`${videoStream}[img${i}]overlay=${x}:${y}:${enable}[vimg${i}]`);
          videoStream = `[vimg${i}]`;
        } else if (layer.type === 'maskedVideo') {
          // Cut-out: scale the video to fill the cut-out box (cover), build an
          // alpha shape, alphamerge, then overlay at the box position.
          const i = vidovCount++;
          inputArgs.push('-i', layer.file);
          const idx = inputIdx++;
          videoOverlayInputs.push({ idx, layer });
          // Hidden layer: KEEP the input + videoOverlayInputs entry (so its
          // audio can still be mixed via [idx:a]), but DON'T draw its picture.
          // videoStream passes through unchanged — no [vmcut] is produced.
          if (layer.hidden) return;
          const mw = Math.max(2, Math.round((layer.width / 100) * evenW));
          const mh = Math.max(2, Math.round((layer.height / 100) * evenH));
          const cxPx = Math.round((layer.x / 100) * evenW);
          const cyPx = Math.round((layer.y / 100) * evenH);
          const bx = cxPx - mw / 2, by = cyPx - mh / 2;
          // geq expression is wrapped in single quotes below, so commas inside
          // it are literal — DO NOT escape them with \, (that breaks the expr
          // parser and the alpha mask comes out fully transparent → no video).
          let alphaExpr;
          if (layer.shape === 'circle') {
            const rx = mw / 2, ry = mh / 2;
            alphaExpr = `if(lte(pow((X-${mw/2})/${rx},2)+pow((Y-${mh/2})/${ry},2),1),255,0)`;
          } else {
            const rPct = layer.shape === 'rounded' ? Math.max(0, layer.radius || 0) : 0;
            const R = Math.min(mw, mh) / 2 * (rPct / 100);
            alphaExpr = `if(lte(pow(X-clip(X,${R},${mw - R}),2)+pow(Y-clip(Y,${R},${mh - R}),2),${R * R}),255,0)`;
          }
          const enable = `enable='between(t,${layer.startTime},${layer.endTime})'`;
          const ovSp = Math.max(0.1, (layer.speed || 100) / 100);
          const ovDur = Math.max(0.1, (layer.endTime ?? totalDur) - (layer.startTime || 0));
          const ovSrc = layer.srcStart || 0;
          const ccB = (layer.ccB || 0); // raw -50..+50
          const ccC = (layer.ccC == null ? 100 : layer.ccC) / 100;
          const ccS = (layer.ccS == null ? 100 : layer.ccS) / 100;
          const ccH = Number(layer.ccH || 0);
          const bMult = 1 + ccB / 100;
          const cmPart = bMult !== 1
            ? `,colorchannelmixer=rr=${bMult.toFixed(3)}:gg=${bMult.toFixed(3)}:bb=${bMult.toFixed(3)}`
            : '';
          const eqPart = (ccC !== 1 || ccS !== 1)
            ? `,eq=contrast=${ccC.toFixed(3)}:saturation=${ccS.toFixed(3)}`
            : '';
          const huePart = ccH !== 0 ? `,hue=h=${ccH.toFixed(2)}` : '';
          const ccPart = cmPart + eqPart + huePart;
          // Trim, retime, then crop the EXACT source region the user picked
          // with the mask (srcCrop) and scale it to the cut-out box. Clamp the
          // crop window to the real input dimensions so ffmpeg doesn't bail
          // when the renderer guessed wrong (e.g. proxy not loaded at Apply).
          let cropPart;
          const probe = mediaProbeMap.get(layer.file) || {};
          const inW = Number(probe.width) > 0 ? Number(probe.width) : null;
          const inH = Number(probe.height) > 0 ? Number(probe.height) : null;
          if (layer.srcCrop && inW && inH) {
            const c = layer.srcCrop;
            let cx = Math.max(0, Math.min(inW - 1, Math.round(c.x)));
            let cy = Math.max(0, Math.min(inH - 1, Math.round(c.y)));
            let cw = Math.max(1, Math.min(inW - cx, Math.round(c.w)));
            let ch = Math.max(1, Math.min(inH - cy, Math.round(c.h)));
            // If srcCrop coords were computed against fake dimensions, scale
            // them back into real input space proportionally (best-effort).
            // We detect this by checking if the requested crop GROSSLY exceeds
            // the file's bounds — only then was it likely measured against an
            // assumed 1920×1080 / 1080×1920 frame. A few px of negative/overflow
            // is just float rounding from the editor and must be CLAMPED, not
            // remapped. (The old check fired on a -0.4 px x — which full-width
            // bottom-bar cut-outs hit constantly — and remapped a perfectly good
            // crop to a wrong/black region, so the cut-out looked gone on render
            // while the preview, which clamps the raw srcCrop, showed it fine.)
            const reqExceeds = (c.x + c.w > inW * 1.5) || (c.y + c.h > inH * 1.5) || (c.x < -2) || (c.y < -2);
            if (reqExceeds) {
              // Renderer probably defaulted to 1920x1080. Rescale srcCrop
              // proportionally to actual dims.
              const assumedW = c.x + c.w > 1080 ? 1920 : 1080;
              const assumedH = c.y + c.h > 1080 ? 1920 : 1080;
              cx = Math.max(0, Math.min(inW - 1, Math.round((c.x / assumedW) * inW)));
              cy = Math.max(0, Math.min(inH - 1, Math.round((c.y / assumedH) * inH)));
              cw = Math.max(1, Math.min(inW - cx, Math.round((c.w / assumedW) * inW)));
              ch = Math.max(1, Math.min(inH - cy, Math.round((c.h / assumedH) * inH)));
            }
            cropPart = `crop=${cw}:${ch}:${cx}:${cy},scale=${mw}:${mh}`;
          } else {
            cropPart = `scale=${mw}:${mh}:force_original_aspect_ratio=increase,crop=${mw}:${mh}`;
          }
          filterParts.push(`[${idx}:v]trim=start=${ovSrc}:end=${(ovSrc + ovDur * ovSp).toFixed(3)},setpts=(PTS-STARTPTS)/${ovSp}+${layer.startTime || 0}/TB,${cropPart}${ccPart},format=rgba[mvfit${i}]`);
          // Alpha mask: alphamerge takes the LUMA (Y) of the 2nd input as the
          // new alpha for the 1st — so we need a grayscale stream where the
          // shape is white (255) and outside is black (0), NOT an alpha-only
          // stream. Use format=gray + geq=lum=...
          filterParts.push(`color=c=black:s=${mw}x${mh}:r=30:d=${totalDur.toFixed(3)},format=gray,geq=lum='${alphaExpr}'[mvmask${i}]`);
          filterParts.push(`[mvfit${i}][mvmask${i}]alphamerge[mvcut${i}]`);
          filterParts.push(`${videoStream}[mvcut${i}]overlay=${bx}:${by}:${enable}[vmcut${i}]`);
          videoStream = `[vmcut${i}]`;
        } else if (layer.type === 'videoOverlay') {
          const i = vidovCount++;
          inputArgs.push('-i', layer.file);
          const idx = inputIdx++;
          videoOverlayInputs.push({ idx, layer });
          // Hidden layer: KEEP the input + videoOverlayInputs entry (so its
          // audio can still be mixed via [idx:a]), but DON'T draw its picture.
          // videoStream passes through unchanged — no [vvidov] is produced.
          if (layer.hidden) return;
          const x = `(W*${layer.x / 100}-w/2)`;
          const y = `(H*${layer.y / 100}-h/2)`;
          const scaleW = Math.max(2, Math.round((layer.size / 100) * evenW));
          const scaleH = layer.aspect ? Math.max(2, Math.round(scaleW / layer.aspect)) : -1;
          const enable = `enable='between(t,${layer.startTime},${layer.endTime})'`;
          const ovSp = Math.max(0.1, (layer.speed || 100) / 100);
          const ovDur = Math.max(0.1, (layer.endTime ?? totalDur) - (layer.startTime || 0));
          const ovSrc = layer.srcStart || 0;
          // Per-video colour correction (Эффекты видео + Свойства) — see
          // the maskedVideo branch above for why brightness goes via
          // colorchannelmixer instead of eq.brightness.
          const ccB = (layer.ccB || 0);
          const ccC = (layer.ccC == null ? 100 : layer.ccC) / 100;
          const ccS = (layer.ccS == null ? 100 : layer.ccS) / 100;
          const ccH = Number(layer.ccH || 0);
          const bMult = 1 + ccB / 100;
          const cmPart = bMult !== 1
            ? `,colorchannelmixer=rr=${bMult.toFixed(3)}:gg=${bMult.toFixed(3)}:bb=${bMult.toFixed(3)}`
            : '';
          const eqPart = (ccC !== 1 || ccS !== 1)
            ? `,eq=contrast=${ccC.toFixed(3)}:saturation=${ccS.toFixed(3)}`
            : '';
          const huePart = ccH !== 0 ? `,hue=h=${ccH.toFixed(2)}` : '';
          const ccPart = cmPart + eqPart + huePart;
          filterParts.push(`[${idx}:v]trim=start=${ovSrc}:end=${(ovSrc + ovDur * ovSp).toFixed(3)},setpts=(PTS-STARTPTS)/${ovSp}+${layer.startTime || 0}/TB,scale=${scaleW}:${scaleH}${ccPart},format=rgba[vov${i}]`);
          filterParts.push(`${videoStream}[vov${i}]overlay=${x}:${y}:${enable}[vvidov${i}]`);
          videoStream = `[vvidov${i}]`;
        } else if (layer.type === 'text') {
          // Hidden layer → text has no audio, skip its visual entirely.
          if (layer.hidden) return;
          if (!layer.text) return;
          const i = txtCount++;
          const hexColor = '0x' + (layer.color || '#ffffff').replace('#', '');
          const align = layer.align || 'center';
          const x = align === 'left' ? `(W*${(layer.x || 50) / 100})`
            : align === 'right' ? `(W*${(layer.x || 50) / 100}-tw)`
            : `(W*${(layer.x || 50) / 100}-tw/2)`;
          const y = `(H*${(layer.y || 50) / 100}-th/2)`;
          const enable = `enable='between(t,${layer.startTime || 0},${layer.endTime || 9999})'`;
          // Write text to a UTF-8 temp file so Cyrillic / Unicode renders correctly
          const tmpTxt = path.join(os.tmpdir(), `smtxt_${Date.now()}_${i}.txt`);
          tmpFiles.push(tmpTxt);
          liveTmpFiles.add(tmpTxt);
          pendingTextWrites.push(fs.promises.writeFile(tmpTxt, layer.text || '', 'utf8').catch(() => {}));
          let fontPart = '';
          if (layer.fontFile && fs.existsSync(layer.fontFile)) {
            // GUARANTEE preview==export font: drawtext/freetype silently fails to
            // open fonts whose path has non-ASCII chars or spaces (e.g.
            // C:\Users\Гена\Desktop\Project 1\…) and falls back to a default face
            // — that's the "render uses a different font" bug. Mirror the subtitle
            // pipeline: copy the EXACT file the preview loaded into a clean ASCII
            // temp path, then point drawtext at that copy.
            let fontForDraw = layer.fontFile;
            try {
              const dest = path.join(os.tmpdir(), `smtxtfont_${Date.now()}_${i}${path.extname(layer.fontFile) || '.ttf'}`);
              fs.copyFileSync(layer.fontFile, dest);
              tmpFiles.push(dest);
              liveTmpFiles.add(dest);
              fontForDraw = dest;
            } catch {}
            fontPart = `:fontfile='${ffPath(fontForDraw)}'`;
          } else {
            fontPart = drawtextFontOption();
          }
          const textSrc = tmpFiles.includes(tmpTxt)
            ? `textfile='${ffPath(tmpTxt)}'`
            : `text='${escapeDrawtext(layer.text)}'`;
          const txtAlpha = Math.max(0, Math.min(1, (layer.opacity == null ? 100 : layer.opacity) / 100));
          filterParts.push(`${videoStream}drawtext=${textSrc}:fontsize=${layer.size || 40}:fontcolor=${hexColor}@${txtAlpha.toFixed(3)}:shadowcolor=black@${(0.85 * txtAlpha).toFixed(3)}:shadowx=2:shadowy=2:x=${x}:y=${y}${fontPart}:${enable}[vtxt${i}]`);
          videoStream = `[vtxt${i}]`;
        } else if (layer.type === 'zoom') {
          // Zoom ramp: 1× → (1+strength) at the midpoint → 1× at the end.
          const zi = zoomCount++;
          const zls = layer.startTime || 0;
          const zle = layer.endTime ?? totalDur;
          const zspan = Math.max(0.1, zle - zls);
          const zstr = Math.max(0, layer.strength || 0) / 100;
          const tri = `if(lt((t-${zls})/${zspan},0.5),2*(t-${zls})/${zspan},2*(1-(t-${zls})/${zspan}))`;
          const factor = `(if(between(t,${zls},${zle}),1+${zstr}*${tri},1))`;
          filterParts.push(`${videoStream}crop=w='iw/${factor}':h='ih/${factor}':x='(iw-iw/${factor})/2':y='(ih-ih/${factor})/2',scale=${evenW}:${evenH}[vzoom${zi}]`);
          videoStream = `[vzoom${zi}]`;
        }
      });

      // Fade in/out on video
      if (fadeIn > 0 || fadeOut > 0) {
        const parts = [];
        if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fadeIn}`);
        if (fadeOut > 0) parts.push(`fade=t=out:st=${Math.max(0, totalDur - fadeOut)}:d=${fadeOut}`);
        filterParts.push(`${videoStream}${parts.join(',')}[vfaded]`);
        videoStream = '[vfaded]';
      }

      // ── Subtitles burn-in (ASS karaoke) ──────────────────────────────
      // Each subtitle layer becomes one ASS file with per-word colored
      // events that mirror the live CapCut-style highlight in the preview.
      // Burned in via the `ass=` filter — the right tool for word karaoke.
      const subtitleLayers = (layers || []).filter(l => l && l.type === 'subtitles' && !l.hidden && Array.isArray(l.segments) && l.segments.length);
      for (let si = 0; si < subtitleLayers.length; si++) {
        const subL = subtitleLayers[si];
        try {
          // Guarantee preview==export font: patch the picked font file's family
          // name to a UNIQUE token, drop the patched copy in an isolated dir, and
          // tell libass to use that token. fontconfig then has exactly one
          // matchable font — no sibling weight, no system-installed copy, and no
          // fuzzy match can hijack it (the old bug: "Arista Pro Thin" rendered as
          // Bold; "Open Sans" picked the Bold file; an installed system copy won).
          let subFontDir = '';
          let fontToken = null;
          const _ff = subL?.style?.fontFile;
          if (_ff) {
            try {
              if (fs.existsSync(_ff)) {
                const isoDir = path.join(os.tmpdir(), `smfont_${Date.now()}_${si}`);
                fs.mkdirSync(isoDir, { recursive: true });
                const token = `StrataSub${si}x${Date.now().toString(36)}`;
                const dest = path.join(isoDir, 'font' + path.extname(_ff));
                if (patchFontFamilyToToken(_ff, dest, token)) {
                  fontToken = token;          // Style will reference this token
                } else {
                  fs.copyFileSync(_ff, dest); // patch failed → at least isolate
                }
                subFontDir = isoDir;
                tmpFontDirs.push(isoDir);
              } else {
                subFontDir = path.dirname(_ff);
              }
            } catch {
              subFontDir = path.dirname(_ff);  // fall back to the whole folder
            }
          }
          const assText = buildAssForSubtitles(subL, evenW, evenH, fontToken);
          const assPath = path.join(os.tmpdir(), `smass_${Date.now()}_${si}.ass`);
          fs.writeFileSync(assPath, assText, 'utf8');
          tmpFiles.push(assPath);
          liveTmpFiles.add(assPath);
          // ffmpeg's `ass=` filter takes a path with the same escaping rules as
          // `subtitles=`. ffPath() handles Windows backslashes + drive colons.
          const assArg = subFontDir
            ? `ass='${ffPath(assPath)}':fontsdir='${ffPath(subFontDir)}'`
            : `ass='${ffPath(assPath)}'`;
          filterParts.push(`${videoStream}${assArg}[vsubs${si}]`);
          videoStream = `[vsubs${si}]`;
        } catch (e) {
          console.warn('[strata] subtitle render skipped:', e?.message || e);
        }
      }
    }

    // Audio: volume on main video + optional audio file layers
    // NOTE: audio follows `muted`, visual follows `hidden`. A `muted` audio
    // layer is dropped from the mix even though a `hidden` one would still play.
    const mvVol = (mainVideoForFilter?.volume ?? 100);
    const audioLayers = (layers || []).filter(l => l.type === 'audio' && !l.muted);
    let audioMap = '0:a?';
    // baseAudio is set by the renderer when input 0 IS an audio file (audio-only
    // project). It carries the real source/timeline split so trimming works.
    const baseAud = payload.baseAudio;

    // Need to also enter the audio block when the main clip's head was
    // trimmed (srcStart > 0) or its start was pushed away from 0 — otherwise
    // ffmpeg copies [0:a] verbatim and audio plays from the source start
    // while video correctly plays from srcStart, so they desync.
    const needMvAudioTrim = mvLayer && (
      (Number(mvLayer.srcStart) || 0) > 0.01 ||
      (Number(videoStart) || 0) > 0.01 ||
      (Number(mvLayer.speed) && Number(mvLayer.speed) !== 100)
    );
    if (mvVol !== 100 || audioLayers.length > 0 || videoOverlayInputs.length > 0 || baseAud || needMvAudioTrim) {
      const baseHasAudio = audioProbeMap.get(payload.file) !== false;
      // audio follows `muted`, visual follows `hidden`: a `muted` main video /
      // base audio still renders its visual (input [0] video) but contributes
      // NO audio — we route input 0's audio to silence so the mix structure
      // (and overlay/audio-layer timing) stays intact.
      const baseMuted = !!(baseAud && payload.baseAudioMuted);
      const mvMuted = !!(mainVideoForFilter && mainVideoForFilter.muted);
      // Base audio — for audio-only projects use baseAudio's real coordinates;
      // for video projects, use the main video's video-range (back-compat).
      // If the base file has no audio stream, synthesise silence so the filter
      // graph remains valid.
      if (baseAud && !baseMuted) {
        const baSrcStart = Math.max(0, Number(baseAud.srcStart) || 0);
        const baLen = Math.max(0.01, Number(baseAud.length) || 1);
        const baSrcEnd = baSrcStart + baLen;
        const baDelayMs = Math.round((Number(baseAud.startTime) || 0) * 1000);
        const baVol = volumeCurve(Number(baseAud.volume) || 100).toFixed(4);
        filterParts.push(`[0:a]atrim=${baSrcStart.toFixed(3)}:${baSrcEnd.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${baDelayMs}:all=1,volume=${baVol}[auMain]`);
      } else if (mvLayer && baseHasAudio && !mvMuted) {
        // [0:a] is the main video's audio — only safe to use as the base mix
        // when there IS a mainVideo (input [0] is conceptually the timeline
        // base). Trim from mvLayer.srcStart for the clip duration so head-trims
        // applied in the editor are honoured here too (same fix as video).
        const mvAtSrc = (Number(mvLayer.srcStart) || 0).toFixed(3);
        const mvAtSrcEnd = ((Number(mvLayer.srcStart) || 0) + Math.max(0.01, videoEnd - videoStart) * mvSp).toFixed(3);
        let atParts = [], atRem = mvSp;
        while (atRem > 2) { atParts.push('atempo=2.0'); atRem /= 2; }
        while (atRem < 0.5) { atParts.push('atempo=0.5'); atRem *= 2; }
        atParts.push(`atempo=${atRem.toFixed(4)}`);
        filterParts.push(`[0:a]atrim=${mvAtSrc}:${mvAtSrcEnd},asetpts=PTS-STARTPTS,${atParts.join(',')},adelay=${Math.round(videoStart*1000)}:all=1,volume=${volumeCurve(mvVol).toFixed(4)}[auMain]`);
      } else {
        filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[auMain]`);
      }
      const mixInputs = ['[auMain]'];
      // Every overlay video carries its own audio, cut to its clip (split-aware).
      // audio follows `muted`, visual follows `hidden`: a `muted` overlay/masked
      // video is still rendered visually (it's in videoOverlayInputs) but its
      // audio is excluded from the mix here.
      videoOverlayInputs.forEach(({ idx, layer }, i) => {
        if (layer.muted) return;
        const oStart = layer.startTime || 0;
        const oEnd = Math.min(layer.endTime ?? totalDur, totalDur);
        const oLen = Math.max(0.1, oEnd - oStart);
        const oSrc = Number(layer.srcStart || 0);
        const oVol = volumeCurve(layer.volume ?? 100);
        const oDelay = Math.round(oStart * 1000);
        const oSp = Math.max(0.1, (layer.speed || 100) / 100);
        const ovHasAudio = audioProbeMap.get(layer.file) !== false;
        if (!ovHasAudio) {
          // Silent overlay — keep the timeline structure intact for amix.
          filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${oLen.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${oDelay}:all=1[auVov${i}]`);
          mixInputs.push(`[auVov${i}]`);
          return;
        }
        let atParts = [], atRem = oSp;
        while (atRem > 2) { atParts.push('atempo=2.0'); atRem /= 2; }
        while (atRem < 0.5) { atParts.push('atempo=0.5'); atRem *= 2; }
        atParts.push(`atempo=${atRem.toFixed(4)}`);
        filterParts.push(`[${idx}:a]atrim=${oSrc.toFixed(3)}:${(oSrc + oLen * oSp).toFixed(3)},asetpts=PTS-STARTPTS,${atParts.join(',')},adelay=${oDelay}:all=1,volume=${oVol.toFixed(4)}[auVov${i}]`);
        mixInputs.push(`[auVov${i}]`);
      });
      audioLayers.forEach((layer, i) => {
        inputArgs.push('-i', layer.file);
        const idx = inputIdx++;
        const aStart = layer.startTime || 0;
        const aEnd = Math.min(layer.endTime ?? totalDur, totalDur);
        const aLen = Math.max(0.1, aEnd - aStart);
        const vol = volumeCurve(layer.volume ?? 100);
        const delayMs = Math.round(aStart * 1000);
        const aSrc = Number(layer.srcStart || 0);
        filterParts.push(`[${idx}:a]atrim=${aSrc.toFixed(3)}:${(aSrc + aLen).toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,volume=${vol.toFixed(4)}[auLayer${i}]`);
        mixInputs.push(`[auLayer${i}]`);
      });
      // Always pass the final audio through aresample to absorb tiny PTS
      // drift from atrim/atempo/adelay chains. Without this, split clips on
      // the timeline accumulate fractional-sample errors → amix sees one
      // input as "ended early" → 2-sec dropout fade-out kicks in and the
      // rest of the audio disappears (the exact symptom of the cut+mask
      // + cut bug). dropout_transition=0 also disables that fade entirely.
      // loudnorm normalizes the final mix to the streaming/broadcast standard
      // -16 LUFS with peaks capped at -1.5 dBTP. This means "naturally quiet"
      // sources (voice files at -40 dB, etc.) come out at a consistent loud
      // level in every export, instead of sounding noticeably quieter than
      // the rest of the project. Single-pass mode — fast enough for export.
      const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
      if (mixInputs.length === 1) {
        filterParts.push(`[auMain]${LOUDNORM},aresample=async=1:first_pts=0[auFinal]`);
      } else {
        filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0,${LOUDNORM},aresample=async=1:first_pts=0[auFinal]`);
      }
      audioMap = '[auFinal]';
    }

    // ── Quality / size — capped relative to the source (max ≤×3, normal ≈
    //    source, fast ≈×0.55), or fully user-defined in custom mode. ──
    const custom = payload.custom || {};
    const srcVideoKbps = (srcMbReal > 0) ? Math.max(200, (srcMbReal * 8192) / srcDurReal - 128) : 0;
    const presetMap = { max: 'slow', normal: 'medium', fast: 'veryfast', custom: 'medium' };
    // custom mode may override the x264 preset (whitelisted) — lets the preview
    // proxy ask for veryfast+low-crf (fast render AND near-lossless quality).
    const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
    const encPreset = (quality === 'custom' && X264_PRESETS.includes(custom.preset)) ? custom.preset : (presetMap[quality] || 'medium');
    const cCrf = (def) => Math.max(1, Math.min(51, Math.round(Number(custom.crf) || def)));
    const cFps = Math.max(0, Math.min(120, Math.round(Number(custom.fps) || 0)));
    let audioKbps = quality === 'fast' ? 128 : 160;
    if (quality === 'custom') audioKbps = Math.max(32, Math.min(512, Number(custom.audioBitrate || 160)));

    const args = [...inputArgs];
    if (filterParts.length) {
      args.push('-filter_complex', filterParts.join(';'));
    }

    if (isAudioOnly) {
      // Audio-only (MP3) export
      args.push('-map', audioMap !== '0:a?' ? audioMap : '0:a');
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', `${quality === 'max' ? 320 : audioKbps}k`);
    } else {
      if (filterParts.length) args.push('-map', videoStream);
      else args.push('-map', '0:v');
      args.push('-map', audioMap);
      // Target video bitrate (0 → fall back to a CRF below).
      let vKbps = 0, maxMul = 1.3;
      if (quality === 'custom' && Number(custom.videoBitrate || 0) > 0) { vKbps = Number(custom.videoBitrate); maxMul = 1.3; }
      else if (quality === 'max' && srcVideoKbps > 0) { vKbps = srcVideoKbps * 2.4; maxMul = 1.25; }
      else if (quality === 'fast' && srcVideoKbps > 0) { vKbps = srcVideoKbps * 0.55; maxMul = 1.45; }
      else if (quality === 'normal' && srcVideoKbps > 0) { vKbps = srcVideoKbps * 0.95; maxMul = 1.3; }
      // -fps_mode cfr forces constant frame rate on output — without this,
      // stacking many overlays with their own setpts shifts produces
      // non-monotonic DTS, which writes a corrupt duration into the moov
      // atom. Players then read garbage as a 64-bit timestamp → "-500
      // hours" / "0 duration" / the file shows the wrong length entirely.
      // cfr regenerates DTS from a fixed clock, so the container is sane.
      if (format === 'webm') {
        args.push('-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '2');
        if (vKbps > 0) { const v = Math.max(300, Math.round(vKbps)); args.push('-b:v', `${v}k`, '-maxrate', `${Math.round(v * maxMul)}k`); }
        else args.push('-crf', String(quality === 'custom' ? cCrf(33) : quality === 'max' ? 28 : quality === 'fast' ? 40 : 33), '-b:v', '0');
        if (quality === 'custom' && cFps > 0) args.push('-r', String(cFps));
        else args.push('-r', '30');
        args.push('-fps_mode', 'cfr');
        args.push('-c:a', 'libopus', '-b:a', `${audioKbps}k`);
      } else {
        args.push('-c:v', 'libx264', '-preset', encPreset);
        if (vKbps > 0) {
          const v = Math.max(300, Math.round(vKbps));
          args.push('-b:v', `${v}k`, '-maxrate', `${Math.round(v * maxMul)}k`, '-bufsize', `${Math.round(v * maxMul * 1.6)}k`);
        } else {
          args.push('-crf', String(quality === 'custom' ? cCrf(23) : quality === 'max' ? 19 : quality === 'fast' ? 27 : 23));
        }
        if (quality === 'custom' && cFps > 0) args.push('-r', String(cFps));
        else args.push('-r', '30');
        args.push('-fps_mode', 'cfr');
        args.push('-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart');
      }
    }
    if (_pr) args.push('-ss', String(_pr.start), '-t', String(renderDur), '-y', outPath);
    else args.push('-t', String(totalDur), '-y', outPath);

    // Make sure every drawtext temp file is on disk BEFORE ffmpeg starts.
    // Otherwise the textfile= references would fail with "no such file".
    Promise.all(pendingTextWrites).then(() => spawnFfmpeg()).catch(() => spawnFfmpeg());

    function spawnFfmpeg() {
    // Background preview-proxy renders (the buffer) emit on a SEPARATE channel
    // so they never collide with the real export's progress UI. Tracked so a
    // stale proxy can be killed (editor:cancelPreview) when the user edits.
    const isPreview = !!(payload && payload.preview);
    const PROG_CH = isPreview ? 'preview-progress' : 'edit-progress';
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    if (isPreview) previewRenderProc = proc;
    let errLog = '';
    proc.stderr?.on('data', (d) => {
      const s = d.toString(); errLog += s;
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && mainWindow) {
        const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        mainWindow.webContents.send(PROG_CH, { percent: Math.min(99, Math.round((secs / renderDur) * 100)) });
      }
    });
    proc.on('close', (code) => {
      if (isPreview && previewRenderProc === proc) previewRenderProc = null;
      cleanupTmps();
      if (mainWindow) mainWindow.webContents.send(PROG_CH, { percent: 100, done: true });
      resolve({ ok: code === 0, error: code !== 0 ? errLog.slice(-1600) : '' });
    });
    proc.on('error', (err) => {
      cleanupTmps();
      resolve({ ok: false, error: String(err) });
    });
    }
    } catch (buildErr) {
      // Building the filter graph threw — clean up temps before bailing.
      cleanupTmps();
      resolve({ ok: false, error: 'Сбой построения фильтра: ' + String(buildErr && buildErr.message || buildErr) });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUBTITLES (Groq Whisper API)
// ─────────────────────────────────────────────────────────────────────────────
// Auto-generated word-level subtitles via Groq's hosted whisper-large-v3.
// Free tier is generous (~14400 transcription seconds/day). Key embedded in
// process.env.GROQ_API_KEY — for dev set via Windows User env, for production
// build it gets baked into the binary (the user doesn't see or manage it,
// CapCut-style UX).
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MAX_FILE_BYTES = 25 * 1024 * 1024;     // Groq hard limit: 25MB
const SUBTITLE_MAX_SECONDS = 25 * 60;             // Refuse projects > 25 min

// Read the key baked into the build at package time (electron/groq-key.json,
// written by scripts/bake-groq-key.cjs). Cached after first read. This is the
// fallback that makes subtitles/transcription work for end users who don't have
// a GROQ_API_KEY env var on their machine.
let _bakedGroqKey = null;
function bakedGroqKey() {
  if (_bakedGroqKey !== null) return _bakedGroqKey;
  _bakedGroqKey = '';
  try {
    const p = path.join(__dirname, 'groq-key.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    _bakedGroqKey = String(parsed.key || '').trim();
  } catch { /* file absent in dev — fine, env var covers it */ }
  return _bakedGroqKey;
}

function groqApiKey() {
  return process.env.GROQ_API_KEY || bakedGroqKey();
}

// Build a mono 16kHz MP3 of the entire project audio mix. This is what we
// send to Whisper — minimal size, maximum accuracy. Mirrors the audio-graph
// logic from video:edit but drops video, volume curves and loudnorm (we want
// the audio as natural as possible for STT; volume balance doesn't matter).
async function extractMixedAudioForTranscription(payload, outPath, onProgress) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('FFmpeg не найден');
  const { file: mainFile, videoStart = 0, videoEnd = 0, totalDuration = 0, layers = [], mainVideo, baseAudio } = payload || {};
  const totalDur = Math.max(0.1, totalDuration);

  // Probe every audio source so we don't reference a silent stream in the
  // filter graph (which crashes ffmpeg with "Stream specifier matches no streams").
  const audioProbeMap = new Map();
  const probeFiles = new Set();
  if (mainFile) probeFiles.add(mainFile);
  for (const l of layers) {
    // maskedVideo (Вырезка) carries audio too — the export mixes it in, so the
    // transcription MUST as well, or speech inside a cut-out clip never reaches
    // Whisper and that clip gets no subtitles (was the "subs missing in the
    // middle / on some videos" bug).
    if (l && l.file && (l.type === 'videoOverlay' || l.type === 'maskedVideo' || l.type === 'audio')) probeFiles.add(l.file);
  }
  await Promise.all([...probeFiles].map(async (f) => {
    try { const p = await probeMediaInfo(ffmpeg, f); audioProbeMap.set(f, !!p.hasAudio); }
    catch { audioProbeMap.set(f, false); }
  }));

  const inputArgs = [];
  const filterParts = [];
  const mixInputs = [];
  let inputIdx = 0;

  // Input 0 is always the main file (mainVideo or baseAudio source).
  if (mainFile) {
    inputArgs.push('-i', mainFile);
    inputIdx = 1;
  }

  // Base audio (audio-only project: input 0 IS an audio file).
  if (baseAudio && audioProbeMap.get(mainFile)) {
    const baSrcStart = Math.max(0, Number(baseAudio.srcStart) || 0);
    const baLen = Math.max(0.01, Number(baseAudio.length) || 1);
    const baSrcEnd = baSrcStart + baLen;
    const baDelayMs = Math.round((Number(baseAudio.startTime) || 0) * 1000);
    filterParts.push(`[0:a]atrim=${baSrcStart.toFixed(3)}:${baSrcEnd.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${baDelayMs}:all=1[auBase]`);
    mixInputs.push('[auBase]');
  } else if (mainVideo && audioProbeMap.get(mainFile)) {
    // Main video's audio — trimmed + tempo-adjusted + delayed like in video:edit.
    const mvSrc = Number(mainVideo.srcStart) || 0;
    const mvSp = Math.max(0.1, (mainVideo.speed || 100) / 100);
    const clipDur = Math.max(0.01, videoEnd - videoStart);
    const mvSrcEnd = mvSrc + clipDur * mvSp;
    const delayMs = Math.round(videoStart * 1000);
    const atParts = [];
    let atRem = mvSp;
    while (atRem > 2) { atParts.push('atempo=2.0'); atRem /= 2; }
    while (atRem < 0.5) { atParts.push('atempo=0.5'); atRem *= 2; }
    atParts.push(`atempo=${atRem.toFixed(4)}`);
    filterParts.push(`[0:a]atrim=${mvSrc.toFixed(3)}:${mvSrcEnd.toFixed(3)},asetpts=PTS-STARTPTS,${atParts.join(',')},adelay=${delayMs}:all=1[auMain]`);
    mixInputs.push('[auMain]');
  }

  // Video-overlay AND cut-out (maskedVideo) audio — mirror the export mix, which
  // routes both through videoOverlayInputs. Skip `muted` clips: their audio is
  // dropped from the final video, so subtitling their speech would caption sound
  // the viewer never hears.
  const vovLayers = (layers || []).filter(l => l && (l.type === 'videoOverlay' || l.type === 'maskedVideo') && l.file && !l.muted);
  vovLayers.forEach((l, i) => {
    if (!audioProbeMap.get(l.file)) return;  // silent overlay — skip
    inputArgs.push('-i', l.file);
    const idx = inputIdx++;
    const oStart = l.startTime || 0;
    const oEnd = l.endTime ?? totalDur;
    const oLen = Math.max(0.1, oEnd - oStart);
    const oSrc = Number(l.srcStart || 0);
    const oSp = Math.max(0.1, (l.speed || 100) / 100);
    const delayMs = Math.round(oStart * 1000);
    const atParts = [];
    let atRem = oSp;
    while (atRem > 2) { atParts.push('atempo=2.0'); atRem /= 2; }
    while (atRem < 0.5) { atParts.push('atempo=0.5'); atRem *= 2; }
    atParts.push(`atempo=${atRem.toFixed(4)}`);
    filterParts.push(`[${idx}:a]atrim=${oSrc.toFixed(3)}:${(oSrc + oLen * oSp).toFixed(3)},asetpts=PTS-STARTPTS,${atParts.join(',')},adelay=${delayMs}:all=1[auV${i}]`);
    mixInputs.push(`[auV${i}]`);
  });

  // Pure audio layers (skip muted — matches the export mix).
  const audLayers = (layers || []).filter(l => l && l.type === 'audio' && l.file && !l.muted);
  audLayers.forEach((l, i) => {
    if (!audioProbeMap.get(l.file)) return;
    inputArgs.push('-i', l.file);
    const idx = inputIdx++;
    const aStart = l.startTime || 0;
    const aEnd = l.endTime ?? totalDur;
    const aLen = Math.max(0.1, aEnd - aStart);
    const aSrc = Number(l.srcStart || 0);
    const delayMs = Math.round(aStart * 1000);
    filterParts.push(`[${idx}:a]atrim=${aSrc.toFixed(3)}:${(aSrc + aLen).toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[auA${i}]`);
    mixInputs.push(`[auA${i}]`);
  });

  if (mixInputs.length === 0) {
    throw new Error('В проекте нет аудио для распознавания (все слои без звука)');
  }

  if (mixInputs.length === 1) {
    filterParts.push(`${mixInputs[0]}aresample=async=1[afin]`);
  } else {
    filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0,aresample=async=1[afin]`);
  }

  const args = [
    ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[afin]',
    '-vn',
    '-ac', '1',           // mono — Whisper prefers it
    '-ar', '16000',       // 16kHz — Whisper's native rate (smaller file, same quality)
    '-c:a', 'libmp3lame',
    '-b:a', '64k',        // tiny file — keeps us well under Groq's 25MB cap
    '-t', String(totalDur),
    '-y', outPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m && onProgress) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress(Math.min(99, (t / totalDur) * 100));
      }
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg код ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// POST the mp3 to Groq's Whisper endpoint and return word-level segments.
// Uses native fetch + FormData (Node 18+ / Electron's bundled Node). The
// response format `verbose_json` + `timestamp_granularities[]=word` gives
// per-word start/end timing — required for the CapCut-style highlight.
async function transcribeWithGroq(audioPath, { language, signal } = {}) {
  const apiKey = groqApiKey();
  if (!apiKey) throw new Error('Groq API ключ не настроен. Свяжись с поддержкой.');

  const fileData = await fs.promises.readFile(audioPath);
  if (fileData.length > GROQ_MAX_FILE_BYTES) {
    throw new Error('Аудио слишком большое после сжатия (>25МБ). Сократи длительность проекта.');
  }

  // Browser-compatible Blob + FormData are global in Electron's main process
  // since Node 18 / fetch landed natively. No extra deps needed.
  const blob = new Blob([fileData], { type: 'audio/mpeg' });
  const form = new FormData();
  form.append('file', blob, path.basename(audioPath));
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  // Only pin the language when the user explicitly picked one. Default ('auto'
  // / empty) lets Whisper DETECT it — forcing the wrong language (e.g. 'ru' on
  // Portuguese speech) makes it hallucinate a credit line instead of
  // transcribing. Auto-detect handles ru/pt/en/es/… correctly.
  if (language && language !== 'auto') form.append('language', language);
  // `temperature=0` makes it deterministic — same audio → same transcript.
  form.append('temperature', '0');

  let res;
  try {
    res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch (e) {
    throw new Error('Не удалось подключиться к Groq (нужен интернет): ' + (e.message || e));
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    if (res.status === 401) throw new Error('Groq API ключ недействителен (401).');
    if (res.status === 429) throw new Error('Превышен дневной лимит Groq. Попробуй позже.');
    throw new Error(`Groq API ошибка ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  // Whisper returns { text, words: [{ word, start, end }], segments: [...] }
  // Group words into phrases of ~5 words (or ~3.5 seconds, whichever first)
  // for a CapCut-style display. The renderer can later split/merge these.
  const words = Array.isArray(data.words) ? data.words.map(w => ({
    start: Number(w.start) || 0,
    end: Number(w.end) || 0,
    text: String(w.word || '').trim(),
  })).filter(w => w.text) : [];

  // Per-segment quality metrics — Whisper's own signals for "this is silence /
  // a hallucination". Used downstream to drop made-up phrases like the infamous
  // "Субтитры сделал DimaTorzok" that the model emits on speechless audio.
  const segments = Array.isArray(data.segments) ? data.segments.map(s => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text || ''),
    noSpeech: Number(s.no_speech_prob) || 0,
    avgLogprob: Number(s.avg_logprob) || 0,
    compression: Number(s.compression_ratio) || 0,
  })) : [];

  return { text: String(data.text || '').trim(), words, segments, raw: data };
}

// Known Whisper "silence hallucinations" — credit lines / sign-offs baked into
// the model's YouTube training data that it emits when the audio has NO speech.
// These are never legitimate content in a user's short clip, so we drop them.
const HALLUCINATION_RE = /субтитр\w*\s*(сделал|подготов\w*|создал|правил|редактир\w*|выполн\w*|by)|редактор\s+субтитр|коррект[оа]р|продолжение\s+следует|спасибо\s+за\s+(просмотр|внимание|подписку)|подпис(ывайтесь|ывайся|ка|ь)|ставьте\s+лайк|dimatorzok|игорь\s+негода|amara\.?\s*org|subtitles?\s+by|thanks?\s+for\s+watching|please\s+subscribe/i;

function isHallucinatedSegment(seg) {
  if (!seg) return false;
  const t = String(seg.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t && HALLUCINATION_RE.test(t)) return true;     // known credit/sign-off phrase
  if (seg.noSpeech >= 0.6) return true;               // Whisper itself flags silence
  if (seg.compression >= 2.4) return true;            // repetitive loop hallucination
  if (seg.avgLogprob <= -1.0) return true;            // very low confidence
  return false;
}

// Keep only words that fall inside a real-speech segment. Returns [] when the
// model produced nothing but hallucinations (all segments bad) — the caller then
// reports "no speech" instead of showing a made-up credit line as a subtitle.
function filterHallucinatedWords(words, segments) {
  if (!Array.isArray(words) || !words.length) return [];
  if (!Array.isArray(segments) || !segments.length) {
    const joined = words.map(w => w.text).join(' ');
    return HALLUCINATION_RE.test(joined) ? [] : words;
  }
  const goodRanges = segments.filter(s => !isHallucinatedSegment(s)).map(s => [s.start, s.end]);
  if (!goodRanges.length) return [];
  return words.filter(w => {
    const mid = ((Number(w.start) || 0) + (Number(w.end) || 0)) / 2;
    return goodRanges.some(([a, b]) => mid >= a - 0.15 && mid <= b + 0.15);
  });
}

// Pack a flat word stream into phrase-sized subtitle segments.
// Rule: new segment when (a) the word starts > 0.8s after the prev one ends
// (pause), OR (b) we'd exceed 7 words / 3.5s in the current segment.
function packWordsToSegments(words) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const segs = [];
  let cur = null;
  const MAX_WORDS = 7;
  const MAX_SEG_DUR = 3.5;
  const PAUSE_GAP = 0.8;
  for (const w of words) {
    if (!cur) {
      cur = { startTime: w.start, endTime: w.end, words: [w] };
      continue;
    }
    const gap = w.start - cur.endTime;
    const segDur = w.end - cur.startTime;
    if (gap > PAUSE_GAP || cur.words.length >= MAX_WORDS || segDur > MAX_SEG_DUR) {
      segs.push(cur);
      cur = { startTime: w.start, endTime: w.end, words: [w] };
    } else {
      cur.words.push(w);
      cur.endTime = w.end;
    }
  }
  if (cur) segs.push(cur);
  // Give each segment a stable id and a denormalized text field for the editor.
  return segs.map((s, i) => ({
    id: 'sub_' + Date.now().toString(36) + '_' + i,
    startTime: s.startTime,
    endTime: s.endTime,
    text: s.words.map(w => w.text).join(' '),
    words: s.words,
  }));
}

ipcMain.handle('subtitles:generate', async (event, payload) => {
  const totalDuration = Number(payload?.totalDuration || 0);
  if (totalDuration > SUBTITLE_MAX_SECONDS) {
    const mins = Math.ceil(totalDuration / 60);
    return { ok: false, error: `Проект слишком длинный (${mins} мин). Лимит — 25 минут. Обрежь или раздели на части.` };
  }

  const tmpAudio = path.join(os.tmpdir(), `smsub_${Date.now()}.mp3`);
  liveTmpFiles.add(tmpAudio);
  const cleanup = () => { try { fs.unlinkSync(tmpAudio); } catch {} liveTmpFiles.delete(tmpAudio); };

  const emit = (info) => {
    try { event.sender.send('subtitles:progress', info); } catch {}
  };

  try {
    emit({ phase: 'extract', percent: 0 });
    await extractMixedAudioForTranscription(payload, tmpAudio, (p) => {
      // Audio extraction is ~30% of total perceived time (ffmpeg local, fast).
      emit({ phase: 'extract', percent: Math.round(p * 0.30) });
    });

    emit({ phase: 'upload', percent: 30 });
    const { text, words, segments: rawSegments } = await transcribeWithGroq(tmpAudio, { language: payload?.language || 'auto' });

    emit({ phase: 'pack', percent: 95 });
    // Drop hallucinated / silence segments BEFORE packing so made-up credit
    // lines never become subtitles.
    const cleanWords = filterHallucinatedWords(words, rawSegments);
    const segments = packWordsToSegments(cleanWords);

    cleanup();
    if (segments.length === 0) {
      emit({ phase: 'error', error: 'Речь не распознана. В аудио нет чёткой речи — возможно там только музыка/шум, или в видео нет голоса.' });
      return { ok: false, error: 'Речь не распознана. В аудио нет чёткой речи — возможно там только музыка/шум, или в видео нет голоса.' };
    }
    emit({ phase: 'done', percent: 100 });
    return { ok: true, segments, fullText: text };
  } catch (e) {
    cleanup();
    emit({ phase: 'error', error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
});

// Standalone speech-to-text. Unlike subtitles:generate (which mixes the whole
// project audio graph), this transcribes ONE picked file directly — the user
// just wants to read the words spoken in a video. Same Groq Whisper backend,
// same hallucination filtering, returns the full plain-text transcript.
ipcMain.handle('transcribe:file', async (event, payload) => {
  const file = payload?.file;
  const language = payload?.language || 'auto';
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'Файл не найден' };

  const emit = (info) => { try { event.sender.send('transcribe:progress', info); } catch {} };
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ok: false, error: 'FFmpeg не найден' };

  let info = null;
  try { info = await probeMediaInfo(ffmpeg, file); } catch {}
  if (!info || !info.hasAudio) return { ok: false, error: 'В файле нет звуковой дорожки — распознавать нечего.' };
  const dur = Number(info.duration || 0);
  if (dur > SUBTITLE_MAX_SECONDS) {
    const mins = Math.ceil(dur / 60);
    return { ok: false, error: `Видео слишком длинное (${mins} мин). Лимит — 25 минут.` };
  }

  const tmpAudio = path.join(os.tmpdir(), `smtr_${Date.now()}.mp3`);
  liveTmpFiles.add(tmpAudio);
  const cleanup = () => { try { fs.unlinkSync(tmpAudio); } catch {} liveTmpFiles.delete(tmpAudio); };

  try {
    emit({ phase: 'extract', percent: 0 });
    await new Promise((resolve, reject) => {
      // Mono 16kHz mp3 — Whisper's native format, tiny file, well under the cap.
      const args = ['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', '-y', tmpAudio];
      const proc = spawn(ffmpeg, args, { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', d => {
        const s = d.toString(); stderr += s;
        const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m && dur > 0) {
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          emit({ phase: 'extract', percent: Math.min(30, Math.round((t / dur) * 30)) });
        }
      });
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg код ${code}: ${stderr.slice(-200)}`)));
    });

    emit({ phase: 'upload', percent: 35 });
    const { text, words, segments: rawSegments } = await transcribeWithGroq(tmpAudio, { language });
    emit({ phase: 'pack', percent: 95 });
    const cleanWords = filterHallucinatedWords(words, rawSegments);
    const segments = packWordsToSegments(cleanWords);
    cleanup();

    const fullText = (String(text || '').trim()) || segments.map(s => s.text).join(' ').trim();
    if (!fullText) {
      emit({ phase: 'error', error: 'Речь не распознана.' });
      return { ok: false, error: 'Речь не распознана — возможно в видео только музыка или шум.' };
    }
    emit({ phase: 'done', percent: 100 });
    return { ok: true, fullText, segments };
  } catch (e) {
    cleanup();
    emit({ phase: 'error', error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
});

// Font list cached after the first read — C:/Windows/Fonts changes rarely
// and the dir is large (1000+ files). Cache survives until app quits.
let _fontsCache = null;
// Bundled fonts ship inside the app under assets/fonts/. They appear at the
// top of the picker (prefixed with ★) and are guaranteed to render the same
// across Windows/Mac since they're not relying on the OS font directory.
// All four — Open Sans, Poppins, Source Sans 3, Montserrat — have full
// Cyrillic + Latin coverage and are SIL OFL / Apache 2.0 licensed (safe to
// distribute with the app).
// Parse a weight/style suffix from "Family-Weight" or "family_weight" filenames.
// Returns "" for Regular (omitted), or e.g. "Bold", "Italic", "Bold Italic".
// Handles common abbreviations Reg/Bol/Ita that ITC/URW fonts use.
function parseFontVariant(base) {
  const m = base.split(/[-_]/).slice(1).join(' ').trim();
  if (!m) return '';
  const norm = m.toLowerCase().replace(/\s+/g, '');
  const direct = { reg: '', regular: '', bol: 'Bold', bold: 'Bold', ita: 'Italic',
    italic: 'Italic', boldita: 'Bold Italic', regita: 'Italic', italicbold: 'Bold Italic',
    medium: 'Medium', light: 'Light', thin: 'Thin', black: 'Black',
    semibold: 'SemiBold', demibold: 'DemiBold', extralight: 'ExtraLight',
    hairline: 'Hairline', fat: 'Fat', extrabold: 'ExtraBold' };
  if (norm in direct) return direct[norm];
  // Multi-token fallback: split CamelCase + spaces, map each, drop unknowns.
  return m.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/)
    .map(w => direct[w.toLowerCase()] !== undefined ? direct[w.toLowerCase()] : w.charAt(0).toUpperCase() + w.slice(1))
    .filter(Boolean).join(' ');
}

// Prettify a filename family key for display: CamelCase + digit boundaries →
// spaced, each word capitalised. "AristaPro"→"Arista Pro", "SourceSans3"→
// "Source Sans 3", "boorsok"→"Boorsok".
function prettyFamilyName(key) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
// Order weights light→heavy for the weight picker.
const VARIANT_ORDER = ['Hairline', 'Thin', 'ExtraLight', 'Light', 'Regular', 'Medium',
  'SemiBold', 'DemiBold', 'Bold', 'ExtraBold', 'Fat', 'Black', 'Italic', 'Bold Italic'];

// GROUP bundled fonts BY FAMILY (one picker entry per family ≈15, not per weight
// file). Each family lists its weight variants; the weight is chosen separately.
// The family KEY comes from the filename (split before the first -/_) so all
// weights of a family group together regardless of their internal name-table.
function listBundledFonts() {
  const dir = appPath('assets', 'fonts');
  try {
    if (!fs.existsSync(dir)) return [];
    const byFamily = new Map();
    for (const f of fs.readdirSync(dir).filter(f => /\.(ttf|otf)$/i.test(f))) {
      const fullPath = path.join(dir, f);
      const base = path.basename(f, path.extname(f));
      const key = base.split(/[-_]/)[0];
      const label = parseFontVariant(base) || 'Regular';
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push({ label, file: fullPath });
    }
    const fams = [...byFamily.entries()].map(([key, variants]) => {
      variants.sort((a, b) => {
        const ia = VARIANT_ORDER.indexOf(a.label), ib = VARIANT_ORDER.indexOf(b.label);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
      });
      const def = variants.find(v => v.label === 'Regular') || variants[0];
      return { family: key, name: '★ ' + prettyFamilyName(key), file: def.file, variants };
    });
    return fams.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

ipcMain.handle('fonts:list', async () => {
  if (_fontsCache) return _fontsCache;
  // Only the curated bundled families — no OS fonts (the picker was drowning in
  // hundreds of system fonts). Each entry is a family with its weight variants.
  _fontsCache = listBundledFonts();
  return _fontsCache;
});

ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Выбери папку', properties: ['openDirectory'] });
  if (result.canceled) return '';
  return result.filePaths[0];
});

// Stable temp path for the background preview-proxy render (the YouTube-style
// buffer). The renderer hands this to video:edit as a low-res output; ffmpeg's
// progress drives the "buffered" bar. `n` lets us avoid clobbering a file that's
// still being read while a fresh render starts.
ipcMain.handle('editor:previewProxyPath', (_e, n) => {
  return path.join(os.tmpdir(), `strata_preview_proxy_${Number(n) || 0}.mp4`);
});
// Tracks the currently-running background preview-proxy ffmpeg so an edit can
// kill it (the timeline changed → the half-rendered buffer is stale).
let previewRenderProc = null;
ipcMain.handle('editor:cancelPreview', () => {
  try { previewRenderProc?.kill('SIGKILL'); } catch {}
  previewRenderProc = null;
  return true;
});

ipcMain.handle('folder:open', async (_event, folder) => {
  if (folder && fs.existsSync(folder)) await shell.openPath(folder);
});

ipcMain.handle('file:reveal', async (_event, filePath) => {
  try { if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath); } catch {}
  return true;
});

ipcMain.handle('system:detectRender', async () => {
  const ffmpeg = findFfmpeg();
  const system = getSystemInfo();
  const acceleration = await detectAcceleration(ffmpeg);
  return {
    ffmpeg,
    system,
    acceleration,
    recommended: chooseEncoder({ hardwareAccel: 'auto' }, acceleration),
    recommendedParallel: autoParallelJobs({ parallelJobs: 'auto', processingProfile: 'balance' }, 3)
  };
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  const safe = String(url || '');
  if (/^https?:\/\//i.test(safe)) await shell.openExternal(safe);
  return true;
});

ipcMain.handle('process:stop', async () => {
  stopRequested = true;
  // Kill every running ffmpeg — parallel job workers each have their own
  // proc and stopping should halt all of them, not just the most recent.
  for (const p of activeProcs) { try { p.kill('SIGTERM'); } catch {} }
  return true;
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function safeName(file) {
  return path.basename(file, path.extname(file)).replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_');
}

function outputMark(settings) {
  const mark = String(settings.outputSuffix ?? '_SM').trim();
  if (!mark) return '';
  return mark.replace(/[<>:"\/\\|?*]+/g, '_').replace(/\s+/g, '_');
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; i < 9999; i++) {
    const p = path.join(dir, `${base}_${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return filePath;
}

function fileSizeMb(file) {
  try { return fs.existsSync(file) ? fs.statSync(file).size / (1024 * 1024) : 0; } catch { return 0; }
}

function getSystemInfo() {
  return {
    cpuCores: Math.max(1, os.cpus()?.length || 1),
    ramGb: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
    platform: process.platform
  };
}

// Cache encoders & acceleration once per app session — ffmpeg's encoder
// list never changes at runtime, so the 1–8 sec spawn was pure waste.
let _encodersCache = null;
let _accelCache = null;
function readEncoders(ffmpeg) {
  if (_encodersCache != null) return Promise.resolve(_encodersCache);
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => out += d.toString());
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 8000);
    proc.on('close', () => { clearTimeout(timer); _encodersCache = out; resolve(out); });
    proc.on('error', () => { clearTimeout(timer); _encodersCache = ''; resolve(''); });
  });
}

async function detectAcceleration(ffmpeg) {
  if (_accelCache) return _accelCache;
  const enc = await readEncoders(ffmpeg);
  const has = (name) => new RegExp(`\\b${name}\\b`, 'i').test(enc);
  _accelCache = {
    nvidia: has('h264_nvenc'),
    intel: has('h264_qsv'),
    amd: has('h264_amf'),
    cpu: true
  };
  return _accelCache;
}

function chooseEncoder(settings, acceleration) {
  const requested = String(settings.hardwareAccel || 'auto').toLowerCase();
  const map = { nvidia: 'h264_nvenc', intel: 'h264_qsv', amd: 'h264_amf', cpu: 'libx264' };
  if (requested !== 'auto' && requested !== 'cpu') {
    if (acceleration[requested]) return { type: requested, codec: map[requested], fallback: false };
    return { type: 'cpu', codec: 'libx264', fallback: true, requested };
  }
  if (requested === 'cpu') return { type: 'cpu', codec: 'libx264', fallback: false };
  if (acceleration.nvidia) return { type: 'nvidia', codec: map.nvidia, fallback: false };
  if (acceleration.intel) return { type: 'intel', codec: map.intel, fallback: false };
  if (acceleration.amd) return { type: 'amd', codec: map.amd, fallback: false };
  return { type: 'cpu', codec: 'libx264', fallback: false };
}

function autoParallelJobs(settings, filesCount = 1) {
  const raw = settings.parallelJobs;
  if (raw !== 'auto' && raw !== 0 && raw !== undefined && raw !== null) return Math.max(1, Math.min(3, Number(raw) || 1));
  const sys = getSystemInfo();
  const profile = settings.resourceMode || settings.processingProfile || 'balance';
  if (settings.backgroundMode || profile === 'background') return 1;
  if (profile === 'max') return Math.max(1, Math.min(filesCount, sys.cpuCores >= 12 && sys.ramGb >= 16 ? 3 : 2));
  return Math.max(1, Math.min(filesCount, sys.cpuCores >= 8 && sys.ramGb >= 8 ? 2 : 1));
}

function encoderLabel(render) {
  const labels = { cpu: 'CPU / libx264', nvidia: 'NVIDIA NVENC', intel: 'Intel QuickSync', amd: 'AMD AMF' };
  return labels[render?.type] || 'CPU / libx264';
}

function humanFfmpegError(output = '') {
  const o = String(output).toLowerCase();
  if (o.includes('no such file') || o.includes('cannot find')) return 'файл или путь не найден';
  if (o.includes('permission denied') || o.includes('access is denied')) return 'нет доступа к файлу или папке сохранения';
  if (o.includes('invalid data') || o.includes('moov atom not found')) return 'файл повреждён или не читается';
  if (o.includes('encoder') && (o.includes('not found') || o.includes('unknown encoder'))) return 'выбранный кодировщик не поддерживается';
  if (o.includes('no space') || o.includes('not enough space')) return 'недостаточно места на диске';
  if (o.includes('filter') || o.includes('invalid argument')) return 'ошибка фильтра обработки видео';
  return 'ошибка обработки видео';
}

function hasVisualChanges(settings) {
  return !!(
    settings.size !== 'original' || settings.format !== 'original' || settings.useCustomSize ||
    settings.trimEnabled || settings.textWatermarkEnabled || settings.imageWatermarkEnabled ||
    settings.noiseEnabled || settings.microzoomEnabled ||
    Number(settings.brightness || 0) !== 0 || Number(settings.contrast || 100) !== 100 ||
    Number(settings.saturation || 100) !== 100 || Number(settings.sharpness || 0) > 0 ||
    Math.abs(Number(settings.speed || 100) - 100) > 0.001
  );
}

function parseProgressTime(line) {
  if (line.startsWith('out_time_ms=')) {
    const v = Number(line.split('=')[1]);
    return Number.isFinite(v) ? v / 1000000 : null;
  }
  if (line.startsWith('out_time=')) {
    const t = line.split('=')[1]?.trim();
    const m = t && t.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

function parseDuration(output) {
  const m = String(output).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseVideoSize(output) {
  const m = String(output).match(/Video:.*?(\d{2,5})x(\d{2,5})/i);
  if (!m) return { width: null, height: null };
  return { width: Number(m[1]), height: Number(m[2]) };
}

// Cache probe results by file path + mtime — invalidates if the source file
// changes underneath us. Drops the entry after 5 minutes of inactivity so a
// long-running app doesn't hoard memory.
const probeCache = new Map();
const PROBE_TTL_MS = 5 * 60 * 1000;
function probeMediaInfo(ffmpeg, file) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs | 0; } catch {}
  const cacheKey = file + '|' + mtime;
  const hit = probeCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < PROBE_TTL_MS) {
    return Promise.resolve(hit.info);
  }
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let out = '';
    p.stderr.on('data', d => out += d.toString());
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => {
      const sz = parseVideoSize(out);
      const info = { duration: parseDuration(out), hasAudio: /Audio:/i.test(out), width: sz.width, height: sz.height, raw: out };
      probeCache.set(cacheKey, { ts: Date.now(), info });
      resolve(info);
    });
    p.on('error', (err) => resolve({ duration: null, hasAudio: false, width: null, height: null, raw: String(err) }));
  });
}

function escapeDrawtext(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

function ffPath(p) { return String(p || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/'/g, "\\'"); }

// Read a font file's REAL internal family name (TrueType/OpenType `name`
// table). Critical for subtitle export: the renderer's font list derives its
// display name from the FILENAME (arial.ttf → "Arial", ARIALBD.TTF →
// "Arialbd", seguiemj.ttf → "Seguiemj"), which often does NOT match the name
// libass/fontconfig needs. Feeding the wrong name makes libass silently fall
// back to a default font, so the export looks nothing like the preview. We
// parse the file once (cached) and hand libass the name it actually indexes.
const _fontNameCache = new Map();
function readFontFamilyName(fontFile) {
  if (!fontFile) return null;
  if (_fontNameCache.has(fontFile)) return _fontNameCache.get(fontFile);
  let result = null;
  try {
    const buf = fs.readFileSync(fontFile);
    let base = 0;
    const sig = buf.toString('latin1', 0, 4);
    // TrueType Collection — point at the first contained font's offset table.
    if (sig === 'ttcf') base = buf.readUInt32BE(12);
    const numTables = buf.readUInt16BE(base + 4);
    let nameOff = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) === 'name') {
        nameOff = buf.readUInt32BE(rec + 8);
        break;
      }
    }
    if (nameOff) {
      const count = buf.readUInt16BE(nameOff + 2);
      const strBase = nameOff + buf.readUInt16BE(nameOff + 4);
      let best = null, bestScore = -1;
      for (let i = 0; i < count; i++) {
        const rec = nameOff + 6 + i * 12;
        const platformID = buf.readUInt16BE(rec);
        const nameID = buf.readUInt16BE(rec + 6);
        const len = buf.readUInt16BE(rec + 8);
        const o = buf.readUInt16BE(rec + 10);
        // nameID 1 = Family, 16 = Typographic Family (weight-independent base).
        if (nameID !== 1 && nameID !== 16) continue;
        const start = strBase + o;
        if (start + len > buf.length) continue;
        let str;
        if (platformID === 3 || platformID === 0) {
          // UTF-16BE — swap to LE so Node can decode it.
          const slice = Buffer.from(buf.subarray(start, start + len));
          if (slice.length % 2 === 0) { slice.swap16(); str = slice.toString('utf16le'); }
          else str = slice.toString('latin1');
        } else {
          str = buf.toString('latin1', start, start + len);
        }
        str = (str || '').replace(/\u0000/g, '').trim();
        if (!str) continue;
        // Prefer the typographic family (16) and the Windows platform (3) so we
        // get the name fontconfig matches on, weight-independent.
        let score = 0;
        if (nameID === 16) score += 2;
        if (platformID === 3) score += 1;
        if (score > bestScore) { bestScore = score; best = str; }
      }
      result = best;
    }
  } catch { result = null; }
  _fontNameCache.set(fontFile, result);
  return result;
}

// Rewrite a font's `name` table so its family/full/typographic names become a
// single UNIQUE ASCII token, and write the patched font to destFile. This is
// what makes the burned-in subtitle font match the preview 1:1: libass resolves
// fonts through fontconfig by FAMILY NAME, and our bundled fonts share names
// across weights (all 8 Arista Pro weights are "Arista Pro"; OpenSans Regular &
// Bold are both "Open Sans"). Worse, if the user also installed the font
// system-wide, fontconfig prefers the system copy over our fontsdir. Both make
// the render pick a DIFFERENT file than the exact one the preview loaded. By
// renaming to a unique token and pointing the Style at that token, libass can
// only resolve the one patched file — no sibling weight, system copy, or fuzzy
// match can interfere. The new table is appended at EOF and the table-directory
// entry repointed (checksum zeroed — rasterizers ignore it). Returns true on
// success. Works for both TrueType (.ttf) and CFF/OpenType (.otf).
function patchFontFamilyToToken(srcFile, destFile, token) {
  try {
    const src = fs.readFileSync(srcFile);
    const buf = Buffer.from(src);
    let base = 0;
    if (buf.toString('latin1', 0, 4) === 'ttcf') base = buf.readUInt32BE(12);
    const numTables = buf.readUInt16BE(base + 4);
    let nameEntry = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) === 'name') { nameEntry = rec; break; }
    }
    if (nameEntry < 0) return false;
    const ascii = String(token).replace(/[^A-Za-z0-9]/g, '');
    const recs = [
      { id: 1,  s: token },     // family
      { id: 2,  s: 'Regular' }, // subfamily
      { id: 4,  s: token },     // full name
      { id: 6,  s: ascii },     // PostScript name (no spaces)
      { id: 16, s: token },     // typographic family (what fontconfig prefers)
      { id: 17, s: 'Regular' }, // typographic subfamily
    ];
    const heaps = recs.map(r => Buffer.from(r.s, 'utf16le').swap16()); // UTF-16BE
    const count = recs.length;
    const strOff = 6 + count * 12;
    const header = Buffer.alloc(6);
    header.writeUInt16BE(0, 0);       // format 0
    header.writeUInt16BE(count, 2);
    header.writeUInt16BE(strOff, 4);
    const recBuf = Buffer.alloc(count * 12);
    let off = 0;
    for (let i = 0; i < count; i++) {
      const r = recs[i], h = heaps[i], p = i * 12;
      recBuf.writeUInt16BE(3, p);        // platform 3 (Windows)
      recBuf.writeUInt16BE(1, p + 2);    // encoding 1 (UCS-2)
      recBuf.writeUInt16BE(0x0409, p + 4); // lang en-US
      recBuf.writeUInt16BE(r.id, p + 6);
      recBuf.writeUInt16BE(h.length, p + 8);
      recBuf.writeUInt16BE(off, p + 10);
      off += h.length;
    }
    const newTable = Buffer.concat([header, recBuf, ...heaps]);
    let appendPos = buf.length;
    const pad = (4 - (appendPos % 4)) % 4;
    const out = Buffer.concat([buf, Buffer.alloc(pad), newTable]);
    appendPos += pad;
    out.writeUInt32BE(0, nameEntry + 4);            // checksum (ignored)
    out.writeUInt32BE(appendPos, nameEntry + 8);    // new offset
    out.writeUInt32BE(newTable.length, nameEntry + 12); // new length
    fs.writeFileSync(destFile, out);
    return true;
  } catch { return false; }
}

// libass sizes a style's Fontsize by the font's OS/2 win-metrics
// ((usWinAscent + usWinDescent) / unitsPerEm), NOT by the em square the way a
// CSS canvas does (`Npx` → em = N px). So at the same nominal size, libass text
// is ~10-20% smaller than the canvas preview, and the gap VARIES per font.
// We read the metrics from the file and return the scale that makes the burned
// subtitle match the preview's pixel height 1:1. Measured empirically accurate
// to ~1-2% across Arial/Impact/Verdana/Calibri/Times. Cached per file.
const _fontScaleCache = new Map();
function readFontAssScale(fontFile) {
  if (!fontFile) return 1.16;
  if (_fontScaleCache.has(fontFile)) return _fontScaleCache.get(fontFile);
  let scale = 1.16;  // sane average fallback if the tables can't be read
  try {
    const buf = fs.readFileSync(fontFile);
    let base = 0;
    if (buf.toString('latin1', 0, 4) === 'ttcf') base = buf.readUInt32BE(12);
    const numTables = buf.readUInt16BE(base + 4);
    let headOff = 0, os2Off = 0, hheaOff = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      const tag = buf.toString('latin1', rec, rec + 4);
      if (tag === 'head') headOff = buf.readUInt32BE(rec + 8);
      else if (tag === 'OS/2') os2Off = buf.readUInt32BE(rec + 8);
      else if (tag === 'hhea') hheaOff = buf.readUInt32BE(rec + 8);
    }
    if (headOff) {
      const unitsPerEm = buf.readUInt16BE(headOff + 18) || 2048;
      let h = 0;
      if (os2Off) {
        // usWinAscent (+74, uint16) + usWinDescent (+76, uint16) — the metric
        // libass actually scales by on Windows-style TrueType fonts.
        h = buf.readUInt16BE(os2Off + 74) + buf.readUInt16BE(os2Off + 76);
      }
      if (!h && hheaOff) {
        // Fallback to hhea ascent-descent if there's no OS/2 table.
        h = buf.readInt16BE(hheaOff + 4) - buf.readInt16BE(hheaOff + 6);
      }
      if (h > 0) scale = h / unitsPerEm;
    }
  } catch { scale = 1.16; }
  // Guard against absurd values from a malformed table.
  if (!(scale > 0.8 && scale < 1.6)) scale = 1.16;
  _fontScaleCache.set(fontFile, scale);
  return scale;
}

// Convert a CSS-style "#rrggbb" hex into the ASS colour literal "&H00BBGGRR".
// ASS uses AABBGGRR byte order (opaque = AA=00) — gets us right for libass.
function _hexToAss(hex) {
  const h = String(hex || '#ffffff').replace('#', '').padEnd(6, '0');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '&H00FFFFFF';
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function _assTime(t) {
  const total = Math.max(0, Number(t) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Build an ASS subtitle file for one subtitle layer. We emit ONE dialogue line
// per word's "active" window — the full segment text is rendered each time,
// but only one word is in highlightColor. This is the simplest path to CapCut-
// style karaoke that works with any libass build (vanilla \k tags would invert
// the colour semantics).
function buildAssForSubtitles(subL, outWidth, outHeight, fontNameOverride) {
  const style = subL.style || {};
  // Prefer the layout's (possibly auto-fitted) fontSize over style.fontSize so
  // shrink-to-fit-box behaves identically in the burned-in result.
  const layoutFs = subL._layout && Number(subL._layout.fontSize);
  const canvasPx = Math.max(12, Math.round(layoutFs || Number(style.fontSize) || 56));
  // libass renders glyphs at the SAME scale a CSS canvas does (Fontsize ≡ em
  // size, factor ≈ 1.0 — measured exactly 1.000 on Arista Pro, ~0.9-1.0 on the
  // rest within cap-metric noise). So NO size correction is needed: Fontsize =
  // canvasPx, ScaleX = ScaleY = 100. The old win-metric scale (~1.44) was a
  // mis-correction that EITHER widened glyphs (ate the spaces between words) when
  // applied to Fontsize, OR stretched them vertically (text looked condensed)
  // when applied to ScaleY. Both are gone now: glyph width matches the canvas-
  // measured positions (no overlap/gap) and the aspect ratio is undistorted.
  const fontSize = canvasPx;
  const yScale = 100;
  // fontNameOverride is the unique token of the patched/isolated font file (see
  // the export loop) — using it guarantees libass loads the EXACT file the
  // preview did. Falls back to the font's real internal family name (then the
  // renderer display name) when no patched font was produced.
  const realName = fontNameOverride || readFontFamilyName(style.fontFile);
  const fontName = String(realName || style.fontFamily || 'Arial').replace(/,/g, ' ');
  const base = _hexToAss(style.color || '#ffffff');
  const high = _hexToAss(style.highlightColor || '#ff9a1f');
  const outline = _hexToAss(style.outlineColor || '#000000');
  // Canvas strokeText(lineWidth=fs*0.08) straddles the glyph path → ~fs*0.04
  // shows OUTSIDE the letter. libass Outline=N draws N fully outside, so use
  // fs*0.04 to match the preview's visible thickness 1:1. Derived from canvasPx
  // (the on-screen size), NOT the libass-scaled fontSize.
  // Outline mode + thickness (mirrors the canvas preview). libass only renders a
  // clean EXTERNAL border, so we offer external + none (any legacy "internal"
  // value is treated as external). Thickness = olT px, drawn outside the glyph.
  const olMode = (style.outlineMode === 'none' || style.outline === false) ? 'none' : 'external';
  const olT = (style.outlineWidth != null && style.outlineWidth !== '')
    ? Math.max(0, Math.round(Number(style.outlineWidth)))
    : Math.max(1, Math.round(canvasPx * 0.04));
  const outlineW = (olMode === 'external') ? olT : 0;

  // Alignment 5 = middle-centre; combined with per-word \an5\pos(x,y) every word
  // is anchored on its own centre point. Margins are irrelevant (we position
  // absolutely) — WrapStyle 2 disables any libass wrapping of its own.
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${outWidth}
PlayResY: ${outHeight}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${base},${high},${outline},&H80000000,0,0,0,0,100,${yScale},0,0,1,${outlineW},0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const escape = (s) => String(s || '')
    .replace(/\\/g, '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, ' ');

  const lines = [];

  // PREFERRED PATH: the renderer measured the exact layout (per-word centres in
  // output px) with the same canvas font the preview used, so we just place each
  // word at its coordinate. This guarantees position/wrap/line-spacing parity
  // with the preview — libass does no layout of its own. For each word we emit:
  //   • a BASE-colour Dialogue spanning the whole segment (Layer 0), and
  //   • a HIGHLIGHT-colour Dialogue spanning that word's active window (Layer 1,
  //     drawn on top) — so the active word lights up exactly when the preview's
  //     does, with no lingering.
  // Animation preset (shared timing constants with the canvas preview's
  // SUB_ANIM). 'pop' scale-punches the spoken word; 'scale' scales+fades the
  // whole phrase in; 'type' reveals words one-by-one; 'rise' rises words in.
  const anim = (style.anim) || 'pop';
  const A = {
    POP_MS: 130, POP_SCALE: 130,
    SCALE_MS: 200, SCALE_FROM: 60, SCALE_FADE_MS: 120,
    RISE_MS: 150, RISE_OFFSET: 28, RISE_FADE_MS: 100,
    BAM_MS1: 100, BAM_MS2: 180, BAM_FROM: 150, BAM_MID: 85,
    BLUR_MS: 200, BLUR_PX: 8,
    ZOUT_MS: 200, ZOUT_FROM: 140, ZOUT_FADE_MS: 120,
    GLOW_MS: 500, GLOW_MUL: 2.5,
    WAVE_MS: 350,
    WAVE_COLORS: ['#ff9a1f', '#ff3bb8', '#46d3ff', '#aaff00'],
    // neon-flicker: thick cyan outline + alpha pattern via chained instant-\t toggles
    NEON_MS: 200, NEON_BORD_MUL: 2.2, NEON_COLOR: '#00f0ff',
    // typewriter-cursor: blinking | after last revealed word, 500ms full period (250 on / 250 off)
    TYPE_CURSOR_MS: 500, TYPE_CURSOR_PAD: 0.18,
    // shake: ±4° rotation jitter via 5 chained \t blocks of \frz
    SHAKE_STAGES: [[0,40,4],[40,80,-4],[80,120,3],[120,160,-2],[160,200,0]],
    // bounce: drop-from-above with squash-and-stretch (drop / hit / settle)
    BOUNCE_OFFSET: 60, BOUNCE_DROP_MS: 120, BOUNCE_SQUASH_MS: 80, BOUNCE_SETTLE_MS: 100,
    BOUNCE_FROM_FSCX: 80, BOUNCE_FROM_FSCY: 140,
    BOUNCE_HIT_FSCX: 120, BOUNCE_HIT_FSCY: 70,
  };
  const neonOutlineAss = _hexToAss(A.NEON_COLOR);
  // Neon ALWAYS draws a thick glow, even when the outline toggle is off — the
  // canvas preview forces the stroke for neon too. So base the neon border on
  // the font's natural outline width (canvasPx*0.04), NOT on outlineW (which is
  // 0 when the user disabled the outline → would collapse neon to a 1px hairline
  // and mismatch the preview's thick glow).
  const neonBaseW = Math.max(1, Math.round(canvasPx * 0.04));
  const neonBord = Math.max(neonBaseW + 1, Math.round(neonBaseW * A.NEON_BORD_MUL));
  // yScale is 100 now (no metric correction), so fy() is the identity — kept so
  // the animation tag builders below read uniformly and stay correct if a scale
  // is ever reintroduced.
  const fy = (n) => Math.round(Number(n) * yScale / 100);
  const waveAss = A.WAVE_COLORS.map(_hexToAss);
  const phraseCx = Math.round(((style.x ?? 50) / 100) * outWidth);
  const phraseCy = Math.round(((style.y ?? 85) / 100) * outHeight);
  const glowBordBase = outlineW;
  const glowBordBig = Math.max(glowBordBase + 1, Math.round(outlineW * A.GLOW_MUL));

  const layout = subL._layout;
  if (layout && Array.isArray(layout.segments) && layout.segments.length) {
    // Rescale if the export resolution differs from what the layout was built
    // for (e.g. user changed canvas size after generating) — keeps it correct.
    const sx = layout.W ? outWidth / layout.W : 1;
    const sy = layout.H ? outHeight / layout.H : 1;
    for (const seg of layout.segments) {
      const segStartNum = Number(seg.start) || 0;
      const segEndNum = Math.max(segStartNum + 0.05, Number(seg.end) || 0);
      const segStart = _assTime(segStartNum);
      const segEnd = _assTime(segEndNum);
      const segWords = seg.words || [];
      for (let wi = 0; wi < segWords.length; wi++) {
        const w = segWords[wi];
        const cx = Math.round((Number(w.cx) || 0) * sx);
        const cy = Math.round((Number(w.cy) || 0) * sy);
        const wPx = Math.round((Number(w.w) || 0) * sx);  // word advance width (for typewriter cursor)
        const txt = escape(w.text);
        const wStartNum = Number(w.start) || 0;
        const wStart = _assTime(wStartNum);
        const wEnd = _assTime(Math.max(wStartNum + 0.02, Number(w.end) || 0));

        // Build the base (Layer 0) and highlight (Layer 1) override blocks +
        // the base event start time, per animation. All curves are linear \t /
        // \move / \fad so they reproduce the canvas preview's math.
        let baseStart = segStart;
        let baseStartNum = segStartNum;
        let baseOv = `{\\an5\\pos(${cx},${cy})\\c${base}}`;
        let highOv = `{\\an5\\pos(${cx},${cy})\\c${high}}`;
        if (anim === 'pop') {
          highOv = `{\\an5\\pos(${cx},${cy})\\c${high}\\fscx${A.POP_SCALE}\\fscy${fy(A.POP_SCALE)}\\t(0,${A.POP_MS},\\fscx100\\fscy${yScale})}`;
        } else if (anim === 'type') {
          baseStart = wStart; baseStartNum = wStartNum;  // reveal the word at its own time
        } else if (anim === 'rise') {
          baseStart = wStart; baseStartNum = wStartNum;
          const mv = `\\move(${cx},${cy + A.RISE_OFFSET},${cx},${cy},0,${A.RISE_MS})\\fad(${A.RISE_FADE_MS},0)`;
          baseOv = `{\\an5${mv}\\c${base}}`;
          highOv = `{\\an5${mv}\\c${high}}`;
        } else if (anim === 'scale') {
          const sX = Math.round(phraseCx + (A.SCALE_FROM / 100) * (cx - phraseCx));
          const sY = Math.round(phraseCy + (A.SCALE_FROM / 100) * (cy - phraseCy));
          baseOv = `{\\an5\\move(${sX},${sY},${cx},${cy},0,${A.SCALE_MS})\\fad(${A.SCALE_FADE_MS},0)\\fscx${A.SCALE_FROM}\\fscy${fy(A.SCALE_FROM)}\\t(0,${A.SCALE_MS},\\fscx100\\fscy${yScale})\\c${base}}`;
          // The highlight must ride the SAME phrase scale-in. If the word lights
          // up mid-animation, pick the animation up partway (p0); once the phrase
          // has settled it's just static.
          const p0 = Math.max(0, Math.min(1, ((wStartNum - segStartNum) * 1000) / A.SCALE_MS));
          if (p0 < 1) {
            const scNow = Math.round(A.SCALE_FROM + (100 - A.SCALE_FROM) * p0);
            const hX = Math.round(phraseCx + (scNow / 100) * (cx - phraseCx));
            const hY = Math.round(phraseCy + (scNow / 100) * (cy - phraseCy));
            const remMs = Math.max(1, Math.round(A.SCALE_MS * (1 - p0)));
            const fadeRem = Math.max(0, Math.round(A.SCALE_FADE_MS - (wStartNum - segStartNum) * 1000));
            const fadeTag = fadeRem > 0 ? `\\fad(${fadeRem},0)` : '';
            highOv = `{\\an5\\move(${hX},${hY},${cx},${cy},0,${remMs})${fadeTag}\\fscx${scNow}\\fscy${fy(scNow)}\\t(0,${remMs},\\fscx100\\fscy${yScale})\\c${high}}`;
          }
        } else if (anim === 'zoomout') {
          // Phrase scales 140% → 100% around its anchor, fading in. Same math
          // as 'scale' but with SCALE_FROM > 100 (starts BIGGER, shrinks in).
          const sX = Math.round(phraseCx + (A.ZOUT_FROM / 100) * (cx - phraseCx));
          const sY = Math.round(phraseCy + (A.ZOUT_FROM / 100) * (cy - phraseCy));
          baseOv = `{\\an5\\move(${sX},${sY},${cx},${cy},0,${A.ZOUT_MS})\\fad(${A.ZOUT_FADE_MS},0)\\fscx${A.ZOUT_FROM}\\fscy${fy(A.ZOUT_FROM)}\\t(0,${A.ZOUT_MS},\\fscx100\\fscy${yScale})\\c${base}}`;
          // Highlight rides the same phrase animation — partial when it lights
          // up mid-anim, static once the phrase has settled (p0 ≥ 1).
          const p0 = Math.max(0, Math.min(1, ((wStartNum - segStartNum) * 1000) / A.ZOUT_MS));
          if (p0 < 1) {
            const scNow = Math.round(A.ZOUT_FROM + (100 - A.ZOUT_FROM) * p0);
            const hX = Math.round(phraseCx + (scNow / 100) * (cx - phraseCx));
            const hY = Math.round(phraseCy + (scNow / 100) * (cy - phraseCy));
            const remMs = Math.max(1, Math.round(A.ZOUT_MS * (1 - p0)));
            const fadeRem = Math.max(0, Math.round(A.ZOUT_FADE_MS - (wStartNum - segStartNum) * 1000));
            const fadeTag = fadeRem > 0 ? `\\fad(${fadeRem},0)` : '';
            highOv = `{\\an5\\move(${hX},${hY},${cx},${cy},0,${remMs})${fadeTag}\\fscx${scNow}\\fscy${fy(scNow)}\\t(0,${remMs},\\fscx100\\fscy${yScale})\\c${high}}`;
          }
        } else if (anim === 'bam') {
          // 3-piece overshoot: 150% → 85% → 100% via chained \t (linear pieces).
          highOv = `{\\an5\\pos(${cx},${cy})\\c${high}\\fscx${A.BAM_FROM}\\fscy${fy(A.BAM_FROM)}\\t(0,${A.BAM_MS1},\\fscx${A.BAM_MID}\\fscy${fy(A.BAM_MID)})\\t(${A.BAM_MS1},${A.BAM_MS2},\\fscx100\\fscy${yScale})}`;
        } else if (anim === 'blurfocus') {
          // Word starts blurred and snaps into focus via \blur ramp.
          highOv = `{\\an5\\pos(${cx},${cy})\\c${high}\\blur${A.BLUR_PX}\\t(0,${A.BLUR_MS},\\blur0)}`;
        } else if (anim === 'glow') {
          // Outline width pulses base → big → base → big → base (~2 cycles).
          const halfMs = Math.round(A.GLOW_MS / 2);
          const cycle = A.GLOW_MS;
          const pulses = [
            `\\t(0,${halfMs},\\bord${glowBordBig})`,
            `\\t(${halfMs},${cycle},\\bord${glowBordBase})`,
            `\\t(${cycle},${cycle + halfMs},\\bord${glowBordBig})`,
            `\\t(${cycle + halfMs},${2 * cycle},\\bord${glowBordBase})`,
          ].join('');
          highOv = `{\\an5\\pos(${cx},${cy})\\c${high}\\bord${glowBordBase}${pulses}}`;
        } else if (anim === 'colorwave') {
          // Highlight cycles through the WAVE palette via chained \t \c, starting
          // the FIRST transition at 0 (matches the canvas preview which lerps
          // from t=0 — not after one full period).
          const T = A.WAVE_MS;
          const transitions = [
            `\\t(0,${T},\\c${waveAss[1]})`,
            `\\t(${T},${2 * T},\\c${waveAss[2]})`,
            `\\t(${2 * T},${3 * T},\\c${waveAss[3]})`,
            `\\t(${3 * T},${4 * T},\\c${waveAss[0]})`,
          ].join('');
          highOv = `{\\an5\\pos(${cx},${cy})\\c${waveAss[0]}${transitions}}`;
        } else if (anim === 'neon') {
          // Thick cyan outline + 6-stage alpha flicker via instant-\t toggles
          // (t,t+1 ramp = effectively a jump cut for libass).
          const flick = [
            `\\t(50,51,\\1a&HFF&\\3a&HFF&)`,
            `\\t(70,71,\\1a&H00&\\3a&H00&)`,
            `\\t(100,101,\\1a&HFF&\\3a&HFF&)`,
            `\\t(120,121,\\1a&H00&\\3a&H00&)`,
            `\\t(160,170,\\1a&H8C&\\3a&H8C&)`,
            `\\t(170,180,\\1a&H00&\\3a&H00&)`,
          ].join('');
          highOv = `{\\an5\\pos(${cx},${cy})\\c${high}\\3c${neonOutlineAss}\\bord${neonBord}${flick}}`;
        } else if (anim === 'typewriter') {
          // Identical to 'type' for the words — reveal each at its own start time.
          baseStart = wStart; baseStartNum = wStartNum;
        } else if (anim === 'shake') {
          // 5-stage rotation jitter via chained \t \frz. Each \t interpolates
          // linearly from the prior \frz value to the new one.
          const st = A.SHAKE_STAGES;
          const shakes = st.map(([t0, t1, deg]) => `\\t(${t0},${t1},\\frz${deg})`).join('');
          highOv = `{\\an5\\pos(${cx},${cy})\\c${high}${shakes}}`;
        } else if (anim === 'bounce') {
          // Phase 1 (0..D): drop from cy-OFFSET → cy + scale (80,140)→(100,100)
          // Phase 2 (D..D+S): impact squash → (HIT_FSCX, HIT_FSCY)
          // Phase 3 (D+S..D+S+T): settle → (100, 100)
          const D = A.BOUNCE_DROP_MS, S = A.BOUNCE_SQUASH_MS, T = A.BOUNCE_SETTLE_MS;
          const O = A.BOUNCE_OFFSET;
          const mv = `\\move(${cx},${cy - O},${cx},${cy},0,${D})`;
          const scales = [
            `\\t(0,${D},\\fscx100\\fscy${yScale})`,
            `\\t(${D},${D + S},\\fscx${A.BOUNCE_HIT_FSCX}\\fscy${fy(A.BOUNCE_HIT_FSCY)})`,
            `\\t(${D + S},${D + S + T},\\fscx100\\fscy${yScale})`,
          ].join('');
          baseStart = wStart; baseStartNum = wStartNum;
          baseOv = `{\\an5${mv}\\fscx${A.BOUNCE_FROM_FSCX}\\fscy${fy(A.BOUNCE_FROM_FSCY)}\\fad(80,0)${scales}\\c${base}}`;
          highOv = `{\\an5${mv}\\fscx${A.BOUNCE_FROM_FSCX}\\fscy${fy(A.BOUNCE_FROM_FSCY)}\\fad(80,0)${scales}\\c${high}}`;
        }

        // The base (Layer 0) must NOT overlap this word's highlight window — else
        // the static base shows THROUGH the animated highlight whenever the anim
        // scales it below 100% (bam), rotates it (shake), blurs it (blurfocus) or
        // flickers its alpha (neon), looking like a 2nd static subtitle underneath
        // (the preview draws each word once, so it never doubled). So we emit the
        // base only BEFORE the highlight (carrying any entrance animation) and a
        // STATIC rest-base AFTER it — the highlight alone owns [wStart, wEnd].
        const wEndNum = Math.max(wStartNum + 0.02, Number(w.end) || 0);
        if (wStartNum > baseStartNum + 0.001) {
          lines.push(`Dialogue: 0,${baseStart},${wStart},Default,,0,0,0,,${baseOv}${txt}`);
        }
        lines.push(`Dialogue: 1,${wStart},${wEnd},Default,,0,0,0,,${highOv}${txt}`);
        if (segEndNum > wEndNum + 0.001) {
          lines.push(`Dialogue: 0,${wEnd},${segEnd},Default,,0,0,0,,{\\an5\\pos(${cx},${cy})\\c${base}}${txt}`);
        }

        // Typewriter cursor: blinking | sits after each word from word.end until
        // the next word begins (or seg.end for last). Blinks 250 on / 250 off.
        if (anim === 'typewriter') {
          const nextW = segWords[wi + 1];
          const cursorStartNum = Number(w.end) || 0;
          const cursorEndNum = nextW ? (Number(nextW.start) || cursorStartNum) : Number(seg.end) || cursorStartNum;
          if (cursorEndNum > cursorStartNum + 0.05) {
            const cursorPadPx = Math.round(canvasPx * A.TYPE_CURSOR_PAD);
            const cursorX = cx + Math.round(wPx / 2) + cursorPadPx;
            // 250ms on / 250ms off, chained \t toggles. ~6 cycles covers 3s of
            // typical word-gap (libass clamps stale tags after event end).
            const blink = [];
            for (let k = 1; k <= 12; k++) {
              const t = k * 250;
              const off = (k % 2 === 1) ? `\\1a&HFF&\\3a&HFF&` : `\\1a&H00&\\3a&H00&`;
              blink.push(`\\t(${t},${t + 1},${off})`);
            }
            const cursorOv = `{\\an5\\pos(${cursorX},${cy})\\c${high}${blink.join('')}}`;
            lines.push(`Dialogue: 1,${_assTime(cursorStartNum)},${_assTime(cursorEndNum)},Default,,0,0,0,,${cursorOv}|`);
          }
        }
      }
    }
    return header + lines.join('\n') + '\n';
  }

  // FALLBACK (no precomputed layout, e.g. an older project): single \pos line
  // per word-window, libass handles wrapping. Less exact but never off-screen.
  const px = Math.round(((style.x ?? 50) / 100) * outWidth);
  const py = Math.round(((style.y ?? 85) / 100) * outHeight);
  for (const seg of (subL.segments || [])) {
    const segStart = Number(seg.startTime) || 0;
    const segEnd = Math.max(segStart + 0.05, Number(seg.endTime) || segStart);
    let words = Array.isArray(seg.words) && seg.words.length ? seg.words : null;
    if (!words) {
      const parts = String(seg.text || '').split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      const each = (segEnd - segStart) / parts.length;
      words = parts.map((t, i) => ({ text: t, start: segStart + i * each, end: segStart + (i + 1) * each }));
    }
    if (words.length === 0) continue;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const start = Math.max(segStart, Number(w.start) || segStart);
      const end = i < words.length - 1
        ? Math.max(start + 0.05, Number(words[i + 1].start) || start)
        : Math.max(start + 0.05, Number(w.end) || segEnd);
      const body = words.map((ww, j) => `{\\c${j === i ? high : base}}${escape(ww.text)}`).join(' ');
      lines.push(`Dialogue: 0,${_assTime(start)},${_assTime(end)},Default,,0,0,0,,{\\pos(${px},${py})}${body}`);
    }
  }
  return header + lines.join('\n') + '\n';
}

function drawtextFontOption() {
  const candidates = process.platform === 'win32'
    ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']
    : ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'];
  for (const f of candidates) {
    try { if (fs.existsSync(f)) return `:fontfile='${ffPath(f)}'`; } catch {}
  }
  return '';
}

function outputSizes(settings) {
  if (settings.preset === 'fb') {
    return [
      { w: 1080, h: 1080, label: '1080x1080' },
      { w: 1080, h: 1350, label: '1080x1350' },
      { w: 1080, h: 1920, label: '1080x1920' }
    ];
  }
  if (settings.useCustomSize) return [{ w: Number(settings.customWidth || 1080), h: Number(settings.customHeight || 1920), label: `${settings.customWidth || 1080}x${settings.customHeight || 1920}` }];
  if (settings.size === 'original' || settings.format === 'original') return [{ original: true, w: null, h: null, label: 'original' }];
  const [w, h] = String(settings.size || '1080x1920').split('x').map(Number);
  return [{ w: w || 1080, h: h || 1920, label: `${w || 1080}x${h || 1920}` }];
}

function buildFilter(settings, size, media = {}) {
  const filters = [];
  let current = '[0:v]';
  let n = 0;
  const next = () => `[v${++n}]`;
  const outW = Math.max(120, Number(size.original ? (media.width || 1080) : (size.w || 1080)));
  const outH = Math.max(120, Number(size.original ? (media.height || 1920) : (size.h || 1920)));
  const fit = settings.fit || 'blur';

  if (size.original) {
    // Keep original dimensions; effects below still apply.
  } else if (fit === 'crop') {
    const l = next(); filters.push(`${current}scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}${l}`); current = l;
  } else if (fit === 'pad') {
    const l = next(); filters.push(`${current}scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black${l}`); current = l;
  } else {
    const l = next(); filters.push(`${current}scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=24:1[bg];[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${l}`); current = l;
  }

  const brightness = Number(settings.brightness || 0) / 100;
  const contrast = Number(settings.contrast || 100) / 100;
  const saturation = Number(settings.saturation || 100) / 100;
  const lEq = next(); filters.push(`${current}eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}${lEq}`); current = lEq;

  if (settings.noiseEnabled && Number(settings.noise || 0) > 0) { const l = next(); filters.push(`${current}noise=alls=${Math.min(30, Number(settings.noise))}:allf=t+u${l}`); current = l; }
  if (settings.sharpness && Number(settings.sharpness) > 0) { const amount = Math.min(2, Number(settings.sharpness) / 100); const l = next(); filters.push(`${current}unsharp=5:5:${amount.toFixed(2)}${l}`); current = l; }
  if (settings.microzoomEnabled && Number(settings.microzoom || 0) > 0) { const z = Number(settings.microzoom) / 100; const l = next(); filters.push(`${current}scale=ceil(iw*(1+${z.toFixed(4)}*0.5*(1+sin(2*PI*t)))/2)*2:ceil(ih*(1+${z.toFixed(4)}*0.5*(1+sin(2*PI*t)))/2)*2:eval=frame,crop=${outW}:${outH}${l}`); current = l; }

  const speed = Number(settings.speed || 100) / 100;
  if (Math.abs(speed - 1) > 0.001) { const l = next(); filters.push(`${current}setpts=${(1/speed).toFixed(8)}*PTS${l}`); current = l; }

  if (settings.imageWatermarkEnabled && settings.imageWatermarkPath && fs.existsSync(settings.imageWatermarkPath)) {
    const pos = settings.imageWatermarkPosition || 'bottom-right';
    const hasCustom = settings.imageWatermarkX != null && settings.imageWatermarkY != null;
    const x = hasCustom ? `(W*${(Number(settings.imageWatermarkX)/100).toFixed(4)}-w/2)` : (pos.includes('right') ? 'W-w-36' : pos.includes('left') ? '36' : '(W-w)/2');
    const y = hasCustom ? `(H*${(Number(settings.imageWatermarkY)/100).toFixed(4)}-h/2)` : (pos.includes('bottom') ? 'H-h-36' : pos.includes('top') ? '36' : '(H-h)/2');
    const wmH = Math.max(16, Math.round(outH * Math.max(1, Math.min(80, Number(settings.imageWatermarkSize || 18))) / 100));
    const opacity = Math.max(0, Math.min(1, Number(settings.imageWatermarkOpacity || 75)/100));
    const l = next();
    filters.push(`[1:v]scale=-1:${wmH},format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[wm${n}];${current}[wm${n}]overlay=${x}:${y}${l}`);
    current = l;
  }

  if (settings.textWatermarkEnabled && settings.watermarkText) {
    const pos = settings.watermarkPosition || 'bottom-right';
    const hasCustom = settings.watermarkX != null && settings.watermarkY != null;
    const x = hasCustom ? `(w*${(Number(settings.watermarkX)/100).toFixed(4)}-tw/2)` : (pos.includes('right') ? 'w-tw-36' : pos.includes('left') ? '36' : '(w-tw)/2');
    const y = hasCustom ? `(h*${(Number(settings.watermarkY)/100).toFixed(4)}-th/2)` : (pos.includes('bottom') ? 'h-th-36' : pos.includes('top') ? '36' : '(h-th)/2');
    const opacity = Math.max(0, Math.min(1, Number(settings.watermarkOpacity || 80)/100));
    const fs = Math.max(12, Number(settings.watermarkSize || 36));
    const fontPart = drawtextFontOption();
    const alignMap = { left: 'L', center: 'C', right: 'R' };
    const alignPart = settings.watermarkAlign ? `:text_align=${alignMap[settings.watermarkAlign] || 'C'}` : '';
    const hexColor = '0x' + (settings.watermarkColor || '#ffffff').replace('#', '');
    const l = next(); const boxPart = settings.watermarkBox === false ? '' : ':box=1:boxcolor=black@0.25:boxborderw=12'; filters.push(`${current}drawtext=text='${escapeDrawtext(settings.watermarkText)}':x=${x}:y=${y}${fontPart}:fontsize=${fs}:fontcolor=${hexColor}@${opacity.toFixed(2)}${alignPart}${boxPart}${l}`); current = l;
  }

  if (!size.original) {
    const evenW = Math.ceil(outW / 2) * 2;
    const evenH = Math.ceil(outH / 2) * 2;
    filters.push(`${current}scale=${evenW}:${evenH}:force_original_aspect_ratio=disable,setsar=1,format=yuv420p[vout]`);
  } else {
    filters.push(`${current}setsar=1,format=yuv420p[vout]`);
  }
  return filters.join(';');
}

function buildCmd(ffmpeg, input, output, settings, size, media = {}, render = { type: 'cpu', codec: 'libx264' }) {
  const trimStart = settings.trimEnabled ? Math.max(0, Number(settings.trimStart || 0)) : 0;
  const trimEnd = settings.trimEnabled ? Math.max(0, Number(settings.trimEnd || 0)) : 0;
  const cmd = ['-y', '-hide_banner', '-progress', 'pipe:1', '-nostats'];
  if (trimStart > 0) cmd.push('-ss', String(trimStart));
  cmd.push('-i', input);
  if (settings.imageWatermarkEnabled && settings.imageWatermarkPath && fs.existsSync(settings.imageWatermarkPath)) {
    cmd.push('-i', settings.imageWatermarkPath);
  }
  const filter = buildFilter(settings, size, media);
  cmd.push('-filter_complex', filter, '-map', '[vout]', '-map', '0:a?');
  const speed = Number(settings.speed || 100) / 100;
  if (media.hasAudio && Math.abs(speed - 1) > 0.001) cmd.push('-af', `atempo=${Math.max(0.5, Math.min(2, speed)).toFixed(8)}`);
  let outDuration = null;
  if (settings.previewTest) outDuration = 10;
  else if (trimEnd > 0 && media.duration) outDuration = Math.max(0.1, media.duration - trimStart - trimEnd);
  if (outDuration) cmd.push('-t', String(outDuration));
  const presetMap = { fast: 'veryfast', balance: 'medium', quality: 'slow', background: 'veryfast', max: 'fast' };
  const profilePreset = settings.processingProfile || settings.resourceMode || settings.encodePreset || 'balance';
  const codec = render?.codec || 'libx264';
  cmd.push('-map_metadata', '-1', '-c:v', codec);
  if (codec === 'libx264') {
    cmd.push('-preset', presetMap[profilePreset] || 'medium');
  } else if (codec === 'h264_nvenc') {
    const nvencPreset = profilePreset === 'quality' ? 'p5' : profilePreset === 'fast' || profilePreset === 'background' ? 'p2' : 'p4';
    cmd.push('-preset', nvencPreset);
  } else if (codec === 'h264_qsv') {
    cmd.push('-preset', profilePreset === 'quality' ? 'slow' : profilePreset === 'fast' || profilePreset === 'background' ? 'veryfast' : 'medium');
  } else if (codec === 'h264_amf') {
    cmd.push('-quality', profilePreset === 'quality' ? 'quality' : profilePreset === 'fast' || profilePreset === 'background' ? 'speed' : 'balanced');
  }
  // ── Size / quality — driven by the export mode ──
  // Presets cap the output relative to the source file so noise/effects can't
  // bloat it: max ≤ ×3, normal ≈ source, fast ≈ ×0.55. Custom is user-defined.
  const srcMb = (input && fs.existsSync(input)) ? fileSizeMb(input) : 0;
  const srcDur = Math.max(1, media.duration || outDuration || 1);
  const srcTotalKbps = srcMb > 0 ? (srcMb * 8192) / srcDur : 0;
  const srcVideoKbps = srcTotalKbps > 0 ? Math.max(200, srcTotalKbps - 128) : 0;
  const mode = settings.exportMode || 'normal';
  let audioKbps = 160;

  const pushBitrate = (vKbps, maxMul) => {
    const v = Math.max(300, Math.round(vKbps));
    cmd.push('-b:v', `${v}k`, '-maxrate', `${Math.round(v * maxMul)}k`, '-bufsize', `${Math.round(v * maxMul * 1.6)}k`);
  };
  const pushCrf = (crf) => {
    const q = Math.max(1, Math.min(51, Math.round(crf)));
    if (codec === 'libx264') cmd.push('-crf', String(q));
    else if (codec === 'h264_nvenc') cmd.push('-cq', String(Math.max(16, Math.min(40, q))), '-b:v', '0');
    else if (codec === 'h264_qsv') cmd.push('-global_quality', String(Math.max(16, Math.min(40, q))));
    else if (codec === 'h264_amf') cmd.push('-rc', 'cqp', '-qp_i', String(Math.max(16, Math.min(40, q))), '-qp_p', String(Math.max(16, Math.min(40, q + 2))));
    else cmd.push('-crf', String(q));
  };

  if (mode === 'custom') {
    const vb = Number(settings.customVideoBitrate || 0);
    if (vb > 0) pushBitrate(vb, 1.3);
    else pushCrf(Number(settings.customCrf || 23));
    audioKbps = Math.max(32, Math.min(512, Number(settings.customAudioBitrate || 160)));
    const fps = Number(settings.customFps || 0);
    if (fps > 0) cmd.push('-r', String(Math.max(1, Math.min(120, Math.round(fps)))));
  } else if (srcVideoKbps > 0) {
    if (mode === 'max') pushBitrate(srcVideoKbps * 2.4, 1.25);          // ≤ ~×3 of the source
    else if (mode === 'fast') { pushBitrate(srcVideoKbps * 0.55, 1.45); audioKbps = 128; }  // 30–50% lighter
    else pushBitrate(srcVideoKbps * 0.95, 1.3);                          // ≈ source size
  } else {
    // Source size unknown — fall back to a sane CRF.
    pushCrf(mode === 'max' ? 19 : mode === 'fast' ? 27 : 23);
    if (mode === 'fast') audioKbps = 128;
  }
  cmd.push('-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', '-shortest', output);
  return cmd;
}


function runFfmpeg(ffmpeg, args, onProgressLine, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    if (options.background) { try { os.setPriority(proc.pid, 10); } catch {} }
    activeProcs.add(proc);
    let output = '';
    const handle = d => {
      const s = d.toString(); output += s;
      s.split(/\r?\n/).filter(Boolean).forEach(line => onProgressLine(line));
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', code => { activeProcs.delete(proc); resolve({ code, output }); });
    proc.on('error', err => { activeProcs.delete(proc); resolve({ code: 1, output: String(err) }); });
  });
}

function fmtEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.round(seconds); const m = Math.floor(s / 60); const r = s % 60;
  if (m >= 60) return `${Math.floor(m/60)}ч ${m%60}м`;
  return m ? `${m}м ${r}с` : `${r}с`;
}

ipcMain.handle('process:start', async (_event, payload) => {
  const ffmpeg = findFfmpeg();
  const files = (payload.files || []).filter(f => VIDEO_EXT.has(path.extname(f).toLowerCase()));
  const settings = payload.settings || {};
  const sizes = outputSizes(settings);
  const copies = Math.max(1, Number(settings.copies || 1));
  const outDir = payload.outputDir || (files[0] ? path.join(path.dirname(files[0]), 'processed') : path.join(process.cwd(), 'processed'));
  fs.mkdirSync(outDir, { recursive: true });
  stopRequested = false;

  const system = getSystemInfo();
  const acceleration = await detectAcceleration(ffmpeg);
  const selectedRender = chooseEncoder(settings, acceleration);
  const parallelLimit = autoParallelJobs(settings, files.length || 1);
  const renderSummary = `Рендер: ${encoderLabel(selectedRender)} | параллельно: ${parallelLimit} | CPU: ${system.cpuCores} ядер | RAM: ${system.ramGb} GB`;
  send('log', `FFmpeg: ${ffmpeg}`);
  send('log', renderSummary);
  if (selectedRender.fallback) send('log', `Запрошенный рендер ${selectedRender.requested} недоступен. Используется CPU.`);
  const ffmpegLooksMissing = ffmpeg === 'ffmpeg' && process.platform === 'win32';
  if (ffmpegLooksMissing) send('log', 'Предупреждение: используется системный ffmpeg. Если он не установлен, обработка не начнётся.');

  const total = files.length * copies * sizes.length;
  let done = 0;
  const createdFiles = [];
  const failedFiles = [];
  const tasks = [];
  const started = Date.now();
  const progressMap = new Map();

  const rawGlobalName = String(settings.globalFilename || '').trim()
    .replace(/\.(mp4|mov|mkv|avi|webm|m4v)$/i, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_');
  const useGlobalName = !!settings.useGlobalFilename && rawGlobalName !== '';
  // Per-file custom names from the queue (renaming each video individually).
  const perFileNames = payload.fileNames || {};
  const baseNameFor = (file) => {
    const custom = String(perFileNames[file] || '').trim()
      .replace(/\.(mp4|mov|mkv|avi|webm|m4v)$/i, '')
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, '_');
    return custom || safeName(file);
  };
  let outputCounter = 0;
  const buildOutName = (file, c, size) => useGlobalName
    ? `${rawGlobalName}_${++outputCounter}.mp4`
    : `${baseNameFor(file)}${outputMark(settings)}_copy${c}_${size.label}.mp4`;

  send('progress', { running: true, total, done: 0, percent: 0, currentPercent: 0, currentFile: '', stage: 'Подготовка файлов', speedText: renderSummary, eta: '—' });

  for (const file of files) {
    if (stopRequested) break;
    const media = await probeMediaInfo(ffmpeg, file);
    const trimStart = settings.trimEnabled ? Math.max(0, Number(settings.trimStart || 0)) : 0;
    const trimEnd = settings.trimEnabled ? Math.max(0, Number(settings.trimEnd || 0)) : 0;
    const baseDuration = media.duration ? Math.max(0.1, media.duration - trimStart - trimEnd) : null;
    const duration = settings.previewTest && baseDuration ? Math.min(10, baseDuration) : baseDuration;
    send('log', `Проверка файла: ${path.basename(file)} | длительность: ${duration ? duration.toFixed(1) + 'с' : 'не определена'} | аудио: ${media.hasAudio ? 'есть' : 'нет'}`);

    if (settings.trimEnabled && media.duration && (trimStart + trimEnd) >= media.duration - 0.1) {
      for (let c = 1; c <= copies; c++) {
        for (const size of sizes) {
          const name = buildOutName(file, c, size);
          const out = uniquePath(path.join(outDir, name));
          failedFiles.push({ input: file, output: out, reason: 'видео слишком короткое для заданной обрезки' });
        }
      }
      continue;
    }

    for (let c = 1; c <= copies; c++) {
      for (const size of sizes) {
        const name = buildOutName(file, c, size);
        const baseOut = path.join(outDir, name);
        tasks.push({ id: tasks.length + 1, file, size, media, duration, copy: c, baseOut });
      }
    }
  }

  // Files rejected during pre-check still count as completed tasks.
  done = failedFiles.length;
  if (failedFiles.length) send('progress', { running: true, total, done, percent: Math.round((done / Math.max(1, total))*100), currentPercent: 0, currentFile: '', stage: `Rejected ${done} из ${total}`, speedText: renderSummary, eta: '—' });

  let nextIndex = 0;
  let activeCount = 0;

  const emitProgress = (task, pct = 0, stageText = null) => {
    if (task) progressMap.set(task.id, Math.max(0, Math.min(1, pct)));
    const activeProgress = Array.from(progressMap.values()).reduce((a, b) => a + b, 0);
    const totalFrac = Math.min(1, (done + activeProgress) / Math.max(1, total));
    const elapsed = (Date.now() - started) / 1000;
    const eta = totalFrac > 0.02 ? elapsed * (1 / totalFrac - 1) : null;
    send('progress', {
      running: true,
      total,
      done,
      percent: Math.round(totalFrac * 100),
      currentPercent: Math.round((pct || 0) * 100),
      currentFile: task ? path.basename(task.file) : '',
      stage: stageText || `Обработка ${Math.min(done + activeCount, total)} из ${total}`,
      speedText: renderSummary,
      eta: fmtEta(eta)
    });
  };

  const runTask = async (task) => {
    if (stopRequested) return;
    activeCount++;
    progressMap.set(task.id, 0);
    const baseOut = task.baseOut;
    if (settings.skipExisting && fs.existsSync(baseOut) && fs.statSync(baseOut).size > 0) {
      createdFiles.push(baseOut);
      done++;
      progressMap.delete(task.id);
      activeCount--;
      send('log', `Пропущен уже готовый файл: ${path.basename(baseOut)}`);
      emitProgress(null, 0, `Пропущено ${done} из ${total}`);
      return;
    }

    const out = settings.skipExisting ? baseOut : uniquePath(baseOut);
    send('log', `Старт: ${path.basename(task.file)} -> ${path.basename(out)} | ${encoderLabel(selectedRender)}`);
    emitProgress(task, 0, `Обработка ${done + 1} из ${total}`);

    const quickCopy = (!hasVisualChanges(settings) && task.size.original);
    let args = quickCopy
      ? ['-y','-hide_banner','-progress','pipe:1','-nostats','-i',task.file,'-map_metadata','-1','-c','copy',out]
      : buildCmd(ffmpeg, task.file, out, settings, task.size, task.media, selectedRender);
    send('log', `Команда: ffmpeg ${args.map(a => String(a).includes(' ') ? `"${a}"` : a).join(' ')}`);

    let lastPct = 0;
    let res = await runFfmpeg(ffmpeg, args, (line) => {
      const sec = parseProgressTime(line);
      if (sec != null && task.duration) {
        lastPct = Math.max(lastPct, Math.min(1, sec / task.duration));
        emitProgress(task, lastPct);
      }
    }, { background: settings.backgroundMode || settings.resourceMode === 'background' });

    let existsOk = fs.existsSync(out) && fs.statSync(out).size > 0;
    if ((!existsOk || res.code !== 0) && selectedRender.type !== 'cpu' && !quickCopy && !stopRequested) {
      send('log', `Аппаратный рендер не сработал для ${path.basename(task.file)}. Пробую CPU fallback...`);
      args = buildCmd(ffmpeg, task.file, out, settings, task.size, task.media, { type: 'cpu', codec: 'libx264' });
      lastPct = 0;
      res = await runFfmpeg(ffmpeg, args, (line) => {
        const sec = parseProgressTime(line);
        if (sec != null && task.duration) {
          lastPct = Math.max(lastPct, Math.min(1, sec / task.duration));
          emitProgress(task, lastPct);
        }
      }, { background: settings.backgroundMode || settings.resourceMode === 'background' });
      existsOk = fs.existsSync(out) && fs.statSync(out).size > 0;
    }

    if (res.code === 0 && existsOk) {
      createdFiles.push(out);
      send('log', `OK: ${path.basename(out)}`);
    } else {
      const reason = stopRequested ? 'остановлено пользователем' : humanFfmpegError(res.output || '');
      failedFiles.push({ input: task.file, output: out, reason });
      send('log', `Ошибка: ${path.basename(task.file)} -> ${path.basename(out)}: ${reason}\n${String(res.output || '').slice(-1200)}`);
    }

    done++;
    progressMap.delete(task.id);
    activeCount--;
    emitProgress(null, 0, `Готово ${done} из ${total}`);
  };

  async function worker() {
    while (!stopRequested) {
      const task = tasks[nextIndex++];
      if (!task) break;
      await runTask(task);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallelLimit, tasks.length || 1)) }, () => worker()));

  if (stopRequested) {
    for (let i = nextIndex; i < tasks.length; i++) {
      const t = tasks[i];
      failedFiles.push({ input: t.file, output: t.baseOut, reason: 'остановлено пользователем' });
    }
  }

  if (settings.openFolderAfter && !stopRequested) {
    try { shell.openPath(outDir); } catch {}
  }
  send('progress', { running: false, total, done, percent: total ? Math.round((done/total)*100) : 0, currentPercent: 0, currentFile: '', stage: stopRequested ? 'Остановлено' : 'Готово', speedText: renderSummary, eta: '0с' });
  send('done', { stopped: stopRequested, total, done, outDir, createdFiles, failedFiles, render: renderSummary });
  if (!stopRequested && createdFiles.length > 0) {
    try {
      if (Notification.isSupported()) {
        const n = createdFiles.length;
        const iconPath = appPath('assets', 'strata_mixer_v1_2_4.ico');
        new Notification({
          title: 'Strata Mixer',
          body: `Готово · ${n} файл${n === 1 ? '' : n < 5 ? 'а' : 'ов'} создано`,
          icon: fs.existsSync(iconPath) ? iconPath : undefined,
          silent: true
        }).show();
      }
    } catch {}
  }
  return { done, total, outDir, createdFiles, failedFiles, render: renderSummary };
});
