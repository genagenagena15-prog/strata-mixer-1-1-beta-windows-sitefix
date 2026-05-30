#!/usr/bin/env node
/**
 * Update + publish the strata mixer marketing site (Cloudflare Pages).
 *
 * Edits the source files in SITE_DIR with the new version + notes, then
 * deploys to Cloudflare Pages via `wrangler pages deploy`. Used as the
 * final step of the one-shot release flow so the download links on
 * stratamixer.net match the freshly published GitHub release.
 *
 * Usage:
 *   node scripts/update-site.cjs <version> [--notes "<text>"] [--dry]
 *
 * Env vars:
 *   CLOUDFLARE_API_TOKEN   — token with Pages:Edit on the account
 *   CLOUDFLARE_ACCOUNT_ID  — the account id (long hex)
 *   CLOUDFLARE_PAGES_PROJECT — Pages project name (e.g. "strata-mixer")
 *   SITE_DIR (optional)    — site source folder
 *     (default: C:\Users\Гена\Desktop\Strata mixer\Сайт\current)
 *   RELEASE_NOTES (optional alt to --notes)
 *
 * Files updated:
 *   - version.json   (latest, displayVersion, windowsUrl, macUrl, notes)
 *   - download/index.html  (download buttons + filenames in instructions
 *                          + version in hero header)
 *   - index.html     (any "v1.2.X" version display in hero/header)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_SITE = 'C:\\Users\\Гена\\Desktop\\Strata mixer\\Сайт\\current';
const SITE_DIR = process.env.SITE_DIR || DEFAULT_SITE;
const RELEASES_BASE = 'https://github.com/genagenagena15-prog/strata-mixer-releases/releases/latest/download';

function exitErr(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

// ── Parse args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const notesIdx = args.indexOf('--notes');
let notes = (notesIdx >= 0 && args[notesIdx + 1]) ? args[notesIdx + 1] : (process.env.RELEASE_NOTES || '');
notes = String(notes || '').trim();
if (/^(пустой|empty|none|без описания|no notes?)$/i.test(notes)) notes = '';

const version = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--notes');
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  exitErr('Pass version as first arg (e.g. 1.2.6). Got: ' + (version || '<none>'));
}

if (!fs.existsSync(SITE_DIR)) exitErr(`Site dir not found: ${SITE_DIR}`);

const winUrl = `${RELEASES_BASE}/StrataMixer-${version}.exe`;
// Single universal .dmg — works natively on both Apple Silicon and Intel.
const macUrl = `${RELEASES_BASE}/StrataMixer-${version}.dmg`;

console.log(`\n📦 Site update for v${version}`);
console.log(`   SITE_DIR = ${SITE_DIR}`);
console.log(`   Win URL  = ${winUrl}`);
console.log(`   Mac URL  = ${macUrl}\n`);

// ── 1. version.json ───────────────────────────────────────────────────────
const versionJsonPath = path.join(SITE_DIR, 'version.json');
if (fs.existsSync(versionJsonPath)) {
  let vj;
  try { vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8')); }
  catch { vj = {}; }
  vj.latest = version;
  vj.displayVersion = `v${version}`;
  vj.windows = vj.windows || {};
  vj.windows.url = winUrl;
  vj.macos = vj.macos || {};
  vj.macos.url = macUrl;
  vj.windowsUrl = winUrl;
  vj.macUrl = macUrl;
  if (notes) vj.notes = notes;
  fs.writeFileSync(versionJsonPath, JSON.stringify(vj, null, 2) + '\n', 'utf8');
  console.log('✏️  version.json updated');
} else {
  console.warn('⚠ version.json not found, skipping');
}

// ── 2. Replace versioned URLs and labels in HTML ──────────────────────────
// Strategy:
// - Replace `StrataMixer-X.Y.Z.exe` with current Win filename
// - Replace `StrataMixer-X.Y.Z.dmg` (and -arm64.dmg) with current Mac filenames
// - Replace `v1.2.X` display strings (cautiously) — only when they look like
//   version markers (e.g. "v1.2.3", "Strata Mixer v1.2.3", "1.2.3 бесплатно").
const htmlFiles = [
  path.join(SITE_DIR, 'index.html'),
  path.join(SITE_DIR, 'download', 'index.html'),
];

// Release date stamped into the "Что нового" panel header (DD.MM.YYYY).
const _now = new Date();
const releaseDate = `${String(_now.getDate()).padStart(2, '0')}.${String(_now.getMonth() + 1).padStart(2, '0')}.${_now.getFullYear()}`;

let touched = 0;
for (const f of htmlFiles) {
  if (!fs.existsSync(f)) continue;
  let src = fs.readFileSync(f, 'utf8');
  const before = src;
  // Filenames in URLs and instructions
  src = src.replace(/StrataMixer-\d+\.\d+\.\d+(-arm64)?\.exe/g, `StrataMixer-${version}.exe`);
  src = src.replace(/StrataMixer-\d+\.\d+\.\d+-arm64\.dmg/g, `StrataMixer-${version}-arm64.dmg`);
  src = src.replace(/StrataMixer-\d+\.\d+\.\d+\.dmg/g, `StrataMixer-${version}.dmg`);
  // Display version. Matches a "v" followed by TWO OR MORE dot-separated
  // numbers, of ANY length — "v1.2", "v1.2.3", and even a previously-mangled
  // "v1.2.7.7.6" — and replaces the WHOLE token with the clean version.
  // (The old code ran a 3-part regex then a 2-part regex; the 2-part one
  // re-matched "v1.2" inside the just-written "v1.2.7" and appended the
  // trailing ".7", so every release compounded the version into garbage like
  // v1.2.7.7.6. A single greedy match fixes that AND repairs old mangling.)
  src = src.replace(/\bv\d+(?:\.\d+)+\b/g, `v${version}`);
  // Refresh the faint release date in the "Что нового" panel header.
  src = src.replace(/(<span class="rn-date">)[^<]*(<\/span>)/g, `$1${releaseDate}$2`);
  if (src !== before) {
    fs.writeFileSync(f, src, 'utf8');
    touched++;
    console.log(`✏️  ${path.relative(SITE_DIR, f)} updated`);
  }
}
if (!touched) console.log('   (no HTML files needed updating)');

// ── 3. Patch notes "Что нового" block ─────────────────────────────────────
// Look for a marker like <div class="release-notes"> or comment markers we
// can insert into. If notes are empty, skip.
if (notes) {
  const downloadHtml = path.join(SITE_DIR, 'download', 'index.html');
  if (fs.existsSync(downloadHtml)) {
    let src = fs.readFileSync(downloadHtml, 'utf8');
    // Build <li> items from the notes. ONLY lines starting with a bullet
    // marker ("• ", "- ", "* ") are turned into bullets — the marker is
    // stripped so the <ul>'s own disc doesn't duplicate it. Plain intro lines
    // (e.g. "В этом обновлении:") are dropped because the <h3> "Что нового"
    // heading already serves that role. **bold** → <strong>, `code` → <code>.
    const liItems = notes
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[•\-*]\s+/.test(l))
      .map((l) => {
        let t = l.replace(/^[•\-*]\s+/, '');
        t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
        return `      <li>${t}</li>`;
      })
      .join('\n');
    // Target the <ul> that directly follows the release-version div (the
    // latest release block) and swap ONLY its contents. The old regex grabbed
    // the first </div> inside the nested .release-notes container, which would
    // have corrupted the markup — that's why notes never landed before.
    const reList = /(<div class="release-version">[^<]*<\/div>\s*<ul>)[\s\S]*?(<\/ul>)/;
    if (reList.test(src)) {
      src = src.replace(reList, `$1\n${liItems}\n    $2`);
      fs.writeFileSync(downloadHtml, src, 'utf8');
      console.log('✏️  download/index.html — patch notes inserted');
    } else {
      console.log('   (release-version <ul> block not found, skipped notes injection)');
    }
  }
}

// ── 4. Publish to Cloudflare Pages via wrangler ───────────────────────────
if (dryRun) {
  console.log('\n🛠  --dry — site files updated locally; NOT publishing to Cloudflare.');
  process.exit(0);
}

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const PROJECT = process.env.CLOUDFLARE_PAGES_PROJECT;
if (!TOKEN || !ACCOUNT || !PROJECT) {
  exitErr(`Missing env: CLOUDFLARE_API_TOKEN=${TOKEN?'✓':'✗'} CLOUDFLARE_ACCOUNT_ID=${ACCOUNT?'✓':'✗'} CLOUDFLARE_PAGES_PROJECT=${PROJECT?'✓':'✗'}`);
}

console.log('\n☁️  Publishing to Cloudflare Pages…');
// cwd into the site dir and use "." as the directory — avoids issues with
// Windows shell quoting when the path contains spaces / Cyrillic characters.
// Avoid spaces in CLI args — Windows shell quoting through `npx` is
// unreliable and breaks multi-word values like a commit message. Single
// hyphenated word is safe.
const r = spawnSync('npx', [
  'wrangler', 'pages', 'deploy', '.',
  '--project-name', PROJECT,
  '--commit-message', `release-v${version}`,
], {
  stdio: 'inherit',
  shell: true,
  cwd: SITE_DIR,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
});

if (r.status !== 0) exitErr(`wrangler exited with code ${r.status}`);
console.log(`\n✅ Site v${version} live on Cloudflare Pages\n`);
