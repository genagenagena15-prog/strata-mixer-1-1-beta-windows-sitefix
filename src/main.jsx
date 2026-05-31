import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import './styles.css';

const APP_VERSION = 'v1.3.2';
// Preview backing-resolution scale while PLAYING (full res when paused for a
// crisp still). 0.5 → ¼ the pixels → ~4× cheaper compositing, no audio glitch.
const PREVIEW_SCALE = 0.5;
const DONATE_WALLET = 'TGoUEoM6AjG6KjnXJi9hFYRn54c6HsTybE';

// Volume slider taper: piecewise for fine control at both ends.
//   • 0 – 50 %:   2 v²   (smooth taper into silence — 5 % ≈ −46 dB, 1 % ≈ −74 dB)
//   • 50 – 100 %: linear (no surprise — 75 % = −2.5 dB)
//   • 100 – 200 %: v³    (cubic boost — 200 % = +18 dB)
// Continuous at the boundaries. The ffmpeg export has loudnorm on the master
// so quieting one layer doesn't drop the overall export level — the slider
// affects only RELATIVE mix balance.
function volumeCurve(percent) {
  const v = Math.max(0, Number(percent) || 0) / 100;
  if (v <= 0.5) return 2 * v * v;
  if (v <= 1) return v;
  return v * v * v;
}

const A = {
  icon: new URL('../assets/strata-icon.svg', import.meta.url).href,
  upload: new URL('../assets/download.png', import.meta.url).href,
  preview: new URL('../assets/picture.png', import.meta.url).href,
  donateQr: new URL('../assets/donate-qr.png', import.meta.url).href,
  cubeWaitWhite: new URL('../assets/cube-white-waiting.mp4', import.meta.url).href,
  cubeWaitBlack: new URL('../assets/cube-black-waiting.mp4', import.meta.url).href,
  cubeFinishWhite: new URL('../assets/cube-white-finish.mp4', import.meta.url).href,
  cubeFinishBlack: new URL('../assets/cube-black-finish.mp4', import.meta.url).href,
};
// Layer-type icons shown next to the clip name on the timeline track row.
// One PNG per type (maskedVideo and mainVideo reuse the video icon).
const LAYER_ICONS = {
  videoOverlay: new URL('../assets/layer-icons/video.png', import.meta.url).href,
  mainVideo:    new URL('../assets/layer-icons/video.png', import.meta.url).href,
  maskedVideo:  new URL('../assets/layer-icons/video.png', import.meta.url).href,
  image:        new URL('../assets/layer-icons/image.png', import.meta.url).href,
  audio:        new URL('../assets/layer-icons/audio.png', import.meta.url).href,
  text:         new URL('../assets/layer-icons/text.png', import.meta.url).href,
  subtitles:    new URL('../assets/layer-icons/text.png', import.meta.url).href,
  mask:         new URL('../assets/layer-icons/mask.png', import.meta.url).href,
  blur:         new URL('../assets/layer-icons/blur.png', import.meta.url).href,
  zoom:         new URL('../assets/layer-icons/zoom.png', import.meta.url).href,
  transition:   new URL('../assets/layer-icons/transition.png', import.meta.url).href,
};

// Subtitle layout constants — SHARED contract with the ASS export in
// electron/main.js (buildAssForSubtitles must use the same fractions so the
// burned-in result wraps identically to the preview).
const SUB_MAX_WIDTH_FRAC = 0.88;  // wrap when a line exceeds 88% of canvas width
const SUB_LINE_HEIGHT = 1.25;     // line advance as a multiple of font size

// Greedy word-wrap: pack words onto a line until the next word would exceed
// maxWidth, then start a new line. `measure(text)` returns the pixel width of
// a string in the current font. Never breaks a single word (a too-long word
// just gets its own line). Returns an array of lines, each an array of words.
function wrapSubtitleWords(words, measure, maxWidth) {
  const lines = [];
  let line = [];
  let lineW = 0;
  const spaceW = measure(' ');
  for (const w of words) {
    const ww = measure(w.text || '');
    const addW = line.length ? spaceW + ww : ww;
    if (line.length && lineW + addW > maxWidth) {
      lines.push(line);
      line = [w];
      lineW = ww;
    } else {
      line.push(w);
      lineW += addW;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

// Compute the EXACT on-canvas layout of one subtitle segment: wrapped lines and
// each word's CENTER point (in output pixels) plus its active-time window. This
// is the SINGLE source of truth shared by the canvas preview AND the burned-in
// export — the export serializes these coordinates into absolute \pos ASS, so
// preview and final video can never diverge on wrapping, line spacing or
// position. `measure(text)` must use the SAME font the preview draws with.
function layoutSubtitleSegment(seg, style, W, H, measure) {
  const fsOrig = Math.max(8, Number(style.fontSize) || 56);
  const segStart = Number(seg.startTime) || 0;
  const segEnd = Math.max(segStart + 0.05, Number(seg.endTime) || segStart);
  let words = Array.isArray(seg.words) && seg.words.length ? seg.words : null;
  if (!words) {
    // No per-word timings (text typed in the editor) — distribute evenly.
    const parts = String(seg.text || '').split(/\s+/).filter(Boolean);
    const each = parts.length ? (segEnd - segStart) / parts.length : 0;
    words = parts.map((t, i) => ({ text: t, start: segStart + i * each, end: segStart + (i + 1) * each }));
  }
  if (!words.length) return { lines: [], fs: fsOrig, segStart, segEnd };
  // PHOTOSHOP / AFTER-EFFECTS text-box model: the font size is EXPLICIT (the
  // panel slider) and is NEVER auto-shrunk. The box only controls where the
  // text WRAPS — its width (boxW) is the wrap width. Text renders at its real
  // size and freely overflows the box / canvas edges (so you CAN make subs that
  // bleed past the frame). boxH is purely the visual frame height; it no longer
  // shrinks the text. Wrap caps at 300 % so the box can exceed the canvas.
  const boxWFrac = Math.max(10, Math.min(300, Number(style.boxW) || 88)) / 100;
  const maxLineWidth = W * boxWFrac;
  const spaceW = measure(' ');
  const wrapped = wrapSubtitleWords(words, measure, maxLineWidth);
  // Per-layer line spacing — percent of fontSize (60–300; default 125 ≡ 1.25).
  const lhPct = Math.max(60, Math.min(300, Number(style.lineHeight) || (SUB_LINE_HEIGHT * 100)));
  const fs = fsOrig;                          // explicit — no auto-fit shrink
  const lineH = fs * (lhPct / 100);
  const blockH = wrapped.length * lineH;
  const cx0 = ((style.x ?? 50) / 100) * W;
  const cy0 = ((style.y ?? 85) / 100) * H;
  let cy = cy0 - blockH / 2 + lineH / 2;
  const out = [];
  for (const line of wrapped) {
    const widths = line.map(w => measure(w.text || ''));
    const spW = spaceW;
    const totalW = widths.reduce((a, b) => a + b, 0) + spW * Math.max(0, line.length - 1);
    let cursor = cx0 - totalW / 2;
    const lineWords = line.map((w, i) => {
      const wd = widths[i];
      const cxw = cursor + wd / 2;
      cursor += wd + spW;
      return {
        text: w.text, cx: cxw, cy, w: wd,
        start: Number(w.start) || segStart,
        end: Math.max((Number(w.start) || segStart) + 0.02, Number(w.end) || segEnd),
      };
    });
    out.push({ cy, words: lineWords });
    cy += lineH;
  }
  return { lines: out, fs, segStart, segEnd };
}

// Six ready-made subtitle looks. Each preset is purely a colour trio
// (text / outline / active-word highlight) so it renders byte-identically in
// the canvas preview and the libass-burned export — no rasterizer-dependent
// effects that could drift between the two.
const SUB_EFFECTS = [
  { id: 'classic', name: 'Классика', color: '#ffffff', outlineColor: '#000000', highlightColor: '#ff9a1f' },
  { id: 'yellow',  name: 'Жёлтый',   color: '#ffd60a', outlineColor: '#000000', highlightColor: '#ffffff' },
  { id: 'neon',    name: 'Неон',     color: '#aaff00', outlineColor: '#103000', highlightColor: '#ffffff' },
  { id: 'pink',    name: 'Розовый',  color: '#ff5cc8', outlineColor: '#2a0420', highlightColor: '#ffffff' },
  { id: 'fire',    name: 'Огонь',    color: '#ffffff', outlineColor: '#000000', highlightColor: '#ff3b1f' },
  { id: 'ice',     name: 'Лёд',      color: '#eaffff', outlineColor: '#003b57', highlightColor: '#46d3ff' },
];

// Per-word/phrase subtitle animations. The timing constants here are the SHARED
// contract between the canvas preview (src/main.jsx) and the ASS export
// (electron/main.js buildAssForSubtitles) — change them in both or they drift.
const SUB_ANIMS = [
  { id: 'none',      name: 'Без анимации' },
  { id: 'pop',       name: 'Поп' },              // active word scale-punches when spoken
  { id: 'bam',       name: 'Бам' },              // overshooting pop: 150% → 85% → 100%
  { id: 'scale',     name: 'Масштаб (зум-ин)' }, // whole phrase scales 60→100 + fades in
  { id: 'zoomout',   name: 'Зум-аут' },          // whole phrase scales 140→100 + fades in
  { id: 'type',      name: 'Печатная' },         // words appear one-by-one as spoken
  { id: 'rise',      name: 'Подъём' },           // words rise up + fade in as spoken
  { id: 'blurfocus', name: 'Размытие в фокус' }, // active word starts blurred → sharp
  { id: 'glow',      name: 'Glow-пульс' },       // outline width pulses on active word
  { id: 'colorwave', name: 'Цвет-волна' },       // active word cycles colours
  { id: 'neon',      name: 'Неон-мерцание' },    // thick neon outline + rapid alpha flicker
  { id: 'typewriter',name: 'Печатная + курсор' },// type reveal + blinking | cursor after last word
  { id: 'shake',     name: 'Тряска' },           // ±4° rotation jitter on active word
  { id: 'bounce',    name: 'Отскок' },           // drops in from above with squash-and-stretch
];
const SUB_ANIM = {
  POP_MS: 130, POP_SCALE: 1.30,         // pop: 130% → 100% over 130ms
  SCALE_MS: 200, SCALE_FROM: 0.60, SCALE_FADE_MS: 120,
  RISE_MS: 150, RISE_OFFSET: 28, RISE_FADE_MS: 100,
  // NEW:
  BAM_MS1: 100, BAM_MS2: 180,           // bam: 150%→85% over 0-100ms, 85%→100% over 100-180ms
  BAM_FROM: 1.50, BAM_MID: 0.85,
  BLUR_MS: 200, BLUR_PX: 8,             // blurfocus: 8px → 0 over 200ms
  ZOUT_MS: 200, ZOUT_FROM: 1.40, ZOUT_FADE_MS: 120,
  GLOW_MS: 500, GLOW_MUL: 2.5,          // outline width pulses base → base*MUL → base, triangle wave
  WAVE_MS: 350,                          // colour-wave: 350ms per colour
  WAVE_COLORS: ['#ff9a1f', '#ff3bb8', '#46d3ff', '#aaff00'],
  // neon: outline becomes thick + cyan, alpha flickers in 6 stages over 200ms then stable
  NEON_MS: 200, NEON_BORD_MUL: 2.2, NEON_COLOR: '#00f0ff',
  NEON_STAGES: [[0,50,1.0],[50,70,0.0],[70,100,1.0],[100,120,0.0],[120,160,0.45],[160,Infinity,1.0]],
  // typewriter: cursor | blinks 250ms on / 250ms off after each revealed word
  TYPE_CURSOR_MS: 500,                  // full blink period (on+off)
  TYPE_CURSOR_PAD: 0.18,                // gap between word end and cursor, in fontSize units
  // shake: 5 stages of rotation pivoting around the word center, ±4° decaying
  SHAKE_STAGES: [[0,40,4],[40,80,-4],[80,120,3],[120,160,-2],[160,200,0]],
  // bounce: drops from above with squash; 3 phases (drop / squash / settle)
  BOUNCE_OFFSET: 60, BOUNCE_DROP_MS: 120, BOUNCE_SQUASH_MS: 80, BOUNCE_SETTLE_MS: 100,
  BOUNCE_FROM_FSCX: 80, BOUNCE_FROM_FSCY: 140,   // drop start (tall+thin)
  BOUNCE_HIT_FSCX: 120, BOUNCE_HIT_FSCY: 70,    // impact (wide+short)
};
// Linear lerp between two #rrggbb hex colours → "rgb(r,g,b)".
function lerpHex(c1, c2, f) {
  const h = (s) => [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16)];
  const a = h(c1), b = h(c2);
  const r = Math.round(a[0] + (b[0]-a[0]) * f);
  const g = Math.round(a[1] + (b[1]-a[1]) * f);
  const bl= Math.round(a[2] + (b[2]-a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

const nav = [
  ['home', 'Главная'],
  ['unique', 'Уникализация'],
  ['format', 'Формат и экспорт'],
  ['transcribe', 'Распознавание речи'],
  ['editor', 'Редактирование'],
];

const formats = [
  { id: 'original', title: 'Без изменения', desc: 'Оригинальный размер', size: 'original', preset: 'original' },
  { id: 'reels', title: 'Reels / Shorts', desc: 'Вертикальный формат', size: '1080x1920', preset: 'vertical' },
  { id: 'instagram', title: 'Instagram Post', desc: 'Пост 4:5', size: '1080x1350', preset: 'post' },
  { id: 'square', title: 'Квадрат', desc: 'Пост 1:1', size: '1080x1080', preset: 'square' },
  { id: 'facebook', title: 'Facebook Pack', desc: '3 размера на выходе', size: 'FB x3', preset: 'fb' },
  { id: 'custom', title: 'Свой размер', desc: 'Ввести вручную', size: 'custom', preset: 'custom' },
];

const uniquePresets = [
  { id: 'light', title: 'Light', desc: 'Лёгкая обработка', details: 'Метаданные, лёгкий цвет, минимальный шум и мягкий микрозум.' },
  { id: 'medium', title: 'Medium', desc: 'Средняя обработка', details: 'Больше визуальных изменений: цвет, микрозум, умеренный шум.' },
  { id: 'strong', title: 'Strong', desc: 'Сильная обработка', details: 'Максимальная уникализация: заметнее шум, цвет и движение кадра.' },
  { id: 'manual', title: 'Manual', desc: 'Свои настройки', details: 'Ручная тонкая настройка всех параметров.' },
];

const sizeOptions = ['1080x1920', '1080x1350', '1080x1080', '720x1280', '1920x1080'];
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
const fileName = (p) => String(p || '').split(/[\\/]/).pop();
const compactName = (p, max = 22) => { const n = fileName(p); if (n.length <= max) return n; const ext = n.includes('.') ? '.' + n.split('.').pop() : ''; const keep = Math.max(8, max - ext.length - 3); return n.slice(0, keep) + '...' + ext; };
const fileUrl = (p) => (p ? `file:///${String(p).replace(/\\/g, '/')}` : '');
// Deterministic CSS family id tied to the physical font file so the preview
// renders with the exact same file FFmpeg uses (guarantees font match).
const fontIdFor = (fontFile) => fontFile ? 'smf_' + String(fontFile).replace(/[^a-z0-9]/gi, '_').toLowerCase() : '';
const fontCss = (layer) => { const id = fontIdFor(layer && layer.fontFile); return id ? `"${id}", Arial, sans-serif` : 'Arial, sans-serif'; };

function useSmoothNumber(target, opts = {}) {
  const { speed = 0.035, snap = 0.003 } = opts;
  const [value, setValue] = useState(Number(target) || 0);
  const targetRef = useRef(Number(target) || 0);
  const valueRef = useRef(Number(target) || 0);
  const lastRef = useRef(0);

  useEffect(() => {
    targetRef.current = Number(target) || 0;
  }, [target]);

  useEffect(() => {
    let raf = 0;
    const tick = (ts) => {
      const last = lastRef.current || ts;
      const dt = Math.min(48, Math.max(8, ts - last));
      lastRef.current = ts;
      const current = valueRef.current;
      const targetValue = targetRef.current;
      const diff = targetValue - current;
      const frameSpeed = 1 - Math.pow(1 - speed, dt / 16.67);
      let next = current + diff * frameSpeed;
      if (Math.abs(diff) < snap) next = targetValue;
      valueRef.current = next;
      setValue(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed, snap]);

  return value;
}

const formatAspect = (settings) => {
  if (settings?.useCustomSize) {
    const w = Math.max(1, Number(settings.customWidth || 1080));
    const h = Math.max(1, Number(settings.customHeight || 1920));
    return `${w} / ${h}`;
  }
  if (settings?.format === 'instagram') return '1080 / 1350';
  if (settings?.format === 'square' || settings?.format === 'facebook') return '1 / 1';
  if (settings?.format === 'original') return '9 / 16';
  return '1080 / 1920';
};

function App() {
  const [active, setActive] = useState('home');
  const [files, setFiles] = useState([]);
  const [outputDir, setOutputDir] = useState('');
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Editor-only: collapse the left sidebar so the canvas/timeline gets the
  // full window width. CSS transitions the grid-template-columns smoothly.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('strata_theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('strata_theme', theme); } catch {}
    // Persist to disk too, so the startup splash window can match the theme.
    try { window.strata?.saveTheme?.(theme); } catch {}
  }, [theme]);
  // Theme toggle with a quick circular reveal spreading from the toggle button.
  function toggleTheme(e) {
    const next = theme === 'light' ? 'dark' : 'light';
    const btn = e && e.currentTarget;
    if (!btn || typeof document.startViewTransition !== 'function') { setTheme(next); return; }
    const r = btn.getBoundingClientRect();
    document.documentElement.style.setProperty('--vt-x', (r.left + r.width / 2) + 'px');
    document.documentElement.style.setProperty('--vt-y', (r.top + r.height / 2) + 'px');
    document.startViewTransition(() => {
      document.documentElement.setAttribute('data-theme', next);
      setTheme(next);
    });
  }
  const [progress, setProgress] = useState({ running: false, total: 0, done: 0, percent: 0, currentPercent: 0, currentFile: '', stage: 'Ожидание запуска', eta: '—', speedText: '—' });
  const [settings, setSettings] = useState({
    format: 'reels', preset: 'light', size: '1080x1920', useCustomSize: false, customWidth: 1080, customHeight: 1920, fit: 'blur',
    speed: 98, copies: 1, outputSuffix: '_SM', microzoomEnabled: false, microzoom: 0, noiseEnabled: false, noise: 0,
    brightness: 0, contrast: 103, saturation: 104, sharpness: 15,
    textWatermarkEnabled: false, watermarkText: '', watermarkPosition: 'bottom-right', watermarkSize: 40, watermarkOpacity: 85, watermarkColor: '#ffffff',
    textLayers: [{ id: 1, text: '', align: 'center', color: '#ffffff', opacity: 85, size: 40, angle: 0, box: true, x: 50, y: 50 }], activeLayerId: 1,
    imageWatermarkEnabled: false, imageWatermarkPath: '', imageWatermarkPosition: 'bottom-right', imageWatermarkSize: 18, imageWatermarkOpacity: 75, watermarkX: null, watermarkY: null, imageWatermarkX: null, imageWatermarkY: null,
    quality: 20, encodePreset: 'balance', targetMb: 0, outputSizeMode: 'auto', openFolderAfter: true, checkFiles: true, sound: true, showLogOnError: true,
    exportMode: 'normal', customVideoBitrate: 0, customCrf: 23, customFps: 0, customAudioBitrate: 160,
    useGlobalFilename: false, globalFilename: '',
    trimEnabled: false, trimStart: 0, trimEnd: 0,
    watermarkAngle: 0, watermarkBox: true, watermarkAlign: 'center',
    weightMode: 'auto', processingProfile: 'balance', largeBatchMode: false, parallelJobs: 1, hardwareAccel: 'auto', backgroundMode: true, cleanupTemp: true, resumeMode: true, safeNames: true,
  });

  useEffect(() => {
    const off1 = window.strata?.onProgress?.((d) => setProgress((p) => ({ ...p, ...d })));
    const off2 = window.strata?.onLog?.((line) => setLogs((l) => [...l.slice(-150), line]));
    const off3 = window.strata?.onDone?.((d) => { setResult(d); if (!d.stopped && settings.sound) playDoneSound(); });
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [settings.sound]);

  const totalOutput = useMemo(() => files.length * Math.max(1, settings.copies) * (settings.format === 'facebook' ? 3 : 1), [files.length, settings.copies, settings.format]);
  const formatText = settings.format === 'facebook' ? 'FB x3' : settings.useCustomSize ? `${settings.customWidth}x${settings.customHeight}` : settings.size === 'original' ? 'Оригинал' : settings.size;
  const visibleFiles = queueOpen ? files : files.slice(0, 5);
  const update = (key, value) => setSettings((s) => ({ ...s, [key]: value }));
  const [fileNames, setFileNames] = useState({});
  const [editorState, setEditorState] = useState(EDITOR_DEFAULT);
  const dragIndex = useRef(null);
  // Listen for project files opened from the OS (double-click .smproj in
  // Explorer / Finder, or "Open with…"). When one arrives, switch to the
  // editor tab and replay the project state.
  useEffect(() => {
    if (!window.strata?.onProjectOpen) return;
    const off = window.strata.onProjectOpen((payload) => {
      if (!payload?.ok || !payload.data?.state) {
        if (payload && !payload.ok) alert('Не удалось открыть проект: ' + (payload.error || 'неизвестная ошибка'));
        return;
      }
      const s = payload.data.state;
      setEditorState({
        file: s.file ?? null,
        totalDuration: Number(s.totalDuration) || 10,
        videoStart: Number(s.videoStart) || 0,
        videoEnd: Number(s.videoEnd) || (Number(s.totalDuration) || 10),
        layers: Array.isArray(s.layers) ? s.layers : [],
        outWidth: Number(s.outWidth) || 1080,
        outHeight: Number(s.outHeight) || 1920,
        bgColor: s.bgColor || '#000000',
        fadeIn: Number(s.fadeIn) || 0,
        fadeOut: Number(s.fadeOut) || 0,
      });
      setActive('editor');
    });
    return () => { try { off?.(); } catch {} };
  }, []);
  function removeFileAt(index) {
    setFiles((list) => {
      const removed = list[index];
      setFileNames((n) => { const c = { ...n }; delete c[removed]; return c; });
      return list.filter((_, i) => i !== index);
    });
  }
  function moveFile(from, to) {
    if (from == null || to == null || from === to) return;
    setFiles((list) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function applyFormat(id) {
    const f = formats.find((x) => x.id === id);
    if (!f) return;
    setSettings((s) => ({ ...s, format: id, preset: f.preset === 'fb' ? 'fb' : (s.preset === 'fb' ? 'light' : s.preset), size: f.size === 'custom' ? s.size : f.size, useCustomSize: f.id === 'custom' }));
  }

  function applyUnique(id) {
    setSettings((s) => {
      const n = { ...s, preset: id };
      if (id === 'light') Object.assign(n, { speed: 98, microzoomEnabled: false, microzoom: 0, noiseEnabled: false, noise: 0, brightness: 0, contrast: 103, saturation: 104, sharpness: 15 });
      if (id === 'medium') Object.assign(n, { speed: 100, microzoomEnabled: true, microzoom: 2, noiseEnabled: true, noise: 3, brightness: 1, contrast: 107, saturation: 108, sharpness: 25 });
      if (id === 'strong') Object.assign(n, { speed: 106, microzoomEnabled: true, microzoom: 5, noiseEnabled: true, noise: 9, brightness: 2, contrast: 112, saturation: 116, sharpness: 40 });
      return n;
    });
  }

  async function chooseFiles() { const f = await window.strata.pickFiles(); if (f?.length) { setFiles(f); setActive('home'); } }
  async function chooseFolder() { const f = await window.strata.pickFolder(); if (f) setOutputDir(f); }
  async function chooseWatermark() { const f = await window.strata.pickImage(); if (f) { update('imageWatermarkPath', f); update('imageWatermarkEnabled', true); } }
  function onDrop(e) { e.preventDefault(); const paths = Array.from(e.dataTransfer.files || []).map((f) => window.strata.getPathForFile(f)).filter(Boolean); if (paths.length) setFiles(paths); }
  function clearFiles() { setFiles([]); setResult(null); }
  async function start(test = false) {
    if (!files.length) { setActive('home'); return; }
    setLogs([]); setResult(null);
    setProgress({ running: true, total: totalOutput, done: 0, percent: 0, currentPercent: 0, currentFile: '', stage: test ? 'Тест 10 секунд' : 'Подготовка файлов', eta: '—', speedText: '—' });
    const payloadSettings = { ...settings, preset: settings.format === 'facebook' ? 'fb' : settings.preset, previewTest: test };
    await window.strata.startProcessing({ files, outputDir, settings: payloadSettings, fileNames });
  }
  function stop() { window.strata.stopProcessing(); }

  return (
    <>
      <Titlebar theme={theme} onToggleTheme={toggleTheme} />
      <WindowProgressBorder progress={progress} />
      <div className={`app-shell${active === 'editor' && sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <aside className="sidebar">
          <div className="nav-list">{nav.map(([id, label]) => <button key={id} className={`nav ${active === id ? 'active' : ''}${id === 'editor' ? ' nav-editor' : ''}${id === 'transcribe' ? ' nav-transcribe' : ''}`} onClick={() => setActive(id)}>{label}</button>)}</div>
          {active !== 'editor' && active !== 'transcribe' && <Preview settings={settings} update={update} files={files} />}
          <div className="sidebar-bottom-actions">
            <button className="report-mini-btn" onClick={() => window.strata.openExternal('https://stratamixer.net/report/')} title="Сообщить об ошибке">Сообщить об ошибке</button>
            <div className="sidebar-mini-row">
              <button className="help-mini-btn" onClick={() => setHelpOpen(true)} title="Справка">Справка</button>
              <button className="donate-card compact-donate" onClick={() => setDonateOpen(true)} title="Поддержать проект">Donate</button>
              <button className="help-mini-btn site-mini-btn" onClick={() => window.strata.openExternal('https://stratamixer.net')} title="Открыть сайт">Сайт</button>
            </div>
          </div>
        </aside>
        {active === 'editor' && (
          <button className={`sidebar-toggle${sidebarCollapsed ? ' collapsed' : ''}`}
            onClick={() => setSidebarCollapsed(c => !c)}
            title={sidebarCollapsed ? 'Показать панель' : 'Скрыть панель'}
            aria-label={sidebarCollapsed ? 'Показать панель' : 'Скрыть панель'}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        <main className="main">
          <div className={`main-scroll${active === 'editor' ? ' editor-mode' : ''}`}>
            <CompactHeader active={active} files={files.length} formatText={formatText} totalOutput={totalOutput} settings={settings} />
            <div key={active} className="page-animate">
              {active === 'home' && <Home files={files} visibleFiles={visibleFiles} chooseFiles={chooseFiles} clearFiles={clearFiles} onDrop={onDrop} queueOpen={queueOpen} setQueueOpen={setQueueOpen} settings={settings} update={update} outputDir={outputDir} chooseFolder={chooseFolder} totalOutput={totalOutput} removeFileAt={removeFileAt} moveFile={moveFile} dragIndex={dragIndex} fileNames={fileNames} setFileNames={setFileNames} />}
              {active === 'editor' && <Editor state={editorState} setState={setEditorState} />}
              {active === 'transcribe' && <TranscribeView />}
              {active === 'format' && (
                <Format settings={settings} applyFormat={applyFormat} update={update}>
                  <Settings settings={settings} update={update} outputDir={outputDir} chooseFolder={chooseFolder} logs={logs} embedded />
                </Format>
              )}
              {active === 'unique' && (
                <Unique settings={settings} update={update} applyUnique={applyUnique}>
                  <Watermark settings={settings} update={update} chooseWatermark={chooseWatermark} embedded />
                </Unique>
              )}
            </div>
          </div>
          {active !== 'editor' && active !== 'transcribe' && <BottomProgress progress={progress} result={result} openResults={() => setResult(result)} />}
          {active !== 'editor' && active !== 'transcribe' && (
            <div className="floating-actions">
              <div className="start-summary">
                <b>{files.length ? `Готово к запуску · видео: ${files.length} · копий: ${settings.copies} · выход: ${totalOutput}` : 'Видео не выбраны'}</b>
                <span>{outputDir || 'Папка: рядом с исходными видео / processed'}</span>
              </div>
              <button className="fab-start" onClick={() => start(false)} disabled={progress.running || !files.length}>Старт</button>
              <button className="fab-test" onClick={() => start(true)} disabled={progress.running || !files.length}>Тест 10 сек</button>
              <button className="fab-stop" onClick={stop} disabled={!progress.running}>Стоп</button>
            </div>
          )}
        </main>
      </div>
      {result && <ResultModal result={result} onClose={() => setResult(null)} />}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {donateOpen && <DonateModal onClose={() => setDonateOpen(false)} />}
      {progress.running && active !== 'editor' && <div className="batch-lock-overlay" aria-hidden="true" />}
    </>
  );
}

// ── Notification center (bell) ───────────────────────────────────────
const NOTIF_SEEN_KEY = 'strata_notif_seen_v1';
const NOTIF_MUTE_KEY = 'strata_notif_muted_v1';
// Public releases page — used as the "rollback" escape hatch in update
// toasts and the bell panel update card. Opens externally so the user can
// download an older .exe/.dmg directly.
const RELEASES_URL = 'https://github.com/genagenagena15-prog/strata-mixer-releases/releases';
const openReleases = () => { try { window.strata?.openExternal?.(RELEASES_URL); } catch {} };

function loadSeenIds() {
  try { return new Set(JSON.parse(localStorage.getItem(NOTIF_SEEN_KEY) || '[]')); }
  catch { return new Set(); }
}
function persistSeenIds(set) {
  try { localStorage.setItem(NOTIF_SEEN_KEY, JSON.stringify([...set].slice(-400))); } catch {}
}

// Notification chime synthesized via Web Audio — no asset file needed.
function playNotifChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [[784, 0], [1175, 0.13]].forEach(([freq, t]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(0.17, now + t + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.5);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + t); osc.stop(now + t + 0.55);
    });
    setTimeout(() => { try { ctx.close(); } catch {} }, 1400);
  } catch {}
}

const BellIcon = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>;

function NotificationBell() {
  const [notifs, setNotifs] = useState([]);
  const [update, setUpdate] = useState({ status: 'idle', version: null, percent: 0, error: null });
  // Whether the user has run a manual "check for updates" this session (so we
  // can show "you're on the latest version" only after an explicit check).
  const [checkedOnce, setCheckedOnce] = useState(false);
  // One-time centered popup that shows a fresh release's patch notes.
  const [centerModal, setCenterModal] = useState(null);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => loadSeenIds());
  const [toasts, setToasts] = useState([]);
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem(NOTIF_MUTE_KEY) === '1'; } catch { return false; } });

  const announcedRef = useRef(null);
  const firstLoadDoneRef = useRef(false);
  const updateAnnouncedRef = useRef('');
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  function spawnToast(toast) {
    const key = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
    setToasts((list) => [...list, { ...toast, key }].slice(-3));
    if (!mutedRef.current) playNotifChime();
    setTimeout(() => setToasts((list) => list.filter((t) => t.key !== key)), 8000);
  }
  function dismissToast(key) { setToasts((list) => list.filter((t) => t.key !== key)); }

  useEffect(() => {
    const api = window.strata?.notifications;
    if (!api) return;
    const apply = (list) => {
      const arr = Array.isArray(list) ? list : [];
      setNotifs(arr);
      // Toast any notification this user hasn't been shown before, on first
      // fetch or later. Persisted via localStorage so an old anonuncement
      // doesn't keep popping each launch — but a brand-new one (added after
      // an app update) gets one toast.
      const seenSet = loadSeenIds();
      const fresh = arr.filter((n) => !seenSet.has(n.id) && !announcedRef.current.has(n.id));
      if (!firstLoadDoneRef.current) {
        // Seed announcedRef with everything currently seen so subsequent
        // fetches don't re-toast.
        announcedRef.current = new Set([...seenSet, ...arr.map(n => n.id)]);
        if (arr.length > 0) firstLoadDoneRef.current = true;
      } else {
        fresh.forEach(n => announcedRef.current.add(n.id));
      }
      if (fresh.length) {
        // The one-time "what's new" popup is now a CENTERED modal showing the
        // release's patch notes (instead of a corner toast). Show the newest.
        const newest = [...fresh].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
        if (!mutedRef.current) playNotifChime();
        setCenterModal({ title: newest.title || 'Что нового', body: newest.body || '', version: newest.version, kind: 'info' });
      }
      // Mark them as seen so we never re-toast on next launch.
      if (fresh.length) {
        const next = new Set(seenSet);
        fresh.forEach(n => next.add(n.id));
        saveSeenIds(next);
        setSeen(next);
      }
    };
    api.get().then(apply).catch(() => {});
    return api.onData(apply);
  }, []);

  useEffect(() => {
    const api = window.strata?.update;
    if (!api) return;
    const apply = (st) => {
      const s = st || { status: 'idle' };
      setUpdate(s);
      if (s.status === 'downloaded' && s.version && updateAnnouncedRef.current !== s.version) {
        updateAnnouncedRef.current = s.version;
        spawnToast({ kind: 'update-ready', title: 'Обновление готово', body: `Версия ${s.version} загружена. Нажми «Обновить» или просто закрой программу — установится при следующем запуске.` });
      }
      // macOS: notify-only flow (DMG is unsigned → no auto-install).
      if (s.status === 'mac-available' && s.version && updateAnnouncedRef.current !== s.version) {
        updateAnnouncedRef.current = s.version;
        spawnToast({ kind: 'update-mac', title: 'Доступна новая версия', body: `Вышла v${s.version}. Нажми «Скачать» — DMG откроется из GitHub, потом перетащи приложение в Applications.` });
      }
    };
    api.getState().then(apply).catch(() => {});
    return api.onState(apply);
  }, []);

  useEffect(() => {
    // Pause the outside-click + Escape handlers while a centered modal is on
    // top — otherwise the same click that dismisses the modal also closes the
    // bell. Result: one click closes just the modal and the bell stays open.
    if (!open || centerModal) return;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, centerModal]);

  const updateUnread = (update.status === 'downloaded' || update.status === 'mac-available') && update.version && !seen.has('update:' + update.version);
  const unreadCount = notifs.filter((n) => !seen.has(n.id)).length + (updateUnread ? 1 : 0);

  function togglePanel() {
    setOpen((v) => {
      const next = !v;
      if (next) {
        const ns = new Set(seen);
        notifs.forEach((n) => ns.add(n.id));
        if ((update.status === 'downloaded' || update.status === 'mac-available') && update.version) ns.add('update:' + update.version);
        setSeen(ns);
        persistSeenIds(ns);
      }
      return next;
    });
  }
  function doInstall() { try { window.strata?.update?.install?.(); } catch {} }
  function toggleMute() {
    setMuted((m) => { const nm = !m; try { localStorage.setItem(NOTIF_MUTE_KEY, nm ? '1' : '0'); } catch {} return nm; });
  }
  // Manual "check for updates" from the persistent card. Triggers the main
  // process to poll GitHub; the bell's update state reacts via the onState
  // subscription further up.
  function doCheck() {
    setCheckedOnce(true);
    try { window.strata?.update?.check?.(); } catch {}
  }
  function closeCenterModal() {
    if (centerModal && centerModal.id) {
      const next = new Set(seen); next.add(centerModal.id);
      saveSeenIds(next); setSeen(next);
    }
    setCenterModal(null);
  }
  // Download + run the previous published version (real rollback), instead of
  // just opening the GitHub releases page. Main handles confirm + download.
  function doRollback() { try { window.strata?.update?.rollback?.(); } catch { openReleases(); } }
  // Render a patch-notes body string into lines, honouring **bold** and blank
  // lines as gaps.
  function renderNotesBody(body) {
    return String(body || '').split(/\r?\n/).map((line, i) => {
      const t = line.trim();
      if (!t) return <div key={i} className="umb-gap" />;
      const parts = t.split(/(\*\*[^*]+\*\*)/g).map((seg, j) =>
        /^\*\*[^*]+\*\*$/.test(seg) ? <strong key={j}>{seg.slice(2, -2)}</strong> : seg);
      return <div key={i} className="umb-line">{parts}</div>;
    });
  }

  // Newest first: sort by ISO date (YYYY-MM-DD) descending. Falls back to the
  // original order for entries that share a date or have none.
  const ordered = [...notifs]
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const d = String(b.n.date || '').localeCompare(String(a.n.date || ''));
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.n);
  const showEmpty = ordered.length === 0 && update.status !== 'downloaded' && update.status !== 'downloading' && update.status !== 'mac-available';

  return <>
    <button ref={btnRef} className={`notif-bell${unreadCount ? ' has-unread' : ''}${open ? ' open' : ''}`} onClick={togglePanel} title="Уведомления" aria-label="Уведомления">
      <BellIcon />
      {unreadCount > 0 && <span className="notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
    </button>
    {open && createPortal(
      <div className="notif-panel" ref={panelRef}>
        <div className="notif-panel-head">
          <span>Уведомления</span>
          <div className="notif-head-actions">
            <button className={`notif-mute${muted ? ' on' : ''}`} onClick={toggleMute} title={muted ? 'Включить звук' : 'Выключить звук'}>
              {muted
                ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>}
            </button>
            <button className="notif-close" onClick={() => setOpen(false)} aria-label="Закрыть">×</button>
          </div>
        </div>
        <div className="notif-panel-body">
          {(update.status === 'downloaded' || update.status === 'mac-available') ? (
            <div className="notif-update-card ready">
              <div className="nuc-title">{update.status === 'mac-available' ? 'Доступна новая версия' : 'Обновление готово'}{update.version ? ` · v${update.version}` : ''}</div>
              <div className="nuc-text">{update.status === 'mac-available'
                ? 'На Mac обновление ставится вручную: нажми «Скачать», установи DMG в Applications.'
                : 'Обновись сейчас или просто закрой программу — новая версия установится автоматически при следующем запуске.'}</div>
              <button className="nuc-btn" onClick={doInstall}>{update.status === 'mac-available' ? 'Скачать' : 'Обновить сейчас'}</button>
              <a className="nuc-rollback" onClick={(e) => { e.preventDefault(); doRollback(); }} href="#">Проблемы? Скачать предыдущую версию</a>
            </div>
          ) : (
            <div className="notif-update-card current">
              <div className="nuc-title">Текущая версия · {APP_VERSION}</div>
              {update.status === 'downloading' ? (
                <>
                  <div className="nuc-bar"><i style={{ width: `${Math.round(update.percent || 0)}%` }} /></div>
                  <div className="nuc-text">Загрузка обновления… {Math.round(update.percent || 0)}%</div>
                </>
              ) : (
                <div className="nuc-text">
                  {update.status === 'checking' ? 'Проверяем обновления…'
                    : update.status === 'error' ? 'Не удалось проверить. Попробуй позже.'
                    : checkedOnce ? 'У вас последняя версия ✓'
                    : 'Проверьте, есть ли новая версия.'}
                </div>
              )}
              {update.status !== 'downloading' && (
                <button className="nuc-btn ghost" onClick={doCheck} disabled={update.status === 'checking'}>
                  {update.status === 'checking' ? 'Проверяем…' : 'Проверить обновление'}
                </button>
              )}
              <a className="nuc-rollback" onClick={(e) => { e.preventDefault(); doRollback(); }} href="#">Скачать предыдущую версию</a>
            </div>
          )}
          {showEmpty && <div className="notif-empty">Пока нет уведомлений</div>}
          {ordered.map((n) => (
            <div key={n.id} className={`notif-item ${n.type === 'update' ? 'is-update' : 'is-info'}${seen.has(n.id) ? '' : ' fresh'}`}>
              <div className="notif-item-top">
                <span className="notif-item-title">{n.title || 'Сообщение'}</span>
                {n.date && <span className="notif-item-date">{n.date}</span>}
              </div>
              {n.body && <div className="notif-item-body">{n.body}</div>}
            </div>
          ))}
        </div>
      </div>, document.body)}
    {toasts.length > 0 && createPortal(
      <div className="notif-toasts">
        {toasts.map((t) => (
          <div key={t.key} className={`notif-toast ${t.kind}`} onClick={() => { togglePanel(); dismissToast(t.key); }}>
            <div className="nt-icon">
              {(t.kind === 'update-ready' || t.kind === 'update-mac')
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                : <BellIcon />}
            </div>
            <div className="nt-content">
              <div className="nt-title">{t.title}</div>
              {t.body && <div className="nt-body">{t.body}</div>}
              {t.kind === 'update-ready' && <button className="nt-btn" onClick={(e) => { e.stopPropagation(); doInstall(); }}>Обновить</button>}
              {t.kind === 'update-mac' && <button className="nt-btn" onClick={(e) => { e.stopPropagation(); doInstall(); }}>Скачать</button>}
              {(t.kind === 'update-ready' || t.kind === 'update-mac') && (
                <a className="nt-rollback" onClick={(e) => { e.stopPropagation(); e.preventDefault(); doRollback(); }} href="#">Проблемы? Скачать предыдущую версию</a>
              )}
            </div>
            <button className="nt-close" onClick={(e) => { e.stopPropagation(); dismissToast(t.key); }} aria-label="Скрыть">×</button>
          </div>
        ))}
      </div>, document.body)}
    {centerModal && createPortal(
      <div className="update-modal-overlay" onClick={closeCenterModal}>
        <div className="update-modal" onClick={(e) => e.stopPropagation()}>
          <button className="update-modal-x" onClick={closeCenterModal} aria-label="Закрыть">×</button>
          {centerModal.version && <div className="update-modal-badge">v{centerModal.version}</div>}
          <h2 className="update-modal-title">{centerModal.title}</h2>
          <div className="update-modal-body">{renderNotesBody(centerModal.body)}</div>
          <div className="update-modal-actions">
            {centerModal.kind === 'update-ready' && <button className="nuc-btn" onClick={() => { doInstall(); closeCenterModal(); }}>Обновить сейчас</button>}
            <button className="update-modal-ok" onClick={closeCenterModal}>Понятно</button>
          </div>
        </div>
      </div>, document.body)}
  </>;
}

// Platform detection: real app uses preload's process.platform; the browser
// preview can be forced with ?platform=mac / ?platform=win.
const IS_MAC = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('platform');
    if (q === 'mac') return true;
    if (q === 'win') return false;
    if (window.strata && window.strata.platform) return window.strata.platform === 'darwin';
  } catch {}
  return false;
})();

function Titlebar({ theme, onToggleTheme }) {
  const dark = theme !== 'light';
  const themeBtn = (
    <button className="theme-toggle" onClick={onToggleTheme} title={dark ? 'Светлая тема' : 'Тёмная тема'} aria-label="Сменить тему">
      {dark
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.4v2.4M12 19.2v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.4 12h2.4M19.2 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/></svg>
        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.9A9 9 0 1 1 11.1 3a7 7 0 0 0 9.9 9.9Z"/></svg>}
    </button>
  );
  if (IS_MAC) {
    return <div className="titlebar mac">
      <div className="title-left-mac">
        <div className="mac-traffic">
          <button className="mtl close" onClick={() => window.strata?.close?.()} title="Закрыть" aria-label="Закрыть" />
          <button className="mtl min" onClick={() => window.strata?.minimize?.()} title="Свернуть" aria-label="Свернуть" />
          <button className="mtl zoom" onClick={() => window.strata?.maximize?.()} title="Развернуть" aria-label="Развернуть" />
        </div>
        {themeBtn}
      </div>
      <div className="title-right-mac">
        <span className="version-badge">{APP_VERSION}</span>
        <NotificationBell />
        <img src={A.icon} />
        <span className="app-title">Strata Mixer</span>
      </div>
    </div>;
  }
  return <div className="titlebar"><div className="title-left"><img src={A.icon} /><span className="app-title">Strata Mixer</span><span className="version-badge">{APP_VERSION}</span><NotificationBell /></div><div className="title-actions">
    {themeBtn}
    <button onClick={() => window.strata.minimize()}>—</button><button onClick={() => window.strata.maximize()}>□</button><button className="close" onClick={() => window.strata.close()}>×</button></div></div>;
}

function WindowProgressBorder({ progress }) {
  const target = progress?.running ? clamp(progress.currentPercent ?? progress.filePercent ?? 0, 0, 100) : 0;
  const p = useSmoothNumber(target, { speed: 0.028, snap: 0.002 });
  if (!progress?.running && p < 0.2) return null;
  const side = (start) => `${clamp((p - start) / 25 * 100, 0, 100)}%`;
  return <div className="window-progress-border" aria-hidden="true">
    <i className="wpb-top" style={{ width: side(0) }} />
    <i className="wpb-right" style={{ height: side(25) }} />
    <i className="wpb-bottom" style={{ width: side(50) }} />
    <i className="wpb-left" style={{ height: side(75) }} />
  </div>;
}
// Standalone "speech → text" view (left-sidebar tab). Pick any video/audio
// file and read out what's spoken in it — same Groq Whisper backend as the
// auto-subtitles, but as a plain transcript with copy.
function TranscribeView() {
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState('auto');
  const [copied, setCopied] = useState(false);

  async function run(which) {
    const f = which || file;
    if (!f || busy) return;
    if (!window.strata?.transcribe?.file) { setErr('Движок распознавания недоступен — обнови программу.'); return; }
    setErr(''); setText(''); setCopied(false); setBusy(true); setProg({ phase: 'extract', percent: 0 });
    let off = null;
    try { off = window.strata.transcribe.onProgress(info => setProg(info)); } catch {}
    try {
      const res = await window.strata.transcribe.file({ file: f, language: lang });
      if (!res?.ok) { setErr(res?.error || 'Не удалось распознать речь'); setProg(null); return; }
      setText(res.fullText || '');
      setProg({ phase: 'done', percent: 100 });
      setTimeout(() => setProg(null), 600);
    } catch (e) { setErr(String(e?.message || e)); setProg(null); }
    finally { setBusy(false); if (off) try { off(); } catch {} }
  }
  async function pickAndRun() {
    if (busy) return;
    let f;
    try { f = await window.strata?.pickMedia?.(); } catch {}
    if (Array.isArray(f)) f = f[0];
    if (f && typeof f === 'object') f = f.path || f.file || '';
    if (!f) return;
    setFile(f);
    run(f);
  }
  function copy() { if (!text) return; try { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} }
  function onDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    if (busy) return;
    const f = Array.from(e.dataTransfer.files || []).map(x => window.strata?.getPathForFile?.(x)).filter(Boolean)[0];
    if (!f) return;
    setFile(f); run(f);
  }

  const phaseLabel = prog && (prog.phase === 'extract' ? 'Извлекаем звук…'
    : prog.phase === 'upload' ? 'Распознаём речь…'
    : prog.phase === 'pack' ? 'Почти готово…'
    : prog.phase === 'done' ? 'Готово' : 'Обработка…');

  return (
    <div className="tr-view">
      <div className="tr-card">
        <h2 className="tr-title">Распознавание речи</h2>
        <p className="tr-sub">Загрузи видео или аудио — определим, что в нём говорят, и покажем текст. Его можно скопировать.</p>

        <div className="tr-controls">
          <label className="tr-lang">
            <span>Язык речи</span>
            <select value={lang} onChange={e => setLang(e.target.value)} disabled={busy}>
              <option value="auto">Авто (определить)</option>
              <option value="ru">Русский</option>
              <option value="pt">Português</option>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="de">Deutsch</option>
              <option value="fr">Français</option>
              <option value="it">Italiano</option>
              <option value="uk">Українська</option>
            </select>
          </label>
          <button className="tr-load-btn" onClick={pickAndRun} disabled={busy}>
            {busy ? 'Распознаём…' : (text ? 'Другое видео' : '＋ Загрузить видео')}
          </button>
        </div>

        {file && <div className="tr-file" title={file}>📄 {fileName(file)}</div>}

        {busy && prog && (
          <div className="tr-prog">
            <div className="tr-prog-bar"><div className="tr-prog-fill" style={{ width: `${prog.percent || 0}%` }} /></div>
            <span className="tr-prog-label">{phaseLabel} {prog.percent != null ? `${prog.percent}%` : ''}</span>
          </div>
        )}

        {err && <div className="tr-error">⚠ {err}</div>}

        {text && !busy && (
          <>
            <textarea className="tr-text" readOnly value={text} spellCheck={false} />
            <div className="tr-acts">
              <button className="tr-copy" onClick={copy}>{copied ? '✓ Скопировано' : '📋 Копировать текст'}</button>
              <button className="tr-redo" onClick={() => run(file)} disabled={busy || !file}>↻ Распознать заново</button>
            </div>
          </>
        )}

        {!text && !busy && !err && (
          <section className="card wide upload-card tr-drop"
            onClick={pickAndRun}
            onDrop={onDrop}
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
            onDragLeave={e => e.currentTarget.classList.remove('drag-over')}>
            <img className="upload-bg" src={A.upload} alt="" aria-hidden="true" />
            <h2>Перетащи видео сюда</h2><p>или нажми, чтобы выбрать файл</p>
            <strong>Распознаем речь и покажем текст</strong>
          </section>
        )}
      </div>
    </div>
  );
}

// Editor hotkeys cheat-sheet. Each row has a tiny CSS-animated demo (no gif
// assets) that loops to show what the shortcut does.
function HotkeysOverlay({ onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const isMac = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const mod = isMac ? '⌘' : 'Ctrl';
  const rows = [
    { keys: ['Пробел'], title: 'Играть / пауза', desc: 'Запускает и останавливает предпросмотр', demo: 'play' },
    { keys: [mod, 'Z'], title: 'Отменить', desc: 'Откатывает последнее действие', demo: 'undo' },
    { keys: [mod, 'C'], title: 'Копировать', desc: 'Копирует выделенный слой или несколько выделенных слоёв', demo: 'copy' },
    { keys: [mod, 'V'], title: 'Вставить', desc: 'Вставляет копию отдельным новым слоем', demo: 'paste' },
    { keys: ['Delete'], title: 'Удалить', desc: 'Удаляет выделенный слой или несколько выделенных слоёв', demo: 'delete' },
    { keys: ['Shift', '+ тащить'], title: 'Ровное перемещение', desc: 'На превью объект едет строго по горизонтали или вертикали', demo: 'axis' },
    { keys: ['Shift', '+ тащить'], title: 'Прилипание к клипам', desc: 'На таймлайне клип примагничивается к началу и концу других — стык встык без зазоров', demo: 'snap' },
    { keys: ['Тащить', '↑ ↓'], title: 'Сменить дорожку', desc: 'Веди клип вверх/вниз — он прилипнет к другой дорожке', demo: 'reorder' },
    { keys: ['Shift / Ctrl', '+ клик'], title: 'Выделить несколько', desc: 'Shift — выделить диапазон слоёв, Ctrl — добавлять по одному; двигаются вместе', demo: 'multi' },
    { keys: ['Масштабирование'], title: 'Масштаб превью', desc: 'Нажми на лупу с процентами на превью и тяни вверх/вниз — приближай и отдаляй кадр', demo: 'zoom' },
  ];
  // A mini timeline track row that mirrors the real editor: dark label column
  // (clip name + a row of action dots) + a lane holding a coloured clip.
  const Clip = (cls = '') => (
    <span className={`hk-clip ${cls}`}><i className="hk-clip-strip" /><i className="hk-clip-lbl" /></span>
  );
  const Row = (laneChildren, cls = '') => (
    <span className={`hk-trow ${cls}`}>
      <span className="hk-lbl"><i /><i /></span>
      <span className="hk-lane">{laneChildren}</span>
    </span>
  );
  const Cursor = (cls = '') => <span className={`hk-cursor ${cls}`} aria-hidden="true" />;
  const Demo = ({ type }) => {
    switch (type) {
      case 'play':
        return (
          <div className="hk-scene hk-scene-play">
            <span className="hk-prev"><i className="hk-prev-sub" /></span>
            <span className="hk-pbbar"><i className="hk-pbplay" /><i className="hk-pbpause" /><span className="hk-pbtrack"><i className="hk-pbhead" /></span></span>
          </div>
        );
      case 'undo':
        return <div className="hk-scene">{Row(<>{Clip('hk-clip-undo')}</>)}<span className="hk-badge">↶</span></div>;
      case 'copy':
        return <div className="hk-scene">{Row(<>{Clip('hk-clip-sel')}{Clip('hk-clip-ghost')}</>)}<span className="hk-badge hk-badge-c">C</span></div>;
      case 'paste':
        return <div className="hk-scene hk-scene-2row">{Row(<>{Clip('hk-clip-pastein')}</>, 'hk-trow-a hk-trow-new')}{Row(<>{Clip()}</>, 'hk-trow-b')}<span className="hk-badge hk-badge-v">V</span></div>;
      case 'delete':
        return <div className="hk-scene">{Row(<>{Clip('hk-clip-sel hk-clip-del')}</>)}<span className="hk-badge hk-badge-x">✕</span></div>;
      case 'axis':
        return (
          <div className="hk-scene hk-scene-prev">
            <span className="hk-prev hk-prev-lg"><i className="hk-axis-guide" /><span className="hk-prev-box">Aa</span>{Cursor('hk-cursor-axis')}</span>
          </div>
        );
      case 'snap':
        return <div className="hk-scene">{Row(<>{Clip('hk-clip-snapmove')}{Clip('hk-clip-static')}<i className="hk-snapline" /></>)}</div>;
      case 'reorder':
        return <div className="hk-scene hk-scene-2row">{Row(<>{Clip('hk-clip-move')}</>, 'hk-trow-a')}{Row(null, 'hk-trow-b hk-trow-hl')}{Cursor('hk-cursor-reorder')}</div>;
      case 'multi':
        return <div className="hk-scene hk-scene-2row">{Row(<>{Clip('hk-clip-sel hk-clip-m1')}</>, 'hk-trow-a')}{Row(<>{Clip('hk-clip-sel hk-clip-m2')}</>, 'hk-trow-b')}{Cursor('hk-cursor-multi')}</div>;
      case 'zoom':
        return <div className="hk-scene hk-scene-prev"><span className="hk-prev hk-prev-lg hk-prev-clip"><span className="hk-zoom-subj" /><span className="hk-zoom-badge">🔍</span></span></div>;
      default: return null;
    }
  };
  return createPortal(
    <div className="hk-overlay" onClick={onClose}>
      <div className="hk-modal" onClick={e => e.stopPropagation()}>
        <div className="hk-head">
          <h2>Управление редактором</h2>
          <button className="hk-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        <div className="hk-grid">
          {rows.map((r, i) => (
            <div className="hk-row" key={i}>
              <div className="hk-demo" data-demo={r.demo}><Demo type={r.demo} /></div>
              <div className="hk-info">
                <div className="hk-keys">{r.keys.map((k, j) => <kbd key={j}>{k}</kbd>)}</div>
                <div className="hk-title">{r.title}</div>
                <div className="hk-desc">{r.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

function CompactHeader({ active, files, formatText, totalOutput, settings }) {
  const titles = { home: 'Главная', format: 'Формат и экспорт', unique: 'Уникализация и водяной знак', transcribe: 'Распознавание речи', editor: 'Редактирование' };
  // Editor tab gets a focused header: just the title + the project-level
  // action buttons. The info chips (видео / формат / копий / выход) only
  // make sense for the batch-uniqualization pipeline, not for the editor.
  if (active === 'editor') {
    const fire = (name) => () => window.dispatchEvent(new CustomEvent(name));
    return <div className="compact-header slim editor-header">
      <h1>{titles.editor}</h1>
      <div className="editor-header-actions">
        <button className="ed-file-btn" onClick={fire('strata:editor-open-project')} title="Открыть проект (Ctrl+O)">Открыть проект</button>
        <button className="ed-file-btn" onClick={fire('strata:editor-save-project')} title="Сохранить проект (Ctrl+S)">Сохранить проект</button>
        <button className="btn primary ed-header-save-btn" data-onb="save" onClick={fire('strata:editor-save')} title="Сохранить готовое видео">Сохранить</button>
      </div>
    </div>;
  }
  return <div className="compact-header slim"><h1>{titles[active] || 'Strata Mixer'}</h1><div className="compact-summary"><span>Видео: <b>{files}</b></span><span>Формат: <b>{formatText}</b></span><span>Копий: <b>{settings.copies}</b></span><span>Выход: <b>{totalOutput}</b></span></div></div>;
}

function QueueRow({ f, i, fileNames, setFileNames, settings, removeFileAt, moveFile, dragIndex, disabled }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const displayName = fileNames[f] || fileName(f);
  function startEdit(e) { if (disabled) return; e.stopPropagation(); setDraft(fileNames[f] || fileName(f).replace(/\.[^.]+$/, '')); setEditing(true); }
  function commitEdit(e) { e.stopPropagation(); const v = draft.trim(); if (v) setFileNames((n) => ({ ...n, [f]: v })); else { const c = { ...fileNames }; delete c[f]; setFileNames(c); } setEditing(false); }
  function onKeyDown(e) { if (e.key === 'Enter') commitEdit(e); if (e.key === 'Escape') setEditing(false); }
  return (
    <div className="queue-row sortable" title={f} draggable={!editing} onDragStart={(e)=>{ dragIndex.current=i; e.dataTransfer.effectAllowed='move'; }} onDragOver={(e)=>{ e.preventDefault(); e.currentTarget.classList.add('drag-over'); }} onDragLeave={(e)=>e.currentTarget.classList.remove('drag-over')} onDrop={(e)=>{ e.preventDefault(); e.currentTarget.classList.remove('drag-over'); moveFile(dragIndex.current, i); }}>
      <span className="queue-num">{i + 1}</span>
      {editing
        ? <input className="queue-name-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitEdit} onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()} />
        : <p className={`queue-filename ${disabled ? '' : 'queue-filename-editable'}`} title="Нажми чтобы переименовать" onClick={startEdit}>{compactName(displayName, 38)}</p>
      }
      <em>{settings.copies} коп.</em>
      <button className="trash-btn" title="Удалить из очереди" onClick={(e)=>{e.stopPropagation(); removeFileAt(i);}}>🗑</button>
    </div>
  );
}

function Home({ files, visibleFiles, chooseFiles, clearFiles, onDrop, queueOpen, setQueueOpen, settings, update, outputDir, chooseFolder, totalOutput, removeFileAt, moveFile, dragIndex, fileNames, setFileNames }) {
  const heavy = files.length > 10 && (settings.noiseEnabled || settings.microzoomEnabled || settings.textWatermarkEnabled || settings.imageWatermarkEnabled || settings.format === 'facebook');
  return <div className="home-clean">
    <section className="card wide upload-card" onDrop={onDrop} onDragOver={(e) => e.preventDefault()} onClick={chooseFiles}>
      <img className="upload-bg" src={A.upload} />
      <h2>Перетащи видео сюда</h2><p>или нажми, чтобы выбрать файлы</p>
      <strong>{files.length ? `Загружено: ${files.length} видео` : 'Файлы ещё не выбраны'}</strong>
      {files.length > 0 && <div className="queue" onClick={(e) => e.stopPropagation()}>
        {visibleFiles.map((f, i) => <QueueRow key={f} f={f} i={i} fileNames={fileNames} setFileNames={setFileNames} settings={settings} removeFileAt={removeFileAt} moveFile={moveFile} dragIndex={dragIndex} disabled={settings.useGlobalFilename} />)}
        {files.length > 5 && <button className="link-btn" onClick={() => setQueueOpen(!queueOpen)}>{queueOpen ? 'Свернуть' : `Показать все (${files.length})`}</button>}
        <button className="link-btn danger" onClick={clearFiles}>Очистить список</button>
      </div>}
    </section>
    <section className="card wide home-output-card">
      <div className="home-output-grid clean">
        <div className="home-copy-field">
          <span>Копий</span>
          <input className="no-spin" type="number" inputMode="numeric" min="1" max="50" value={settings.copies}
            style={{ width: `calc(${String(settings.copies || 1).length}ch + 38px)` }}
            onChange={(e) => update('copies', clamp(e.target.value, 1, 50))} />
        </div>
        <div className="home-name-field">
          <div className="field-head">
            <span>Имя файла <InfoHelp text={'Имя для сохранённых файлов. При нескольких копиях добавляется номер: name_1.mp4, name_2.mp4. Если пусто — используется исходное имя файла.'} /></span>
            <label className={settings.useGlobalFilename ? 'active' : ''}><input type="checkbox" checked={!!settings.useGlobalFilename} onChange={(e) => update('useGlobalFilename', e.target.checked)} />Применить ко всем</label>
          </div>
          <input type="text" value={settings.globalFilename || ''} disabled={!settings.useGlobalFilename} onChange={(e) => update('globalFilename', e.target.value)} placeholder="Имя для всех файлов..." className={settings.useGlobalFilename ? '' : 'field-disabled'} />
        </div>
        <div className="home-total-field">
          <span>Итого</span>
          <div className="home-total-box"><b>{totalOutput}</b></div>
        </div>
        <label className="field output-path"><span>Куда сохранить</span><div className="path-line"><input readOnly value={outputDir || 'Папка processed рядом с видео'} /><button onClick={chooseFolder}>Изменить</button></div></label>
      </div>
      {heavy && <div className="soft-warning">Обработка может занять больше времени: шум, микрозум, водяной знак или Facebook Pack создают больше работы. Facebook Pack делает 3 файла на каждое видео.</div>}
    </section>
  </div>;
}

function Format({ settings, applyFormat, update, children }) {
  return <section className="card page-card format-page">
    <div className="format-grid">
      {formats.map((f) => <button className={`format-card ${settings.format === f.id ? 'selected' : ''}`} key={f.id} onClick={() => applyFormat(f.id)}>
        <h3>{f.title}{f.id === 'facebook' && <InfoHelp text={'Facebook Pack создаёт 3 версии каждого видео: 1080×1080, 1080×1350 и 1080×1920. Это создаёт больше файлов и требует больше времени, но не обязательно увеличивает размер каждого файла.'} />}</h3>
        <p>{f.desc}</p><b>{f.size}</b>
      </button>)}
    </div>
    {settings.useCustomSize && <div className="custom-size-card"><h3>Свой размер</h3><div className="custom-fields"><label><span>Ширина</span><input type="number" value={settings.customWidth} onChange={(e) => update('customWidth', e.target.value)} /></label><label><span>Высота</span><input type="number" value={settings.customHeight} onChange={(e) => update('customHeight', e.target.value)} /></label></div><div className="quick-sizes">{sizeOptions.map((s) => <button key={s} onClick={() => { const [w,h]=s.split('x'); update('customWidth', Number(w)); update('customHeight', Number(h)); }}>{s}</button>)}</div></div>}
    <div className="fit-section"><h3>Как вписать видео <InfoHelp text={'Если итоговый размер отличается от исходного видео, нужно выбрать как поместить картинку в новый формат. Размытый фон — видео остаётся целиком, свободное место заполняется размытым фоном. Поля — видео целиком, свободное место заполняется тёмными полями. Заполнить кадр — видео заполняет весь размер, лишние края могут быть обрезаны.'} /></h3><p className="fit-note">Выбери, что делать со свободным местом при смене размера видео.</p><div className="seg"><button className={settings.fit === 'blur' ? 'selected' : ''} onClick={() => update('fit', 'blur')}>Размытый фон</button><button className={settings.fit === 'pad' ? 'selected' : ''} onClick={() => update('fit', 'pad')}>Поля</button><button className={settings.fit === 'crop' ? 'selected' : ''} onClick={() => update('fit', 'crop')}>Заполнить кадр</button></div></div>
    <div className="trim-section"><div className="trim-head"><Switch label={<>Обрезка роликов <InfoHelp text={'Применяется ко всем загруженным видео. Например, можно удалить 2 секунды в начале и 1 секунду в конце каждого ролика. Если видео слишком короткое, оно будет отмечено как Rejected.'} /></>} checked={settings.trimEnabled} onChange={(v) => update('trimEnabled', v)} /></div>{settings.trimEnabled && <div className="trim-fields"><label><span>Убрать в начале, сек</span><input type="number" min="0" step="0.1" value={settings.trimStart} onChange={(e)=>update('trimStart', e.target.value)} /></label><label><span>Убрать в конце, сек</span><input type="number" min="0" step="0.1" value={settings.trimEnd} onChange={(e)=>update('trimEnd', e.target.value)} /></label></div>}</div>
    {children}
  </section>;
}

function Unique({ settings, update, applyUnique, children }) {
  const details = settings.preset === 'manual';
  return <section className="card page-card compact-content unique-page">
    <div className="format-grid small unique-grid">{uniquePresets.map((p) => <button className={`format-card unique-card ${p.id === 'manual' ? 'manual-card' : ''} ${settings.preset === p.id ? 'selected' : ''}`} key={p.id} onClick={() => applyUnique(p.id)}>
      <h3>{p.title}</h3><p>{p.desc}</p><span className="card-explain">{p.details}</span>{p.id === 'manual' && <b>тонкая настройка</b>}
    </button>)}</div>
    <div className={`manual-panel reveal-panel ${details ? '' : 'locked-panel'}`}><h3>{details ? 'Детальные настройки' : 'Параметры выбранного пресета'}</h3><p className="hint tiny">{details ? 'Manual: значения можно менять вручную.' : 'В Light / Medium / Strong значения показаны для понимания, но заблокированы. Для изменения выбери Manual.'}</p><div className="detail-grid"><Slider disabled={!details} label="Скорость, %" value={settings.speed} min="50" max="150" onChange={(v) => update('speed', v)} /><Switch disabled={!details} label={<>Микрозум <InfoHelp text={'Микрозум добавляет лёгкое движение кадра, но требует пересчёта видео. На больших пачках может заметно замедлить обработку.'} /></>} checked={settings.microzoomEnabled} onChange={(v) => update('microzoomEnabled', v)} /><Slider disabled={!details} label="Сила микрозума" value={settings.microzoom} min="0" max="20" onChange={(v) => update('microzoom', v)} /><Switch disabled={!details} label={<>Шум <InfoHelp text={'Шум уникализирует картинку, но сильно увеличивает нагрузку на обработку и может увеличить вес файла. Для больших пачек лучше ставить небольшое значение.'} /></>} checked={settings.noiseEnabled} onChange={(v) => update('noiseEnabled', v)} /><Slider disabled={!details} label="Сила шума" value={settings.noise} min="0" max="30" onChange={(v) => update('noise', v)} /><Slider disabled={!details} label="Яркость" value={settings.brightness} min="-20" max="20" onChange={(v) => update('brightness', v)} /><Slider disabled={!details} label="Контраст" value={settings.contrast} min="50" max="160" onChange={(v) => update('contrast', v)} /><Slider disabled={!details} label="Насыщенность" value={settings.saturation} min="50" max="180" onChange={(v) => update('saturation', v)} /><Slider disabled={!details} label="Резкость" value={settings.sharpness} min="0" max="200" onChange={(v) => update('sharpness', v)} /></div></div>
    {children}
  </section>;
}

function Watermark({ settings, update, chooseWatermark, embedded }) {
  const wmTip = 'Водяной знак накладывается поверх каждого кадра. Картинка-водяной знак может обрабатываться дольше, чем обычный текст, особенно в больших пачках.';
  const layers = settings.textLayers || [];
  const activeId = settings.activeLayerId || (layers[0]?.id);
  const active = layers.find((l) => l.id === activeId) || layers[0];

  function updateLayer(id, key, val) {
    update('textLayers', layers.map((l) => l.id === id ? { ...l, [key]: val } : l));
  }
  function addLayer() {
    const newId = Date.now();
    update('textLayers', [...layers, { id: newId, text: '', align: 'center', color: '#ffffff', opacity: 85, size: 40, angle: 0, box: true, x: 50, y: 50 }]);
    update('activeLayerId', newId);
  }
  function removeLayer(id) {
    const next = layers.filter((l) => l.id !== id);
    update('textLayers', next);
    if (activeId === id) update('activeLayerId', next[0]?.id || null);
  }

  const body = <><p className="hint wm-hint-line">Позицию знака можно менять мышкой прямо на предпросмотре слева.</p><div className="wm-grid">
    <div className="wm-card">
      <Switch label={<>Текстовый водяной знак <InfoHelp text={wmTip} /></>} checked={settings.textWatermarkEnabled} onChange={(v) => update('textWatermarkEnabled', v)} />
      {settings.textWatermarkEnabled && <div className="wm-fields">
        <div className="wm-layers-row">
          {layers.map((l, i) => (
            <div key={l.id} className={`wm-layer-chip ${l.id === activeId ? 'active' : ''}`} onClick={() => update('activeLayerId', l.id)}>
              <span>{l.text ? l.text.slice(0, 10) : `Слой ${i + 1}`}</span>
              {layers.length > 1 && <button className="wm-layer-del" onClick={(e) => { e.stopPropagation(); removeLayer(l.id); }} title="Удалить слой">×</button>}
            </div>
          ))}
          <button className="wm-layer-add" onClick={addLayer} title="Добавить текстовый слой">＋</button>
        </div>
        {active && <>
          <label className="field"><span>Текст</span><input value={active.text} onChange={(e) => updateLayer(active.id, 'text', e.target.value)} placeholder="Введи текст..." /></label>
          <label className="field wm-color-row"><span>Цвет текста</span><input type="color" value={active.color || '#ffffff'} onChange={(e) => updateLayer(active.id, 'color', e.target.value)} /></label>
          <Slider label="Прозрачность, %" value={active.opacity} min="0" max="100" onChange={(v) => updateLayer(active.id, 'opacity', v)} />
          <Slider label="Размер шрифта, px" value={active.size} min="12" max="200" onChange={(v) => updateLayer(active.id, 'size', v)} />
          <Slider label="Поворот, °" value={active.angle} min="-45" max="45" onChange={(v) => updateLayer(active.id, 'angle', v)} />
          <Switch label="Подложка под текст" checked={active.box} onChange={(v) => updateLayer(active.id, 'box', v)} />
        </>}
      </div>}
    </div>
    <div className="wm-card"><Switch label={<>Графический водяной знак <InfoHelp text={wmTip} /></>} checked={settings.imageWatermarkEnabled} onChange={(v) => update('imageWatermarkEnabled', v)} />{settings.imageWatermarkEnabled && <div className="wm-fields"><button className="btn secondary" onClick={chooseWatermark}>Выбрать файл</button><p className="file-name">{settings.imageWatermarkPath ? fileName(settings.imageWatermarkPath) : 'Файл не выбран'}</p><Slider label="Размер" value={settings.imageWatermarkSize} min="5" max="60" onChange={(v) => update('imageWatermarkSize', v)} /><Slider label="Прозрачность" value={settings.imageWatermarkOpacity} min="0" max="100" onChange={(v) => update('imageWatermarkOpacity', v)} /></div>}</div>
  </div></>;
  if (embedded) return <div className="wm-embedded">{body}</div>;
  return <section className="card page-card watermark-page">{body}</section>;
}


function InfoHelp({ text }) { return <b className="info-help" onClick={(e)=>{e.preventDefault();e.stopPropagation();}} aria-label="Справка">?<i className="help-tip">{text}</i></b>; }
function ResultStatus({ type, reason }) {
  const ok = type === 'prepared';
  return <span className={`result-status ${ok ? 'prepared' : 'rejected'}`}>
    {ok ? <i /> : <em className="reject-triangle">!</em>}
    {ok ? 'Prepared' : 'Rejected'}
    {!ok && reason && <small className="reject-tip">{reason}</small>}
  </span>;
}
function Settings({ settings, update, outputDir, chooseFolder, embedded }) {
  const exportModes = [
    ['max', 'Максимальное'],
    ['normal', 'Обычное'],
    ['fast', 'Быстрое'],
    ['custom', 'Свои настройки'],
  ];
  const inner = <div className="settings-grid settings-embedded">
    <div className="settings-block"><h3>Куда сохранить</h3><label className="field"><span>Папка результата</span><div className="path-line"><input readOnly value={outputDir || 'Папка processed рядом с видео'} /><button onClick={chooseFolder}>Выбрать</button></div></label><Switch label="Открывать папку после завершения" checked={settings.openFolderAfter} onChange={(v) => update('openFolderAfter', v)} /><Switch label="Звук после завершения" checked={settings.sound} onChange={(v) => update('sound', v)} /></div>
    <div className="settings-block"><h3>Качество и вес</h3>
      <div className="quality-cards q4">{exportModes.map(([id,t])=>(
        <button key={id} className={settings.exportMode===id?'selected':''} onClick={()=>update('exportMode',id)}><b>{t}</b></button>
      ))}</div>
      {settings.exportMode==='custom' && (
        <div className="custom-export">
          <label className="field"><span>Битрейт видео, кбит/с (0 = по качеству)</span><input className="no-spin" type="number" min="0" max="100000" value={settings.customVideoBitrate||0} onChange={(e)=>update('customVideoBitrate', clamp(e.target.value,0,100000))} /></label>
          <label className="field"><span>Качество CRF (1–51, меньше = лучше)</span><input className="no-spin" type="number" min="1" max="51" value={settings.customCrf||23} onChange={(e)=>update('customCrf', clamp(e.target.value,1,51))} /></label>
          <label className="field"><span>Кадры в секунду (0 = как в исходнике)</span><input className="no-spin" type="number" min="0" max="120" value={settings.customFps||0} onChange={(e)=>update('customFps', clamp(e.target.value,0,120))} /></label>
          <label className="field"><span>Битрейт аудио, кбит/с</span><input className="no-spin" type="number" min="32" max="512" value={settings.customAudioBitrate||160} onChange={(e)=>update('customAudioBitrate', clamp(e.target.value,32,512))} /></label>
        </div>
      )}
    </div>
  </div>;
  if (embedded) return inner;
  return <section className="card page-card settings-page compact-content">{inner}</section>;
}
function Preview({ settings, update, files = [] }) {
  const stageRef = useRef(null);
  const filter = `brightness(${100 + Number(settings.brightness || 0)}%) contrast(${Number(settings.contrast || 100)}%) saturate(${Number(settings.saturation || 100)}%)`;
  const imgWmStyle = watermarkStyle(settings.imageWatermarkPosition, settings.imageWatermarkOpacity, settings.imageWatermarkSize, true, settings.imageWatermarkX, settings.imageWatermarkY);
  const activeNoise = Boolean(settings.noiseEnabled) && Number(settings.noise || 0) > 0;
  const activeMicrozoom = Boolean(settings.microzoomEnabled) && Number(settings.microzoom || 0) > 0;

  function startDrag(kind, e) {
    e.preventDefault(); e.stopPropagation();
    const move = (ev) => {
      const r = stageRef.current?.getBoundingClientRect(); if (!r) return;
      const x = Math.max(5, Math.min(95, ((ev.clientX - r.left) / r.width) * 100));
      const y = Math.max(5, Math.min(95, ((ev.clientY - r.top) / r.height) * 100));
      if (kind === 'text') { update('watermarkX', x); update('watermarkY', y); }
      if (kind === 'image') { update('imageWatermarkX', x); update('imageWatermarkY', y); }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); move(e);
  }

  function startResize(kind, e) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = kind === 'text' ? Number(settings.watermarkSize || 40) : Number(settings.imageWatermarkSize || 18);
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : -dy;
      if (kind === 'text') update('watermarkSize', Math.round(clamp(startSize + delta * 0.45, 16, 120)));
      if (kind === 'image') update('imageWatermarkSize', Math.round(clamp(startSize + delta * 0.12, 5, 80)));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  const firstVideo = files?.[0];
  const src = firstVideo ? fileUrl(firstVideo) : A.preview;
  const isVideo = Boolean(firstVideo);
  const zoom = activeMicrozoom ? 1 + Math.min(0.18, Number(settings.microzoom || 0) / 100) : 1;
  const media = (cls) => {
    if (isVideo) {
      return <video className={cls} src={src} style={{ filter, transform: `scale(${zoom})` }} muted loop playsInline preload="metadata" />;
    }
    return <img className={`${cls} preview-placeholder-icon`} src={src} alt="Добавь видео для предпросмотра" />;
  };

  const textLayers = settings.textWatermarkEnabled ? (settings.textLayers || []) : [];

  const renderStage = (aspect, label, attachRef = false) => (
    <div className="fb-preview-item"
      onMouseEnter={e => { if (isVideo) e.currentTarget.querySelectorAll('video').forEach(v => v.play().catch(() => {})); }}
      onMouseLeave={e => { if (isVideo) e.currentTarget.querySelectorAll('video').forEach(v => { v.pause(); v.currentTime = 0; }); }}>
      {label && <span className="fb-preview-label">{label}</span>}
      <div ref={attachRef ? stageRef : null} className={`preview-stage fit-${settings.fit || 'blur'} ${isVideo ? '' : 'empty-preview'}`} style={{ aspectRatio: aspect }}>
        {isVideo && settings.fit === 'blur' && media('preview-bg')}
        {media('preview-img')}
        {activeNoise && <div className="noise" style={{ opacity: clamp(settings.noise, 0, 30) / 120 }} />}
        {textLayers.map((l) => {
          if (!l.text) return null;
          const lStyle = watermarkStyle(null, l.opacity, l.size, false, l.x, l.y);
          const lTransform = `${lStyle.transform || ''} rotate(${Number(l.angle || 0)}deg)`;
          return <div key={l.id} className="wm-object wm-object-text" style={{...lStyle, transform: lTransform}}>
            <div className={`wm-text draggable ${l.box ? 'with-box' : 'no-box'}`}
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); const move = (ev) => { const r = stageRef.current?.getBoundingClientRect(); if (!r) return; const x=Math.max(5,Math.min(95,((ev.clientX-r.left)/r.width)*100)); const y=Math.max(5,Math.min(95,((ev.clientY-r.top)/r.height)*100)); update('textLayers', (settings.textLayers||[]).map((tl) => tl.id===l.id ? {...tl,x,y} : tl)); }; const up = () => { window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); }; window.addEventListener('pointermove',move); window.addEventListener('pointerup',up); move(e); }}
              style={{ textAlign: l.align || 'center', color: l.color || '#ffffff', fontSize: `${Math.max(12, l.size / 3)}px`, whiteSpace: 'pre' }}>
              {l.text}
            </div>
          </div>;
        })}
        {settings.imageWatermarkEnabled && settings.imageWatermarkPath && <div className="wm-object wm-object-image" style={imgWmStyle}><img className="wm-img draggable" onPointerDown={(e)=>startDrag('image',e)} src={fileUrl(settings.imageWatermarkPath)} /><ResizeHandles onResize={(e)=>startResize('image',e)} /></div>}
      </div>
    </div>
  );

  const isFacebook = settings.format === 'facebook';
  return <div className={`preview-card ${isFacebook ? 'preview-card-fb' : ''}${isVideo ? ' has-files' : ''}`}><h3>Предпросмотр</h3>
    {isFacebook ? <div className="fb-preview-grid">
      {renderStage('1 / 1', '1080×1080', true)}
      {renderStage('1080 / 1350', '1080×1350')}
      {renderStage('1080 / 1920', '1080×1920')}
    </div> : renderStage(isVideo ? formatAspect(settings) : '1 / 1', '', true)}
  </div>;
}

function ResizeHandles({ onResize }) {
  return <>{['nw','n','ne','e','se','s','sw','w'].map((p) => <i key={p} className={`resize-handle ${p}`} onPointerDown={onResize} />)}</>;
}
function watermarkStyle(position, opacity = 80, size = 20, image = false, customX = null, customY = null) {
  const s = { opacity: clamp(opacity, 0, 100) / 100 };
  if (customX != null && customY != null) { s.left = `${customX}%`; s.top = `${customY}%`; s.transform = 'translate(-50%, -50%)'; }
  else { const pad = 12; if (position?.includes('top')) s.top = pad; if (position?.includes('bottom')) s.bottom = pad; if (position?.includes('left')) s.left = pad; if (position?.includes('right')) s.right = pad; if (position === 'center') { s.left = '50%'; s.top = '50%'; s.transform = 'translate(-50%, -50%)'; } }
  if (image) s.height = `${Math.max(14, size * 1.7)}px`; else s.fontSize = `${Math.max(12, size / 3)}px`;
  return s;
}
function BottomProgress({ progress, result, openResults }) {
  const targetTotal = clamp(progress.percent, 0, 100);
  const targetCurrent = clamp(progress.currentPercent ?? progress.filePercent ?? 0, 0, 100);
  const totalPct = useSmoothNumber(progress.running ? targetTotal : (result ? 100 : 0), { speed: 0.032, snap: 0.002 });
  const currentPct = useSmoothNumber(progress.running ? targetCurrent : 0, { speed: 0.032, snap: 0.002 });
  const currentPctText = Math.round(currentPct);
  const totalPctText = Math.round(totalPct);
  if (!progress.running && !result) return null;
  const currentName = progress.currentFile ? compactName(progress.currentFile, 34) : '—';
  return <div className={`bottom-progress ${progress.running ? 'show' : 'done'}`}>
    <div className="progress-meta"><b>{progress.stage}</b><span>Обработано {progress.done || 0} из {progress.total || 0}</span></div>
    <div className="progress-bars"><div className="current-file-row"><span>Сейчас: <b title={progress.currentFile || ''}>{currentName}</b></span><em>Текущее видео: {currentPctText}%</em></div><div className="glowbar"><i style={{ width: `${totalPct}%` }} /></div></div>
    <strong>{totalPctText}%</strong>{result && <button onClick={openResults}>Результаты</button>}
  </div>;
}

function ResultModal({ result, onClose }) {
  const list = result.createdFiles || [];
  const failed = result.failedFiles || [];
  const text = [`Папка: ${result.outDir}`, 'Создано:', ...list, 'Не получилось:', ...failed.map((x) => `${x.output || x.input} — ${x.reason || 'ошибка'}`)].join('\n');
  return <div className="modal-back"><div className="result-modal"><h2>Готово</h2><p>Папка: <b>{result.outDir}</b></p><p>Создано: <b className="ok-text">{list.length}</b> · Не получилось: <b className="bad-text">{failed.length}</b></p><h3>Созданные файлы</h3><div className="modal-list">{list.length ? list.map((f) => <div className="result-row" key={f}><span title={fileName(f)}>{compactName(f, 28)}</span><ResultStatus type="prepared" /></div>) : <div>Нет созданных файлов</div>}</div>{failed.length > 0 && <><h3>Не получилось</h3><div className="modal-list failed-list">{failed.map((x, i) => <div className="result-row" key={i}><span title={`${x.output ? fileName(x.output) : fileName(x.input)} — ${x.reason || 'ошибка'}`}>{compactName(x.output || x.input, 28)} — {x.reason || 'ошибка'}</span><ResultStatus type="rejected" reason={x.reason || 'Ошибка обработки'} /></div>)}</div></>}<div className="modal-actions"><button onClick={() => window.strata.openFolder(result.outDir)}>Открыть папку</button><button onClick={() => navigator.clipboard?.writeText(text)}>Скопировать список</button><button onClick={onClose}>Закрыть</button></div></div></div>; }


function HelpModal({ onClose }) {
  const topics = [
    {
      title: 'Как начать',
      body: '1) Перетащи видео на Главную. 2) Выбери формат во вкладке Формат. 3) Настрой уникализацию или выбери пресет. 4) Укажи папку и нажми Старт.'
    },
    {
      title: 'Что такое Facebook Pack',
      body: 'Facebook Pack создаёт 3 версии каждого видео: 1080×1080, 1080×1350 и 1080×1920. Это увеличивает количество файлов и время обработки, но не означает, что каждый файл станет тяжелее.'
    },
    {
      title: 'Почему файл стал больше',
      body: 'Вес может вырасти из-за шума, микрозума, повышения качества, увеличения разрешения или повторного кодирования уже сильно сжатого видео. Для экономии веса выбери Экспорт → Экономить вес или Лимит MB.'
    },
    {
      title: 'Как ускорить обработку',
      body: 'Для больших пачек используй режим Большая пачка, качество Быстро или Баланс, меньше шума, меньше микрозума и 1–2 параллельных задачи. Facebook Pack делает 3 файла на каждое видео, поэтому идёт дольше.'
    },
    {
      title: 'Почему файл Rejected',
      body: 'Rejected означает, что итоговый файл не был создан или оказался пустым. Наведи мышкой на красный треугольник в окне результата, чтобы увидеть полную причину: короткое видео, нет доступа к папке, повреждённый файл или ошибка кодирования.'
    },
    {
      title: 'Preview и итоговое видео',
      body: 'Предпросмотр помогает заранее увидеть готовый результат: формат, режим вписывания, водяной знак, цвет, шум и микрозум. Если выбран Facebook Pack, в предпросмотре отображаются все 3 формата, которые будут созданы на выходе.'
    }
  ];
  return <div className="modal-back"><div className="help-modal">
    <div className="help-head"><div><h2>Справка Strata Mixer</h2><p>Короткие ответы по основным функциям программы.</p></div><button onClick={onClose}>×</button></div>
    <div className="help-list">
      {topics.map((t) => <div className="help-topic" key={t.title}><h3>{t.title}</h3><p>{t.body}</p></div>)}
    </div>
    <div className="modal-actions"><button onClick={onClose}>Закрыть</button></div>
  </div></div>;
}

function DonateModal({ onClose }) {
  const [copied, setCopied] = useState(false);
  const copyWallet = async () => {
    try {
      await navigator.clipboard?.writeText(DONATE_WALLET);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  return <div className="modal-back"><div className="donate-modal">
    <h2>Поддержать Strata Mixer</h2>
    <p className="hint">Если программа помогает экономить время, можно поддержать развитие проекта.</p>
    <div className="donate-body">
      <div className="qr-wrap"><img src={A.donateQr} alt="USDT TRC20 QR" /></div>
      <div className="wallet-box">
        <span className="donate-coin-label">USDT TRC20</span>
        <button className="wallet-value" onClick={copyWallet} title="Нажми, чтобы скопировать">{DONATE_WALLET}</button>
        <small>{copied ? 'Кошелёк скопирован' : 'Нажми на кошелёк, чтобы скопировать'}</small>
      </div>
    </div>
    <div className="donate-actions-row">
      <button className="donate-copy-btn" onClick={copyWallet}>Скопировать кошелёк</button>
      <button className="donate-close-btn" onClick={onClose}>Закрыть</button>
    </div>
  </div></div>;
}

// Slider with click-to-type value. Clicking the bold value swaps it for an
// inline number input so the user can punch in exact percents instead of
// wrestling the range thumb (which on small ranges jumps in coarse steps).
// Font dropdown with per-row preview: "Aa" rendered in that font followed by
// the family name in a neutral face. The native <select>/<option> can't render
// each option in its own font face reliably + can't mix font-families inside
// one row, so this is a custom popover.
function FontPicker({ value, fonts, onChange }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  const current = fonts.find(f => f.name === value);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  // Bundled fonts use the smf_<id> @font-face we registered on mount; system
  // fonts are referenced by the OS family name directly.
  const previewFamily = (f) => f.name.startsWith('★ ')
    ? fontCss({ fontFile: f.file })
    : `"${f.name.replace(/"/g, '')}", Arial, sans-serif`;
  const pickItem = (name) => { onChange(name); setOpen(false); };
  return (
    <div className="font-picker" ref={wrapRef}>
      <button type="button" className="font-picker-btn" onClick={() => setOpen(o => !o)}>
        <span className="font-picker-sample" style={current ? { fontFamily: previewFamily(current) } : undefined}>Aa</span>
        <span className="font-picker-name">{current ? current.name : 'По умолчанию'}</span>
        <span className="font-picker-chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="font-picker-list" role="listbox">
          <div className={`font-picker-item${!current ? ' active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); pickItem(''); }}>
            <span className="font-picker-sample">Aa</span>
            <span className="font-picker-name">По умолчанию</span>
          </div>
          {fonts.map(f => (
            <div key={f.file}
              className={`font-picker-item${f.name === value ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pickItem(f.name); }}>
              <span className="font-picker-sample" style={{ fontFamily: previewFamily(f) }}>Aa</span>
              <span className="font-picker-name">{f.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Slider({ label, value, min, max, onChange, disabled=false, step=1 }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onChange(Math.max(Number(min), Math.min(Number(max), Math.round(n))));
    setEditing(false);
  };
  return <label className={`slider ${disabled ? 'disabled' : ''}`} aria-disabled={disabled}>
    <span>{label}
      {editing
        ? <input className="slider-edit" type="number" min={min} max={max} value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(false); }} />
        : <b onClick={() => { if (!disabled) { setDraft(String(value)); setEditing(true); } }} title="Клик чтобы вписать значение">{value}</b>}
    </span>
    <input type="range" min={min} max={max} step={step} value={value}
      aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      onChange={(e) => { if (!disabled) onChange(Number(e.target.value)); }}
      onWheel={(e) => {
        if (disabled) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = Math.max(Number(min), Math.min(Number(max), Number(value) + dir * Number(step || 1)));
        if (next !== Number(value)) onChange(next);
      }} />
  </label>;
}
function Switch({ label, checked, onChange, disabled=false }) { return <label className={`switch ${disabled ? 'disabled' : ''}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span className="switch-toggle"/><div className="switch-label">{label}</div></label>; }
function playDoneSound() { try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); [523, 659, 784].forEach((f, i) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.value = f; o.type = 'sine'; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.11); g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + i * 0.11 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.11 + 0.23); o.start(ctx.currentTime + i * 0.11); o.stop(ctx.currentTime + i * 0.11 + 0.25); }); } catch {} }

const EDITOR_DEFAULT = {
  file: null,
  totalDuration: 10, videoStart: 0, videoEnd: 10,
  layers: [],
  outWidth: 1080, outHeight: 1920,
  bgColor: '#000000', fadeIn: 0, fadeOut: 0,
};

const CLIP_COLORS = ['#38bdf8', '#34d399', '#4ade80', '#a3e635', '#fbbf24', '#fb923c', '#f87171', '#f472b6', '#e879f9', '#a78bfa', '#818cf8', '#94a3b8'];

// Onboarding: a short overview (steps with `manual` — advanced with «Понял»)
// mixed with hands-on steps that auto-advance when the user does the action.
// The last step is closed with the «Все понял» button.
const ONBOARD_STEPS = [
  // — Знакомство —
  { t: 'Добавьте видео', d: 'Для начала добавьте видео — нажмите подсвеченную кнопку «＋ Импорт» или перетащите файл прямо в окно. Дальше осмотримся в редакторе.', sel: '[data-onb="import"]',
    done: c => c.layers.some(l => l.type === 'videoOverlay') },
  { t: 'Экран предпросмотра', d: 'Это экран предпросмотра — здесь видно, как выглядит ваш ролик со всеми слоями и эффектами.', sel: '[data-onb="preview"]', manual: true, clickAdvance: true },
  { t: 'Шкала времени', d: 'Внизу — шкала времени, тут живут все ваши слои. Кликните по видео-клипу, а затем потяните его за левый край внутрь, чтобы укоротить ролик.',
    sel: c => c.selectedId ? '[data-onb="clipstart"]' : '[data-onb="timeline"]', drag: true,
    done: c => c.layers.some(l => l.type === 'videoOverlay' && ((l.startTime || 0) > 0.05 || (l.endTime ?? c.totalDuration) < c.totalDuration - 0.05)) },
  { t: 'Эффекты и слои', d: 'Справа — две вкладки: «Свойства» (настройки выбранного слоя) и «Эффекты» (эффекты для видео и новые слои — текст, блюр, зум). Окей — теперь соберём ролик вместе!', sel: '[data-onb="tabs"]', manual: true, clickAdvance: true,
    done: c => c.edPropTab === 'effects' },
  // — Практика —
  { t: 'Откройте эффекты', d: 'Откройте подсвеченную вкладку «Эффекты».', sel: '[data-onb="effects"]', resetTab: true,
    done: c => c.edPropTab === 'effects' },
  { t: 'Добавьте текст', d: 'В блоке «Эффект-слои» нажмите подсвеченную кнопку «Текст» — на видео появится текстовый слой.', sel: '[data-onb="text"]', selAlt: '[data-onb="effects"]', openAcc: 'layers',
    done: c => c.layers.some(l => l.type === 'text') },
  { t: 'Впишите текст', d: 'Откройте вкладку «Свойства» и впишите свой текст в подсвеченное поле.', sel: '[data-onb="textinput"]', selAlt: '[data-onb="propstab"]', delay: 2000,
    done: c => c.layers.some(l => l.type === 'text' && (l.text || '').trim().length > 0) },
  { t: 'Разместите слой на превью', d: 'Перетащите текстовый слой прямо на превью туда, где он нужен, и за уголки рамки растяните его до нужного размера.', sel: '[data-onb="preview"]',
    done: c => c.layers.some(l => l.type === 'text' && ((l.x ?? 50) !== 50 || (l.y ?? 80) !== 80) && (l.size ?? 48) !== 48) },
  { t: 'Добавьте блюр', d: 'В блоке «Эффект-слои» нажмите подсвеченную кнопку «Блюр» — на видео появится размытая область.', sel: '[data-onb="blur"]', selAlt: '[data-onb="effects"]', openAcc: 'layers',
    done: c => c.layers.some(l => l.type === 'blur') },
  { t: 'Настройте блюр', d: 'Во вкладке «Свойства» задайте «Силу блюра», а на превью растяните рамку блюра за уголки до нужного размера и поставьте туда, где надо размыть.', sel: '[data-onb="preview"]',
    done: c => c.layers.some(l => l.type === 'blur' && ((l.strength ?? 15) !== 15 || (l.width ?? 50) !== 50 || (l.height ?? 30) !== 30 || (l.x ?? 25) !== 25 || (l.y ?? 25) !== 25)) },
  { t: 'Блюр на шкале времени', d: 'Перетащите клип блюра по шкале времени туда, где размытие должно появляться. А длительность меняйте, потянув клип за края: за левый или правый край — можно с обеих сторон.', sel: '[data-onb="timeline"]',
    done: c => c.layers.some(l => l.type === 'blur' && (l.startTime || 0) !== 0) },
  { t: 'Сохраните результат', d: 'Готово — вы освоили основы! Когда ролик собран, сохраните его подсвеченной кнопкой «Сохранить».', sel: '[data-onb="save"]' },
];

// Playful render-modal hints — one is picked at random for each render.
const RENDER_PHRASES = [
  'Кубик колдует над твоим видео',
  'Кубик полирует каждый пиксель',
  'Кубик договаривается с кодеком',
  'Кубик раскладывает кадры по полочкам',
  'Кубик жонглирует битами',
  'Кубик заряжает видео магией',
  'Кубик подкручивает контраст',
  'Кубик уговаривает рендер поторопиться',
  'Кубик собирает ролик по кусочкам',
  'Кубик дорисовывает последние кадры',
  'Кубик причёсывает пиксели',
  'Кубик варит видео на медленном огне',
  'Кубик добавляет щепотку вдохновения',
  'Кубик нажимает все нужные кнопки',
  'Кубик считает кадры на пальцах',
  'Кубик прогревает видеокарту',
  'Кубик шепчет кадрам, чтобы спешили',
  'Кубик заплетает дорожки в косичку',
  'Кубик красит видео в нужные цвета',
  'Кубик ловит сбежавшие пиксели',
  'Кубик сводит звук и картинку',
  'Кубик заворачивает ролик в красивую обёртку',
  'Кубик протирает линзу перед рендером',
  'Кубик настраивает резкость',
  'Кубик переписывает биты набело',
  'Кубик строит твой шедевр',
  'Кубик складывает слои стопочкой',
  'Кубик трудится не покладая граней',
  'Кубик гладит кадры утюжком',
  'Кубик заряжает батарейки рендера',
  'Кубик пакует видео в коробочку',
  'Кубик ищет потерянный кадр',
  'Кубик подметает лишние артефакты',
  'Кубик раздаёт пикселям задания',
  'Кубик дирижирует оркестром кадров',
  'Кубик доводит ролик до блеска',
  'Кубик сшивает кадры ниткой',
  'Кубик кормит кодек печеньками',
  'Кубик включает режим максимальной красоты',
  'Кубик считает до миллиона пикселей',
  'Кубик аккуратно склеивает сцены',
  'Кубик добавляет немного волшебства',
  'Кубик проверяет каждый кадр дважды',
  'Кубик крутит ручки настроек',
  'Кубик расставляет кадры по местам',
  'Кубик сжимает видео без потери красоты',
  'Кубик заваривает чай, пока рендерит',
  'Кубик подгоняет последние мегабайты',
  'Кубик рисует финальные штрихи',
  'Кубик отправляет кадры в печать',
  'Кубик настраивает машину времени для кадров',
  'Кубик собирает пиксели в кучку',
  'Кубик дрессирует кодек',
  'Кубик проявляет твоё видео, как фотоплёнку',
  'Кубик наводит лоск',
  'Кубик уплотняет ролик',
  'Кубик прокручивает кадры в голове',
  'Кубик подбирает идеальные цвета',
  'Кубик колдует тёмную магию рендера',
  'Кубик доедает последние кадры',
  'Кубик трамбует биты поплотнее',
  'Кубик начищает видео до блеска',
  'Кубик прогоняет видео через волшебный фильтр',
  'Кубик собирает мозаику из кадров',
  'Кубик завязывает бантик на ролике',
  'Кубик ускоряется как может',
  'Кубик переносит кадры на руках',
  'Кубик заряжает видео хорошим настроением',
  'Кубик чинит то, что не ломалось',
  'Кубик считает овечек между кадрами',
  'Кубик раскручивает катушку с плёнкой',
  'Кубик подбирает рифму к каждому кадру',
  'Кубик наряжает видео к выходу',
  'Кубик прогревает процессор объятиями',
  'Кубик ищет, где спрятался последний процент',
  'Кубик доплетает финальную сцену',
  'Кубик расставляет всё по своим граням',
  'Кубик добавляет блеска в каждый кадр',
  'Кубик аккуратно несёт твой ролик к финишу',
  'Кубик шлифует углы',
  'Кубик примеряет ролику новый формат',
  'Кубик собирает финальную версию',
  'Кубик складывает кадры в гармошку',
  'Кубик упрашивает прогресс-бар двигаться',
  'Кубик заговаривает зубы кодеку',
  'Кубик дописывает последние биты',
  'Кубик протягивает дорожку до конца',
  'Кубик доводит дело до точки',
  'Кубик красиво заканчивает работу',
  'Кубик включает турборежим',
  'Кубик ловит вдохновение для финала',
  'Кубик считает кадры, как звёзды',
  'Кубик готовит видео к премьере',
  'Кубик стряхивает пыль с пикселей',
  'Кубик доносит ролик до финиша',
  'Кубик завершает магический ритуал',
  'Кубик прихорашивает каждую сцену',
  'Кубик дорабатывает мелочи',
  'Кубик колдует и почти закончил',
  'Кубик вот-вот покажет результат',
  'Кубик проверяет алгоритмы модерации Facebook',
  'Кубик договаривается с модераторами Facebook',
  'Кубик уговаривает Facebook не банить это видео',
  'Кубик прячет ролик от строгих алгоритмов Facebook',
  'Кубик шепчет роботам Facebook, что всё чисто',
  'Кубик готовит видео к проверке Facebook',
  'Кубик обходит фильтры модерации Facebook',
  'Кубик сдаёт экзамен модерации Facebook',
  'Кубик убеждает Facebook, что ролик уникальный',
  'Кубик протаскивает видео мимо банхаммера Facebook',
  'Кубик заносит печеньки модераторам Facebook',
  'Кубик маскирует ролик от детекторов Facebook',
  'Кубик проходит фейс-контроль Facebook',
  'Кубик задабривает алгоритмы Facebook',
  'Кубик делает видео незаметным для модерации Facebook',
  'Кубик договаривается о мире с роботами Facebook',
  'Кубик проверяет, не сработает ли блокировка Facebook',
  'Кубик уводит ролик от глаз модераторов Facebook',
  'Кубик переодевает видео, чтобы Facebook не узнал',
  'Кубик ставит ролику штамп «одобрено Facebook»',
  'Кубик гипнотизирует алгоритмы Facebook',
  'Кубик объясняет Facebook, что это новый ролик',
  'Кубик усыпляет бдительность модерации Facebook',
  'Кубик чистит видео от меток, которые ловит Facebook',
  'Кубик договаривается, чтобы Facebook пропустил ролик',
  'Кубик прячет следы от антифрод-системы Facebook',
  'Кубик уговаривает Facebook дать ролику зелёный свет',
  'Кубик проводит видео через таможню Facebook',
  'Кубик делает ролик невидимым для бана Facebook',
  'Кубик жмёт руку модераторам Facebook',
];

function RenderHint() {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * RENDER_PHRASES.length));
  useEffect(() => {
    const iv = setInterval(() => {
      // Jump to a different random phrase every 4 seconds.
      setIdx(i => (i + 1 + Math.floor(Math.random() * (RENDER_PHRASES.length - 1))) % RENDER_PHRASES.length);
    }, 4000);
    return () => clearInterval(iv);
  }, []);
  return <div className="editor-save-modal-hint">{RENDER_PHRASES[idx]}<span className="render-dots" /></div>;
}

function VideoOverlayEl({ file, currentTime }) {
  const vRef = useRef(null);
  useEffect(() => {
    const v = vRef.current;
    if (!v) return;
    const t = Math.max(0, currentTime);
    if (Math.abs(v.currentTime - t) > 0.12) v.currentTime = t;
  }, [currentTime]);
  return <video ref={vRef} src={fileUrl(file)} muted playsInline preload="metadata" style={{ display:'block', width:'100%', pointerEvents:'none', userSelect:'none' }} />;
}

function Editor({ state, setState }) {
  const { file, totalDuration, videoStart, videoEnd, layers, outWidth, outHeight, bgColor, fadeIn, fadeOut } = state;
  const set = (key, val) => setState((s) => ({ ...s, [key]: typeof val === 'function' ? val(s[key]) : val }));

  const [systemFonts, setSystemFonts] = useState([]);
  useEffect(() => { window.strata?.listFonts?.().then(f => setSystemFonts(f || [])).catch(() => {}); }, []);

  // Load every text layer's font file into the browser under a deterministic
  // family id (fontIdFor). The preview then renders with the exact same physical
  // file FFmpeg uses, so preview and output fonts always match.
  const [fontRevision, setFontRevision] = useState(0);
  const loadedFontsRef = useRef(new Set());
  // Stable string of text-layer fontFiles — recomputed when layers change,
  // but only TRIGGERS the font-loader effect when the set of fontFiles
  // actually differs (drag/move/color tweaks no longer wake it up).
  // A layer's physical font file: text layers store it on the layer, subtitle
  // layers store it on `.style`. Both must be loaded so the canvas preview
  // measures and renders with the SAME face FFmpeg burns in.
  const layerFontFile = (l) => l.type === 'subtitles' ? (l.style?.fontFile || '') : (l.type === 'text' ? (l.fontFile || '') : '');
  const textFontKey = useMemo(
    () => layers.map(layerFontFile).filter(Boolean).sort().join('|'),
    [layers]
  );
  useEffect(() => {
    layers.forEach(layer => {
      const fontFile = layerFontFile(layer);
      if (!fontFile) return;
      const id = fontIdFor(fontFile);
      if (!id || loadedFontsRef.current.has(id)) return;
      loadedFontsRef.current.add(id);
      const url = `file:///${fontFile.replace(/\\/g, '/').replace(/^\/+/, '')}`;
      new FontFace(id, `url("${url}")`).load()
        .then(f => { document.fonts.add(f); setFontRevision(r => r + 1); })
        .catch(() => { loadedFontsRef.current.delete(id); });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textFontKey]);

  // Eagerly @font-face-register bundled fonts (★ prefix) so the picker dropdown
  // renders each row in its own face for preview. System fonts don't need this
  // — the OS already has them registered for CSS font-family lookup.
  useEffect(() => {
    if (!systemFonts.length) return;
    for (const f of systemFonts) {
      if (!f.name.startsWith('★ ')) continue;
      const id = fontIdFor(f.file);
      if (!id || loadedFontsRef.current.has(id)) continue;
      loadedFontsRef.current.add(id);
      const url = `file:///${f.file.replace(/\\/g, '/').replace(/^\/+/, '')}`;
      new FontFace(id, `url("${url}")`).load()
        .then(face => { document.fonts.add(face); setFontRevision(r => r + 1); })
        .catch(() => { loadedFontsRef.current.delete(id); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemFonts]);

  const [widthStr, setWidthStr] = useState(String(outWidth));
  const [heightStr, setHeightStr] = useState(String(outHeight));
  const dimWidthRef = useRef(null);
  const [dimFocused, setDimFocused] = useState(false);
  const SIZE_PRESETS = [['1080','1920'],['1080','1350'],['1080','1080'],['1920','1080']];
  const isCustomSize = !SIZE_PRESETS.some(([w,h]) => widthStr === w && heightStr === h);
  useEffect(() => { setWidthStr(String(outWidth)); }, [outWidth]);
  useEffect(() => { setHeightStr(String(outHeight)); }, [outHeight]);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [edPropTab, setEdPropTab] = useState('props');
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  // Collapsed by default so the subtitle panel isn't a wall of controls.
  const [subStyleOpen, setSubStyleOpen] = useState(false);
  // Lightweight in-app toast for soft errors / hints. Replaces native alert()
  // so notifications match the editor's look — dark card, orange accent.
  const [editorHint, setEditorHint] = useState(null);
  const editorHintTimerRef = useRef(null);
  function showEditorHint(text, kind = 'warn') {
    setEditorHint({ text, kind, key: Date.now() });
    if (editorHintTimerRef.current) clearTimeout(editorHintTimerRef.current);
    editorHintTimerRef.current = setTimeout(() => setEditorHint(null), 4000);
  }
  // When a subtitle layer becomes selected (timeline click / keyboard / etc),
  // force the side panel onto «Свойства» so the user always sees subtitle
  // controls. Otherwise switching from «Эффекты» → subtitle click leaves the
  // panel on Эффекты with no clue where to tune the subtitle.
  useEffect(() => {
    if (!selectedId) return;
    const sel = layers.find(l => l.id === selectedId);
    if (sel?.type === 'subtitles') setEdPropTab('props');
  }, [selectedId, layers]);
  // Which Effects section is currently expanded (accordion: only one at a time).
  // Defaults to null so all three start collapsed on tab open.
  const [effectsOpen, setEffectsOpen] = useState(null);
  const [saveFinishing, setSaveFinishing] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  // Subtitle generation: { phase: 'extract'|'upload'|'pack'|'done'|'error', percent, error? }
  // null when nothing is happening. When non-null, the progress modal renders.
  const [subProgress, setSubProgress] = useState(null);
  // Recognition language for auto-subtitles. 'auto' lets Whisper detect it
  // (handles Portuguese/Russian/English/… correctly); forcing the wrong one
  // makes the model hallucinate instead of transcribing.
  const [subLang, setSubLang] = useState('auto');
  const [saveFmt, setSaveFmt] = useState('mp4');
  const [saveQual, setSaveQual] = useState('max');
  const [saveCustom, setSaveCustom] = useState({ videoBitrate: 0, crf: 23, fps: 0, audioBitrate: 160 });
  const [durStr, setDurStr] = useState(String(totalDuration));
  const [colorMenu, setColorMenu] = useState(null);
  const [onboardStep, setOnboardStep] = useState(() => {
    try { return localStorage.getItem('strata_editor_onboard_v3') ? -1 : 0; } catch { return -1; }
  });
  const [onboardSkip, setOnboardSkip] = useState(false);
  const [onbRect, setOnbRect] = useState(null);
  // Dirty flag: true when the project has unsaved changes. Synced to the
  // main process so it can prompt to save on app quit and on update install.
  const [dirty, setDirty] = useState(false);
  // In-app save-prompt modal. null when hidden; { message, detail } when shown.
  // Main process requests it via 'project:save-prompt-request' IPC and waits
  // for the user's choice via the response handler below.
  const [savePromptState, setSavePromptState] = useState(null);
  useEffect(() => {
    if (!window.strata?.onSavePromptRequest) return;
    return window.strata.onSavePromptRequest((payload) => {
      setSavePromptState(payload || { message: 'Сохранить проект?', detail: '' });
    });
  }, []);
  const answerSavePrompt = (choice) => {
    setSavePromptState(null);
    try { window.strata?.savePromptResponse?.(choice); } catch {}
  };
  // Keyboard shortcuts when the modal is open: Esc = Cancel, Enter = Save.
  useEffect(() => {
    if (!savePromptState) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); answerSavePrompt('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); answerSavePrompt('save'); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePromptState]);
  // Set right before a state mutation that should NOT be counted as a user
  // edit (initial mount, project load). The next layers-effect tick reads
  // and clears it so dirty stays false.
  const suppressDirtyRef = useRef(true);
  useEffect(() => {
    if (suppressDirtyRef.current) { suppressDirtyRef.current = false; return; }
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers]);
  useEffect(() => { try { window.strata?.setDirty?.(dirty); } catch {} }, [dirty]);
  const [zoom, setZoom] = useState(1);
  // Compute a sensible initial preview height for the current window — on
  // small monitors a hard-coded 440 hid the timeline AND the resize handle,
  // so the user couldn't shrink it. Reserve room for titlebar, editor
  // header, toolbar, timeline tracks and the props panel below.
  const [previewH, setPreviewH] = useState(() => {
    const wh = (typeof window !== 'undefined') ? window.innerHeight : 900;
    // ≈ 38 titlebar + 48 header + 80 editor toolbar + 200 timeline + 32 padding
    return Math.max(180, Math.min(440, wh - 420));
  });
  // Preview zoom — driven by the +/-/reset buttons in the corner overlay.
  // 1.0 = fit-to-frame; clamped [0.3, 5.0]. CSS transform scales the canvas
  // visually without touching the canvas's internal resolution.
  const [previewZoom, setPreviewZoom] = useState(1);
  const [zoomScrubActive, setZoomScrubActive] = useState(false);
  // Timeline horizontal-zoom scrubber active flag (mirrors the preview's zoom
  // scrubber UX: hold + drag the value up/down, or wheel over it).
  const [tlZoomScrubActive, setTlZoomScrubActive] = useState(false);
  // Preview pan: when zoomed past 1×, the user can click-and-drag empty space
  // on the preview to pan around. Layer hit-area pointerDown handlers call
  // stopPropagation, so this only fires on empty preview clicks.
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const previewPanRef = useRef({ x: 0, y: 0 });
  useEffect(() => { previewPanRef.current = previewPan; }, [previewPan]);
  // Save-progress modal: driven by IPC events from the main-process bundler.
  // Two SEPARATE states — saveProgress (number 0..100) drives the VIDEO render
  // modal; projSaveProgress (object {phase,percent,...}) drives the PROJECT save
  // modal. They were merged before, and a non-zero render number would also
  // satisfy the project modal's truthy check → both modals shown simultaneously.
  const [saveProgress, setSaveProgress] = useState(null);
  const [projSaveProgress, setProjSaveProgress] = useState(null);
  useEffect(() => {
    if (!window.strata?.onSaveProgress) return;
    return window.strata.onSaveProgress((info) => {
      if (info?.phase === 'done') {
        setProjSaveProgress({ ...info, percent: 100 });
        setTimeout(() => setProjSaveProgress(null), 1100);
      } else {
        setProjSaveProgress(info);
      }
    });
  }, []);
  function formatBytes(b) {
    const n = Number(b) || 0;
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' МБ';
    if (n >= 1024) return Math.round(n / 1024) + ' КБ';
    return n + ' Б';
  }
  function resetPreviewZoom() { setPreviewZoom(1); setPreviewPan({ x: 0, y: 0 }); }
  function startPreviewPan(e) {
    // Always allowed (any zoom). Layer hit-area handlers call stopPropagation,
    // so this only fires on empty preview clicks — moving layers still works.
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startPanX = previewPanRef.current.x, startPanY = previewPanRef.current.y;
    const onMove = (ev) => setPreviewPan({ x: startPanX + (ev.clientX - startX), y: startPanY + (ev.clientY - startY) });
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  // If the window is resized smaller than the current previewH allows,
  // clamp it down so the timeline and resize handle stay visible.
  useEffect(() => {
    const onResize = () => {
      const wh = window.innerHeight;
      const maxAllowed = Math.max(180, wh - 380);
      setPreviewH(h => h > maxAllowed ? maxAllowed : h);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const videoRef = useRef(null);
  const timelineRef = useRef(null);
  const tlScrollRef = useRef(null);
  // Custom horizontal scrollbar shown ABOVE the tracks (under the toolbar) only
  // when the timeline is wider than the viewport — i.e. when zoomed in. Native
  // bottom scrollbar stays; this one is just easier to reach at the top.
  const [tlBar, setTlBar] = useState({ show: false, w: 100, l: 0 });
  const updateTlBar = () => {
    const el = tlScrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    if (scrollWidth <= clientWidth + 1) { setTlBar(b => (b.show ? { show: false, w: 100, l: 0 } : b)); return; }
    setTlBar({ show: true, w: (clientWidth / scrollWidth) * 100, l: (scrollLeft / scrollWidth) * 100 });
  };
  // Drag the thumb → scroll the timeline (the scroll event syncs the thumb back).
  const onTlBarThumbDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = tlScrollRef.current; if (!el) return;
    const track = e.currentTarget.parentElement;
    const trackW = track ? track.clientWidth : el.clientWidth;
    const startX = e.clientX;
    const startScroll = el.scrollLeft;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const next = startScroll + (dx / trackW) * el.scrollWidth;
      el.scrollLeft = Math.max(0, Math.min(maxScroll, next));
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  // Recompute the top scrollbar when the zoom changes (inner width = zoom×100%)
  // or the window resizes (viewport width changes). The onScroll handler keeps
  // it in sync during normal scrolling.
  useEffect(() => {
    const id = requestAnimationFrame(updateTlBar);
    window.addEventListener('resize', updateTlBar);
    return () => { cancelAnimationFrame(id); window.removeEventListener('resize', updateTlBar); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  const canvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  // Fullscreen preview: a second canvas painted by the same render loop, shown
  // in a fixed overlay that goes into real OS fullscreen for distraction-free
  // playback review.
  const fsCanvasRef = useRef(null);
  const fsOverlayRef = useRef(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  // "Buffered" ranges (YouTube-style): time spans that have actually PLAYED /
  // rendered since the last edit. Shown as a faint orange bar on the scrubber so
  // the user sees where the preview is already prepared. Reset on any edit.
  // (Becomes true instant-replay ranges once the frame-cache lands — Stage 2.)
  const [buffered, setBuffered] = useState([]);
  // HD-ready ranges (the 2nd, high-res proxy pass). Drawn brighter over the
  // faint low-res `buffered` so the user can SEE the quality upgrade land.
  const [bufferedHd, setBufferedHd] = useState([]);
  // Live HD render frontier {s,e} (striped) — shows the HD pass PROGRESSING,
  // distinct from the solid `bufferedHd` (= actually playable). Null when idle.
  const [bufferedHdLive, setBufferedHdLive] = useState(null);
  // ⏳ Preview-perf Phase 2: PLAY from the background proxy. When a rendered
  // proxy file already covers the playhead, a hidden <video> takes over the
  // picture+audio+clock so the canvas (the expensive recomposite) stops — frees
  // the main thread → no audio dropouts, buttery playback. Flips back to the
  // crisp full-res canvas instantly on pause/scrub/edit/buffer-gap.
  const [proxyPlay, setProxyPlay] = useState(false);
  // Diagnostic: what the preview is actually showing (canvas / proxy q0 / q1).
  const [proxyDbg, setProxyDbg] = useState('');
  const proxyDbgRef = useRef('');
  const videoOverlayRefs = useRef({});
  const videoRevRef = useRef(null);
  const audioLayerRefs = useRef({});
  // Parallel <audio> tags that play the audio track from each videoOverlay
  // layer. The video elements themselves stay muted (used for canvas frame
  // capture only), so we mirror them with audio-only HTML elements driven
  // by the same timeline sync logic.
  const videoAudioRefs = useRef({});
  // Preview volume via WebAudio: routes each <audio>/<video> through a gain
  // node so the slider can actually boost past 1.0 in the preview (the native
  // HTMLMediaElement.volume is clamped at 1.0). The gain node uses exactly
  // the same volumeCurve as the ffmpeg export, so what you hear in preview
  // is what's written to the file. WeakMap keys auto-clean when React
  // remounts an element (src change).
  const audioCtxRef = useRef(null);
  const gainNodesRef = useRef(new WeakMap());
  function getAudioCtx() {
    if (!audioCtxRef.current) {
      try { audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { audioCtxRef.current = null; }
    }
    return audioCtxRef.current;
  }
  function setBoostedVolume(el, percent) {
    if (!el) return;
    const gain = volumeCurve(percent);
    const ctx = getAudioCtx();
    if (!ctx) { el.volume = Math.max(0, Math.min(1, gain)); return; }
    let node = gainNodesRef.current.get(el);
    if (!node) {
      try {
        const source = ctx.createMediaElementSource(el);
        const g = ctx.createGain();
        source.connect(g);
        g.connect(ctx.destination);
        node = { source, gain: g };
        gainNodesRef.current.set(el, node);
      } catch {
        el.volume = Math.max(0, Math.min(1, gain));
        return;
      }
    }
    node.gain.gain.value = gain;
    el.volume = 1; // native volume must stay at 1 — gain node owns the level
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
  }
  const imgCacheRef = useRef(new Map());
  const renderFrameRef = useRef(null);
  const subtitleLayoutsRef = useRef(new Map());
  const rafRef = useRef(null);
  // Render-on-demand state: the canvas loop runs ONLY while playing or for a
  // short burst after a change, then stops — no constant idle/editing redraw.
  const renderUntilRef = useRef(0);
  const loopRunningRef = useRef(false);
  const playingRef = useRef(false);
  const drawScaleRef = useRef(1);   // current preview backing scale (1 = full / paused)
  // Background preview-proxy (YouTube-style buffer): a low-res render of the
  // whole timeline via the export pipeline. exportingRef pauses it during a real
  // export; token bumps on every edit to invalidate a stale render.
  const exportingRef = useRef(false);
  const proxyRunningRef = useRef(false);
  const proxyTokenRef = useRef(0);
  const proxyDoneTokenRef = useRef(-1);
  // Phase 2 — play-from-proxy. proxyFilesRef collects each FULLY-rendered proxy
  // segment as {appStart, appEnd, url, token} (a segment is only playable once
  // ffmpeg finished it — faststart writes the moov atom at the end). The hidden
  // <video> (proxyVideoRef) is slaved to the playhead; proxyPlayRef mirrors the
  // proxyPlay state for use inside RAF/effects without re-subscribing.
  const proxyVideoRef = useRef(null);     // inline preview proxy <video>
  const proxyVideoFsRef = useRef(null);   // fullscreen-overlay proxy <video>
  const proxyFilesRef = useRef([]);
  const proxyPlayRef = useRef(false);
  const proxyActiveUrlRef = useRef(null);
  const currentTimeRef = useRef(0);
  const previewFullscreenRef = useRef(false);
  const measureCanvasRef = useRef(null);
  const blurTmpRef = useRef(null);
  // Holds the full composite (base + overlays) captured at the first clipping
  // mask each frame, so every mask reveals it inside its shape (union of holes).
  const maskFullRef = useRef(null);
  const selAnchorRef = useRef(null);
  const layerDragRef = useRef(null);
  // Timestamp (ms) of the last clip drag that actually moved, so the click event
  // that fires right after pointerup doesn't reset a multi-selection. Using a
  // timestamp (not a bare flag) means a never-delivered click can't leave it
  // stuck and swallow a later legitimate click.
  const suppressRowClickRef = useRef(0);
  const videoFrameCacheRef = useRef(new Map());
  // Timeline thumbnail cache. Generated once per file via a hidden <video>
  // element + canvas at low resolution; reused for every clip-instance of
  // that file (e.g. when you split a clip, both halves share the same pool).
  // Map<filePath, { thumbs: [{t, url}], dur, loading }>.
  const thumbsCacheRef = useRef(new Map());
  const [thumbsRev, setThumbsRev] = useState(0);
  const clipboardRef = useRef(null);
  const zoomTmpRef = useRef(null);
  const [undoStack, setUndoStack] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => { setDurStr(String(totalDuration)); }, [totalDuration]);

  const dur = Math.max(0.1, totalDuration);
  const fmt = (s) => { if (!s && s !== 0) return '0:00.0'; const m = Math.floor(s / 60); const sec = Math.floor(s % 60); const ms = Math.floor((s % 1) * 10); return `${m}:${String(sec).padStart(2, '0')}.${ms}`; };
  const pct = (t) => `${Math.min(100, Math.max(0, (t / dur) * 100))}%`;

  function commitDuration() {
    const v = Math.max(0.1, parseFloat(durStr) || 0.1);
    setDurStr(String(v));
    setState((s) => ({ ...s, totalDuration: v, videoEnd: Math.min(s.videoEnd, v) }));
  }

  async function pickFile() {
    const f = await window.strata?.pickMedia?.();
    addMediaPaths(f);
  }
  function clearAll() {
    if (!layers.length) return;
    setConfirmClearOpen(true);
  }
  function doClearAll() {
    pushUndo();
    // Purge all per-layer caches before wiping state — otherwise the
    // bitmaps/canvas backing them stick around in memory until GC.
    try { videoFrameCacheRef.current.clear(); } catch {}
    try { imgCacheRef.current.clear(); } catch {}
    videoOverlayRefs.current = {};
    audioLayerRefs.current = {};
    setState((s) => ({ ...s, layers: [], file: null }));
    setSelectedId(null); setSelectedIds(new Set());
    setConfirmClearOpen(false);
  }
  function closeOnboard() {
    setOnboardStep(-1);
    // Only the «Больше не показывать» checkbox stops the tour from re-appearing
    // every time the editor is opened.
    if (onboardSkip) { try { localStorage.setItem('strata_editor_onboard_v3', '1'); } catch {} }
  }

  // Onboarding spotlight: continuously track the target element for the current
  // step so the overlay cuts a hole around it (highlight) and locks the rest.
  // A polling interval self-corrects through the page-entry animation and any
  // layout shifts; it only re-renders when the (rounded) rect actually changes.
  useEffect(() => {
    if (onboardStep < 0 || onboardStep >= ONBOARD_STEPS.length) { setOnbRect(null); return; }
    const step = ONBOARD_STEPS[onboardStep];
    // `sel` may be a plain selector or a function of the live editor context.
    const ctx = { selectedId, layers, edPropTab };
    const primary = typeof step.sel === 'function' ? step.sel(ctx) : step.sel;
    if (!primary && !step.selAlt) { setOnbRect(null); return; }
    let last = '';
    const measure = () => {
      // Prefer the real target; if it isn't on screen yet (wrong tab), fall
      // back to selAlt — the control the user must click first to reveal it.
      let el = primary ? document.querySelector(primary) : null;
      if (!el && step.selAlt) el = document.querySelector(step.selAlt);
      let next = null;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) next = { x: r.left, y: r.top, w: r.width, h: r.height };
      }
      const key = next ? `${next.x | 0},${next.y | 0},${next.w | 0},${next.h | 0}` : 'null';
      if (key !== last) { last = key; setOnbRect(next); }
    };
    measure();
    const iv = setInterval(measure, 200);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearInterval(iv);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [onboardStep, layers.length, edPropTab, selectedId]);

  // Onboarding: a step marked `resetTab` forces the properties panel back to
  // «Свойства» on entry; `openAcc` opens the named effects accordion so the
  // button it points at (e.g. «Текст»/«Блюр» inside «Эффект-слои») is actually
  // visible — otherwise the highlight lands on a collapsed, clipped button.
  useEffect(() => {
    if (onboardStep < 0 || onboardStep >= ONBOARD_STEPS.length) return;
    const step = ONBOARD_STEPS[onboardStep];
    if (step.resetTab) setEdPropTab('props');
    if (step.openAcc) { setEdPropTab('effects'); setEffectsOpen(step.openAcc); }
  }, [onboardStep]);

  // Onboarding auto-advance: when the user performs the action the current
  // step asks for, move to the next step automatically after a short beat.
  useEffect(() => {
    if (onboardStep < 0 || onboardStep >= ONBOARD_STEPS.length - 1) return;
    const step = ONBOARD_STEPS[onboardStep];
    if (!step.done || !step.done({ layers, edPropTab, totalDuration })) return;
    // Each change resets the timer — so e.g. the text step advances only once
    // the user has paused (step.delay), not on the first keystroke.
    const t = setTimeout(() => {
      setOnboardStep(s => (s === onboardStep ? s + 1 : s));
    }, step.delay || 450);
    return () => clearTimeout(t);
  }, [onboardStep, layers, edPropTab, totalDuration]);

  // Snapshot the FULL editor state so Ctrl+Z restores everything, not just
  // layers (also: duration, canvas size, bg, fade, video range, etc.).
  function pushUndo() {
    const json = JSON.stringify(state);
    // Skip if the top of the stack is already identical (avoid duplicate
    // entries when auto-snapshot races an explicit pushUndo).
    if (lastPushedJsonRef.current === json) return;
    setUndoStack(s => [...s.slice(-29), JSON.parse(json)]);
    lastPushedJsonRef.current = json;
  }

  // Layer types that benefit from a distinct palette color (clip-like
  // tracks). Effects/text already have semantic colors so they're skipped.
  const COLOR_CYCLED_TYPES = new Set(['videoOverlay', 'image', 'maskedVideo', 'audio']);
  function nextPaletteColor(currentLayers) {
    // Count existing layers with a clipColor from the palette so the new
    // one picks up the NEXT slot, cycling back to 0 when we wrap.
    const used = currentLayers.filter(l => COLOR_CYCLED_TYPES.has(l.type) && l.clipColor).length;
    return CLIP_COLORS[used % CLIP_COLORS.length];
  }
  const addLayer = (layer) => {
    pushUndo();
    set('layers', (l) => {
      // Auto-assign the next palette colour to media-like layers that
      // haven't been given an explicit clipColor yet.
      const lyr = (!layer.clipColor && COLOR_CYCLED_TYPES.has(layer.type))
        ? { ...layer, clipColor: nextPaletteColor(l) }
        : layer;
      return [...l, lyr];
    });
    setSelectedId(layer.id);
    setSelectedIds(new Set());
    setEdPropTab('props');
  };
  const delLayer = (id) => {
    pushUndo();
    if (id === '__mv__') {
      setState(s => ({ ...s, file: null, layers: s.layers.filter(x => x.id !== id) }));
      setSelectedId(null);
      return;
    }
    // Release cached bitmaps & DOM refs for the deleted layer so they don't
    // pile up across a long editing session (image canvases, decoded video
    // frames per layer-id, etc.).
    const removed = layers.find(l => l.id === id);
    if (removed) {
      try { videoFrameCacheRef.current.delete(id); } catch {}
      try { delete videoOverlayRefs.current[id]; } catch {}
      try { delete audioLayerRefs.current[id]; } catch {}
      // image cache is keyed by file path — only purge if no other layer
      // still references the same file.
      if (removed.file && removed.type === 'image') {
        const stillUsed = layers.some(l => l.id !== id && l.file === removed.file);
        if (!stillUsed) { try { imgCacheRef.current.delete(removed.file); } catch {} }
      }
    }
    set('layers', (l) => l.filter(x => x.id !== id));
    setSelectedId((s) => s === id ? null : s);
  };
  const delSelected = () => {
    const ids = selectedIds.size ? [...selectedIds] : (selectedId ? [selectedId] : []);
    if (!ids.length) return;
    pushUndo();
    setState((s) => ({ ...s, file: ids.includes('__mv__') ? null : s.file, layers: s.layers.filter((x) => !ids.includes(x.id)) }));
    setSelectedId(null); setSelectedIds(new Set());
  };
  const updLayer = (id, k, v) => set('layers', (l) => l.map(x => x.id === id ? { ...x, [k]: v } : x));
  const moveLayer = (id, dir) => { pushUndo(); set('layers', (l) => {
    const i = l.findIndex(x => x.id === id); if (i < 0) return l;
    const n = [...l]; const j = i + dir;
    if (j < 0 || j >= n.length) return n;
    [n[i], n[j]] = [n[j], n[i]]; return n;
  }); };
  const reorderLayer = (fromId, toId) => {
    if (fromId == null || fromId === toId) return;
    pushUndo();
    set('layers', (ls) => {
      const arr = [...ls];
      const fi = arr.findIndex(x => x.id === fromId);
      const ti = arr.findIndex(x => x.id === toId);
      if (fi < 0 || ti < 0) return ls;
      const [item] = arr.splice(fi, 1);
      arr.splice(ti, 0, item);
      return arr;
    });
  };
  const toggleVis = (id) => { pushUndo(); set('layers', (l) => l.map(x => x.id === id ? { ...x, hidden: !x.hidden } : x)); };
  // Speaker toggle — silences ONLY the layer's audio (preview + export), leaving
  // the picture untouched. Independent of `hidden` (the eye, visual-only).
  const toggleMute = (id) => { pushUndo(); set('layers', (l) => l.map(x => x.id === id ? { ...x, muted: !x.muted } : x)); };
  // Which layer types actually carry audio (so we only show the speaker on them).
  const LAYER_HAS_AUDIO = (t) => t === 'mainVideo' || t === 'videoOverlay' || t === 'maskedVideo' || t === 'audio';

  async function addImageOverlay() {
    const f = await window.strata?.pickImage?.();
    if (f) addLayer({ id: Date.now(), type: 'image', file: f, startTime: 0, endTime: dur, x: 50, y: 50, size: 100, opacity: 100, fitCover: true });
  }
  function addBlurRegion() {
    addLayer({ id: Date.now(), type: 'blur', startTime: 0, endTime: Math.min(3, dur), x: 25, y: 25, width: 50, height: 30, strength: 15 });
  }
  function addZoom() {
    addLayer({ id: uid(), type: 'zoom', startTime: 0, endTime: Math.min(2, dur), strength: 30 });
  }
  // Auto-find the nearest clip edge on the timeline so transitions snap to
  // the place where two clips meet. Falls back to the playhead if no clips.
  function nearestClipBoundary() {
    const edges = [];
    layers.forEach(l => {
      if (['videoOverlay','maskedVideo','mainVideo','audio','image'].includes(l.type)) {
        edges.push(l.startTime || 0);
        edges.push(l.endTime ?? dur);
      }
    });
    if (!edges.length) return currentTime;
    let best = edges[0], bestDist = Math.abs(currentTime - edges[0]);
    for (const b of edges) {
      const d = Math.abs(currentTime - b);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    return best;
  }
  // Map a 0-100 strength to the kind-specific visual params. Linearly
  // interpolates between the old low (s=0) and high (s=100) preset values.
  // - shake:   camera shake + white flash
  // - whippan: fast horizontal motion-blur sweep
  // - zoom:    quick zoom punch with blur (up to 3× scale)
  // - blur:    burst of gaussian blur that resolves
  function transitionParams(kind, strength) {
    const s = Math.max(0, Math.min(100, Number(strength) || 50)) / 100;
    if (kind === 'shake')   return { amp: 14 + (60 - 14) * s,     flash: 0.55 + (1.00 - 0.55) * s };
    if (kind === 'whippan') return { shift: 35 + (100 - 35) * s,  blur: 10 + (40 - 10) * s };
    if (kind === 'zoom')    return { scale: 1.5 + (3.0 - 1.5) * s, blur: 4 + (18 - 4) * s };
    if (kind === 'blur')    return { blur: 10 + (50 - 10) * s };
    if (kind === 'seamzoom') return {
      scale: 3 + (6 - 3) * s,         // max zoom 3× → 6×
      blur:  8 + (22 - 8) * s,        // gaussian blur sigma at peak
      rgb:   4 + (14 - 4) * s,        // chromatic aberration px at peak
      flash: 0.18 + (0.38 - 0.18) * s,// white flash alpha at peak
    };
    return {};
  }

  function addTransition(kind, strength = 50) {
    // Strength = 0-100 → visual intensity (amp / blur / shift / scale).
    // Duration is fixed at 0.4 s; the user stretches the clip on the
    // timeline independently — length = how long, slider = how strong.
    const k = kind || 'shake';
    const numStrength = Math.max(0, Math.min(100, Number(strength) || 50));
    const duration = 0.4;
    const params = transitionParams(k, numStrength);
    const cx = nearestClipBoundary();
    const half = duration / 2;
    const ls = Math.max(0, Math.min(dur - duration, cx - half));
    addLayer({
      id: uid(), type: 'transition', kind: k, strength: numStrength,
      startTime: ls, endTime: ls + duration,
      ...params,
    });
  }
  function addMaskRegion() {
    // Clipping mask: everything composed BELOW this layer is shown only inside
    // the mask shape; pixels outside become the background colour.
    // Default to a circle sized in PIXELS (equal w/h), not in % of the canvas —
    // otherwise a vertical (e.g. 1080×1920) project gets an oblong ellipse.
    const sizePx = Math.round(Math.min(outWidth, outHeight) * 0.5);
    const wPct = (sizePx / outWidth) * 100;
    const hPct = (sizePx / outHeight) * 100;
    addLayer({ id: uid(), type: 'mask', startTime: 0, endTime: dur, x: 50, y: 50, width: wPct, height: hPct, shape: 'circle', radius: 12 });
  }

  // Switching to circle/square should snap to equilateral pixel dimensions.
  // Rounded keeps whatever the user has tuned.
  function changeMaskShape(layerId, newShape) {
    if (newShape !== 'circle' && newShape !== 'square') {
      updLayer(layerId, 'shape', newShape);
      return;
    }
    set('layers', ls => ls.map(x => {
      if (x.id !== layerId) return x;
      const curWpx = (x.width / 100) * outWidth;
      const curHpx = (x.height / 100) * outHeight;
      const sizePx = Math.max(curWpx, curHpx);
      const wPct = clamp((sizePx / outWidth) * 100, 5, 300);
      const hPct = clamp((sizePx / outHeight) * 100, 5, 300);
      return { ...x, shape: newShape, width: wPct, height: hPct };
    }));
  }
  function applyMask(maskId) {
    // Find the closest videoOverlay BELOW the mask in stack order, convert it
    // into a maskedVideo carrying the mask's shape/bounds, then drop both the
    // mask and the source clip from the layer list.
    const maskIdx = layers.findIndex(l => l.id === maskId);
    if (maskIdx < 0) return;
    const mask = layers[maskIdx];
    let srcIdx = -1;
    for (let i = maskIdx - 1; i >= 0; i--) {
      if (layers[i].type === 'videoOverlay') { srcIdx = i; break; }
    }
    if (srcIdx < 0) { alert('Под маской нет видео-клипа. Поставь маску над видео и попробуй снова.'); return; }
    const src = layers[srcIdx];
    // Compute which region of the SOURCE video was under the mask at this
    // moment, so the cut-out shows exactly those pixels (not the centre).
    // Source-video pixels:
    const vidEl = videoOverlayRefs.current[src.id];
    if (!vidEl || !vidEl.videoWidth) {
      alert('Видео ещё не подгрузилось (возможно идёт перекодировка из HEVC). Подожди пару секунд и нажми Применить снова.');
      return;
    }
    const vAspect = src.aspect || (vidEl.videoWidth / vidEl.videoHeight);
    const sw = vidEl.videoWidth;
    const sh = vidEl.videoHeight;
    // Video bounds on canvas (matches getLayerPx for videoOverlay):
    const vwC = (src.size || 40) / 100 * outWidth;
    const vhC = vwC / vAspect;
    const vxC = (src.x / 100) * outWidth - vwC / 2;
    const vyC = (src.y / 100) * outHeight - vhC / 2;
    // Mask bounds on canvas:
    const mwC = (mask.width / 100) * outWidth;
    const mhC = (mask.height / 100) * outHeight;
    const mxC = (mask.x / 100) * outWidth - mwC / 2;
    const myC = (mask.y / 100) * outHeight - mhC / 2;
    // Mask region projected onto the source video's pixel space:
    const srcCrop = {
      x: ((mxC - vxC) / vwC) * sw,
      y: ((myC - vyC) / vhC) * sh,
      w: (mwC / vwC) * sw,
      h: (mhC / vhC) * sh,
    };
    pushUndo();
    const masked = {
      // Reuse the source clip's id so the underlying <video> element keeps its
      // current decoded frames — otherwise React mounts a fresh <video> tag
      // that needs ~200ms to load, and the user sees a blank cut-out in the
      // gap. Same id = same DOM element = instant frame after Apply.
      id: src.id,
      type: 'maskedVideo',
      file: src.file,
      startTime: src.startTime,
      endTime: src.endTime,
      srcStart: src.srcStart || 0,
      srcDuration: src.srcDuration,
      speed: src.speed,
      reversed: src.reversed,
      volume: src.volume ?? 100,
      ccB: src.ccB, ccC: src.ccC, ccS: src.ccS, ccH: src.ccH,
      // Cut-out geometry inherited from the mask:
      x: mask.x, y: mask.y, width: mask.width, height: mask.height,
      shape: mask.shape, radius: mask.radius || 0,
      // Which slice of the source video was under the mask at Apply time.
      // The cut-out keeps showing THESE pixels even after you drag it elsewhere.
      srcCrop,
    };
    set('layers', (ls) => ls
      .filter(l => l.id !== mask.id)
      .map(l => l.id === src.id ? masked : l));
    setSelectedId(masked.id);
    setSelectedIds(new Set());
  }
  function addTextOverlay() {
    const sysFont = systemFonts[0];
    addLayer({ id: Date.now(), type: 'text', text: '', color: '#ffffff', size: 48, opacity: 100, align: 'center', x: 50, y: 80, startTime: 0, endTime: dur, fontFamily: sysFont?.name || 'Arial', fontFile: sysFont?.file || '' });
  }

  // ── Auto-subtitles via Groq Whisper ────────────────────────────────────
  // Sends the project's full mixed audio to the cloud, gets back word-level
  // timestamps, packs them into ~7-word phrase segments, and drops a single
  // 'subtitles' layer on the timeline that spans the entire project.
  async function generateSubtitlesLayer() {
    if (subProgress) return;  // already running — modal is open
    if (!window.strata?.subtitles?.generate) {
      setSubProgress({ phase: 'error', error: 'Подключение к движку субтитров недоступно (обнови программу).' });
      return;
    }
    // Wire up progress listener BEFORE invoking so we don't miss the first ticks.
    let off = null;
    try {
      off = window.strata.subtitles.onProgress((info) => setSubProgress(info));
    } catch {}
    setSubProgress({ phase: 'extract', percent: 0 });
    try {
      const sysFont = systemFonts[0];
      // Send the exact payload the export pipeline needs — main.js then
      // reuses the same audio-mix logic to bake a 16kHz mono mp3 for Whisper.
      const res = await window.strata.subtitles.generate({
        file: state.file,
        videoStart: state.videoStart || 0,
        videoEnd: state.videoEnd || state.totalDuration || 0,
        totalDuration: state.totalDuration || 0,
        layers: state.layers || [],
        mainVideo: state.mainVideo || (state.layers || []).find(l => l.type === 'mainVideo') || null,
        baseAudio: state.baseAudio || null,
        language: subLang || 'auto',
      });
      if (!res?.ok) {
        setSubProgress({ phase: 'error', error: res?.error || 'Неизвестная ошибка распознавания' });
        return;
      }
      const segs = Array.isArray(res.segments) ? res.segments : [];
      if (segs.length === 0) {
        setSubProgress({ phase: 'error', error: 'В аудио не нашлось речи. Проверь что в проекте есть голос.' });
        return;
      }
      // Drop any previous subtitles layer — only one active set at a time
      // (the user can split/merge segments inside the editor, but adding a
      // second auto-set on top is just confusing).
      const existingSubId = (state.layers || []).find(l => l.type === 'subtitles')?.id;
      if (existingSubId) {
        set('layers', (ls) => ls.filter(l => l.id !== existingSubId));
      }
      // Initial box-area: measure the actual widest segment + line count at the
      // default fontSize so the orange resize frame on the preview HUGS the
      // text from the start, instead of always opening at 88 %×100 % of the
      // canvas (which made the frame look bigger than the subs themselves).
      // Padding: +6 % width and +2 % height per line so the frame breathes.
      const fsDefault = 56;
      const fontFam = sysFont?.name || 'Arial';
      const mc = measureCtx();
      mc.font = `${fsDefault}px "${fontFam}", Arial, sans-serif`;
      let maxTextW = 0, maxLines = 1;
      for (const s of segs) {
        const txt = String(s.text || '').trim();
        if (!txt) continue;
        const w = mc.measureText(txt).width;
        if (w > maxTextW) maxTextW = w;
        // A naive line estimate — if the segment text doesn't fit a single
        // line at boxW≈70 %, it'll wrap; bump line count so boxH still hugs.
        const wrapLimit = (state.outWidth || 1080) * 0.7;
        if (w > wrapLimit) maxLines = Math.max(maxLines, Math.ceil(w / wrapLimit));
      }
      const outW = state.outWidth || 1080;
      const outH = state.outHeight || 1920;
      const initBoxW = Math.max(20, Math.min(120, Math.round((maxTextW / outW) * 100) + 6));
      const initBoxH = Math.max(8,  Math.min(60,  Math.round((maxLines * fsDefault * 1.3 / outH) * 100) + 2));
      addLayer({
        id: 'sub_' + Date.now().toString(36),
        type: 'subtitles',
        startTime: 0,
        endTime: state.totalDuration || segs[segs.length - 1].endTime,
        segments: segs,
        style: {
          fontFamily: fontFam,
          fontFile: sysFont?.file || '',
          fontSize: fsDefault,
          anim: 'pop',
          color: '#ffffff',
          outlineColor: '#000000',
          highlightColor: '#ff9a1f',
          x: 50,
          y: 85,
          boxW: initBoxW,
          boxH: initBoxH,
        },
        clipColor: '#ff9a1f',
      });
      // Jump the playhead onto the first phrase so the user immediately SEES the
      // subtitles in the preview (otherwise they only show during speech and the
      // playhead may be parked in silence).
      const firstStart = Number(segs[0]?.startTime) || 0;
      setCurrentTime(Math.max(0, firstStart + 0.05));
      setSubProgress({ phase: 'done', percent: 100 });
      setTimeout(() => setSubProgress(null), 900);
    } catch (e) {
      setSubProgress({ phase: 'error', error: String(e?.message || e) });
    } finally {
      if (off) try { off(); } catch {}
    }
  }

  // Probe a media file for its real duration via a hidden DOM element.
  // Resolves with 0 on error so callers can fall back to the timeline default.
  function probeMediaDuration(file) {
    return new Promise((resolve) => {
      const isVideo = /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(file);
      const el = document.createElement(isVideo ? 'video' : 'audio');
      el.preload = 'metadata';
      el.muted = true;
      el.src = fileUrl(file);
      const cleanup = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onErr);
      };
      const onMeta = () => { cleanup(); resolve(Number(el.duration) || 0); };
      const onErr = () => { cleanup(); resolve(0); };
      el.addEventListener('loadedmetadata', onMeta, { once: true });
      el.addEventListener('error', onErr, { once: true });
      // Hard timeout — some files take forever to even read metadata.
      setTimeout(() => { cleanup(); resolve(0); }, 4000);
    });
  }
  async function addVideoOverlay() {
    const files = await window.strata?.pickFiles?.();
    const f = files?.[0];
    if (!f) return;
    const id = Date.now();
    // Use the file's real duration — if it's longer than the timeline, grow
    // the timeline to fit (otherwise the user would have to manually stretch
    // the clip from 0..10 → 0..15 every time).
    const probed = await probeMediaDuration(f);
    const dur0 = probed > 0.1 ? probed : dur;
    if (probed > totalDuration) set('totalDuration', probed);
    addLayer({ id, type: 'videoOverlay', file: f, startTime: 0, endTime: dur0, srcDuration: probed > 0 ? probed : undefined, x: 50, y: 50, size: 100 });
    ensureProxy(id, f);
  }
  async function addAudioFile() {
    const f = await window.strata?.pickAudio?.();
    if (!f) return;
    const probed = await probeMediaDuration(f);
    const dur0 = probed > 0.1 ? probed : dur;
    if (probed > totalDuration) set('totalDuration', probed);
    addLayer({ id: Date.now(), type: 'audio', file: f, startTime: 0, endTime: dur0, srcDuration: probed > 0 ? probed : undefined, volume: 100 });
  }

  const uid = () => 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // Silently make sure each video file has a Chromium-friendly preview source.
  // Probes first (fast); only re-encodes if HEVC/AV1/ProRes etc. Result is
  // cached by file path so reopening or duplicating the layer is instant.
  function ensureProxy(layerId, filePath) {
    if (!window.strata?.makeProxy || !filePath) return;
    window.strata.makeProxy({ file: filePath }).then(res => {
      if (res?.ok && res.proxyPath) {
        setState(s => ({ ...s, layers: s.layers.map(x =>
          x.id === layerId ? { ...x, _proxyFile: res.proxyPath } : x) }));
      }
    }).catch(() => {});
  }
  // Drag-and-drop any media into the editor: videos / images / audio land on
  // the timeline as layers. The first dropped video becomes the main video.
  async function addMediaPaths(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;

    // Pre-build skeletons keeping the original index so the user sees the
    // same order they dropped the files in.
    const skeletons = list.map(p => {
      const ext = (p.split('.').pop() || '').toLowerCase();
      if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(ext)) return { kind: 'video', path: p };
      if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) return { kind: 'image', path: p };
      if (['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'].includes(ext)) return { kind: 'audio', path: p };
      return null;
    }).filter(Boolean);
    if (!skeletons.length) return;

    // Probe all video/audio files in parallel — metadata-only, very fast.
    // Images have no duration; they'll inherit the (possibly expanded)
    // timeline length so they cover the whole project by default.
    const probed = await Promise.all(skeletons.map(s =>
      (s.kind === 'video' || s.kind === 'audio') ? probeMediaDuration(s.path) : Promise.resolve(0)
    ));
    const maxProbed = Math.max(0, ...probed);
    const newTotal = Math.max(totalDuration, maxProbed);

    const added = [];
    for (let i = 0; i < skeletons.length; i++) {
      const s = skeletons[i];
      const realDur = probed[i] > 0.1 ? probed[i] : newTotal;
      if (s.kind === 'video') {
        // Every imported video fills the project frame by default (size 100 =
        // full canvas width), just like the very first/main video — not a small
        // 40% picture-in-picture. The user resizes down if they want an overlay.
        added.push({ id: uid(), type: 'videoOverlay', file: s.path, startTime: 0, endTime: realDur, srcDuration: probed[i] || undefined, x: 50, y: 50, size: 100, fitCover: true });
      } else if (s.kind === 'image') {
        added.push({ id: uid(), type: 'image', file: s.path, startTime: 0, endTime: newTotal, x: 50, y: 50, size: 100, opacity: 100, fitCover: true });
      } else if (s.kind === 'audio') {
        added.push({ id: uid(), type: 'audio', file: s.path, startTime: 0, endTime: realDur, srcDuration: probed[i] || undefined, volume: 100 });
      }
    }
    if (!added.length) return;
    pushUndo();
    setState((s) => {
      // Expand the timeline if any new file is longer than the current
      // duration (so the user doesn't have to manually stretch).
      const expandedTotal = Math.max(s.totalDuration, newTotal);
      // Walk through the added layers and assign the next palette colour
      // to each clip-like type. Cycle through CLIP_COLORS in order.
      let used = s.layers.filter(l => COLOR_CYCLED_TYPES.has(l.type) && l.clipColor).length;
      const tinted = added.map(l => {
        if (!COLOR_CYCLED_TYPES.has(l.type) || l.clipColor) return l;
        const col = CLIP_COLORS[used % CLIP_COLORS.length];
        used += 1;
        return { ...l, clipColor: col };
      });
      return { ...s, totalDuration: expandedTotal, videoEnd: Math.max(s.videoEnd, expandedTotal), layers: [...s.layers, ...tinted] };
    });
    // Auto-select the freshly added layer.
    setSelectedId(added[added.length - 1].id);
    setSelectedIds(new Set());
    // Background: kick off proxy generation for any HEVC/AV1 videos so the
    // preview "just plays" without the user seeing codec errors.
    added.filter(l => l.type === 'videoOverlay').forEach(l => ensureProxy(l.id, l.file));
  }
  function onEditorDrop(e) {
    e.preventDefault();
    addMediaPaths(Array.from(e.dataTransfer?.files || []).map((f) => window.strata?.getPathForFile?.(f)));
  }

  // ── Project save / open (.smproj) ──────────────────────────────────────────
  // Pure JSON snapshot of the editor state with volatile fields stripped
  // (proxy paths, selection, "missing file" flags). Re-opening replays it
  // into setState and kicks off proxy regen for any HEVC/AV1 videos.
  // Internal save — returns the IPC result without UI feedback. Called both
  // from the user-facing saveProject() and from the save-on-quit/update
  // prompt initiated by the main process (which renders its own dialogs).
  async function doSaveProject() {
    if (!window.strata?.saveProject) return { ok: false, error: 'no IPC' };
    const cleanLayers = layers.map((l) => {
      const { _proxyFile, _proxyMaking, _missing, ...rest } = l || {};
      return rest;
    });
    const proj = {
      version: 1,
      app: 'strata-mixer',
      savedAt: new Date().toISOString(),
      suggestedName: (fileName(layers.find(l => l.file)?.file || '') || 'project').replace(/\.[^.]+$/, '') + '.smproj',
      state: {
        file: file || null,
        totalDuration, videoStart, videoEnd,
        layers: cleanLayers,
        outWidth, outHeight, bgColor, fadeIn, fadeOut,
      },
    };
    const res = await window.strata.saveProject(proj);
    if (res?.ok) setDirty(false);
    return res || { ok: false, error: 'unknown' };
  }
  async function saveProject() {
    const res = await doSaveProject();
    if (res && !res.ok && !res.canceled) {
      alert('Не удалось сохранить проект: ' + (res.error || 'неизвестная ошибка'));
    }
  }

  async function openProject() {
    if (!window.strata?.openProject) return;
    const res = await window.strata.openProject();
    if (!res) return;
    if (!res.ok) {
      if (!res.canceled) alert('Не удалось открыть проект: ' + (res.error || 'формат не распознан'));
      return;
    }
    const s = res.data?.state;
    if (!s) { alert('Файл проекта пуст или повреждён.'); return; }
    pushUndo();
    const restored = {
      file: s.file ?? null,
      totalDuration: Number(s.totalDuration) || 10,
      videoStart: Number(s.videoStart) || 0,
      videoEnd: Number(s.videoEnd) || (Number(s.totalDuration) || 10),
      layers: Array.isArray(s.layers) ? s.layers : [],
      outWidth: Number(s.outWidth) || 1080,
      outHeight: Number(s.outHeight) || 1920,
      bgColor: s.bgColor || '#000000',
      fadeIn: Number(s.fadeIn) || 0,
      fadeOut: Number(s.fadeOut) || 0,
    };
    // Drop bitmap caches from the previous project so we don't carry stale
    // frames into the new one (and don't leak memory).
    try { videoFrameCacheRef.current.clear(); } catch {}
    try { imgCacheRef.current.clear(); } catch {}
    videoOverlayRefs.current = {};
    audioLayerRefs.current = {};
    // The setState below will change `layers`, which would normally flip
    // dirty=true via the layers-tracking effect. Suppress that one fire so
    // a freshly loaded project starts clean.
    suppressDirtyRef.current = true;
    setState(restored);
    setDirty(false);
    setSelectedId(null);
    setSelectedIds(new Set());
    // Re-kick proxy generation for video layers whose source still exists.
    // Missing files stay flagged via _missing — UI shows a warning, export
    // skips them (or the user re-attaches the file manually).
    const missing = restored.layers.filter(l => l && l._missing);
    if (missing.length) {
      const names = missing.map(l => fileName(l.file || '')).join('\n');
      alert(`Проект открыт. Не найдено файлов: ${missing.length}\n${names}\n\nЭти слои отмечены красным. Чтобы починить — удали слой и добавь файл заново.`);
    }
    restored.layers.forEach((l) => {
      if (!l._missing && (l.type === 'videoOverlay' || l.type === 'maskedVideo') && l.file) {
        ensureProxy(l.id, l.file);
      }
    });
  }

  // Save-request bridge: when the main process needs the renderer to save
  // (because the user picked "Сохранить" on the quit/update prompt), run
  // doSaveProject and report the result back so main can proceed.
  const doSaveProjectRef = useRef(null);
  doSaveProjectRef.current = doSaveProject;
  useEffect(() => {
    if (!window.strata?.onSaveRequest) return;
    return window.strata.onSaveRequest(async () => {
      try {
        const res = doSaveProjectRef.current
          ? await doSaveProjectRef.current()
          : { ok: false, error: 'no impl' };
        window.strata?.saveRequestResponse?.(res);
      } catch (e) {
        window.strata?.saveRequestResponse?.({ ok: false, error: String(e.message || e) });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Merge 2+ selected video/audio clips into one.
  // - Same source file + source-contiguous → instant in-renderer merge (undo-split case).
  // - Different files / non-contiguous → ffmpeg pre-renders a single merged file.
  async function mergeSelected() {
    const ids = selectedIds.size > 1 ? [...selectedIds] : (selectedId ? [selectedId] : []);
    const picked = layers.filter(l => ids.includes(l.id) && (l.type === 'videoOverlay' || l.type === 'audio'));
    if (picked.length < 2) {
      alert('Выбери 2 или больше видео/аудио клипа (Ctrl+клик на таймлайне).');
      return;
    }
    if (!picked.every(c => c.type === picked[0].type)) {
      alert('Выбраны клипы разных типов (видео + аудио). Объедини по отдельности.');
      return;
    }
    const isAudio = picked[0].type === 'audio';

    // Detect the simple split-undo case: same file + source-contiguous slices.
    picked.sort((a, b) => (a.srcStart || 0) - (b.srcStart || 0));
    const sameFile = picked.every(c => c.file === picked[0].file);
    let sourceContiguous = sameFile;
    for (let i = 0; sourceContiguous && i < picked.length - 1; i++) {
      const endA = (picked[i].srcStart || 0) + ((picked[i].endTime ?? dur) - (picked[i].startTime || 0));
      const startB = picked[i + 1].srcStart || 0;
      if (Math.abs(endA - startB) > 0.05) sourceContiguous = false;
    }

    if (sameFile && sourceContiguous) {
      // Fast path — keeps the original file reference, no re-encode.
      const first = picked[0];
      const totalLen = picked.reduce((sum, c) => sum + ((c.endTime ?? dur) - (c.startTime || 0)), 0);
      const startsAt = Math.min(...picked.map(c => c.startTime || 0));
      const merged = {
        ...first,
        startTime: startsAt,
        endTime: Math.min(dur, startsAt + totalLen),
        srcStart: first.srcStart || 0,
      };
      pushUndo();
      const keepIds = new Set(picked.map(c => c.id).filter(id => id !== first.id));
      set('layers', ls => ls
        .filter(l => !keepIds.has(l.id))
        .map(l => l.id === first.id ? merged : l));
      setSelectedId(first.id);
      setSelectedIds(new Set());
      return;
    }

    // Heavy path — ffmpeg concat. Play order = timeline order so the merged
    // clip sounds/looks the way the user arranged them.
    picked.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    const clips = picked.map(c => ({
      file: c.file,
      srcStart: c.srcStart || 0,
      length: (c.endTime ?? dur) - (c.startTime || 0),
      speed: c.speed || 100,
      reversed: !!c.reversed,
    }));
    const startsAt = Math.min(...picked.map(c => c.startTime || 0));
    const totalLen = clips.reduce((s, c) => s + c.length, 0);

    setSaveFinishing(false);
    setSaveProgress(0);
    const offProg = window.strata?.onMergeProgress?.((d) => {
      setSaveProgress(Math.max(0, Math.min(99, Math.round(d.percent || 0))));
    });

    let res;
    try {
      res = await window.strata?.mergeClips?.({
        clips, w: outWidth, h: outHeight, isAudio,
      });
    } catch (e) { res = { ok: false, error: String(e.message || e) }; }

    offProg?.();
    setSaveProgress(null);

    if (!res?.ok) {
      alert('Не получилось объединить: ' + (res?.error || 'неизвестная ошибка'));
      return;
    }

    pushUndo();
    const first = picked[0];
    const merged = {
      ...first,
      file: res.path,
      startTime: startsAt,
      endTime: Math.min(dur, startsAt + totalLen),
      srcStart: 0,
      srcDuration: totalLen,
      speed: 100,
      reversed: false,
      // Reset codec-specific cached metadata that no longer matches the new file.
      aspect: undefined,
    };
    const keepIds = new Set(picked.map(c => c.id).filter(id => id !== first.id));
    set('layers', ls => ls
      .filter(l => !keepIds.has(l.id))
      .map(l => l.id === first.id ? merged : l));
    setSelectedId(first.id);
    setSelectedIds(new Set());
  }

  function splitAtPlayhead() {
    const t = currentTime;
    // Prefer the explicitly selected layer; otherwise find any layer the
    // playhead is currently inside (most editors auto-pick — clicking the clip
    // first should not be required).
    let layer = selectedId ? layers.find(l => l.id === selectedId) : null;
    // Subtitle layers hold many phrases — splitting the whole track makes no
    // sense (each phrase is edited individually), so they're never splittable.
    if (layer && layer.type === 'subtitles') {
      showEditorHint('Слой субтитров нельзя разрезать — редактируй отдельные фразы в панели субтитров.');
      return;
    }
    const inside = (l) => l && t > (l.startTime || 0) + 0.05 && t < (l.endTime ?? totalDuration) - 0.05;
    if (!inside(layer)) {
      // Pick a splittable layer the playhead is inside. Prefer media types.
      const order = ['videoOverlay', 'mainVideo', 'audio', 'image', 'text'];
      const candidates = layers
        .filter(l => inside(l) && l.type !== 'blur' && l.type !== 'mask' && l.type !== 'maskedVideo' && l.type !== 'effect' && l.type !== 'subtitles')
        .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
      layer = candidates[0];
    }
    if (!layer) {
      showEditorHint('Поставь курсор воспроизведения внутри клипа и попробуй ещё раз — нечего резать в этой точке.');
      return;
    }
    if (t <= (layer.startTime || 0) + 0.05 || t >= (layer.endTime ?? totalDuration) - 0.05) {
      showEditorHint('Курсор слишком близко к краю клипа — двинь его в середину и разрежь.');
      return;
    }
    pushUndo();
    const newId = uid();
    const consumed = t - (layer.startTime || 0);
    set('layers', (ls) => {
      const idx = ls.findIndex(x => x.id === layer.id);
      const res = ls.map(x => x.id === layer.id ? { ...x, endTime: t } : x);
      const second = { ...layer, id: newId, startTime: t };
      if (layer.type === 'videoOverlay' || layer.type === 'audio') {
        second.srcStart = (layer.srcStart || 0) + consumed;
      }
      res.splice(idx + 1, 0, second);
      return res;
    });
    setSelectedId(layer.id);
  }

  function onVideoMeta(e) {
    const v = e.target;
    const d = v.duration || 0;
    const nAR = (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : null;
    setState((s) => {
      const next = { ...s };
      if (d > 0) {
        // Auto-fit project duration to the video's length ONLY when the user
        // hasn't customised it (still the default 10 s). Without this check,
        // opening a saved project would clobber the persisted totalDuration
        // with the mainVideo's source length every time.
        const autoFit = Math.abs(s.totalDuration - 10) < 0.01;
        if (autoFit) { next.totalDuration = d; next.videoStart = 0; next.videoEnd = d; }
      }
      if (nAR) {
        const frameAR = s.outWidth / s.outHeight;
        // "contain" the video inside the frame as the initial, undeformed default
        const size = nAR < frameAR ? Math.min(100, (s.outHeight * nAR) / s.outWidth * 100) : 100;
        next.layers = s.layers.map(l => l.type === 'mainVideo'
          ? { ...l, aspect: nAR, size, x: 50, y: 50 } : l);
      }
      return next;
    });
    setZoom(1);
  }
  function onTimeUpdate(e) {
    const ct = e.target.currentTime;
    setCurrentTime(ct);
    if (playing && ct >= videoEnd) { e.target.pause(); setPlaying(false); }
  }

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    if (v.currentTime < videoStart) { v.currentTime = videoStart; setCurrentTime(videoStart); }
    else if (v.currentTime > videoEnd) { v.currentTime = videoEnd; setCurrentTime(videoEnd); }
  }, [videoStart, videoEnd]);

  // Generate low-res thumbnail strip for each video file ONCE — reused for
  // all clips (and split halves) of that file. Saves the browser from
  // spawning 30+ <video> decoders on every clip render.
  async function generateThumbsForFile(file) {
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = fileUrl(file);
      await new Promise((res, rej) => {
        const cleanup = () => { video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('error', onErr); };
        const onMeta = () => { cleanup(); res(); };
        const onErr = () => { cleanup(); rej(new Error('video load error')); };
        video.addEventListener('loadedmetadata', onMeta, { once: true });
        video.addEventListener('error', onErr, { once: true });
      });
      const dur = video.duration;
      if (!isFinite(dur) || dur < 0.05) return;
      const canvas = document.createElement('canvas');
      const W = 96; // low-res — thumbnails on timeline are tiny anyway
      const H = Math.round(W * (video.videoHeight || 9) / (video.videoWidth || 16)) || 54;
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const N = Math.min(30, Math.max(2, Math.round(dur)));
      const thumbs = [];
      for (let i = 0; i < N; i++) {
        const t = (i / Math.max(1, N - 1)) * dur;
        await new Promise((r) => {
          const onSeeked = () => { video.removeEventListener('seeked', onSeeked); r(); };
          video.addEventListener('seeked', onSeeked, { once: true });
          try { video.currentTime = t; } catch { r(); }
        });
        try { ctx.drawImage(video, 0, 0, W, H); } catch {}
        let url = '';
        try { url = canvas.toDataURL('image/jpeg', 0.55); } catch {}
        thumbs.push({ t, url });
      }
      thumbsCacheRef.current.set(file, { dur, thumbs, loading: false });
      setThumbsRev(r => r + 1);
    } catch {
      thumbsCacheRef.current.delete(file);
    }
  }
  useEffect(() => {
    layers.forEach(l => {
      if ((l.type !== 'videoOverlay' && l.type !== 'maskedVideo') || !l.file) return;
      if (thumbsCacheRef.current.has(l.file)) return;
      thumbsCacheRef.current.set(l.file, { loading: true, thumbs: [], dur: 0 });
      generateThumbsForFile(l.file);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers]);

  // Image cache loader
  useEffect(() => {
    layers.forEach(l => {
      if (l.type !== 'image' || !l.file || imgCacheRef.current.has(l.file)) return;
      const img = new Image();
      // When freshly imported, scale the image to COVER the whole preview frame
      // (touch all four borders, crop the overflow) — like "fill screen" in
      // other editors. Runs once: clears fitCover so later user resizes stick.
      img.onload = () => {
        const nAR = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : null;
        if (!nAR) return;
        setState((s) => ({ ...s, layers: s.layers.map(x => {
          if (x.id !== l.id || !x.fitCover) return x;
          const frameAR = s.outWidth / s.outHeight;
          const coverSize = 100 * Math.max(1, nAR / frameAR);
          return { ...x, aspect: nAR, size: coverSize, x: 50, y: 50, fitCover: false };
        }) }));
      };
      img.src = fileUrl(l.file);
      imgCacheRef.current.set(l.file, img);
    });
  }, [layers]);

  // Sync video overlay and audio layer playheads
  useEffect(() => {
    // Sync reversed main video preview element
    const mvLayer = layers.find(l => l.type === 'mainVideo');
    if (mvLayer?.reversed) {
      const el = videoRevRef.current;
      if (el) {
        const revT = Math.max(videoStart, Math.min(videoEnd, videoEnd - (currentTime - videoStart)));
        if (Math.abs(el.currentTime - revT) > 0.05) el.currentTime = revT;
      }
    }
    layers.forEach(l => {
      if (l.type === 'videoOverlay' || l.type === 'maskedVideo') {
        const el = videoOverlayRefs.current[l.id];
        if (!el) return;
        let t;
        const srcOff = l.srcStart || 0;
        const spd = Math.max(0.1, (l.speed || 100) / 100);
        if (l.reversed) {
          // Reverse maps the clip length (endTime-startTime), matching the
          // FFmpeg render which reverses exactly that [0, clipDur] segment.
          const clipDur = Math.max(0.1, (l.endTime ?? dur) - (l.startTime || 0));
          const tFwd = Math.max(0, currentTime - (l.startTime || 0));
          t = srcOff + Math.max(0, clipDur - tFwd) * spd;
        } else {
          t = srcOff + Math.max(0, currentTime - (l.startTime || 0)) * spd;
        }
        // When the timeline is PLAYING, let the element play naturally and
        // only resync if it drifts a lot (>0.3s). When paused/scrubbing we
        // keep the element pinned tightly to the playhead.
        const inRange = currentTime >= (l.startTime || 0) && currentTime <= (l.endTime ?? dur);
        const tightSync = !playing;
        const driftLimit = tightSync ? 0.08 : 0.3;
        // While the proxy owns the picture, don't reseek these decoders either —
        // they're paused and off-screen; a single resync runs on hand-back.
        if (!proxyPlayRef.current && Math.abs(el.currentTime - t) > driftLimit) {
          try { el.currentTime = t; } catch {}
        }
        try { el.playbackRate = spd; } catch {}
        // Actually play the hidden <video> so frames decode smoothly — the
        // canvas renderer copies the live frames to its cache each RAF tick.
        // Reverse can't be played natively; that case still uses scrubbing.
        // While the proxy serves the picture the canvas isn't copying these
        // frames, so pause the decoders too (the <audio> mirror below keeps the
        // sound) — saves N video decodes on heavy projects.
        if (playing && inRange && !l.reversed && !proxyPlayRef.current) {
          if (el.paused) el.play().catch(() => {});
        } else if (!el.paused) {
          try { el.pause(); } catch {}
        }

        // Mirror the video's audio track via a parallel hidden <audio> element
        // so the user actually hears the clip in preview. Reversed clips have
        // no live audio (HTML5 can't play in reverse) — silenced.
        const aEl = videoAudioRefs.current[l.id];
        if (aEl) {
          // During playback the element runs natively in sync; only correct a
          // LARGE drift. A tight threshold here causes audible stutter/dropouts
          // when a heavy re-render (e.g. selecting a layer) briefly stalls the
          // RAF loop and currentTime lags — the reseek re-buffers and clicks.
          const aDrift = playing ? 0.35 : 0.12;
          if (Math.abs(aEl.currentTime - t) > aDrift) aEl.currentTime = t;
          try { aEl.playbackRate = spd; } catch {}
          setBoostedVolume(aEl, l.volume ?? 100);
          if (playing && inRange && !l.reversed && !l.muted) {
            if (aEl.paused) aEl.play().catch(() => {});
          } else if (!aEl.paused) aEl.pause();
        }
      } else if (l.type === 'audio') {
        const el = audioLayerRefs.current[l.id];
        if (!el) return;
        const inRange = currentTime >= (l.startTime || 0) && currentTime <= (l.endTime ?? dur);
        const t = (l.srcStart || 0) + Math.max(0, currentTime - (l.startTime || 0));
        // Loose during playback (native sync) / tight while scrubbing — avoids
        // reseek stutter when a re-render briefly stalls the RAF loop.
        if (Math.abs(el.currentTime - t) > (playing ? 0.35 : 0.12)) el.currentTime = t;
        setBoostedVolume(el, l.volume ?? 100);
        // Speaker toggle (muted) silences audio; the eye (hidden) never touches it.
        if (playing && inRange && !l.muted) { if (el.paused) el.play().catch(() => {}); }
        else { if (!el.paused) el.pause(); }
      }
    });
    // Also depend on layers — when the user trims a clip start, srcStart
    // changes mid-render; without re-running this sync the underlying
    // <video> stays seeked to the old position and preview keeps showing
    // the un-trimmed frame. proxyPlay → re-run to pause/resume the decoders
    // when the proxy takes over / hands the picture back.
  }, [currentTime, playing, layers, proxyPlay]);

  // ⏳ WIP — PREVIEW PERF REWRITE (Stage 1a of N). Stage 1b = LOW-RES preview
  // while moving is NOT done yet (full plan + constraints in memory
  // project_strata_codemap.md → "ACTIVE WORK"). Hard rule: NO draft mode, preview
  // must equal export, crisp full-res frame on pause.
  //
  // RENDER ON DEMAND. The old loop repainted the full-res canvas ~30×/sec
  // FOREVER (even idle/paused) — that constant recomposite of every layer was
  // the main source of lag + audio dropouts on heavy projects. Now the loop runs
  // ONLY while playing, or for a short BURST after any change (so the async-
  // decoded <video> frame after a seek/edit still lands on the canvas), then it
  // STOPS. Idle = zero work.
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const paintOnce = () => {
    const draw = renderFrameRef.current;
    if (!draw) return;
    // Phase 2: while the proxy <video> is serving the picture, skip the whole
    // canvas recomposite — that idle main thread is what keeps audio smooth.
    if (proxyPlayRef.current) return;
    const canvas = previewCanvasRef.current;
    if (canvas) draw(canvas.getContext('2d'));
    const fs = fsCanvasRef.current;   // fullscreen mirror, when open
    if (fs) draw(fs.getContext('2d'));
  };
  const ensureRenderLoop = () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;
    let last = 0;
    const tick = (ts) => {
      // Low-res while playing (smooth), full-res otherwise (crisp scrub/pause).
      drawScaleRef.current = playingRef.current ? PREVIEW_SCALE : 1;
      // Keep going while playing OR within the post-change burst window.
      if (!playingRef.current && nowMs() > renderUntilRef.current) {
        paintOnce();                  // one last settle paint (full res), then stop
        loopRunningRef.current = false;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
      if (ts - last < 33) return;
      last = ts;
      paintOnce();
    };
    rafRef.current = requestAnimationFrame(tick);
  };
  const kickRender = (ms = 650) => {
    renderUntilRef.current = Math.max(renderUntilRef.current, nowMs() + ms);
    ensureRenderLoop();
  };
  // Repaint whenever the visible frame can change (scrub, edit, bg, canvas size,
  // font load). During playback the loop self-sustains via playingRef.
  useEffect(() => {
    kickRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, layers, bgColor, outWidth, outHeight, videoStart, videoEnd, fontRevision, previewFullscreen]);
  // Play/pause: start the loop (play → runs continuously; pause → one final
  // settle paint, then stops).
  useEffect(() => {
    playingRef.current = playing;
    kickRender();
    return () => { /* loop self-stops; nothing to cancel here */ };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  // Stop the loop on unmount.
  useEffect(() => () => { loopRunningRef.current = false; cancelAnimationFrame(rafRef.current); }, []);

  // An edit invalidates the prepared buffer: bump the token (so a stale render's
  // progress stops touching the bar), clear the bar, and kill the running proxy.
  useEffect(() => {
    proxyTokenRef.current++;
    proxyDoneTokenRef.current = -1;
    proxyFilesRef.current = [];        // rendered proxies are now stale
    deactivateProxy();                 // drop back to the live canvas at once
    setBuffered([]);
    setBufferedHd([]);
    setBufferedHdLive(null);
    window.strata?.cancelPreview?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, totalDuration, outWidth, outHeight, bgColor]);
  // Pressing Play kicks the background buffer render. It runs to completion even
  // if the user pauses → the bar keeps filling ahead (YouTube-style).
  useEffect(() => {
    if (playing) buildPreviewProxy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // ── Phase 2 — PLAY FROM THE PROXY ────────────────────────────────────────
  // Once a proxy segment has fully rendered, a hidden <video> serves the picture
  // so the canvas recomposite STOPS (frees the main thread → smooth audio + no
  // stutter). The proxy is a SLAVE: it's muted and follows the existing playhead
  // (live <audio> stays the sound, the wall-clock / main-video stays the clock),
  // so there's no audio cut-over glitch and no clock conflict. Flips back to the
  // crisp full-res canvas the instant we pause / scrub / edit / hit a gap.
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  useEffect(() => { previewFullscreenRef.current = previewFullscreen; }, [previewFullscreen]);
  // The proxy <video> lives in TWO places (inline + fullscreen overlay) because a
  // browser-fullscreen element only shows its own descendants. Only the one for
  // the current view is ever driven; the other stays paused/hidden.
  const activeProxyVideo = () => (previewFullscreenRef.current ? proxyVideoFsRef.current : proxyVideoRef.current);
  const setDbg = (s) => { if (proxyDbgRef.current !== s) { proxyDbgRef.current = s; setProxyDbg(s); } };

  function findReadyProxyFile(appT) {
    const eps = 0.05, lead = 0.12;   // need a little runway before a file's end
    let best = null;
    for (const f of proxyFilesRef.current) {
      if (f.token !== proxyTokenRef.current) continue;       // stale (edited)
      if (appT >= f.appStart - eps && appT < f.appEnd - lead) {
        // Prefer the highest quality, then the longest runway before a switch.
        const fq = f.q || 0, bq = best ? (best.q || 0) : -1;
        if (!best || fq > bq || (fq === bq && f.appEnd > best.appEnd)) best = f;
      }
    }
    return best;
  }
  function deactivateProxy() {
    // Pause BOTH elements — on a fullscreen toggle the active one switches, and
    // we don't want the old element to keep decoding in the background.
    [proxyVideoRef.current, proxyVideoFsRef.current].forEach(pv => { if (pv) { try { pv.pause(); } catch {} } });
    proxyActiveUrlRef.current = null;
    if (proxyPlayRef.current) { proxyPlayRef.current = false; setProxyPlay(false); kickRender(); }
  }
  function loadProxy(want, seekT) {
    const pv = activeProxyVideo(); if (!pv) return;
    // Mid-play file switch (esp. the low→high quality upgrade): drop to the
    // canvas for the brief reload so the swap doesn't flash black. The playing
    // canvas (PREVIEW_SCALE) is itself sharper than the low proxy, so the
    // transition reads as low→sharper→crisp. Initial activation skips this.
    if (proxyPlayRef.current) { proxyPlayRef.current = false; setProxyPlay(false); kickRender(); }
    proxyActiveUrlRef.current = want.url;          // claim now so we don't re-enter
    const target = Math.max(0, seekT);
    let done = false;
    // Cut over once the right frame is presented (no black flash). Guarded so a
    // watchdog + the real `seeked` can't both fire, and so a superseded load is
    // dropped.
    const cutOver = () => {
      if (done) return; done = true;
      if (proxyActiveUrlRef.current !== want.url) return;    // superseded mid-load
      try { pv.play().catch(() => {}); } catch {}
      proxyPlayRef.current = true; setProxyPlay(true);
    };
    const onLoaded = () => {
      pv.removeEventListener('loadeddata', onLoaded);
      if (proxyActiveUrlRef.current !== want.url) return;
      if (Math.abs(pv.currentTime - target) < 0.05) { cutOver(); return; }
      const onSeeked = () => { pv.removeEventListener('seeked', onSeeked); cutOver(); };
      pv.addEventListener('seeked', onSeeked, { once: true });
      try { pv.currentTime = target; } catch { cutOver(); }
      setTimeout(cutOver, 600);                     // watchdog: seek didn't fire
    };
    try { pv.pause(); } catch {}                    // don't swap src on a playing el
    pv.muted = true;                                // audio stays on the live mirrors
    pv.addEventListener('loadeddata', onLoaded, { once: true });
    pv.src = fileUrl(want.url);
    try { pv.load(); } catch {}
    // watchdog: loadeddata never arrived → force the seek+cutover anyway, so the
    // picture can never get stuck on the canvas mid-swap.
    setTimeout(() => {
      if (done || proxyActiveUrlRef.current !== want.url) return;
      try { pv.currentTime = target; } catch {}
      cutOver();
    }, 1300);
  }
  function proxyStep() {
    const pv = activeProxyVideo(); if (!pv) return;
    const appT = currentTimeRef.current;
    const want = findReadyProxyFile(appT);
    if (!want) { setDbg('canvas (no buffer here)'); if (proxyPlayRef.current) deactivateProxy(); return; }
    if (proxyActiveUrlRef.current !== want.url) { setDbg('loading q' + (want.q || 0) + '…'); loadProxy(want, appT - want.appStart); return; }
    if (!proxyPlayRef.current) { setDbg('loading q' + (want.q || 0) + '…'); return; }   // still loading / cutting over
    setDbg('PROXY q' + (want.q || 0) + (want.q >= 1 ? ' (HD)' : ' (low)'));
    if (pv.paused) { try { pv.play().catch(() => {}); } catch {} }
    // Keep the muted proxy picture aligned to the live playhead. Both run at
    // real time so they stay close; only a real drift forces a tiny reseek.
    const tgt = appT - want.appStart;
    if (Math.abs(pv.currentTime - tgt) > 0.18) { try { pv.currentTime = Math.max(0, tgt); } catch {} }
  }
  // Controller runs while playing (inline OR fullscreen — re-runs on the toggle
  // to swap which <video> it drives). Re-checks every frame, so it auto-cuts over
  // the moment the segment covering the playhead finishes rendering (AE-style).
  useEffect(() => {
    if (!playing) { deactivateProxy(); return; }
    let raf = 0;
    const loop = () => { proxyStep(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); deactivateProxy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, previewFullscreen]);
  // Faint-orange "already rendered" segments drawn behind the bright progress
  // fill on the scrubber (shared by the normal + fullscreen playback bars).
  const renderBuffered = () => [
    ...buffered.map((iv, i) => (
      <div key={'lo' + i} className="ed-scrub-buffered"
        style={{ left: pct(iv.s), width: `${Math.max(0, Math.min(100, ((iv.e - iv.s) / dur) * 100))}%` }} />
    )),
    // HD render FRONTIER (striped green = "rendering here, in progress").
    ...(bufferedHdLive ? [(
      <div key="hdlive" className="ed-scrub-buffered ed-scrub-buffered-hd-live"
        style={{ left: pct(bufferedHdLive.s), width: `${Math.max(0, Math.min(100, ((bufferedHdLive.e - bufferedHdLive.s) / dur) * 100))}%` }} />
    )] : []),
    // HD READY ranges (solid green) drawn on top — "HD plays here".
    ...bufferedHd.map((iv, i) => (
      <div key={'hd' + i} className="ed-scrub-buffered ed-scrub-buffered-hd"
        style={{ left: pct(iv.s), width: `${Math.max(0, Math.min(100, ((iv.e - iv.s) / dur) * 100))}%` }} />
    )),
  ];

  // Drive real OS fullscreen from the previewFullscreen state. Entering asks
  // the overlay element to go fullscreen; exiting (button or browser ESC) drops
  // back. The fullscreenchange listener keeps React state in sync when the user
  // presses ESC (which the browser handles itself).
  useEffect(() => {
    const el = fsOverlayRef.current;
    if (previewFullscreen) {
      if (el && !document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [previewFullscreen]);
  useEffect(() => {
    const onFsChange = () => { if (!document.fullscreenElement) setPreviewFullscreen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setPreviewFullscreen(false); };
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('fullscreenchange', onFsChange); window.removeEventListener('keydown', onKey); };
  }, []);

  // Global Space-to-toggle-play — fires anywhere in the editor EXCEPT while a
  // text input/textarea/contentEditable is focused (so typing a space in the
  // segment editor or filename field doesn't pause the video).
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable) || tag === 'SELECT') return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Subscribe to proxy-encode progress events. The backend emits the
  // current % per source file; we mirror it onto every layer using that file.
  useEffect(() => {
    const off = window.strata?.onProxyProgress?.((d) => {
      if (!d?.file) return;
      setState(s => ({ ...s, layers: s.layers.map(x => (x.file === d.file && x._proxyMaking)
        ? { ...x, _proxyProgress: Math.round(d.percent || 0) } : x) }));
    });
    return () => off?.();
  }, []);

  // Ctrl+Z undo — restores the full previous editor state. Registered on
  // capture phase so it always wins over inputs / focused buttons.
  useEffect(() => {
    const handler = (e) => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ') && !e.shiftKey && !e.altKey)) return;
      // Flush any pending auto-snapshot so the in-flight state change made
      // micro-seconds ago is recorded BEFORE we pop the stack.
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
        const prevJson = lastSnapshotRef.current;
        if (prevJson && prevJson !== JSON.stringify(state)) {
          setUndoStack(s => {
            const top = s[s.length - 1];
            if (top && JSON.stringify(top) === prevJson) return s;
            return [...s.slice(-29), JSON.parse(prevJson)];
          });
          lastSnapshotRef.current = JSON.stringify(state);
        }
      }
      e.preventDefault();
      e.stopPropagation();
      setUndoStack(s => {
        if (!s.length) return s;
        const prev = s[s.length - 1];
        // Replace the whole state so duration, canvas, bg etc. all restore.
        setState(() => JSON.parse(JSON.stringify(prev)));
        // Move focus off any input so the next keystroke isn't intercepted.
        try { document.activeElement?.blur?.(); } catch {}
        undoApplyingRef.current = true;
        return s.slice(0, -1);
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [state]);

  // Ctrl+S → save project, Ctrl+O → open project. Capture phase so they win
  // over focused buttons/inputs; we skip when the user is actually typing.
  useEffect(() => {
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 's' && k !== 'o') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === 's') saveProject(); else openProject();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [state]);

  // The header (CompactHeader, rendered at App level) hosts the project
  // action buttons. It dispatches CustomEvents so the Editor — which owns
  // the actual handlers and state — can react. Avoids lifting state up.
  useEffect(() => {
    const onOpen = () => openProject();
    const onSaveProj = () => saveProject();
    const onSaveExport = () => {
      const hasVideo = layers.some(l => l.type === 'videoOverlay');
      const hasAudio = layers.some(l => l.type === 'audio');
      if (!hasVideo && hasAudio) setSaveFmt('mp3');
      setSaveDialogOpen(true);
    };
    window.addEventListener('strata:editor-open-project', onOpen);
    window.addEventListener('strata:editor-save-project', onSaveProj);
    window.addEventListener('strata:editor-save', onSaveExport);
    return () => {
      window.removeEventListener('strata:editor-open-project', onOpen);
      window.removeEventListener('strata:editor-save-project', onSaveProj);
      window.removeEventListener('strata:editor-save', onSaveExport);
    };
  }, [layers]);

  // Auto-snapshot: any time state actually changes, push the PREVIOUS state
  // onto the undo stack after a short debounce. This catches everything that
  // doesn't call pushUndo() explicitly — slider tweaks, text edits, color
  // picks, duration changes, canvas resize, bg colour, fade, etc.
  const lastSnapshotRef = useRef(null);
  const snapshotTimerRef = useRef(null);
  const undoApplyingRef = useRef(false);
  // Track JSON of the most-recently pushed snapshot so dedup can compare
  // without re-stringifying the (potentially large) top of the stack.
  const lastPushedJsonRef = useRef(null);
  useEffect(() => {
    // Defer the (expensive) JSON.stringify until the debounce timer fires —
    // earlier this ran on every Editor re-render which during a clip-drag
    // means 60 stringifies/sec on potentially 100KB+ state.
    if (undoApplyingRef.current) { undoApplyingRef.current = false; return; }
    clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      const curJson = JSON.stringify(state);
      if (lastSnapshotRef.current === null) { lastSnapshotRef.current = curJson; return; }
      if (curJson === lastSnapshotRef.current) return;
      const prevJson = lastSnapshotRef.current;
      // Cheap dedup: skip pushing if we already pushed this exact snapshot
      // (e.g. an explicit pushUndo() raced this auto-snapshot).
      if (lastPushedJsonRef.current === prevJson) {
        lastSnapshotRef.current = curJson;
        return;
      }
      setUndoStack(s => [...s.slice(-29), JSON.parse(prevJson)]);
      lastPushedJsonRef.current = prevJson;
      lastSnapshotRef.current = curJson;
    }, 400);
  }, [state]);

  // Spacebar toggles playback, Delete removes selected layers.
  function copySelected() {
    const ids = selectedIds.size ? [...selectedIds] : (selectedId ? [selectedId] : []);
    const picked = layers.filter(l => ids.includes(l.id));
    if (picked.length) clipboardRef.current = JSON.parse(JSON.stringify(picked));
  }
  function pasteClipboard() {
    const clip = clipboardRef.current;
    if (!clip || !clip.length) return;
    pushUndo();
    const copies = clip.map(l => ({ ...l, id: uid() }));
    set('layers', (ls) => [...ls, ...copies]);
    setSelectedId(copies[copies.length - 1].id);
    setSelectedIds(new Set(copies.map(c => c.id)));
  }
  useEffect(() => {
    if (!colorMenu) return;
    const close = () => setColorMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [colorMenu]);
  // Keep handlers in a ref so we attach the window listener exactly ONCE,
  // not every re-render (which during a clip-drag is 60 reattaches/sec).
  const keyHandlerImplRef = useRef(null);
  keyHandlerImplRef.current = (e) => {
    const t = (e.target?.tagName || '').toLowerCase();
    if (t === 'input' || t === 'textarea' || e.target?.isContentEditable) return;
    // Capture phase + stopPropagation — Space toggles playback no matter
    // which control (button, panel, canvas) currently holds focus.
    if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); togglePlay(); }
    else if (e.key === 'Delete') { e.preventDefault(); delSelected(); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') { copySelected(); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') { e.preventDefault(); pasteClipboard(); }
  };
  useEffect(() => {
    const handler = (e) => keyHandlerImplRef.current?.(e);
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Drive the playhead when playing a timeline that has no main video.
  useEffect(() => {
    if (!playing || videoRef.current) return;
    let raf = 0, last = performance.now();
    const tick = (ts) => {
      const delta = (ts - last) / 1000; last = ts;
      setCurrentTime((t) => { const nt = t + delta; if (nt >= dur) { setPlaying(false); return dur; } return nt; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur]);

  function seekTo(t) { const v = videoRef.current; if (v) v.currentTime = t; setCurrentTime(t); }
  function togglePlay() {
    // Play is a user gesture → resume the WebAudio context if browser
    // autoplay policy suspended it. Without this the gain-node chain stays
    // silent on first play.
    try { const c = audioCtxRef.current; if (c && c.state === 'suspended') c.resume(); } catch {}
    // On macOS, starting playback clears any layer selection. Selecting a layer
    // mid-playback triggers a heavy timeline re-render that can stall the audio
    // sync and cause stutter/dropouts; with nothing selected playback stays
    // smooth. Windows is unaffected, so it keeps its selection.
    const isMac = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
    if (!playing && isMac && (selectedId || selectedIds.size)) {
      setSelectedId(null);
      setSelectedIds(new Set());
    }
    const v = videoRef.current;
    if (!v) {
      // No main video — still allow playing a text/image-only timeline.
      setPlaying((p) => { if (!p && currentTime >= dur) setCurrentTime(0); return !p; });
      return;
    }
    if (playing) { v.pause(); setPlaying(false); }
    else {
      if (v.currentTime >= videoEnd || v.currentTime < videoStart) { v.currentTime = videoStart; setCurrentTime(videoStart); }
      v.play().catch(() => {}); setPlaying(true);
    }
  }

  // Shared scrub-drag handler so the normal playback bar AND the fullscreen
  // overlay's bar behave identically. getBoundingClientRect is read off the
  // event target, so it works wherever the scrub element is rendered.
  function scrubPointerDown(e) {
    e.preventDefault();
    pausePlayback();
    const r = e.currentTarget.getBoundingClientRect();
    const seek = (ev) => {
      let t = Math.max(0, Math.min(dur, ((ev.clientX - r.left) / r.width) * dur));
      t = snapTime(t, ev.shiftKey);
      seekTo(t);
    };
    seek(e);
    const move = (ev) => seek(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function makePreviewDrag(id) {
    return (e) => {
      e.stopPropagation(); e.preventDefault();
      // Ctrl/Cmd+click toggles the layer in the multi-selection; plain click
      // selects it alone (unless it is already part of a multi-selection).
      if (e.ctrlKey || e.metaKey) {
        setSelectedIds(s => { const n = new Set(s); if (!n.size && selectedId) n.add(selectedId); n.has(id) ? n.delete(id) : n.add(id); return n; });
        setSelectedId(id);
      } else if (!selectedIds.has(id)) {
        setSelectedId(id);
        setSelectedIds(new Set());
      }
      pushUndo();
      const r = canvasRef.current?.getBoundingClientRect(); if (!r) return;
      const sx = e.clientX, sy = e.clientY;
      // Move the whole group together when the grabbed layer is multi-selected
      const groupIds = (selectedIds.has(id) && selectedIds.size > 1) ? [...selectedIds] : [id];
      // Subtitles keep their position on `.style` (x/y %), every other layer on
      // the layer itself. Read the right source so dragging actually moves subs.
      const readPos = (l) => l.type === 'subtitles'
        ? { x: l.style?.x ?? 50, y: l.style?.y ?? 85 }
        : { x: l.x, y: l.y };
      const startPos = {};
      layers.forEach(l => { if (groupIds.includes(l.id)) startPos[l.id] = readPos(l); });
      if (!startPos[id]) { const L = layers.find(l => l.id === id); if (L) startPos[id] = readPos(L); }
      const move = (ev) => {
        let pdx = ev.clientX - sx, pdy = ev.clientY - sy;
        // Shift constrains movement to a single axis (whichever the cursor has
        // travelled further along) so objects slide perfectly straight.
        if (ev.shiftKey) {
          if (Math.abs(pdx) >= Math.abs(pdy)) pdy = 0; else pdx = 0;
        }
        const dx = (pdx / r.width) * 100;
        const dy = (pdy / r.height) * 100;
        set('layers', (l) => l.map(x => {
          const sp = startPos[x.id];
          if (!sp) return x;
          const nx = Math.max(0, Math.min(100, sp.x + dx));
          const ny = Math.max(0, Math.min(100, sp.y + dy));
          return x.type === 'subtitles'
            ? { ...x, style: { ...(x.style || {}), x: nx, y: ny } }
            : { ...x, x: nx, y: ny };
        }));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
  }

  // Corner handles (nw/ne/se/sw) stretch freely (change aspect);
  // edge handles (n/e/s/w) resize proportionally (keep aspect).
  // One-sided: only the dragged edge moves; the opposite edge stays put.
  function makePreviewResize(id, handle) {
    return (e) => {
      e.stopPropagation(); e.preventDefault();
      pushUndo();
      setSelectedId(id); setSelectedIds(new Set());
      const r = canvasRef.current?.getBoundingClientRect(); if (!r) return;
      const W = outWidth, H = outHeight;
      const L = layers.find(l => l.id === id); if (!L) return;
      const box = getLayerPx(L);
      const startW = Math.max(1, box.w), startH = Math.max(1, box.h);
      const sx = e.clientX, sy = e.clientY;
      const hsign = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
      const vsign = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
      const isCorner = hsign !== 0 && vsign !== 0;
      // Center-based resize: both sides grow/shrink symmetrically from the
      // layer's center. The dragged edge tracks the cursor (Δ added once),
      // the opposite edge mirrors (Δ subtracted) — so total dimension changes
      // by 2Δ and the centre stays put.
      const startCx = (L.x / 100) * W, startCy = (L.y / 100) * H;
      // Start edges of the box — the OPPOSITE edge stays anchored while the
      // dragged handle moves, like every other editor. (Only the grabbed
      // corner/side travels; the far corner is pinned.)
      const boxL = box.x, boxR = box.x + box.w, boxT = box.y, boxB = box.y + box.h;
      // Given a final size, place the centre so the anchored (opposite) edge
      // stays put. No horizontal/vertical handle → that axis stays centred.
      const anchorCx = (nw) => hsign > 0 ? boxL + nw / 2 : hsign < 0 ? boxR - nw / 2 : startCx;
      const anchorCy = (nh) => vsign > 0 ? boxT + nh / 2 : vsign < 0 ? boxB - nh / 2 : startCy;
      const move = (ev) => {
        const dxPx = ((ev.clientX - sx) / r.width) * W;
        const dyPx = ((ev.clientY - sy) / r.height) * H;
        const keepAspect = ev.shiftKey;
        if (L.type === 'blur' || L.type === 'mask' || L.type === 'maskedVideo') {
          let nw = startW, nh = startH;
          if (hsign) nw = Math.max(0.05 * W, startW + dxPx * hsign);
          if (vsign) nh = Math.max(0.05 * H, startH + dyPx * vsign);
          if (keepAspect && isCorner) {
            const ratio = startW / startH;
            if (Math.abs(nw / startW - 1) > Math.abs(nh / startH - 1)) nh = nw / ratio;
            else nw = nh * ratio;
          }
          // Mask/maskedVideo can scale up to 300 % of canvas (so the cut-out
          // can extend past the frame for big-cropout effects). Blur stays
          // capped at canvas size.
          const maxPct = L.type === 'blur' ? 100 : 300;
          const cx = anchorCx(nw), cy = anchorCy(nh);
          set('layers', (ls) => ls.map(x => x.id === id ? { ...x,
            width: Math.max(5, Math.min(maxPct, nw / W * 100)),
            height: Math.max(5, Math.min(maxPct, nh / H * 100)),
            x: clamp(cx / W * 100, 0, 100), y: clamp(cy / H * 100, 0, 100) } : x));
          return;
        }
        if (L.type === 'text') {
          let ratio = 1;
          if (hsign) ratio = (startW + dxPx * hsign * 2) / startW;
          else if (vsign) ratio = (startH + dyPx * vsign * 2) / startH;
          ratio = Math.max(0.1, ratio);
          const ns = Math.max(8, Math.min(400, Math.round((L.size || 48) * ratio)));
          set('layers', (ls) => ls.map(x => x.id === id ? { ...x, size: ns,
            x: clamp(startCx / W * 100, 0, 100), y: clamp(startCy / H * 100, 0, 100) } : x));
          return;
        }
        // media layers: image / mainVideo / videoOverlay.
        // Only the grabbed handle travels — the opposite corner/side is pinned.
        let nw, nh;
        if (isCorner) {
          nw = Math.max(0.03 * W, startW + dxPx * hsign);
          nh = Math.max(0.03 * H, startH + dyPx * vsign);
          if (keepAspect) {
            const s = Math.max(nw / startW, nh / startH);
            nw = startW * s; nh = startH * s;
          }
        } else if (hsign) {
          nw = Math.max(0.03 * W, startW + dxPx * hsign);
          nh = nw * (startH / startW);
        } else {
          nh = Math.max(0.03 * H, startH + dyPx * vsign);
          nw = nh * (startW / startH);
        }
        const lockAspect = keepAspect || !isCorner;
        // Edge-snap: when the dragged edge lands near a frame border (0 / W / H),
        // stick to it flush — like Premiere/Photoshop. Threshold ≈ 3% of canvas.
        // Since the opposite edge is pinned, we snap the size that lands the
        // moving edge exactly on the border. With aspect locked we apply the
        // closer of the two snaps as a uniform scale.
        const TW = 0.03 * W, THh = 0.03 * H;
        let snapW = null, snapH = null;
        if (hsign > 0)      { if (Math.abs(boxL + nw - W) < TW) snapW = W - boxL; }
        else if (hsign < 0) { if (Math.abs(boxR - nw) < TW)     snapW = boxR; }
        if (vsign > 0)      { if (Math.abs(boxT + nh - H) < THh) snapH = H - boxT; }
        else if (vsign < 0) { if (Math.abs(boxB - nh) < THh)     snapH = boxB; }
        if (lockAspect) {
          const cands = [];
          if (snapW != null) cands.push(snapW / nw);
          if (snapH != null) cands.push(snapH / nh);
          if (cands.length) {
            const s = cands.reduce((a, b) => Math.abs(b - 1) < Math.abs(a - 1) ? b : a);
            nw *= s; nh *= s;
          }
        } else {
          if (snapW != null) nw = snapW;
          if (snapH != null) nh = snapH;
        }
        const nsize = Math.max(3, Math.min(400, nw / W * 100));
        const naspect = nw / nh;
        const cx = anchorCx(nw), cy = anchorCy(nh);
        set('layers', (ls) => ls.map(x => x.id === id ? { ...x, size: nsize, aspect: naspect,
          x: clamp(cx / W * 100, 0, 100), y: clamp(cy / H * 100, 0, 100) } : x));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
  }

  // Resize the subtitle box-area by dragging its outline on the preview.
  // Center-anchored (style.x/style.y stays put) and symmetric: dragging an edge
  // grows both sides by Δ so the rect changes by 2Δ. Font size scales with the
  // box — corners use the geometric mean of the W/H scale (balanced); edge
  // handles use the single dimension being changed. fontSize stays clamped to
  // [20, 160] so a small box doesn't shrink text below readable.
  function makeSubBoxResize(id, handle) {
    return (e) => {
      e.stopPropagation(); e.preventDefault();
      pushUndo();
      const r = canvasRef.current?.getBoundingClientRect(); if (!r) return;
      const L = layers.find(l => l.id === id); if (!L || L.type !== 'subtitles') return;
      const st = L.style || {};
      const startW  = Math.max(10, Math.min(300, Number(st.boxW) || 88));
      const startH  = Math.max(5,  Math.min(300, Number(st.boxH) || 100));
      const sx = e.clientX, sy = e.clientY;
      const hsign = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
      const vsign = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
      // Photoshop-style: dragging the box edges resizes the BOX ONLY (the wrap
      // area). Font size is set separately via the panel slider — the box never
      // changes the text size. Side handles change one dimension; corners both.
      const move = (ev) => {
        const dxPct = ((ev.clientX - sx) / r.width)  * 100;
        const dyPct = ((ev.clientY - sy) / r.height) * 100;
        let nw = startW, nh = startH;
        if (hsign) nw = Math.max(10, Math.min(300, startW + dxPct * hsign * 2));
        if (vsign) nh = Math.max(5,  Math.min(300, startH + dyPct * vsign * 2));
        set('layers', (ls) => ls.map(x => x.id === id
          ? { ...x, style: { ...(x.style || {}), boxW: Math.round(nw), boxH: Math.round(nh) } }
          : x));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
  }

  // Drag a single subtitle SEGMENT along the (expanded) subtitle track to fix
  // its timing. Shifts the segment's start/end AND every word's start/end by the
  // same delta so the karaoke highlight stays in sync. Derived from a snapshot
  // taken at drag start, so repeated moves never compound.
  function makeSubSegDrag(layerId, segId) {
    return (e) => {
      e.stopPropagation(); e.preventDefault();
      const layer = layers.find(l => l.id === layerId);
      const seg = layer && (layer.segments || []).find(s => s.id === segId);
      if (!seg) return;
      const ruler = timelineRef.current?.getBoundingClientRect(); if (!ruler) return;
      const sx = e.clientX;
      const snap = JSON.parse(JSON.stringify(seg));
      const segDur = Math.max(0.01, snap.endTime - snap.startTime);
      let undoTaken = false;
      const move = (ev) => {
        if (Math.abs(ev.clientX - sx) < 3) return;  // ignore micro-jitter on a click
        if (!undoTaken) { pushUndo(); undoTaken = true; }
        const delta = ((ev.clientX - sx) / ruler.width) * dur;
        const newStart = Math.max(0, Math.min(dur - segDur, snap.startTime + delta));
        const wd = newStart - snap.startTime;
        const moved = {
          ...snap,
          startTime: snap.startTime + wd,
          endTime: snap.endTime + wd,
          words: (snap.words || []).map(w => ({ ...w, start: (Number(w.start) || 0) + wd, end: (Number(w.end) || 0) + wd })),
        };
        set('layers', ls => ls.map(l => l.id === layerId
          ? { ...l, segments: (l.segments || []).map(s => s.id === segId ? moved : s) }
          : l));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
  }

  // Resize one subtitle segment by dragging its left (isStart) or right edge —
  // makes the phrase shorter/longer like a clip. The word timings are remapped
  // linearly into the new [start,end] range so the karaoke highlight still
  // spans the whole phrase. Snapshot-based, so it never compounds.
  function makeSubSegResize(layerId, segId, isStart) {
    return (e) => {
      e.stopPropagation(); e.preventDefault();
      const layer = layers.find(l => l.id === layerId);
      const seg = layer && (layer.segments || []).find(s => s.id === segId);
      if (!seg) return;
      const ruler = timelineRef.current?.getBoundingClientRect(); if (!ruler) return;
      const sx = e.clientX;
      const snap = JSON.parse(JSON.stringify(seg));
      const MIN = 0.1;
      let undoTaken = false;
      const remap = (t, oldS, oldE, newS, newE) => {
        const span = (oldE - oldS) || 1;
        return newS + ((t - oldS) / span) * (newE - newS);
      };
      const move = (ev) => {
        if (Math.abs(ev.clientX - sx) < 2) return;
        if (!undoTaken) { pushUndo(); undoTaken = true; }
        const delta = ((ev.clientX - sx) / ruler.width) * dur;
        let newS = snap.startTime, newE = snap.endTime;
        if (isStart) newS = Math.max(0, Math.min(snap.endTime - MIN, snap.startTime + delta));
        else newE = Math.min(dur, Math.max(snap.startTime + MIN, snap.endTime + delta));
        const moved = {
          ...snap,
          startTime: newS,
          endTime: newE,
          words: (snap.words || []).map(w => ({
            ...w,
            start: remap(Number(w.start) || 0, snap.startTime, snap.endTime, newS, newE),
            end: remap(Number(w.end) || 0, snap.startTime, snap.endTime, newS, newE),
          })),
        };
        set('layers', ls => ls.map(l => l.id === layerId
          ? { ...l, segments: (l.segments || []).map(s => s.id === segId ? moved : s) }
          : l));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
  }

  function makeClipBodyDrag(id) {
    if (id === '__mv__') {
      return (e) => {
        if (e.target.classList.contains('etl-clip-handle')) return;
        e.stopPropagation();
        pushUndo();
        const r = timelineRef.current?.getBoundingClientRect(); if (!r) return;
        const clipLen = videoEnd - videoStart;
        const offsetT = ((e.clientX - r.left) / r.width) * dur - videoStart;
        const move = (ev) => {
          const r2 = timelineRef.current?.getBoundingClientRect(); if (!r2) return;
          const ns = Math.max(0, Math.min(dur - clipLen, ((ev.clientX - r2.left) / r2.width) * dur - offsetT));
          setState((s) => ({ ...s, videoStart: ns, videoEnd: ns + clipLen }));
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      };
    }
    return (e) => {
      if (e.target.classList.contains('etl-clip-handle')) return;
      e.stopPropagation();
      const layer = layers.find(l => l.id === id); if (!layer) return;
      const startX = e.clientX, startY = e.clientY;
      const clipEl = e.currentTarget;
      const hasMod = e.ctrlKey || e.metaKey || e.shiftKey;
      const MOVE_THRESHOLD = 5; // px of travel before we decide an axis
      let mode = 'pending'; // 'pending' | 'horizontal' | 'reorder'
      let undoTaken = false;
      const takeUndoOnce = () => { if (!undoTaken) { pushUndo(); undoTaken = true; } };
      // Select the grabbed clip when a drag actually COMMITS (not on a plain
      // click — the row's click handler owns that, and selecting here too would
      // make a click select-then-deselect). A clip already inside a multi-
      // selection is left alone so the whole group drags together.
      const selectForDrag = () => {
        if (!hasMod && !selectedIds.has(id)) {
          setSelectedId(id);
          setSelectedIds(new Set());
          selAnchorRef.current = id;
        }
      };

      // Reference top of the clip's own row, used to translate the lifted clip
      // so it visually snaps onto whichever track row sits under the cursor.
      const ownRow = clipEl.closest && clipEl.closest('.etl-track-row');
      const ownRowTop = ownRow ? ownRow.getBoundingClientRect().top : 0;

      const startHorizontal = () => {
        mode = 'horizontal';
        takeUndoOnce();
        selectForDrag();
      };
      const startReorder = () => {
        mode = 'reorder';
        selectForDrag();
        takeUndoOnce();
        try { clipEl.classList.add('etl-clip-reorder-active'); } catch {}
      };

      // Drag the whole group when the grabbed clip is multi-selected (mainVideo excluded)
      const group = (selectedIds.has(id) && selectedIds.size > 1)
        ? layers.filter(l => selectedIds.has(l.id) && l.id !== '__mv__')
        : [layer];
      const starts = {};
      group.forEach(l => { starts[l.id] = { s: l.startTime, len: l.endTime - l.startTime }; });
      if (!starts[id]) starts[id] = { s: layer.startTime, len: layer.endTime - layer.startTime };

      // Pick which track row the cursor is over by walking the DOM.
      const rowIdFromPoint = (cx, cy) => {
        const els = document.elementsFromPoint(cx, cy);
        for (const el of els) {
          const row = el.closest && el.closest('.etl-track-row');
          if (row && row.dataset && row.dataset.layerId) return row.dataset.layerId;
        }
        return null;
      };

      const move = (ev) => {
        if (mode === 'pending') {
          const dx = Math.abs(ev.clientX - startX);
          const dy = Math.abs(ev.clientY - startY);
          if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
            // Decide intent by the dominant axis the moment movement is clear:
            // a mostly-vertical gesture means "move to another track" (reorder),
            // anything else is a normal horizontal time-drag. No hold needed.
            if (dy > dx) startReorder();
            else startHorizontal();
          } else return;
        }
        if (mode === 'horizontal') {
          const r2 = timelineRef.current?.getBoundingClientRect(); if (!r2) return;
          const dt = ((ev.clientX - startX) / r2.width) * dur;
          const snapTargets = ev.shiftKey
            ? [0, dur, currentTime, ...layers.filter(o => !starts[o.id]).flatMap(o => [o.startTime || 0, o.endTime ?? dur])]
            : null;
          set('layers', (l) => l.map(x => {
            const st = starts[x.id]; if (!st) return x;
            let ns = Math.max(0, Math.min(dur - st.len, st.s + dt));
            if (snapTargets) {
              let best = ns, bd = dur * 0.025;
              for (const tg of snapTargets) {
                if (Math.abs(ns - tg) < bd) { bd = Math.abs(ns - tg); best = tg; }
                if (Math.abs(ns + st.len - tg) < bd) { bd = Math.abs(ns + st.len - tg); best = tg - st.len; }
              }
              ns = Math.max(0, Math.min(dur - st.len, best));
            }
            return { ...x, startTime: ns, endTime: ns + st.len };
          }));
        } else if (mode === 'reorder') {
          // Highlight the row currently under the cursor and magnetically snap
          // the lifted clip onto that track's centre line so the drop target is
          // unmistakable (the clip "sticks" to whichever track you hover).
          document.querySelectorAll('.etl-track-row.etl-reorder-hover').forEach(el => el.classList.remove('etl-reorder-hover'));
          const overId = rowIdFromPoint(ev.clientX, ev.clientY);
          const row = overId && document.querySelector(`.etl-track-row[data-layer-id="${CSS.escape(overId)}"]`);
          if (row) {
            if (overId !== id) row.classList.add('etl-reorder-hover');
            const snapDy = row.getBoundingClientRect().top - ownRowTop;
            clipEl.style.setProperty('--reorder-dy', `${snapDy}px`);
          } else {
            // Between rows / off the track list — follow the cursor freely.
            clipEl.style.setProperty('--reorder-dy', `${ev.clientY - startY}px`);
          }
        }
      };
      const up = (ev) => {
        // A real drag happened → swallow the click that browsers fire next, so
        // it can't fall through to the row handler and wipe a multi-selection.
        // Store a TIMESTAMP (not a bare flag): if the trailing click never comes
        // (e.g. released over another row), the value self-expires instead of
        // silently swallowing the next unrelated click.
        if (mode !== 'pending') suppressRowClickRef.current = Date.now();
        try { clipEl.classList.remove('etl-clip-reorder-active'); clipEl.style.removeProperty('--reorder-dy'); } catch {}
        document.querySelectorAll('.etl-track-row.etl-reorder-hover').forEach(el => el.classList.remove('etl-reorder-hover'));
        if (mode === 'reorder') {
          const overId = rowIdFromPoint(ev.clientX, ev.clientY);
          if (overId && overId !== id) reorderLayer(id, overId);
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
  }

  function makeClipHandleDrag(id, isStart) {
    if (id === '__mv__') {
      return (e) => {
        e.stopPropagation();
        pushUndo();
        const move = (ev) => {
          const r = timelineRef.current?.getBoundingClientRect(); if (!r) return;
          const t = Math.max(0, Math.min(dur, ((ev.clientX - r.left) / r.width) * dur));
          if (isStart) {
            setState((s) => ({ ...s, videoStart: Math.max(0, Math.min(s.videoEnd - 0.1, t)) }));
          } else {
            // Trim the main clip only — never extend the overall timeline
            setState((s) => ({ ...s, videoEnd: Math.max(s.videoStart + 0.1, Math.min(s.totalDuration, t)) }));
          }
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      };
    }
    return (e) => {
      e.stopPropagation();
      pushUndo();
      const move = (ev) => {
        const r = timelineRef.current?.getBoundingClientRect(); if (!r) return;
        const t = Math.max(0, Math.min(dur, ((ev.clientX - r.left) / r.width) * dur));
        if (isStart) {
          // Trimming the HEAD of a clip: move startTime AND shift srcStart so
          // the source IN-point moves with it. Without the srcStart update
          // the export plays the unstrimmed source while the preview seems
          // fine — they only match when srcStart tracks startTime.
          set('layers', (l) => l.map(x => {
            if (x.id !== id) return x;
            const oldStart = x.startTime || 0;
            const oldSrc = x.srcStart || 0;
            const isMedia = x.type === 'videoOverlay' || x.type === 'audio' || x.type === 'maskedVideo';
            // For media layers, we can only pull the head left by as much
            // source as we have BEFORE srcStart. Going further would extend
            // the clip on the timeline past the available source — and the
            // renderer would either freeze on the last frame or fill black.
            const minStart = isMedia ? Math.max(0, oldStart - oldSrc) : 0;
            const newStart = Math.max(minStart, Math.min(x.endTime - 0.1, t));
            const delta = newStart - oldStart;
            const next = { ...x, startTime: newStart };
            if (isMedia) {
              let newSrc = oldSrc + delta;
              if (newSrc < 0) newSrc = 0;
              if (x.srcDuration && newSrc > x.srcDuration - 0.05) newSrc = x.srcDuration - 0.05;
              next.srcStart = newSrc;
            }
            return next;
          }));
        }
        else set('layers', (l) => l.map(x => x.id === id ? { ...x, endTime: Math.max(x.startTime + 0.1, x.srcDuration ? Math.min(t, x.startTime + (x.srcDuration - (x.srcStart || 0))) : t) } : x));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
  }

  // Stop video + audio playback. Called whenever the user grabs the playhead
  // (timeline ruler or playback bar scrub) so scrubbing doesn't fight playback.
  function pausePlayback() {
    const v = videoRef.current;
    try { if (v && !v.paused) v.pause(); } catch {}
    setPlaying(false);
  }

  // Snap a candidate time `t` to the nearest clip edge / 0 / dur, when held.
  // Mirrors the per-layer snap behaviour so scrubbing feels consistent.
  function snapTime(t, shiftKey) {
    if (!shiftKey) return t;
    const targets = [0, dur];
    for (const o of layers) {
      targets.push(o.startTime || 0);
      targets.push(o.endTime ?? dur);
    }
    let best = t, bd = dur * 0.025;
    for (const tg of targets) {
      if (Math.abs(t - tg) < bd) { bd = Math.abs(t - tg); best = tg; }
    }
    return best;
  }

  function timelineSeek(e) {
    if (!timelineRef.current) return;
    const r = timelineRef.current.getBoundingClientRect();
    let t = Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
    t = snapTime(t, e.shiftKey);
    seekTo(t);
  }
  function onRulerPointerDown(e) {
    e.preventDefault();
    pausePlayback();
    timelineSeek(e);
    const move = ev => timelineSeek(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Determine the export "base" (input 0) the same way for export AND the
  // background preview-proxy, so the proxy renders the EXACT same composition.
  function computeExportBase() {
    const vids = layers.filter(l => l.type === 'videoOverlay' && !l.hidden);
    const auds = layers.filter(l => l.type === 'audio' && !l.hidden);
    const visibleVisuals = layers.filter(l => !l.hidden && (l.type === 'videoOverlay' || l.type === 'image' || l.type === 'maskedVideo'));
    const bottomVisual = visibleVisuals[0];
    const baseVid = (bottomVisual && bottomVisual.type === 'videoOverlay') ? bottomVisual : null;
    const baseAud = (!baseVid && !bottomVisual && auds.length > 0) ? auds[0] : null;
    const baseFile = baseVid?.file || baseAud?.file || vids[0]?.file || file || null;
    return { vids, auds, baseVid, baseAud, baseFile };
  }
  // Build the exact payload video:edit consumes. Overrides let the preview-proxy
  // reuse it at low res / temp path / preview channel — guaranteeing preview=output.
  function buildEditPayload({ outWidth: ow, outHeight: oh, outPath, format, quality, custom, preview }) {
    const { baseVid, baseAud, baseFile } = computeExportBase();
    if (!baseFile) return null;
    const baseAudioPayload = baseAud ? {
      srcStart: baseAud.srcStart || 0,
      length: Math.max(0.01, (baseAud.endTime ?? totalDuration) - (baseAud.startTime || 0)),
      startTime: baseAud.startTime || 0,
      volume: baseAud.volume ?? 100,
      muted: !!baseAud.muted,
    } : null;
    const hasAudioType = (l) => l.type === 'videoOverlay' || l.type === 'maskedVideo' || l.type === 'audio';
    return {
      file: baseFile,
      videoStart: baseVid ? (baseVid.startTime || 0) : baseAud ? (baseAud.startTime || 0) : (videoStart || 0),
      videoEnd: baseVid ? (baseVid.endTime ?? totalDuration) : baseAud ? (baseAud.endTime ?? totalDuration) : (videoEnd || totalDuration),
      totalDuration,
      mainVideo: baseVid ? { ...baseVid, type: 'mainVideo' } : (layers.find(l => l.type === 'mainVideo') || null),
      baseAudio: baseAudioPayload,
      baseAudioMuted: !!(baseAud && baseAud.muted),
      layers: layers
        .filter(l => l !== baseVid && l !== baseAud && l.type !== 'mainVideo' && !(l.hidden && !hasAudioType(l)))
        .map(l => l.type === 'subtitles'
          ? { ...l, _layout: subtitleLayoutsRef.current.get(l.id) || buildSubtitleLayout(l) }
          : l),
      outWidth: ow, outHeight: oh, bgColor, fadeIn, fadeOut, outPath,
      format, quality, custom, preview: !!preview,
    };
  }
  async function saveAs(fmt, qual) {
    const ext = fmt === 'mp3' ? 'mp3' : fmt === 'webm' ? 'webm' : 'mp4';
    const { baseFile } = computeExportBase();
    if (!baseFile) { alert('Нет ни одного видео или аудио для сохранения.'); return; }
    const outPath = await window.strata?.pickSaveAs?.(fileName(baseFile || '').replace(/\.[^.]+$/, '') + `_edit.${ext}`, fmt);
    if (!outPath) return;
    setSaveDialogOpen(false);
    setSaveFinishing(false);
    setSaveProgress(0);
    exportingRef.current = true;   // pause the preview-proxy buffer during export
    proxyTokenRef.current++;       // invalidate + kill any running proxy first
    try { window.strata?.cancelPreview?.(); } catch {}
    const off = window.strata?.onEditProgress?.((d) => {
      if (d.done) {
        // Render finished — keep the modal open to play the «finish» clip once.
        off?.(); playDoneSound();
        setSaveProgress(100); setSaveFinishing(true);
      } else {
        setSaveProgress(Math.round(d.percent || 0));
      }
    });
    const result = await window.strata?.editVideo?.(
      buildEditPayload({ outWidth, outHeight, outPath, format: fmt, quality: qual, custom: saveCustom })
    );
    exportingRef.current = false;
    if (result && !result.ok) { setSaveProgress(null); setSaveFinishing(false); alert('Ошибка: ' + result.error); }
    else if (result?.ok) window.strata?.revealFile?.(outPath);
  }

  // Background "buffer": render the whole timeline to a LOW-RES temp mp4 via the
  // SAME export pipeline (so it equals the output), streaming ffmpeg progress to
  // the buffered bar. Runs to completion regardless of play/pause → the bar fills
  // ahead while paused (YouTube-style). Invalidated (token bump) on any edit.
  async function buildPreviewProxy() {
    if (proxyRunningRef.current || exportingRef.current) return;
    const token = proxyTokenRef.current;
    if (proxyDoneTokenRef.current === token) return;   // both passes already done
    const { baseFile } = computeExportBase();
    if (!baseFile) return;
    const longSide = Math.max(outWidth, outHeight) || 1;
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    // Buffer AHEAD of the playhead first (the part about to be watched), then
    // fill the start — exactly like YouTube.
    const T = Math.max(0, Math.min(dur, currentTime));
    const segs = (T > 0.2 && T < dur - 0.2)
      ? [{ start: T, end: dur }, { start: 0, end: T }]
      : [{ start: 0, end: dur }];
    proxyRunningRef.current = true;

    // Render every segment at (ow×oh), tagging each finished mp4 with quality
    // rank `q` — the player always prefers the highest q available, so when the
    // hi-res pass lands it transparently upgrades the picture. `setBar`/`doneAcc`
    // drive the matching scrubber bar (low=orange faint, HD=brighter) with live
    // ffmpeg %; `slot` keeps temp paths unique.
    const renderPass = async (ow, oh, q, slot, setBar, doneAcc) => {
      const lo = (q === 0);
      // Live ffmpeg % → the render frontier. LOW merges it into its own (orange)
      // bar — the YouTube buffering feel. HD routes it to the SEPARATE striped
      // `bufferedHdLive` so it shows "rendering here", while the solid green
      // `bufferedHd` stays an HONEST "playable here" (set only on full completion).
      const off = window.strata?.onPreviewProgress?.((d) => {
        if (proxyTokenRef.current !== token) return;
        const seg = segs[Math.min(doneAcc.length, segs.length - 1)];
        const pct = d.done ? 100 : (d.percent || 0);
        const frontier = { s: seg.start, e: seg.start + (pct / 100) * (seg.end - seg.start) };
        if (lo) setBar([...doneAcc, frontier]); else setBufferedHdLive(frontier);
      });
      let ok = true;
      try {
        for (let i = 0; i < segs.length; i++) {
          if (proxyTokenRef.current !== token) { ok = false; break; }
          const seg = segs[i];
          let outPath;
          try { outPath = await window.strata?.previewProxyPath?.(token * 10 + slot + i); } catch { ok = false; break; }
          if (!outPath) { ok = false; break; }
          // LOW pass: 'fast' (veryfast/crf27) — speed, it's the temporary smooth
          // fallback. HD pass: near-visually-lossless crf16 at the FAST 'veryfast'
          // preset (crf = quality lever, preset = speed lever — so we get a render
          // fast enough to appear during watch AND a picture that matches the
          // UNcompressed paused canvas; crf27 was what read as "HD говно").
          const hi = q >= 1;
          const payload = buildEditPayload({ outWidth: ow, outHeight: oh, outPath, format: 'mp4', quality: hi ? 'custom' : 'fast', custom: hi ? { crf: 16, preset: 'veryfast' } : {}, preview: true });
          if (!payload) { ok = false; break; }
          payload.previewRange = { start: seg.start, end: seg.end };
          const res = await window.strata?.editVideo?.(payload);
          if (proxyTokenRef.current !== token) { ok = false; break; }
          if (res && res.ok === false) { console.warn('[proxy] segment render failed q=' + q + ' ' + ow + 'x' + oh + ':', (res.error || '').slice(0, 400)); ok = false; break; }
          // Complete, playable mp4 (faststart moov written on close) → register.
          proxyFilesRef.current = [
            ...proxyFilesRef.current.filter(f => f.url !== outPath),
            { appStart: seg.start, appEnd: seg.end, url: outPath, q, token },
          ];
          doneAcc.push({ s: seg.start, e: seg.end }); setBar([...doneAcc]);
          if (!lo) setBufferedHdLive(null);   // segment fully done → frontier resets
        }
      } catch (e) { console.warn('[proxy] pass error q=' + q, e); ok = false; }
      off?.();
      if (!lo) setBufferedHdLive(null);        // HD pass ended → clear the frontier
      return ok;
    };

    // PASS 1 — LOW res (≈480 long side): smooth playback ASAP + fills the bar.
    const loSc = Math.min(1, 480 / longSide);
    const loW = even(outWidth * loSc), loH = even(outHeight * loSc);
    const ok1 = await renderPass(loW, loH, 0, 0, setBuffered, []);

    // PASS 2 — FULL export resolution: play-HD then looks IDENTICAL to the
    // paused canvas (which renders at full res) → preview == export during
    // playback too. Swapped in by the player the moment each hi segment
    // finishes. Skipped if pass 1 was already full res (already-small projects).
    if (ok1 && proxyTokenRef.current === token) {
      const hiW = even(outWidth), hiH = even(outHeight);
      if (hiW > loW) await renderPass(hiW, hiH, 1, 5, setBufferedHd, []);
    }

    proxyRunningRef.current = false;
    if (proxyTokenRef.current === token) proxyDoneTokenRef.current = token;  // both passes done
  }

  const sel = selectedId ? layers.find(l => l.id === selectedId) : null;
  const timelineLayers = [...layers].reverse();
  // Subtitles need an audio source to transcribe. Videos are imported as
  // `videoOverlay` layers (state.file stays null in this flow), so gate the
  // button on the SAME sources the export audio-mix reads, not on state.file.
  const hasAudioSrc = !!file || layers.some(l => l && (
    l.type === 'mainVideo' ||
    (l.file && (l.type === 'videoOverlay' || l.type === 'maskedVideo' || l.type === 'audio'))
  ));

  function lColor(l) {
    if (l.clipColor) return l.clipColor;
    if (l.type === 'mainVideo') return '#38bdf8';
    if (l.type === 'text') return '#f472b6';
    if (l.type === 'blur') return '#818cf8';
    if (l.type === 'image') return '#4ade80';
    if (l.type === 'videoOverlay') return '#38bdf8';
    if (l.type === 'audio') return '#34d399';
    if (l.type === 'zoom') return '#fb923c';
    if (l.type === 'mask') return '#e879f9';
    if (l.type === 'maskedVideo') return '#c084fc';
    if (l.type === 'transition') return '#fde047';
    if (l.type === 'subtitles') return '#ff9a1f';
    return '#aaa';
  }
  function lIcon(l) {
    if (l.type === 'mainVideo') return '🎬';
    if (l.type === 'audio') return '🎵';
    if (l.type === 'mask') return '◐';
    if (l.type === 'maskedVideo') return '◐';
    if (l.type === 'transition') return '⚡';
    if (l.type === 'subtitles') return 'CC';
    return l.type === 'text' ? 'T' : l.type === 'blur' ? '◎' : l.type === 'image' ? '🖼' : '🎬';
  }
  function lName(l) {
    const rev = l.reversed ? ' ↺' : '';
    if (l.type === 'mainVideo') return compactName(fileName(l.file || ''), 9) + rev;
    if (l.type === 'text') return l.text?.slice(0, 8) || 'Текст';
    if (l.type === 'blur') return 'Блюр';
    if (l.type === 'zoom') return 'Зум';
    if (l.type === 'mask') return 'Маска';
    if (l.type === 'maskedVideo') return 'Вырезка' + rev;
    if (l.type === 'transition') {
      const kLbl = { shake: 'Удар', whippan: 'Whip pan', zoom: 'Zoom', blur: 'Blur' }[l.kind || 'shake'] || 'Переход';
      const s = typeof l.strength === 'number'
        ? Math.round(l.strength)
        : (l.strength === 'low' ? 25 : l.strength === 'high' ? 80 : l.strength === 'mid' ? 50 : null);
      return s != null ? `${kLbl} ${s}%` : kLbl;
    }
    if (l.type === 'subtitles') {
      const n = Array.isArray(l.segments) ? l.segments.length : 0;
      return `Субтитры (${n})`;
    }
    return compactName(fileName(l.file || ''), 9) + rev;
  }
  // Full, untruncated label for the hover tooltip on the timeline. File-based
  // layers show the complete file name; the rest reuse the short descriptive
  // label (it isn't truncated anyway).
  function lFull(l) {
    const rev = l.reversed ? ' ↺' : '';
    if (l.file) return fileName(l.file) + rev;
    if (l.type === 'text') return l.text || 'Текст';
    return lName(l);
  }

  function measureCtx() {
    let c = measureCanvasRef.current;
    if (!c) { c = document.createElement('canvas'); measureCanvasRef.current = c; }
    return c.getContext('2d');
  }
  // Cache text widths keyed by `text|font|size` — measureText is non-trivial
  // and was being called once per text layer per render frame. Cleared
  // periodically so the map doesn't accumulate forever.
  const textWidthCacheRef = useRef(new Map());
  function measureTextCached(text, font, fs) {
    const k = text + '|' + font + '|' + fs;
    const hit = textWidthCacheRef.current.get(k);
    if (hit !== undefined) return hit;
    const mc = measureCtx();
    mc.font = `${fs}px ${font}`;
    const tw = mc.measureText(text || ' ').width;
    textWidthCacheRef.current.set(k, tw);
    // Bound the cache: drop oldest half when it gets big.
    if (textWidthCacheRef.current.size > 512) {
      const keys = [...textWidthCacheRef.current.keys()].slice(0, 256);
      keys.forEach(kk => textWidthCacheRef.current.delete(kk));
    }
    return tw;
  }

  // Pre-compute the subtitle layout (absolute per-word centres, in output px)
  // using the SAME canvas measureText the preview draws with, and hand it to the
  // export. libass then positions each word at these exact coordinates with
  // \pos, so the burned-in subs match the preview pixel-for-pixel (no libass
  // wrapping/line-spacing of its own). Must run AFTER the subtitle font is
  // loaded (the font-loader effect handles that on layer change).
  function buildSubtitleLayout(subL) {
    const st = subL.style || {};
    const fsOrig = Math.max(8, Number(st.fontSize) || 56);
    const mc = measureCtx();
    // Natural font weight (no forced bold) — both the canvas preview AND the
    // libass export render the font's real outlines, so the outline thickness
    // matches 1:1. For a bold look the user picks a Bold font variant. Measuring
    // must also be non-bold so positions match the drawn (non-bold) glyphs.
    mc.font = `${fsOrig}px ${fontCss({ fontFamily: st.fontFamily, fontFile: st.fontFile })}`;
    const measure = (t) => mc.measureText(t || '').width;
    // The longest segment dictates how aggressively we have to shrink to fit
    // the box (so all segments share ONE font size and stay visually consistent
    // — instead of one short phrase being bigger than its neighbours).
    let layoutFs = fsOrig;
    const perSeg = (subL.segments || []).map((seg) => {
      const r = layoutSubtitleSegment(seg, st, outWidth, outHeight, measure);
      if (r.fs < layoutFs) layoutFs = r.fs;
      return r;
    });
    const scale = layoutFs / fsOrig;
    const segments = perSeg.map((r) => {
      const words = [];
      for (const line of r.lines) {
        for (const w of line.words) {
          // Re-scale word positions if some OTHER segment forced a smaller fs,
          // so every segment ends up at the same size around the phrase anchor.
          const cx = scale === 1 ? w.cx : phraseAnchor(st).x + (w.cx - phraseAnchor(st).x) * (layoutFs / r.fs);
          const cy = scale === 1 ? w.cy : phraseAnchor(st).y + (w.cy - phraseAnchor(st).y) * (layoutFs / r.fs);
          words.push({ text: w.text, cx: Math.round(cx), cy: Math.round(cy), w: Math.round(w.w * (layoutFs / r.fs)), start: w.start, end: w.end });
        }
      }
      return { start: r.segStart, end: r.segEnd, words };
    }).filter(s => s.words.length);
    return { W: outWidth, H: outHeight, fontSize: layoutFs, segments };
  }
  function phraseAnchor(st) {
    return { x: ((st.x ?? 50) / 100) * outWidth, y: ((st.y ?? 85) / 100) * outHeight };
  }

  // Single source of truth for a layer's on-canvas rectangle (in output pixels).
  // Used by the renderer, the selection outline and the interactive hit areas
  // so the preview, the bounding box and the export all agree.
  function getLayerPx(layer) {
    const W = outWidth, H = outHeight;
    if (layer.type === 'mainVideo') {
      const vid = videoRef.current;
      const aspect = layer.aspect || ((vid && vid.videoWidth) ? vid.videoWidth / vid.videoHeight : W / H);
      const w = (layer.size || 100) / 100 * W, h = w / aspect;
      return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
    }
    if (layer.type === 'videoOverlay') {
      const ov = videoOverlayRefs.current[layer.id];
      const aspect = layer.aspect || ((ov && ov.videoWidth) ? ov.videoWidth / ov.videoHeight : 16 / 9);
      const w = (layer.size || 40) / 100 * W, h = w / aspect;
      return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
    }
    if (layer.type === 'image') {
      const img = imgCacheRef.current.get(layer.file);
      const aspect = layer.aspect || ((img && img.naturalWidth) ? img.naturalWidth / img.naturalHeight : 1);
      const w = (layer.size || 30) / 100 * W, h = w / aspect;
      return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
    }
    if (layer.type === 'blur' || layer.type === 'mask' || layer.type === 'maskedVideo') {
      const w = (layer.width || 50) / 100 * W, h = (layer.height || 30) / 100 * H;
      return { w, h, x: (layer.x / 100) * W - w / 2, y: (layer.y / 100) * H - h / 2 };
    }
    if (layer.type === 'text') {
      const fs = layer.size || 48;
      const tw = measureTextCached(layer.text || ' ', fontCss(layer), fs);
      const w = tw + 24, h = fs * 1.4;
      const cx = (layer.x / 100) * W;
      const x = layer.align === 'left' ? cx - 12 : layer.align === 'right' ? cx - w + 12 : cx - w / 2;
      return { w, h, x, y: (layer.y / 100) * H - h / 2 };
    }
    if (layer.type === 'subtitles') {
      // Bounding box for the CURRENTLY active segment, so drag-to-move feels
      // like grabbing the visible text. Falls back to the longest segment's
      // width when nothing is currently active (so the box never collapses).
      const st = layer.style || {};
      const fs = Number(st.fontSize) || 56;
      const segs = Array.isArray(layer.segments) ? layer.segments : [];
      const active = segs.find(s => currentTime >= s.startTime && currentTime <= s.endTime)
        || segs.reduce((a, b) => (a && a.text.length >= b.text.length ? a : b), null)
        || { text: 'Субтитры' };
      const tw = measureTextCached(active.text || ' ', fontCss({ fontFamily: st.fontFamily, fontFile: st.fontFile }), fs);
      const w = tw + 36, h = fs * 1.5;
      const x = ((st.x ?? 50) / 100) * W - w / 2;
      const y = ((st.y ?? 85) / 100) * H - h / 2;
      return { w, h, x, y };
    }
    return { w: 0, h: 0, x: 0, y: 0 };
  }

  // Update canvas render function each render (closure over current state)
  // ── SINGLE SOURCE OF TRUTH for subtitle geometry ──────────────────────────
  // buildSubtitleLayout measures ONCE (wrapping, per-word centres, the global
  // auto-fit font size). BOTH the canvas preview AND the libass export consume
  // this exact layout, so they can never diverge on where text wraps, how big
  // it is, or where each word sits — the recurring preview↔render bugs all came
  // from measuring twice (preview on the live canvas, export on a separate one
  // that sometimes fell back to a different font). Keyed on a cheap signature so
  // it rebuilds only when subtitle content / style / canvas size / font load
  // state changes — not every frame.
  const subtitleLayoutSig = useMemo(() => layers
    .filter(l => l.type === 'subtitles')
    .map(l => l.id + ':' + JSON.stringify(l.style || {}) + ':' +
      (l.segments || []).map(s => `${s.startTime},${s.endTime},${s.text || ''},${(s.words || []).length}`).join('|'))
    .join('~') + `@${outWidth}x${outHeight}#${fontRevision}`,
    [layers, outWidth, outHeight, fontRevision]);
  const subtitleLayouts = useMemo(() => {
    const map = new Map();
    for (const l of layers) {
      if (l.type === 'subtitles' && Array.isArray(l.segments) && l.segments.length) {
        try { map.set(l.id, buildSubtitleLayout(l)); } catch {}
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleLayoutSig]);
  useEffect(() => { subtitleLayoutsRef.current = subtitleLayouts; }, [subtitleLayouts]);

  // Keep the render loop's playing flag current synchronously (effects run after
  // paint; the RAF tick must see the latest value the same frame).
  playingRef.current = playing;
  renderFrameRef.current = (ctx) => {
    const W = outWidth, H = outHeight;
    // LOW-RES PREVIEW: the canvas BACKING is W·S × H·S (S<1 while playing), and a
    // setTransform(S) maps the unchanged full-res [0,W]×[0,H] draw coords into it.
    // CSS upscales to display size; export is untouched (full res). Only the few
    // spots that snapshot the canvas onto itself (blur/mask/transition scratch
    // canvases) need to know S — everything else draws in full-res coords.
    const S = Math.max(0.1, Math.min(1, drawScaleRef.current || 1));
    const bw = Math.max(2, Math.round(W * S)), bh = Math.max(2, Math.round(H * S));
    if (ctx.canvas.width !== bw || ctx.canvas.height !== bh) { ctx.canvas.width = bw; ctx.canvas.height = bh; }
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgColor || '#000000';
    ctx.fillRect(0, 0, W, H);
    // Clipping-mask state for this frame: the first mask captures the full
    // composite (base + overlays) and resets the canvas to the pristine base;
    // every mask then stamps that composite inside its shape → union of holes.
    let maskInitDone = false;
    let maskVFull = null;
    for (const layer of layers) {
      if (layer.hidden) continue;
      if (layer.type === 'mainVideo') {
        if (currentTime >= videoStart && currentTime <= videoEnd) {
          const vid = layer.reversed ? (videoRevRef.current || videoRef.current) : videoRef.current;
          if (vid && vid.readyState >= 2) {
            const b = getLayerPx(layer);
            try { ctx.drawImage(vid, b.x, b.y, b.w, b.h); } catch(e) {}
          }
        }
        continue;
      }
      const ls = layer.startTime || 0, le = layer.endTime !== undefined ? layer.endTime : dur;
      if (currentTime < ls || currentTime > le) continue;
      if (layer.type === 'image') {
        const img = imgCacheRef.current.get(layer.file);
        if (img?.complete && img.naturalWidth > 0) {
          const b = getLayerPx(layer);
          ctx.globalAlpha = (layer.opacity || 100) / 100;
          try { ctx.drawImage(img, b.x, b.y, b.w, b.h); } catch(e) {}
          ctx.globalAlpha = 1;
        }
      } else if (layer.type === 'blur') {
        // Blur whatever is already on the canvas (every layer below this one).
        // Capture a padded region so the blur near the edges samples real
        // neighbouring pixels instead of hard-cutting at the blur frame.
        const b = getLayerPx(layer);
        const strength = Math.max(1, layer.strength || 10);
        const pad = Math.ceil(strength * 2.5);
        const cx0 = Math.max(0, Math.floor(b.x - pad)), cy0 = Math.max(0, Math.floor(b.y - pad));
        const cx1 = Math.min(W, Math.ceil(b.x + b.w + pad)), cy1 = Math.min(H, Math.ceil(b.y + b.h + pad));
        const cw = cx1 - cx0, ch = cy1 - cy0;
        if (cw > 0 && ch > 0) {
          const tmp = blurTmpRef.current || (blurTmpRef.current = document.createElement('canvas'));
          if (tmp.width !== cw) tmp.width = cw;
          if (tmp.height !== ch) tmp.height = ch;
          const tctx = tmp.getContext('2d');
          tctx.clearRect(0, 0, cw, ch);
          try { tctx.drawImage(ctx.canvas, cx0 * S, cy0 * S, cw * S, ch * S, 0, 0, cw, ch); } catch(e) {}
          ctx.save();
          ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
          ctx.filter = `blur(${strength}px)`;
          try { ctx.drawImage(tmp, 0, 0, cw, ch, cx0, cy0, cw, ch); } catch(e) {}
          ctx.filter = 'none';
          ctx.restore();
        }
      } else if (layer.type === 'mask') {
        // Clipping mask (cookie-cutter): inside the shape we keep the full
        // composition; OUTSIDE the shape we fall back to the main video base
        // (the lower layer), NOT a flat bgColor hole. Multiple masks UNION —
        // each cuts its own hole — so the FIRST active mask captures the full
        // composite and resets the canvas to the pristine base, then every
        // active mask stamps that composite inside its own shape. (The old code
        // re-derived the base per mask, so the 2nd mask erased the 1st's hole —
        // matching the export bug that dropped a mask on render.)
        const b = getLayerPx(layer);
        const r = Math.max(0, Math.min(Math.min(b.w, b.h) / 2, (layer.radius || 0) / 100 * Math.min(b.w, b.h) / 2));
        if (!maskInitDone) {
          // 1) Capture the full composite (base + every overlay below the masks).
          const vf = maskFullRef.current || (maskFullRef.current = document.createElement('canvas'));
          if (vf.width !== bw) vf.width = bw;
          if (vf.height !== bh) vf.height = bh;
          const vfx = vf.getContext('2d');
          vfx.setTransform(1, 0, 0, 1, 0, 0);
          vfx.clearRect(0, 0, bw, bh);
          try { vfx.drawImage(ctx.canvas, 0, 0); } catch(e) {}
          maskVFull = vf;
          // 2) Reset the canvas to the pristine base = bgColor + the main video
          //    only (mirrors the export's [vmaskBase] = pristine [vscaled]).
          ctx.save();
          ctx.fillStyle = bgColor || '#000000';
          ctx.fillRect(0, 0, W, H);
          const mv = layers.find(l => l.type === 'mainVideo');
          if (mv && !mv.hidden && currentTime >= videoStart && currentTime <= videoEnd) {
            const vid = mv.reversed ? (videoRevRef.current || videoRef.current) : videoRef.current;
            if (vid && vid.readyState >= 2) {
              const mb = getLayerPx(mv);
              try { ctx.drawImage(vid, mb.x, mb.y, mb.w, mb.h); } catch(e) {}
            }
          }
          ctx.restore();
          maskInitDone = true;
        }
        // 3) Stamp the captured composite inside THIS mask's shape (union).
        ctx.save();
        ctx.beginPath();
        if (layer.shape === 'circle') {
          ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
        } else if (layer.shape === 'rounded') {
          // Manual rounded-rect path (works in older Chromium without roundRect).
          const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
          ctx.moveTo(x0 + r, y0);
          ctx.lineTo(x1 - r, y0);
          ctx.arcTo(x1, y0, x1, y0 + r, r);
          ctx.lineTo(x1, y1 - r);
          ctx.arcTo(x1, y1, x1 - r, y1, r);
          ctx.lineTo(x0 + r, y1);
          ctx.arcTo(x0, y1, x0, y1 - r, r);
          ctx.lineTo(x0, y0 + r);
          ctx.arcTo(x0, y0, x0 + r, y0, r);
        } else {
          ctx.rect(b.x, b.y, b.w, b.h);
        }
        ctx.clip();
        if (maskVFull) { try { ctx.drawImage(maskVFull, 0, 0, W, H); } catch(e) {} }
        ctx.restore();
      } else if (layer.type === 'text') {
        const fs = layer.size || 48;
        ctx.save();
        ctx.font = `${fs}px ${fontCss(layer)}`;
        ctx.textAlign = layer.align || 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = (layer.opacity || 100) / 100;
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
        ctx.fillStyle = layer.color || '#ffffff';
        ctx.fillText(layer.text || '', (layer.x/100)*W, (layer.y/100)*H);
        ctx.restore();
      } else if (layer.type === 'subtitles') {
        const st = layer.style || {};
        // Box-area visualization moved to an HTML overlay (see preview layout
        // below) — that one is interactive: drag the dashed outline to move,
        // grab the corners/edges to resize. Drawing on canvas + HTML at the
        // same time would double the outline, so we skip the canvas draw.
        // WYSIWYG: show a phrase ONLY while the playhead is inside its
        // [start,end] window — exactly like the burned-in export. In the gaps
        // (silence, or time freed by shortening/deleting a phrase) the screen is
        // empty, both here and in the render. (Right after generation the
        // playhead is auto-jumped onto the first phrase, and clicking a phrase
        // in the list jumps to it, so subs are still easy to find.)
        // SINGLE SOURCE OF TRUTH: read the precomputed layout (shared with the
        // export) — never re-measure here, or preview and render could disagree
        // on wrapping/size/position. The layout stores flat positioned words
        // (line breaks already baked into each word's cy) + the global font size.
        const layout = subtitleLayouts.get(layer.id);
        if (!layout) continue;
        const segL = (layout.segments || []).find(s => currentTime >= s.start && currentTime <= s.end);
        if (!segL || !segL.words.length) continue;
        const fs = layout.fontSize;
        ctx.save();
        ctx.font = `${fs}px ${fontCss({ fontFamily: st.fontFamily, fontFile: st.fontFile })}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        // Wrap all active-segment words in one pseudo-line so the existing
        // per-word draw loop (animations, highlight, cursor) works unchanged.
        const lines = [{ words: segL.words }];
        const baseColor = st.color || '#ffffff';
        const outlineColor = st.outlineColor || '#000000';
        const highlightColor = st.highlightColor || '#ff9a1f';
        // Outline: external (a border outside the glyph) or none, with an explicit
        // thickness in px. Canvas strokeText straddles the path, so lineWidth =
        // 2×thickness gives an `olT`-px border OUTSIDE the glyph — matching libass
        // Outline=olT in the export 1:1.
        const olMode = (st.outlineMode === 'none' || st.outline === false) ? 'none' : 'external';
        const olT = (st.outlineWidth != null && st.outlineWidth !== '')
          ? Math.max(0, Number(st.outlineWidth))
          : Math.max(2, Math.round(fs * 0.04));
        const outlineW = Math.max(1, Math.round(olT * 2));   // canvas lineWidth
        ctx.lineWidth = outlineW;
        const anim = st.anim || 'pop';
        const segStart = Number(segL.start) || 0;
        // 'scale' animates the WHOLE phrase around its anchor (style.x/y point).
        const phraseCx = ((st.x ?? 50) / 100) * W, phraseCy = ((st.y ?? 85) / 100) * H;
        // Phrase-level entrance animations — wrap the whole word loop in a
        // single transform around the phrase anchor (style.x/y point).
        if (anim === 'scale' || anim === 'zoomout') {
          const from = anim === 'scale' ? SUB_ANIM.SCALE_FROM : SUB_ANIM.ZOUT_FROM;
          const ms   = anim === 'scale' ? SUB_ANIM.SCALE_MS   : SUB_ANIM.ZOUT_MS;
          const fadeMs = anim === 'scale' ? SUB_ANIM.SCALE_FADE_MS : SUB_ANIM.ZOUT_FADE_MS;
          const tau = (currentTime - segStart) * 1000;
          const p = Math.max(0, Math.min(1, tau / ms));
          const sc = from + (1 - from) * p;
          ctx.globalAlpha = Math.max(0, Math.min(1, tau / fadeMs));
          ctx.translate(phraseCx, phraseCy);
          ctx.scale(sc, sc);
          ctx.translate(-phraseCx, -phraseCy);
        }
        for (const line of lines) {
          for (let wi = 0; wi < line.words.length; wi++) {
            const w = line.words[wi];
            const appeared = currentTime >= w.start;
            // Typewriter / rise / bounce / typewriter-cursor reveal words only once their time arrives.
            if ((anim === 'type' || anim === 'rise' || anim === 'bounce' || anim === 'typewriter') && !appeared) continue;
            const isActive = currentTime >= w.start && currentTime <= w.end;
            const tau = (currentTime - w.start) * 1000;  // ms since the word started
            let wScale = 1, dy = 0, wAlpha = 1, wBlur = 0, wOutlineMul = 1, wDynColor = null;
            let wScaleX = 1, wScaleY = 1, wRot = 0, neonOutlineColor = null;
            if (anim === 'pop' && isActive) {
              wScale = 1 + (SUB_ANIM.POP_SCALE - 1) * Math.max(0, 1 - tau / SUB_ANIM.POP_MS);
            } else if (anim === 'rise') {
              dy = SUB_ANIM.RISE_OFFSET * Math.max(0, 1 - tau / SUB_ANIM.RISE_MS);
              wAlpha = Math.max(0, Math.min(1, tau / SUB_ANIM.RISE_FADE_MS));
            } else if (anim === 'bam' && isActive) {
              // 3-segment overshoot: 150% → 85% → 100%. Linear pieces — match ASS.
              if (tau < SUB_ANIM.BAM_MS1) {
                wScale = SUB_ANIM.BAM_FROM + (SUB_ANIM.BAM_MID - SUB_ANIM.BAM_FROM) * (tau / SUB_ANIM.BAM_MS1);
              } else if (tau < SUB_ANIM.BAM_MS2) {
                wScale = SUB_ANIM.BAM_MID + (1 - SUB_ANIM.BAM_MID) * ((tau - SUB_ANIM.BAM_MS1) / (SUB_ANIM.BAM_MS2 - SUB_ANIM.BAM_MS1));
              }
            } else if (anim === 'blurfocus' && isActive) {
              wBlur = SUB_ANIM.BLUR_PX * Math.max(0, 1 - tau / SUB_ANIM.BLUR_MS);
            } else if (anim === 'glow' && isActive) {
              // Triangle wave (linear ramp up & down) — matches ASS chained \t.
              const ph = (tau / SUB_ANIM.GLOW_MS) % 1;
              const tri = ph < 0.5 ? ph * 2 : (1 - ph) * 2;
              wOutlineMul = 1 + tri * (SUB_ANIM.GLOW_MUL - 1);
            } else if (anim === 'colorwave' && isActive) {
              const pal = SUB_ANIM.WAVE_COLORS;
              const idxF = tau / SUB_ANIM.WAVE_MS;
              const idx = Math.floor(idxF) % pal.length;
              const next = (idx + 1) % pal.length;
              wDynColor = lerpHex(pal[idx], pal[next], idxF - Math.floor(idxF));
            } else if (anim === 'neon' && isActive) {
              // Find which flicker stage tau falls into → alpha for that stage.
              for (const [t0, t1, a] of SUB_ANIM.NEON_STAGES) { if (tau >= t0 && tau < t1) { wAlpha = a; break; } }
              wOutlineMul = SUB_ANIM.NEON_BORD_MUL;
              neonOutlineColor = SUB_ANIM.NEON_COLOR;
            } else if (anim === 'shake' && isActive) {
              // Stagewise rotation jitter; linear lerp inside each stage.
              for (const [t0, t1, deg] of SUB_ANIM.SHAKE_STAGES) {
                if (tau >= t0 && tau < t1) {
                  // Lerp from PREVIOUS stage's deg → this stage's deg.
                  const prev = SUB_ANIM.SHAKE_STAGES[SUB_ANIM.SHAKE_STAGES.indexOf(SUB_ANIM.SHAKE_STAGES.find(([a,b]) => a === t0)) - 1];
                  const fromDeg = prev ? prev[2] : 0;
                  const p = (tau - t0) / Math.max(1, t1 - t0);
                  wRot = fromDeg + (deg - fromDeg) * p;
                  break;
                }
              }
            } else if (anim === 'bounce') {
              // Phase 1: drop from above (dy interp negative→0) while squashing fscy 140→100
              // Phase 2: impact squash fscx→120, fscy→70
              // Phase 3: settle back to 100/100
              const D = SUB_ANIM.BOUNCE_DROP_MS, S = SUB_ANIM.BOUNCE_SQUASH_MS, T = SUB_ANIM.BOUNCE_SETTLE_MS;
              if (tau < D) {
                const p = tau / D;
                dy = -SUB_ANIM.BOUNCE_OFFSET * (1 - p);
                wScaleX = (SUB_ANIM.BOUNCE_FROM_FSCX + (100 - SUB_ANIM.BOUNCE_FROM_FSCX) * p) / 100;
                wScaleY = (SUB_ANIM.BOUNCE_FROM_FSCY + (100 - SUB_ANIM.BOUNCE_FROM_FSCY) * p) / 100;
                wAlpha = Math.min(1, p * 1.5);
              } else if (tau < D + S) {
                const p = (tau - D) / S;
                wScaleX = (100 + (SUB_ANIM.BOUNCE_HIT_FSCX - 100) * p) / 100;
                wScaleY = (100 + (SUB_ANIM.BOUNCE_HIT_FSCY - 100) * p) / 100;
              } else if (tau < D + S + T) {
                const p = (tau - D - S) / T;
                wScaleX = (SUB_ANIM.BOUNCE_HIT_FSCX + (100 - SUB_ANIM.BOUNCE_HIT_FSCX) * p) / 100;
                wScaleY = (SUB_ANIM.BOUNCE_HIT_FSCY + (100 - SUB_ANIM.BOUNCE_HIT_FSCY) * p) / 100;
              }
            }
            ctx.save();
            if (wAlpha !== 1) ctx.globalAlpha = ctx.globalAlpha * wAlpha;
            if (wBlur > 0.1) ctx.filter = `blur(${wBlur}px)`;
            // Combined transform — uniform scale (pop/bam) OR independent X/Y (bounce) + rotation (shake)
            // around the word's anchor point (cx, cy+dy).
            const hasTransform = wScale !== 1 || wScaleX !== 1 || wScaleY !== 1 || wRot !== 0;
            if (hasTransform) {
              ctx.translate(w.cx, w.cy + dy);
              if (wRot !== 0) ctx.rotate(wRot * Math.PI / 180);
              if (wScale !== 1) ctx.scale(wScale, wScale);
              if (wScaleX !== 1 || wScaleY !== 1) ctx.scale(wScaleX, wScaleY);
              ctx.translate(-w.cx, -(w.cy + dy));
            }
            if (wOutlineMul !== 1) ctx.lineWidth = outlineW * wOutlineMul;
            // Outline first, then fill on top — TikTok/CapCut look. Skipped when none.
            if (olMode !== 'none' || neonOutlineColor) {
              ctx.strokeStyle = neonOutlineColor || outlineColor;
              ctx.strokeText(w.text, w.cx, w.cy + dy);
            }
            ctx.fillStyle = isActive ? (wDynColor || highlightColor) : baseColor;
            ctx.fillText(w.text, w.cx, w.cy + dy);
            ctx.restore();
            // Typewriter cursor — blinking `|` after the last revealed word in the segment.
            if (anim === 'typewriter') {
              const isLastRevealed = (wi === line.words.length - 1)
                || (currentTime < line.words[wi + 1]?.start);
              if (isLastRevealed) {
                const period = SUB_ANIM.TYPE_CURSOR_MS;
                const phase = ((currentTime - w.end) * 1000) / period;
                const visible = (Math.floor(phase * 2) % 2) === 0; // on/off halves
                if (visible) {
                  const cursorX = w.cx + (w.w || fs * 0.5) / 2 + fs * SUB_ANIM.TYPE_CURSOR_PAD;
                  if (olMode !== 'none') {
                    ctx.strokeStyle = outlineColor;
                    ctx.strokeText('|', cursorX, w.cy);
                  }
                  ctx.fillStyle = highlightColor;
                  ctx.fillText('|', cursorX, w.cy);
                }
              }
            }
          }
        }
        ctx.restore();
      } else if (layer.type === 'videoOverlay') {
        const ov = videoOverlayRefs.current[layer.id];
        const b = getLayerPx(layer);
        let cache = videoFrameCacheRef.current.get(layer.id);
        // Per-video colour correction — applied to the whole video layer.
        const ccf = `brightness(${100 + (layer.ccB || 0)}%) contrast(${layer.ccC ?? 100}%) saturate(${layer.ccS ?? 100}%) hue-rotate(${layer.ccH ?? 0}deg)`;
        const hasCC = ccf !== 'brightness(100%) contrast(100%) saturate(100%) hue-rotate(0deg)';
        if (hasCC) { ctx.save(); ctx.filter = ccf; }
        if (ov && ov.readyState >= 2 && ov.videoWidth) {
          try { ctx.drawImage(ov, b.x, b.y, b.w, b.h); } catch(e) {}
          // Keep the last good frame so scrubbing never flashes to black.
          if (!cache) { cache = document.createElement('canvas'); videoFrameCacheRef.current.set(layer.id, cache); }
          if (cache.width !== ov.videoWidth) cache.width = ov.videoWidth;
          if (cache.height !== ov.videoHeight) cache.height = ov.videoHeight;
          try { cache.getContext('2d').drawImage(ov, 0, 0); } catch(e) {}
        } else if (cache && cache.width) {
          try { ctx.drawImage(cache, b.x, b.y, b.w, b.h); } catch(e) {}
        }
        if (hasCC) ctx.restore();
      } else if (layer.type === 'maskedVideo') {
        const ov = videoOverlayRefs.current[layer.id];
        const b = getLayerPx(layer);
        const r = Math.max(0, Math.min(Math.min(b.w, b.h) / 2, (layer.radius || 0) / 100 * Math.min(b.w, b.h) / 2));
        // Frame cache — keeps the last successfully decoded video frame so the
        // cut-out doesn't go black during seek/play transients (same trick the
        // plain videoOverlay branch uses).
        let cache = videoFrameCacheRef.current.get(layer.id);
        // Refresh cache from the live video element when it's ready.
        if (ov && ov.readyState >= 2 && ov.videoWidth) {
          if (!cache) { cache = document.createElement('canvas'); videoFrameCacheRef.current.set(layer.id, cache); }
          if (cache.width !== ov.videoWidth) cache.width = ov.videoWidth;
          if (cache.height !== ov.videoHeight) cache.height = ov.videoHeight;
          try { cache.getContext('2d').drawImage(ov, 0, 0); } catch(e) {}
        }
        ctx.save();
        // Build the cut-out shape and clip to it.
        ctx.beginPath();
        if (layer.shape === 'circle') {
          ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
        } else if (layer.shape === 'rounded') {
          const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
          ctx.moveTo(x0 + r, y0);
          ctx.lineTo(x1 - r, y0);
          ctx.arcTo(x1, y0, x1, y0 + r, r);
          ctx.lineTo(x1, y1 - r);
          ctx.arcTo(x1, y1, x1 - r, y1, r);
          ctx.lineTo(x0 + r, y1);
          ctx.arcTo(x0, y1, x0, y1 - r, r);
          ctx.lineTo(x0, y0 + r);
          ctx.arcTo(x0, y0, x0 + r, y0, r);
        } else {
          ctx.rect(b.x, b.y, b.w, b.h);
        }
        ctx.clip();
        // Optional CC.
        const ccf = `brightness(${100 + (layer.ccB || 0)}%) contrast(${layer.ccC ?? 100}%) saturate(${layer.ccS ?? 100}%) hue-rotate(${layer.ccH ?? 0}deg)`;
        if (ccf !== 'brightness(100%) contrast(100%) saturate(100%) hue-rotate(0deg)') ctx.filter = ccf;
        // Always draw from the cache canvas — drawImage from a canvas is more
        // reliable than from a live <video> element that may be mid-seek.
        const src = (cache && cache.width) ? cache : null;
        if (src) {
          if (layer.srcCrop) {
            const c = layer.srcCrop;
            const sx = Math.max(0, Math.min(src.width - 1, c.x));
            const sy = Math.max(0, Math.min(src.height - 1, c.y));
            const sw = Math.max(1, Math.min(src.width - sx, c.w));
            const sh = Math.max(1, Math.min(src.height - sy, c.h));
            try { ctx.drawImage(src, sx, sy, sw, sh, b.x, b.y, b.w, b.h); } catch(e) {}
          } else {
            const vAsp = src.width / src.height;
            const bAsp = b.w / b.h;
            let dw, dh, dx, dy;
            if (vAsp > bAsp) { dh = b.h; dw = dh * vAsp; dx = b.x + (b.w - dw) / 2; dy = b.y; }
            else             { dw = b.w; dh = dw / vAsp; dx = b.x; dy = b.y + (b.h - dh) / 2; }
            try { ctx.drawImage(src, dx, dy, dw, dh); } catch(e) {}
          }
        }
        ctx.restore();
      } else if (layer.type === 'transition') {
        const tls = layer.startTime || 0, tle = layer.endTime ?? dur;
        const span = Math.max(0.01, tle - tls);
        const tProg = Math.max(0, Math.min(1, (currentTime - tls) / span));
        const t = currentTime;
        const kind = layer.kind || 'shake';
        // Triangle ramp 0 → 1 (mid) → 0; sine version is smoother.
        const peak = Math.sin(tProg * Math.PI);

        // Reusable snapshot canvas (already used by other layers). Sized to the
        // BACKING (bw×bh) so the self-snapshot is 1:1; draw-backs use ,W,H dest.
        const tmp = blurTmpRef.current || (blurTmpRef.current = document.createElement('canvas'));
        if (tmp.width !== bw) tmp.width = bw;
        if (tmp.height !== bh) tmp.height = bh;
        const tctx = tmp.getContext('2d');
        tctx.setTransform(1, 0, 0, 1, 0, 0);

        if (kind === 'shake') {
          // Shake + white flash combo (original).
          const amp = (layer.amp || 30);
          const decay = 1 - tProg * 0.85;
          const ox = (Math.sin(t * 113) * 0.6 + Math.sin(t * 187) * 0.4) * amp * decay;
          const oy = (Math.cos(t * 97)  * 0.6 + Math.cos(t * 151) * 0.4) * amp * decay;
          tctx.clearRect(0, 0, W, H);
          try { tctx.drawImage(ctx.canvas, 0, 0); } catch(e) {}
          ctx.fillStyle = bgColor || '#000000';
          ctx.fillRect(0, 0, W, H);
          try { ctx.drawImage(tmp, ox, oy, W, H); } catch(e) {}
          const flashMax = layer.flash ?? 0.85;
          let alpha;
          if (tProg < 0.15) alpha = (tProg / 0.15) * flashMax;
          else              alpha = Math.max(0, flashMax * (1 - (tProg - 0.15) / 0.85));
          if (alpha > 0.001) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, alpha);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, W, H);
            ctx.restore();
          }
        } else if (kind === 'whippan') {
          // Fast horizontal motion-blur swipe.
          const shiftMax = (layer.shift || 60) / 100 * W;
          const blurMax = layer.blur || 22;
          // The frame goes off to the right (or left) at midpoint, returns.
          // Direction baked into the sign of the shift curve.
          const xOff = Math.sin(tProg * Math.PI) * shiftMax; // 0 → +shift → 0
          const blurNow = blurMax * peak;
          tctx.clearRect(0, 0, W, H);
          try { tctx.drawImage(ctx.canvas, 0, 0); } catch(e) {}
          ctx.fillStyle = bgColor || '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.save();
          if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
          try { ctx.drawImage(tmp, xOff, 0, W, H); } catch(e) {}
          ctx.restore();
        } else if (kind === 'zoom') {
          // Zoom punch — up to 300%, with blur ramping with scale.
          const scaleMax = layer.scale || 2;
          const blurMax = layer.blur || 8;
          const scale = 1 + (scaleMax - 1) * peak;
          const blurNow = blurMax * peak;
          if (scale > 1.001 || blurNow > 0.5) {
            tctx.clearRect(0, 0, W, H);
            try { tctx.drawImage(ctx.canvas, 0, 0); } catch(e) {}
            ctx.clearRect(0, 0, W, H);
            ctx.save();
            if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
            const dw = W * scale, dh = H * scale;
            try { ctx.drawImage(tmp, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch(e) {}
            ctx.restore();
          }
        } else if (kind === 'blur') {
          // Burst of gaussian blur that resolves.
          const blurMax = layer.blur || 25;
          const blurNow = blurMax * peak;
          if (blurNow > 0.5) {
            tctx.clearRect(0, 0, W, H);
            try { tctx.drawImage(ctx.canvas, 0, 0); } catch(e) {}
            ctx.clearRect(0, 0, W, H);
            ctx.save();
            ctx.filter = `blur(${blurNow}px)`;
            try { ctx.drawImage(tmp, 0, 0, W, H); } catch(e) {}
            ctx.restore();
          }
        } else if (kind === 'seamzoom') {
          // Seamless zoom: camera "falls" into the frame with motion blur +
          // chromatic aberration + a peak white flash that hides the cut between
          // the outgoing and incoming clip. Curve is a sine peaking at midpoint.
          const scaleMax = layer.scale || 4.5;
          const blurMax = layer.blur || 16;
          const rgbMax = layer.rgb || 9;
          const flashMax = layer.flash ?? 0.28;
          const sc = 1 + (scaleMax - 1) * peak;
          const blurNow = blurMax * peak;
          const rgbNow = rgbMax * peak;
          // 1. Snapshot the current composition.
          tctx.clearRect(0, 0, W, H);
          try { tctx.drawImage(ctx.canvas, 0, 0); } catch(e) {}
          // 2. Repaint background, then the zoomed+blurred snapshot.
          ctx.fillStyle = bgColor || '#000000';
          ctx.fillRect(0, 0, W, H);
          const dw = W * sc, dh = H * sc;
          const dx = (W - dw) / 2, dy = (H - dh) / 2;
          ctx.save();
          if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
          try { ctx.drawImage(tmp, dx, dy, dw, dh); } catch(e) {}
          ctx.restore();
          // 3. Chromatic ghost — duplicate offsets in screen blend reads as
          // RGB aberration without needing a per-channel offscreen.
          if (rgbNow > 0.5) {
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.4;
            if (blurNow > 0.5) ctx.filter = `blur(${blurNow}px)`;
            try { ctx.drawImage(tmp, dx + rgbNow, dy, dw, dh); } catch(e) {}
            try { ctx.drawImage(tmp, dx - rgbNow, dy, dw, dh); } catch(e) {}
            ctx.restore();
          }
          // 4. White flash centred on the peak — hides the cut and gives punch.
          if (peak > 0.5) {
            const fAlpha = ((peak - 0.5) / 0.5) * flashMax;
            if (fAlpha > 0.001) {
              ctx.save();
              ctx.globalAlpha = Math.min(1, fAlpha);
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, W, H);
              ctx.restore();
            }
          }
        }
      } else if (layer.type === 'zoom') {
        // Zoom ramps the whole composition: 1× → max at the midpoint → 1× at the end.
        const zls = layer.startTime || 0, zle = layer.endTime ?? dur;
        const zspan = Math.max(0.1, zle - zls);
        const zp = (currentTime - zls) / zspan;
        const ztri = Math.max(0, zp < 0.5 ? zp * 2 : (1 - zp) * 2);
        const zfactor = 1 + (Math.max(0, layer.strength || 0) / 100) * ztri;
        if (zfactor > 1.001) {
          const tmp = zoomTmpRef.current || (zoomTmpRef.current = document.createElement('canvas'));
          if (tmp.width !== bw) tmp.width = bw;
          if (tmp.height !== bh) tmp.height = bh;
          const tctx = tmp.getContext('2d');
          tctx.setTransform(1, 0, 0, 1, 0, 0);
          tctx.clearRect(0, 0, bw, bh);
          try { tctx.drawImage(ctx.canvas, 0, 0); } catch(e) {}
          ctx.clearRect(0, 0, W, H);
          const dw = W * zfactor, dh = H * zfactor;
          try { ctx.drawImage(tmp, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch(e) {}
        }
      }
    }
    // Draw selection outlines
    const drawSel = (layer) => {
      const b = getLayerPx(layer);
      if (!b.w || !b.h) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,138,0,.95)'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
      ctx.strokeRect(b.x-3, b.y-3, b.w+6, b.h+6);
      ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,138,0,.95)';
      const hs = 8;
      [[b.x-3,b.y-3],[b.x+b.w-5,b.y-3],[b.x-3,b.y+b.h-5],[b.x+b.w-5,b.y+b.h-5]].forEach(([hx,hy]) => ctx.fillRect(hx, hy, hs, hs));
      ctx.restore();
    };
    for (const layer of layers) {
      if (!layer.hidden && (selectedId === layer.id || selectedIds.has(layer.id))) drawSel(layer);
    }
  };

  return <>
    {savePromptState && (
      <div className="sm-prompt-back" onClick={(e) => { if (e.target === e.currentTarget) answerSavePrompt('cancel'); }}>
        <div className="sm-prompt-modal" role="dialog" aria-modal="true">
          <div className="sm-prompt-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            </svg>
          </div>
          <div className="sm-prompt-body">
            <h2 className="sm-prompt-title">{savePromptState.message || 'Сохранить проект?'}</h2>
            {savePromptState.detail && <p className="sm-prompt-detail">{savePromptState.detail}</p>}
          </div>
          <div className="sm-prompt-actions">
            <button className="sm-prompt-btn sm-prompt-btn-ghost" onClick={() => answerSavePrompt('cancel')}>Отмена</button>
            <button className="sm-prompt-btn sm-prompt-btn-secondary" onClick={() => answerSavePrompt('dont-save')}>Не сохранять</button>
            <button className="sm-prompt-btn sm-prompt-btn-primary" onClick={() => answerSavePrompt('save')} autoFocus>Сохранить</button>
          </div>
        </div>
      </div>
    )}
    {saveProgress !== null && (() => {
      const lightTheme = document.documentElement.getAttribute('data-theme') === 'light';
      const cubeBg = lightTheme ? '#ebf1f8' : '#020202';
      const vidSrc = saveFinishing
        ? (lightTheme ? A.cubeFinishWhite : A.cubeFinishBlack)
        : (lightTheme ? A.cubeWaitWhite : A.cubeWaitBlack);
      return (
        <div className="editor-save-modal">
          <div className="editor-save-modal-box render-box" style={{ background: cubeBg }}>
            <video key={vidSrc} className="editor-save-modal-video" src={vidSrc}
              autoPlay muted playsInline loop={!saveFinishing} style={{ background: cubeBg }}
              onEnded={() => { if (saveFinishing) { setSaveProgress(null); setSaveFinishing(false); } }} />
            <div className="editor-save-modal-title" style={{ color: lightTheme ? '#1a1c25' : '#fff' }}>
              {saveFinishing ? 'Готово!' : 'Рендеринг'}
            </div>
            {!saveFinishing && <>
              <div className="editor-save-modal-pct">{saveProgress}%</div>
              <div className="editor-save-modal-bar-wrap" style={{ background: lightTheme ? '#d3d8e2' : '#121214' }}>
                <div className="editor-save-modal-bar" style={{ width: `${saveProgress}%` }} />
              </div>
              <RenderHint />
            </>}
          </div>
        </div>
      );
    })()}
    {editorHint && (
      <div key={editorHint.key} className={`ed-hint-toast ed-hint-${editorHint.kind}`}
        onClick={() => setEditorHint(null)}>
        <span className="ed-hint-icon" aria-hidden="true">
          {editorHint.kind === 'warn' ? '⚠' : editorHint.kind === 'error' ? '✕' : 'ℹ'}
        </span>
        <span className="ed-hint-text">{editorHint.text}</span>
        <button className="ed-hint-close" aria-label="Закрыть"
          onClick={(e) => { e.stopPropagation(); setEditorHint(null); }}>×</button>
      </div>
    )}
    {colorMenu && (
      <div className="etl-color-menu" style={{ left: colorMenu.x, top: colorMenu.y }} onPointerDown={e=>e.stopPropagation()}>
        {CLIP_COLORS.map(c => (
          <button key={c} className="etl-color-cube" style={{ background: c }} title={c}
            onClick={()=>{ updLayer(colorMenu.id, 'clipColor', c); setColorMenu(null); }} />
        ))}
      </div>
    )}
    {onboardStep >= 0 && onboardStep < ONBOARD_STEPS.length && (() => {
      const PAD = 8;
      const vw = window.innerWidth, vh = window.innerHeight;
      const CW = 344;
      const r = onbRect ? {
        x: Math.max(0, onbRect.x - PAD), y: Math.max(0, onbRect.y - PAD),
        w: onbRect.w + PAD * 2, h: onbRect.h + PAD * 2,
      } : null;
      // Position the tooltip so it never covers the highlighted control.
      let cardStyle;
      if (r) {
        const cx = Math.min(Math.max(14, r.x + r.w / 2 - CW / 2), vw - CW - 14);
        const below = vh - (r.y + r.h);
        if (below > 250) cardStyle = { top: r.y + r.h + 16, left: cx };
        else if (r.y > 250) cardStyle = { top: Math.max(14, r.y - 16), left: cx, transform: 'translateY(-100%)' };
        else if (vw - (r.x + r.w) > CW + 32) cardStyle = { left: r.x + r.w + 16, top: Math.min(Math.max(14, r.y), vh - 300) };
        else cardStyle = { left: Math.max(14, r.x - CW - 16), top: Math.min(Math.max(14, r.y), vh - 300) };
      } else {
        cardStyle = { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' };
      }
      return createPortal(
        <div className="ed-onboard-layer">
          {r ? (
            <>
              <div className="ed-onboard-block" style={{ top: 0, left: 0, width: vw, height: r.y }} />
              <div className="ed-onboard-block" style={{ top: r.y, left: 0, width: r.x, height: r.h }} />
              <div className="ed-onboard-block" style={{ top: r.y, left: r.x + r.w, width: vw - r.x - r.w, height: r.h }} />
              <div className="ed-onboard-block" style={{ top: r.y + r.h, left: 0, width: vw, height: vh - r.y - r.h }} />
              <div className="ed-onboard-dim" style={{ top: r.y, left: r.x, width: r.w, height: r.h }} />
              <div className="ed-onboard-ring" style={{ top: r.y, left: r.x, width: r.w, height: r.h }} />
              {ONBOARD_STEPS[onboardStep].drag && selectedId && (
                <div className="ed-onboard-drag" style={{ top: r.y + r.h / 2, left: r.x + r.w / 2 }}>⟶</div>
              )}
              {ONBOARD_STEPS[onboardStep].clickAdvance && (
                <div className="ed-onboard-catch" style={{ top: r.y, left: r.x, width: r.w, height: r.h }}
                  onClick={() => setOnboardStep(s => (s < ONBOARD_STEPS.length - 1 ? s + 1 : s))} />
              )}
            </>
          ) : (
            <div className="ed-onboard-mask ed-onboard-mask-full" />
          )}
          <div className="ed-onboard-card ed-onboard-card-float" style={cardStyle}>
            <button className="ed-onboard-x" onClick={closeOnboard} title="Закрыть">×</button>
            <div className="ed-onboard-step">Шаг {onboardStep + 1} из {ONBOARD_STEPS.length}</div>
            <h2>{ONBOARD_STEPS[onboardStep].t}</h2>
            <p>{ONBOARD_STEPS[onboardStep].d}</p>
            <div className="ed-onboard-nav">
              <div className="ed-onboard-dots">
                {ONBOARD_STEPS.map((_, i) => <i key={i} className={i === onboardStep ? 'on' : i < onboardStep ? 'done' : ''} />)}
              </div>
            </div>
            <label className="ed-onboard-skip">
              <input type="checkbox" checked={onboardSkip} onChange={e => setOnboardSkip(e.target.checked)} />
              Больше не показывать
            </label>
            <div className="ed-onboard-actions">
              {onboardStep >= ONBOARD_STEPS.length - 1
                ? <button className="btn primary" onClick={closeOnboard}>Все понял</button>
                : ONBOARD_STEPS[onboardStep].manual
                  ? <button className="btn primary" onClick={() => setOnboardStep(s => s + 1)}>Понял</button>
                  : null}
            </div>
          </div>
        </div>,
        document.body
      );
    })()}
    {confirmClearOpen && (
      <div className="modal-back" onClick={e => { if (e.target === e.currentTarget) setConfirmClearOpen(false); }}>
        <div className="result-modal ed-confirm-modal">
          <h2>Очистить редактор?</h2>
          <p className="ed-confirm-text">Все слои и медиа будут удалены.</p>
          <div className="modal-actions ed-confirm-actions">
            <button className="btn" onClick={() => setConfirmClearOpen(false)}>Отмена</button>
            <button className="btn primary ed-confirm-danger" onClick={doClearAll}>Очистить</button>
          </div>
        </div>
      </div>
    )}
    {projSaveProgress && (() => {
      // Same visual language as the video-render modal — Кубик waiting → finish
      // animation, so the user gets a single consistent "we're working on it"
      // experience for both video save and project save.
      const lightTheme = document.documentElement.getAttribute('data-theme') === 'light';
      const cubeBg = lightTheme ? '#ebf1f8' : '#020202';
      const done = projSaveProgress.phase === 'done';
      const vidSrc = done
        ? (lightTheme ? A.cubeFinishWhite : A.cubeFinishBlack)
        : (lightTheme ? A.cubeWaitWhite : A.cubeWaitBlack);
      const pct = Math.max(0, Math.min(100, Math.round(projSaveProgress.percent || 0)));
      return (
        <div className="editor-save-modal" onClick={(e) => e.stopPropagation()}>
          <div className="editor-save-modal-box render-box" style={{ background: cubeBg }}>
            <video key={vidSrc} className="editor-save-modal-video" src={vidSrc}
              autoPlay muted playsInline loop={!done} style={{ background: cubeBg }} />
            <div className="editor-save-modal-title" style={{ color: lightTheme ? '#1a1c25' : '#fff' }}>
              {done ? 'Сохранено!' : 'Сохраняем проект'}
            </div>
            {!done && <>
              <div className="editor-save-modal-pct">{pct}%</div>
              <div className="editor-save-modal-bar-wrap" style={{ background: lightTheme ? '#d3d8e2' : '#121214' }}>
                <div className="editor-save-modal-bar" style={{ width: `${pct}%` }} />
              </div>
              <div className="psp-status" style={{ color: lightTheme ? '#3a3d4a' : '#b0b0b6', marginTop: 8, fontSize: 13 }}>
                {projSaveProgress.fileName
                  ? <>Упаковываю <b>{projSaveProgress.fileName}</b></>
                  : 'Подготовка файлов…'}
              </div>
            </>}
          </div>
        </div>
      );
    })()}
    {subProgress && (
      <div className="editor-save-modal" onClick={(e) => e.stopPropagation()}>
        <div className="editor-save-modal-box save-fmt-dialog sub-gen-modal">
          {subProgress.phase === 'error' ? (
            <>
              <div className="editor-save-modal-title">Не получилось</div>
              <div className="sub-gen-err">{subProgress.error || 'Неизвестная ошибка'}</div>
              <div className="sub-gen-actions">
                <button className="sgm-btn-primary" onClick={() => setSubProgress(null)}>Закрыть</button>
              </div>
            </>
          ) : (
            <>
              <div className="editor-save-modal-title">
                {subProgress.phase === 'done' ? 'Готово!' : 'Распознаём речь…'}
              </div>
              <div className="psp-status">
                {subProgress.phase === 'extract' && 'Готовим звук проекта…'}
                {subProgress.phase === 'upload' && 'Отправляем в облако (Whisper)…'}
                {subProgress.phase === 'pack' && 'Раскладываем по словам…'}
                {subProgress.phase === 'done' && 'Субтитры добавлены на таймлайн'}
              </div>
              <div className="psp-bar"><i style={{ width: `${Math.max(2, Math.round(subProgress.percent || 0))}%` }} /></div>
              <div className="psp-meta">
                <span>{Math.round(subProgress.percent || 0)}%</span>
                <span className="sgm-engine">whisper-large-v3 · Groq</span>
              </div>
            </>
          )}
        </div>
      </div>
    )}
    {saveDialogOpen && (
      <div className="editor-save-modal" onClick={e => { if (e.target === e.currentTarget) setSaveDialogOpen(false); }}>
        <div className="editor-save-modal-box save-fmt-dialog">
          <div className="editor-save-modal-title">Сохранить видео</div>
          <div className="save-fmt-row">
            <span className="save-fmt-label">Формат</span>
            <div className="save-fmt-btns">
              {[['mp4','MP4 (H.264)'],['webm','WebM (VP9)'],['mp3','MP3 (аудио)']].map(([id,lbl]) => (
                <button key={id} className={`save-fmt-opt${saveFmt===id?' active':''}`} onClick={() => setSaveFmt(id)}>{lbl}</button>
              ))}
            </div>
          </div>
          <div className="save-fmt-row">
            <span className="save-fmt-label">Качество</span>
            <div className="save-fmt-btns">
              {[['max','Высокое'],['normal','Обычное'],['fast','Лёгкий вес'],['custom','Свои настройки']].map(([id,lbl]) => (
                <button key={id} className={`save-fmt-opt${saveQual===id?' active':''}`} onClick={() => setSaveQual(id)}>{lbl}</button>
              ))}
            </div>
          </div>
          {saveQual === 'custom' && (
            <div className="save-custom">
              <label className="field"><span>Битрейт видео, кбит/с (0 = по качеству)</span><input className="no-spin" type="number" min="0" max="100000" value={saveCustom.videoBitrate} onChange={e=>setSaveCustom(c=>({...c,videoBitrate:clamp(e.target.value,0,100000)}))} /></label>
              <label className="field"><span>Качество CRF (1–51)</span><input className="no-spin" type="number" min="1" max="51" value={saveCustom.crf} onChange={e=>setSaveCustom(c=>({...c,crf:clamp(e.target.value,1,51)}))} /></label>
              <label className="field"><span>Кадры/с (0 = как в исходнике)</span><input className="no-spin" type="number" min="0" max="120" value={saveCustom.fps} onChange={e=>setSaveCustom(c=>({...c,fps:clamp(e.target.value,0,120)}))} /></label>
              <label className="field"><span>Битрейт аудио, кбит/с</span><input className="no-spin" type="number" min="32" max="512" value={saveCustom.audioBitrate} onChange={e=>setSaveCustom(c=>({...c,audioBitrate:clamp(e.target.value,32,512)}))} /></label>
            </div>
          )}
          <div className="save-fmt-actions">
            <button className="btn secondary" onClick={() => setSaveDialogOpen(false)}>Отмена</button>
            <button className="btn primary" onClick={() => saveAs(saveFmt, saveQual)}>Сохранить</button>
          </div>
        </div>
      </div>
    )}
    <section className="card page-card editor-page" onDrop={onEditorDrop} onDragOver={(e) => e.preventDefault()}>

      {/* ── TOOLBAR ── */}
      <div className="ed-toolbar">
        <button className="ed-file-btn" data-onb="import" onClick={pickFile}>＋ Импорт</button>
        <button className="ed-file-btn ed-clear-btn" onClick={clearAll} disabled={!layers.length}>Очистить</button>
        {onboardStep < 0 && (
          <button className="ed-file-btn ed-learn-btn" onClick={() => setOnboardStep(0)} title="Запустить обучение заново">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1 2.7 3 6 3s6-2 6-3v-5"/></svg>
            Обучение
          </button>
        )}
        <div className="ed-toolbar-sep" />
        <div className="ed-toolbar-group">
          {[['1080×1920','1080','1920'],['1080×1350','1080','1350'],['1080×1080','1080','1080'],['1920×1080','1920','1080']].map(([lbl,w,h]) => (
            <button key={lbl} className={`ed-preset-btn${widthStr===w&&heightStr===h?' active':''}`}
              onClick={() => { set('outWidth',Number(w)); set('outHeight',Number(h)); setWidthStr(w); setHeightStr(h); }}>
              {lbl}
            </button>
          ))}
          <button className={`ed-preset-btn${(isCustomSize||dimFocused)?' active':''}`} title="Задать свой размер"
            onClick={() => dimWidthRef.current?.select()}>Свой</button>
          <input ref={dimWidthRef} className="ed-dim-inp" type="number" value={widthStr} onChange={e=>setWidthStr(e.target.value)}
            onFocus={()=>setDimFocused(true)}
            onBlur={()=>{const v=Math.max(100,Math.min(7680,Number(widthStr)||1080));setWidthStr(String(v));set('outWidth',v);setDimFocused(false);}}
            onKeyDown={e=>e.key==='Enter'&&e.target.blur()} />
          <span className="ed-dim-x">×</span>
          <input className="ed-dim-inp" type="number" value={heightStr} onChange={e=>setHeightStr(e.target.value)}
            onFocus={()=>setDimFocused(true)}
            onBlur={()=>{const v=Math.max(100,Math.min(7680,Number(heightStr)||1920));setHeightStr(String(v));set('outHeight',v);setDimFocused(false);}}
            onKeyDown={e=>e.key==='Enter'&&e.target.blur()} />
        </div>
        <div style={{flex:1}} />
        <button className="ed-file-btn ed-help-btn" onClick={()=>setHotkeysOpen(true)} title="Управление: горячие клавиши и жесты">
          <span className="ed-help-q" aria-hidden="true">?</span> Управление
        </button>
      </div>

      {/* ── WORKSPACE: Preview + Properties ── */}
      {(!file && !layers.length) ? (
        <div className="card wide upload-card editor-upload-card" onClick={pickFile}>
          <img className="upload-bg" src={A.upload} />
          <h2>Перетащи медиа сюда</h2>
          <p>или нажми, чтобы импортировать медиа</p>
        </div>
      ) : (
        <div className="ed-workspace">

        {/* Preview column */}
        <div className="ed-preview-col">
          {/* Hidden video elements for canvas frame capture */}
          {file && <video ref={videoRef} key={file} src={fileUrl(file)} muted playsInline preload="metadata"
            onLoadedMetadata={onVideoMeta} onTimeUpdate={onTimeUpdate}
            style={{ position:'fixed', top:0, left:0, width:1, height:1, opacity:0, pointerEvents:'none' }} />}
          {file && <video ref={videoRevRef} key={`rev-${file}`} src={fileUrl(file)} muted playsInline preload="auto"
            style={{ position:'fixed', top:0, left:0, width:1, height:1, opacity:0, pointerEvents:'none' }} />}
          {/* Audio-only mirror of each video layer's soundtrack. Use proxy
              when available so HEVC/AV1 files actually play in preview. */}
          {layers.filter(l => l.type === 'videoOverlay' || l.type === 'maskedVideo').map(l => (
            <audio key={`a-${l.id}-${l._proxyFile ? 'p' : 'o'}`}
              ref={el => { if (el) videoAudioRefs.current[l.id] = el; else delete videoAudioRefs.current[l.id]; }}
              src={fileUrl(l._proxyFile || l.file)} preload="auto"
              style={{ display:'none' }} />
          ))}
          {layers.filter(l => l.type === 'videoOverlay' || l.type === 'maskedVideo').map(l => (
            <video key={`${l.id}-${l._proxyFile ? 'p' : 'o'}`}
              ref={el => { if (el) videoOverlayRefs.current[l.id] = el; else delete videoOverlayRefs.current[l.id]; }}
              src={fileUrl(l._proxyFile || l.file)} muted playsInline preload="auto"
              onError={() => {
                // Silent safety net: if the proactive proxy didn't fire (e.g.
                // a file that probed as supported but turned out to fail at
                // decode time), kick off a forced proxy build now. No UI.
                if (l._proxyFile) return;
                window.strata?.makeProxy?.({ file: l.file, force: true }).then(res => {
                  if (res?.ok && res.proxyPath) {
                    setState(s => ({ ...s, layers: s.layers.map(x =>
                      x.id === l.id ? { ...x, _proxyFile: res.proxyPath } : x) }));
                  }
                });
              }}
              onLoadedMetadata={(e) => {
                const d = e.target.duration;
                const vw = e.target.videoWidth, vh = e.target.videoHeight;
                const nAR = (vw && vh) ? vw / vh : null;
                if (!(d > 0)) return;
                setState((s) => {
                  const next = { ...s };
                  const autoFit = Math.abs(s.totalDuration - 10) < 0.01;
                  if (autoFit) next.totalDuration = d;
                  const frameAR = s.outWidth / s.outHeight;
                  next.layers = s.layers.map((lay) => {
                    if (lay.id !== l.id) return lay;
                    const srcDur = lay.srcDuration || d;
                    const maxEnd = (lay.startTime || 0) + Math.max(0.1, srcDur - (lay.srcStart || 0));
                    const newEnd = autoFit ? maxEnd : Math.min(lay.endTime ?? maxEnd, maxEnd);
                    const out = { ...lay, srcDuration: srcDur, endTime: newEnd };
                    // First load → scale to COVER the whole preview frame (fill to
                    // all borders, crop overflow), not just match the main video.
                    if (lay.fitCover && nAR) {
                      out.aspect = nAR;
                      out.size = 100 * Math.max(1, nAR / frameAR);
                      out.x = 50; out.y = 50;
                      out.fitCover = false;
                    }
                    return out;
                  });
                  return next;
                });
              }}
              style={{ position:'fixed', top:0, left:0, width:1, height:1, opacity:0, pointerEvents:'none' }} />
          ))}
          {layers.filter(l => l.type === 'audio').map(l => (
            <audio key={l.id}
              ref={el => { if (el) audioLayerRefs.current[l.id] = el; else delete audioLayerRefs.current[l.id]; }}
              src={fileUrl(l.file)} preload="auto"
              onLoadedMetadata={(e) => {
                const d = e.target.duration;
                if (!(d > 0) || !isFinite(d)) return;
                setState((s) => {
                  const next = { ...s };
                  // Auto-fit the project length to this audio if the user hasn't
                  // touched the duration yet (still the default 10s).
                  const autoFit = Math.abs(s.totalDuration - 10) < 0.01;
                  if (autoFit) next.totalDuration = d;
                  next.layers = s.layers.map((lay) => {
                    if (lay.id !== l.id) return lay;
                    const srcDur = lay.srcDuration || d;
                    const maxEnd = (lay.startTime || 0) + Math.max(0.1, srcDur - (lay.srcStart || 0));
                    // If we just expanded the project to fit this audio, also
                    // stretch the clip itself to span the full new duration.
                    const newEnd = autoFit ? maxEnd : Math.min(lay.endTime ?? maxEnd, maxEnd);
                    // Remember real source length so the right-handle drag can't
                    // stretch the clip past it (matches video-layer behaviour).
                    return { ...lay, srcDuration: srcDur, endTime: newEnd };
                  });
                  return next;
                });
              }}
              style={{ display:'none' }} />
          ))}

          <div className="ed-preview-wrap" data-onb="preview"
            onPointerDown={startPreviewPan}
            style={{ flex: '0 0 auto', height: previewH, position:'relative', cursor: 'grab' }}>
            <div ref={canvasRef} style={{ position:'relative', height:'100%', width:'auto', maxWidth:'100%', aspectRatio:`${outWidth}/${outHeight}`, transform:`translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`, transformOrigin:'center center', transition:'transform .08s linear' }}>
                {/* Clip layer: only the rendered canvas + orange frame get clipped
                    to the project rect. The interactive bounding boxes/handles
                    (rendered as siblings below) are NOT clipped so the user can
                    still grab corners when a layer is scaled larger than the
                    preview area. */}
                <div className="ed-preview-clip" style={{ position:'absolute', inset:0, overflow:'hidden', background:'#000', borderRadius:'10px' }}>
                  <canvas ref={previewCanvasRef}
                    style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', display:'block', pointerEvents:'none' }} />
                  {/* Phase 2 play-from-proxy: muted picture source that overlays
                      the canvas while a rendered proxy segment covers the playhead
                      (mp4 AR == project AR → objectFit:fill matches the canvas). */}
                  <video ref={proxyVideoRef} muted playsInline preload="auto"
                    style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', objectFit:'fill', display: (proxyPlay && !previewFullscreen) ? 'block' : 'none', pointerEvents:'none', zIndex:2, background:'#000' }} />
                  {/* Diagnostic badge — what the preview is showing right now. */}
                  <div style={{ position:'absolute', top:4, left:4, zIndex:6, font:'11px monospace', fontWeight:700, color: proxyDbg.startsWith('PROXY q1') ? '#7CFC6A' : proxyDbg.startsWith('PROXY q0') ? '#ffd24a' : '#9fd0ff', background:'rgba(0,0,0,.66)', padding:'2px 6px', borderRadius:4, pointerEvents:'none', letterSpacing:'.3px' }}>{proxyDbg || 'canvas'}</div>
                  {/* Subtle frame — the project rect is defined by contrast between
                      the black canvas and the gray preview surround; only a thin
                      hairline on top to make the edge crisp. */}
                  <div aria-hidden="true" style={{ position:'absolute', inset:0, border:'1px solid rgba(255,255,255,.12)', pointerEvents:'none', zIndex:3 }} />
                </div>
                {/* Invisible hit-area divs for interaction — sized to the real
                    on-canvas rectangle so the bounding box always wraps the
                    whole element. Corners stretch, edges resize proportionally.
                    These render OUTSIDE the clip — handles stay grabbable even
                    when the layer extends beyond the preview bounds. */}
                {/* Skip subtitle layers — they have their own canvas-drawn orange
                    box-area visualization that matches their actual style.x/y/boxW
                    layout. The generic getLayerPx() rectangle for subs is wrong
                    and the resize handles don't tie to anything meaningful. */}
                {layers.filter(l => !l.hidden && l.type !== 'audio' && l.type !== 'subtitles').map(layer => {
                  if (layer.type !== 'mainVideo' &&
                      (currentTime < (layer.startTime||0) || currentTime > (layer.endTime??dur))) return null;
                  const isSel = selectedId === layer.id || selectedIds.has(layer.id);
                  const b = getLayerPx(layer);
                  return (
                    <div key={layer.type==='text'?`${layer.id}-${fontRevision}`:layer.id}
                      onPointerDown={makePreviewDrag(layer.id)}
                      style={{ position:'absolute',
                        left:`${b.x/outWidth*100}%`, top:`${b.y/outHeight*100}%`,
                        width:`${b.w/outWidth*100}%`, height:`${b.h/outHeight*100}%`,
                        cursor:'move', userSelect:'none', touchAction:'none', background:'transparent',
                        border: isSel ? '1px dashed rgba(255,255,255,.85)' : undefined,
                        boxShadow: isSel ? '0 0 0 1px rgba(0,0,0,.55)' : undefined }}>
                      {layer.reversed && <span className="ed-reversed-badge">⏪</span>}
                      {isSel && ['nw','n','ne','e','se','s','sw','w'].map(h =>
                        <div key={h} className={`preview-rh preview-rh-${h}`}
                          onPointerDown={makePreviewResize(layer.id, h)} />)}
                    </div>
                  );
                })}
                {/* Photoshop-style subtitle text box. Visible when a subtitle
                    layer is selected. WIDTH = boxW (the wrap width — drag the
                    left/right handles to control where lines break). HEIGHT auto-
                    follows the actual text block so the frame always hugs the text
                    (one clean box, no mismatch). Body drag = move; font size is the
                    panel slider, never the box. */}
                {(() => {
                  const subSel = layers.find(l => l.id === selectedId && l.type === 'subtitles' && !l.hidden);
                  if (!subSel) return null;
                  const st = subSel.style || {};
                  const boxW = Math.max(10, Math.min(300, Number(st.boxW) || 88));
                  const cx = st.x ?? 50, cy = st.y ?? 85;
                  // Auto-height: measure the active (or first) segment's text block
                  // from the shared layout so the frame snugly wraps the text.
                  let boxHpct = ((Number(st.fontSize) || 56) * ((st.lineHeight ?? 125) / 100) / outHeight) * 100 + 3;
                  const subLayout = subtitleLayouts.get(subSel.id);
                  if (subLayout && subLayout.segments.length) {
                    const segL = subLayout.segments.find(s => currentTime >= s.start && currentTime <= s.end) || subLayout.segments[0];
                    if (segL && segL.words.length) {
                      const cys = segL.words.map(w => w.cy);
                      const lineH = subLayout.fontSize * ((st.lineHeight ?? 125) / 100);
                      const blockPx = (Math.max(...cys) - Math.min(...cys)) + lineH;
                      boxHpct = (blockPx / outHeight) * 100 + 3;
                    }
                  }
                  return (
                    <div className="sub-box-overlay"
                      onPointerDown={makePreviewDrag(subSel.id)}
                      style={{ position:'absolute',
                        left:`${cx - boxW/2}%`, top:`${cy - boxHpct/2}%`,
                        width:`${boxW}%`, height:`${boxHpct}%`,
                        cursor:'move', touchAction:'none', userSelect:'none' }}>
                      {['e','w'].map(h =>
                        <div key={h} className={`preview-rh preview-rh-${h}`}
                          onPointerDown={makeSubBoxResize(subSel.id, h)} />)}
                    </div>
                  );
                })()}
              </div>
            {/* Zoom controls — bottom-right corner of preview. The "100%"
                label is a scrubber: hold + drag up/down to zoom in/out
                continuously (1.2% per pixel), so users can dial in an exact
                zoom without clicking ± repeatedly. */}
            <div className="preview-zoom-ctrl">
              <button onClick={(e) => { e.stopPropagation(); setPreviewZoom(z => Math.max(0.3, z / 1.2)); }} title="Уменьшить (−)">−</button>
              <span className={`zoom-pct zoom-pct-scrub${zoomScrubActive ? ' active' : ''}`}
                title="Тяни вверх/вниз чтобы менять зум"
                onPointerDown={(e) => {
                  e.stopPropagation(); e.preventDefault();
                  const startY = e.clientY;
                  const startZ = previewZoom;
                  const el = e.currentTarget;
                  try { el.setPointerCapture(e.pointerId); } catch {}
                  setZoomScrubActive(true);
                  const onMove = (ev) => {
                    const dy = startY - ev.clientY;       // up = positive
                    const factor = Math.pow(1.012, dy);   // 1.2 % per px
                    const next = Math.max(0.3, Math.min(5, startZ * factor));
                    setPreviewZoom(+next.toFixed(3));
                  };
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    try { el.releasePointerCapture(e.pointerId); } catch {}
                    setZoomScrubActive(false);
                  };
                  window.addEventListener('pointermove', onMove);
                  window.addEventListener('pointerup', onUp);
                }}>{Math.round(previewZoom * 100)}%
                {zoomScrubActive && (() => {
                  // Vertical track that appears while dragging. Log-scale maps
                  // the 30 %–500 % range onto a 0-1 position so the thumb feels
                  // proportional through the whole range (linear would crowd
                  // everything below 100 %).
                  const MIN = 0.3, MAX = 5;
                  const pos = Math.log(previewZoom / MIN) / Math.log(MAX / MIN);
                  return (
                    <span className="zoom-scrub-track" aria-hidden="true">
                      <span className="zoom-scrub-label top">500%</span>
                      <span className="zoom-scrub-bar">
                        <span className="zoom-scrub-mid" />
                        <span className="zoom-scrub-thumb" style={{ bottom: `${pos * 100}%` }} />
                      </span>
                      <span className="zoom-scrub-label bot">30%</span>
                    </span>
                  );
                })()}
              </span>
              <button onClick={(e) => { e.stopPropagation(); setPreviewZoom(z => Math.min(5, z * 1.2)); }} title="Увеличить (+)">+</button>
              <button onClick={(e) => { e.stopPropagation(); resetPreviewZoom(); }} title="Сбросить (1:1)" className="zoom-reset">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            </div>
          </div>

          {/* Preview resize handle */}
          <div className="ed-preview-resize"
            onPointerDown={e => {
              e.preventDefault();
              const startY = e.clientY, startH = previewH;
              const move = ev => setPreviewH(Math.max(120, Math.min(700, startH + ev.clientY - startY)));
              const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          />

          {/* Playback bar */}
          <div className="ed-playback">
            <button className="ed-pb-btn ed-pb-play" onClick={togglePlay}>{playing ? '⏸' : '▶'}</button>
            <div className="ed-scrub" onPointerDown={scrubPointerDown}>
              {renderBuffered()}<div className="ed-scrub-fill" style={{ width:pct(currentTime) }} />
              <div className="ed-scrub-head" style={{ left:pct(currentTime) }} />
            </div>
            <span className="ed-time">{fmt(currentTime)}</span>
            <span className="ed-time-sep">/</span>
            <input className="ed-dur-inp" data-onb="duration" type="text" inputMode="decimal" value={durStr} title="Длительность, сек"
              onChange={e=>setDurStr(e.target.value)} onBlur={commitDuration} onKeyDown={e=>e.key==='Enter'&&e.target.blur()} />
            <span className="ed-time-unit">с</span>
            <button className="ed-pb-btn ed-pb-fs" onClick={()=>setPreviewFullscreen(true)} title="Полный экран (предпросмотр)">⛶</button>
          </div>

          {/* Fullscreen preview overlay — a second canvas painted by the same
              render loop, shown over everything and pushed into real OS
              fullscreen. ESC or the ✕ button exits. */}
          {previewFullscreen && (
            <div ref={fsOverlayRef} className="ed-fs-overlay"
              style={{ position:'fixed', inset:0, zIndex:9999, background:'#000', display:'flex', flexDirection:'column' }}>
              <div style={{ position:'relative', flex:'1 1 auto', display:'flex', alignItems:'center', justifyContent:'center', minHeight:0, overflow:'hidden' }}>
                <canvas ref={fsCanvasRef}
                  style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }} />
                {/* Phase 2b: fullscreen proxy picture (same slave model as inline). */}
                <video ref={proxyVideoFsRef} muted playsInline preload="auto"
                  style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'contain', display: (proxyPlay && previewFullscreen) ? 'block' : 'none', pointerEvents:'none', background:'#000' }} />
              </div>
              <div className="ed-playback ed-playback-fs"
                style={{ flex:'0 0 auto', display:'flex', alignItems:'center', gap:'10px', padding:'10px 16px', background:'rgba(20,20,22,.92)' }}>
                <button className="ed-pb-btn ed-pb-play" onClick={togglePlay}>{playing ? '⏸' : '▶'}</button>
                <div className="ed-scrub" style={{ flex:'1 1 auto' }} onPointerDown={scrubPointerDown}>
                  {renderBuffered()}<div className="ed-scrub-fill" style={{ width:pct(currentTime) }} />
                  <div className="ed-scrub-head" style={{ left:pct(currentTime) }} />
                </div>
                <span className="ed-time">{fmt(currentTime)}</span>
                <span className="ed-time-sep">/</span>
                <span className="ed-time">{fmt(dur)}</span>
                <button className="ed-pb-btn ed-pb-fs" onClick={()=>setPreviewFullscreen(false)} title="Выйти (Esc)">✕</button>
              </div>
            </div>
          )}
        </div>

        {/* Properties panel — wrapped so it can be absolutely sized to the
            preview column's height (it scrolls internally instead of inflating
            the workspace row, which would push the timeline far below). */}
        <div className="ed-props-col">
        <div className="ed-props">
          <div className="ed-props-tabs" data-onb="tabs">
            <button className={`ed-props-tab${edPropTab==='props'?' active':''}`} data-onb="propstab" onClick={()=>setEdPropTab('props')}>Свойства</button>
            <button className={`ed-props-tab${edPropTab==='effects'?' active':''}`} data-onb="effects" onClick={()=>setEdPropTab('effects')}>🎛 Эффекты</button>
          </div>
          {edPropTab === 'props' && <>

          {/* Main video properties */}
          {sel?.type === 'mainVideo' && (
            <div className="ed-prop-block ed-prop-sel">
              <div className="ed-prop-head">🎬 {compactName(fileName(sel.file||''), 16)}</div>
              <div className="ed-info-grid">
                <span>Начало</span><b>{fmt(videoStart)}</b>
                <span>Конец</span><b>{fmt(videoEnd)}</b>
                <span>Длина</span><b>{fmt(videoEnd - videoStart)}</b>
              </div>
              <Slider label="Размер, %" value={Math.round(sel.size||100)} min="10" max="200" onChange={v=>updLayer(sel.id,'size',v)} />
              <Slider label="Громкость, %" value={sel.volume??100} min="0" max="200" onChange={v=>updLayer(sel.id,'volume',v)} />
              <p className="ed-hint">Тяни за ручки на таймлайне для обрезки</p>
            </div>
          )}

          {/* Image properties */}
          {sel?.type === 'image' && (
            <div className="ed-prop-block ed-prop-sel">
              <div className="ed-prop-head">🖼 {compactName(fileName(sel.file||''), 16)}</div>
              <Slider label="Размер, %" value={sel.size} min="5" max="200" onChange={v=>updLayer(sel.id,'size',v)} />
              <Slider label="Прозрачность, %" value={sel.opacity} min="0" max="100" onChange={v=>updLayer(sel.id,'opacity',v)} />
            </div>
          )}

          {/* Blur properties */}
          {sel?.type === 'blur' && (
            <div className="ed-prop-block ed-prop-sel">
              <div className="ed-prop-head">◎ Блюр</div>
              <Slider label="Ширина, %" value={sel.width} min="5" max="100" onChange={v=>updLayer(sel.id,'width',v)} />
              <Slider label="Высота, %" value={sel.height} min="5" max="100" onChange={v=>updLayer(sel.id,'height',v)} />
              <Slider label="Сила блюра" value={sel.strength} min="1" max="50" onChange={v=>updLayer(sel.id,'strength',v)} />
            </div>
          )}

          {/* Mask + masked-video share the same shape-editor block. */}
          {(sel?.type === 'mask' || sel?.type === 'maskedVideo') && (() => {
            const locked = sel.shape === 'circle' || sel.shape === 'square';
            // For "Размер" slider in locked mode: edit the larger pixel dim.
            const sizePx = Math.max((sel.width / 100) * outWidth, (sel.height / 100) * outHeight);
            const updSize = (px) => set('layers', ls => ls.map(x => x.id === sel.id ? {
              ...x,
              width: clamp((px / outWidth) * 100, 5, 300),
              height: clamp((px / outHeight) * 100, 5, 300),
            } : x));
            const maxPx = Math.max(outWidth, outHeight) * 3;
            return (
              <div className="ed-prop-block ed-prop-sel">
                <div className="ed-prop-head">
                  <span>{sel.type === 'mask' ? '◐ Маска' : `◐ Вырезка · ${compactName(fileName(sel.file||''), 12)}`}</span>
                  {sel.type === 'mask' && (
                    <button className="ed-mask-apply" onClick={() => applyMask(sel.id)} title="Применить — превратит видео под маской в подвижную вырезку выбранной формы">
                      Применить
                    </button>
                  )}
                </div>
                <div className="ed-mask-shapes">
                  {[['square','◼','Квадрат'],['rounded','▢','Скругл.'],['circle','●','Круг']].map(([id,glyph,lbl]) => (
                    <button key={id} type="button" className={`ed-mask-shape${sel.shape===id?' active':''}`}
                      onClick={()=>changeMaskShape(sel.id,id)} title={lbl}>
                      <span className="ed-mask-shape-glyph">{glyph}</span>
                      <span className="ed-mask-shape-lbl">{lbl}</span>
                    </button>
                  ))}
                </div>
                {locked ? (
                  <Slider label="Размер, px" value={Math.round(sizePx)} min="40" max={maxPx} onChange={updSize} />
                ) : (
                  <>
                    <Slider label="Ширина, %" value={sel.width} min="5" max="300" onChange={v=>updLayer(sel.id,'width',v)} />
                    <Slider label="Высота, %" value={sel.height} min="5" max="300" onChange={v=>updLayer(sel.id,'height',v)} />
                  </>
                )}
                {sel.shape === 'rounded' && (
                  <Slider label="Скругление углов, %" value={sel.radius ?? 12} min="0" max="50" onChange={v=>updLayer(sel.id,'radius',v)} />
                )}
                {sel.type === 'maskedVideo' && (
                  <Slider label="Громкость, %" value={sel.volume??100} min="0" max="200" onChange={v=>updLayer(sel.id,'volume',v)} />
                )}
                <p className="ed-effects-hint">
                  {sel.type === 'mask'
                    ? 'Маска обрезает всё что под ней. Нажми «Применить» — видео-клип превратится в подвижную вырезку.'
                    : 'Перетащи вырезку мышкой по превью. Уголки рамки меняют размер от центра.'}
                </p>
              </div>
            );
          })()}

          {sel?.type === 'zoom' && (
            <div className="ed-prop-block ed-prop-sel">
              <div className="ed-prop-head">Зум</div>
              <Slider label="Сила зума, %" value={sel.strength} min="5" max="100" onChange={v=>updLayer(sel.id,'strength',v)} />
              <p className="ed-effects-hint">Длительность зума = длина клипа на таймлайне. Разгон до максимума за первую половину, плавный возврат — за вторую.</p>
            </div>
          )}

          {sel?.type === 'transition' && (() => {
            // Strength = 0-100 slider that re-derives visual params (amp/blur/
            // shift/scale) on every change. Duration stays whatever the clip
            // is currently set to on the timeline.
            const cur = typeof sel.strength === 'number'
              ? sel.strength
              : (sel.strength === 'low' ? 25 : sel.strength === 'high' ? 80 : 50);
            const applyStrength = (v) => {
              const params = transitionParams(sel.kind || 'shake', v);
              set('layers', ls => ls.map(x => x.id === sel.id
                ? { ...x, strength: Number(v), ...params }
                : x));
            };
            return (
              <div className="ed-prop-block ed-prop-sel">
                <div className="ed-prop-head">⚡ Переход</div>
                <Slider label="Сила" value={cur} min="0" max="100" onChange={applyStrength} />
                <p className="ed-effects-hint">Длина клипа на таймлайне — это длительность перехода. Сила меняет интенсивность эффекта.</p>
              </div>
            );
          })()}

          {/* Text properties */}
          {sel?.type === 'text' && (
            <div className="ed-prop-block ed-prop-sel">
              <div className="ed-prop-head">✏ Текст</div>
              <textarea className="ed-textarea" data-onb="textinput" rows={2} value={sel.text} onChange={e=>updLayer(sel.id,'text',e.target.value)} />
              {systemFonts.length > 0 && (
                <div className="ed-prop-row">
                  <span className="ed-prop-label">Шрифт</span>
                  <FontPicker value={sel.fontFamily || ''} fonts={systemFonts}
                    onChange={(fn) => { const ff = systemFonts.find(f => f.name === fn); set('layers', l => l.map(x => x.id === sel.id ? { ...x, fontFamily: fn, fontFile: ff?.file || '' } : x)); }} />
                </div>
              )}
              <div className="ed-prop-row">
                <span className="ed-prop-label">Цвет</span>
                <input type="color" className="ed-color-inp" value={sel.color||'#ffffff'} onChange={e=>updLayer(sel.id,'color',e.target.value)} />
              </div>
              <Slider label="Размер" value={sel.size} min="12" max="200" onChange={v=>updLayer(sel.id,'size',v)} />
              <Slider label="Прозрачность, %" value={sel.opacity} min="0" max="100" onChange={v=>updLayer(sel.id,'opacity',v)} />
            </div>
          )}

          {sel?.type === 'subtitles' && (() => {
            const st = sel.style || {};
            const updStyle = (k, v) => set('layers', (ls) => ls.map(l => l.id === sel.id ? { ...l, style: { ...(l.style || {}), [k]: v } } : l));
            const segs = Array.isArray(sel.segments) ? sel.segments : [];
            // Edit a single segment's text — we also rebuild the per-word array
            // so the karaoke highlight stays in sync. New words inherit the
            // segment's [start,end] interval uniformly.
            const updSegText = (segId, newText) => {
              set('layers', (ls) => ls.map(l => {
                if (l.id !== sel.id) return l;
                const news = (l.segments || []).map(s => {
                  if (s.id !== segId) return s;
                  const parts = (newText || '').split(/\s+/).filter(Boolean);
                  if (parts.length === 0) return { ...s, text: '', words: [] };
                  const dur = Math.max(0.01, s.endTime - s.startTime);
                  const each = dur / parts.length;
                  const words = parts.map((w, i) => ({
                    text: w,
                    start: s.startTime + i * each,
                    end: s.startTime + (i + 1) * each,
                  }));
                  return { ...s, text: parts.join(' '), words };
                });
                return { ...l, segments: news };
              }));
            };
            const delSeg = (segId) => set('layers', (ls) => ls.map(l => l.id === sel.id ? { ...l, segments: (l.segments || []).filter(s => s.id !== segId) } : l));
            const mergeWithNext = (segId) => set('layers', (ls) => ls.map(l => {
              if (l.id !== sel.id) return l;
              const arr = l.segments || [];
              const i = arr.findIndex(s => s.id === segId);
              if (i < 0 || i >= arr.length - 1) return l;
              const a = arr[i], b = arr[i + 1];
              const merged = {
                id: a.id,
                startTime: a.startTime,
                endTime: b.endTime,
                text: (a.text + ' ' + b.text).trim(),
                words: [...(a.words || []), ...(b.words || [])],
              };
              const news = [...arr.slice(0, i), merged, ...arr.slice(i + 2)];
              return { ...l, segments: news };
            }));
            const splitAtMid = (segId) => set('layers', (ls) => ls.map(l => {
              if (l.id !== sel.id) return l;
              const arr = l.segments || [];
              const i = arr.findIndex(s => s.id === segId);
              if (i < 0) return l;
              const s = arr[i];
              const words = s.words || [];
              if (words.length < 2) return l;
              const mid = Math.floor(words.length / 2);
              const a = {
                id: s.id,
                startTime: s.startTime,
                endTime: words[mid - 1].end,
                text: words.slice(0, mid).map(w => w.text).join(' '),
                words: words.slice(0, mid),
              };
              const b = {
                id: s.id + '_b' + Date.now().toString(36),
                startTime: words[mid].start,
                endTime: s.endTime,
                text: words.slice(mid).map(w => w.text).join(' '),
                words: words.slice(mid),
              };
              const news = [...arr.slice(0, i), a, b, ...arr.slice(i + 1)];
              return { ...l, segments: news };
            }));
            // Re-chunk the whole subtitle stream into nicely-sized groups. Unlike
            // a strict word count (which makes ugly "2+1" splits when short words
            // appear), this packs words by a CHARACTER budget — the way Submagic /
            // CapCut / opus do it: short words pack together, long words split, and
            // it always breaks at sentence-ending punctuation. The "n" control is a
            // size target: budget ≈ n×7 chars with a soft word ceiling of n+2 so a
            // run of tiny words can't make one giant line. Flattens every word with
            // its timing first, so it's fully reversible (1↔3↔5 re-derive cleanly).
            const regroupSegments = (n) => {
              pushUndo();
              set('layers', (ls) => ls.map(l => {
                if (l.id !== sel.id || l.type !== 'subtitles') return l;
                const all = [];
                for (const s of (l.segments || [])) {
                  const ss = Number(s.startTime) || 0;
                  const se = Math.max(ss + 0.05, Number(s.endTime) || ss);
                  let ws = Array.isArray(s.words) && s.words.length ? s.words : null;
                  if (!ws) {
                    const parts = String(s.text || '').split(/\s+/).filter(Boolean);
                    const each = parts.length ? (se - ss) / parts.length : 0;
                    ws = parts.map((t, i) => ({ text: t, start: ss + i * each, end: ss + (i + 1) * each }));
                  }
                  for (const w of ws) all.push({ text: w.text, start: Number(w.start) || ss, end: Number(w.end) || se });
                }
                if (!all.length) return l;
                const budget = n * 7;      // characters per group (soft)
                const maxW = n + 2;        // word ceiling so tiny-word runs don't blow up
                const groups = [];
                let cur = [], curChars = 0;
                for (const w of all) {
                  const wl = (w.text || '').length;
                  const add = cur.length ? wl + 1 : wl;   // +1 for the space
                  if (cur.length && (curChars + add > budget || cur.length >= maxW)) {
                    groups.push(cur); cur = []; curChars = 0;
                  }
                  cur.push(w);
                  curChars += cur.length === 1 ? wl : add;
                  // Sentence end → always break after (keeps phrases whole).
                  if (/[.!?…]$/.test((w.text || '').trim())) { groups.push(cur); cur = []; curChars = 0; }
                }
                if (cur.length) groups.push(cur);
                const news = groups.map((g, gi) => {
                  const start = Number(g[0].start) || 0;
                  const nextG = groups[gi + 1];
                  // Hold each group until the next begins (no flicker on pauses).
                  const end = nextG
                    ? Math.max(start + 0.05, Number(nextG[0].start) || start)
                    : Math.max(start + 0.05, Number(g[g.length - 1].end) || start);
                  return {
                    id: 'seg_' + gi + '_' + Date.now().toString(36),
                    startTime: start,
                    endTime: end,
                    text: g.map(w => w.text).join(' '),
                    words: g.map(w => ({ ...w })),
                  };
                });
                return { ...l, segments: news, wordsPerGroup: n };
              }));
            };
            const jumpTo = (t) => setCurrentTime(Math.max(0, Math.min(totalDuration, t)));
            return (
              <div className="ed-prop-block ed-prop-sel">
                <div className="ed-prop-head">✦ Субтитры ({segs.length})</div>
                {systemFonts.length > 0 && (
                  <div className="ed-prop-row">
                    <span className="ed-prop-label">Шрифт</span>
                    <FontPicker value={st.fontFamily || ''} fonts={systemFonts}
                      onChange={(fn) => { const ff = systemFonts.find(f => f.name === fn); set('layers', ls => ls.map(l => l.id === sel.id ? { ...l, style: { ...(l.style || {}), fontFamily: fn, fontFile: ff?.file || '' } } : l)); }} />
                  </div>
                )}
                <div className="ed-prop-row">
                  <span className="ed-prop-label">Размер группы</span>
                  <div className="sub-wpg-btns">
                    {[1, 2, 3, 4, 5, 6].map(n => (
                      <button key={n}
                        className={`sub-wpg-btn${sel.wordsPerGroup === n ? ' active' : ''}`}
                        title={`≈${n} ${n === 1 ? 'слово' : 'слова'} на экране — умная группировка: короткие слова пакуются вместе, длинные разбиваются, рвётся по знакам препинания`}
                        onClick={() => regroupSegments(n)}>{n}</button>
                    ))}
                  </div>
                </div>
                <Slider label="Размер шрифта" value={st.fontSize ?? 56} min="16" max="200" onChange={v => updStyle('fontSize', v)} />

                {/* Collapsible style block — animation, colours, outline, spacing
                    tucked away so the panel isn't a wall of controls. Collapsed by default. */}
                <div className={`ed-effects-section sub-style-acc${subStyleOpen ? ' open' : ' collapsed'}`}>
                  <button className="ed-effects-title ed-acc-toggle" onClick={() => setSubStyleOpen(o => !o)} aria-expanded={subStyleOpen}>
                    <span>Оформление</span>
                    <span className="ed-acc-chev" aria-hidden="true">▾</span>
                  </button>
                  <div className="ed-acc-body"><div className="ed-acc-inner">
                    <div className="ed-prop-row">
                      <span className="ed-prop-label">Анимация</span>
                      <select className="ed-font-sel" value={st.anim || 'pop'} onChange={e => updStyle('anim', e.target.value)}>
                        {SUB_ANIMS.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    <Slider label="Межстрочное, %" value={st.lineHeight ?? 125} min="60" max="300" onChange={v => updStyle('lineHeight', v)} />
                    <div className="ed-prop-row">
                      <span className="ed-prop-label">Цвет текста</span>
                      <input type="color" className="ed-color-inp" value={st.color || '#ffffff'} onChange={e => updStyle('color', e.target.value)} />
                    </div>
                    {(() => {
                      const olMode = st.outlineMode || (st.outline === false ? 'none' : 'external');
                      const setMode = (m) => { updStyle('outlineMode', m); updStyle('outline', m !== 'none'); };
                      return (
                        <>
                          <div className="ed-prop-row">
                            <span className="ed-prop-label">Обводка</span>
                            <select className="ed-font-sel" value={olMode === 'internal' ? 'external' : olMode} onChange={e => setMode(e.target.value)}>
                              <option value="external">Есть</option>
                              <option value="none">Нет</option>
                            </select>
                          </div>
                          {olMode !== 'none' && (
                            <>
                              <div className="ed-prop-row">
                                <span className="ed-prop-label">Цвет обводки</span>
                                <input type="color" className="ed-color-inp"
                                  value={st.outlineColor || '#000000'}
                                  onChange={e => updStyle('outlineColor', e.target.value)} />
                              </div>
                              <Slider label="Толщина обводки" value={st.outlineWidth ?? Math.max(2, Math.round((st.fontSize ?? 56) * 0.04))}
                                min="1" max="40" onChange={v => updStyle('outlineWidth', v)} />
                            </>
                          )}
                        </>
                      );
                    })()}
                    <div className="ed-prop-row">
                      <span className="ed-prop-label">Подсветка слова</span>
                      <input type="color" className="ed-color-inp" value={st.highlightColor || '#ff9a1f'} onChange={e => updStyle('highlightColor', e.target.value)} />
                    </div>
                  </div></div>
                </div>

                <div className="sub-seg-list">
                  <div className="sub-seg-hint">Клик по фразе → переход к ней. Двойной клик по тексту → редактирование.</div>
                  {segs.map((s, idx) => {
                    const isActive = currentTime >= s.startTime && currentTime <= s.endTime;
                    return (
                      <div key={s.id} className={`sub-seg-item${isActive ? ' active' : ''}`}>
                        <button className="sub-seg-time" onClick={() => jumpTo(s.startTime)} title="Перейти к этой фразе">
                          {fmt(s.startTime)}
                        </button>
                        <textarea
                          className="sub-seg-text"
                          rows={1}
                          spellCheck={false}
                          value={s.text}
                          onChange={e => updSegText(s.id, e.target.value)}
                        />
                        <div className="sub-seg-acts">
                          <button className="sub-seg-act" title="Разделить пополам" onClick={() => splitAtMid(s.id)}>✂</button>
                          {idx < segs.length - 1 && (
                            <button className="sub-seg-act" title="Объединить со следующей" onClick={() => mergeWithNext(s.id)}>⇣</button>
                          )}
                          <button className="sub-seg-act danger" title="Удалить" onClick={() => delSeg(s.id)}>×</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="ed-prop-row" style={{ marginTop: 10 }}>
                  <span className="ed-prop-label">Язык речи</span>
                  <select className="ed-font-sel" value={subLang} onChange={e => setSubLang(e.target.value)}>
                    <option value="auto">Авто (определить)</option>
                    <option value="ru">Русский</option>
                    <option value="pt">Português</option>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                    <option value="de">Deutsch</option>
                    <option value="fr">Français</option>
                    <option value="it">Italiano</option>
                    <option value="uk">Українська</option>
                  </select>
                </div>
                <button className="sub-regen-btn" onClick={generateSubtitlesLayer} disabled={!!subProgress}>
                  Распознать заново
                </button>
              </div>
            );
          })()}

          {/* Video overlay properties */}
          {sel?.type === 'videoOverlay' && (
            <div className="ed-prop-block ed-prop-sel">
              <div className="ed-prop-head">🎬 {compactName(fileName(sel.file||''), 16)}</div>
              <Slider label="Размер, %" value={Math.round(sel.size)} min="5" max="200" onChange={v=>updLayer(sel.id,'size',v)} />
              <Slider label="Громкость, %" value={sel.volume??100} min="0" max="200" onChange={v=>updLayer(sel.id,'volume',v)} />
              <Slider label="Яркость" value={sel.ccB ?? 0} min="-50" max="50" onChange={v=>updLayer(sel.id,'ccB',v)} />
              <Slider label="Насыщенность, %" value={sel.ccS ?? 100} min="0" max="200" onChange={v=>updLayer(sel.id,'ccS',v)} />
              <Slider label="Цветовой тон, °" value={sel.ccH ?? 0} min="-180" max="180" onChange={v=>updLayer(sel.id,'ccH',v)} />
              {((sel.ccB || 0) !== 0 || (sel.ccS ?? 100) !== 100 || (sel.ccH ?? 0) !== 0) && (
                <button className="ed-cc-reset" onClick={() => set('layers', l => l.map(x => x.id === sel.id ? { ...x, ccB: 0, ccS: 100, ccH: 0 } : x))}>Сбросить цветокоррекцию</button>
              )}
            </div>
          )}

          {/* Audio layer properties */}
          {sel?.type === 'audio' && (
            <div className="ed-prop-block ed-prop-sel">
              <div className="ed-prop-head">🎵 {compactName(fileName(sel.file||''), 16)}</div>
              <Slider label="Громкость, %" value={sel.volume??100} min="0" max="200" onChange={v=>updLayer(sel.id,'volume',v)} />
            </div>
          )}

          {!selectedId && (
            <div className="ed-prop-block ed-prop-hint-blk">
              <p className="ed-hint">Нажми на дорожку в таймлайне, чтобы изменить параметры слоя</p>
            </div>
          )}
          </>}

          {/* Effects tab */}
          {edPropTab === 'effects' && (
            <div className="ed-effects-panel">
              <div className={`ed-effects-section${effectsOpen==='videofx'?' open':' collapsed'}`} data-onb="videofx">
                <button className="ed-effects-title ed-acc-toggle" onClick={()=>setEffectsOpen(o=>o==='videofx'?null:'videofx')} aria-expanded={effectsOpen==='videofx'}>
                  <span>Эффекты видео</span>
                  <span className="ed-acc-chev" aria-hidden="true">▾</span>
                </button>
                <div className="ed-acc-body"><div className="ed-acc-inner">
                {sel?.type !== 'videoOverlay' && <p className="ed-effects-hint">Выберите видео-слой на таймлайне.</p>}
                {sel?.type === 'videoOverlay' && (() => {
                  const speedOn = !!sel.fxSpeed || (sel.speed != null && sel.speed !== 100);
                  return (
                    <>
                      <p className="ed-effects-hint ed-effects-hint-section">Применяются к выбранному видео-слою.</p>
                      <div className="ed-effects-add">
                        <button className={`ed-effect-btn ed-effect-btn-d${sel.reversed ? ' active' : ''}`}
                          onClick={() => updLayer(sel.id, 'reversed', !sel.reversed)}>
                          <span>Реверс</span>
                          <small>проигрывание задом наперёд</small>
                        </button>
                        <button className={`ed-effect-btn ed-effect-btn-d${speedOn ? ' active' : ''}`}
                          onClick={() => speedOn
                            ? set('layers', l => l.map(x => x.id === sel.id ? { ...x, fxSpeed: false, speed: 100 } : x))
                            : updLayer(sel.id, 'fxSpeed', true)}>
                          <span>Скорость</span>
                          <small>ускоряет или замедляет</small>
                        </button>
                      </div>
                      {speedOn && (
                        <Slider label="Скорость, %" value={sel.speed ?? 100} min="25" max="400" onChange={v=>setState(s=>{
                          const layers=s.layers.map(x=>{
                            if(x.id!==sel.id)return x;
                            const st=x.startTime||0;
                            const dur=(x.endTime??s.totalDuration)-st;
                            const nd=Math.max(0.2,dur*(x.speed||100)/Math.max(1,v));
                            return {...x,speed:v,endTime:st+nd};
                          });
                          const maxEnd=layers.reduce((m,l)=>Math.max(m,l.endTime||0),0);
                          return {...s,layers,totalDuration:Math.max(s.totalDuration,maxEnd)};
                        })} />
                      )}
                    </>
                  );
                })()}
                </div></div>
              </div>

              <div className={`ed-effects-section${effectsOpen==='layers'?' open':' collapsed'}`}>
                <button className="ed-effects-title ed-acc-toggle" onClick={()=>setEffectsOpen(o=>o==='layers'?null:'layers')} aria-expanded={effectsOpen==='layers'}>
                  <span>Эффект-слои</span>
                  <span className="ed-acc-chev" aria-hidden="true">▾</span>
                </button>
                <div className="ed-acc-body"><div className="ed-acc-inner">
                  <p className="ed-effects-hint ed-effects-hint-section">Создаёт новый слой и применяется ко всем слоям под собой.</p>
                  <div className="ed-effects-add">
                    <button className="ed-effect-btn" data-onb="blur" onClick={addBlurRegion}>Блюр</button>
                    <button className="ed-effect-btn" onClick={addZoom}>Зум</button>
                    <button className="ed-effect-btn" onClick={addMaskRegion}>Маска</button>
                    <button className="ed-effect-btn" data-onb="text" onClick={addTextOverlay}>Текст</button>
                  </div>
                </div></div>
              </div>

              <div className={`ed-effects-section${effectsOpen==='transitions'?' open':' collapsed'}`}>
                <button className="ed-effects-title ed-acc-toggle" onClick={()=>setEffectsOpen(o=>o==='transitions'?null:'transitions')} aria-expanded={effectsOpen==='transitions'}>
                  <span>Переходы</span>
                  <span className="ed-acc-chev" aria-hidden="true">▾</span>
                </button>
                <div className="ed-acc-body"><div className="ed-acc-inner">
                  <p className="ed-effects-hint ed-effects-hint-section">Используется для склейки двух разных видео, добавляется новым слоем.</p>
                  {/* Click a kind to add that transition with default strength */}
                  <div className="ed-trans-chips ed-trans-chips-grid">
                    {[
                      { kind: 'shake',   label: 'Удар',       desc: 'тряска + вспышка' },
                      { kind: 'whippan', label: 'Whip pan',   desc: 'горизонтальный сдвиг' },
                      { kind: 'zoom',    label: 'Zoom punch', desc: 'резкий зум с блюром' },
                      { kind: 'blur',    label: 'Blur burst', desc: 'размытие при склейке' },
                      { kind: 'seamzoom',label: 'Бесшовный зум', desc: 'провал в кадр + блюр' },
                    ].map(({ kind, label, desc }) => (
                      <button key={kind}
                        className="ed-trans-chip"
                        onClick={() => addTransition(kind, 50)}>
                        {label}
                        <small>{desc}</small>
                      </button>
                    ))}
                  </div>
                </div></div>
              </div>
            </div>
          )}

        </div>
        </div>
      </div>
      )}

      {/* ── TIMELINE ── */}
      {(
        <div className="ed-tl-section" data-onb="timeline">
          {/* Timeline toolbar */}
          <div className="ed-tl-bar">
            <button
              className="etl-subs-btn"
              onClick={generateSubtitlesLayer}
              disabled={!!subProgress || !hasAudioSrc}
              title={!hasAudioSrc ? 'Сначала добавь видео или аудио' : 'Автоматически распознать речь и добавить субтитры'}>
              <span aria-hidden="true" style={{marginRight:6}}>✦</span>Субтитры
            </button>
            <button className="etl-add-btn" onClick={splitAtPlayhead} title="Разрезать клип под курсором по позиции воспроизведения">✂ Разрезать</button>
            <button className="etl-add-btn" onClick={mergeSelected} disabled={selectedIds.size < 2} title="Объединить выбранные клипы (Ctrl+клик по клипам на таймлайне для мультивыбора)">⛓ Объединить</button>
            <div style={{flex:1}} />
            <div className="ed-zoom">
              <span className="ed-zoom-lbl">Масштаб</span>
              <button className="ed-zoom-btn" onClick={()=>setZoom(z=>Math.max(1,+(z-0.5).toFixed(1)))}>−</button>
              {/* The value is a scrubber, same as the preview zoom: hold + drag
                  up/down (or wheel over it) to dial the timeline zoom smoothly. */}
              <span className={`ed-zoom-val zoom-pct-scrub${tlZoomScrubActive ? ' active' : ''}`}
                title="Тяни вверх/вниз или крути колесо, чтобы менять масштаб"
                onWheel={(e) => {
                  e.preventDefault();
                  const dir = e.deltaY < 0 ? 1 : -1;
                  setZoom(z => Math.max(1, Math.min(8, +(z + dir * 0.25).toFixed(2))));
                }}
                onPointerDown={(e) => {
                  e.stopPropagation(); e.preventDefault();
                  const startY = e.clientY;
                  const startZ = zoom;
                  const el = e.currentTarget;
                  try { el.setPointerCapture(e.pointerId); } catch {}
                  setTlZoomScrubActive(true);
                  const onMove = (ev) => {
                    const dy = startY - ev.clientY;       // up = positive
                    const factor = Math.pow(1.012, dy);   // ~1.2 % per px
                    const next = Math.max(1, Math.min(8, startZ * factor));
                    setZoom(+next.toFixed(2));
                  };
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    try { el.releasePointerCapture(e.pointerId); } catch {}
                    setTlZoomScrubActive(false);
                  };
                  window.addEventListener('pointermove', onMove);
                  window.addEventListener('pointerup', onUp);
                }}>{zoom}×
                {tlZoomScrubActive && (() => {
                  // Vertical track shown while dragging (log scale over 1×–8×).
                  const MIN = 1, MAX = 8;
                  const pos = Math.log(zoom / MIN) / Math.log(MAX / MIN);
                  return (
                    <span className="zoom-scrub-track" aria-hidden="true">
                      <span className="zoom-scrub-label top">8×</span>
                      <span className="zoom-scrub-bar">
                        <span className="zoom-scrub-mid" />
                        <span className="zoom-scrub-thumb" style={{ bottom: `${pos * 100}%` }} />
                      </span>
                      <span className="zoom-scrub-label bot">1×</span>
                    </span>
                  );
                })()}
              </span>
              <button className="ed-zoom-btn" onClick={()=>setZoom(z=>Math.min(8,+(z+0.5).toFixed(1)))}>＋</button>
            </div>
          </div>

          {/* Top horizontal scrollbar — appears only when zoomed in (timeline
              wider than the viewport). Sits under the toolbar, above the tracks. */}
          {tlBar.show && (
            <div className="ed-tl-hscroll">
              <div className="ed-tl-hscroll-thumb" style={{ width: `${tlBar.w}%`, left: `${tlBar.l}%` }}
                onPointerDown={onTlBarThumbDown} />
            </div>
          )}

          {/* Scrollable timeline */}
          <div className="ed-tl-scroll" ref={tlScrollRef} onScroll={updateTlBar}>
            <div className="ed-tl-inner" style={{width:`${zoom*100}%`}}>

              {/* Ruler */}
              <div className="etl-header">
                <div className="etl-label-col" />
                <div className="etl-time-ruler" ref={timelineRef} onPointerDown={onRulerPointerDown} style={{cursor:'col-resize'}}>
                  {Array.from({length:11},(_,i)=>(
                    <span key={i} style={{left:`${i*10}%`}}>{fmt((i/10)*dur)}</span>
                  ))}
                  <div className="etl-playhead" style={{left:pct(currentTime)}} />
                </div>
              </div>

              {/* Layer tracks */}
              {timelineLayers.map(layer => {
                const isMV = layer.type === 'mainVideo';
                const clStart = isMV ? videoStart : layer.startTime;
                const clEnd = isMV ? videoEnd : layer.endTime;
                // Subtitle track expands when selected so each phrase can be
                // dragged to fix its timing.
                const isSubExpanded = layer.type === 'subtitles' && selectedId === layer.id;
                return (
                  <div key={layer.id}
                    data-layer-id={layer.id}
                    className={`etl-track-row${(selectedId===layer.id||selectedIds.has(layer.id))?' etl-selected':''}${layer.hidden?' etl-hidden':''}${isSubExpanded?' etl-row-subs-expanded':''}`}
                    onClick={e=>{
                      // Ignore the synthetic click that immediately follows a drag
                      // (otherwise moving a group would clear the multi-selection).
                      // Only suppress a fresh one (<500ms) so a stale value can't
                      // swallow a later real click.
                      if (Date.now() - suppressRowClickRef.current < 500) { suppressRowClickRef.current = 0; return; }
                      const idx = timelineLayers.findIndex(l => l.id === layer.id);
                      if (e.shiftKey) {
                        // Shift (with or without Ctrl): select every layer
                        // between the anchor and this one, inclusive.
                        let a = timelineLayers.findIndex(l => l.id === (selAnchorRef.current ?? selectedId));
                        if (a < 0) a = idx;
                        const lo = Math.min(a, idx), hi = Math.max(a, idx);
                        setSelectedIds(new Set(timelineLayers.slice(lo, hi+1).map(l => l.id)));
                        setSelectedId(layer.id);
                      } else if (e.ctrlKey||e.metaKey) {
                        // Ctrl+Click: toggle this layer in the multi-selection
                        setSelectedIds(s => { const n = new Set(s); if (!n.size && selectedId) n.add(selectedId); n.has(layer.id) ? n.delete(layer.id) : n.add(layer.id); return n; });
                        setSelectedId(layer.id);
                        selAnchorRef.current = layer.id;
                      } else {
                        setSelectedId(layer.id===selectedId?null:layer.id);
                        setSelectedIds(new Set());
                        selAnchorRef.current = layer.id;
                      }
                    }}>
                    <div className="etl-label-col" draggable
                      onDragStart={e=>{ layerDragRef.current=layer.id; e.dataTransfer.effectAllowed='move'; }}
                      onDragOver={e=>{ e.preventDefault(); e.currentTarget.classList.add('etl-drop-target'); }}
                      onDragLeave={e=>e.currentTarget.classList.remove('etl-drop-target')}
                      onDrop={e=>{ e.preventDefault(); e.currentTarget.classList.remove('etl-drop-target'); reorderLayer(layerDragRef.current, layer.id); layerDragRef.current=null; }}>
                      <span className={`etl-track-label${layer._missing ? ' etl-missing' : ''}`} title={layer._missing ? `Файл не найден: ${layer.file || ''}` : lFull(layer)}>
                        {layer._missing ? '⚠ ' : ''}{lName(layer)}
                      </span>
                      <div className="etl-track-actions">
                        <button className="etl-act-color" title="Цвет клипа" style={{background:lColor(layer)}}
                          onPointerDown={e=>e.stopPropagation()}
                          onClick={e=>{e.stopPropagation(); const r=e.currentTarget.getBoundingClientRect(); setColorMenu(cm=>cm&&cm.id===layer.id?null:{id:layer.id,x:r.left,y:r.bottom+5});}} />
                        <button className={`etl-act-btn etl-vis${layer.hidden?' etl-off':''}`} title={layer.hidden?'Показать видео':'Скрыть видео'}
                          onClick={e=>{e.stopPropagation();toggleVis(layer.id);}}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                          {layer.hidden && <span className="etl-act-slash" aria-hidden="true" />}
                        </button>
                        {LAYER_HAS_AUDIO(layer.type) && (
                          <button className={`etl-act-btn etl-snd${layer.muted?' etl-off':''}`} title={layer.muted?'Включить звук':'Выключить звук'}
                            onClick={e=>{e.stopPropagation();toggleMute(layer.id);}}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12"/></svg>
                            {layer.muted && <span className="etl-act-slash" aria-hidden="true" />}
                          </button>
                        )}
                        <button className="etl-act-btn etl-del" onClick={e=>{e.stopPropagation();delLayer(layer.id);}}>×</button>
                        <div className="etl-act-vstack">
                          <button className="etl-act-btn etl-act-mini" title="Выше" onClick={e=>{e.stopPropagation();moveLayer(layer.id,1);}}>↑</button>
                          <button className="etl-act-btn etl-act-mini" title="Ниже" onClick={e=>{e.stopPropagation();moveLayer(layer.id,-1);}}>↓</button>
                        </div>
                      </div>
                    </div>
                    <div className={`etl-track-area${isSubExpanded?' etl-track-area-subs':''}`}>
                      {isSubExpanded ? (
                        (layer.segments||[]).map(seg => (
                          <div key={seg.id} className="etl-subseg"
                            style={{left:pct(seg.startTime),width:`calc(${pct(seg.endTime)} - ${pct(seg.startTime)})`,background:lColor(layer)+'cc',borderColor:lColor(layer)}}
                            title={`${seg.text}\n(тяни середину — сдвиг тайминга, края — длина)`}
                            onPointerDown={makeSubSegDrag(layer.id, seg.id)}
                            onClick={e=>{e.stopPropagation(); setCurrentTime(Math.max(0, Math.min(dur, (seg.startTime||0)+0.02)));}}>
                            <div className="etl-subseg-handle etl-subseg-s" onPointerDown={makeSubSegResize(layer.id, seg.id, true)} />
                            <span className="etl-subseg-label">{seg.text}</span>
                            <div className="etl-subseg-handle etl-subseg-e" onPointerDown={makeSubSegResize(layer.id, seg.id, false)} />
                          </div>
                        ))
                      ) : (
                      <div className={`etl-clip${(layer.type==='image'||layer.type==='videoOverlay')?' etl-clip-img':''}`}
                        style={{left:pct(clStart),width:`calc(${pct(clEnd)} - ${pct(clStart)})`,background:lColor(layer)+(layer.hidden?'55':'bb'),borderColor:lColor(layer),cursor:'grab',opacity:layer.hidden?.5:1}}
                        onPointerDown={makeClipBodyDrag(layer.id)}>
                        {/* 1:1 type badge pinned to the clip start — instantly tells
                            you what the layer is (video / image / audio / text…). */}
                        <span className="etl-clip-typebadge" style={{background:lColor(layer)}} title={lName(layer)}>
                          {LAYER_ICONS[layer.type]
                            ? <img src={LAYER_ICONS[layer.type]} alt="" />
                            : <span>{layer.type==='audio'?'♪':layer.type==='text'?'T':layer.type==='subtitles'?'✦':'▦'}</span>}
                        </span>
                        {layer.type==='audio' && (
                          <div className="etl-waveform" aria-hidden="true">
                            {Array.from({length:36},(_,i)=><div key={i} className="etl-waveform-bar" style={{height:`${22+Math.sin(i*.9+1.2)*28+Math.cos(i*1.7)*18}%`}} />)}
                          </div>
                        )}
                        {layer.type==='image' && layer.file && (
                          <img className="etl-clip-thumb" src={fileUrl(layer.file)} alt="" aria-hidden="true" />
                        )}
                        {layer.type==='videoOverlay' && layer.file && (() => {
                          const clipDur = Math.max(0.1, (layer.endTime ?? dur) - (layer.startTime || 0));
                          const srcStart = layer.srcStart || 0;
                          const n = Math.max(1, Math.min(40, Math.round(clipDur)));
                          const cache = thumbsCacheRef.current.get(layer.file);
                          // FAST PATH: cached thumbnails (low-res JPEG <img>).
                          // No video decoders, no seek latency, instant on split.
                          if (cache && cache.thumbs && cache.thumbs.length && !cache.loading) {
                            return <div className="etl-clip-thumbstrip" aria-hidden="true">
                              {Array.from({ length: n }, (_, i) => {
                                const t = srcStart + (i / Math.max(1, n - 1)) * clipDur;
                                // Pick the closest pre-generated thumb.
                                let bestIdx = 0, bestDist = Infinity;
                                for (let j = 0; j < cache.thumbs.length; j++) {
                                  const d = Math.abs(cache.thumbs[j].t - t);
                                  if (d < bestDist) { bestDist = d; bestIdx = j; }
                                }
                                return <img key={i} className="etl-thumb-cell"
                                  src={cache.thumbs[bestIdx].url} alt="" />;
                              })}
                            </div>;
                          }
                          // FALLBACK: while the cache is still generating,
                          // use a small number of <video> elements so the
                          // user sees SOMETHING right away.
                          const nFb = Math.min(8, n);
                          return <div className="etl-clip-thumbstrip" aria-hidden="true">
                            {Array.from({ length: nFb }, (_, i) => {
                              const t = srcStart + (i / Math.max(1, nFb - 1)) * clipDur;
                              return <video key={i}
                                className="etl-thumb-cell"
                                src={fileUrl(layer.file) + `#t=${t.toFixed(2)}`}
                                muted preload="metadata" />;
                            })}
                          </div>;
                        })()}
                        <div className="etl-clip-handle etl-clip-s"
                          data-onb={(selectedId === layer.id && layer.type === 'videoOverlay') ? 'clipstart' : undefined}
                          onPointerDown={makeClipHandleDrag(layer.id,true)} />
                        <span className="etl-clip-inner-label">{lName(layer)}</span>
                        {layer.type==='videoOverlay' && (layer.reversed || (layer.speed!=null&&layer.speed!==100) || (layer.ccB||0)!==0 || (layer.ccC!=null&&layer.ccC!==100) || (layer.ccS!=null&&layer.ccS!==100) || (layer.ccH||0)!==0) && (
                          <span className="etl-clip-fx" title="Применены эффекты">fx</span>
                        )}
                        <div className="etl-clip-handle etl-clip-e" onPointerDown={makeClipHandleDrag(layer.id,false)} />
                      </div>
                      )}
                    </div>
                  </div>
                );
              })}

            </div>
          </div>
        </div>
      )}

    </section>
    {hotkeysOpen && <HotkeysOverlay onClose={() => setHotkeysOpen(false)} />}
  </>;
}

createRoot(document.getElementById('root')).render(<App />);
