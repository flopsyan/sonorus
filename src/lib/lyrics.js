// Lyrics from an audio file or the .lrc next to it: plain text, or timed lines that can
// follow the song. LRC is a text format, so a timed lyric can arrive as one plain string in
// any tag; this module reads the timestamps back out. Nothing is fetched from elsewhere.

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

// Some taggers write a newline as a bare `n` (the backslash of `\n` lost on the way), so a
// timed lyric arrives as one line with the other stamps inside it: "to men[00:20.59] As I".
// An `n` glued to a stamp is never words, so it is the line break.
const GLUED_STAMP = /n(?=\[\d{1,3}:[0-5]?\d(?:[.:]\d{1,3})?\])/;

function stamp(time) {
  const ms = Math.round(time * 1000);
  return `[${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3)}]`;
}

// Timed lines with such run-together lines inside them, split back apart.
export function splitGlued(lines) {
  if (!lines.some((line) => GLUED_STAMP.test(line.text))) return lines;
  const lrc = lines.map((line) => stamp(line.time) + line.text).join('\n');
  return parseLrc(lrc.replace(new RegExp(GLUED_STAMP.source, 'g'), '\n'));
}

// The same fault in untimed text: "to menAs I was". Without stamps an `n` before a capital
// could be a word, so only text with no line break at all and several such joins is touched.
const GLUED_LINE = /(?<=[\p{Ll}?!.,)'"])n(?=[\p{Lu}(¿¡])/gu;
const GLUED_RUN = /([\p{L}']*?)(n+)(?=[\p{Lu}(¿¡])/gu;

export function repairUntimed(text) {
  const raw = String(text || '');
  if (/[\r\n]/.test(raw) || (raw.match(GLUED_LINE) || []).length < 3) return raw;
  // "downn" is down and a break, "younn" you and a blank line. The lyric's own words decide;
  // failing that, an n after a vowel, w or m is taken for the word's own ("again", "down").
  const known = new Set(raw.toLowerCase().split(/[^\p{L}']+/u));
  const ownN = (word) =>
    known.has(word + 'n') || (!known.has(word) && /[aeiouwm\u00e0-\u00f6\u00f8-\u00fc]$/.test(word));
  return raw.replace(GLUED_RUN, (match, word, run, offset) => {
    const before = word ? word.at(-1) : raw[offset - 1];
    if (!before || !/[\p{Ll}?!.,)'"]/u.test(before)) return match;
    const keep = run.length > 1 && word && ownN(word.toLowerCase()) ? 1 : 0;
    return word + 'n'.repeat(keep) + '\n'.repeat(Math.min(run.length - keep, 2));
  });
}

// True when a block of text is LRC rather than prose.
export function looksTimed(text) {
  LRC_TIME.lastIndex = 0;
  return LRC_TIME.test(String(text || ''));
}

// `{ text, lines, fromLrc }`, `lines` empty unless the lyric is timed. A file may carry several
// lyrics (languages, USLT next to SYLT), and a .lrc next to it is asked before them all:
// the first timed one wins, else the first with words. `fromLrc` says the .lrc won.
export function extractLyrics(common, sidecar = '') {
  const lrc = sidecar ? { text: sidecar } : null;
  const tags = [
    ...(lrc ? [lrc] : []),
    ...(Array.isArray(common && common.lyrics) ? common.lyrics : []),
  ];
  let text = '';
  let textFromLrc = false;

  for (const tag of tags) {
    if (!tag) continue;

    // A SYLT frame arrives already split into timed pieces. So does a plain
    // string tag that held LRC - music-metadata parses those on the way in.
    if (Array.isArray(tag.syncText) && tag.syncText.length && tag.timeStampFormat === MILLISECONDS) {
      const lines = splitGlued(
        tag.syncText
          .filter((line) => line && typeof line.timestamp === 'number')
          .map((line) => ({ time: line.timestamp / 1000, text: String(line.text || '').trim() }))
          .sort((a, b) => a.time - b.time)
      );
      if (lines.some((line) => line.text)) {
        return { text: lines.map((line) => line.text).join('\n').trim(), lines, fromLrc: false };
      }
    }

    const raw = String(tag.text || '').trim();
    if (!raw) continue;

    // A USLT frame is handed over as an object, so nothing parsed it on the way
    // in - and USLT is exactly where an LRC lyric usually hides.
    if (looksTimed(raw)) {
      const lines = splitGlued(parseLrc(raw));
      if (lines.some((line) => line.text)) {
        return { text: lines.map((line) => line.text).join('\n').trim(), lines, fromLrc: tag === lrc };
      }
    }

    if (!text) {
      text = repairUntimed(raw);
      textFromLrc = tag === lrc;
    }
  }

  return { text, lines: [], fromLrc: textFromLrc };
}
