const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'bin');
fs.mkdirSync(outDir, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────
// Windows & Linux: just copy whatever ffmpeg-static brought in for the host.
// macOS: download BOTH arm64 + x64 from the same place ffmpeg-static uses,
//        so a single universal .dmg can pick the right binary at runtime.
// ─────────────────────────────────────────────────────────────────────────

const platform = process.platform;

// Pull the release tag + executable name from ffmpeg-static's own
// package.json so the URL stays in sync if the dependency is upgraded.
// See node_modules/ffmpeg-static/install.js lines 173-174 for the exact
// pattern: `${downloadsUrl}/${release}/${executableBaseName}-${platform}-${arch}.gz`
let FFMPEG_TAG = 'b6.1.1';
let FFMPEG_EXE_NAME = 'ffmpeg';
try {
  const ffPkg = require('ffmpeg-static/package.json');
  const meta = ffPkg && ffPkg['ffmpeg-static'];
  if (meta) {
    if (meta['binary-release-tag']) FFMPEG_TAG = meta['binary-release-tag'];
    if (meta['executable-base-name']) FFMPEG_EXE_NAME = meta['executable-base-name'];
  }
} catch {}
const FFMPEG_URL = (arch) =>
  `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${FFMPEG_EXE_NAME}-darwin-${arch}.gz`;

function download(url, dst) {
  return new Promise((resolve, reject) => {
    function go(u) {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          go(res.headers.location); return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} on ${u}`)); return;
        }
        const out = fs.createWriteStream(dst);
        const isGz = /\.gz(\?|$)/.test(u);
        const stream = isGz ? res.pipe(zlib.createGunzip()) : res;
        stream.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }).on('error', reject);
    }
    go(url);
  });
}

async function prepareMac() {
  // Try to copy whatever ffmpeg-static gave us locally first (current arch),
  // so a fresh install isn't required twice for the local-arch binary.
  let local = '';
  try { local = require('ffmpeg-static'); } catch {}

  for (const arch of ['arm64', 'x64']) {
    const dst = path.join(outDir, `ffmpeg-darwin-${arch}`);
    if (fs.existsSync(dst)) {
      console.log(`Already have ffmpeg-darwin-${arch}, skipping`);
      continue;
    }
    if (local && fs.existsSync(local) && process.arch === arch) {
      // Local install matches this arch — reuse without downloading.
      fs.copyFileSync(local, dst);
      try { fs.chmodSync(dst, 0o755); } catch {}
      console.log(`Copied local ffmpeg → ${dst}`);
      continue;
    }
    // Otherwise pull from ffmpeg-static's GitHub release CDN.
    console.log(`Downloading ${FFMPEG_URL(arch)}…`);
    await download(FFMPEG_URL(arch), dst);
    try { fs.chmodSync(dst, 0o755); } catch {}
    console.log(`Wrote ${dst}`);
  }
}

function prepareWindowsOrLinux() {
  let src = '';
  try { src = require('ffmpeg-static'); } catch {}
  const dst = path.join(outDir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (src && fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    try { fs.chmodSync(dst, 0o755); } catch {}
    console.log('Prepared local FFmpeg:', dst);
  } else {
    console.log('FFmpeg static binary not found; app will try system ffmpeg.');
  }
}

(async () => {
  if (platform === 'darwin') await prepareMac();
  else prepareWindowsOrLinux();
})().catch((e) => { console.error('prepare-ffmpeg failed:', e); process.exit(1); });
