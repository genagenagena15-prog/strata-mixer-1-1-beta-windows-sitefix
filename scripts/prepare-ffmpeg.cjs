const fs = require('fs');
const path = require('path');
let src = '';
try { src = require('ffmpeg-static'); } catch (e) {}
const outDir = path.join(__dirname, '..', 'bin');
fs.mkdirSync(outDir, { recursive: true });
const dst = path.join(outDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
if (src && fs.existsSync(src)) {
  fs.copyFileSync(src, dst);
  try { fs.chmodSync(dst, 0o755); } catch {}
  console.log('Prepared local FFmpeg:', dst);
} else {
  console.log('FFmpeg static binary not found; app will try system ffmpeg.');
}
