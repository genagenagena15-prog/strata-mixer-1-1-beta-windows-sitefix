// Parity harness — render the SAME scene via canvas2d (replicating renderFrameRef) and via the
// WebGL2 Compositor, then pixel-diff. Proves geometry parity of Step A (video/image/overlay)
// before touching main.jsx. Result → console @@BENCH@@ (launcher writes proto/last-bench.json).

import { Compositor } from '/src/engine/compositor.js';
import { rasterizeText } from '/src/engine/textRaster.js';

const outW = 540, outH = 960, bg = '#101014';
const FONT = 'sans-serif';
const $ = (id) => document.getElementById(id);
const log = (m) => { console.log(m); const el = $('log'); if (el) el.textContent += m + '\n'; };

async function loadVideo(url) {
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('load ' + url)); });
  v.currentTime = Math.min(1, (v.duration || 2) / 2);
  await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); });
  return v;
}

// EXACT replica of getLayerPx (main.jsx ≈4694) for the types under test.
function getPx(layer) {
  const W = outW, H = outH;
  if (layer.type === 'mainVideo') {
    const vid = layer._el;
    const aspect = layer.aspect || ((vid && vid.videoWidth) ? vid.videoWidth / vid.videoHeight : W / H);
    const w = (layer.size || 100) / 100 * W, h = w / aspect;
    return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
  }
  if (layer.type === 'videoOverlay') {
    const ov = layer._el;
    const aspect = layer.aspect || ((ov && ov.videoWidth) ? ov.videoWidth / ov.videoHeight : 16 / 9);
    const w = (layer.size || 40) / 100 * W, h = w / aspect;
    return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
  }
  if (layer.type === 'image') {
    const img = layer._el;
    const aspect = layer.aspect || ((img && img.naturalWidth) ? img.naturalWidth / img.naturalHeight : 1);
    const w = (layer.size || 30) / 100 * W, h = w / aspect;
    return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
  }
  if (layer.type === 'blur' || layer.type === 'mask' || layer.type === 'maskedVideo') {
    const w = (layer.width || 50) / 100 * W, h = (layer.height || 30) / 100 * H;
    return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
  }
  return { w: 0, h: 0, x: 0, y: 0 };
}
let blurTmp = null;
let maskFullCanvas = null;
let zoomTmp = null;

