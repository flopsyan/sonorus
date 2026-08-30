// Smaller copies of the songs, so a phone on mobile data does not have to pull
// a 35 MB FLAC for a four minute track.
//
// Three things decide the whole design, and all three come from the same place:
// the file has to stay a *file*.
//
//  - The music folder is mounted read-only on purpose, so nothing may be
//    written next to the original. And it could not be anyway: `AUDIO_EXT` in
//    `scanner.js` contains `.opus`, so a sibling file would be scanned as a
//    second track and every album would double.
//  - The stream route answers `Range` requests, which is what gives the app its
//    seek bar and its resumable downloads. A pipe out of ffmpeg has no
//    `Content-Length` and no byte offsets to seek to, so the encode is finished
//    to disk first and then served with the same `res.sendFile` as the original.
//  - An entry is written to a temporary name and renamed into place. A rename
//    is atomic, so a process killed mid-encode leaves no half file that would
//    later be served as a whole one.
//
// There is exactly one profile. A ladder of them was considered and dropped:
// what is wanted is "the original" or "small enough for a mobile connection",
// and every step in between is a setting nobody ever moves.
//
// And exactly one kind of source: **lossless only**, see `willTranscode`. A file
// that is already lossy is handed over untouched however large it is.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { transcodeDir } from '../db.js';

const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';

// The cap on the whole cache. The music library re-encoded at this profile is
// ungefähr a third of the FLACs it was made from, so a library of a few hundred
// gigabytes lands in the tens - which is why there is a cap at all rather than
// letting it grow until the disk is full. 0 turns the limit off.
const maxBytes = Math.round((Number(process.env.TRANSCODE_MAX_GB) || 60) * 1024 ** 3);

// An entry touched this recently is never evicted, however full the cache is.
//
// This is not politeness, it is the one correctness rule of the whole cache. The
// app resumes an interrupted download with `Range: bytes=N-`, and a re-encode is
// not byte-for-byte identical to the encode it replaces. Evicting an entry
// between two chunks of the same download would hand out offsets into a
// different file, and the app would stitch two encodes together without any
// error at all. Half an hour is longer than any single track can take.
const KEEP_RECENT_MS = 30 * 60 * 1000;

/**
 * The one profile.
 *
 * `-map 0:a` drops the embedded cover: the app fetches artwork separately, and
 * a FLAC picture is often 1-2 MB against a 3.5 MB Opus file. `-map_metadata -1`
 * drops the tags for the same reason - the client takes every name from the API,
 * never from the stream.
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
 * Whether [track] is really served in [profile], or handed over untouched.
 *
 * **Only lossless sources are ever re-encoded.** ffmpeg goes down the ladder and
 * never sideways: FLAC, WAV, ALAC, APE, WavPack and DSD shrink, and every lossy
 * file - MP3, AAC, Opus, Vorbis - is handed over as it lies, whatever its
 * bitrate. Florian's rule, 2026-08-30, after 312 podcast episodes at 160-320
 * kbps were being re-encoded into Opus 128 on the phone.
 *
 * The bitrate decided this until then (lossy above 140.8 kbps shrank too), and
 * on paper a 320k MP3 into a 128k Opus is smaller. What it also is, is a second
 * generation of lossy loss for a file that was already small enough - and no
 * bitrate threshold can tell the two apart, because the encoder that made the
 * source is not the one reading it back.
 *
 * `lossless` comes from `music-metadata` and is a fact about the codec, not
 * about the extension: a compressed WAV and a hybrid WavPack are false, and a
 * container whose parser sets nothing (WMA, Musepack) lands on false as well -
 * the safe side, since an unknown format is one nothing should be re-encoding.
 */
export function willTranscode(track, profile) {
  if (!profile || !track) return false;
  return !!track.lossless;
}

/**
 * What a client is really served for [quality]: the profile name when it is
 * transcoded, `original` when it is not.
 *
 * The clients draw this rather than what they asked for, so the format shown
 * under the transport is the format coming out of the speaker.
 */
export function servedQuality(track, quality) {
  const profile = profileOf(quality);
  return willTranscode(track, profile) ? profile.name : ORIGINAL;
}

/**
 * The file name of a cache entry.
 *
 * The track's own size and mtime are in the key, which is what makes
 * invalidation free: the scanner already stores both, so a re-tagged or replaced
 * file simply asks for a different name and the old entry ages out on its own.
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
    // Checked again inside the lock: another request may have finished it
    // between the check above and getting here.
    if (!fs.existsSync(target)) {
      await encode(track.path, target, profile);
      evictIfNeeded();
    }
    return target;
  })().finally(() => running.delete(key));

  running.set(key, job);
  return job;
}

/**
 * Runs ffmpeg into a temporary file and renames it into place.
 *
 * The temporary name carries the process id and a random suffix, so two
 * containers on the same volume cannot write the same scratch file.
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
 * Drops the least recently used entries until the cache is under the cap.
 *
 * Never touches anything used in the last [KEEP_RECENT_MS] - see the note on
 * that constant, it is what keeps a resumed download reading one single encode.
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
 * Whether ffmpeg is actually there.
 *
 * Asked once at startup and remembered, so the settings page and the stream
 * route can say that the smaller quality is unavailable - rather than every
 * single stream discovering it again and failing one at a time.
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
 * Encodes everything that is not in the cache yet.
 *
 * Run after a scan, because that is the moment the library is known to be
 * current and the moment a new file has just appeared. It is deliberately
 * sequential: this is I/O against the music share, and four ffmpegs pulling
 * FLACs over NFS at once are slower than one, not faster.
 *
 * A failure on one file is counted and stepped over. One unreadable song must
 * not stop the other several thousand.
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

  try {
    for (const track of tracks) {
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
        await ensure(track, profile);
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
