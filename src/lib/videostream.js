// Cheapest first: direct (the file with Range), remux (picture copied into fragmented MP4,
// sound converted or picked), encode (picture re-encoded, the only real CPU cost). A piped
// stream cannot seek, so the player asks for a new one at its position and adds the offset.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { subtitleDir, transcodeDir } from '../db.js';
import { ffmpegBin, h264Args, keyframeBefore, run } from './media.js';

const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis']);
// ffmpeg seeks 3/23 s before -ss when the picture has B-frames, so -ss right on a
// keyframe landed one keyframe early: seconds of picture before any sound.
const PAST_KEYFRAME = 0.14;
const DIRECT_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

// Audio the viewer asked for, else the language they picked last, else German,
// else English, else whatever the file marks as default.
export function pickAudio(audio, { index, langs = [] } = {}) {
  if (!audio.length) return null;
  const byIndex = audio.find((a) => a.index === index);
  if (byIndex) return byIndex;
  for (const want of [...langs, 'ger', 'deu', 'de', 'eng', 'en']) {
    const hit = audio.find((a) => a.lang === want);
    if (hit) return hit;
  }
  return audio.find((a) => a.default) || audio[0];
}

// Beyond hevc/av1/vp9, `caps` comes from the phone: extra `video`/`audio` codecs, `hevcMkv`
// (HEVC out of Matroska), `tracks` (picks among audio tracks itself). A browser sends none.
export function videoPlayable(v, caps) {
  if (!v) return true;
  const eightBit = !v.pixFmt || /^yuvj?420p$/.test(v.pixFmt);
  if (v.codec === 'h264') return eightBit;
  if (v.codec === 'hevc') return !!caps.hevc;
  if (v.codec === 'av1') return !!caps.av1;
  if (v.codec === 'vp9') return !!caps.vp9;
  return (caps.video || []).includes(v.codec);
}

export function audioPlayable(a, caps) {
  return !a || BROWSER_AUDIO.has(a.codec) || (caps.audio || []).includes(a.codec);
}

/** True when the client can play the file exactly as it lies, with this audio track. */
export function playsAsIs(video, absPath, audio, caps) {
  const streams = JSON.parse(video.streams || '{}');
  const ext = path.extname(absPath).toLowerCase();
  // Firefox plays H.264 out of Matroska, but HEVC only out of MP4.
  const containerOk =
    ext in DIRECT_MIME && !(streams.video && streams.video.codec === 'hevc' && ext === '.mkv' && !caps.hevcMkv);
  return (
    videoPlayable(streams.video, caps) &&
    audioPlayable(audio, caps) &&
    containerOk &&
    ((streams.audio || []).length <= 1 || !!caps.tracks)
  );
}

/**
 * How one video is served to one client, starting at `start` seconds.
 * `force` skips the cheaper ways after the client has refused one of them.
 */
export async function planPlayback(video, absPath, { audioIndex, langs, start = 0, caps = {}, force = null }) {
  const streams = JSON.parse(video.streams || '{}');
  const audio = pickAudio(streams.audio || [], { index: audioIndex, langs });
  const videoOk = videoPlayable(streams.video, caps);
  const audioOk = audioPlayable(audio, caps);
  const base = { audio: audio ? audio.index : null };

  if (!force && playsAsIs(video, absPath, audio, caps)) {
    return { ...base, mode: 'direct', offset: 0, start, url: `/api/videos/${video.id}/file` };
  }

  const copy = videoOk && force !== 'encode';
  // A retry converts the sound too: a phone can list a decoder and still fail on the
  // track (a Pixel with E-AC-3 Atmos), and then every retry failed the same way.
  const soundCopy = audioOk && (!force || (audio && audio.codec === 'aac'));
  const offset = copy ? (await keyframeBefore(absPath, start)) + PAST_KEYFRAME : Math.max(0, start);
  const query = new URLSearchParams({
    start: String(Math.round(offset * 1000) / 1000),
    vc: copy ? 'copy' : 'h264',
    ...(audio ? { audio: String(audio.index), ac: soundCopy ? 'copy' : 'aac' } : {}),
  });
  return {
    ...base,
    mode: copy ? 'remux' : 'encode',
    offset,
    start,
    url: `/api/videos/${video.id}/stream?${query}`,
  };
}

