const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoMod = require('png-to-ico');
const pngToIco = typeof pngToIcoMod === 'function' ? pngToIcoMod : pngToIcoMod.default;

const svgPath = process.argv[2] || 'C:\\Users\\Гена\\Desktop\\КУБИК\\stratamixerICON.svg';
const outIco = path.join(__dirname, '..', 'assets', 'strata_mixer_1_1d.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const svg = fs.readFileSync(svgPath);
  const master = await sharp(svg, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const pngs = [];
  for (const s of sizes) {
    pngs.push(await sharp(master).resize(s, s).png().toBuffer());
  }
  const ico = await pngToIco(pngs);
  fs.writeFileSync(outIco, ico);
  console.log(`ICO written: ${outIco} (${ico.length} bytes, sizes ${sizes.join('/')})`);
})().catch((e) => { console.error(e); process.exit(1); });
