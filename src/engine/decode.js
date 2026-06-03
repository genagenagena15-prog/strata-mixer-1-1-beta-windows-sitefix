// src/engine/decode.js — Tier-A video source: demux (mediabunny) → WebCodecs VideoDecoder →
// a small ring of decoded VideoFrames around the playhead. `frameAt(tSec)` returns the frame whose
// timestamp is the newest <= the requested media time (0-copy: the caller texImage2D's it; the ring
// owns the frame's lifetime and closes it on eviction — the caller must NOT close it).
//
// The MASTER CLOCK stays external (live audio): this module never drives time, it only serves the
// nearest-decoded frame for a queried time and decodes ahead to keep the window full. On a backward
// jump (or a big forward jump past the window) it seeks to the preceding keyframe and re-primes.
//
// Geometry note: a VideoFrame has displayWidth/codedWidth, NOT .videoWidth — so consumers that need
// pixel dims (maskedVideo srcCrop, aspect) must read VideoSource.width/height, never the frame.

import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';

const US = 1e6;                 // seconds → microseconds (WebCodecs timestamps are µs)
const LOOKAHEAD_US = 350_000;   // keep ~0.35s decoded ahead of the playhead
const KEEP_BEHIND_US = 120_000; // retain ~0.12s behind (tiny back-scrubs / repeated frames)
const MAX_QUEUE = 8;            // cap decoder.decodeQueueSize so we don't over-submit
const SEEK_BACK_US = 60_000;    // playhead < oldest-by-this → treat as a backward seek

export class VideoSource {
  // opts.srcStart (sec): offset INTO the source video that media-time 0 maps to (clip trim).
  constructor(src, opts = {}) {
    this.src = src;                       // URL string OR Blob/File
    this.srcStart = opts.srcStart || 0;
    this.label = opts.label || 'video';
    this.ring = [];                       // decoded VideoFrames, kept roughly sorted by timestamp
    this.chunks = [];                     // all encoded chunks {type,timestamp,duration,data}
    this.keyIdx = [];                     // indices into chunks[] that are keyframes
    this.idx = 0;                         // next chunk to submit
    this.w = 0; this.h = 0;
    this.ready = false;
    this.err = null;
    this.decoded = 0;                     // total frames emitted (diagnostics)
    this._configured = false;
  }

  async init() {
    const blob = this.src instanceof Blob ? this.src : await (await fetch(this.src)).blob();
    this.input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    this.track = await this.input.getPrimaryVideoTrack();
    if (!this.track) throw new Error('no video track: ' + this.label);
    this.config = await this.track.getDecoderConfig();
    this.w = await this.track.getDisplayWidth();
    this.h = await this.track.getDisplayHeight();
    // Demux ALL packets up front (rilsy are short < 1 min; keeps seek O(1) on a keyframe index).
    const sink = new EncodedPacketSink(this.track);
    let p = await sink.getFirstPacket();
    while (p) {
      const c = p.toEncodedVideoChunk();
      const d = new Uint8Array(c.byteLength); c.copyTo(d);
      if (c.type === 'key') this.keyIdx.push(this.chunks.length);
      this.chunks.push({ type: c.type, timestamp: c.timestamp, duration: c.duration || 0, data: d });
      p = await sink.getNextPacket(p);
    }
    if (!this.chunks.length) throw new Error('no packets: ' + this.label);
    if (!this.keyIdx.length) this.keyIdx.push(0);
    const last = this.chunks[this.chunks.length - 1];
    this.durUs = last.timestamp + (last.duration || 33_333);
    this._makeDecoder();
    this.ready = true;
    return this;
  }

