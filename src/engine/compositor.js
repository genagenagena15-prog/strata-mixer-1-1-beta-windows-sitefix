// src/engine/compositor.js — the ONE WebGL2 compositor (source of truth for preview AND export).
// Step A: mainVideo / image / videoOverlay, drawn from DOM <video>/<img> textures using the
// app's getLayerPx geometry, in z-order, into an offscreen FBO, then blit to the canvas.
// mask/blur/text/subtitles/transition/zoom come in later steps; WebCodecs 0-copy replaces the
// DOM-video source on Tier A. Geometry is NEVER re-derived here — it comes from getPx (=getLayerPx).

import {
  getGL, makeProgram, createUnitQuad, createTexture, createFBO,
  uploadElement, VS_QUAD, pxRectToNDC,
} from './gl.js';
import { FS_TRANSITIONS, TRANSITION_TYPE } from './effects/transitions.js';
import { FS_TEXT } from './effects/textStyles.js';

// CSS-filter colour-correct, shared by every shader that cc's. Mirrors canvas2d
// `ctx.filter = brightness(%) contrast(%) saturate(%) hue-rotate(deg)` APPLIED IN THAT ORDER, in
// sRGB. brightness = MUL factor (NOT add), contrast = affine, saturate = Rec709 luma mix, hue-rotate
// = SVG feColorMatrix hueRotate (0.213/0.715/0.072). Neutral = B1, C1, S1, H0.
const CC_GLSL = `
vec3 hueRotate709(vec3 c, float deg){
  float a = deg * 0.01745329252;
  float cs = cos(a), sn = sin(a);
  return vec3(
    (0.213+cs*0.787-sn*0.213)*c.r + (0.715-cs*0.715-sn*0.715)*c.g + (0.072-cs*0.072+sn*0.928)*c.b,
    (0.213-cs*0.213+sn*0.143)*c.r + (0.715+cs*0.285+sn*0.140)*c.g + (0.072-cs*0.072-sn*0.283)*c.b,
    (0.213-cs*0.213-sn*0.787)*c.r + (0.715-cs*0.715+sn*0.715)*c.g + (0.072+cs*0.928+sn*0.072)*c.b
  );
}
vec3 applyCC(vec3 c, float B, float C, float Sa, float Hdeg){
  c *= B;
  c = (c - 0.5) * C + 0.5;
  float l = dot(c, vec3(0.213, 0.715, 0.072));
  c = mix(vec3(l), c, Sa);
  if(Hdeg != 0.0) c = hueRotate709(c, Hdeg);
  return c;
}`;

const FS_LAYER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uB, uC, uS, uH;   // CSS-filter cc: brightness FACTOR, contrast, saturate, hue°
out vec4 frag;
${CC_GLSL}
void main(){
  vec4 t = texture(uTex, vUv);
  vec3 c = applyCC(t.rgb, uB, uC, uS, uH);
  frag = vec4(clamp(c, 0.0, 1.0), t.a * uOpacity);
}`;

// Chroma key ("Удалить фон"): same as FS_LAYER but pixels whose CHROMA (Cb/Cr) is close to the
// key colour get alpha→0, revealing the layer below (the keyed layer is drawn with the normal
// src-over blend, so transparent areas show whatever the scene already holds). Keying on Cb/Cr
// (not RGB) is brightness-independent and mirrors ffmpeg's `chromakey` (YUV) used on the Tier-B
// export path → preview==export. a = smoothstep(thresh, thresh+smooth, dist): 0 = keyed out (the
// background colour), 1 = fully kept; the band in between feathers the edge. CC applied after.
const FS_CHROMA = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uB, uC, uS, uH;   // CSS-filter cc (same as FS_LAYER)
uniform vec3 uKey;              // key colour rgb 0..1
uniform float uThresh;         // chroma distance below which a pixel is fully keyed out
uniform float uSmooth;         // feather band width above uThresh
out vec4 frag;
${CC_GLSL}
vec2 chroma(vec3 c){
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec2(c.b - y, c.r - y);   // (Cb, Cr) up to scale
}
void main(){
  vec4 t = texture(uTex, vUv);
  float d = distance(chroma(t.rgb), chroma(uKey));
  float a = smoothstep(uThresh, uThresh + max(uSmooth, 1e-4), d);
  vec3 c = applyCC(t.rgb, uB, uC, uS, uH);
  frag = vec4(clamp(c, 0.0, 1.0), t.a * a * uOpacity);
}`;

const FS_BLIT = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; out vec4 frag;
void main(){ frag = texture(uTex, vUv); }`;

// rgb *= uMul (keep alpha). For the seamzoom chromatic ghost drawn under a 'screen' blend:
// canvas2d `globalCompositeOperation='screen'; globalAlpha=0.4` == blendFunc(ONE_MINUS_DST_COLOR, ONE)
// with the source rgb pre-scaled by 0.4 → Cr = 0.4*Cs*(1-Cd) + Cd.
const FS_MUL = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; uniform float uMul; out vec4 frag;
void main(){ vec4 t = texture(uTex, vUv); frag = vec4(t.rgb * uMul, t.a); }`;

// Pixelation: snap the sample UV to a uBlocks (x,y) grid → true blocks. Sampled with the source
// texture set to NEAREST for crisp edges. Mirrors canvas2d's downscale→upscale-nearest pixelize
// (renderFrameRef pixelize ≈5432) and the ffmpeg scale=flags=neighbor export. Orientation-invariant
// (symmetric quantize) so it inherits the verified snapshot-blit Y-handling unchanged.
const FS_PIXELIZE = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; uniform vec2 uBlocks; out vec4 frag;
void main(){
  vec2 uv = (floor(vUv * uBlocks) + 0.5) / uBlocks;
  frag = texture(uTex, uv);
}`;

// Separable gaussian — matches CSS filter:blur(strength px) (stdDeviation = strength).
const FS_GAUSS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;      // direction * texel (1/res)
uniform float uSigma;
uniform int uRadius;
out vec4 frag;
void main(){
  float wsum = 0.0; vec4 acc = vec4(0.0);
  for(int i=-180;i<=180;i++){
    if(i < -uRadius || i > uRadius) continue;
    float w = exp(-float(i*i) / (2.0*uSigma*uSigma));
    acc += w * texture(uTex, vUv + uStep*float(i));
    wsum += w;
  }
  frag = acc / wsum;
}`;

// Copy a source texture into a sub-rect of the destination, sampled by SCREEN position
// (gl_FragCoord) so the blurred region lands exactly where it was captured from.
const FS_COPYRECT = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
out vec4 frag;
void main(){ frag = texture(uTex, gl_FragCoord.xy / uRes); }`;

// Drop shadow / outer glow tint pass ("Эффекты слоя"): take a BLURRED SILHOUETTE (uTex — only its
// ALPHA channel matters, RGB is ignored) and paint it as a SOLID-coloured shadow, sampled by screen
// position shifted by uOffset (= dx,dy in backing px, y already flipped for FBO y-up), so the shadow
// lands offset from the layer. Output rgb = uColor (the shadow/glow colour), alpha = blurredAlpha ×
// uOpacity. Composited over the scene with a normal src-over blend (shadow) or additive (glow). Used
// BEFORE the layer itself is drawn → the layer sits on top of its own shadow, like Photoshop.
const FS_SHADOW = `#version 300 es
precision highp float;
uniform sampler2D uTex;   // blurred silhouette (alpha = shape coverage)
uniform vec2 uRes;
uniform vec2 uOffset;     // shadow shift in backing px (x right, y already flipped to FBO y-up)
uniform vec3 uColor;      // shadow/glow rgb 0..1
uniform float uOpacity;   // 0..1 overall shadow strength
uniform float uHard;      // 0 = soft shadow/glow (default, unchanged). >0 = OUTLINE: cut the blurred
                          // silhouette at this alpha level → a crisp DILATED shape; the ring that
                          // sticks out from under the layer reads as a stroke.
