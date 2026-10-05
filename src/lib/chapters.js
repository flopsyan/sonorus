// Chapter marks via ffprobe: music-metadata's `format.chapters` is empty for every
// Audible m4b in the real library although the marks are there. ffprobe ships with
// ffmpeg; without it books simply have no chapters, which the player handles.

import { spawn } from 'node:child_process';

const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';

// A book of forty hours is still only a few hundred marks; a file that answers
// with megabytes of them is broken, and reading all of it would be the bug.
const MAX_OUTPUT = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/**
 * The chapters in play order as `{ title, start }`, `start` in seconds. An empty list
 * is the normal answer for a song, an episode or a book ripped per chapter.
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

    child.stdout.setEncoding('utf8'); // a chunk boundary can split a UTF-8 character
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
