// Fetches lyrics from LRCLIB for every song Sonorus has none for, and writes each as
// `<song>.lrc` next to its audio file. Runs outside the server, whose music mount stays
// read-only. An existing .lrc is never overwritten.
//
//   node tools/fetch-lyrics.js --db <copy of sonorus.sqlite> --music <music folder>
//                              [--out <folder>] [--report <file.tsv>] [--limit <n>]
//
// --db wants a copy: SQLite in WAL mode cannot be shared with the server across hosts.
// --out writes the files into another folder (same layout) instead of the library.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

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
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`Unexpected argument: ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.db || !opts.music) throw new Error('Usage: fetch-lyrics.js --db <file> --music <folder> [--out <folder>] [--report <file>] [--limit <n>]');
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

// "Queen & David Bowie" against "Queen": either side may carry a guest the other leaves out.
function sameArtist(a, b) {
  const x = plain(a);
  const y = plain(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
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
  if (hit && (hit.syncedLyrics || hit.instrumental)) return hit;
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
  return close.find((r) => r.syncedLyrics) || hit || close.find((r) => r.plainLyrics) || close.find((r) => r.instrumental) || null;
}

function kindOf(hit) {
  if (!hit) return 'miss';
  if (hit.syncedLyrics) return 'synced';
  if (hit.plainLyrics) return 'plain';
  return hit.instrumental ? 'instrumental' : 'miss';
}

async function main() {
  const opts = options(process.argv.slice(2));
  const musicDir = path.resolve(opts.music);
  const outDir = path.resolve(opts.out || opts.music);

  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const songs = db
    .prepare(
      `SELECT t.path, t.title, t.duration, COALESCE(NULLIF(t.track_artist, ''), ar.name) AS artist,
              COALESCE(al.title, '') AS album
         FROM tracks t
         LEFT JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums al ON al.id = t.album_id
        WHERE t.lyrics = '' AND t.missing_at = '' AND t.podcast_id IS NULL AND t.audiobook_id IS NULL
        ORDER BY t.path`
    )
    .all()
    .filter((song) => song.path.startsWith(SERVER_MUSIC_DIR + '/'))
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
    if (!fs.existsSync(path.join(musicDir, rel))) kind = 'gone';
    else if (fs.existsSync(path.join(musicDir, lrcRel)) || fs.existsSync(target)) kind = 'has-lrc';
    else {
      try {
        const hit = await lookup(song);
        kind = kindOf(hit);
        if (kind === 'synced' || kind === 'plain') {
          const text = (hit.syncedLyrics || hit.plainLyrics).trimEnd() + '\n';
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, text, { flag: 'wx' });
        }
      } catch (err) {
        kind = 'error';
        song.error = err.message;
      }
    }

    counts[kind] = (counts[kind] || 0) + 1;
    rows.push([kind, song.artist, song.album, song.title, rel, song.error || ''].join('\t'));
    if ((i + 1) % 100 === 0 || i + 1 === songs.length) {
      const minutes = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[${i + 1}/${songs.length}, ${minutes} min] ${JSON.stringify(counts)}`);
    }
  }

  if (opts.report) fs.writeFileSync(opts.report, ['kind\tartist\talbum\ttitle\tpath\terror', ...rows].join('\n') + '\n');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
