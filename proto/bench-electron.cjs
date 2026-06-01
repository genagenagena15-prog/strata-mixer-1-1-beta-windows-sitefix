// Standalone Electron launcher for the Phase-1 GPU bench.
// Runs in its OWN process (no single-instance lock) so it does NOT collide with the
// real Strata app, and uses DEFAULT GPU settings — exactly like the real app
// (electron/main.js sets no GPU switches) — so the Tier detect is representative.
//
// Captures the page console and:
//   - mirrors it to this process stdout (so `npm run bench` shows progress)
//   - writes the final @@BENCH@@ verdict line to proto/last-bench.json
//
// Run:  npm run bench    (starts vite + this launcher)

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Per-process userData + no shader disk cache — avoids "Unable to move the cache / Access denied"
// when bench runs share the default cache dir (back-to-back or alongside the real Strata app).
try { app.setPath('userData', path.join(os.tmpdir(), 'strata-bench-' + process.pid)); } catch (e) { /* ignore */ }
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const URL = process.env.BENCH_URL || 'http://localhost:5180/proto/preview-bench.html';
const RESULT = path.join(__dirname, 'last-bench.json');

function onConsole(event, ...rest) {
  // Electron changed this signature across versions:
  //   old: (event, level, message, line, sourceId)
  //   new: (event, details)  where details = { level, message, lineNumber, sourceId }
  let msg;
  if (rest.length === 1 && rest[0] && typeof rest[0] === 'object') msg = rest[0].message;
  else msg = rest[1];
  if (msg == null) return;
  process.stdout.write(msg + '\n');
  if (typeof msg === 'string' && msg.startsWith('@@BENCH@@')) {
    try { fs.writeFileSync(RESULT, msg.slice('@@BENCH@@'.length)); } catch (e) { /* ignore */ }
  }
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1240, height: 940,
    backgroundColor: '#0c0d12',
    title: 'Strata GPU Bench — Phase 1',
    // backgroundThrottling:false — Chromium otherwise freezes rAF/timers for occluded
    // windows; the bench must run even when our window is behind the dev app.
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', onConsole);
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    process.stdout.write(`[launcher] did-fail-load ${code} ${desc} — is vite up on :5180?\n`);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    process.stdout.write(`[launcher] render-process-gone: ${JSON.stringify(d)}\n`);
  });
  if (process.env.BENCH_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  win.loadURL(URL);
  process.stdout.write('[launcher] loading ' + URL + '\n');
});

app.on('window-all-closed', () => app.quit());
