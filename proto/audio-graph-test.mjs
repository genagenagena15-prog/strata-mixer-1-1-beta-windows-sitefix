// proto/audio-graph-test.mjs — proves the shared audio-graph helpers in electron/main.js
// (audioClipChain / finalAudioMix) produce BYTE-IDENTICAL filtergraph strings to the former
// inline code at all three call sites (engine:export-begin, video:edit, extractMixed…).
// We can't HEAR the export, so we verify the ffmpeg command instead: same string → same audio.
// Run: node proto/audio-graph-test.mjs   (exit 0 = all identical)

// ─── pure copies of the helpers + their deps from electron/main.js ───
function atempoChain(speed) {
  const at = []; let r = speed;
  while (r > 2) { at.push('atempo=2.0'); r /= 2; }
  while (r < 0.5) { at.push('atempo=0.5'); r *= 2; }
  at.push('atempo=' + r.toFixed(4));
  return at.join(',');
}
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';   // kept for a possible future toggle; not used by default
const PEAK_LIMIT = 'alimiter=limit=0.95:level=disabled';   // default export master: native loudness, only tame peaks
function audioClipChain(idx, trimStart, trimEnd, delayMs, label, opts) {
  const o = opts || {}, tempo = o.tempo || '', vol = o.vol || '', env = o.env || '';
  return `[${idx}:a]atrim=${trimStart.toFixed(3)}:${trimEnd.toFixed(3)},asetpts=PTS-STARTPTS${tempo},adelay=${delayMs}:all=1${vol}${env}[${label}]`;
}
function finalAudioMix(mixInputs, label, opts) {
  const o = opts || {};
  const ln = (o.loudnorm === false) ? '' : `${PEAK_LIMIT},`;
  const ar = ((o.firstPts === false) ? 'aresample=async=1' : 'aresample=async=1:first_pts=0') + ',aformat=channel_layouts=stereo';
  if (mixInputs.length === 1) return `${mixInputs[0]}${ln}${ar}[${label}]`;
  return `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0,${ln}${ar}[${label}]`;
}

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  expected: ${expected}\n  actual:   ${actual}`); }
}

// A sample volume-envelope fragment (the real buildVolEnvExpr output shape is opaque to this test;
// what matters is the helper splices whatever fragment it's given verbatim).
const ENV = `,volume='if(lt(t,1.0000),0.5000,1.0000)':eval=frame`;

// ── 1. engine:export-begin — per source: tempo (conditional) + raw baseVol + env ──
// old: `[${i+1}:a]atrim=${ts.toFixed(3)}:${te.toFixed(3)},asetpts=PTS-STARTPTS${tempo},adelay=${delay}:all=1,volume=${baseVol}${envFilt}[au${i}]`
{
  const i = 0, ts = 1.5, te = 3.5, delay = 2000, sp = 1.5, baseVol = '1';
  const tempo = (Math.abs(sp - 1) > 1e-3) ? (',' + atempoChain(sp)) : '';
  eq('export src (tempo+vol+env)',
    audioClipChain(i + 1, ts, te, delay, `au${i}`, { tempo, vol: `,volume=${baseVol}`, env: ENV }),
    `[1:a]atrim=1.500:3.500,asetpts=PTS-STARTPTS,atempo=1.5000,adelay=2000:all=1,volume=1${ENV}[au0]`);
}
{ // speed 1 → no tempo, no env
  const i = 2, ts = 0, te = 5.2, delay = 0, sp = 1, baseVol = '1.2340';
  const tempo = (Math.abs(sp - 1) > 1e-3) ? (',' + atempoChain(sp)) : '';
  eq('export src (no tempo, no env)',
    audioClipChain(i + 1, ts, te, delay, `au${i}`, { tempo, vol: `,volume=${baseVol}`, env: '' }),
    `[3:a]atrim=0.000:5.200,asetpts=PTS-STARTPTS,adelay=0:all=1,volume=1.2340[au2]`);
}
eq('export final single',
  finalAudioMix(['[au0]'], 'auFinal'),
  `[au0]${PEAK_LIMIT},aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[auFinal]`);
eq('export final multi',
  finalAudioMix(['[au0]', '[au1]'], 'auFinal'),
  `[au0][au1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,${PEAK_LIMIT},aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[auFinal]`);

// ── 2. video:edit — base [0:a] (no tempo) / main (tempo) / overlay (tempo+env) / audio (env) ──
eq('vedit base [0:a]',
  audioClipChain(0, 0.3, 4.3, 1500, 'auMain', { vol: `,volume=0.7000` }),
  `[0:a]atrim=0.300:4.300,asetpts=PTS-STARTPTS,adelay=1500:all=1,volume=0.7000[auMain]`);
{ // main video: numbers in, toFixed(3) inside == old pre-stringified
  const mvSrc = 2, mvSp = 1.25, videoStart = 0.4, videoEnd = 8.4, mvVolStr = '1.0000';
  const mvSrcEnd = mvSrc + Math.max(0.01, videoEnd - videoStart) * mvSp;
  eq('vedit main [0:a] (tempo)',
    audioClipChain(0, mvSrc, mvSrcEnd, Math.round(videoStart * 1000), 'auMain', { tempo: ',' + atempoChain(mvSp), vol: `,volume=${mvVolStr}` }),
    `[0:a]atrim=2.000:${mvSrcEnd.toFixed(3)},asetpts=PTS-STARTPTS,atempo=1.2500,adelay=400:all=1,volume=1.0000[auMain]`);
}
{
  const idx = 3, oSrc = 1, oLen = 6, oSp = 2, oDelay = 500, oBaseVol = '1';
  eq('vedit overlay (tempo+env)',
    audioClipChain(idx, oSrc, oSrc + oLen * oSp, oDelay, `auVov0`, { tempo: ',' + atempoChain(oSp), vol: `,volume=${oBaseVol}`, env: ENV }),
    `[3:a]atrim=1.000:13.000,asetpts=PTS-STARTPTS,atempo=2.0000,adelay=500:all=1,volume=1${ENV}[auVov0]`);
}
{
  const idx = 4, aSrc = 0, aLen = 10, delayMs = 1000, aBaseVol = '0.5000';
  eq('vedit audio layer (env, no tempo)',
    audioClipChain(idx, aSrc, aSrc + aLen, delayMs, `auLayer0`, { vol: `,volume=${aBaseVol}`, env: ENV }),
    `[4:a]atrim=0.000:10.000,asetpts=PTS-STARTPTS,adelay=1000:all=1,volume=0.5000${ENV}[auLayer0]`);
}
eq('vedit final single',
  finalAudioMix(['[auMain]'], 'auFinal'),
  `[auMain]${PEAK_LIMIT},aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[auFinal]`);
eq('vedit final multi',
  finalAudioMix(['[auMain]', '[auVov0]'], 'auFinal'),
  `[auMain][auVov0]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,${PEAK_LIMIT},aresample=async=1:first_pts=0,aformat=channel_layouts=stereo[auFinal]`);

// ── 3. extractMixed… — no volume, no env, no loudnorm, no first_pts ──
eq('extract base [0:a]',
  audioClipChain(0, 0.3, 4.3, 1500, 'auBase', {}),
  `[0:a]atrim=0.300:4.300,asetpts=PTS-STARTPTS,adelay=1500:all=1[auBase]`);
{
  const mvSrc = 2, mvSp = 1.25, clipDur = 8, delayMs = 400;
  const mvSrcEnd = mvSrc + clipDur * mvSp;
  eq('extract main [0:a] (tempo)',
    audioClipChain(0, mvSrc, mvSrcEnd, delayMs, 'auMain', { tempo: ',' + atempoChain(mvSp) }),
    `[0:a]atrim=2.000:${mvSrcEnd.toFixed(3)},asetpts=PTS-STARTPTS,atempo=1.2500,adelay=400:all=1[auMain]`);
}
{
  const idx = 1, oSrc = 1, oLen = 6, oSp = 2, delayMs = 500;
  eq('extract overlay (tempo)',
    audioClipChain(idx, oSrc, oSrc + oLen * oSp, delayMs, `auV0`, { tempo: ',' + atempoChain(oSp) }),
    `[1:a]atrim=1.000:13.000,asetpts=PTS-STARTPTS,atempo=2.0000,adelay=500:all=1[auV0]`);
}
{
  const idx = 2, aSrc = 0, aLen = 10, delayMs = 1000;
  eq('extract audio layer',
    audioClipChain(idx, aSrc, aSrc + aLen, delayMs, `auA0`, {}),
    `[2:a]atrim=0.000:10.000,asetpts=PTS-STARTPTS,adelay=1000:all=1[auA0]`);
}
eq('extract final single',
  finalAudioMix(['[auMain]'], 'afin', { loudnorm: false, firstPts: false }),
  `[auMain]aresample=async=1,aformat=channel_layouts=stereo[afin]`);
eq('extract final multi',
  finalAudioMix(['[auMain]', '[auV0]'], 'afin', { loudnorm: false, firstPts: false }),
  `[auMain][auV0]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,aresample=async=1,aformat=channel_layouts=stereo[afin]`);

console.log(`audio-graph-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
