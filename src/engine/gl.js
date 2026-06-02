// src/engine/gl.js — small WebGL2 helpers shared by the compositor.
// No React, no app state — pure GL plumbing so it can be unit-tested in isolation.

export function getGL(canvas, opts) {
  const gl = canvas.getContext('webgl2', {
    antialias: false, premultipliedAlpha: true, alpha: true,
    preserveDrawingBuffer: false, powerPreference: 'high-performance',
    ...(opts || {}),
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  return gl;
}

export function makeShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader compile: ' + log + '\n' + src);
  }
  return s;
}

export function makeProgram(gl, vsSrc, fsSrc) {
  const vs = makeShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = makeShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('program link: ' + log);
  }
  // lazy-cached uniform locations: prog.u.uName
  p.u = new Proxy({}, { get: (c, k) => (k in c ? c[k] : (c[k] = gl.getUniformLocation(p, k))) });
  return p;
}

// A unit quad [0,1]^2 as a triangle strip on attribute location 0.
export function createUnitQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export function createTexture(gl, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const f = filter || gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// Offscreen RGBA8 render target. Returns {fbo, tex, w, h, resize()}.
export function createFBO(gl, w, h) {
  const tex = createTexture(gl);
  const fbo = gl.createFramebuffer();
  const o = {
    fbo, tex, w: 0, h: 0,
    resize(nw, nh) {
      nw = Math.max(1, nw | 0); nh = Math.max(1, nh | 0);
      if (nw === o.w && nh === o.h) return;
      o.w = nw; o.h = nh;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
  };
  o.resize(w, h);
  return o;
}

// Upload a TexImageSource (HTMLVideoElement / HTMLImageElement / VideoFrame / canvas)
// into `tex`. Natural orientation (no GL flip) — the shader's uFlip handles screen Y.
export function uploadElement(gl, tex, el, premultiply) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!premultiply);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
}

// Shared quad vertex shader. uRect = (x0,y0,x1,y1) in NDC; uFlip flips V.
// uRot (radians) rotates the quad around the rect centre — aspect-corrected via uAspect
// (= W/H) so a square stays square. uRot defaults to 0 for every program that never sets
// it (blit/blur/mask/…), so the rotation branch is a no-op there; only the layer draws
// (which set uRot per call) ever rotate. → zero behaviour change for the existing paths.
export const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec4 uRect;
uniform int uFlip;
uniform float uRot;
uniform float uAspect;
out vec2 vUv;
void main(){
  vUv = vec2(aPos.x, uFlip==1 ? 1.0 - aPos.y : aPos.y);
  vec2 ndc = mix(uRect.xy, uRect.zw, aPos);
  if(uRot != 0.0){
    vec2 c = (uRect.xy + uRect.zw) * 0.5;
    vec2 d = ndc - c;
    vec2 q = vec2(d.x * uAspect, d.y);          // NDC → square (pixel-proportional) space
    float cs = cos(uRot), sn = sin(uRot);
    d = vec2((q.x*cs - q.y*sn) / uAspect, q.x*sn + q.y*cs);
    ndc = c + d;
  }
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

// Map a pixel rect {x,y,w,h} in an WxH output space to NDC (x0,y0,x1,y1),
// y-down pixels → y-up NDC. Draw with uFlip=1 so the texture appears upright.
export function pxRectToNDC(x, y, w, h, W, H) {
  const x0 = (x / W) * 2 - 1;
  const x1 = ((x + w) / W) * 2 - 1;
  // pixel y grows down; NDC y grows up → top edge (y) maps to +, bottom to −
  const y0 = 1 - (y / H) * 2;
  const y1 = 1 - ((y + h) / H) * 2;
  return [x0, y1, x1, y0]; // (x0,ybottom,x1,ytop) so mix(aPos) spans the rect
}
