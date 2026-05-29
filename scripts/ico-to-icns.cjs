#!/usr/bin/env node
/**
 * Convert a Windows .ico into a macOS .icns by extracting the embedded PNG
 * images and re-packing them in Apple's icon format. Used so the file
 * association icon for .smproj looks the same on Mac as on Windows.
 *
 *   node scripts/ico-to-icns.cjs <input.ico> <output.icns>
 */

const fs = require('fs');
const path = require('path');
const { decodeIco } = require('icojs');
const png2icons = require('png2icons');

(async () => {
  const inIco = process.argv[2];
  const outIcns = process.argv[3];
  if (!inIco || !outIcns) {
    console.error('Usage: node scripts/ico-to-icns.cjs <input.ico> <output.icns>');
    process.exit(1);
  }
  const icoBuf = fs.readFileSync(path.resolve(inIco));
  const images = await decodeIco(icoBuf);
  if (!images.length) throw new Error('No images extracted from ' + inIco);
  // Sort by size descending — png2icons needs the largest PNG (it downscales
  // for smaller representations inside the .icns).
  images.sort((a, b) => b.width - a.width);
  const largest = images[0];
  console.log(`Source: ${images.length} image(s), largest ${largest.width}×${largest.height}`);

  const pngBuf = Buffer.from(largest.buffer);
  // BILINEAR resampling is the safe default. 0 = no PNG compression tuning.
  const icnsBuf = png2icons.createICNS(pngBuf, png2icons.BILINEAR, 0);
  if (!icnsBuf) throw new Error('png2icons.createICNS returned null');

  fs.writeFileSync(path.resolve(outIcns), icnsBuf);
  console.log(`Wrote ${outIcns} (${icnsBuf.length} bytes)`);
})().catch((e) => { console.error(e); process.exit(1); });
