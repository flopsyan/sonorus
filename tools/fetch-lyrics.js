// Fetches lyrics from LRCLIB for every song Sonorus has none for, and writes each as
// `<song>.lrc` next to its audio file. Runs outside the server, whose music mount stays
// read-only. An existing .lrc is never overwritten.
//
//   node tools/fetch-lyrics.js --db <copy of sonorus.sqlite> --music <music folder>
//     [--out <folder>] [--report <file.tsv>] [--limit <n>] [--paths <file>] [--untimed]
//
// --db wants a copy: SQLite in WAL mode cannot be shared with the server across hosts.
// --out writes the files into another folder (same layout) instead of the library.
// --paths only asks for the songs listed in the file, one path per line as in the report.
// --untimed asks for the songs whose lyrics have no timestamps, and keeps only timed hits.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseLrc } from '../src/lib/lyrics.js';

const API = 'https://lrclib.net/api';
const USER_AGENT = 'Sonorus fetch-lyrics (https://github.com/flopsyan/sonorus)';
// LRCLIB asks batch clients for one request at a time with a pause in between.
const PAUSE_MS = 300;
// LRCLIB itself only matches a recording within two seconds of the asked duration.
const DURATION_SLACK = 2;
// The music folder as the server sees it; the paths in the database start with it.
const SERVER_MUSIC_DIR = '/music';