  _makeDecoder() {
    this.decoder = new VideoDecoder({
      output: (frame) => { this.ring.push(frame); this.decoded++; },
      error: (e) => { this.err = e; },
    });
    this._configure();
  }
  _configure() {
    this.decoder.configure({ ...this.config, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    this._configured = true;
  }

  // last keyframe index whose timestamp <= tUs
  _keyframeFor(tUs) {
    let k = this.keyIdx[0];
    for (let i = 0; i < this.keyIdx.length; i++) {
      if (this.chunks[this.keyIdx[i]].timestamp <= tUs) k = this.keyIdx[i];
      else break;
    }
    return k;
  }

  // Hard seek: drop everything in flight, jump submission to the keyframe preceding tUs.
  _seekTo(tUs) {
    for (const f of this.ring) { try { f.close(); } catch {} }
    this.ring.length = 0;
    try { this.decoder.reset(); } catch {}
    this._configure();
    this.idx = this._keyframeFor(Math.max(0, tUs));
  }

  // Submit chunks until the decode queue / ring covers tUs + LOOKAHEAD (bounded; output is async).
  _pump(tUs) {
    const targetUs = tUs + LOOKAHEAD_US;
    let guard = 0;
    while (this.idx < this.chunks.length && this.decoder.decodeQueueSize < MAX_QUEUE && !this.err) {
      const submittedTs = this.chunks[this.idx].timestamp;
      const newestTs = this.ring.length ? this.ring[this.ring.length - 1].timestamp : submittedTs;
      if (newestTs >= targetUs && this.ring.length) break;
      const c = this.chunks[this.idx++];
      try { this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration, data: c.data })); }
      catch (e) { this.err = e; break; }
      if (++guard > 240) break; // never spin unbounded in one call
    }
  }

  // Close frames well behind the playhead; keep the chosen frame + a small back-window.
  _gc(tUs, keep) {
    if (this.ring.length <= 1) return;
    const cutoff = tUs - KEEP_BEHIND_US;
    this.ring = this.ring.filter((f) => {
      if (f === keep) return true;
      if (f.timestamp < cutoff) { try { f.close(); } catch {} return false; }
      return true;
    });
  }

  // Return the VideoFrame for media-time tSec (newest ts <= t), or the nearest available, or null
  // while the decoder is still catching up. The ring keeps owning it — DO NOT close it in the caller.
  frameAt(tSec) {
    if (!this.ready || this.err) return null;
    const tUs = Math.round((tSec + this.srcStart) * US);
    // Seek decision — two cases only:
    //  • backward past the ring  → reset to the target's keyframe.
    //  • forward where the target's keyframe is AHEAD of what we're currently submitting → jump to it
    //    (skip decoding the gap). If the keyframe is at/behind idx, we're mid-catch-up toward the
    //    target inside the same GOP — DON'T re-seek (that was the bug: it reset every frame and never
    //    closed the gap on mid-GOP seeks deeper than ~1s from the keyframe).
    const oldest = this.ring.length ? this.ring[0].timestamp : null;
    const kfTarget = this._keyframeFor(Math.max(0, tUs));
    if (oldest != null && tUs < oldest - SEEK_BACK_US) this._seekTo(tUs);
    else if (kfTarget > this.idx) this._seekTo(tUs);

    this._pump(tUs);

    // pick newest frame with ts <= tUs; else the oldest future frame (so something shows)
    let pick = null, future = null;
    for (const f of this.ring) {
      if (f.timestamp <= tUs) { if (!pick || f.timestamp > pick.timestamp) pick = f; }
      else if (!future || f.timestamp < future.timestamp) future = f;
    }
    const chosen = pick || future;
    if (chosen) this._gc(tUs, chosen);
    return chosen;
  }

  // Like frameAt but ASYNC: pump the decoder and WAIT until the frame at tSec is actually decoded
  // into the ring (or EOF / error / timeout). WebCodecs output is async, so the sync frameAt() returns
  // whatever happens to be decoded NOW — fine for a single source (the per-frame ffmpeg await lets it
  // catch up), but a STACK of overlay decoders can't all keep up in real time, so the 2nd+ source
  // returned a STALE frame → it looked stuck then jumped = the "overlay fast-forwards in EXPORT" bug.
  // The export awaits this for every active source before compositing each frame. Export-only; preview
  // never calls it (it samples the live <video>). Mirrors frameAt's seek decision so the subsequent
  // sync frameAt(tSec) picks the now-ready frame without re-seeking.
  async ensureFrameAt(tSec, timeoutMs = 4000) {
    if (!this.ready || this.err) return;
    const tUs = Math.round((tSec + this.srcStart) * US);
    const oldest = this.ring.length ? this.ring[0].timestamp : null;
    const kfTarget = this._keyframeFor(Math.max(0, tUs));
    if (oldest != null && tUs < oldest - SEEK_BACK_US) this._seekTo(tUs);
    else if (kfTarget > this.idx) this._seekTo(tUs);
    const start = Date.now();
    while (!this.err) {
      this._pump(tUs);
      if (this.ring.some((f) => f.timestamp >= tUs)) return;                            // a frame at/after tUs is decoded → frameAt can pick the right one
      if (this.idx >= this.chunks.length && this.decoder.decodeQueueSize === 0) return; // past EOF — nothing left to decode (hold last frame)
      if (Date.now() - start > timeoutMs) return;                                       // safety: never hang the export on a stuck decoder
      await new Promise((r) => setTimeout(r, 1));                                        // yield so the async decoder output lands in the ring
    }
  }

  get width() { return this.w; }
  get height() { return this.h; }
  get aspect() { return this.h ? this.w / this.h : 16 / 9; }

  dispose() {
    for (const f of this.ring) { try { f.close(); } catch {} }
    this.ring.length = 0;
    try { this.decoder.close(); } catch {}
    this.chunks.length = 0;
  }
}
