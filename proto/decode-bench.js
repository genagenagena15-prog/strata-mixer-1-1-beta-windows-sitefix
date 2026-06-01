// P2-6 de-risk harness — play 2 real videos through decode.js (WebCodecs) → Compositor (0-copy),
// in real time off an emulated master clock, then exercise SEEK (incl. backward). Proves the decode
// pipeline works in a play scenario: frames advance, seeks resolve, no decoder errors, ring bounded
// (frames are closed on eviction — no leak). Result → console @@BENCH@@ (launcher → last-bench.json).

import { Compositor } from '/src/engine/compositor.js';
import { VideoSource } from '/src/engine/decode.js';

const outW = 540, outH = 960, bg = '#101014';
const $ = (id) => document.getElementById(id);
const log = (m) => { console.log(m); const el = $('log'); if (el) el.textContent += m + '\n'; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let curT = 0; // current media time the compositor reads via getSource

// minimal getLayerPx replica for mainVideo / videoOverlay (aspect from the VideoSource)
function getPx(layer) {
  const W = outW, H = outH;
  if (layer.type === 'mainVideo') {
    const w = (layer.size || 100) / 100 * W, h = w / (layer.aspect || W / H);
    return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
  }
  // videoOverlay
  const w = (layer.size || 40) / 100 * W, h = w / (layer.aspect || 16 / 9);
  return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
}

function setVerdict(text, cls) { const v = $('verdict'); v.textContent = text; v.className = cls; }

async function main() {
  try {
    if (typeof VideoDecoder === 'undefined') {
      setVerdict('NO WebCodecs — Tier B only', 'bad');
      log('@@BENCH@@' + JSON.stringify({ error: 'no WebCodecs' }));
      return;
    }
    const names = await (await fetch('/proto/testmedia/manifest.json')).json();
    const base = '/proto/testmedia/';
    log('[decode] init sources…');
    const mainVs = new VideoSource(base + names[0], { label: 'main' });
    const ov = new VideoSource(base + names[3], { label: 'overlay' });
    await mainVs.init();
    await ov.init();
    log(`[decode] main ${mainVs.width}x${mainVs.height} ${mainVs.chunks.length}pk ${mainVs.keyIdx.length}kf dur=${(mainVs.durUs/1e6).toFixed(2)}s`);
    log(`[decode] ov   ${ov.width}x${ov.height} ${ov.chunks.length}pk ${ov.keyIdx.length}kf dur=${(ov.durUs/1e6).toFixed(2)}s`);

    const cg = $('cg');
    const comp = new Compositor(cg);
    const layers = [
      { id: 'm', type: 'mainVideo', x: 50, y: 50, size: 100, aspect: mainVs.aspect, _vs: mainVs },
      { id: 'a', type: 'videoOverlay', x: 30, y: 32, size: 46, startTime: 0, endTime: 999, aspect: ov.aspect, _vs: ov },
    ];
    const frameObj = {
      W: outW, H: outH, bgColor: bg, layers, time: 0, videoStart: 0, videoEnd: 999, dur: 999,
      getPx,
      getSource: (l) => (l._vs ? l._vs.frameAt(curT) : null),
    };

    const playDur = Math.min(4.0, (mainVs.durUs / 1e6) - 0.05);
    log(`[play] real-time playback for ${playDur.toFixed(2)}s…`);

    // ---- PLAY PHASE (real-time, rAF-paced) ----
    let renders = 0;
    const seenMain = new Set();
    let maxRingMain = 0, maxRingOv = 0, repeats = 0, lastMainTs = -1;
    const t0 = performance.now();
    await new Promise((resolve) => {
      function tick() {
        const t = (performance.now() - t0) / 1000;
        curT = t; frameObj.time = t;
        comp.renderFrame(frameObj);
        renders++;
        const mf = mainVs.frameAt(t);
        if (mf) { if (mf.timestamp === lastMainTs) repeats++; else { seenMain.add(mf.timestamp); lastMainTs = mf.timestamp; } }
        maxRingMain = Math.max(maxRingMain, mainVs.ring.length);
        maxRingOv = Math.max(maxRingOv, ov.ring.length);
        if (t >= playDur || mainVs.err || ov.err) return resolve();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const elapsed = (performance.now() - t0) / 1000;
    const fps = renders / elapsed;
    log(`[play] ${renders} renders / ${elapsed.toFixed(2)}s = ${fps.toFixed(1)} fps · distinctMainFrames=${seenMain.size} · repeats=${repeats} · maxRing main/ov=${maxRingMain}/${maxRingOv}`);
    if (mainVs.err) log('[play] MAIN decoder error: ' + mainVs.err.message, 'bad');
    if (ov.err) log('[play] OV decoder error: ' + ov.err.message, 'bad');

    // ---- SEEK PHASE (jump around, incl. backward; verify the served frame lands near target) ----
    const avgGopSec = (mainVs.durUs / 1e6) / Math.max(1, mainVs.keyIdx.length);
    log(`[seek] main GOP ≈ ${avgGopSec.toFixed(2)}s/keyframe (${mainVs.keyIdx.length} kf) — long GOP = costlier mid-GOP seeks`);
    const targets = [3.0, 0.4, 2.2, 1.0, 0.0];
    const seeks = [];
    const frameDurUs = mainVs.durUs / Math.max(1, mainVs.chunks.length); // ~1 frame
    const tolUs = Math.max(60_000, frameDurUs * 1.5);
    for (const tgt of targets) {
      curT = tgt;
      const s0 = performance.now();
      let gotTs = null, settleMs = -1;
      for (let i = 0; i < 75; i++) {           // up to ~1.5s to settle the seek (long-GOP source)
        const f = mainVs.frameAt(tgt);
        if (f && Math.abs(f.timestamp - tgt * 1e6) <= tolUs) { gotTs = f.timestamp; settleMs = performance.now() - s0; break; }
        await sleep(20);
      }
      const ok = gotTs != null;
      seeks.push({ tgt, gotMs: gotTs != null ? +(gotTs / 1e6).toFixed(3) : null, settleMs: settleMs >= 0 ? Math.round(settleMs) : null, ok });
      log(`[seek] →${tgt.toFixed(2)}s  got=${gotTs != null ? (gotTs/1e6).toFixed(3) + 's' : 'MISS'}  settle=${settleMs >= 0 ? Math.round(settleMs) + 'ms' : '—'}`);
    }

    // ---- VERDICT ----
    const expectedMin = playDur * 12;          // expect at least ~12 distinct frames/sec to have shown
    const framesOk = seenMain.size >= expectedMin;
    const seeksOk = seeks.every((s) => s.ok);
    const noErr = !mainVs.err && !ov.err;
    const ringOk = maxRingMain < 90 && maxRingOv < 90; // bounded → GC/close works (no leak)
    const go = framesOk && seeksOk && noErr && ringOk;
    const verdict = go ? 'GO ✅ — Tier A decode pipeline works'
      : (noErr ? 'CLOSE ⚠ — pipeline runs, check metrics' : 'NO-GO ❌ — decoder error');
    setVerdict(`${verdict}  ·  ${fps.toFixed(0)}fps · frames ${seenMain.size} · seeks ${seeks.filter(s=>s.ok).length}/${seeks.length} · ring≤${Math.max(maxRingMain,maxRingOv)}`,
      go ? 'ok' : (noErr ? 'warn' : 'bad'));

    const result = {
      fps: +fps.toFixed(1), renders, distinctMainFrames: seenMain.size, repeats,
      maxRingMain, maxRingOv, seeksOk: seeks.filter(s => s.ok).length + '/' + seeks.length,
      decErr: mainVs.err ? mainVs.err.message : (ov.err ? ov.err.message : null),
      framesOk, ringOk, verdict: go ? 'GO' : (noErr ? 'CLOSE' : 'NO-GO'),
    };
    log('@@BENCH@@' + JSON.stringify(result));

    mainVs.dispose(); ov.dispose();
  } catch (e) {
    setVerdict('ERROR: ' + e.message, 'bad');
    log('[error] ' + (e.stack || e.message));
    log('@@BENCH@@' + JSON.stringify({ error: e.message }));
  }
}

// DOMContentLoaded may already have fired by the time this module evaluates (module scripts are
// deferred) — guard with readyState so main() always runs.
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => setTimeout(main, 200));
else setTimeout(main, 200);
