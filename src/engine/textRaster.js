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
