const { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, nativeImage, screen, Notification } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

let mainWindow = null;
let splashWindow = null;
let splashShownAt = 0;
let currentProc = null;
let stopRequested = false;
let tray = null;
let isQuitting = false;

// Single-instance lock: relaunching while minimized to tray just reveals
// the existing window instead of spawning a duplicate process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

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

function findFfmpeg() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch {}
  const candidates = [
    appPath('bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    resourcePath('ffmpeg.exe'),
    resourcePath('ffmpeg'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'app', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
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
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);

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
    clearTimeout(timer);
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
  const iconPath = appPath('assets', process.platform === 'darwin' ? 'strata_mixer_1_1d.icns' : 'strata_mixer_1_1d.ico');
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
  const icon = appPath('assets', process.platform === 'darwin' ? 'strata_mixer_1_1d.icns' : 'strata_mixer_1_1d.ico');
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
  // instead of quitting. A real quit goes through the tray menu / app.quit().
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
const NOTIFICATIONS_URL = 'https://updates.stratamixer.net/notifications.json';

let updateState = { status: 'idle', version: null, percent: 0, error: null };
let notificationsCache = [];

function pushUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  send('update:state', updateState);
}

function setupAutoUpdater() {
  // electron-updater needs a packaged app (app-update.yml is embedded at build).
  if (!app.isPackaged) return;
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
  try { autoUpdater.checkForUpdates().catch(() => {}); } catch {}
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
ipcMain.handle('update:install', () => {
  try { autoUpdater.quitAndInstall(true, true); } catch {}
  return true;
});
ipcMain.handle('notifications:get', () => notificationsCache);
ipcMain.handle('notifications:refresh', async () => { await fetchNotifications(); return notificationsCache; });

app.on('second-instance', () => showMainWindow());
app.on('before-quit', () => { isQuitting = true; });

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  if (process.platform === 'win32') app.setAppUserModelId('com.stratamixer.app.1.1beta');

  createSplashWindow();
  createWindow();
  createTray();
  startUpdateAndNotificationCycle();

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
    const filterParts = [];
    const inputArgs = ['-i', file];
    let videoStream = '[0:v]';
    let inputIdx = 1;

    const evenW = Math.ceil(outWidth / 2) * 2;
    const evenH = Math.ceil(outHeight / 2) * 2;
    const clipLen = Math.max(0.1, videoEnd - videoStart);
    const padAfter = Math.max(0, totalDuration - videoEnd);
    const totalDur = Math.max(0.1, totalDuration);
    const bgHex = (bgColor || '#000000').replace('#', '0x');
    const isAudioOnly = format === 'mp3';

    if (!isAudioOnly) {
      const mv = mainVideoForFilter;
      if (mv && mv.aspect && mv.size) {
        const mvW = Math.max(2, Math.round((mv.size / 100) * evenW));
        const mvH = Math.max(2, Math.round(mvW / mv.aspect));
        const mvX = Math.round(((mv.x == null ? 50 : mv.x) / 100) * evenW - mvW / 2);
        const mvY = Math.round(((mv.y == null ? 50 : mv.y) / 100) * evenH - mvH / 2);
        filterParts.push(`color=c=${bgHex}:s=${evenW}x${evenH}:r=30:d=${totalDur.toFixed(3)}[smbg]`);
        filterParts.push(`[0:v]trim=start=${videoStart}:end=${videoEnd},setpts=PTS-STARTPTS+${videoStart}/TB,scale=${mvW}:${mvH},setsar=1[smmv]`);
        filterParts.push(`[smbg][smmv]overlay=${mvX}:${mvY}:eof_action=pass:enable='between(t,${videoStart},${videoEnd})'[vscaled]`);
      } else {
        let baseFilter = `${videoStream}trim=start=${videoStart}:end=${videoEnd},setpts=PTS-STARTPTS,scale=${evenW}:${evenH}:force_original_aspect_ratio=decrease,setsar=1,pad=${evenW}:${evenH}:(ow-iw)/2:(oh-ih)/2:${bgHex}`;
        if (videoStart > 0 || padAfter > 0) {
          baseFilter += `,tpad=start_duration=${videoStart}:stop_duration=${padAfter}:color=${bgHex}`;
        }
        baseFilter += '[vscaled]';
        filterParts.push(baseFilter);
      }
      videoStream = '[vscaled]';

      let blurCount = 0, imgCount = 0, vidovCount = 0, txtCount = 0, zoomCount = 0;
      const videoOverlayInputs = [];
      (layers || []).forEach((layer) => {
        if (layer.type === 'blur') {
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
        } else if (layer.type === 'videoOverlay') {
          const i = vidovCount++;
          inputArgs.push('-i', layer.file);
          const idx = inputIdx++;
          videoOverlayInputs.push({ idx, layer });
          const x = `(W*${layer.x / 100}-w/2)`;
          const y = `(H*${layer.y / 100}-h/2)`;
          const scaleW = Math.max(2, Math.round((layer.size / 100) * evenW));
          const scaleH = layer.aspect ? Math.max(2, Math.round(scaleW / layer.aspect)) : -1;
          const enable = `enable='between(t,${layer.startTime},${layer.endTime})'`;
          const ovSp = Math.max(0.1, (layer.speed || 100) / 100);
          const ovDur = Math.max(0.1, (layer.endTime ?? totalDur) - (layer.startTime || 0));
          const ovSrc = layer.srcStart || 0;
          // Per-video colour correction (Эффекты видео)
          const ccB = (layer.ccB || 0) / 100;
          const ccC = (layer.ccC == null ? 100 : layer.ccC) / 100;
          const ccS = (layer.ccS == null ? 100 : layer.ccS) / 100;
          const ccPart = (ccB !== 0 || ccC !== 1 || ccS !== 1)
            ? `,eq=brightness=${ccB.toFixed(3)}:contrast=${ccC.toFixed(3)}:saturation=${ccS.toFixed(3)}`
            : '';
          filterParts.push(`[${idx}:v]trim=start=${ovSrc}:end=${(ovSrc + ovDur * ovSp).toFixed(3)},setpts=(PTS-STARTPTS)/${ovSp}+${layer.startTime || 0}/TB,scale=${scaleW}:${scaleH}${ccPart},format=rgba[vov${i}]`);
          filterParts.push(`${videoStream}[vov${i}]overlay=${x}:${y}:${enable}[vvidov${i}]`);
          videoStream = `[vvidov${i}]`;
        } else if (layer.type === 'text') {
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
          try { fs.writeFileSync(tmpTxt, layer.text || '', 'utf8'); tmpFiles.push(tmpTxt); } catch(e) {}
          let fontPart = '';
          if (layer.fontFile && fs.existsSync(layer.fontFile)) {
            fontPart = `:fontfile='${ffPath(layer.fontFile)}'`;
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
    }

    // Audio: volume on main video + optional audio file layers
    const mvVol = (mainVideoForFilter?.volume ?? 100);
    const audioLayers = (layers || []).filter(l => l.type === 'audio');
    let audioMap = '0:a?';

    if (mvVol !== 100 || audioLayers.length > 0 || videoOverlayInputs.length > 0) {
      // Base video audio — cut to the base clip's range, placed on the timeline.
      filterParts.push(`[0:a]atrim=${videoStart.toFixed(3)}:${videoEnd.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${Math.round(videoStart*1000)}|${Math.round(videoStart*1000)},volume=${(mvVol / 100).toFixed(3)}[auMain]`);
      const mixInputs = ['[auMain]'];
      // Every overlay video carries its own audio, cut to its clip (split-aware).
      videoOverlayInputs.forEach(({ idx, layer }, i) => {
        const oStart = layer.startTime || 0;
        const oEnd = Math.min(layer.endTime ?? totalDur, totalDur);
        const oLen = Math.max(0.1, oEnd - oStart);
        const oSrc = Number(layer.srcStart || 0);
        const oVol = (layer.volume ?? 100) / 100;
        const oDelay = Math.round(oStart * 1000);
        const oSp = Math.max(0.1, (layer.speed || 100) / 100);
        let atParts = [], atRem = oSp;
        while (atRem > 2) { atParts.push('atempo=2.0'); atRem /= 2; }
        while (atRem < 0.5) { atParts.push('atempo=0.5'); atRem *= 2; }
        atParts.push(`atempo=${atRem.toFixed(4)}`);
        filterParts.push(`[${idx}:a]atrim=${oSrc.toFixed(3)}:${(oSrc + oLen * oSp).toFixed(3)},asetpts=PTS-STARTPTS,${atParts.join(',')},adelay=${oDelay}|${oDelay},volume=${oVol.toFixed(3)}[auVov${i}]`);
        mixInputs.push(`[auVov${i}]`);
      });
      audioLayers.forEach((layer, i) => {
        inputArgs.push('-i', layer.file);
        const idx = inputIdx++;
        const aStart = layer.startTime || 0;
        const aEnd = Math.min(layer.endTime ?? totalDur, totalDur);
        const aLen = Math.max(0.1, aEnd - aStart);
        const vol = (layer.volume ?? 100) / 100;
        const delayMs = Math.round(aStart * 1000);
        const aSrc = Number(layer.srcStart || 0);
        filterParts.push(`[${idx}:a]atrim=${aSrc.toFixed(3)}:${(aSrc + aLen).toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},volume=${vol.toFixed(3)}[auLayer${i}]`);
        mixInputs.push(`[auLayer${i}]`);
      });
      if (mixInputs.length === 1) {
        audioMap = '[auMain]';
      } else {
        filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0[auFinal]`);
        audioMap = '[auFinal]';
      }
    }

    // ── Quality / size — capped relative to the source (max ≤×3, normal ≈
    //    source, fast ≈×0.55), or fully user-defined in custom mode. ──
    const custom = payload.custom || {};
    const srcVideoKbps = (srcMbReal > 0) ? Math.max(200, (srcMbReal * 8192) / srcDurReal - 128) : 0;
    const presetMap = { max: 'slow', normal: 'medium', fast: 'veryfast', custom: 'medium' };
    const encPreset = presetMap[quality] || 'medium';
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
      if (format === 'webm') {
        args.push('-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '2');
        if (vKbps > 0) { const v = Math.max(300, Math.round(vKbps)); args.push('-b:v', `${v}k`, '-maxrate', `${Math.round(v * maxMul)}k`); }
        else args.push('-crf', String(quality === 'custom' ? cCrf(33) : quality === 'max' ? 28 : quality === 'fast' ? 40 : 33), '-b:v', '0');
        if (quality === 'custom' && cFps > 0) args.push('-r', String(cFps));
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
        args.push('-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart');
      }
    }
    args.push('-t', String(totalDur), '-y', outPath);

    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let errLog = '';
    proc.stderr?.on('data', (d) => {
      const s = d.toString(); errLog += s;
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && mainWindow) {
        const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        mainWindow.webContents.send('edit-progress', { percent: Math.min(99, Math.round((secs / totalDur) * 100)) });
      }
    });
    proc.on('close', (code) => {
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      if (mainWindow) mainWindow.webContents.send('edit-progress', { percent: 100, done: true });
      resolve({ ok: code === 0, error: code !== 0 ? errLog.slice(-1600) : '' });
    });
    proc.on('error', (err) => {
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      resolve({ ok: false, error: String(err) });
    });
  });
});

ipcMain.handle('fonts:list', async () => {
  if (process.platform !== 'win32') return [];
  const fontsDir = 'C:/Windows/Fonts';
  try {
    return fs.readdirSync(fontsDir)
      .filter(f => /\.(ttf|otf)$/i.test(f))
      .map(f => {
        const n = path.basename(f, path.extname(f))
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim();
        return { name: n, file: (fontsDir + '/' + f) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
});

ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Выбери папку', properties: ['openDirectory'] });
  if (result.canceled) return '';
  return result.filePaths[0];
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
  const acceleration = detectAcceleration(ffmpeg);
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
  if (currentProc) { try { currentProc.kill('SIGTERM'); } catch {} }
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

function readEncoders(ffmpeg) {
  try {
    const out = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
    return String(out || '');
  } catch (e) {
    try { return String(e.stdout || '') + '\n' + String(e.stderr || ''); } catch { return ''; }
  }
}

function detectAcceleration(ffmpeg) {
  const enc = readEncoders(ffmpeg);
  const has = (name) => new RegExp(`\\b${name}\\b`, 'i').test(enc);
  return {
    nvidia: has('h264_nvenc'),
    intel: has('h264_qsv'),
    amd: has('h264_amf'),
    cpu: true
  };
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

function probeMediaInfo(ffmpeg, file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let out = '';
    p.stderr.on('data', d => out += d.toString());
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => { const sz = parseVideoSize(out); resolve({ duration: parseDuration(out), hasAudio: /Audio:/i.test(out), width: sz.width, height: sz.height, raw: out }); });
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
    currentProc = proc;
    let output = '';
    const handle = d => {
      const s = d.toString(); output += s;
      s.split(/\r?\n/).filter(Boolean).forEach(line => onProgressLine(line));
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', code => { currentProc = null; resolve({ code, output }); });
    proc.on('error', err => { currentProc = null; resolve({ code: 1, output: String(err) }); });
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
  const acceleration = detectAcceleration(ffmpeg);
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
        const iconPath = appPath('assets', 'strata_mixer_1_1d.ico');
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
