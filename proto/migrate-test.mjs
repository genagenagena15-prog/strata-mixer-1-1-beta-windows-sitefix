// Quick check of the legacy-effect migration mapping against the real effect sets.
import { TRANSITIONS, TRANSITION_TYPE, TEXT_ANIMS, TEXT_ANIM_TYPE } from '../src/engine/effects/index.js';

function migrateLegacyLayers(layers) {
  if (!Array.isArray(layers)) return [];
  const FIRST_TRANSITION = (TRANSITIONS[0] && TRANSITIONS[0].id) || 'rgbrush';
  const firstAnim = TEXT_ANIMS.find(a => a.id !== 'none');
  const FIRST_ANIM = (firstAnim && firstAnim.id) || 'pop';
  return layers.map(l => {
    if (!l || typeof l !== 'object') return l;
    if (l.type === 'transition' && (!l.kind || TRANSITION_TYPE[l.kind] == null)) return { ...l, kind: FIRST_TRANSITION };
    if (l.type === 'subtitles' && l.style && l.style.anim != null && l.style.anim !== 'none' && TEXT_ANIM_TYPE[l.style.anim] === undefined) return { ...l, style: { ...l.style, anim: FIRST_ANIM } };
    return l;
  });
}

const samples = [
  { type: 'transition', kind: 'flash' },      // interim → remap
  { type: 'transition', kind: 'whippan' },    // oldest → remap
  { type: 'transition', kind: 'rgbrush' },    // current → keep
  { type: 'transition', kind: 'pixelize' },   // interim (≠ pixelate) → remap
  { type: 'transition', kind: 'swirl' },      // current → keep
  { type: 'subtitles', style: { anim: 'glow' } },     // old → remap
  { type: 'subtitles', style: { anim: 'colorwave' } },// old → remap
  { type: 'subtitles', style: { anim: 'pop' } },      // current → keep
  { type: 'subtitles', style: { anim: 'wave' } },     // current → keep
  { type: 'subtitles', style: { anim: 'none' } },     // none → keep
  { type: 'videoOverlay', x: 50 },            // untouched
];
const out = migrateLegacyLayers(samples);
const report = out.map((l, i) => ({
  in: samples[i].kind || (samples[i].style && samples[i].style.anim) || samples[i].type,
  out: l.kind || (l.style && l.style.anim) || l.type,
}));
console.log('FIRST_TRANSITION=' + TRANSITIONS[0].id + '  FIRST_ANIM=' + TEXT_ANIMS.find(a => a.id !== 'none').id);
console.log(JSON.stringify(report, null, 0));
