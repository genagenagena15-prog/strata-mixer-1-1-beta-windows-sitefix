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
  try {
    for (let i = 0; i < total; i++) {
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
      const raw = comp.readPixels(W, H);                  // GL order: row 0 = bottom
      const accepted = await onFrame(flipRows(raw, W, H), i);  // → top-down for ffmpeg rawvideo
      if (accepted === false) break;                      // ffmpeg stopped reading (closed/died) → stop, don't hang
      rendered++;
      if (spec.onProgress) spec.onProgress(rendered, total);
    }
  } finally {
    comp.dispose();
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