export function directMime(absPath) {
  return DIRECT_MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
}

// ffmpeg writes each stream into a file, and every request for it is answered from
// that file. A browser or proxy that drops the connection then gets back in where it
// was instead of starting ffmpeg over from the plan's start.
const streamDir = path.join(transcodeDir, 'streams');
fs.rmSync(streamDir, { recursive: true, force: true });
fs.mkdirSync(streamDir, { recursive: true });

// The stream files share a disk with the database, so ffmpeg is held before it fills it.
const MIN_FREE = 2 * 1024 ** 3;
const CHECK_EVERY = 32 * 1024 ** 2;
const IDLE_MS = 30 * 60_000;
const READ_CHUNK = 256 * 1024;

// One stream per account: a seek starts a new one, and the old one goes with its file.
const jobs = new Map();

/** How far the account's stream of this video has got, for the player's stats overlay. */
export function streamStats(userId, videoId) {
  const job = jobs.get(userId);
  if (!job || job.videoId !== videoId) return null;
  const { ready, rate, waitFrom } = job.stats;
  return { ready, rate, waiting: !!waitFrom, done: job.done && !job.failed };
}

// Seconds of media produced per second of work. Time held back for disk space is
// left out, so the number says how fast the server can go.
function trackProgress(stats, chunk) {
  stats.line += chunk;
  const lines = stats.line.split('\n');
  stats.line = lines.pop();
  for (const line of lines) {
    const out = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (out) stats.next = Number(out[1]) / 1e6;
    if (!line.startsWith('progress=')) continue;
    const t = Date.now();
    const waited = stats.waitedMs + (stats.waitFrom ? t - stats.waitFrom : 0);
    if (stats.at) {
      const busy = t - stats.at - (waited - stats.waitedAt);
      if (busy > 300 && stats.next > stats.ready) {
        const sample = (stats.next - stats.ready) / (busy / 1000);
        stats.rate = stats.rate === null ? sample : stats.rate * 0.7 + sample * 0.3;
      }
    }
    stats.at = t;
    stats.waitedAt = waited;
    stats.ready = stats.next;
  }
}

