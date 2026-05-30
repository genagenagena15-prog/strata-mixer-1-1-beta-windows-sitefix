#!/usr/bin/env node
/**
 * Bake the Groq API key into the packaged app.
 *
 * Reads the key from process.env.GROQ_API_KEY and writes it to
 * electron/groq-key.json, which electron-builder packs into app.asar. At
 * runtime, main.js's groqApiKey() reads process.env first, then falls back to
 * this baked file — so end users (who don't have the env var) get working
 * subtitles / speech-to-text without managing any key (CapCut-style UX).
 *
 * Run this BEFORE electron-builder:
 *   - Local Windows build: release.cjs calls it (dev's Windows env has the key).
 *   - Mac CI: build-mac.yml runs it with env GROQ_API_KEY from the repo secret.
 *
 * SECURITY: the key ends up extractable from the distributed binary (anyone can
 * unpack app.asar). That's the accepted trade-off for the embedded-key UX. The
 * file is gitignored so the key never lands in the (public) source repo.
 */
const fs = require('fs');
const path = require('path');

const key = String(process.env.GROQ_API_KEY || '').trim();
const dest = path.join(__dirname, '..', 'electron', 'groq-key.json');

if (!key) {
  // Don't hard-fail the build — just warn. The app still works, minus the
  // cloud subtitle/transcribe features. (Guards against a missing CI secret.)
  fs.writeFileSync(dest, JSON.stringify({ key: '' }) + '\n', 'utf8');
  console.warn('⚠ bake-groq-key: GROQ_API_KEY not set — wrote EMPTY key. Subtitles/transcription will be disabled in this build.');
  process.exit(0);
}

fs.writeFileSync(dest, JSON.stringify({ key }) + '\n', 'utf8');
console.log(`✓ bake-groq-key: wrote ${path.relative(path.join(__dirname, '..'), dest)} (key ${key.slice(0, 7)}…, ${key.length} chars)`);
