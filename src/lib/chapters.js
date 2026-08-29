// The chapter marks inside one audio file.
//
// This is the one thing in Sonorus that `music-metadata` cannot answer. It does
// expose `format.chapters`, and the note in the vault once said that would be
// enough - measured on 2026-08-29 against the real library it returns an empty
// list for every Audible m4b here, while the marks are plainly in the files
// (ffprobe finds 59 in "Das Paket", 391 in "Der Anschlag"). So ffprobe reads
// them, which costs one short process per book part and only on a scan that
// actually re-reads the file.
//
// ffprobe ships with ffmpeg, which the image already installs for the smaller
// streaming quality, so this adds no dependency. Without it the books simply
// have no chapters - the same shape of degradation as a missing ffmpeg, and the
// player is built to do without them.

import { spawn } from 'node:child_process';

const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';

// A book of forty hours is still only a few hundred marks; a file that answers
// with megabytes of them is broken, and reading all of it would be the bug.
const MAX_OUTPUT = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/**
 * The chapters of one file, in the order they play, as `{ title, start }` with
 * `start` in seconds. An empty list means the file has none - which is the
 * ordinary answer for a song, an episode and a book that was ripped per chapter
 * into separate files.
 */
export async function readChapters(filePath) {
  const raw = await runProbe(filePath);
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  return list
    .map((chapter, i) => ({
      // ffprobe hands the start twice: `start_time` in seconds as a string, and
      // `start` in the file's own time base. The seconds are the ones that need
      // no arithmetic and no guess about the base.
      start: Number(chapter.start_time),
      title: String((chapter.tags && chapter.tags.title) || '').trim(),
      order: i,
    }))
    .filter((chapter) => Number.isFinite(chapter.start) && chapter.start >= 0)
    // A file whose marks are out of order would draw a seek bar that jumps
    // backwards, so the order is decided here rather than trusted.
    .sort((a, b) => a.start - b.start || a.order - b.order)
    .map(({ start, title }) => ({ start, title }));
}

function runProbe(filePath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        ffprobeBin,
        ['-v', 'error', '-print_format', 'json', '-show_chapters', filePath],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      return resolve('');
    }

    let out = '';
    let over = false;
    const timer = setTimeout(() => {
      over = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (out.length > MAX_OUTPUT) return;
      out += chunk;
    });
    // No ffprobe at all is not an error worth stopping a scan for: it means the
    // library has no chapters, and every other thing about the file was read
    // long before this ran.
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(over || code !== 0 ? '' : out);
    });
  });
}