// EXACT replica of renderFrameRef (main.jsx ≈4776) for the types under test.
function drawCanvas2D(ctx, layers, time) {
  const W = outW, H = outH;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  let maskInitDone = false, maskVFull = null;
  for (const layer of layers) {
    if (layer.hidden) continue;
    if (layer.type === 'mainVideo') {
      const b = getPx(layer);
      try { ctx.drawImage(layer._el, b.x, b.y, b.w, b.h); } catch {}
      continue;
    }
    const ls = layer.startTime || 0, le = layer.endTime !== undefined ? layer.endTime : 999;
    if (time < ls || time > le) continue;
    if (layer.type === 'image') {
      const b = getPx(layer);
      ctx.globalAlpha = (layer.opacity || 100) / 100;
      try { ctx.drawImage(layer._el, b.x, b.y, b.w, b.h); } catch {}
      ctx.globalAlpha = 1;
    } else if (layer.type === 'videoOverlay') {
      const b = getPx(layer);
      // cc replica of renderFrameRef ≈5101
      const ccf = `brightness(${100+(layer.ccB||0)}%) contrast(${layer.ccC??100}%) saturate(${layer.ccS??100}%) hue-rotate(${layer.ccH??0}deg)`;
      const hasCC = ccf !== 'brightness(100%) contrast(100%) saturate(100%) hue-rotate(0deg)';
      ctx.save();
      if (hasCC) ctx.filter = ccf;
      try { ctx.drawImage(layer._el, b.x, b.y, b.w, b.h); } catch {}
      ctx.restore();
    } else if (layer.type === 'blur') {
      // exact replica of renderFrameRef ≈4817 (S=1 here)
      const b = getPx(layer);
      const strength = Math.max(1, layer.strength || 10);
      const pad = Math.ceil(strength * 2.5);
      const cx0 = Math.max(0, Math.floor(b.x - pad)), cy0 = Math.max(0, Math.floor(b.y - pad));
      const cx1 = Math.min(W, Math.ceil(b.x + b.w + pad)), cy1 = Math.min(H, Math.ceil(b.y + b.h + pad));
      const cw = cx1 - cx0, ch = cy1 - cy0;
      if (cw > 0 && ch > 0) {
        const tmp = blurTmp || (blurTmp = document.createElement('canvas'));
        if (tmp.width !== cw) tmp.width = cw;
        if (tmp.height !== ch) tmp.height = ch;
        const tctx = tmp.getContext('2d');
        tctx.clearRect(0, 0, cw, ch);
        try { tctx.drawImage(ctx.canvas, cx0, cy0, cw, ch, 0, 0, cw, ch); } catch {}
        ctx.save();
        ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
        ctx.filter = `blur(${strength}px)`;
        try { ctx.drawImage(tmp, 0, 0, cw, ch, cx0, cy0, cw, ch); } catch {}
        ctx.filter = 'none';
        ctx.restore();
      }
    } else if (layer.type === 'mask') {
      // exact replica of renderFrameRef ≈4841 (union model, S=1)
      const b = getPx(layer);
      const r = Math.max(0, Math.min(Math.min(b.w, b.h) / 2, (layer.radius || 0) / 100 * Math.min(b.w, b.h) / 2));
      if (!maskInitDone) {
        const vf = maskFullCanvas || (maskFullCanvas = document.createElement('canvas'));
        if (vf.width !== W) vf.width = W;
        if (vf.height !== H) vf.height = H;
        const vfx = vf.getContext('2d');
        vfx.setTransform(1, 0, 0, 1, 0, 0);
        vfx.clearRect(0, 0, W, H);
        try { vfx.drawImage(ctx.canvas, 0, 0); } catch {}
        maskVFull = vf;
        ctx.save();
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
        const mv = layers.find(l => l.type === 'mainVideo');
        if (mv && !mv.hidden) {
          const mb = getPx(mv);
          try { ctx.drawImage(mv._el, mb.x, mb.y, mb.w, mb.h); } catch {}
        }
        ctx.restore();
        maskInitDone = true;
      }
      ctx.save();
      ctx.beginPath();
      if (layer.shape === 'circle') {
        ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      } else if (layer.shape === 'rounded') {
        const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
        ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r);
        ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r);
        ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r);
        ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r);
      } else {
        ctx.rect(b.x, b.y, b.w, b.h);
      }
      ctx.clip();
      if (maskVFull) { try { ctx.drawImage(maskVFull, 0, 0, W, H); } catch {} }
      ctx.restore();
    } else if (layer.type === 'maskedVideo') {
      // exact replica of renderFrameRef ≈5115 (S=1; src = the live video element)
      const b = getPx(layer);
      const r = Math.max(0, Math.min(Math.min(b.w, b.h) / 2, (layer.radius || 0) / 100 * Math.min(b.w, b.h) / 2));
      const src = layer._el;
      ctx.save();
      ctx.beginPath();
      if (layer.shape === 'circle') {
        ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      } else if (layer.shape === 'rounded') {
        const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
        ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r);
        ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r);
        ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r);
        ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r);
      } else {
        ctx.rect(b.x, b.y, b.w, b.h);
      }
      ctx.clip();
      // cc replica of renderFrameRef ≈5151 (inside the save/clip; restored at the branch end)
      const mccf = `brightness(${100+(layer.ccB||0)}%) contrast(${layer.ccC??100}%) saturate(${layer.ccS??100}%) hue-rotate(${layer.ccH??0}deg)`;
      if (mccf !== 'brightness(100%) contrast(100%) saturate(100%) hue-rotate(0deg)') ctx.filter = mccf;
      if (src && (src.videoWidth || src.naturalWidth)) {
        const sW = src.videoWidth || src.naturalWidth;
        const sH = src.videoHeight || src.naturalHeight;
        if (layer.srcCrop) {
          const c = layer.srcCrop;
          const sx = Math.max(0, Math.min(sW - 1, c.x));
          const sy = Math.max(0, Math.min(sH - 1, c.y));
          const sw = Math.max(1, Math.min(sW - sx, c.w));
          const sh = Math.max(1, Math.min(sH - sy, c.h));
          try { ctx.drawImage(src, sx, sy, sw, sh, b.x, b.y, b.w, b.h); } catch {}
        } else {
          const vAsp = sW / sH, bAsp = b.w / b.h;
          let dw, dh, dx, dy;
          if (vAsp > bAsp) { dh = b.h; dw = dh * vAsp; dx = b.x + (b.w - dw) / 2; dy = b.y; }
          else { dw = b.w; dh = dw / vAsp; dx = b.x; dy = b.y + (b.h - dh) / 2; }
          try { ctx.drawImage(src, dx, dy, dw, dh); } catch {}
        }
      }
      ctx.restore();
    } else if (layer.type === 'text') {
      // exact replica of renderFrameRef ≈4901
      const fs = layer.size || 48;
      ctx.save();
      ctx.font = `${fs}px ${FONT}`;
      ctx.textAlign = layer.align || 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = (layer.opacity || 100) / 100;
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
      ctx.fillStyle = layer.color || '#ffffff';
      ctx.fillText(layer.text || '', (layer.x / 100) * W, (layer.y / 100) * H);
      ctx.restore();
    } else if (layer.type === 'zoom') {
      // exact replica of renderFrameRef ≈5304 (S=1)
      const zls = layer.startTime || 0, zle = layer.endTime != null ? layer.endTime : 999;
      const zspan = Math.max(0.1, zle - zls);
      const zp = (time - zls) / zspan;
      const ztri = Math.max(0, zp < 0.5 ? zp * 2 : (1 - zp) * 2);
      const zf = 1 + (Math.max(0, layer.strength || 0) / 100) * ztri;
      if (zf > 1.001) {
        const tmp = zoomTmp || (zoomTmp = document.createElement('canvas'));
        if (tmp.width !== W) tmp.width = W;
        if (tmp.height !== H) tmp.height = H;
        const tctx = tmp.getContext('2d');
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.clearRect(0, 0, W, H);
        try { tctx.drawImage(ctx.canvas, 0, 0); } catch {}
        ctx.clearRect(0, 0, W, H);
        const dw = W * zf, dh = H * zf;
        try { ctx.drawImage(tmp, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch {}
      }
    } else if (layer.type === 'transition') {
      // exact replica of renderFrameRef ≈5174 (shake kind, S=1)
      const tls = layer.startTime || 0, tle = layer.endTime != null ? layer.endTime : 999;
      const span = Math.max(0.01, tle - tls);
      const tProg = Math.max(0, Math.min(1, (time - tls) / span));
      const t = time;
      const kind = layer.kind || 'shake';
      const tmp = blurTmp || (blurTmp = document.createElement('canvas'));
      if (tmp.width !== W) tmp.width = W;
      if (tmp.height !== H) tmp.height = H;
      const tctx = tmp.getContext('2d');
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      const peak = Math.sin(tProg * Math.PI);
      if (kind === 'shake') {
        const amp = (layer.amp || 30);
        const decay = 1 - tProg * 0.85;
        const ox = (Math.sin(t * 113) * 0.6 + Math.sin(t * 187) * 0.4) * amp * decay;
        const oy = (Math.cos(t * 97) * 0.6 + Math.cos(t * 151) * 0.4) * amp * decay;
        tctx.clearRect(0, 0, W, H);
        try { tctx.drawImage(ctx.canvas, 0, 0); } catch {}
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
        try { ctx.drawImage(tmp, ox, oy, W, H); } catch {}
        const flashMax = layer.flash != null ? layer.flash : 0.85;
        const alpha = tProg < 0.15 ? (tProg / 0.15) * flashMax : Math.max(0, flashMax * (1 - (tProg - 0.15) / 0.85));
        if (alpha > 0.001) {
          ctx.save(); ctx.globalAlpha = Math.min(1, alpha);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); ctx.restore();
        }
      } else if (kind === 'whippan') {
        const shiftMax = (layer.shift || 60) / 100 * W;
        const blurMax = layer.blur || 22;
        const xOff = Math.sin(tProg * Math.PI) * shiftMax;
        const blurNow = blurMax * peak;
        tctx.clearRect(0, 0, W, H);
        try { tctx.drawImage(ctx.canvas, 0, 0); } catch {}
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
        ctx.save();
        if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
        try { ctx.drawImage(tmp, xOff, 0, W, H); } catch {}
        ctx.restore();
      } else if (kind === 'zoom') {
        const scaleMax = layer.scale || 2;
        const blurMax = layer.blur || 8;
        const scale = 1 + (scaleMax - 1) * peak;
        const blurNow = blurMax * peak;
        if (scale > 1.001 || blurNow > 0.5) {
          tctx.clearRect(0, 0, W, H);
          try { tctx.drawImage(ctx.canvas, 0, 0); } catch {}
          ctx.clearRect(0, 0, W, H);
          ctx.save();
          if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
          const dw = W * scale, dh = H * scale;
          try { ctx.drawImage(tmp, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch {}
          ctx.restore();
        }
      } else if (kind === 'blur') {
        const blurMax = layer.blur || 25;
        const blurNow = blurMax * peak;
        if (blurNow > 0.5) {
          tctx.clearRect(0, 0, W, H);
          try { tctx.drawImage(ctx.canvas, 0, 0); } catch {}
          ctx.clearRect(0, 0, W, H);
          ctx.save();
          ctx.filter = `blur(${blurNow}px)`;
          try { ctx.drawImage(tmp, 0, 0, W, H); } catch {}
          ctx.restore();
        }
      } else if (kind === 'seamzoom') {
        const scaleMax = layer.scale || 4.5;
        const blurMax = layer.blur || 16;
        const rgbMax = layer.rgb || 9;
        const flashMax = layer.flash != null ? layer.flash : 0.28;
        const sc = 1 + (scaleMax - 1) * peak;
        const blurNow = blurMax * peak;
        const rgbNow = rgbMax * peak;
        tctx.clearRect(0, 0, W, H);
        try { tctx.drawImage(ctx.canvas, 0, 0); } catch {}
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
        const dw = W * sc, dh = H * sc;
        const dx = (W - dw) / 2, dy = (H - dh) / 2;
        ctx.save();
        if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
        try { ctx.drawImage(tmp, dx, dy, dw, dh); } catch {}
        ctx.restore();
        if (rgbNow > 0.5) {
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = 0.4;
          if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
          try { ctx.drawImage(tmp, dx + rgbNow, dy, dw, dh); } catch {}
          try { ctx.drawImage(tmp, dx - rgbNow, dy, dw, dh); } catch {}
          ctx.restore();
        }
        if (peak > 0.5) {
          const fAlpha = ((peak - 0.5) / 0.5) * flashMax;
          if (fAlpha > 0.001) {
            ctx.save(); ctx.globalAlpha = Math.min(1, fAlpha);
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); ctx.restore();
          }
        }
      }
    }
  }
}

