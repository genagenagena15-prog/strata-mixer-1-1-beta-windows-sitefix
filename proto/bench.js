// Strata GPU preview engine — PHASE 1 DE-RISK BENCH (v2: honest timing + stress ladder)
// Proves on THIS machine that the risky nodes are alive AND measures real headroom:
//   1) WebGL2 hardware (not SwiftShader)   2) WebCodecs H.264 hardware decode
//   3) 0-copy texImage2D(VideoFrame)+close 4) composite N layers @res with heavy fx — TRUE GPU ms
//   5) SDF glow smooth (not blocky)
// Timing uses EXT_disjoint_timer_query_webgl2 (real GPU time, vsync-independent), not gl.finish.
// A stress ladder (layers / resolution / fx) finds the ceiling even on a fast GPU, so we can
// reason about weaker integrated GPUs.
//
// Nothing here touches src/main.jsx or electron/main.js. Isolated prototype.

import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';

const EXPORT_W = 1080, EXPORT_H = 1920;
const TEST_CODEC_PROBE = 'avc1.640028';
const MAX_LAYERS = 12;

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  $('log').appendChild(line); $('log').scrollTop = $('log').scrollHeight;
  console.log(msg);
}
function setRow(id, val, verdict) { const el = $(id); if (!el) return; el.textContent = val; el.className = 'val ' + (verdict || ''); }
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// fast macrotask yield (NOT setTimeout — that clamps to ~4ms and starves the decoder)
const _mc = new MessageChannel();
let _yres = null; _mc.port1.onmessage = () => { const r = _yres; _yres = null; r && r(); };
const macroYield = () => new Promise(res => { _yres = res; _mc.port2.postMessage(0); });
// setTimeout works even when the window is backgrounded/occluded (rAF does not).
const smallSleep = (ms = 6) => new Promise(r => setTimeout(r, ms));

// ---------- WebGL2 ----------
let gl, canvas, progComposite, progGlow, progBlit, quadVAO;
let sceneFBO = null, sceneTex = null, sceneW = EXPORT_W, sceneH = EXPORT_H;
let timerExt = null;

function makeShader(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
function makeProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, makeShader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, makeShader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  p._u = new Proxy({}, { get: (c, k) => (k in c ? c[k] : (c[k] = gl.getUniformLocation(p, k))) });
  return p;
}

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec4 uRect; uniform int uFlip;
out vec2 vUv;
void main(){
  vUv = vec2(aPos.x, uFlip==1 ? 1.0 - aPos.y : aPos.y);
  vec2 ndc = mix(uRect.xy, uRect.zw, aPos);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

// composite + colorcorrect + optional heavy fx (emulates per-layer blur/glow fill cost)
const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uBright, uContrast, uSat, uOpacity, uHeavy;
out vec4 outColor;
void main(){
  vec4 t = texture(uTex, vUv);
  vec3 acc = t.rgb;
  for(int k=0;k<64;k++){
    if(float(k) >= uHeavy) break;
    float a = float(k) * 0.196;
    acc += texture(uTex, vUv + vec2(cos(a), sin(a)) * 0.005).rgb;
  }
  acc /= (1.0 + uHeavy);
  vec3 c = acc + uBright;
  c = (c - 0.5) * uContrast + 0.5;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat);
  outColor = vec4(clamp(c, 0.0, 1.0), t.a * uOpacity);
}`;

const FS_GLOW = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSdf;
uniform vec3 uGlowColor, uFillColor;
uniform float uSpread, uPulse;
out vec4 outColor;
void main(){
  float d = texture(uSdf, vUv).r;
  float sd = d - 0.5;
  float aa = fwidth(sd) + 1e-4;
  float fill = smoothstep(-aa, aa, sd);
  float glow = smoothstep(-uSpread, 0.0, sd);
  glow = pow(glow, 1.6) * uPulse;
  vec3 col = mix(uGlowColor * glow, uFillColor, fill);
  float a = max(glow, fill);
  outColor = vec4(col * a, a);
}`;

