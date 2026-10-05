// Opus copies of lossless songs for mobile data. Cached outside the read-only music folder
// (a sibling .opus would scan as a second track), finished to disk before serving so Range
// requests can seek and resume, and renamed into place so a killed encode leaves no half file.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { transcodeDir } from '../db.js';

const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';

// TRANSCODE_MAX_GB is an LRU eviction threshold, not a budget; 0 turns eviction off.
// Not `Number(...) || 60`, which would turn that 0 into 60.
function capBytes() {
  const raw = String(process.env.TRANSCODE_MAX_GB ?? '').trim();
  const gb = raw === '' ? 60 : Number(raw);
  return Math.round((Number.isFinite(gb) && gb >= 0 ? gb : 60) * 1024 ** 3);
}

const maxBytes = capBytes();

// Never evict an entry touched this recently: a resumed download (`Range: bytes=N-`)
// would get offsets into a re-encode that is not byte-identical and silently stitch
// two files together. Half an hour outlasts any single track.
const KEEP_RECENT_MS = 30 * 60 * 1000;

/**
 * `-map 0:a` and `-map_metadata -1` drop cover and tags: clients take both from the API,
 * and a FLAC picture is often 1-2 MB against a 3.5 MB Opus file.
 */
export const PROFILES = {
  opus128: {
    name: 'opus128',
    label: 'Opus 128 kbps',
    ext: '.opus',
    codec: 'opus',
    mime: 'audio/ogg',
    bitrate: 128_000,
    args: ['-map', '0:a', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on'],
  },
};

/** The name the API and the clients use for "leave it as it is". */
export const ORIGINAL = 'original';

/** A requested quality, cleaned up. Anything unknown means the original. */
export function profileOf(quality) {
  const wanted = String(quality || '').trim().toLowerCase();
  if (!wanted || wanted === ORIGINAL) return null;
  return PROFILES[wanted] || null;
}

/**
 * Only lossless sources are re-encoded; a lossy file of any bitrate would just gain a second
 * generation of loss. `lossless` is music-metadata's per-codec fact, and an unknown format
 * lands on false, the safe side.
 */
export function willTranscode(track, profile) {
  if (!profile || !track) return false;
  return !!track.lossless;
}

/**
 * The quality really served. Clients show this rather than what they asked for,
 * so the format shown is the one coming out of the speaker.
 */
export function servedQuality(track, quality) {
  const profile = profileOf(quality);
  return willTranscode(track, profile) ? profile.name : ORIGINAL;
}

/**
 * Size and mtime are in the key, so a re-tagged or replaced file gets a new name
 * and the old entry simply ages out.
 */
export function keyFor(track, profile) {
  const stamp = crypto
    .createHash('sha1')
    .update(`${track.size}:${track.mtime}:${track.path}`)
    .digest('hex')
    .slice(0, 12);
  return `${track.id}-${profile.name}-${stamp}${profile.ext}`;
}

export function pathFor(track, profile) {
  return path.join(transcodeDir, keyFor(track, profile));
}

// One encode per key at a time. Ten listeners starting the same song at once is
// one ffmpeg, not ten - and, more to the point, not ten writers on one file.
const running = new Map();

/**
 * The cache entry for [track] at [profile], encoding it first if it is not
 * there yet. Answers null when the track is not transcoded at all, which is the
 * caller's signal to serve the original file.
 */
export async function ensure(track, profile) {
  if (!willTranscode(track, profile)) return null;
  const target = pathFor(track, profile);
  if (fs.existsSync(target)) {
    touch(target);
    return target;
  }
  const key = path.basename(target);
  if (running.has(key)) return running.get(key);

  const job = (async () => {
    await encode(track.path, target, profile);
    evictIfNeeded();
    return target;
  })().finally(() => running.delete(key));

  running.set(key, job);
  return job;
}

/**
 * Encodes to a temporary name and renames it into place. Pid plus random suffix keep
 * two containers on one volume from writing the same scratch file.
 */
async function encode(source, target, profile) {
  await fsp.mkdir(transcodeDir, { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', source,
    ...profile.args,
    '-f', 'ogg',
    '-y', temp,
  ];

  try {
    await run(args);
    const { size } = await fsp.stat(temp);
    if (!size) throw new Error('ffmpeg produced an empty file');
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err;
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      // Only the tail is worth keeping - ffmpeg is happy to write megabytes.
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (err) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(`ffmpeg not found (${ffmpegBin}). Set FFMPEG_PATH or install it.`)
          : err
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
    });
  });
}

