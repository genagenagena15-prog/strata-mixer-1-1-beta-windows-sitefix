const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const appName = 'StrataMixer_1_1';
console.log(`macOS build arch: ${arch}`);

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) process.exit(res.status || 1);
}

run('npm', ['run', 'build']);
run('npm', ['run', 'prepare-ffmpeg']);
run('npx', [
  'electron-packager', '.', appName,
  '--platform=darwin',
  `--arch=${arch}`,
  '--out=release-mac',
  '--overwrite',
  '--icon=assets/strata_mixer_1_1d.icns',
  '--prune=true'
]);

if (process.platform !== 'darwin') {
  console.log('DMG can only be created on macOS. App package was prepared by electron-packager when running on macOS.');
  process.exit(0);
}

const releaseDir = path.resolve('release-mac');
const packagedDir = path.join(releaseDir, `${appName}-darwin-${arch}`);
const appPath = path.join(packagedDir, `${appName}.app`);
const dmgRoot = path.join(releaseDir, 'dmg-root');
const dmgPath = path.join(releaseDir, 'StrataMixer_1_1.dmg');
fs.rmSync(dmgRoot, { recursive: true, force: true });
fs.mkdirSync(dmgRoot, { recursive: true });
run('cp', ['-R', appPath, dmgRoot + '/']);
try { fs.symlinkSync('/Applications', path.join(dmgRoot, 'Applications')); } catch {}
fs.rmSync(dmgPath, { force: true });
run('hdiutil', ['create', '-volname', 'Strata Mixer 1.1', '-srcfolder', dmgRoot, '-ov', '-format', 'UDZO', dmgPath]);
console.log(`\nDONE: ${dmgPath}`);
