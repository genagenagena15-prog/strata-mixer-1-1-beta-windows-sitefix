// src/engine/textRaster.js — rasterize text EXACTLY as renderFrameRef draws it, into a fitted
// offscreen canvas, returned as a TexImageSource + its output-space box. Because it's the same
// canvas2d rasterizer the preview uses, compositing this texture is pixel-identical to the old
// direct draw — and the SAME function feeds the export path, so libass is no longer needed.

let _measCtx = null;
function measCtx() {
  if (!_measCtx) _measCtx = document.createElement('canvas').getContext('2d');
  return _measCtx;
}

// Mirrors renderFrameRef ≈4901: font `${fs}px ${fontCss}`, baseline middle, align, opacity,
// hard drop-shadow (rgba(0,0,0,.85) offset 2,2), fill = layer.color, at (x%,y%).
export function rasterizeText(layer, W, H, fontFamilyCss) {
  const fs = layer.size || 48;
  const text = layer.text || '';
  const align = layer.align || 'center';
  const cx = (layer.x / 100) * W, cy = (layer.y / 100) * H;

  const m = measCtx();
  m.font = `${fs}px ${fontFamilyCss}`;
  const tw = m.measureText(text).width;

  const padX = Math.ceil(fs * 0.4) + 8;     // room for overhang + shadow + AA
  const boxW = Math.max(2, Math.ceil(tw + padX * 2));
  const boxH = Math.max(2, Math.ceil(fs * 2 + 6));

  const c = document.createElement('canvas');
  c.width = boxW; c.height = boxH;
  const ctx = c.getContext('2d');
  ctx.font = `${fs}px ${fontFamilyCss}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';                   // position manually so the box is align-agnostic
  ctx.globalAlpha = (layer.opacity || 100) / 100;
  ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
  ctx.fillStyle = layer.color || '#ffffff';
  ctx.fillText(text, padX, boxH / 2);

  const leftOnOutput = align === 'center' ? cx - tw / 2 : align === 'right' ? cx - tw : cx;
  return { source: c, x: leftOnOutput - padX, y: cy - boxH / 2, w: boxW, h: boxH };
}

// Rasterize ONE subtitle word (or the base/highlight variant) into a fitted canvas.
// `box` = {cx, cy, w} from buildSubtitleLayout (output px); style carries colour/font/outline.
// Kept separate so karaoke can render base + highlight as two draws with different styles.
// `alphaOnly` = produce a WHITE-glyph-on-transparent raster (NO outline/shadow/colour) so its
// alpha channel is pure glyph coverage — the input the GPU text-style shader (effects/textStyles.js
// FS_TEXT) wants (it paints colour/glow/outline itself). Extra padding gives the glow room to bleed.
// Without the flag this is byte-for-byte the original colour-baked raster (shipping path unchanged).
export function rasterizeWord(word, box, style, fontFamilyCss, alphaOnly) {
  const fs = Number(style.fontSize) || 56;
  const text = word || '';
  const m = measCtx();
  m.font = `${fs}px ${fontFamilyCss}`;
  const tw = m.measureText(text).width;
  const outline = alphaOnly ? 0 : (Number(style.outline) || 0);
  const blur = alphaOnly ? 0 : (Number(style.blur) || 0);   // blurfocus anim
  const glowPad = alphaOnly ? Math.ceil(fs * 0.6) : 0;      // headroom for the shader's glow spread
  const padX = Math.ceil(fs * 0.4) + 8 + outline + Math.ceil(blur) + glowPad;
  const padY = Math.ceil(fs * 0.4) + 8 + outline + Math.ceil(blur) + glowPad;
  const boxW = Math.max(2, Math.ceil(tw + padX * 2));
  const boxH = Math.max(2, Math.ceil(fs + padY * 2));
  const c = document.createElement('canvas');
  c.width = boxW; c.height = boxH;
  const ctx = c.getContext('2d');
  ctx.font = `${fs}px ${fontFamilyCss}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';                                // matches renderFrameRef ≈5010
  ctx.miterLimit = 2;
  const mx = boxW / 2, my = boxH / 2;
  if (alphaOnly) {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, mx, my);
    return { source: c, x: box.cx - boxW / 2, y: box.cy - boxH / 2, w: boxW, h: boxH };
  }
  if (blur > 0.1) ctx.filter = `blur(${blur}px)`;
  if (outline > 0) {
    ctx.lineWidth = outline * 2;
    ctx.strokeStyle = style.outlineColor || '#000000';
    ctx.strokeText(text, mx, my);
  }
  ctx.fillStyle = style.color || '#ffffff';
  ctx.fillText(text, mx, my);
  return { source: c, x: box.cx - boxW / 2, y: box.cy - boxH / 2, w: boxW, h: boxH };
}

// Rasterize a rounded background PLATE («подложка») sized to ONE subtitle word + padding, centred at
// box.cx/cy. Returned like rasterizeWord so the compositor draws it as a plain COLOURED quad (no
// FS_TEXT) BEHIND the word, riding the same anim transform. Tunable via style.plate* (defaults below).
export function rasterizePlate(word, box, style, fontFamilyCss) {
  const fs = Number(style.fontSize) || 56;
  const m = measCtx();
  m.font = `${fs}px ${fontFamilyCss}`;
  const tw = m.measureText(word || '').width;
  const padX = Math.round(fs * (style.platePadX != null ? style.platePadX : 0.34));
  const padY = Math.round(fs * (style.platePadY != null ? style.platePadY : 0.20));
  const plateW = tw + padX * 2;
  const plateH = fs + padY * 2;
  const margin = 6;                                  // canvas headroom so rounded corners aren't clipped
  const boxW = Math.max(2, Math.ceil(plateW + margin * 2));
  const boxH = Math.max(2, Math.ceil(plateH + margin * 2));
  const c = document.createElement('canvas');
  c.width = boxW; c.height = boxH;
  const ctx = c.getContext('2d');
  const r = Math.min(plateH / 2, Math.round(fs * (style.plateRadius != null ? style.plateRadius : 0.32)));
  ctx.globalAlpha = (style.plateOpacity != null ? style.plateOpacity : 60) / 100;
  ctx.fillStyle = style.plateColor || '#000000';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(margin, margin, plateW, plateH, r);
  else ctx.rect(margin, margin, plateW, plateH);
  ctx.fill();
  return { source: c, x: box.cx - boxW / 2, y: box.cy - boxH / 2, w: boxW, h: boxH };
}