uniform int uGradN;       // 0 = flat uColor (shadow/glow + solid outline). 2..4 = gradient stop count.
uniform vec3 uGradC0; uniform vec3 uGradC1; uniform vec3 uGradC2; uniform vec3 uGradC3;
uniform vec2 uGradDir;    // gradient axis = (cosθ, -sinθ): screen y-down folded into the FBO's y-up.
uniform vec4 uGradRect;   // layer rect in FBO uv (x,y,w,h) so the gradient spans the LAYER, not the frame.
out vec4 frag;
vec3 gradAt(float t){     // up-to-4 evenly-spaced stops
  if(uGradN <= 2) return mix(uGradC0, uGradC1, t);
  float s = t * float(uGradN - 1);
  if(uGradN == 3) return (s < 1.0) ? mix(uGradC0, uGradC1, s) : mix(uGradC1, uGradC2, s - 1.0);
  if(s < 1.0) return mix(uGradC0, uGradC1, s);
  if(s < 2.0) return mix(uGradC1, uGradC2, s - 1.0);
  return mix(uGradC2, uGradC3, s - 2.0);
}
void main(){
  vec2 uv = (gl_FragCoord.xy - uOffset) / uRes;
  float a = texture(uTex, uv).a;
  // sampling outside the silhouette texture must read 0 (CLAMP_TO_EDGE could smear an edge value
  // across the offset gap) → hard-zero anything outside [0,1].
  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) a = 0.0;
  if(uHard > 0.0) a = smoothstep(uHard * 0.6, uHard * 1.4, a);   // outline: blurred → crisp dilated edge
  vec3 col = uColor;
  if(uGradN >= 2){
    vec2 p = (uv - uGradRect.xy) / uGradRect.zw;            // 0..1 within the layer box
    float tt = clamp(dot(p - 0.5, uGradDir) + 0.5, 0.0, 1.0);
    col = gradAt(tt);
  }
  frag = vec4(col, a * uOpacity);
}`;

// Outline alpha cut level for the FS_SHADOW uHard path. Tuned so that, with the shadow pass's
// sigma = width·S, the dilation ≈ `width` frame-px (the stroke thickness the user dials in).
const OUTLINE_THRESH = 0.16;

// Mask stamp: draw the FULL composite (uFull, sampled by screen pos) inside this mask's shape.
// alpha = inside the shape (rect / ellipse / rounded-rect, ~1px AA). Multiple masks union.
const FS_MASKSTAMP = `#version 300 es
precision highp float;
in vec2 vUv;                 // 0..1 across the mask rect
uniform sampler2D uFull;
uniform vec2 uRes;
uniform int uShape;          // 0 rect, 1 ellipse, 2 rounded
uniform float uRadiusPx;
uniform vec2 uRectPx;        // mask rect size in (backing) px
out vec4 frag;
void main(){
  vec2 p = vUv * uRectPx;
  vec2 c = uRectPx * 0.5;
  float a = 1.0;
  if(uShape == 1){
    vec2 d = (p - c) / max(c, vec2(0.5));
    float r = length(d);
    float aa = max(fwidth(r), 1e-4);
    a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  } else if(uShape == 2){
    vec2 d = abs(p - c) - (c - vec2(uRadiusPx));
    float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uRadiusPx;
    float aa = max(fwidth(sd), 1e-4);
    a = 1.0 - smoothstep(-aa, aa, sd);
  }
  vec4 full = texture(uFull, gl_FragCoord.xy / uRes);
  frag = vec4(full.rgb, full.a * a);
}`;

// Masked video ("Вырезка"): draw a sub-rect of a video texture (srcCrop, or cover-fit) into the
// destination rect, clipped to a shape (rect / ellipse / rounded-rect, ~1px AA), optional CC.
// Mirrors renderFrameRef ≈5115. Unlike a `mask` layer this stamps ITS OWN video, not the composite.
const FS_MASKEDVIDEO = `#version 300 es
precision highp float;
in vec2 vUv;                 // 0..1 across the destination rect
uniform sampler2D uVideo;
uniform vec4 uSrcUV;         // (u0, v0, uSize, vSize) — sub-rect of the video texture
uniform int uShape;          // 0 rect, 1 ellipse, 2 rounded
uniform float uRadiusPx;
uniform vec2 uRectPx;        // dest rect size in backing px (shape AA)
uniform float uB, uC, uS, uH;
out vec4 frag;
${CC_GLSL}
void main(){
  vec2 uv = uSrcUV.xy + vUv * uSrcUV.zw;
  vec3 c = applyCC(texture(uVideo, uv).rgb, uB, uC, uS, uH);
  vec2 p = vUv * uRectPx;
  vec2 cen = uRectPx * 0.5;
  float a = 1.0;
  if(uShape == 1){
    vec2 d = (p - cen) / max(cen, vec2(0.5));
    float rr = length(d);
    float aa = max(fwidth(rr), 1e-4);
    a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rr);
  } else if(uShape == 2){
    vec2 d = abs(p - cen) - (cen - vec2(uRadiusPx));
    float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uRadiusPx;
    float aa = max(fwidth(sd), 1e-4);
    a = 1.0 - smoothstep(-aa, aa, sd);
  }
  frag = vec4(clamp(c, 0.0, 1.0), a);
}`;

// Fullscreen-quad VS for the ported effect shaders (effects/*.js). Uses our location-0
// unit quad (aPos in [0,1]²) and emits `v_uv` (0..1) — the varying name the pack FS expect.
const VS_FX = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 v_uv;
void main(){ v_uv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;

// Positioned-quad VS for the text-style shader (FS_TEXT). VS_QUAD but emits `v_uv` (the varying
// name FS_TEXT expects) + uFlip (canvas raster row0=top → upright in the GL scene, like _drawLayer).
const VS_TEXTQUAD = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec4 uRect;
uniform int uFlip;
uniform float uRot;
uniform float uAspect;
out vec2 v_uv;
void main(){
  v_uv = vec2(aPos.x, uFlip==1 ? 1.0 - aPos.y : aPos.y);
  vec2 ndc = mix(uRect.xy, uRect.zw, aPos);
  if(uRot != 0.0){
    vec2 c = (uRect.xy + uRect.zw) * 0.5;
    vec2 d = ndc - c;
    vec2 q = vec2(d.x * uAspect, d.y);
    float cs = cos(uRot), sn = sin(uRot);
    d = vec2((q.x*cs - q.y*sn) / uAspect, q.x*sn + q.y*cs);
    ndc = c + d;
  }
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(s || '000000', 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function srcReady(src) {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return src.readyState >= 2;
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) return src.complete && src.naturalWidth > 0;
  return !!src; // VideoFrame / canvas / ImageBitmap
}

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = getGL(canvas);
    const gl = this.gl;
    this.progLayer = makeProgram(gl, VS_QUAD, FS_LAYER);
    this.progChroma = makeProgram(gl, VS_QUAD, FS_CHROMA);  // green-screen / chroma key
    this.progBlit = makeProgram(gl, VS_QUAD, FS_BLIT);
    this.progGauss = makeProgram(gl, VS_QUAD, FS_GAUSS);
    this.progCopyRect = makeProgram(gl, VS_QUAD, FS_COPYRECT);
    this.progShadow = makeProgram(gl, VS_QUAD, FS_SHADOW);   // drop shadow / outer glow tint
    this.progMask = makeProgram(gl, VS_QUAD, FS_MASKSTAMP);
    this.progMaskedVideo = makeProgram(gl, VS_QUAD, FS_MASKEDVIDEO);
    this.progScreen = makeProgram(gl, VS_QUAD, FS_MUL);
    this.progPixelize = makeProgram(gl, VS_QUAD, FS_PIXELIZE);
    this.progFX = makeProgram(gl, VS_FX, FS_TRANSITIONS);   // ported 24 GPU transitions (effects/transitions.js)
    this.progText = makeProgram(gl, VS_TEXTQUAD, FS_TEXT);  // 9 emissive text styles (effects/textStyles.js)
    this.quad = createUnitQuad(gl);
    this.scene = createFBO(gl, 16, 16);   // accumulator
    this.scratchA = createFBO(gl, 16, 16); // ping-pong for effects that read the accumulator
    this.scratchB = createFBO(gl, 16, 16);
    this.scratchC = createFBO(gl, 16, 16); // 3rd buffer: scale→blur ping-pong while scratchA holds a snapshot
    this.texCache = new Map(); // layerId -> { tex }
    this.whiteTex = createTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  _texFor(id) {
    let r = this.texCache.get(id);
    if (!r) { r = { tex: createTexture(this.gl) }; this.texCache.set(id, r); }
    return r;
  }

  // Drop a layer's cached GPU texture (call when a layer is removed).
  forget(id) {
    const r = this.texCache.get(id);
    if (r) { try { this.gl.deleteTexture(r.tex); } catch {} this.texCache.delete(id); }
  }

  // frame = {
  //   W, H, bgColor, layers, time, videoStart, videoEnd, dur,
  //   getPx(layer) -> {x,y,w,h}  (= getLayerPx),
  //   getSource(layer) -> HTMLVideoElement | HTMLImageElement | VideoFrame | null,
  //   backingScale? (0..1; low-res-while-moving — defaults 1)
  // }
  renderFrame(frame) {
    const gl = this.gl;
    const W = frame.W, H = frame.H;
    const S = Math.max(0.1, Math.min(1, frame.backingScale || 1));
    const bw = Math.max(2, Math.round(W * S)), bh = Math.max(2, Math.round(H * S));
    if (this.canvas.width !== bw || this.canvas.height !== bh) { this.canvas.width = bw; this.canvas.height = bh; }
    this.scene.resize(bw, bh);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    const bg = hexToRgb(frame.bgColor);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const t = frame.time;
    // Occlusion culling: if some layer is a guaranteed opaque full-frame cover (a solid rect
    // that will actually paint this frame), every layer BELOW it is hidden and need not be
    // drawn (or even touched). Find the TOPMOST such cover; skip everything under it. Pure
    // optimisation — when in doubt _coverIdx returns -1 and nothing is skipped (draw it all).
    const coverIdx = this._coverIdx(frame, W, H, t);
    let maskInitDone = false;
    for (let li = 0; li < frame.layers.length; li++) {
      const layer = frame.layers[li];
      if (li < coverIdx) continue;   // fully occluded by the cover at coverIdx (which is drawn on top)
      if (layer.hidden) continue;
      // time-gate (mirrors renderFrameRef)
      if (layer.type === 'mainVideo') {
        if (!(t >= frame.videoStart && t <= frame.videoEnd)) continue;
      } else {
        const ls = layer.startTime || 0, le = layer.endTime !== undefined ? layer.endTime : frame.dur;
        if (t < ls || t > le) continue;
      }

      if (layer.type === 'mainVideo' || layer.type === 'image' || layer.type === 'videoOverlay') {
        const src = frame.getSource(layer);
        const rec = this._texFor(layer.id);
        // Keep the LAST uploaded frame when the live source isn't ready: rapid scrubbing /
        // seeks briefly drop a <video>'s readyState below 2, and returning null here would
        // flash the layer to BLACK until the seek settles. Only skip on the very first load.
        if (srcReady(src)) { uploadElement(gl, rec.tex, src); rec.hasFrame = true; }
        else if (!rec.hasFrame) continue;
        const b = frame.getPx(layer);
        if (!b || b.w <= 0 || b.h <= 0) continue;
        const rect = pxRectToNDC(b.x, b.y, b.w, b.h, W, H);
        const opacity = layer.type === 'image' ? (layer.opacity ?? 100) / 100 : 1;
        const cc = frame.getCC ? frame.getCC(layer) : null;
        const rot = -(layer.angle || 0) * Math.PI / 180, aspect = W / H;   // +angle = clockwise (matches CSS box + canvas2d)
        const hasChroma = !!(layer.chromaKey && layer.chromaKey.color);
        // Layer effects (shadow / glow) — only for image|videoOverlay overlays, NOT the mainVideo
        // full-frame background (a shadow there is invisible). Silhouette = the layer's own alpha
        // shape (chroma cut-out if keyed, else the opaque rect), so the shadow follows the visible
        // form. Drawn BEFORE the layer → layer sits on top of its shadow.
        if (layer.type !== 'mainVideo') {
          const sh = this._shadowParams(layer.shadow), gl2 = this._shadowParams(layer.glow), ol = this._outlineParams(layer.outline);
          if (sh || gl2 || ol) {
            const sil = () => {
              if (hasChroma) this._drawChromaLayer(rec.tex, rect, opacity, null, layer.chromaKey, rot, aspect);
              else this._drawLayer(rec.tex, rect, opacity, null, rot, aspect);
            };
            if (gl2) this._drawLayerShadow(frame, gl2, sil, bw, bh, true);   // outer glow (centred, additive)
            if (sh) this._drawLayerShadow(frame, sh, sil, bw, bh, false);    // drop shadow
            if (ol) this._drawLayerShadow(frame, ol, sil, bw, bh, false, OUTLINE_THRESH, this._gradFor(layer.outline, b, W, H));   // outline — drawn last (nearest the layer)
          }
        }
        // Chroma key («Удалить фон»): key out the colour → reveals the scene below it.
        if (hasChroma) this._drawChromaLayer(rec.tex, rect, opacity, cc, layer.chromaKey, rot, aspect);
        else this._drawLayer(rec.tex, rect, opacity, cc, rot, aspect);
      } else if (layer.type === 'blur') {
        this._blur(frame, layer, bw, bh);
      } else if (layer.type === 'mask') {
        if (!maskInitDone) { this._captureFullAndResetBase(frame, bw, bh); maskInitDone = true; }
        this._stampMask(frame, layer, bw, bh);
      } else if (layer.type === 'maskedVideo') {
        // Shadow / glow follow the cut-out SILHOUETTE (the masked-video shape rendered into scratchB).
        const sh = this._shadowParams(layer.shadow), gl2 = this._shadowParams(layer.glow), ol = this._outlineParams(layer.outline);
        if (sh || gl2 || ol) {
          const sil = (fbo) => this._drawMaskedVideo(frame, layer, bw, bh, fbo);
          if (gl2) this._drawLayerShadow(frame, gl2, sil, bw, bh, true);
          if (sh) this._drawLayerShadow(frame, sh, sil, bw, bh, false);
          if (ol) this._drawLayerShadow(frame, ol, sil, bw, bh, false, OUTLINE_THRESH, this._gradFor(layer.outline, frame.getPx(layer), W, H));
        }
        this._drawMaskedVideo(frame, layer, bw, bh);
      } else if (layer.type === 'text' || layer.type === 'subtitles') {
        // text/subtitles are rasterized (textRaster) by the caller into 1+ draws; we just
        // composite each as a textured quad. Same raster feeds preview AND export → no libass.
        const draws = frame.getTextDraw ? frame.getTextDraw(layer, t) : null;
        // Rotate a single TEXT layer around its centre. Subtitles are multi-word draws,
        // each with its own rect — rotating each around its own centre would spin words
        // in place, so subtitle rotation is left out of v1 (rot stays 0).
        const trot = layer.type === 'text' ? -(layer.angle || 0) * Math.PI / 180 : 0;
        const tasp = frame.W / frame.H;
        // per-draw output rect (offset+scale) — shared by the real draw and the shadow silhouette.
        const drawRect = (d) => {
          let dx = d.x, dy = d.y, dw = d.w, dh = d.h;
          const sx = d.scaleX != null ? d.scaleX : 1, sy = d.scaleY != null ? d.scaleY : 1;
          if (sx !== 1 || sy !== 1) { const ccx = d.x + d.w / 2, ccy = d.y + d.h / 2; dw = d.w * sx; dh = d.h * sy; dx = ccx - dw / 2; dy = ccy - dh / 2; }
          return pxRectToNDC(dx, dy, dw, dh, frame.W, frame.H);
        };
        // Layer shadow / glow for text|subtitles — ONE pass over the whole layer's glyph silhouette
        // (every word/line draw as a plain alpha quad), so the shadow sits under all the glyphs.
        if (draws && draws.length) {
          const sh = this._shadowParams(layer.shadow), gl2 = this._shadowParams(layer.glow);
          if (sh || gl2) {
            const sil = () => {
              for (let di = 0; di < draws.length; di++) {
                const d = draws[di]; if (!d || !d.source) continue;
                const rec = this._texFor(layer.id + '#' + di);
                uploadElement(gl, rec.tex, d.source);
                this._drawLayer(rec.tex, drawRect(d), d.opacity != null ? d.opacity : 1, null, trot, tasp);
              }
            };
            if (gl2) this._drawLayerShadow(frame, gl2, sil, bw, bh, true);
            if (sh) this._drawLayerShadow(frame, sh, sil, bw, bh, false);
          }
        }
        if (draws) {
          for (let di = 0; di < draws.length; di++) {
            const d = draws[di];
            if (!d || !d.source) continue;
            const rec = this._texFor(layer.id + '#' + di);
            uploadElement(gl, rec.tex, d.source);
            const r2 = drawRect(d);
            if (d.style != null && (d.style > 0 || (d.anim != null && d.anim > 0))) {
              // FS_TEXT pass: GPU style (neon/fire/…) OR a PIXEL anim (fill/wave/type/blur, via u_anim)
              // even at plain style 0. d.source is a glyph-ALPHA raster, recoloured/animated in-shader.
              this._drawTextStyled(rec.tex, d, r2, (d.source && d.source.width) || d.w, (d.source && d.source.height) || d.h, t, trot, tasp);
            } else {
              this._drawLayer(rec.tex, r2, d.opacity != null ? d.opacity : 1, null, trot, tasp);
            }
          }
        }
      } else if (layer.type === 'zoom') {
        this._zoomLayer(frame, layer, bw, bh);
      } else if (layer.type === 'transition') {
        const fxType = TRANSITION_TYPE[layer.kind];
        if (fxType != null) this._transitionGPU(frame, layer, bw, bh, fxType);  // ported GPU transition
        else this._transition(frame, layer, bw, bh);                            // legacy kinds (now no-op)
      }
    }

    // blit scene FBO → screen
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.progBlit);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.progBlit.u.uTex, 0);
    gl.uniform4f(this.progBlit.u.uRect, -1, -1, 1, 1);
    gl.uniform1i(this.progBlit.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Occlusion culling — index of the TOPMOST layer that is an opaque full-frame cover (a solid
  // rectangle that will actually paint this frame). Layers below it are invisible. Returns -1 when
  // there is no such cover, so the caller draws everything (unchanged behaviour). SAFE-by-default:
  // any uncertainty (not ready, rotated, chroma-keyed, not covering the frame, transparent) → the
  // layer is NOT treated as a cover, so we never hide something that should be visible.
  _coverIdx(frame, W, H, t) {
    const layers = frame.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (this._isFullCover(frame, layers[i], W, H, t)) return i;
    }
    return -1;
  }

  // True ONLY if `layer` is a guaranteed opaque, full-frame, axis-aligned cover that WILL draw this
  // frame — i.e. it paints a solid rectangle over the whole canvas with no holes:
  //  • type ∈ {mainVideo, image, videoOverlay} (solid rects; mask/maskedVideo/blur/text/subtitles/
  //    transition/zoom never qualify — they reveal or transform what's below);
  //  • not hidden, and inside its time window (else it doesn't draw at all → can't occlude);
  //  • opaque: image needs opacity===100; video is always opaque;
  //  • no chroma key (chromaKey.color punches transparent holes → reveals the layer below);
  //  • not rotated (!layer.angle — a rotated rect leaves the frame corners uncovered);
  //  • its rect (frame.getPx) covers the ENTIRE frame: x<=0 && y<=0 && x+w>=W && y+h>=H, w>0,h>0;
  //  • has a real frame to draw (source ready OR a cached texture from a previous frame) — otherwise
  //    the layer itself draws nothing this frame and would expose the layers below it.
  _isFullCover(frame, layer, W, H, t) {
    if (!layer || layer.hidden) return false;
    const ty = layer.type;
    if (ty !== 'mainVideo' && ty !== 'image' && ty !== 'videoOverlay') return false;
    // same time-gate the draw loop uses — a gated-out layer never paints
    if (ty === 'mainVideo') {
      if (!(t >= frame.videoStart && t <= frame.videoEnd)) return false;
    } else {
      const ls = layer.startTime || 0, le = layer.endTime !== undefined ? layer.endTime : frame.dur;
      if (t < ls || t > le) return false;
    }
    // opacity: image can be semi-transparent; video is always opaque
    if (ty === 'image' && (layer.opacity ?? 100) !== 100) return false;
    // chroma key cuts holes; rotation leaves corners empty → not a solid full cover
    if (layer.chromaKey && layer.chromaKey.color) return false;
    if (layer.angle) return false;
    // must cover the whole frame
    const b = frame.getPx(layer);
    if (!b || !(b.w > 0) || !(b.h > 0)) return false;
    if (!(b.x <= 0 && b.y <= 0 && b.x + b.w >= W && b.y + b.h >= H)) return false;
    // must have something to draw (live source ready, or a texture kept from a prior frame —
    // matches the renderFrame "keep last frame during scrub" behaviour)
    const src = frame.getSource ? frame.getSource(layer) : null;
    if (srcReady(src)) return true;
    const rec = this.texCache.get(layer.id);
    return !!(rec && rec.hasFrame);
  }

  _drawLayer(tex, rect, opacity, cc, rot, aspect) {
    const gl = this.gl, p = this.progLayer;
    gl.useProgram(p);
    gl.bindVertexArray(this.quad);
    gl.enable(gl.BLEND);
    // straight-alpha source over premultiplied-ish dest; matches canvas2d drawImage+globalAlpha closely
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uOpacity, opacity);
    // colour-correct: neutral by default (Step A mirrors canvas2d preview, which doesn't cc video)
    gl.uniform1f(p.u.uB, cc ? cc.b : 1);
    gl.uniform1f(p.u.uC, cc ? cc.c : 1);
    gl.uniform1f(p.u.uS, cc ? cc.s : 1);
    gl.uniform1f(p.u.uH, cc ? cc.h : 0);
    gl.uniform4f(p.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(p.u.uFlip, 1);
    gl.uniform1f(p.u.uRot, rot || 0);            // ALWAYS set (progLayer is shared with _drawSnapshot/_flash)
    gl.uniform1f(p.u.uAspect, aspect || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Chroma-key draw: like _drawLayer but keys out ck.color (Cb/Cr distance). The transparent
  // pixels src-over-blend into the scene already drawn below → the layer beneath shows through,
  // exactly like a mask cut-out. ck = {color:'#rrggbb', threshold 0..100, smoothness 0..100}.
  _drawChromaLayer(tex, rect, opacity, cc, ck, rot, aspect) {
    const gl = this.gl, p = this.progChroma;
    gl.useProgram(p);
    gl.bindVertexArray(this.quad);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uOpacity, opacity);
    gl.uniform1f(p.u.uB, cc ? cc.b : 1);
    gl.uniform1f(p.u.uC, cc ? cc.c : 1);
    gl.uniform1f(p.u.uS, cc ? cc.s : 1);
    gl.uniform1f(p.u.uH, cc ? cc.h : 0);
    const rgb = hexToRgb(ck.color);
    gl.uniform3f(p.u.uKey, rgb[0], rgb[1], rgb[2]);
    // slider 0..100 → chroma-distance units (cbcr space ~0..1.4). Defaults match main.jsx.
    gl.uniform1f(p.u.uThresh, Math.max(0, (ck.threshold != null ? ck.threshold : 45) / 100 * 0.8));
    gl.uniform1f(p.u.uSmooth, Math.max(0, (ck.smoothness != null ? ck.smoothness : 30) / 100 * 0.5));
    gl.uniform4f(p.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(p.u.uFlip, 1);
    gl.uniform1f(p.u.uRot, rot || 0);
    gl.uniform1f(p.u.uAspect, aspect || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Emissive GPU text style (effects/textStyles.js FS_TEXT) — draws the glyph-ALPHA raster
  // (white-on-transparent; d.source from rasterizeWord(...,alphaOnly=true)) at `rect`, ADDITIVELY
  // over the scene, recolouring/glowing per d.style/base/acc/intensity/anim. Used for the 9 pack
  // styles (neon/fire/chrome/…); plain text keeps the opaque _drawLayer path.
  _drawTextStyled(tex, d, rect, texW, texH, time, rot, aspect) {
    const gl = this.gl, p = this.progText;
    gl.useProgram(p); gl.bindVertexArray(this.quad);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);   // additive emissive over video
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.u_text, 0);
    gl.uniform1f(p.u.u_time, (d.animTime != null ? d.animTime : time) || 0);
    gl.uniform1f(p.u.u_intensity, d.intensity != null ? d.intensity : 1);
    gl.uniform1i(p.u.u_style, d.style | 0);
    gl.uniform1i(p.u.u_anim, d.anim | 0);
    const base = d.base || [1, 1, 1], acc = d.acc || [1, 0.6, 0.1];
    gl.uniform3f(p.u.u_base, base[0], base[1], base[2]);
    gl.uniform3f(p.u.u_acc, acc[0], acc[1], acc[2]);
    gl.uniform2f(p.u.u_texel, 1 / Math.max(1, texW), 1 / Math.max(1, texH));
    gl.uniform4f(p.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(p.u.uFlip, 1);
    gl.uniform1f(p.u.uRot, rot || 0);
    gl.uniform1f(p.u.uAspect, aspect || 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Separable gaussian (two FS_GAUSS passes) — the shared inner loop of every blur in this file
  // (`_blur`, `_drawLayerShadow`, `_compositeSnapshot`). H pass: srcTex → midFbo (uStep = 1/bw, 0);
  // V pass: midTex → dstFbo (uStep = 0, 1/bh). `radius` is derived from `sigma` identically to all
  // three former call sites (min(180, ceil(sigma*3))). The caller owns: resizing the scratch FBOs,
  // deciding whether to blur at all (the blur-strength threshold), and what to do before/after.
  // Leaves progGauss bound, dstFbo bound, and midTex bound to TEXTURE0 (matches the old inline code).
  _gaussBlur(srcTex, midFbo, midTex, dstFbo, sigma, bw, bh) {
    const gl = this.gl;
    const radius = Math.min(180, Math.ceil(sigma * 3));
    gl.disable(gl.BLEND);
    gl.useProgram(this.progGauss); gl.bindVertexArray(this.quad);
    gl.uniform1f(this.progGauss.u.uSigma, sigma);
    gl.uniform1i(this.progGauss.u.uRadius, radius);
    gl.uniform4f(this.progGauss.u.uRect, -1, -1, 1, 1);
    gl.uniform1i(this.progGauss.u.uFlip, 0);
    // H pass: srcTex → midFbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, midFbo); gl.viewport(0, 0, bw, bh);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.progGauss.u.uTex, 0);
    gl.uniform2f(this.progGauss.u.uStep, 1 / bw, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // V pass: midTex → dstFbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.bindTexture(gl.TEXTURE_2D, midTex);
    gl.uniform2f(this.progGauss.u.uStep, 0, 1 / bh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Blur layer: gaussian-blur everything below it (the accumulated scene), clipped to the
  // blur rect. Mirrors renderFrameRef ≈4817 (capture region + filter:blur + clip). Separable
  // gaussian over the whole frame (CLAMP_TO_EDGE = same edge behaviour), then the blur rect is
  // copied back into the scene by screen position.
  _blur(frame, layer, bw, bh) {
    const gl = this.gl;
    const S = bw / frame.W;
    const strength = Math.max(1, layer.strength || 10);
    const sigma = Math.max(0.5, strength * S);   // radius derived inside _gaussBlur
    this.scratchA.resize(bw, bh); this.scratchB.resize(bw, bh);
    // separable gaussian: scene → scratchA (H) → scratchB (V)
    this._gaussBlur(this.scene.tex, this.scratchA.fbo, this.scratchA.tex, this.scratchB.fbo, sigma, bw, bh);
    // composite blurred rect back into scene (replace inside rect)
    const b = frame.getPx(layer);
    if (!b || b.w <= 0 || b.h <= 0) return;
    const rect = pxRectToNDC(b.x, b.y, b.w, b.h, frame.W, frame.H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.progCopyRect);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchB.tex);
    gl.uniform1i(this.progCopyRect.u.uTex, 0);
    gl.uniform2f(this.progCopyRect.u.uRes, bw, bh);
    gl.uniform4f(this.progCopyRect.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(this.progCopyRect.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // mask union — at the FIRST mask: snapshot the full composite (scene → scratchA), then reset
  // the scene to the pristine base (bg + mainVideo only). Mirrors renderFrameRef ≈4852.
  _captureFullAndResetBase(frame, bw, bh) {
    const gl = this.gl;
    this.scratchA.resize(bw, bh);
    gl.disable(gl.BLEND);
    // copy scene → scratchA (full composite)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchA.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.useProgram(this.progBlit); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.progBlit.u.uTex, 0);
    gl.uniform4f(this.progBlit.u.uRect, -1, -1, 1, 1);
    gl.uniform1i(this.progBlit.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // reset scene → base (bg + mainVideo only)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    const bg = hexToRgb(frame.bgColor);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const mv = frame.layers.find(l => l.type === 'mainVideo');
    if (mv && !mv.hidden && frame.time >= frame.videoStart && frame.time <= frame.videoEnd) {
      const src = frame.getSource(mv);
      const rec = this._texFor(mv.id);
      if (srcReady(src)) { uploadElement(gl, rec.tex, src); rec.hasFrame = true; }   // else keep last (scrub)
      if (rec.hasFrame) {
        const b = frame.getPx(mv);
        if (b && b.w > 0 && b.h > 0) this._drawLayer(rec.tex, pxRectToNDC(b.x, b.y, b.w, b.h, frame.W, frame.H), 1);
      }
    }
  }

  // Stamp the captured full composite (scratchA) inside THIS mask's shape into the scene.
  _stampMask(frame, layer, bw, bh) {
    const gl = this.gl;
    const b = frame.getPx(layer);
    if (!b || b.w <= 0 || b.h <= 0) return;
    const S = bw / frame.W;
    const rr = Math.max(0, Math.min(Math.min(b.w, b.h) / 2, (layer.radius || 0) / 100 * Math.min(b.w, b.h) / 2));
    const shape = layer.shape === 'circle' ? 1 : (layer.shape === 'rounded' ? 2 : 0);
    const rect = pxRectToNDC(b.x, b.y, b.w, b.h, frame.W, frame.H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.progMask); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchA.tex);
    gl.uniform1i(this.progMask.u.uFull, 0);
    gl.uniform2f(this.progMask.u.uRes, bw, bh);
    gl.uniform1i(this.progMask.u.uShape, shape);
    gl.uniform1f(this.progMask.u.uRadiusPx, rr * S);
    gl.uniform2f(this.progMask.u.uRectPx, b.w * S, b.h * (bh / frame.H));
    gl.uniform4f(this.progMask.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(this.progMask.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // maskedVideo ("Вырезка"): stamp THIS layer's own video into its dest rect, clipped to the shape.
  // srcCrop → sub-rect of the source pixels (the slice that was under the mask at Apply time); else
  // cover-fit the whole video into the rect. Mirrors renderFrameRef ≈5115 (clip shape + drawImage).
  // targetFbo defaults to the scene accumulator; the shadow pass passes a scratch FBO to capture the
  // cut-out SILHOUETTE (its alpha shape) without touching the scene.
  _drawMaskedVideo(frame, layer, bw, bh, targetFbo) {
    const gl = this.gl;
    const src = frame.getSource(layer);
    const b = frame.getPx(layer);
    if (!b || b.w <= 0 || b.h <= 0) return;
    const rec = this._texFor(layer.id);
    // Keep the last frame during scrubbing/seeks (see renderFrame note) instead of vanishing.
    // dims source: DOM video (videoWidth) / image (naturalWidth) / canvas (width) / VideoFrame
    // (displayWidth|codedWidth — a VideoFrame has NO .videoWidth). Cached on the record so a
    // not-ready frame can still map its UVs from the last known size.
    if (srcReady(src)) {
      rec.srcW = src.videoWidth || src.naturalWidth || src.displayWidth || src.codedWidth || src.width || 1;
      rec.srcH = src.videoHeight || src.naturalHeight || src.displayHeight || src.codedHeight || src.height || 1;
      uploadElement(gl, rec.tex, src);
      rec.hasFrame = true;
    } else if (!rec.hasFrame) return;
    const srcW = rec.srcW || 1, srcH = rec.srcH || 1;
    // UV sub-rect: srcCrop (clamped exactly like canvas2d) or cover-fit centred.
    let u0, v0, uSize, vSize;
    if (layer.srcCrop) {
      const c = layer.srcCrop;
      const sx = Math.max(0, Math.min(srcW - 1, c.x));
      const sy = Math.max(0, Math.min(srcH - 1, c.y));
      const sw = Math.max(1, Math.min(srcW - sx, c.w));
      const sh = Math.max(1, Math.min(srcH - sy, c.h));
      u0 = sx / srcW; v0 = sy / srcH; uSize = sw / srcW; vSize = sh / srcH;
    } else {
      const vAsp = srcW / srcH, bAsp = b.w / b.h;
      let dw, dh, dx, dy;
      if (vAsp > bAsp) { dh = b.h; dw = dh * vAsp; dx = b.x + (b.w - dw) / 2; dy = b.y; }
      else { dw = b.w; dh = dw / vAsp; dx = b.x; dy = b.y + (b.h - dh) / 2; }
      u0 = (b.x - dx) / dw; uSize = b.w / dw; v0 = (b.y - dy) / dh; vSize = b.h / dh;
    }
    const S = bw / frame.W;
    const rr = Math.max(0, Math.min(Math.min(b.w, b.h) / 2, (layer.radius || 0) / 100 * Math.min(b.w, b.h) / 2));
    const shape = layer.shape === 'circle' ? 1 : (layer.shape === 'rounded' ? 2 : 0);
    const rect = pxRectToNDC(b.x, b.y, b.w, b.h, frame.W, frame.H);
    const cc = frame.getCC ? frame.getCC(layer) : null;
    const p = this.progMaskedVideo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo || this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(p); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    gl.uniform1i(p.u.uVideo, 0);
    gl.uniform4f(p.u.uSrcUV, u0, v0, uSize, vSize);
    gl.uniform1i(p.u.uShape, shape);
    gl.uniform1f(p.u.uRadiusPx, rr * S);
    gl.uniform2f(p.u.uRectPx, b.w * S, b.h * (bh / frame.H));
    gl.uniform1f(p.u.uB, cc ? cc.b : 1);
    gl.uniform1f(p.u.uC, cc ? cc.c : 1);
    gl.uniform1f(p.u.uS, cc ? cc.s : 1);
    gl.uniform1f(p.u.uH, cc ? cc.h : 0);
    gl.uniform4f(p.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(p.u.uFlip, 1);
    gl.uniform1f(p.u.uRot, -(layer.angle || 0) * Math.PI / 180);
    gl.uniform1f(p.u.uAspect, frame.W / frame.H);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Normalize a layer's shadow/glow descriptor → {color, blur, dx, dy, opacity} or null if it would
  // be invisible (no spec, or blur<=0 AND dx==0 AND dy==0 AND opacity<=0 → nothing to draw). Shared
  // by drop shadow (layer.shadow) and outer glow (layer.glow). Returns null = zero overhead, the
  // caller skips the whole shadow pass.
  _shadowParams(fx) {
    if (!fx) return null;
    const blur = +fx.blur || 0;
    const dx = +fx.dx || 0, dy = +fx.dy || 0;
    const opacity = fx.opacity != null ? +fx.opacity : 1;
    if (opacity <= 0) return null;
    if (blur <= 0 && dx === 0 && dy === 0) return null;   // invisible: no spread, no offset
    return { color: fx.color || '#000000', blur, dx, dy, opacity };
  }

  // Outline («Обводка») params → shaped like a CENTRED shadow so _drawLayerShadow draws it with
  // hard=OUTLINE_THRESH (crisp dilated silhouette = stroke). `width` = stroke thickness in frame px
  // (becomes the shadow sigma = width·S). Returns null = no stroke.
  _outlineParams(fx) {
    if (!fx) return null;
    const width = +fx.width || 0;
    const opacity = fx.opacity != null ? +fx.opacity : 1;
    if (width <= 0 || opacity <= 0) return null;
    return { color: fx.color || '#000000', blur: width, dx: 0, dy: 0, opacity };
  }

  // Gradient spec for a gradient outline → null when the outline is solid (or invalid). `b` is the
  // layer's px rect (the gradient spans it); rect is converted to FBO uv (y-up). Colours stay hex —
  // _drawLayerShadow converts them and derives the axis from `angle`.
  _gradFor(fx, b, W, H) {
    if (!fx || !fx.grad || !Array.isArray(fx.colors) || fx.colors.length < 2 || !b || b.w <= 0 || b.h <= 0) return null;
    return { colors: fx.colors.slice(0, 4), angle: +fx.angle || 0, rect: [b.x / W, 1 - (b.y + b.h) / H, b.w / W, b.h / H] };
  }

  // Drop shadow / outer glow for a single layer — runs BEFORE the layer's own draw so the layer sits
  // ON TOP of its shadow (Photoshop semantics). Parametrized so PHASE 3 (outer glow) reuses it: glow
  // = same call with dx=dy=0 (centred) + additive=true. Mechanism (reuses the FBO + separable-gauss
  // infra, scratchB/scratchC are transient so the scene FBO and the mask snapshot in scratchA survive):
  //   1. SILHOUETTE: drawSilhouette(scratchB.fbo) renders the layer's ALPHA shape (glyphs / rect /
  //      cut-out) into a transparent scratchB. Its RGB is irrelevant — the tint pass discards it.
  //   2. BLUR: separable gaussian by `blur` px (scratchB → scratchC → scratchB). Skipped when blur≈0
  //      (a crisp offset shadow).
  //   3. TINT + OFFSET + COMPOSITE: progShadow paints the blurred alpha as a solid `color`, shifted by
  //      (dx,dy) px, alpha = blurredAlpha × opacity, over the scene (src-over for shadow / additive for
  //      glow). Sampled by screen pos so the offset is exact.
  // Leaves the scene FBO bound (+ full viewport) so the caller can immediately draw the real layer.
  _drawLayerShadow(frame, fx, drawSilhouette, bw, bh, additive, hard, grad) {
    const gl = this.gl;
    const S = bw / frame.W;
    this.scratchB.resize(bw, bh);
    this.scratchC.resize(bw, bh);

    // 1. silhouette → scratchB (cleared transparent first)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchB.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawSilhouette(this.scratchB.fbo);   // draws the layer's alpha shape into the bound scratchB

    // 2. separable gaussian over scratchB by `blur` px (skip when negligible → crisp offset shadow)
    const sigma = Math.max(0.5, (fx.blur || 0) * S);
    if (hard || (fx.blur || 0) * S > 0.5) {   // outline ALWAYS spreads (it's a dilation); shadow only when meaningful
      // scratchB → scratchC (H) → scratchB (V)
      this._gaussBlur(this.scratchB.tex, this.scratchC.fbo, this.scratchC.tex, this.scratchB.fbo, sigma, bw, bh);
    }

    // 3. tint + offset + composite scratchB → scene
    const rgb = hexToRgb(fx.color);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.enable(gl.BLEND);
    // progShadow outputs STRAIGHT alpha (rgb=uColor, a=coverage×opacity). src-over (shadow) matches
    // _drawLayer's blend exactly; additive (glow) uses SRC_ALPHA,ONE so light is added in proportion
    // to coverage (= premultiply-on-blend), like _drawTextStyled's emissive pass — no solid colour wash.
    if (additive) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.progShadow;
    gl.useProgram(p); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchB.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform2f(p.u.uRes, bw, bh);
    // full-screen quad (FS_SHADOW samples by gl_FragCoord, so VS_QUAD just needs to cover the frame).
    gl.uniform4f(p.u.uRect, -1, -1, 1, 1);
    gl.uniform1i(p.u.uFlip, 0);
    gl.uniform1f(p.u.uRot, 0);
    // dy is screen y-down (top-left origin) but the FBO is y-up → flip dy for the screen-pos sampler.
    gl.uniform2f(p.u.uOffset, (fx.dx || 0) * S, -(fx.dy || 0) * S);
    gl.uniform3f(p.u.uColor, rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(p.u.uOpacity, fx.opacity != null ? fx.opacity : 1);
    gl.uniform1f(p.u.uHard, hard || 0);   // 0 = shadow/glow (soft); >0 = outline (crisp dilated edge)
    // Gradient outline: up to 4 stops along uGradDir across the layer rect. uGradN=0 → flat uColor,
    // so shadow / glow / solid-outline draws stay byte-identical.
    if (grad && grad.colors && grad.colors.length >= 2) {
      const gc = grad.colors.slice(0, 4).map(hexToRgb);
      gl.uniform1i(p.u.uGradN, gc.length);
      gl.uniform3f(p.u.uGradC0, gc[0][0], gc[0][1], gc[0][2]);
      gl.uniform3f(p.u.uGradC1, gc[1][0], gc[1][1], gc[1][2]);
      if (gc[2]) gl.uniform3f(p.u.uGradC2, gc[2][0], gc[2][1], gc[2][2]);
      if (gc[3]) gl.uniform3f(p.u.uGradC3, gc[3][0], gc[3][1], gc[3][2]);
      const rad = (grad.angle || 0) * Math.PI / 180;
      gl.uniform2f(p.u.uGradDir, Math.cos(rad), -Math.sin(rad));
      const r = grad.rect;
      gl.uniform4f(p.u.uGradRect, r[0], r[1], r[2], r[3]);
    } else {
      gl.uniform1i(p.u.uGradN, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // scene stays bound (full viewport) so the caller draws the real layer right on top.
  }

  // snapshot the scene FBO → scratchA (in FBO orientation, row0 = bottom).
  _snapshotScene(bw, bh) {
    const gl = this.gl;
    this.scratchA.resize(bw, bh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchA.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progBlit); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.progBlit.u.uTex, 0);
    gl.uniform4f(this.progBlit.u.uRect, -1, -1, 1, 1);
    gl.uniform1i(this.progBlit.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _clearScene(r, g, b, a) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.scene.w, this.scene.h);
    gl.disable(gl.BLEND);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Draw the scratchA snapshot (FBO orientation, uFlip=0) into the scene at `rect`.
  _drawSnapshot(rect, opacity, replace) {
    const gl = this.gl, p = this.progLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.scene.w, this.scene.h);
    if (replace) gl.disable(gl.BLEND);
    else { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    gl.useProgram(p); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchA.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uOpacity, opacity);
    gl.uniform1f(p.u.uB, 1); gl.uniform1f(p.u.uC, 1); gl.uniform1f(p.u.uS, 1); gl.uniform1f(p.u.uH, 0);
    gl.uniform4f(p.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    gl.uniform1i(p.u.uFlip, 0);
    gl.uniform1f(p.u.uRot, 0);   // progLayer is shared with _drawLayer (which may have left a rotation set)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // zoom layer: snapshot the whole composite, clear, redraw scaled & centred on a triangle ramp.
  // Mirrors renderFrameRef ≈5304.
  _zoomLayer(frame, layer, bw, bh) {
    const zls = layer.startTime || 0, zle = layer.endTime != null ? layer.endTime : frame.dur;
    const zspan = Math.max(0.1, zle - zls);
    const zp = (frame.time - zls) / zspan;
    const ztri = Math.max(0, zp < 0.5 ? zp * 2 : (1 - zp) * 2);
    const zf = 1 + (Math.max(0, layer.strength || 0) / 100) * ztri;
    if (zf <= 1.001) return;
    this._snapshotScene(bw, bh);
    this._clearScene(0, 0, 0, 0);
    const dw = frame.W * zf, dh = frame.H * zf, dx = (frame.W - dw) / 2, dy = (frame.H - dh) / 2;
    this._drawSnapshot(pxRectToNDC(dx, dy, dw, dh, frame.W, frame.H), 1, true);
  }

  // Full-frame white flash at `alpha` (transition punch). Mirrors the canvas2d fillRect(#fff)+globalAlpha.
  _flash(alpha) {
    if (alpha <= 0.001) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.scene.w, this.scene.h);
    this._drawLayer(this.whiteTex, [-1, -1, 1, 1], Math.min(1, alpha));
  }

  // Draw the scratchA snapshot scaled/offset to dest px-rect (dx,dy,dw,dh), optionally gaussian-blurred
  // by blurPx (in frame-W px, applied in DEST space — after the scale, matching CSS filter:blur on a
  // scaled drawImage), then composite into the scene. blend: 'over' = src-over; 'screen' = canvas2d
  // screen@0.4. Uses scratchB/scratchC so scratchA (the snapshot) survives multiple calls (seamzoom).
  _compositeSnapshot(frame, dx, dy, dw, dh, blurPx, blend, bw, bh) {
    const gl = this.gl;
    this.scratchB.resize(bw, bh); this.scratchC.resize(bw, bh);
    // 1. scale/offset scratchA → scratchB (cleared transparent, straight copy)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchB.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const r = pxRectToNDC(dx, dy, dw, dh, frame.W, frame.H);
    gl.useProgram(this.progBlit); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchA.tex);
    gl.uniform1i(this.progBlit.u.uTex, 0);
    gl.uniform4f(this.progBlit.u.uRect, r[0], r[1], r[2], r[3]);
    gl.uniform1i(this.progBlit.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // 2. optional dest-space gaussian (scratchB → scratchC → scratchB)
    if (blurPx > 0.5) {
      const sigma = Math.max(0.5, blurPx * (bw / frame.W));
      this._gaussBlur(this.scratchB.tex, this.scratchC.fbo, this.scratchC.tex, this.scratchB.fbo, sigma, bw, bh);
    }
    // 3. composite scratchB → scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo); gl.viewport(0, 0, bw, bh);
    gl.enable(gl.BLEND);
    if (blend === 'screen') {
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_COLOR, gl.ONE, gl.ZERO, gl.ONE);
      const p = this.progScreen;
      gl.useProgram(p); gl.bindVertexArray(this.quad);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchB.tex);
      gl.uniform1i(p.u.uTex, 0); gl.uniform1f(p.u.uMul, 0.4);
      gl.uniform4f(p.u.uRect, -1, -1, 1, 1); gl.uniform1i(p.u.uFlip, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      // premultiplied over: scratchB carries binary 0/1 alpha (scene is fully opaque), so after the
      // gaussian its edges are valid premultiplied pixels — blending with ONE (not SRC_ALPHA) makes the
      // blurred seam fade into the bg exactly like canvas2d's premultiplied filter:blur (no dark halo).
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.progBlit); gl.bindVertexArray(this.quad);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchB.tex);
      gl.uniform1i(this.progBlit.u.uTex, 0);
      gl.uniform4f(this.progBlit.u.uRect, -1, -1, 1, 1); gl.uniform1i(this.progBlit.u.uFlip, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // Draw the scratchA snapshot back into the scene quantized to blocksX×blocksY (true pixelation).
  // The snapshot fully covers the frame and is opaque, so we REPLACE (blend off) — no clear needed.
  // Source set to NEAREST for crisp blocks, restored to LINEAR after. Same uFlip=0 sampling as the
  // verified _snapshotScene/_drawSnapshot path → orientation unchanged.
  _pixelizeSnapshot(blocksX, blocksY, bw, bh) {
    const gl = this.gl, p = this.progPixelize;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(p); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchA.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform2f(p.u.uBlocks, Math.max(1, blocksX), Math.max(1, blocksY));
    gl.uniform4f(p.u.uRect, -1, -1, 1, 1);
    gl.uniform1i(p.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  // GPU transition pass — the ported pack effects (effects/transitions.js, 24 kinds via u_type).
  // SELF-EFFECT mode: u_from = u_to = the current composite (scratchA). Works for the energetic
  // DISTORTION transitions (zoom-blur / glitch / spin / flash / pixelate / ripple / swirl / …); pure
  // A→B crossfades (fade / luma-wipe / iris) are degenerate here (from==to) until a clip-pair feed
  // lands — TODO (needs the outgoing+incoming clip textures at the cut). Gated by the layer window
  // via u_progress 0..1; strength = layer.strength/50 (0..100 → ~0..2). Mirrors export by construction
  // (same shader on both paths once engineExport renders the same pass).
  _transitionGPU(frame, layer, bw, bh, fxType) {
    const gl = this.gl;
    const tls = layer.startTime || 0, tle = layer.endTime != null ? layer.endTime : frame.dur;
    const span = Math.max(0.01, tle - tls);
    const prog = Math.max(0, Math.min(1, (frame.time - tls) / span));
    const strength = layer.strength != null ? Math.max(0, layer.strength) / 50 : 1;
    this._snapshotScene(bw, bh);                 // composite → scratchA
    this.scratchB.resize(bw, bh);
    // render the transition (snapshot → scratchB)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchB.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    const p = this.progFX;
    gl.useProgram(p); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchA.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.scratchA.tex);
    gl.uniform1i(p.u.u_from, 0);
    gl.uniform1i(p.u.u_to, 1);
    gl.uniform1f(p.u.u_progress, prog);
    gl.uniform1f(p.u.u_strength, strength);
    gl.uniform1f(p.u.u_time, frame.time);
    gl.uniform1i(p.u.u_type, fxType);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // scratchB → scene (replace, no blend)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progBlit); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scratchB.tex);
    gl.uniform1i(this.progBlit.u.uTex, 0);
    gl.uniform4f(this.progBlit.u.uRect, -1, -1, 1, 1);
    gl.uniform1i(this.progBlit.u.uFlip, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0); // restore default active unit
  }

  // Preview-only: render transition `fxType` between two DISTINCT sources (A→B) straight to the
  // screen at `progress`. Unlike _transitionGPU (self-effect, one composite), this shows a real
  // A→B wipe/fade — used by the effect-preview hover card. Caller sets the canvas size first.
  renderTransitionPreview(fxType, srcA, srcB, progress, strength, time) {
    const gl = this.gl;
    const bw = this.canvas.width, bh = this.canvas.height;
    // FLIP_Y on upload — these source canvases are top-down but the FX program samples in FBO
    // (bottom-up) orientation; flipping here keeps A/B upright instead of upside-down.
    const upFlip = (tex, src) => { gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); };
    const recA = this._texFor('__prevA'); upFlip(recA.tex, srcA);
    const recB = this._texFor('__prevB'); upFlip(recB.tex, srcB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    const p = this.progFX;
    gl.useProgram(p); gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, recA.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, recB.tex);
    gl.uniform1i(p.u.u_from, 0);
    gl.uniform1i(p.u.u_to, 1);
    gl.uniform1f(p.u.u_progress, progress);
    gl.uniform1f(p.u.u_strength, strength);
    gl.uniform1f(p.u.u_time, time);
    gl.uniform1i(p.u.u_type, fxType);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  // transition layer (time-windowed) — engineMode parity for the 6 NEW transition kinds
  // (flash/slide/spin/rgbsplit/glitch/pixelize). flash/slide/rgbsplit/pixelize are faithful to the
  // canvas2d semantics; pixelize uses true NEAREST blocks (FS_PIXELIZE). STILL APPROXIMATED (need the
  // parity harness or GUI to verify the position math before tightening — see memory): spin = zoom-blur
  // (no quad rotation), glitch = rgbsplit (no per-slice jitter). engineMode is flag-gated, so these two
  // approximations are acceptable for now; ffmpeg/canvas2d already do spin+glitch faithfully on export.
  _transition(frame, layer, bw, bh) {
    const tls = layer.startTime || 0, tle = layer.endTime != null ? layer.endTime : frame.dur;
    const span = Math.max(0.01, tle - tls);
    const tProg = Math.max(0, Math.min(1, (frame.time - tls) / span));
    const kind = layer.kind || 'flash';
    const peak = Math.sin(tProg * Math.PI);   // 0 → 1 (mid) → 0
    const W = frame.W, H = frame.H;
    const bg = hexToRgb(frame.bgColor);
    if (kind === 'flash') {
      this._flash(peak * (layer.flash != null ? layer.flash : 0.85));
    } else if (kind === 'slide') {
      const dist = (layer.dist || 80) / 100 * W;
      const blurNow = (layer.blur || 12) * peak;
      this._snapshotScene(bw, bh);
      this._clearScene(bg[0], bg[1], bg[2], 1);
      this._compositeSnapshot(frame, -peak * dist, 0, W, H, blurNow, 'over', bw, bh);
    } else if (kind === 'spin') {
      // approx: zoom-blur (no rotation in the quad yet)
      const scaleMax = layer.scale || 1.6;
      const blurNow = (layer.blur || 12) * peak;
      const sc = 1 + (scaleMax - 1) * peak;
      this._snapshotScene(bw, bh);
      this._clearScene(bg[0], bg[1], bg[2], 1);
      const dw = W * sc, dh = H * sc;
      this._compositeSnapshot(frame, (W - dw) / 2, (H - dh) / 2, dw, dh, blurNow, 'over', bw, bh);
    } else if (kind === 'rgbsplit' || kind === 'glitch') {
      const rgbMax = layer.rgb || (kind === 'glitch' ? 18 : 20);
      const blurNow = (layer.blur || (kind === 'glitch' ? 0 : 6)) * peak;
      const off = peak * rgbMax;
      this._snapshotScene(bw, bh);
      this._compositeSnapshot(frame, 0, 0, W, H, blurNow, 'over', bw, bh);   // (blurred) base over the scene
      if (off > 0.5) {
        this._compositeSnapshot(frame, -off, 0, W, H, blurNow, 'screen', bw, bh);
        this._compositeSnapshot(frame, off, 0, W, H, blurNow, 'screen', bw, bh);
      }
    } else if (kind === 'pixelize') {
      // faithful: quantize to (W/block)×(H/block) true NEAREST blocks, peaking at the cut.
      // Mirrors canvas2d block = 1 + (pxMax-1)*peak; sw=round(W/block), sh=round(H/block).
      const pxMax = layer.px || 24;
      const block = 1 + (pxMax - 1) * peak;
      if (block > 1.5) {
        this._snapshotScene(bw, bh);
        this._pixelizeSnapshot(Math.round(W / block), Math.round(H / block), bw, bh);
      }
    }
  }

  // Read the current screen back as RGBA (for the parity harness / export).
  readPixels(w, h) {
    const gl = this.gl;
    const W = w || this.canvas.width, H = h || this.canvas.height;
    const buf = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf; // row 0 = bottom (GL order)
  }

  dispose() {
    const gl = this.gl;
    for (const r of this.texCache.values()) { try { gl.deleteTexture(r.tex); } catch {} }
    this.texCache.clear();
  }
}
