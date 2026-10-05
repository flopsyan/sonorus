// Lyrics from an audio file: plain text, or timed lines that can follow the song.
// LRC is a text format, so a timed lyric can arrive as one plain string in any tag;
// this module reads the timestamps back out. Nothing is fetched from elsewhere.

// ID3v2's SYLT frame can count in MPEG frames instead of milliseconds, and a
// frame number cannot be turned into a position without the file. Only this
// format is usable; anything else is treated as unsynchronised text.
const MILLISECONDS = 2;

// `[01:23.45]`, `[01:23.456]`, `[1:23]`: the fraction is read by its length. Metadata
// tags like `[ar:Bowie]` never match - they have no digits where the minutes belong.
const LRC_TIME = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;

function seconds(minutes, secs, fraction) {
  const frac = fraction ? Number(fraction) / 10 ** fraction.length : 0;
  return Number(minutes) * 60 + Number(secs) + frac;
}

// A refrain is written once with several stamps, so each stamp becomes its own line.
// Untimed lines are dropped: they are the `[ti:]`/`[ar:]` header, or have no position.
export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    LRC_TIME.lastIndex = 0;
    const stamps = [...raw.matchAll(LRC_TIME)];
    if (!stamps.length) continue;
    // Everything after the last timestamp is the words; the stamps themselves
    // sit at the head of the line.
    const words = raw.slice(stamps[stamps.length - 1].index + stamps[stamps.length - 1][0].length).trim();
    for (const stamp of stamps) lines.push({ time: seconds(stamp[1], stamp[2], stamp[3]), text: words });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// True when a block of text is LRC rather than prose.
export function looksTimed(text) {
  LRC_TIME.lastIndex = 0;
  return LRC_TIME.test(String(text || ''));
}

// `{ text, lines }`, `lines` empty unless the file is timed. A file may carry several
// lyrics (languages, USLT next to SYLT): the first timed one wins, else the first with words.
export function extractLyrics(common) {
  const tags = Array.isArray(common && common.lyrics) ? common.lyrics : [];
  let text = '';

  for (const tag of tags) {
    if (!tag) continue;

    // A SYLT frame arrives already split into timed pieces. So does a plain
    // string tag that held LRC - music-metadata parses those on the way in.
    if (Array.isArray(tag.syncText) && tag.syncText.length && tag.timeStampFormat === MILLISECONDS) {
      const lines = tag.syncText
        .filter((line) => line && typeof line.timestamp === 'number')
        .map((line) => ({ time: line.timestamp / 1000, text: String(line.text || '').trim() }))
        .sort((a, b) => a.time - b.time);
      if (lines.some((line) => line.text)) {
        return { text: lines.map((line) => line.text).join('\n').trim(), lines };
      }
    }

    const raw = String(tag.text || '').trim();
    if (!raw) continue;

    // A USLT frame is handed over as an object, so nothing parsed it on the way
    // in - and USLT is exactly where an LRC lyric usually hides.
    if (looksTimed(raw)) {
      const lines = parseLrc(raw);
      if (lines.some((line) => line.text)) {
        return { text: lines.map((line) => line.text).join('\n').trim(), lines };
      }
    }

    if (!text) text = raw;
  }

  return { text, lines: [] };
}