/** Marks an entry as used, which is what the eviction order reads. */
function touch(file) {
  const now = new Date();
  fsp.utimes(file, now, now).catch(() => {});
}

let evicting = false;

/**
 * Drops the least recently used entries until under the cap, never one used within
 * [KEEP_RECENT_MS], so a resumed download keeps reading one single encode.
 */
function evictIfNeeded() {
  if (!maxBytes || evicting) return;
  evicting = true;
  try {
    const cutoff = Date.now() - KEEP_RECENT_MS;
    const entries = [];
    let total = 0;
    for (const name of fs.readdirSync(transcodeDir)) {
      if (name.endsWith('.tmp')) continue;
      const full = path.join(transcodeDir, name);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) continue;
      total += stat.size;
      entries.push({ full, size: stat.size, used: stat.atimeMs || stat.mtimeMs });
    }
    if (total <= maxBytes) return;

    entries.sort((a, b) => a.used - b.used);
    for (const entry of entries) {
      if (total <= maxBytes) break;
      if (entry.used > cutoff) continue;
      try {
        fs.unlinkSync(entry.full);
        total -= entry.size;
      } catch {
        // Gone already, or in use on a platform that says so. Either is fine.
      }
    }
  } catch (err) {
    console.warn('Sonorus: could not tidy the transcode cache:', err && err.message ? err.message : err);
  } finally {
    evicting = false;
  }
}

/** What the settings page shows about the cache. */
export function cacheStats() {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(transcodeDir)) {
      if (name.endsWith('.tmp')) continue;
      const stat = fs.statSync(path.join(transcodeDir, name), { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) continue;
      files += 1;
      bytes += stat.size;
    }
  } catch {
    // No directory yet is an empty cache, not an error.
  }
  return { files, bytes, maxBytes, dir: transcodeDir };
}

/**
 * Probed once at startup, so the settings page and the stream route know the smaller
 * quality is unavailable instead of every stream failing on its own.
 */
let ffmpegReady = false;

export function isFfmpegReady() {
  return ffmpegReady;
}

export async function probeFfmpeg() {
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-version']);
    ffmpegReady = true;
  } catch (err) {
    ffmpegReady = false;
    console.warn(
      'Sonorus: ffmpeg is not available, so only the original quality can be served:',
      err && err.message ? err.message : err
    );
  }
  return ffmpegReady;
}

// --- Batch pre-generation ---------------------------------------------------

// Live progress, read by the settings page exactly like the scan's own state.
const batch = {
  running: false,
  done: 0,
  total: 0,
  skipped: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  error: '',
};

export function batchState() {
  return { ...batch };
}

/**
 * Encodes everything not cached yet, run after a scan. Sequential on purpose: several
 * ffmpegs pulling FLACs over NFS are slower than one. A failing file is counted and skipped.
 */
export async function pregenerate(tracks, profile = PROFILES.opus128, onProgress = null) {
  if (batch.running) return batchState();
  Object.assign(batch, {
    running: true,
    done: 0,
    total: tracks.length,
    skipped: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: '',
  });

  // Past the cap every encode only evicts an earlier one, which the next scan encodes again.
  let used = maxBytes ? cacheStats().bytes : 0;
  try {
    for (const track of tracks) {
      if (maxBytes && used >= maxBytes) break;
      if (!willTranscode(track, profile)) {
        batch.skipped += 1;
        batch.done += 1;
        if (onProgress) onProgress(batch.done, batch.total);
        continue;
      }
      const target = pathFor(track, profile);
      if (fs.existsSync(target)) {
        batch.skipped += 1;
        batch.done += 1;
        if (onProgress) onProgress(batch.done, batch.total);
        continue;
      }
      try {
        const file = await ensure(track, profile);
        if (file) used += fs.statSync(file, { throwIfNoEntry: false })?.size || 0;
      } catch (err) {
        batch.failed += 1;
        console.warn(
          `Sonorus: could not transcode ${track.path}:`,
          err && err.message ? err.message : err
        );
      }
      batch.done += 1;
      if (onProgress) onProgress(batch.done, batch.total);
    }
  } catch (err) {
    batch.error = err && err.message ? err.message : String(err);
  } finally {
    batch.running = false;
    batch.finishedAt = new Date().toISOString();
  }
  return batchState();
}
