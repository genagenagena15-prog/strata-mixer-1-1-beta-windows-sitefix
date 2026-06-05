// src/engine/exportRender.js — render a frame RANGE through an OFFSCREEN Compositor at full res for
// export. The SAME Compositor as the preview ⇒ preview == export by construction (this is the whole
// point: it kills the preview≠export bug class and removes libass/drawtext from the burned path).
//
// Renderer-side only. It does NOT touch the live preview or the existing video:edit filtergraph —
// the caller (a future engineExport path in video:edit, behind a flag) drives it and streams each
// frame to ffmpeg. The transport (renderer→main→ffmpeg.stdin rawvideo) is de-risked in
// proto/export-bench (GO: 1.52× realtime, backpressure-bounded). readPixels is GL bottom-up, so we
// flip rows to top-down for ffmpeg's rawvideo (rgba) input.

import { Compositor } from './compositor.js';
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, canEncodeVideo, QUALITY_HIGH } from 'mediabunny';

// spec = {
//   W, H, fps, durationSec, bgColor, videoStart, videoEnd,
//   layers,                       // same layer-array shape the preview uses
//   getPx(layer),                 // = getLayerPx (geometry — NEVER re-derived here)
//   getSource(layer, tSec),       // full-res source at media time tSec (VideoFrame / <video> / canvas / <img>)
//   getTextDraw(layer, tSec),     // text/subtitle word draws at tSec
//   getCC(layer),                 // colour-correct factors (videoOverlay/maskedVideo)
//   signal?,                      // AbortSignal to cancel mid-export
//   onProgress?(done, total),
// }
// onFrame(rgbaUint8, index) -> Promise|void   (caller pushes to ffmpeg; await it to honour backpressure)
export async function renderExportFrames(spec, onFrame) {
  const { W, H, fps, durationSec } = spec;
  const total = Math.max(1, Math.round(durationSec * fps));
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const comp = new Compositor(canvas);
  let rendered = 0;
  // PIPELINE: the GPU renders frame N+1 (+N+2) while frame N's pixels are still being read back off the
  // GPU (async PBO) and encoded by ffmpeg — instead of stalling the CPU on a SYNCHRONOUS readPixels every
  // frame, which forced GPU-render and NVENC-encode to run strictly one-after-another (Σ instead of max).
  // DEPTH bounds how many frames are in flight (backpressure); the compositor's PBO ring is sized DEPTH+1.
  const DEPTH = 2;
  const inflight = [];                  // strict FIFO of { handle, index }
  let stopped = false;
  // onFrame (the 8MB cross-process IPC to ffmpeg) was the export bottleneck — but most of its time is the
  // ASYNC transit/encode, not renderer-thread work. So FIRE it WITHOUT blocking and keep a few in flight:
  // the transit of frame N overlaps the GPU render + readback of frames N+1.. . ONFRAME_DEPTH bounds it
  // (backpressure + bounded memory). Acks come back in frame ORDER (main writes serially), so order holds.
  const _onFrameInflight = [];
  const ONFRAME_DEPTH = 4;
  // Resolve the OLDEST in-flight frame (preserves frame order) and hand it to ffmpeg. Each frame gets its
  // OWN output buffer — sharing one across the ring would alias in-flight frames and corrupt the video.
  const drainOldest = async () => {
    const item = inflight.shift();
    const out = new Uint8Array(item.handle.bytes);
    await comp.readPixelsResolve(item.handle, out);     // GL order: row 0 = bottom (fence wait + getBufferSubData)
    const flipped = flipRows(out, W, H);                 // → top-down for ffmpeg rawvideo (CPU 8MB copy)
    const p = Promise.resolve(onFrame(flipped, item.index)).then((accepted) => {  // FIRE — don't block on the transit
      if (accepted === false) stopped = true;           // ffmpeg stopped reading (closed/died) → stop, don't hang
      else { rendered++; if (spec.onProgress) spec.onProgress(rendered, total); }
    });
    _onFrameInflight.push(p);
    if (_onFrameInflight.length >= ONFRAME_DEPTH) await _onFrameInflight.shift();   // bound frames in flight
  };
  try {
    for (let i = 0; i < total && !stopped; i++) {
      if (spec.signal && spec.signal.aborted) break;
      const t = i / fps;
      // WAIT for every active source to actually decode its frame at t before compositing. WebCodecs
      // output is async; without this a stack of overlay decoders that can't all keep up returns stale
      // frames → the 2nd+ overlay "fast-forwards" in the exported file (preview is fine — it samples the
      // live <video>). No-op when there are no WebCodecs sources to wait on.
      if (spec.prepareFrame) await spec.prepareFrame(t);
      const frame = {
        W, H, bgColor: spec.bgColor, layers: spec.layers, time: t,
        videoStart: spec.videoStart, videoEnd: spec.videoEnd, dur: durationSec,
        backingScale: 1,                                  // ALWAYS full res for export (no low-res-while-moving)
        getPx: spec.getPx,
        getSource: (l) => spec.getSource(l, t),
        getTextDraw: spec.getTextDraw ? (l) => spec.getTextDraw(l, t) : undefined,
        getCC: spec.getCC,
      };
      comp.renderFrame(frame);
      inflight.push({ handle: comp.readPixelsBeginAsync(W, H), index: i });  // kick async readback (non-blocking)
      if (inflight.length >= DEPTH) await drainOldest();  // hold <= DEPTH frames in flight
    }
    while (inflight.length && !stopped) await drainOldest();  // flush the tail in order
    while (_onFrameInflight.length) await _onFrameInflight.shift();  // wait for ALL frames to reach ffmpeg before finish
  } finally {
    for (const item of inflight) comp.releaseAsyncHandle(item.handle);  // abort/early-exit → free leftover fences
    comp.dispose(true);   // throwaway OffscreenCanvas → release its WebGL2 context so it doesn't leak
  }
  return rendered;
}