function streamArgs(video, absPath, { start, vc, audio, ac }) {
  const streams = JSON.parse(video.streams || '{}');
  const v = streams.video;
  const a = (streams.audio || []).find((x) => x.index === audio) || null;
  const enc =
    v && vc !== 'copy'
      ? h264Args([...(v.interlaced ? ['yadif'] : []), "scale=w='min(1920,iw)':h=-2"], {
          crf: '21',
          bitrate: v.height >= 720 ? '8M' : '3M',
          maxrate: '12M',
          bufsize: '24M',
        })
      : null;

  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:3', ...(enc ? enc.input : [])];
  // Picture and sound both start at the keyframe; the edit list then trims them to `start`.
  if (vc === 'copy') args.push('-noaccurate_seek');
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', absPath);
  if (v) args.push('-map', `0:${v.index}`);
  if (a) args.push('-map', `0:${a.index}`);

  if (!v) {
    // Audio only.
  } else if (vc === 'copy') {
    args.push('-c:v', 'copy');
    if (v.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    args.push(...enc.output, '-g', '48');
  }
  if (a) {
    if (ac === 'copy') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  args.push(
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    // delay_moov puts the B-frame delay, the AAC priming and the trim to `start` into
    // one edit list entry per track, the only form ExoPlayer reads as well.
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov',
    'pipe:1'
  );
  return args;
}

function freeBytes() {
  try {
    const st = fs.statfsSync(streamDir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

// Holds ffmpeg while the disk is short of MIN_FREE, and lets it go again once it is not.
function guardDisk(job) {
  if (job.stopped) return;
  if (freeBytes() >= MIN_FREE) {
    if (job.stats.waitFrom) {
      job.stats.waitedMs += Date.now() - job.stats.waitFrom;
      job.stats.waitFrom = 0;
    }
    if (!job.out.writableNeedDrain) job.child.stdout.resume();
    return;
  }
  if (!job.stats.waitFrom) job.stats.waitFrom = Date.now();
  job.child.stdout.pause();
  job.guardTimer = setTimeout(() => guardDisk(job), 10_000);
}

function stopJob(job) {
  if (jobs.get(job.userId) === job) jobs.delete(job.userId);
  job.stopped = true;
  clearTimeout(job.guardTimer);
  job.child.kill('SIGKILL');
  job.out.destroy();
  fs.rm(job.file, { force: true }, () => {});
  job.wake();
}

function startJob(userId, key, video, args) {
  const old = jobs.get(userId);
  if (old) stopJob(old);
  const job = {
    userId,
    key,
    videoId: video.id,
    file: path.join(streamDir, `${userId}-${Date.now()}.mp4`),
    written: 0,
    unchecked: 0,
    readers: 0,
    lastSeen: Date.now(),
    done: false,
    failed: false,
    stopped: false,
    waiters: [],
    stats: { line: '', next: 0, ready: 0, rate: null, at: 0, waitedAt: 0, waitedMs: 0, waitFrom: 0 },
  };
  job.wake = () => {
    const waiting = job.waiters;
    job.waiters = [];
    waiting.forEach((resolve) => resolve());
  };
  job.more = () => new Promise((resolve) => job.waiters.push(resolve));
  const finish = (failed) => {
    job.done = true;
    job.failed = failed;
    job.wake();
  };

  // Opened right here: the request that started the job reads the file a moment later.
  job.out = fs.createWriteStream(job.file, { fd: fs.openSync(job.file, 'w') });
  const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  job.child = child;
  jobs.set(userId, job);

  child.stdio[3].on('data', (chunk) => trackProgress(job.stats, chunk));
  child.stdout.on('data', (chunk) => {
    // Readers only see what the file really holds, so `written` moves in the callback.
    const more = job.out.write(chunk, (err) => {
      if (err) return;
      job.written += chunk.length;
      job.wake();
    });
    if (!more) child.stdout.pause();
    job.unchecked += chunk.length;
    if (job.unchecked >= CHECK_EVERY) {
      job.unchecked = 0;
      guardDisk(job);
    }
  });
  job.out.on('drain', () => {
    if (!job.stats.waitFrom) child.stdout.resume();
  });
  job.out.on('error', (err) => {
    console.warn(`Sonorus: stream file of video ${video.id}:`, err.message);
    child.kill('SIGKILL');
    finish(true);
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.on('error', (err) => {
    console.warn('Sonorus: ffmpeg could not start:', err.message);
    finish(true);
  });
  child.on('close', (code, signal) => {
    if (job.stopped) return;
    if (code && !signal && stderr) console.warn(`Sonorus: ffmpeg stream of video ${video.id} ended with ${code}: ${stderr.trim()}`);
    job.out.end(() => finish(!!(code || signal)));
  });
  return job;
}

const sweeper = setInterval(() => {
  for (const job of jobs.values()) {
    if (!job.readers && Date.now() - job.lastSeen > IDLE_MS) stopJob(job);
  }
}, 60_000);
sweeper.unref();

const drained = (res) =>
  new Promise((resolve) => {
    // Gone before the write: neither 'drain' nor 'close' will come again.
    if (res.destroyed) return resolve();
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });

// Follows the file as ffmpeg writes it, until the stream is complete or the client leaves.
async function tail(job, res) {
  job.readers += 1;
  const leave = () => job.wake();
  res.on('close', leave);
  let fh = null;
  try {
    fh = await fsp.open(job.file, 'r');
    let pos = 0;
    while (!res.destroyed && !job.stopped) {
      if (pos >= job.written) {
        if (job.done) break;
        await job.more();
        continue;
      }
      // A fresh buffer each time: res.write may hold on to it until it is sent.
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, job.written - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      job.lastSeen = Date.now();
      if (!res.write(buf.subarray(0, bytesRead))) await drained(res);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Sonorus: reading stream of video ${job.videoId}:`, err.message);
  } finally {
    job.readers -= 1;
    job.lastSeen = Date.now();
    res.off('close', leave);
    if (fh) await fh.close();
    res.end();
  }
}

/**
 * Answers one request for a remuxed or re-encoded stream. While ffmpeg still runs the
 * answer is the whole stream from its first byte (a browser asking for a range skips
 * ahead itself); once it is complete the file is served like any other, with ranges.
 */
export function serveStream(req, res, video, absPath, { start, vc, audio, ac, userId }) {
  const key = [video.id, start, vc, audio, ac].join('|');
  let job = jobs.get(userId);
  if (!job || job.key !== key || job.failed) job = startJob(userId, key, video, streamArgs(video, absPath, { start, vc, audio, ac }));
  job.lastSeen = Date.now();
  // Without it nginx spools the stream into its own temp files, up to 1 GB a request.
  const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };

  if (job.done && !job.failed) {
    job.readers += 1;
    res.on('close', () => {
      job.readers -= 1;
      job.lastSeen = Date.now();
    });
    res.sendFile(job.file, { headers, acceptRanges: true, cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
    return;
  }
  res.writeHead(200, { ...headers, 'Accept-Ranges': 'none' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  tail(job, res);
}

// --- Subtitles ----------------------------------------------------------------

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function seconds(stamp) {
  const m = TIME.exec(stamp);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

// Only italics, bold and underline survive; everything else a subtitle file can
// carry (fonts, colours, ASS override blocks) is dropped.
function cleanText(text) {
  return text
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(\/?)([ibu])\s*>/gi, '\u0001$1$2\u0002')
    .replace(/<[^>]*>/g, '')
    .replace(/\u0001(\/?)([ibu])\u0002/gi, (_, slash, tag) => `<${slash}${tag.toLowerCase()}>`)
    .replace(/\\N/g, '\n')
    .trim();
}

/** Cues out of SRT or WebVTT text: [{ s, e, t }], sorted by start. */
export function parseCues(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    const s = seconds(from);
    const e = seconds(to);
    const t = cleanText(lines.slice(at + 1).join('\n'));
    if (s == null || e == null || !t) continue;
    cues.push({ s, e, t });
  }
  return cues.sort((a, b) => a.s - b.s);
}

// German subtitle files are as often Windows-1252 as they are UTF-8.
function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

async function toSrt(source, map) {
  return run(ffmpegBin, ['-nostdin', '-v', 'error', '-i', source, ...(map ? ['-map', map] : []), '-f', 'srt', 'pipe:1'], {
    timeout: 30 * 60_000,
    maxOutput: 32 * 1024 * 1024,
  });
}

/** A subtitle file lying next to the video. */
export async function externalCues(absVideoPath, sub) {
  const file = path.join(path.dirname(absVideoPath), sub.file);
  if (sub.format === 'ass' || sub.format === 'ssa') return parseCues(await toSrt(file));
  return parseCues(decode(await fsp.readFile(file)));
}

const extracting = new Map();
const failedExtractions = new Set();

/**
 * A text subtitle stream inside the video. Getting at it means reading the whole
 * file, minutes for a large film on the NAS, so it runs once in the background
 * and is kept; until then the answer is null and the player asks again.
 */
export async function embeddedCues(video, absVideoPath, streamIndex) {
  const cache = path.join(subtitleDir, `v${video.id}-s${streamIndex}-${video.mtime}.srt`);
  if (fs.existsSync(cache)) return parseCues(decode(await fsp.readFile(cache)));
  if (failedExtractions.has(cache)) return [];
  if (!extracting.has(cache)) {
    const job = toSrt(absVideoPath, `0:${streamIndex}`)
      .then((srt) => fsp.writeFile(cache, srt))
      .catch((err) => {
        failedExtractions.add(cache);
        console.warn(`Sonorus: subtitle ${streamIndex} of video ${video.id}:`, err.message);
      })
      .finally(() => extracting.delete(cache));
    extracting.set(cache, job);
  }
  return null;
}
