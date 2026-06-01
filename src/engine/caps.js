// src/engine/caps.js — GPU/WebCodecs capability + Tier detection.
// Extracted from the validated Phase-1 bench (proto/bench.js). Tier A = live-GPU
// WebGL2 + hardware H.264; Tier B = software/blocklisted → fall back to the proxy.

export function detectGL() {
  let gl = null;
  try {
    const c = document.createElement('canvas');
    gl = c.getContext('webgl2');
  } catch { /* ignore */ }
  if (!gl) return { webgl2: false, renderer: '', software: true };
  let renderer = '';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl.getParameter(gl.RENDERER) || '');
  } catch { /* ignore */ }
  const software = /swiftshader|software|llvmpipe|basic render|microsoft basic/i.test(renderer);
  return { webgl2: true, renderer, software };
}

export async function detectH264Hardware() {
  if (typeof VideoDecoder === 'undefined') return false;
  try {
    const s = await VideoDecoder.isConfigSupported({
      codec: 'avc1.640028', codedWidth: 1080, codedHeight: 1920,
      hardwareAcceleration: 'prefer-hardware',
    });
    return !!(s && s.supported);
  } catch { return false; }
}

// Full async tier pick. Tier A requires hardware WebGL2 + WebCodecs present.
// (hardware H.264 is reported but not required for Tier A — decode can fall back
// to DOM <video> textures; the 0-copy WebCodecs path is the optimization.)
export async function pickTier() {
  const g = detectGL();
  const webcodecs = typeof VideoDecoder !== 'undefined';
  const hwH264 = webcodecs ? await detectH264Hardware() : false;
  const tier = (g.webgl2 && !g.software && webcodecs) ? 'A' : 'B';
  return { ...g, webcodecs, hwH264, tier };
}

// Cheap synchronous gate (no WebCodecs probe) — for "can we even try WebGL".
export function canUseWebgl() {
  const g = detectGL();
  return g.webgl2 && !g.software;
}
