// Getting a film or an episode onto the phone. The file as it lies whenever the
// phone plays it (and, for "small", when it is small already). Anything else is
// written by ffmpeg into a phone-ready MP4 first - one at a time, at low
// priority, so a download never stalls the music - and the phone polls until it
// is there. A piped stream would not do: it cannot resume and cannot seek.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transcodeDir } from '../db.js';
import { ffmpegBin } from './media.js';
import { audioPlayable, pickAudio, playsAsIs, videoPlayable } from './videostream.js';

// A subfolder: the music cache's eviction only looks at top-level files.
const dir = path.join(transcodeDir, 'videos');
// A prepared file the phone has not read for this long is gone.
const KEEP_MS = 24 * 3600 * 1000;
// What "small" aims at, picture plus sound. A file already below it is sent as
// it is; the margin keeps a file right at the line from being encoded for nothing.
const SMALL_BITS = 2_000_000 + 128_000;
const SMALL_MARGIN = 1.1;
// Sound that goes into an MP4 as it is; anything else becomes AAC.
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3']);

fs.mkdirSync(dir, { recursive: true });
for (const name of fs.readdirSync(dir)) {
  if (name.endsWith('.part')) fs.rmSync(path.join(dir, name), { force: true });
}

const jobs = new Map(); // key -> { args, duration, progress, error, child }
const queue = [];
let running = null;

function bitrate(video) {
  return video.duration > 0 && video.size > 0 ? (video.size * 8) / video.duration : Infinity;
}

/**
 * What the phone gets for one video: `file` (the original), or a variant ffmpeg
 * has to write - `remux` (picture copied, sound made playable), `full` (picture
 * encoded at its own size, up to 1080p) or `small` (720p).
 */
export function downloadVariant(video, absPath, { quality, caps, langs }) {
  const streams = JSON.parse(video.streams || '{}');
  const audio = pickAudio(streams.audio || [], { langs });
  const asIs = playsAsIs(video, absPath, audio, caps);
  const small = quality === 'small';
  if (asIs && (!small || bitrate(video) <= SMALL_BITS * SMALL_MARGIN)) return { kind: 'file', audio };
  if (small) return { kind: 'small', audio };
  if (videoPlayable(streams.video, caps)) {
    return { kind: 'remux', audio, copyAudio: !!audio && MP4_AUDIO.has(audio.codec) && audioPlayable(audio, caps) };
  }
  return { kind: 'full', audio };
}

export function variantKey(video, variant) {
  return `${video.id}-${video.mtime}-${variant.kind}-a${variant.audio ? variant.audio.index : 'x'}`;
}

export const preparedPath = (key) => path.join(dir, `${key}.mp4`);

function ffmpegArgs(video, absPath, variant) {
  const streams = JSON.parse(video.streams || '{}');
  const v = streams.video;
  const a = variant.audio;
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', absPath];
  if (v) args.push('-map', `0:${v.index}`);
  if (a) args.push('-map', `0:${a.index}`);
  if (v && variant.kind === 'remux') {
    args.push('-c:v', 'copy');
    if (v.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else if (v) {
    const filters = [];
    if (v.interlaced) filters.push('yadif');
    const small = variant.kind === 'small';
    filters.push(small ? "scale=w=-2:h='min(720,ih)'" : "scale=w='min(1920,iw)':h=-2", 'format=yuv420p');
    args.push(
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', small ? '23' : '21',
      '-maxrate', small ? '2M' : '12M', '-bufsize', small ? '4M' : '24M', '-profile:v', 'high'
    );
  }
  if (a) {
    if (variant.copyAudio) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', variant.kind === 'small' ? '128k' : '192k', '-ac', '2');
  }
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', '-y');
  return args;
}

function startNext() {
  if (running || !queue.length) return;
  const key = queue.shift();
  const job = jobs.get(key);
  if (!job) return startNext();
  running = key;
  const target = preparedPath(key);
  const part = `${target}.part`;
  const child = spawn(ffmpegBin, [...job.args, part], { stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  try {
    os.setPriority(child.pid, 10);
  } catch {
    // Not allowed on every system; it only makes the encode politer.
  }
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const times = [...String(chunk).matchAll(/out_time_us=(\d+)/g)];
    const last = times.length ? Number(times[times.length - 1][1]) : 0;
    if (last > 0 && job.duration > 0) job.progress = Math.min(0.99, last / 1e6 / job.duration);
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const finish = (error) => {
    if (running === key) running = null;
    job.child = null;
    if (error) {
      fs.rmSync(part, { force: true });
      if (jobs.get(key) === job) job.error = error;
    } else {
      fs.renameSync(part, target);
      jobs.delete(key);
    }
    startNext();
  };
  child.on('error', (err) => finish(err.message));
  child.on('close', (code, signal) => {
    if (signal) return finish('abgebrochen');
    if (code) {
      console.warn(`Sonorus: preparing video ${key} for download failed: ${stderr.trim()}`);
      return finish(stderr.trim().split('\n').pop() || `ffmpeg ${code}`);
    }
    finish(null);
  });
}

function sweep() {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.part')) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (stat && stat.mtimeMs < cutoff) fs.rmSync(full, { force: true });
  }
}

/**
 * Where a prepared download stands, starting it when nobody has yet. Asking
 * again is how the phone polls; a failed job is retried on the next ask.
 */
export function prepare(video, absPath, variant) {
  sweep();
  const key = variantKey(video, variant);
  const target = preparedPath(key);
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (stat) return { ready: true, key, size: stat.size };
  let job = jobs.get(key);
  if (job && job.error) {
    const error = job.error;
    jobs.delete(key);
    return { ready: false, key, error };
  }
  if (!job) {
    job = { args: ffmpegArgs(video, absPath, variant), duration: video.duration || 0, progress: 0, error: null, child: null };
    jobs.set(key, job);
    queue.push(key);
    startNext();
  }
  return { ready: false, key, progress: job.progress, queued: running === key ? 0 : queue.indexOf(key) + 1 };
}

/** The phone has the file, or no longer wants it: stop the job and drop the copy. */
export function release(key) {
  const job = jobs.get(key);
  if (job) {
    jobs.delete(key);
    const at = queue.indexOf(key);
    if (at >= 0) queue.splice(at, 1);
    if (job.child) job.child.kill('SIGKILL');
  }
  fs.rmSync(preparedPath(key), { force: true });
}

/** Reading a prepared file counts as using it, so the sweep leaves it alone. */
export function touch(key) {
  const now = new Date();
  try {
    fs.utimesSync(preparedPath(key), now, now);
  } catch {
    // Gone already; the send that follows answers 404.
  }
}
