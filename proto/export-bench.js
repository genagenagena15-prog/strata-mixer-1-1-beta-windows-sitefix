// Renderer (nodeIntegration) — stream N full-res RGBA frames to main per frame with backpressure
// (await the invoke ack, which awaits ffmpeg's drain). Synthetic frames stand in for the compositor's
// readPixels output, so the numbers reflect pure transport + encode (the P2-8 feasibility gate).
const { ipcRenderer } = require('electron');
const W = 1080, H = 1920, FPS = 30, N = 150; // 5s @ 30fps
const log = (m) => { console.log(m); const e = document.getElementById('log'); if (e) e.textContent += m + '\n'; };

async function run() {
  try {
    const s = await ipcRenderer.invoke('export:start');
    log('[export] ffmpeg=' + s.ffmpeg + ' exists=' + s.ok);
    if (!s.ok) { log('@@BENCH@@' + JSON.stringify({ error: 'ffmpeg not found at ' + s.ffmpeg })); return; }
    log('[export] streaming ' + N + ' frames ' + W + 'x' + H + ' RGBA (' + (W * H * 4 / 1e6).toFixed(1) + ' MB/frame)…');
    const frame = new Uint8Array(W * H * 4);
    const t0 = performance.now();
    let genMs = 0, sendMs = 0;
    for (let i = 0; i < N; i++) {
      // NOTE: genMs is a SYNTHETIC artefact — the real export gets frames from GPU readPixels (~1-3ms),
      // not a JS fill. We vary content so ffmpeg can't trivially compress it to nothing.
      const g0 = performance.now();
      const v = (i * 7) & 255;
      for (let p = 0; p < frame.length; p += 4) { frame[p] = v; frame[p + 1] = (p >> 12) & 255; frame[p + 2] = 255 - v; frame[p + 3] = 255; }
      genMs += performance.now() - g0;
      const s0 = performance.now();
      await ipcRenderer.invoke('export:frame', frame.buffer.slice(0)); // independent copy + backpressure ack
      sendMs += performance.now() - s0;
    }
    const res = await ipcRenderer.invoke('export:end');
    const total = performance.now() - t0;
    const videoSec = N / FPS;
    const out = {
      ...res, totalMs: Math.round(total), genMs: Math.round(genMs), sendMs: Math.round(sendMs),
      realtimeRatio: +(videoSec / (total / 1000)).toFixed(2), // >1 ⇒ faster than realtime
    };
    log('[export] ' + JSON.stringify(out));
    log('@@BENCH@@' + JSON.stringify(out));
  } catch (e) { log('[error] ' + (e.stack || e.message)); log('@@BENCH@@' + JSON.stringify({ error: e.message })); }
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => setTimeout(run, 200));
else setTimeout(run, 200);