const FS_BLIT = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; out vec4 outColor;
void main(){ outColor = texture(uTex, vUv); }`;

function ensureScene(scale) {
  const w = Math.round(EXPORT_W * scale), h = Math.round(EXPORT_H * scale);
  if (sceneTex && w === sceneW && h === sceneH) return;
  sceneW = w; sceneH = h;
  if (!sceneTex) sceneTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (!sceneFBO) sceneFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function initGL() {
  canvas = $('view');
  canvas.width = EXPORT_W; canvas.height = EXPORT_H;
  gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (!gl) throw new Error('no webgl2');
  timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  progComposite = makeProgram(VS_QUAD, FS_COMPOSITE);
  progGlow = makeProgram(VS_QUAD, FS_GLOW);
  progBlit = makeProgram(VS_QUAD, FS_BLIT);
  quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  ensureScene(1.0);
}

function drawQuad(prog, rect, flip) {
  gl.useProgram(prog); gl.bindVertexArray(quadVAO);
  gl.uniform4f(prog._u.uRect, rect[0], rect[1], rect[2], rect[3]);
  if (prog._u.uFlip) gl.uniform1i(prog._u.uFlip, flip ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ---------- caps ----------
async function detectCaps() {
  const out = { webgl2: false, renderer: '', software: false, webcodecs: false, hwH264: false, tier: 'B' };
  const c = document.createElement('canvas'); const g = c.getContext('webgl2');
  out.webgl2 = !!g;
  if (g) {
    const dbg = g.getExtension('WEBGL_debug_renderer_info');
    out.renderer = dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (g.getParameter(g.RENDERER) || '');
    out.software = /swiftshader|software|llvmpipe|basic render/i.test(out.renderer);
  }
  out.webcodecs = (typeof VideoDecoder !== 'undefined');
  if (out.webcodecs) {
    try {
      const sup = await VideoDecoder.isConfigSupported({ codec: TEST_CODEC_PROBE, codedWidth: 1080, codedHeight: 1920, hardwareAcceleration: 'prefer-hardware' });
      out.hwH264 = !!(sup && sup.supported);
    } catch { out.hwH264 = false; }
  }
  out.tier = (out.webgl2 && !out.software && out.webcodecs) ? 'A' : 'B';
  setRow('cap-webgl2', out.webgl2 ? 'yes' : 'NO', out.webgl2 ? 'ok' : 'bad');
  setRow('cap-renderer', out.renderer || '(unknown)', out.software ? 'bad' : 'ok');
  setRow('cap-software', out.software ? 'SOFTWARE — Tier B' : 'hardware', out.software ? 'bad' : 'ok');
  setRow('cap-webcodecs', out.webcodecs ? 'yes' : 'NO', out.webcodecs ? 'ok' : 'bad');
  setRow('cap-hwh264', out.hwH264 ? 'prefer-hardware OK' : 'no/unsupported', out.hwH264 ? 'ok' : 'warn');
  setRow('cap-tier', out.tier === 'A' ? 'A (live GPU)' : 'B (proxy fallback)', out.tier === 'A' ? 'ok' : 'warn');
  setRow('cap-timer', timerExt ? 'GPU timer query' : 'fallback (finish)', timerExt ? 'ok' : 'warn');
  log(`[caps] webgl2=${out.webgl2} sw=${out.software} renderer="${out.renderer}" webcodecs=${out.webcodecs} hwH264=${out.hwH264} timer=${!!timerExt} -> Tier ${out.tier}`);
  return out;
}

// ---------- per-layer decoder ----------
class LayerDecoder {
  constructor(url, label) { this.url = url; this.label = label; this.ring = []; this.target = 4; this.decoded = 0; }
  async init() {
    const blob = await (await fetch(this.url)).blob();
    this.input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    this.track = await this.input.getPrimaryVideoTrack();
    if (!this.track) throw new Error('no video track: ' + this.url);
    this.config = await this.track.getDecoderConfig();
    this.w = await this.track.getDisplayWidth();
    this.h = await this.track.getDisplayHeight();
    let sup = { supported: true };
    try { sup = await VideoDecoder.isConfigSupported({ ...this.config, hardwareAcceleration: 'prefer-hardware' }); } catch {}
    this.hw = !!sup.supported;
    this.chunks = [];
    const sink = new EncodedPacketSink(this.track);
    let p = await sink.getFirstPacket();
    while (p) {
      const c = p.toEncodedVideoChunk();
      const d = new Uint8Array(c.byteLength); c.copyTo(d);
      this.chunks.push({ type: c.type, timestamp: c.timestamp, duration: c.duration || 0, data: d });
      p = await sink.getNextPacket(p);
    }
    const last = this.chunks[this.chunks.length - 1];
    this.loopDur = (last.timestamp + (last.duration || 33333));
    this.idx = 0; this.loop = 0;
    this.decoder = new VideoDecoder({
      output: (frame) => { this.ring.push(frame); this.decoded++; },
      error: (e) => { this.err = e; log('[decode] ' + this.label + ' error: ' + e.message, 'bad'); },
    });
    this.decoder.configure({ ...this.config, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.hasTex = false;
    log(`[layer] ${this.label}  ${this.w}x${this.h}  codec=${this.config.codec}  packets=${this.chunks.length}  hw=${this.hw}`);
    return this;
  }
  pump() {
    while ((this.ring.length + this.decoder.decodeQueueSize) < this.target && !this.err) {
      const c = this.chunks[this.idx];
      this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp + this.loop * this.loopDur, duration: c.duration, data: c.data }));
      if (++this.idx >= this.chunks.length) { this.idx = 0; this.loop++; }
    }
  }
  takeNewest() { if (!this.ring.length) return null; while (this.ring.length > 1) this.ring.shift().close(); return this.ring.shift(); }
  uploadNewest() {
    const f = this.takeNewest(); if (!f) return -1;
    const t0 = performance.now();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f);
    const dt = performance.now() - t0;
    f.close(); this.hasTex = true; return dt;
  }
  flush() { for (const f of this.ring) f.close(); this.ring.length = 0; }
  destroy() { this.flush(); try { this.decoder.close(); } catch {} try { gl.deleteTexture(this.tex); } catch {} }
}

// ---------- render ----------
function renderScene(layers, heavy) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
  gl.viewport(0, 0, sceneW, sceneH);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(progComposite);
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i]; if (!L.hasTex) continue;
    if (i === 0) gl.disable(gl.BLEND); else { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, L.tex);
    gl.uniform1i(progComposite._u.uTex, 0);
    gl.uniform1f(progComposite._u.uBright, 0.02 * i);
    gl.uniform1f(progComposite._u.uContrast, 1.04);
    gl.uniform1f(progComposite._u.uSat, 1.10);
    gl.uniform1f(progComposite._u.uOpacity, i === 0 ? 1.0 : 0.86);
    gl.uniform1f(progComposite._u.uHeavy, heavy || 0);
    const m = i === 0 ? 0 : 0.04 * (i % 6);
    drawQuad(progComposite, [-1 + m, -1 + m, 1 - m, 1 - m], true);
  }
  gl.disable(gl.BLEND);
}
function blitSceneToScreen() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(progBlit); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.uniform1i(progBlit._u.uTex, 0);
  drawQuad(progBlit, [-1, -1, 1, 1], false);
}

// ---------- SDF glow ----------
let sdfTex = null;
function chamferDT(seed, W, H) {
  const INF = 1e9, d = new Float32Array(W * H), a = 1.0, b = Math.SQRT2;
  for (let i = 0; i < W * H; i++) d[i] = seed[i] ? 0 : INF;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + a);
    if (y > 0) v = Math.min(v, d[i - W] + a);
    if (x > 0 && y > 0) v = Math.min(v, d[i - W - 1] + b);
    if (x < W - 1 && y > 0) v = Math.min(v, d[i - W + 1] + b);
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + a);
    if (y < H - 1) v = Math.min(v, d[i + W] + a);
    if (x < W - 1 && y < H - 1) v = Math.min(v, d[i + W + 1] + b);
    if (x > 0 && y < H - 1) v = Math.min(v, d[i + W - 1] + b);
    d[i] = v;
  }
  return d;
}
function buildSDF(text) {
  const S = 512;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const x = c.getContext('2d');
  x.clearRect(0, 0, S, S); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '900 150px Arial, sans-serif'; x.fillText(text, S / 2, S / 2);
  const img = x.getImageData(0, 0, S, S).data;
  const inside = new Uint8Array(S * S), outside = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) { const on = img[i * 4 + 3] > 127 ? 1 : 0; inside[i] = on; outside[i] = 1 - on; }
  const dIn = chamferDT(outside, S, S), dOut = chamferDT(inside, S, S);
  const RANGE = 0.14 * S, tex = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) { const sd = inside[i] ? dIn[i] : -dOut[i]; tex[i] = Math.max(0, Math.min(255, Math.round((0.5 + sd / (2 * RANGE)) * 255))); }
  if (!sdfTex) sdfTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sdfTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, S, S, 0, gl.RED, gl.UNSIGNED_BYTE, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
function renderGlowOverScreen(pulse) {
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(progGlow); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sdfTex);
  gl.uniform1i(progGlow._u.uSdf, 0);
  gl.uniform3f(progGlow._u.uGlowColor, 0.20, 0.85, 1.0);
  gl.uniform3f(progGlow._u.uFillColor, 0.92, 0.99, 1.0);
  gl.uniform1f(progGlow._u.uSpread, 0.42);
  gl.uniform1f(progGlow._u.uPulse, 0.7 + 0.3 * pulse);
  drawQuad(progGlow, [-0.8, -0.35, 0.8, 0.35], true);
  gl.disable(gl.BLEND);
}

// ---------- honest GPU timing (real GPU ns, vsync-independent) ----------
const _scratch = new Uint8Array(4);
async function measureGPUms(renderFn, frames) {
  // readPixels(1px) after each frame forces the GPU pipeline to finish synchronously.
  // Reliable on ANGLE/D3D11 (where EXT_disjoint_timer_query is flaky) AND on the
  // integrated GPUs / Macs we actually care about — gl.finish() does NOT sync on ANGLE.
  renderFn(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _scratch); // warmup
  await smallSleep(2);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) { renderFn(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _scratch); }
  return { ms: (performance.now() - t0) / frames, n: frames, method: 'readpixels-sync' };
}
// clear+readback only — used to measure (and subtract) the fixed per-frame sync overhead
function clearOnly() { gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO); gl.viewport(0, 0, sceneW, sceneH); gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }

// ---------- decode throughput (fixed: macroYield, not setTimeout) ----------
async function benchDecodeThroughput(layers, ms) {
  layers.forEach(L => { L.decoded = 0; L.flush(); L.target = 16; });
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    for (const L of layers) { L.pump(); while (L.ring.length > 2) L.ring.shift().close(); }
    await macroYield();
  }
  const dt = (performance.now() - t0) / 1000;
  const total = layers.reduce((s, L) => s + L.decoded, 0);
  layers.forEach(L => { L.target = 4; L.flush(); });
  return { fps: total / dt, perLayer: layers.map(L => Math.round(L.decoded / dt)) };
}

// ---------- orchestration ----------
const FILES = [];
let DECODERS = [];
async function loadManifest() {
  const names = await (await fetch('testmedia/manifest.json')).json();
  names.forEach(n => FILES.push('testmedia/' + n));
  log(`[media] ${FILES.length} test clips`);
}
async function buildDecoders(n) {
  DECODERS.forEach(d => d.destroy()); DECODERS = [];
  for (let i = 0; i < n; i++) {
    const url = FILES[i % FILES.length];
    DECODERS.push(await new LayerDecoder(url, `L${i}:${url.split('/').pop().slice(0, 10)}`).init());
  }
  for (let w = 0; w < 16; w++) { DECODERS.forEach(d => d.pump()); await smallSleep(8); }
  DECODERS.forEach(d => d.uploadNewest());
}

const LADDER = [
  { name: '7 слоёв · 1080×1920 · fx0', n: 7, scale: 1.0, heavy: 0 },
  { name: '7 слоёв · 1080×1920 · fx24', n: 7, scale: 1.0, heavy: 24 },
  { name: '12 слоёв · 1080×1920 · fx0', n: 12, scale: 1.0, heavy: 0 },
  { name: '7 слоёв · 1620×2880 · fx12', n: 7, scale: 1.5, heavy: 12 },
  { name: '12 слоёв · 1620×2880 · fx24', n: 12, scale: 1.5, heavy: 24 },
];

function stressRow(name, ms, fps, cls, ov) {
  const div = document.createElement('div'); div.className = 'srow';
  const val = ms ? `${ms.toFixed(2)} ms · ${fps} fps` : `&lt; ${(ov * 0.3).toFixed(2)} ms (floor)`;
  div.innerHTML = `<span class="sname">${name}</span><span class="sval ${cls}">${val}</span>`;
  $('stress').appendChild(div);
}

let busy = false;
async function runFull() {
  if (busy) return; busy = true;
  $('stress').innerHTML = ''; $('verdict').textContent = 'running…'; $('verdict').className = 'verdict';
  try {
    const caps = await detectCaps();
    log('[bench] building ' + MAX_LAYERS + ' layer decoders…');
    await buildDecoders(MAX_LAYERS);
    const anyHw = DECODERS.some(d => d.hw);
    setRow('cap-hwh264', anyHw ? 'prefer-hardware OK' : 'software decode', anyHw ? 'ok' : 'warn');

    log('[bench] decode throughput (' + MAX_LAYERS + ' layers, 2s)…');
    const dec = await benchDecodeThroughput(DECODERS, 2000);
    setRow('r-decode', `${dec.fps.toFixed(0)} fr/s (per: ${dec.perLayer.join('/')})`, dec.fps > MAX_LAYERS * 30 ? 'ok' : 'warn');

    // measure upload cost (0-copy) across all layers
    let up = 0, upN = 0;
    for (const L of DECODERS) { L.pump(); }
    await smallSleep(10);
    for (const L of DECODERS) { const u = L.uploadNewest(); if (u >= 0) { up += u; upN++; } }
    setRow('r-upload', `${(up / Math.max(1, upN)).toFixed(2)} ms/frame ×${upN}`, (up / Math.max(1, upN)) < 1.5 ? 'ok' : 'warn');

    buildSDF('НЕОН');

    // STRESS LADDER — real GPU ms per config (readPixels-sync, overhead subtracted)
    log('[bench] stress ladder (readPixels-sync GPU time)…');
    ensureScene(1.0);
    const ov = (await measureGPUms(clearOnly, 60)).ms;
    log(`[stress] readback+clear overhead ≈ ${ov.toFixed(3)}ms (subtracted)`);
    const ladderRes = [];
    for (const cfg of LADDER) {
      ensureScene(cfg.scale);
      const active = DECODERS.slice(0, cfg.n);
      for (const L of active) { L.pump(); L.uploadNewest(); }
      const raw = (await measureGPUms(() => renderScene(active, cfg.heavy), 80)).ms;
      const measurable = raw > ov * 1.3;                 // below this, real cost is lost in readback noise
      const ms = measurable ? raw - ov : null;           // null = below floor (effectively free)
      const fps = ms ? Math.round(1000 / ms) : null;
      const cls = !ms ? 'ok' : (ms < 16.6 ? 'ok' : (ms < 33.3 ? 'warn' : 'bad'));
      stressRow(cfg.name, ms, fps, cls, ov);
      log(`[stress] ${cfg.name}: ${ms ? ms.toFixed(2) + 'ms (' + fps + 'fps)' : '< floor'} raw=${raw.toFixed(2)} ov=${ov.toFixed(2)}`);
      ladderRes.push({ name: cfg.name, n: cfg.n, scale: cfg.scale, heavy: cfg.heavy, ms: ms ? +ms.toFixed(2) : null, fps });
      await macroYield();
    }
    ensureScene(1.0);

    // verdict — project to integrated GPUs from the VALID (heavy) measurements, not the floor noise.
    // RTX 5060 Ti is ~8–20× faster than typical integrated (Iris Xe / Apple M-base / old Intel) in fill+ALU.
    const hwOk = caps.tier === 'A' && anyHw;
    const typical = ladderRes.find(r => r.n === 7 && r.scale === 1.0 && r.heavy === 24); // heavy fx on 7 layers
    const extreme = ladderRes[ladderRes.length - 1];                                     // 12 layers @1620p + heavy fx
    const tMs = (typical && typical.ms) || 0.5, eMs = (extreme && extreme.ms) || 3.0;
    const projT = [tMs * 8, tMs * 20], projE = [eMs * 8, eMs * 20];
    let verdict, vclass;
    if (!hwOk) { verdict = 'NO-GO — Tier B (нет hw GPU/WebCodecs). Прокси-fallback.'; vclass = 'bad'; }
    else {
      vclass = projT[1] < 33.3 ? 'ok' : 'warn';
      verdict = `GO ✅ (RTX тащит играючи; реалистичная сцена ниже floor-шума). ` +
        `Прогноз ВСТРОЙКА ×8–20 → тяжёлая сцена 7сл+эффекты ${tMs.toFixed(2)}мс ⇒ ~${projT[0].toFixed(0)}–${projT[1].toFixed(0)}мс ` +
        `(${projT[1] < 33.3 ? 'держит 30–60fps' : 'на грани 30fps'}); ` +
        `экстрим 12сл@1620p+fx ${eMs.toFixed(1)}мс ⇒ ~${projE[0].toFixed(0)}–${projE[1].toFixed(0)}мс. ` +
        `⚠ Это ЭКСТРАПОЛЯЦИЯ — финал нужен прогоном на реальной встройке.`;
    }
    $('verdict').textContent = verdict; $('verdict').className = 'verdict ' + vclass;

    const result = {
      tier: caps.tier, renderer: caps.renderer, hwH264: anyHw,
      decodeFps: +dec.fps.toFixed(0), uploadMs: +(up / Math.max(1, upN)).toFixed(2),
      ladder: ladderRes.map(r => ({ name: r.name, ms: r.ms, fps: r.fps })),
      typicalHeavyMs: +tMs.toFixed(2), extremeMs: +eMs.toFixed(2),
      projIntegratedTypicalMs: [+projT[0].toFixed(1), +projT[1].toFixed(1)],
      projIntegratedExtremeMs: [+projE[0].toFixed(1), +projE[1].toFixed(1)],
      verdict,
    };
    log('@@BENCH@@' + JSON.stringify(result));
  } catch (e) {
    $('verdict').textContent = 'ERROR: ' + e.message; $('verdict').className = 'verdict bad';
    log('[error] ' + (e.stack || e.message), 'bad');
    log('@@BENCH@@' + JSON.stringify({ error: e.message }));
  } finally { busy = false; idleLoop(); }
}

let idleOn = false;
function idleLoop() {
  if (idleOn) return; idleOn = true;
  function frame() {
    if (busy) { requestAnimationFrame(frame); return; }
    const active = DECODERS.slice(0, 7);
    for (const L of active) { L.pump(); L.uploadNewest(); }
    renderScene(active, 0); blitSceneToScreen();
    if (sdfTex) renderGlowOverScreen((Math.sin(performance.now() / 300) + 1) / 2);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    initGL(); await loadManifest();
    $('run').addEventListener('click', runFull);
    log('Bench ready. Auto-running in 600ms…');
    setTimeout(runFull, 600);
  } catch (e) {
    $('verdict').textContent = 'INIT ERROR: ' + e.message; $('verdict').className = 'verdict bad';
    log('[init error] ' + (e.stack || e.message), 'bad');
  }
});
