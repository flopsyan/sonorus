// Getting a video file into a browser. Three ways, cheapest first:
//
//   direct   the file as it lies, with Range, when the browser plays it as is
//   remux    ffmpeg copies the picture into fragmented MP4 and converts only
//            the sound (E-AC-3, DTS) or picks one of several audio tracks
//   encode   ffmpeg re-encodes the picture too (MPEG-2, or HEVC for a
//            browser without HEVC) - the only one that costs real CPU
//
// A piped stream cannot seek, so the player asks for a new one starting at the
// position it wants and adds that offset to its own clock.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { subtitleDir } from '../db.js';
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

// `caps` beyond hevc/av1/vp9 comes from the phone, which reports its own
// decoders: `video` and `audio` list further codecs, `hevcMkv` says HEVC plays
// out of Matroska, `tracks` that it can pick one of several audio tracks itself.
// A browser sends none of them and keeps the browser rules.
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

// One running ffmpeg per account: a seek starts a new stream, and the old one
// must not keep encoding into a socket nobody reads.
const running = new Map();

/** How far the account's stream of this video has got, for the player's stats overlay. */
export function streamStats(userId, videoId) {
  const child = running.get(userId);
  if (!child || child.stats.videoId !== videoId) return null;
  const { sent, rate, waitFrom } = child.stats;
  return { sent, rate, waiting: !!waitFrom };
}

// ffmpeg blocks while the socket is full, so its own speed= sinks to 1x once the
// browser has enough. Only the time it was free to write says how fast it can go.
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
      if (busy > 300 && stats.next > stats.sent) {
        const sample = (stats.next - stats.sent) / (busy / 1000);
        stats.rate = stats.rate === null ? sample : stats.rate * 0.7 + sample * 0.3;
      }
    }
    stats.at = t;
    stats.waitedAt = waited;
    stats.sent = stats.next;
  }
}

/** Pipes ffmpeg's fragmented MP4 into the response until the browser hangs up. */
export function pipeStream(req, res, video, absPath, { start, vc, audio, ac, userId }) {
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
    // nothing to map
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

  const previous = running.get(userId);
  if (previous) previous.kill('SIGKILL');

  const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  child.stats = { videoId: video.id, line: '', next: 0, sent: 0, rate: null, at: 0, waitedAt: 0, waitedMs: 0, waitFrom: 0 };
  child.stdio[3].on('data', (chunk) => trackProgress(child.stats, chunk));
  running.set(userId, child);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.on('error', (err) => {
    console.warn('Sonorus: ffmpeg could not start:', err.message);
    if (!res.headersSent) res.status(500).end();
  });
  child.on('close', (code, signal) => {
    if (running.get(userId) === child) running.delete(userId);
    if (code && !signal && stderr) console.warn(`Sonorus: ffmpeg stream of video ${video.id} ended with ${code}: ${stderr.trim()}`);
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
  });
  // pipe() by hand, to know when the socket holds ffmpeg back.
  child.stdout.on('data', (chunk) => {
    if (!res.write(chunk)) {
      child.stdout.pause();
      child.stats.waitFrom = Date.now();
    }
  });
  res.on('drain', () => {
    if (child.stats.waitFrom) child.stats.waitedMs += Date.now() - child.stats.waitFrom;
    child.stats.waitFrom = 0;
    child.stdout.resume();
  });
  child.stdout.on('end', () => res.end());
  req.on('close', () => {
    child.kill('SIGKILL');
    // A paused stdout never reaches its end, and without it the child never closes.
    child.stdout.destroy();
  });
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
