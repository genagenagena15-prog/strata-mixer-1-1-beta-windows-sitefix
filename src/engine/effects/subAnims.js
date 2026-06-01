// src/engine/effects/subAnims.js
// 15 subtitle animations from STRATA_EFFECTS_PACK.md §4.
// Two groups:
//  (a) transform anims (pop/slide/zoom/rotate/flip/jelly/…) — JS animTransform() →
//      feeds VS_TEXT uniforms u_scale (sx,sy) / u_offset (ox,oy) / u_rot. Pure JS,
//      no GLSL port needed.
//  (b) pixel anims (wave / karaoke-fill / typewriter / blur-in) — live INSIDE the
//      text fragment shader (textStyles.js FS_TEXT) selected by u_anim.
//
// Offsets/scales are in CLIP SPACE (quad −1..1, so ox=1.0 = half the screen) →
// resolution-independent → preview==export parity by construction (pack §0).
//
// ⚠ TIMING: the pack demo cycled on `time%2s` as a placeholder. In Strata the word
// window is KNOWN (segments[].words[].start/end). Pass `tWord` = seconds since the
// word activated (clamped to its window) so `enter`/`fill`/`prog` track the real
// word, NOT a 2s loop. animTransform() below takes that `tWord`.

// Returns {sx,sy,ox,oy,rot} for VS_TEXT. tWord = seconds since the word activated.
export function animTransform(a, tWord) {
  const time = tWord;
  const C = 2.0, t = (time % C) / C, enter = Math.min(t / 0.4, 1.0), eo = 1 - Math.pow(1 - enter, 3);
  let sx = 1, sy = 1, ox = 0, oy = 0, rot = 0;
  if (a === 1) { const b = (time % 1.1) / 1.1; sx = sy = 1 + 0.22 * Math.exp(-b * 7); }                                  // 1 Pop
  else if (a === 4) { const b = (time % 1.1) / 1.1; sx = sy = 1 + 0.35 * Math.exp(-b * 9); ox = Math.sin(time * 55) * 0.02 * Math.exp(-b * 6); } // 4 Punch
  else if (a === 5) { oy = -1.2 * (1 - eo); }                                                                  // 5 Slide-up
  else if (a === 6) { ox = -1.6 * (1 - eo); }                                                                  // 6 Slide side
  else if (a === 7) { sx = sy = 2.2 - 1.2 * eo; }                                                              // 7 Zoom-in
  else if (a === 8) { rot = 0.6 * (1 - eo); sx = sy = 0.7 + 0.3 * eo; }                                        // 8 Rotate-in
  else if (a === 9) { sx = Math.max(0.03, Math.sin(eo * Math.PI / 2)); }                                       // 9 Flip
  else if (a === 12) { ox = Math.sin(time * 50) * 0.015; oy = Math.cos(time * 43) * 0.015; }                   // 12 Shake
  else if (a === 13) { oy = 1.2 * (1 - eo) - Math.sin(eo * Math.PI * 2) * 0.08 * (1 - eo); }                   // 13 Bounce-drop
  else if (a === 14) { sx = 1 + 0.14 * Math.sin(time * 8); sy = 1 - 0.14 * Math.sin(time * 8); }               // 14 Jelly
  return { sx, sy, ox, oy, rot };
}

// Which anims are pixel-shader anims (handled by u_anim in FS_TEXT) vs transform anims.
export const PIXEL_ANIMS = new Set([2, 3, 10, 11]); // fill, wave, typewriter, blur-in
export const isPixelAnim = (a) => PIXEL_ANIMS.has(a);

// UI-picker metadata (pack §4). `a` = the u_anim / animTransform selector.
export const TEXT_ANIMS = [
  { id: 'none',       a: 0,  name: 'Нет' },
  { id: 'pop',        a: 1,  name: 'Pop / подскок' },
  { id: 'fill',       a: 2,  name: 'Заливка (караоке)' },
  { id: 'wave',       a: 3,  name: 'Волна' },
  { id: 'punch',      a: 4,  name: 'Punch' },
  { id: 'slideup',    a: 5,  name: 'Slide-up' },
  { id: 'slideside',  a: 6,  name: 'Slide сбоку' },
  { id: 'zoomin',     a: 7,  name: 'Zoom-in' },
  { id: 'rotatein',   a: 8,  name: 'Rotate-in' },
  { id: 'flip',       a: 9,  name: 'Flip' },
  { id: 'typewriter', a: 10, name: 'Typewriter' },
  { id: 'blurin',     a: 11, name: 'Blur-in' },
  { id: 'shake',      a: 12, name: 'Shake' },
  { id: 'bouncedrop', a: 13, name: 'Bounce-drop' },
  { id: 'jelly',      a: 14, name: 'Jelly' },
];
export const TEXT_ANIM_TYPE = Object.fromEntries(TEXT_ANIMS.map(x => [x.id, x.a]));