async function main() {
  try {
    const names = await (await fetch('/proto/testmedia/manifest.json')).json();
    const base = '/proto/testmedia/';
    log('[parity] loading videos…');
    const v0 = await loadVideo(base + names[0]); // 720x1280
    const v1 = await loadVideo(base + names[3]); // 1080x1350
    const v2 = await loadVideo(base + names[2]); // 944x944

    const trKind = new URLSearchParams(location.search).get('kind') || 'shake';
    log('[parity] transition kind = ' + trKind);
    const layers = [
      { id: 'm', type: 'mainVideo', x: 50, y: 50, size: 100, aspect: v0.videoWidth / v0.videoHeight, _el: v0 },
      { id: 'a', type: 'videoOverlay', x: 32, y: 34, size: 46, startTime: 0, endTime: 999, ccB: 18, ccC: 128, ccS: 140, ccH: 30, aspect: v1.videoWidth / v1.videoHeight, _el: v1 },
      { id: 'b', type: 'videoOverlay', x: 70, y: 68, size: 40, startTime: 0, endTime: 999, aspect: v2.videoWidth / v2.videoHeight, _el: v2 },
      { id: 'bl', type: 'blur', x: 50, y: 52, width: 64, height: 26, strength: 14, startTime: 0, endTime: 999 },
      { id: 'mk', type: 'mask', x: 40, y: 45, width: 42, height: 34, shape: 'circle', startTime: 0, endTime: 999 },
      { id: 'mv', type: 'maskedVideo', x: 64, y: 38, width: 34, height: 30, shape: 'rounded', radius: 40, srcCrop: { x: 300, y: 350, w: 480, h: 480 }, startTime: 0, endTime: 999, ccB: -12, ccC: 118, ccS: 85, ccH: -25, aspect: v1.videoWidth / v1.videoHeight, _el: v1 },
      { id: 't', type: 'text', x: 50, y: 82, size: 58, color: '#ffe14d', align: 'center', text: 'СТРАТА', opacity: 100, startTime: 0, endTime: 999 },
      { id: 'z', type: 'zoom', strength: 60, startTime: 0.5, endTime: 1.5 },
      { id: 'tr', type: 'transition', kind: trKind, amp: 22, flash: 0.4, shift: 55, blur: 6, scale: 2.2, rgb: 8, startTime: 0.6, endTime: 1.4 },
    ];
    const time = 1;

    // canvas2d path
    const c2 = $('c2'); c2.width = outW; c2.height = outH;
    const ctx = c2.getContext('2d', { willReadFrequently: true });
    drawCanvas2D(ctx, layers, time);

    // webgl path
    const cg = $('cg');
    const comp = new Compositor(cg);
    comp.renderFrame({
      W: outW, H: outH, bgColor: bg, layers, time, videoStart: 0, videoEnd: 999, dur: 999,
      getPx, getSource: (l) => l._el,
      getTextDraw: (l) => l.type === 'text' ? [rasterizeText(l, outW, outH, FONT)] : [],
      getCC: (l) => {
        if (l.type !== 'videoOverlay' && l.type !== 'maskedVideo') return null;
        const B = (100 + (l.ccB || 0)) / 100, C = (l.ccC ?? 100) / 100, Sa = (l.ccS ?? 100) / 100, Hh = l.ccH ?? 0;
        if (B === 1 && C === 1 && Sa === 1 && Hh === 0) return null;
        return { b: B, c: C, s: Sa, h: Hh };
      },
    });

    // diff (canvas2d row0=top; webgl readPixels row0=bottom → flip)
    const a = ctx.getImageData(0, 0, outW, outH).data;
    const g = comp.readPixels(outW, outH);
    let sum = 0, max = 0, over = 0;
    const diff = ctx.createImageData(outW, outH);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const ai = (y * outW + x) * 4;
        const gi = ((outH - 1 - y) * outW + x) * 4; // flip vertical
        let dmax = 0;
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.abs(a[ai + ch] - g[gi + ch]);
          sum += d; if (d > dmax) dmax = d;
        }
        if (dmax > max) max = dmax;
        if (dmax > 8) over++;
        const amp = Math.min(255, dmax * 6);
        diff.data[ai] = amp; diff.data[ai + 1] = amp; diff.data[ai + 2] = amp; diff.data[ai + 3] = 255;
      }
    }
    const n = outW * outH;
    const mae = sum / (n * 3);
    const pctOver = (over / n) * 100;
    const c3 = $('c3'); c3.width = outW; c3.height = outH;
    c3.getContext('2d').putImageData(diff, 0, 0);

    const verdict = (mae < 3 && pctOver < 2) ? 'PARITY OK ✅' : (mae < 8 ? 'CLOSE ⚠ (resampler diff at edges)' : 'DIVERGES ❌');
    $('verdict').textContent = `${verdict}  ·  MAE ${mae.toFixed(2)} · max ${max} · >8diff ${pctOver.toFixed(2)}%`;
    $('verdict').className = 'verdict ' + (mae < 3 ? 'ok' : mae < 8 ? 'warn' : 'bad');
    log(`[parity] MAE=${mae.toFixed(3)} max=${max} over8=${pctOver.toFixed(2)}% verdict=${verdict}`);
    log('@@BENCH@@' + JSON.stringify({ mae: +mae.toFixed(3), max, pctOver8: +pctOver.toFixed(2), verdict }));
  } catch (e) {
    $('verdict').textContent = 'ERROR: ' + e.message;
    $('verdict').className = 'verdict bad';
    log('[error] ' + (e.stack || e.message));
    log('@@BENCH@@' + JSON.stringify({ error: e.message }));
  }
}

window.addEventListener('DOMContentLoaded', () => setTimeout(main, 300));
