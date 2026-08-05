// Lyrics as they come out of an audio file.
//
// Two shapes have to be told apart, and only one of them can follow the song:
// a plain block of text, and lines that each carry a timestamp. Which one a
// file has is not a question of the tag it used - LRC is a *text* format, so a
// perfectly timed lyric can arrive as one long string in a field that promises
// nothing. Reading the timestamps back out of that string is what this module
// is for.
//
// Nothing is fetched from anywhere: what the file does not carry does not
// exist for Sonorus.

// ID3v2's SYLT frame can count in MPEG frames instead of milliseconds, and a
// frame number cannot be turned into a position without the file. Only this
// format is usable; anything else is treated as unsynchronised text.
const MILLISECONDS = 2;

// One LRC timestamp: `[01:23.45]`, `[01:23.456]`, `[1:23]`. The fraction is
// read by its length, so both hundredths and milliseconds land on seconds.
// `[ar:Bowie]` and the other metadata tags never match - they have no digits
// where the minutes belong.
const LRC_TIME = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;

function seconds(minutes, secs, fraction) {
  const frac = fraction ? Number(fraction) / 10 ** fraction.length : 0;
  return Number(minutes) * 60 + Number(secs) + frac;
}

// Reads LRC out of a block of text. One line may carry several timestamps - a
// refrain is written once and stamped for every time it comes round - so each
// of them becomes a line of its own.
//
// Lines without a timestamp are dropped rather than kept in place: they are the
// `[ti:]` / `[ar:]` header, and a lyric that mixes timed and untimed lines has
// no position to show the untimed ones at.
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

// The lyrics of one file: `{ text, lines }`, where `lines` is empty unless the
// file knows when each line is sung.
//
// `common.lyrics` is an array because a file may carry several - different
// languages, or an unsynchronised USLT next to a synchronised SYLT. The first
// timed one wins; without any, the first that has words at all.
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
