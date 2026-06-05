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
// Per-(text/size/font/colour/outline) RASTER CACHE. The glyph bitmap a word produces is IDENTICAL on
// every frame — only its POSITION and anim scale change, and those are applied at DRAW time, not baked
// into the pixels. Re-running a fresh canvas + fillText for every word on EVERY frame is what made
// subtitle EXPORTS crawl (a 20s/30fps clip = thousands of identical re-rasters). Cache the canvas once
// per unique key, recompute only the position-dependent x/y on return. Bounded (oldest-evicted).
const _wordCache = new Map();   // key -> { source: canvas, w, h }
const _plateCache = new Map();
const _RASTER_CACHE_MAX = 1500;
function _rasterCachePut(cache, key, val) {
  if (cache.size >= _RASTER_CACHE_MAX) { const oldest = cache.keys().next().value; cache.delete(oldest); }
  cache.set(key, val);
}

export function rasterizeWord(word, box, style, fontFamilyCss, alphaOnly) {
  const fs = Number(style.fontSize) || 56;
  const text = word || '';
  const outline = alphaOnly ? 0 : (Number(style.outline) || 0);
  const blur = alphaOnly ? 0 : (Number(style.blur) || 0);   // blurfocus anim
  const color = style.color || '#ffffff';
  const outlineColor = style.outlineColor || '#000000';
  const key = (alphaOnly ? 'A|' : 'C|') + text + '|' + fs + '|' + fontFamilyCss +
    (alphaOnly ? '' : ('|' + color + '|' + outlineColor + '|' + outline + '|' + blur));
  let r = _wordCache.get(key);
  if (r) { _wordCache.delete(key); _wordCache.set(key, r); }   // LRU: refresh recency so a still-used word survives eviction
  if (!r) {
    const m = measCtx();
    m.font = `${fs}px ${fontFamilyCss}`;
    const tw = m.measureText(text).width;
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
    } else {
      if (blur > 0.1) ctx.filter = `blur(${blur}px)`;
      if (outline > 0) {
        ctx.lineWidth = outline * 2;
        ctx.strokeStyle = outlineColor;
        ctx.strokeText(text, mx, my);
      }
      ctx.fillStyle = color;
      ctx.fillText(text, mx, my);
    }
    r = { source: c, w: boxW, h: boxH };
    _rasterCachePut(_wordCache, key, r);
  }
  // rkey = stable identity of THIS glyph bitmap → the compositor uploads it to a GL texture ONCE and
  // reuses it across frames instead of re-uploading the same word every frame.
  return { source: r.source, x: box.cx - r.w / 2, y: box.cy - r.h / 2, w: r.w, h: r.h, rkey: key };
}

// Rasterize a rounded background PLATE («подложка») sized to ONE subtitle word + padding, centred at
// box.cx/cy. Returned like rasterizeWord so the compositor draws it as a plain COLOURED quad (no
// FS_TEXT) BEHIND the word, riding the same anim transform. Tunable via style.plate* (defaults below).
export function rasterizePlate(word, box, style, fontFamilyCss) {
  const fs = Number(style.fontSize) || 56;
  const plateColor = style.plateColor || '#000000';
  const plateOpacity = (style.plateOpacity != null ? style.plateOpacity : 60);
  const platePadX = (style.platePadX != null ? style.platePadX : 0.34);
  const platePadY = (style.platePadY != null ? style.platePadY : 0.20);
  const plateRadius = (style.plateRadius != null ? style.plateRadius : 0.32);
  const key = (word || '') + '|' + fs + '|' + fontFamilyCss + '|' + plateColor + '|' + plateOpacity + '|' + platePadX + '|' + platePadY + '|' + plateRadius;
  let r = _plateCache.get(key);
  if (r) { _plateCache.delete(key); _plateCache.set(key, r); }   // LRU: refresh recency (Map reorder only)
  if (!r) {
    const m = measCtx();
    m.font = `${fs}px ${fontFamilyCss}`;
    const tw = m.measureText(word || '').width;
    const padX = Math.round(fs * platePadX);
    const padY = Math.round(fs * platePadY);
    const plateW = tw + padX * 2;
    const plateH = fs + padY * 2;
    const margin = 6;                                  // canvas headroom so rounded corners aren't clipped
    const boxW = Math.max(2, Math.ceil(plateW + margin * 2));
    const boxH = Math.max(2, Math.ceil(plateH + margin * 2));
    const c = document.createElement('canvas');
    c.width = boxW; c.height = boxH;
    const ctx = c.getContext('2d');
    const rad = Math.min(plateH / 2, Math.round(fs * plateRadius));
    ctx.globalAlpha = plateOpacity / 100;
    ctx.fillStyle = plateColor;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(margin, margin, plateW, plateH, rad);
    else ctx.rect(margin, margin, plateW, plateH);
    ctx.fill();
    r = { source: c, w: boxW, h: boxH };
    _rasterCachePut(_plateCache, key, r);
  }
  return { source: r.source, x: box.cx - r.w / 2, y: box.cy - r.h / 2, w: r.w, h: r.h, rkey: 'P|' + key };
}
