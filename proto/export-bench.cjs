// P2-8 transport de-risk — measure the REAL bottleneck of compositor-export: streaming full-res
// RGBA frames renderer → main → ffmpeg.stdin (rawvideo) → H.264. Synthetic frames (no compositor)
// so this measures pure transport + encode throughput, which gates whether P2-8 is feasible.
//
// Loads the page from disk (file://) with nodeIntegration so the renderer can ipcRenderer.invoke
// per frame (built-in backpressure: it awaits main's ack, which awaits ffmpeg's 'drain'). No vite.
//
// Run:  electron proto/export-bench.cjs       (writes proto/last-bench.json)

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const W = 1080, H = 1920, FPS = 30;
const FFMPEG = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const OUT = path.join(os.tmpdir(), 'strata-export-test.mp4');
const RESULT = path.join(__dirname, 'last-bench.json');

try { app.setPath('userData', path.join(os.tmpdir(), 'strata-expbench-' + process.pid)); } catch {}
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let ff = null, framesIn = 0, bytesIn = 0, t0 = 0, backpressureWaits = 0;
let drainResolvers = [];

ipcMain.handle('export:start', () => {
  if (!fs.existsSync(FFMPEG)) return { ok: false, ffmpeg: FFMPEG };
  framesIn = 0; bytesIn = 0; backpressureWaits = 0; drainResolvers = []; t0 = Date.now();
  ff = spawn(FFMPEG, ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS),
    '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', OUT]);
  ff.stderr.on('data', () => {});
  ff.stdin.on('drain', () => { const r = drainResolvers; drainResolvers = []; r.forEach(fn => fn()); });
  ff.on('error', (e) => process.stdout.write('[ff] error ' + e.message + '\n'));
  return { ok: true, ffmpeg: FFMPEG };
});

ipcMain.handle('export:frame', async (_e, buf) => {
  const b = Buffer.from(buf);
  framesIn++; bytesIn += b.length;
  const ok = ff.stdin.write(b);
  if (!ok) { backpressureWaits++; await new Promise(r => drainResolvers.push(r)); }
  return true;
});

ipcMain.handle('export:end', async () => {
  try { ff.stdin.end(); } catch {}
  const code = await new Promise(r => ff.on('close', r));
  const ms = Date.now() - t0;
  let outMB = 0; try { outMB = fs.statSync(OUT).size / 1e6; } catch {}
  const res = {
    framesIn, bytesMB: +(bytesIn / 1e6).toFixed(1), ms,
    encFps: +(framesIn / (ms / 1000)).toFixed(1),
    throughputMBs: +((bytesIn / 1e6) / (ms / 1000)).toFixed(1),
    backpressureWaits, outMB: +outMB.toFixed(2), ffExit: code,
  };
  try { fs.writeFileSync(RESULT, JSON.stringify(res)); } catch {}
  return res;
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 760, height: 520, backgroundColor: '#0c0d12', title: 'Strata Export Transport Bench',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, _l, msg) => { if (msg != null) process.stdout.write(msg + '\n'); });
  win.webContents.on('render-process-gone', (_e, d) => process.stdout.write('[gone] ' + JSON.stringify(d) + '\n'));
  win.loadFile(path.join(__dirname, 'export-bench.html'));
  process.stdout.write('[launcher] export-bench up (ffmpeg=' + FFMPEG + ')\n');
});
app.on('window-all-closed', () => app.quit());
