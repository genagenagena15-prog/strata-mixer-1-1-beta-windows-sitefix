#!/usr/bin/env node
/**
 * One-shot release script.
 *
 *   node scripts/release.cjs patch                  → 1.2.5 → 1.2.6
 *   node scripts/release.cjs minor                  → 1.2.5 → 1.3.0
 *   node scripts/release.cjs major                  → 1.2.5 → 2.0.0
 *   node scripts/release.cjs 1.4.2                  → explicit version
 *   node scripts/release.cjs patch --dry            → bump + build locally, NO publish
 *   node scripts/release.cjs patch --notes "text"   → publish with patch notes
 *
 * Patch notes (`--notes`) are written to BOTH:
 *   - the GitHub Release body (visible at /releases/tag/vX.Y.Z)
 *   - notifications.json in the releases repo so the in-app notification
 *     bell picks it up on the next poll (every 10 minutes).
 *
 * What the script does (per run):
 *   1. Bumps `version` and `publicVersion` in package.json
 *   2. Syncs `APP_VERSION` in src/main.jsx so the in-app footer matches
 *   3. Runs `vite build` + `prepare-ffmpeg`
 *   4. Runs `electron-builder --win --publish always` → uploads installer,
 *      blockmap, latest.yml to a fresh GitHub release tagged `vX.Y.Z`
 *   5. (If --notes was passed and not --dry) PATCHes the release body and
 *      prepends an entry to notifications.json in the releases repo.
 *
 * Requirements (one-time):
 *   - GH_TOKEN env var with a Personal Access Token (classic, scope `repo`).
 *   - The `build.publish` field in package.json points at the right
 *     owner/repo on GitHub.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const progress = require('./release-progress.cjs');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const mainJsxPath = path.join(root, 'src', 'main.jsx');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8'); }

function bump(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current || '');
  if (!m) throw new Error(`Cannot parse current version "${current}"`);
  const [, maj, min, pat] = m.map(Number);
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  throw new Error(`Unknown bump kind "${kind}". Use patch | minor | major | x.y.z`);
}

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    console.error(`\n❌ "${cmd} ${args.join(' ')}" failed with exit code ${r.status}`);
    process.exit(r.status || 1);
  }
}

// Non-fatal variant — returns the exit code so the caller can decide.
function runSoft(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  return r.status;
}

async function ghApi(urlPath, opts = {}) {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${process.env.GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'strata-mixer-release-script',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub API ${res.status} on ${urlPath}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function updateReleaseBody(owner, repo, tag, body) {
  // Find release by tag, then PATCH its body. Retry a few times because the
  // release might not be queryable yet right after electron-builder uploads.
  let release = null;
  for (let i = 0; i < 8; i++) {
    try {
      release = await ghApi(`/repos/${owner}/${repo}/releases/tags/${tag}`);
      break;
    } catch (e) {
      if (e.status === 404 && i < 7) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
  if (!release) throw new Error(`Release for tag ${tag} not found after 8 retries`);
  await ghApi(`/repos/${owner}/${repo}/releases/${release.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

async function updateNotificationsJson(owner, repo, version, body) {
  const filePath = 'notifications.json';
  let existing = null;
  try {
    existing = await ghApi(`/repos/${owner}/${repo}/contents/${filePath}?ref=main`);
  } catch (e) {
    if (e.status !== 404) throw e;
    // File doesn't exist yet — we'll create it
  }
  let arr = [];
  if (existing) {
    try {
      const decoded = Buffer.from(existing.content, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.messages) ? parsed.messages : []);
    } catch { arr = []; }
  }
  const entry = {
    id: `v${version}`,
    type: 'update',
    title: `Strata Mixer v${version}`,
    body,
    version,
    date: new Date().toISOString().slice(0, 10),
  };
  // Remove any same-id entry (re-release case), then prepend.
  arr = arr.filter(e => e && e.id !== entry.id);
  arr.unshift(entry);
  const newContent = Buffer.from(JSON.stringify(arr, null, 2)).toString('base64');
  const putBody = {
    message: `Add notification for v${version}`,
    content: newContent,
    branch: 'main',
  };
  if (existing?.sha) putBody.sha = existing.sha;
  await ghApi(`/repos/${owner}/${repo}/contents/${filePath}`, {
    method: 'PUT',
    body: JSON.stringify(putBody),
  });
}

// ── Parse args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const notesIdx = args.indexOf('--notes');
let notes = '';
if (notesIdx >= 0 && args[notesIdx + 1]) {
  notes = args[notesIdx + 1];
} else if (process.env.RELEASE_NOTES) {
  notes = process.env.RELEASE_NOTES;
}
notes = String(notes || '').trim();
// Treat sentinel values as "no notes"
if (/^(пустой|empty|none|без описания|no notes?)$/i.test(notes)) notes = '';

const kind = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--notes') || 'patch';

// ── Bump version ──────────────────────────────────────────────────────────
const pkg = readJson(pkgPath);
const oldVersion = pkg.version;
const newVersion = bump(oldVersion, kind);

console.log(`\n📦 ${oldVersion}  →  ${newVersion}`);
if (notes) console.log(`📝 Notes (${notes.length} chars)\n`); else console.log(`📝 No notes\n`);

// ── Spawn the live progress dashboard (browser auto-opens) ─────────────────
if (!dryRun) {
  progress.start(newVersion, {
    sourceOwner: 'genagenagena15-prog',
    sourceRepo: 'strata-mixer-1-1-beta-windows-sitefix',
    releasesOwner: 'genagenagena15-prog',
    releasesRepo: 'strata-mixer-releases',
    tag: `v${newVersion}`,
  });
}

pkg.version = newVersion;
pkg.publicVersion = `v${newVersion}`;
writeJson(pkgPath, pkg);

let mainSrc = fs.readFileSync(mainJsxPath, 'utf8');
const before = mainSrc;
mainSrc = mainSrc.replace(/const APP_VERSION = 'v[\d.]+';/, `const APP_VERSION = 'v${newVersion}';`);
if (mainSrc !== before) {
  fs.writeFileSync(mainJsxPath, mainSrc, 'utf8');
  console.log(`✏️  src/main.jsx → APP_VERSION = 'v${newVersion}'`);
}

// ── Verify GH_TOKEN before doing the heavy work (unless dry) ──────────────
if (!dryRun && !process.env.GH_TOKEN) {
  console.error('\n❌ GH_TOKEN env var is not set — cannot publish to GitHub.');
  console.error('   setx GH_TOKEN "ghp_xxx..." (then RESTART terminal), or run with --dry.\n');
  process.exit(1);
}

// ── Push source to GitHub & tag → triggers Mac CI in parallel ──────────────
// We commit everything currently in the working tree under one chore commit,
// then tag it vX.Y.Z. The tag push triggers .github/workflows/build-mac.yml
// in the source repo, which builds the macOS .dmg on a GitHub macOS runner
// and uploads it to the same release in the releases repo. So while we
// build Windows locally in the next step, the Mac build is already running
// in the cloud.
if (!dryRun) {
  progress.set('win', { status: 'building', detail: 'Коммит + пуш в source repo', percent: 5 });
  console.log('\n📌 Pushing version bump to source repo + tag (triggers Mac CI)…');
  if (runSoft('git', ['add', '-A']) !== 0) {
    console.error('   ✗ git add failed — aborting');
    process.exit(1);
  }
  const commitMsg = notes
    ? `chore: release v${newVersion}\n\n${notes}`
    : `chore: release v${newVersion}`;
  // Pass the message via -F /dev/stdin so newlines survive shell quoting.
  const commitArgs = ['commit', '-m', JSON.stringify(commitMsg).slice(1, -1).replace(/\\n/g, '\n')];
  // On Windows shell, easier: write to a temp file and use -F.
  const tmpMsg = path.join(require('os').tmpdir(), `strata-commit-${Date.now()}.txt`);
  fs.writeFileSync(tmpMsg, commitMsg, 'utf8');
  const commitStatus = runSoft('git', ['commit', '-F', tmpMsg]);
  try { fs.unlinkSync(tmpMsg); } catch {}
  if (commitStatus !== 0) {
    console.warn('   ⚠ git commit returned non-zero (possibly nothing to commit). Continuing.');
  } else {
    if (runSoft('git', ['push']) !== 0) {
      console.error('   ✗ git push failed — check auth + try again');
      process.exit(1);
    }
  }
  // Tag (annotated, includes notes as the tag message) + push
  const tagName = `v${newVersion}`;
  const tagMsgFile = path.join(require('os').tmpdir(), `strata-tag-${Date.now()}.txt`);
  fs.writeFileSync(tagMsgFile, notes || `Strata Mixer ${tagName}`, 'utf8');
  if (runSoft('git', ['tag', '-a', tagName, '-F', tagMsgFile]) !== 0) {
    console.warn(`   ⚠ git tag ${tagName} failed (already exists?). Trying to push existing.`);
  }
  try { fs.unlinkSync(tagMsgFile); } catch {}
  if (runSoft('git', ['push', 'origin', tagName]) !== 0) {
    console.error('   ✗ git push tag failed — Mac CI will NOT trigger automatically');
    console.error('     Run later: git push origin ' + tagName);
  } else {
    console.log(`   ✓ ${tagName} pushed → Mac CI started in background`);
    progress.set('win', { status: 'building', detail: 'Тэг запушен, Mac CI стартует', percent: 15 });
  }
}

// ── Build + (optionally) publish ──────────────────────────────────────────
console.log(dryRun
  ? '🛠  Building Windows locally (no publish — --dry)…\n'
  : '🚀 Building & publishing Windows installer to GitHub…\n');

if (!dryRun) progress.set('win', { status: 'building', detail: 'vite build', percent: 25 });
run('npm', ['run', 'build']);
if (!dryRun) progress.set('win', { status: 'building', detail: 'prepare-ffmpeg', percent: 35 });
run('npm', ['run', 'prepare-ffmpeg']);
if (!dryRun) progress.set('win', { status: 'publishing', detail: 'electron-builder + upload', percent: 55 });
run('npx', [
  'electron-builder', '--win',
  ...(dryRun ? [] : ['--publish', 'always']),
]);
if (!dryRun) progress.set('win', { status: 'publishing', detail: 'Описание релиза + notifications.json', percent: 85 });

// ── Post-publish: update release body + notifications.json ────────────────
const owner = pkg.build?.publish?.[0]?.owner;
const repo = pkg.build?.publish?.[0]?.repo;

(async () => {
  if (!dryRun && notes && owner && repo) {
    console.log('\n🔗 Updating GitHub release body…');
    try {
      await updateReleaseBody(owner, repo, `v${newVersion}`, notes);
      console.log('   ✓ release body set');
    } catch (e) {
      console.error('   ✗ failed to set release body:', e.message);
    }
    console.log('🔔 Updating notifications.json in releases repo…');
    try {
      await updateNotificationsJson(owner, repo, newVersion, notes);
      console.log('   ✓ notifications.json updated');
    } catch (e) {
      console.error('   ✗ failed to update notifications.json:', e.message);
    }
  }
  if (!dryRun) progress.set('win', { status: 'done', detail: `StrataMixer-${newVersion}.exe залит на GitHub`, percent: 100 });

  // ── Update marketing site on Cloudflare Pages ─────────────────────────
  // Edits version.json + download links in the site source, then deploys
  // via wrangler. Only runs when not a dry-run and when the Cloudflare
  // credentials are present (otherwise we log a hint and skip).
  if (!dryRun) {
    const hasCfCreds = process.env.CLOUDFLARE_API_TOKEN
      && process.env.CLOUDFLARE_ACCOUNT_ID
      && process.env.CLOUDFLARE_PAGES_PROJECT;
    if (!hasCfCreds) {
      console.log('\n⚠ Cloudflare env not set — skipping site update.');
      console.log('  Set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_PAGES_PROJECT to enable.');
      progress.set('site', { status: 'failed', detail: 'Cloudflare env не настроены', percent: 100 });
    } else {
      progress.set('site', { status: 'updating', detail: 'Правлю version.json + HTML', percent: 25 });
      console.log('\n🌐 Updating marketing site on Cloudflare Pages…');
      progress.set('site', { status: 'deploying', detail: 'wrangler pages deploy…', percent: 70 });
      const siteRes = spawnSync('node', [
        path.join(root, 'scripts', 'update-site.cjs'),
        newVersion,
        ...(notes ? ['--notes', notes] : []),
      ], { stdio: 'inherit', shell: true, cwd: root, env: process.env });
      if (siteRes.status !== 0) {
        console.error('   ✗ site update failed — release on GitHub is still live');
        progress.set('site', { status: 'failed', detail: 'wrangler упал', percent: 100 });
      } else {
        progress.set('site', { status: 'done', detail: 'stratamixer.net обновлён', percent: 100 });
      }
    }
  }
  if (!dryRun) progress.shutdownIfDone();

  console.log(`\n✅ v${newVersion} ${dryRun ? 'built locally' : 'released'}`);
  if (dryRun) {
    console.log(`   release-installer\\StrataMixer-${newVersion}.exe`);
  } else if (owner && repo) {
    console.log(`   Win release:  https://github.com/${owner}/${repo}/releases/tag/v${newVersion}`);
    console.log(`   Mac CI:       https://github.com/genagenagena15-prog/strata-mixer-1-1-beta-windows-sitefix/actions`);
    console.log(`                 (≈10 min; .dmg attaches to same release when done)`);
    console.log(`   Site:         https://stratamixer.net (Cloudflare auto-promoted)`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
