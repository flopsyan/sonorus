// ffprobe and ffmpeg for the video side: what a file contains, where its
// keyframes are, and small copies of the artwork lying next to it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';

// Text subtitles can be turned into cues; bitmap ones (PGS, DVD) cannot without OCR.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

export function run(bin, args, { timeout = 60_000, maxOutput = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => {
      if (out.length < maxOutput) out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-2000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited with ${code}: ${err.trim()}`));
    });
  });
}

const lang = (s) => String((s.tags && s.tags.language) || '').toLowerCase();
const label = (s) => String((s.tags && (s.tags.title || s.tags.handler_name)) || '').trim();

/** The streams of one video file, shaped for the player. */
export async function probeVideo(file) {
  const raw = await run(ffprobeBin, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const data = JSON.parse(raw);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const format = data.format || {};

  // Cover art inside an mkv or mp4 is a video stream too, flagged attached_pic.
  const v = streams.find(
    (s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)
  );
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name || '',
      channels: s.channels || 0,
      lang: lang(s),
      title: label(s),
      default: !!(s.disposition && s.disposition.default),
    }));
  const subs = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name || '',
      lang: lang(s),
      title: label(s),
      forced: !!(s.disposition && s.disposition.forced),
      default: !!(s.disposition && s.disposition.default),
      text: TEXT_SUBS.has(s.codec_name),
    }));

  return {
    duration: Number(format.duration) || Number(v && v.duration) || 0,
    container: String(format.format_name || ''),
    video: v
      ? {
          index: v.index,
          codec: v.codec_name || '',
          profile: v.profile || '',
          width: v.width || 0,
          height: v.height || 0,
          pixFmt: v.pix_fmt || '',
          interlaced: ['tt', 'bb', 'tb', 'bt'].includes(v.field_order),
          hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
        }
      : null,
    audio,
    subs,
  };
}

/**
 * The last keyframe at or before `at` seconds. Copying the video stream can only
 * start on one, so the player is told where the stream really begins and its
 * clock and the subtitles stay exact.
 */
export async function keyframeBefore(file, at) {
  if (at <= 0) return 0;
  const from = Math.max(0, at - 20);
  try {
    const out = await run(
      ffprobeBin,
      [
        '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
        '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0',
        '-read_intervals', `${from}%${at + 0.05}`, file,
      ],
      { timeout: 20_000 }
    );
    let best = -1;
    for (const line of out.split('\n')) {
      for (const cell of line.split(',')) {
        const t = Number(cell);
        if (Number.isFinite(t) && t <= at + 0.01 && t > best) best = t;
      }
    }
    return best >= 0 ? best : from;
  } catch {
    return from;
  }
}

/**
 * A copy of an image at most `width` wide. SVG is copied as it is: ffmpeg does
 * not rasterise it, and a browser draws it sharp at any size anyway.
 */
export async function resizeImage(source, target, width) {
  if (fs.existsSync(target)) return;
  const temp = `${target}.${process.pid}.tmp${target.slice(target.lastIndexOf('.'))}`;
  if (source.toLowerCase().endsWith('.svg')) {
    await fsp.copyFile(source, temp);
  } else {
    const png = target.endsWith('.png');
    // A logo is a PNG because it is transparent, and scaling a palette PNG
    // drops the alpha unless the frame is made RGBA first - which left the
    // transparent parts standing in whatever colour the palette had behind
    // them (a green box around Stranger Things, 2026-09-22).
    const filter = `${png ? 'format=rgba,' : ''}scale=w='min(${width},iw)':h=-2`;
    await run(
      ffmpegBin,
      [
        '-nostdin', '-v', 'error', '-y', '-i', source, '-frames:v', '1',
        '-vf', filter,
        ...(png ? [] : ['-q:v', '3']),
        temp,
      ],
      { timeout: 30_000 }
    );
  }
  await fsp.rename(temp, target);
}

export { ffmpegBin, ffprobeBin };