function options(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      opts[argv[i].slice(2)] = true;
    } else {
      opts[argv[i].slice(2)] = value;
      i++;
    }
  }
  if (!opts.db || !opts.music) throw new Error('Usage: fetch-lyrics.js --db <file> --music <folder> [--out <folder>] [--report <file>] [--limit <n>] [--paths <file>] [--untimed]');
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(endpoint, params) {
  const url = `${API}/${endpoint}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status === 503) && attempt < 8) {
      await sleep((Number(res.headers.get('retry-after')) || 5) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`LRCLIB answered ${res.status}`);
    return res.json();
  }
}

async function ask(endpoint, params) {
  const answer = await call(endpoint, params);
  await sleep(PAUSE_MS);
  return answer;
}

const plain = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const CREDIT_SEPARATOR = /\s*(?:[&,;/+]|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\band\b|\bund\b)\s*/i;
const credits = (s) => String(s || '').split(CREDIT_SEPARATOR).map(plain).filter(Boolean);

// Either side may carry a guest the other leaves out: "Queen & David Bowie" credits Queen.
// Whole names only, so "3 Doors Down" does not count as "3".
function sameArtist(found, wanted) {
  const x = plain(found);
  const y = plain(wanted);
  return Boolean(x && y) && (x === y || credits(found).includes(y) || credits(wanted).includes(x));
}

// "Instrumental" stands in for words in many records that are not marked instrumental.
const PLACEHOLDER = /^[\s()[\]♪.-]*(instrumental)?[\s()[\]♪.-]*$/i;
// LRC header tags ("[ar:Pink Floyd]") and "Title: ..." lines describe a song, they are not its words.
const TAG = /^\s*\[[a-z]+:[^\]]*\]\s*$/i;
const isWords = (line) => !PLACEHOLDER.test(line) && !TAG.test(line) && !/^\s*(artist|album|title)\s*:/i.test(line);

// A timed lyric whose words run past the end of the song was timed against another version.
function timedFor(record, song) {
  // Sonorus does not apply an `[offset:]` tag, so such stamps would all be off by it.
  if (/^\s*\[offset:\s*[+-]?0*[1-9]/im.test(String((record && record.syncedLyrics) || ''))) return false;
  const lines = parseLrc(record && record.syncedLyrics).filter((line) => isWords(line.text));
  return lines.length > 0 && !(song.duration > 0 && lines[lines.length - 1].time > song.duration + 1);
}

// Sonorus shows untimed text as it is, so header tags would show up as words.
function textOf(record) {
  const lines = String((record && record.plainLyrics) || '').split(/\r?\n/).filter((line) => !TAG.test(line));
  return lines.some(isWords) ? lines.join('\n').trim() : '';
}

// What a record is worth for this song. Words timed for another version still count as text.
function verdict(record, song) {
  if (!record) return { kind: 'miss' };
  if (timedFor(record, song)) return { kind: 'synced', text: record.syncedLyrics };
  const text =
    textOf(record) ||
    parseLrc(record.syncedLyrics).map((line) => line.text).filter(isWords).join('\n');
  if (text) return { kind: 'plain', text };
  return { kind: record.instrumental || record.syncedLyrics || record.plainLyrics ? 'instrumental' : 'miss' };
}

// The exact lookup often lands on a plain-text record while a timed one of the same length
// sits next to it, so anything short of timed goes on to a search. Search results count
// only where artist and duration agree.
async function lookup(song) {
  const known = song.duration > 0;
  const base = { track_name: song.title, artist_name: song.artist };
  if (known) base.duration = Math.round(song.duration);

  // Albums are named differently everywhere, so a miss with the album is asked again without.
  let hit = song.album ? await ask('get', { ...base, album_name: song.album }) : null;
  if (!hit) hit = await ask('get', base);
  if (hit && (timedFor(hit, song) || hit.instrumental)) return hit;
  if (!known) return hit;

  let found;
  try {
    found = (await ask('search', { track_name: song.title, artist_name: song.artist })) || [];
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
  const close = found
    .filter((r) => Math.abs(r.duration - song.duration) <= DURATION_SLACK && sameArtist(r.artistName, song.artist))
    .sort((a, b) => Math.abs(a.duration - song.duration) - Math.abs(b.duration - song.duration));
  return close.find((r) => timedFor(r, song)) || hit || close.find(textOf) || close.find((r) => r.instrumental) || null;
}

async function main() {
  const opts = options(process.argv.slice(2));
  const musicDir = path.resolve(opts.music);
  const outDir = path.resolve(opts.out || opts.music);

  const only = opts.paths ? new Set(fs.readFileSync(opts.paths, 'utf8').split('\n').filter(Boolean)) : null;
  const which = opts.untimed ? "t.lyrics <> '' AND t.lyrics_sync = ''" : "t.lyrics = ''";

  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const songs = db
    .prepare(
      `SELECT t.path, t.title, t.duration, COALESCE(NULLIF(t.track_artist, ''), ar.name) AS artist,
              COALESCE(al.title, '') AS album
         FROM tracks t
         LEFT JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums al ON al.id = t.album_id
        WHERE ${which} AND t.missing_at = '' AND t.podcast_id IS NULL AND t.audiobook_id IS NULL
        ORDER BY t.path`
    )
    .all()
    .filter((song) => song.path.startsWith(SERVER_MUSIC_DIR + '/'))
    .filter((song) => !only || only.has(path.relative(SERVER_MUSIC_DIR, song.path)))
    .slice(0, opts.limit ? Number(opts.limit) : undefined);
  db.close();

  const counts = {};
  const rows = [];
  const started = Date.now();

  for (const [i, song] of songs.entries()) {
    const rel = path.relative(SERVER_MUSIC_DIR, song.path);
    const lrcRel = rel.slice(0, -path.extname(rel).length) + '.lrc';
    const target = path.join(outDir, lrcRel);

    let kind;
    let hit = null;
    if (!fs.existsSync(path.join(musicDir, rel))) kind = 'gone';
    else if (fs.existsSync(path.join(musicDir, lrcRel)) || fs.existsSync(target)) kind = 'has-lrc';
    else {
      try {
        hit = await lookup(song);
        const found = verdict(hit, song);
        kind = found.kind;
        // Plain text is no gain over the untimed lyrics the song already has.
        if (opts.untimed && kind === 'plain') kind = 'no-sync';
        if (kind === 'synced' || kind === 'plain') {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, found.text.trimEnd() + '\n', { flag: 'wx' });
        }
      } catch (err) {
        kind = 'error';
        song.error = err.message;
      }
    }

    counts[kind] = (counts[kind] || 0) + 1;
    const match = hit ? `${hit.id}: ${hit.artistName} - ${hit.trackName} (${hit.duration} s)` : '';
    rows.push([kind, song.artist, song.album, song.title, Math.round(song.duration), rel, match, song.error || ''].join('\t'));
    if ((i + 1) % 100 === 0 || i + 1 === songs.length) {
      const minutes = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[${i + 1}/${songs.length}, ${minutes} min] ${JSON.stringify(counts)}`);
    }
  }

  if (opts.report) fs.writeFileSync(opts.report, ['kind\tartist\talbum\ttitle\tduration\tpath\tmatch\terror', ...rows].join('\n') + '\n');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