// Vertical flip of an RGBA buffer (GL bottom-up → image top-down).
function flipRows(buf, W, H) {
  const stride = W * 4;
  const out = new Uint8Array(buf.length);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * stride;
    out.set(buf.subarray(src, src + stride), y * stride);
  }
  return out;
}

// ─── WebCodecs ENCODE export (FAST path) ──────────────────────────────────────────────────────────────
// Encodes each composited frame to H.264 IN THE RENDERER via a hardware WebCodecs VideoEncoder (driven by
// mediabunny's CanvasSource) and muxes a VIDEO-ONLY mp4 — so only a tiny COMPRESSED bitstream crosses to
// main, NOT 8MB raw per frame (the Windows renderer→main IPC was the export bottleneck). Audio is muxed
// in a cheap second ffmpeg pass. Same Compositor + same renderFrame ⇒ pixel-identical to preview (only the
// final RGB→H.264 encode differs — verify colour once). macOS was already fast; this makes Windows match it.

// Feature-detect: can this machine encode H.264 at this size? (true for hardware OR software — gate on a
// wall-clock probe in runEngineExport before trusting it for speed; always keep the rawvideo fallback.)
export async function canEncodeAvc(W, H) {
  try { return await canEncodeVideo('avc', { width: W, height: H }); } catch { return false; }
}

// Render the whole timeline to a VIDEO-ONLY mp4 (Uint8Array) via WebCodecs. main then ffmpeg-muxes the audio.
export async function renderExportFramesEncoded(spec) {
  const { W, H, fps, durationSec } = spec;
  const total = Math.max(1, Math.round(durationSec * fps));
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const comp = new Compositor(canvas);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: QUALITY_HIGH,                 // subjective high quality, scales with resolution
    keyFrameInterval: 2,                   // forced GOP every 2s — good seeking in players
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',                // NOT 'realtime' — we want picture quality, not low latency
  });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  let rendered = 0;
  try {
    for (let i = 0; i < total; i++) {
      if (spec.signal && spec.signal.aborted) break;
      const t = i / fps;
      if (spec.prepareFrame) await spec.prepareFrame(t);   // decode-wait BEFORE render (await is fine here)
      const frame = {
        W, H, bgColor: spec.bgColor, layers: spec.layers, time: t,
        videoStart: spec.videoStart, videoEnd: spec.videoEnd, dur: durationSec,
        backingScale: 1,                                   // ALWAYS full res for export
        getPx: spec.getPx,
        getSource: (l) => spec.getSource(l, t),
        getTextDraw: spec.getTextDraw ? (l) => spec.getTextDraw(l, t) : undefined,
        getCC: spec.getCC,
      };
      comp.renderFrame(frame);
      // CRITICAL (preserveDrawingBuffer:false): CanvasSource.add() captures the canvas SYNCHRONOUSLY here —
      // right after renderFrame and BEFORE any await — else the captured frame is BLACK. The returned promise
      // is the encoder/writer BACKPRESSURE (await it; no manual encodeQueueSize juggling needed).
      await source.add(t, 1 / fps);
      rendered++;
      if (spec.onProgress) spec.onProgress(rendered, total);
    }
    if (spec.signal && spec.signal.aborted) { try { await output.cancel(); } catch {} return null; }
    await output.finalize();
    const buf = output.target.buffer;
    return buf ? new Uint8Array(buf) : null;
  } catch (e) {
    try { await output.cancel(); } catch {}
    throw e;
  } finally {
    try { comp.dispose(true); } catch {}
  }
}
