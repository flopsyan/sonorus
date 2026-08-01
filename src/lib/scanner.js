// Library scanner: walks the mounted music folder and writes what it finds into
// the library tables.
//
// Who made a track and where it belongs comes from the folder structure, not
// from the file tags - tags are inconsistent across a collection and put songs
// under artists and albums nobody asked for. The layout is the contract:
//
//   music/<Interpret>/<Album>/01 - Titel.flac   album track
//   music/<Interpret>/Titel.flac                single, belongs to no album
//
// Only what the folders cannot say is still read from the file: release date,
// genre, duration, format and the embedded cover art.
//
// The music folder is read-only. Everything the scanner produces (rows, cover
// art) lives in the data directory, so a rescan can always rebuild the library
// from the files without touching them.
//
// Files whose size and modification time are unchanged since the last scan are
// skipped, which makes a rescan of a large library cheap.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';

import db, { coversDir, musicDir, getMeta, setMeta } from '../db.js';
import { normalize, loosen, primaryArtist } from './normalize.js';
import { parseReleaseDate, yearOf } from './dates.js';
import { resolveIssuesForUser } from '../models/issues.js';

// Extensions music-metadata can read tags from. Whether a browser can play a
// given file is a separate question (see the README).
const AUDIO_EXT = new Set([
  '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus',
  '.wav', '.wv', '.aif', '.aiff', '.aifc', '.wma', '.ape', '.mpc', '.dsf', '.dff',
]);

// Cover files next to the audio, used when a file carries no embedded artwork.
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const COVER_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// Bumped whenever the scanner reads a file differently than it used to. A
// changed version makes the next scan re-read every file instead of skipping
// the unchanged ones, so an existing library picks up the new interpretation.
const SCANNER_VERSION = 'escaped-dot-1';

const COVER_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Live progress of the running scan, polled by the settings page.
const state = {
  running: false,
  phase: 'idle', // idle | walking | reading | pruning | done | error
  total: 0,
  done: 0,
  added: 0,
  updated: 0,
  removed: 0,
  kept: 0, // files gone, rows kept because a rating or playlist needs them
  skipped: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  error: '',
};

export function scanState() {
  return { ...state, musicDir };
}

export function isScanning() {
  return state.running;
}

// --- Row helpers ------------------------------------------------------------

const selectArtist = db.prepare('SELECT id FROM artists WHERE name = ?');
const insertArtist = db.prepare('INSERT INTO artists (name) VALUES (?)');

function artistId(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const found = selectArtist.get(clean);
  if (found) return found.id;
  return Number(insertArtist.run(clean).lastInsertRowid);
}

const selectAlbum = db.prepare(
  'SELECT id, release_date, cover FROM albums WHERE title = ? AND artist_id IS ?'
);
const insertAlbum = db.prepare(
  'INSERT INTO albums (title, artist_id, year, release_date) VALUES (?, ?, ?, ?)'
);
// The album takes the most precise date any of its tracks carries: an empty
// column is filled, and a bare year gives way to the same year with a day on it
// ('2015' -> '2015-05-17'). A date the user typed in by hand is never touched.
const touchAlbumDate = db.prepare(
  `UPDATE albums SET year = @year, release_date = @date
    WHERE id = @id AND year_locked = 0
      AND length(release_date) < length(@date) AND instr(@date, release_date) = 1`
);

function albumId(title, aId, date) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  const found = selectAlbum.get(clean, aId);
  if (found) {
    if (date) touchAlbumDate.run({ id: found.id, date, year: yearOf(date) });
    return found.id;
  }
  return Number(insertAlbum.run(clean, aId, yearOf(date), date).lastInsertRowid);
}

const selectGenre = db.prepare('SELECT id FROM genres WHERE name = ?');
const insertGenre = db.prepare('INSERT INTO genres (name) VALUES (?)');

function genreId(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const found = selectGenre.get(clean);
  if (found) return found.id;
  return Number(insertGenre.run(clean).lastInsertRowid);
}

// --- Where a file sits in the folder structure -------------------------------

const UNKNOWN_ARTIST = 'Unbekannter Interpret';

// A folder inside an album that only groups one disc of it ("CD1", "Disc 2").
const DISC_DIR = /^(?:cd|disc|disk)\s*[-_. ]?(\d{1,2})$/i;

// A name starting with a dot is hidden and never walked (see collectFiles), so
// an album like "...Baby One More Time" would never be scanned. Escaping that
// dot with a backslash - "\...Baby One More Time" - takes the hiding away on
// the filesystem; the backslash is not part of the name and is dropped here, so
// the library shows the title the way it is meant to read.
function unhide(name) {
  return name.startsWith('\\.') ? name.slice(1) : name;
}

// "01 - Titel", "01 Titel", "1-01 Titel". Only used inside an album folder, so
// a single called "1979.flac" keeps its name.
function splitTrackNumber(base) {
  // A disc prefix is written tight ("1-01 Titel"), and that is the only thing
  // that tells it apart from a track number followed by a title that starts
  // with a number: "02 - 400 Lux" is track 2 of "400 Lux", not disc 2 of
  // track 400. So no space is allowed around the separator here.
  const withDisc = base.match(/^(\d{1,2})[-_.](\d{1,3})\s*[-._)]?\s+(.+)$/);
  if (withDisc) {
    return { discNo: Number(withDisc[1]), trackNo: Number(withDisc[2]), title: withDisc[3].trim() };
  }
  const m = base.match(/^(\d{1,3})\s*[-._)]\s*(.+)$/) || base.match(/^(\d{1,3})\s+(.+)$/);
  if (!m) return { discNo: null, trackNo: null, title: base };
  return { discNo: null, trackNo: Number(m[1]), title: m[2].trim() || base };
}

// Reads artist, album, track number and title off the path. Everything below
// the artist folder that is not an album folder is a single.
function describeFile(filePath) {
  const parts = path.relative(musicDir, filePath).split(path.sep);
  const base = unhide(path.basename(filePath, path.extname(filePath)).trim());

  const artist = parts.length > 1 ? unhide(parts[0].trim()) : UNKNOWN_ARTIST;
  const album = parts.length > 2 ? unhide(parts[1].trim()) : '';
  if (!album) return { artist, album: '', title: base, trackNo: null, discNo: null };

  const parsed = splitTrackNumber(base);
  // A disc folder carries the disc number the file name usually leaves out.
  const dirName = unhide(parts[parts.length - 2]);
  const discDir = dirName === album ? null : DISC_DIR.exec(dirName);
  return {
    artist,
    album,
    title: parsed.title,
    trackNo: parsed.trackNo,
    discNo: discDir ? Number(discDir[1]) : parsed.discNo,
  };
}

// --- The release date -------------------------------------------------------

// The most precise date the tags of one file agree on. `date` is the primary
// tag, the other two only refine it: a source that says the same year with a
// month or a day on it wins, one that says another year does not - it is a
// different release then, and the primary tag decides which one this file is.
// Without any usable date the bare year tag is still a date.
function releaseDate(common) {
  let best = '';
  for (const raw of [common.date, common.releasedate, common.originaldate]) {
    const date = parseReleaseDate(raw);
    if (!date) continue;
    if (!best) best = date;
    else if (date.length > best.length && date.startsWith(best)) best = date;
  }
  return best || parseReleaseDate(common.year) || '';
}

// --- Cover art --------------------------------------------------------------

const setAlbumCover = db.prepare('UPDATE albums SET cover = ? WHERE id = ?');
const setTrackCover = db.prepare('UPDATE tracks SET cover = ? WHERE id = ?');

// Writes one artwork file into the covers directory and returns its name, or
// an empty string when the file carries none. `fromFolder` allows a cover image
// lying next to the audio: right for an album folder, wrong for a single, where
// the image next to it belongs to the artist and not to that one song.
async function storeCoverFile(meta, filePath, baseName, fromFolder) {
  const picture = meta.common.picture && meta.common.picture[0];
  if (picture && picture.data && picture.data.length) {
    const ext = COVER_MIME_EXT[String(picture.format || '').toLowerCase()] || '.jpg';
    const name = `${baseName}${ext}`;
    await fsp.writeFile(path.join(coversDir, name), Buffer.from(picture.data));
    return name;
  }
  if (!fromFolder) return '';

  const dir = path.dirname(filePath);
  for (const base of COVER_NAMES) {
    for (const ext of COVER_EXT) {
      try {
        const buf = await fsp.readFile(path.join(dir, base + ext));
        const name = `${baseName}${ext === '.jpeg' ? '.jpg' : ext}`;
        await fsp.writeFile(path.join(coversDir, name), buf);
        return name;
      } catch {
        // no such file - try the next candidate
      }
    }
  }
  return '';
}

// The album keeps the first artwork any of its tracks turns up - unless the
// user picked one, in which case that one stays, even if it was removed.
async function storeAlbumCover(albumId_, meta, filePath) {
  const album = db.prepare('SELECT id, cover, cover_locked FROM albums WHERE id = ?').get(albumId_);
  if (!album || album.cover || album.cover_locked) return;
  const name = await storeCoverFile(meta, filePath, `album-${album.id}`, true);
  if (name) setAlbumCover.run(name, album.id);
}

// --- Walking the folder -----------------------------------------------------

// Collects every audio file under the music folder. Symlinked directories are
// followed but remembered, so a loop cannot make the walk run forever.
async function collectFiles(root) {
  const files = [];
  const seenDirs = new Set();

  async function walk(dir) {
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch {
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      } else if (entry.isSymbolicLink()) {
        try {
          const st = await fsp.stat(full);
          if (st.isDirectory()) await walk(full);
          else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) files.push(full);
        } catch {
          // broken symlink
        }
      }
    }
  }

  await walk(root);
  return files;
}

// --- Writing one track ------------------------------------------------------

const selectTrackByPath = db.prepare(
  `SELECT id, size, mtime, year, release_date, cover, missing_at, genres_locked, year_locked,
          cover_locked
     FROM tracks WHERE path = ?`
);
const markFound = db.prepare("UPDATE tracks SET missing_at = '' WHERE id = ?");
const insertTrack = db.prepare(`
  INSERT INTO tracks (path, title, artist_id, album_id, track_no, disc_no, year, release_date,
                      duration, bitrate, codec, lossless, cover, missing_at, genres_locked,
                      year_locked, cover_locked, size, mtime, norm_title, loose_title, norm_artist)
  VALUES (@path, @title, @artist_id, @album_id, @track_no, @disc_no, @year, @release_date,
          @duration, @bitrate, @codec, @lossless, @cover, @missing_at, @genres_locked,
          @year_locked, @cover_locked, @size, @mtime, @norm_title, @loose_title, @norm_artist)
`);
const updateTrack = db.prepare(`
  UPDATE tracks SET title = @title, artist_id = @artist_id, album_id = @album_id,
                    track_no = @track_no, disc_no = @disc_no, year = @year,
                    release_date = @release_date, duration = @duration,
                    bitrate = @bitrate, codec = @codec, lossless = @lossless, cover = @cover,
                    missing_at = @missing_at, genres_locked = @genres_locked,
                    year_locked = @year_locked, cover_locked = @cover_locked,
                    size = @size, mtime = @mtime,
                    norm_title = @norm_title, loose_title = @loose_title, norm_artist = @norm_artist
   WHERE id = @id
`);
const clearTrackGenres = db.prepare('DELETE FROM track_genres WHERE track_id = ?');
const linkTrackGenre = db.prepare(
  'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
);

// `keepGenres` is set for a track whose genres the user edited by hand - the
// file's genres would otherwise win back on the next scan.
const writeTrack = db.transaction((row, genres, existingId, keepGenres) => {
  let id = existingId;
  if (id) {
    updateTrack.run({ ...row, id });
  } else {
    id = Number(insertTrack.run(row).lastInsertRowid);
  }
  if (keepGenres) return id;

  clearTrackGenres.run(id);
  for (const name of genres) {
    const gid = genreId(name);
    if (gid) linkTrackGenre.run(id, gid);
  }
  return id;
});

async function indexFile(filePath, stat, force) {
  const existing = selectTrackByPath.get(filePath);
  if (!force && existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs)) {
    // A file that was marked missing and is back unchanged never reaches the
    // write below, so it is cleared here.
    if (existing.missing_at) markFound.run(existing.id);
    state.skipped += 1;
    return;
  }

  const meta = await parseFile(filePath, { duration: true });
  const common = meta.common || {};
  const format = meta.format || {};

  // The folders decide artist, album, title and track number; the file only
  // fills in what a folder name cannot say.
  const place = describeFile(filePath);
  const date = releaseDate(common);
  const aId = artistId(place.artist);
  const alId = place.album ? albumId(place.album, aId, date) : null;

  // A date the user typed in by hand on a single stays - the file's would
  // otherwise win it back on the next scan.
  const yearLocked = !!(existing && existing.year_locked);

  const row = {
    path: filePath,
    title: place.title,
    artist_id: aId,
    album_id: alId,
    track_no: place.trackNo,
    disc_no: place.discNo,
    year: yearLocked ? existing.year : yearOf(date),
    release_date: yearLocked ? existing.release_date : date,
    duration: format.duration || 0,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    codec: String(format.codec || format.container || ''),
    lossless: format.lossless ? 1 : 0,
    // Only singles carry their own artwork; an album track shows its album's,
    // which is also why a track moving into an album loses the lock with it.
    cover: alId ? '' : (existing && existing.cover) || '',
    missing_at: '',
    genres_locked: (existing && existing.genres_locked) || 0,
    year_locked: yearLocked ? 1 : 0,
    cover_locked: alId ? 0 : (existing && existing.cover_locked) || 0,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    norm_title: normalize(place.title),
    loose_title: loosen(place.title),
    norm_artist: primaryArtist(place.artist),
  };

  const trackId = writeTrack(
    row,
    Array.isArray(common.genre) ? common.genre : [],
    existing && existing.id,
    !!(existing && existing.genres_locked)
  );

  if (existing) state.updated += 1;
  else state.added += 1;

  if (alId) {
    await storeAlbumCover(alId, meta, filePath);
    // A cover the user picked for the single stays, and one the user removed
    // stays removed - the embedded picture would win it back otherwise.
  } else if (!row.cover && !row.cover_locked) {
    const name = await storeCoverFile(meta, filePath, `track-${trackId}`, false);
    if (name) setTrackCover.run(name, trackId);
  }
}

// --- Pruning ----------------------------------------------------------------

// A star rating outlives its file: deleting the row would cascade the rating
// away, so a track someone has rated, put in a playlist or listened to is only
// marked as missing and stays visible - greyed out, with its path. Everything
// else nobody would miss is deleted as before.
const isReferenced = db.prepare(`
  SELECT 1 FROM ratings        WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM playlist_items WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM plays          WHERE track_id = @id
   LIMIT 1
`);
const markMissing = db.prepare('UPDATE tracks SET missing_at = @now WHERE id = @id');
const deleteTrack = db.prepare('DELETE FROM tracks WHERE id = ?');

const retireTracks = db.transaction((ids) => {
  const now = new Date().toISOString();
  let removed = 0;
  for (const id of ids) {
    if (isReferenced.get({ id })) markMissing.run({ id, now });
    else {
      deleteTrack.run(id);
      removed += 1;
    }
  }
  return removed;
});

// Removes the artists, albums and genres that no track references any more.
// Playlist entries and ratings pointing at a deleted track cascade away with it.
const prune = db.transaction(() => {
  db.exec(`
    DELETE FROM albums
     WHERE id NOT IN (SELECT album_id FROM tracks WHERE album_id IS NOT NULL);
    DELETE FROM artists
     WHERE id NOT IN (SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL)
       AND id NOT IN (SELECT artist_id FROM albums WHERE artist_id IS NOT NULL);
    DELETE FROM genres
     WHERE id NOT IN (SELECT genre_id FROM track_genres);
  `);
});

// --- The scan ---------------------------------------------------------------

// Runs one full scan. Returns immediately if a scan is already running, so a
// double click on "Bibliothek scannen" cannot start two walks.
export async function runScan() {
  if (state.running) return scanState();

  Object.assign(state, {
    running: true,
    phase: 'walking',
    total: 0,
    done: 0,
    added: 0,
    updated: 0,
    removed: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: '',
  });

  try {
    if (!fs.existsSync(musicDir)) {
      throw new Error(`Musikordner nicht gefunden: ${musicDir}`);
    }

    const files = await collectFiles(musicDir);
    state.total = files.length;
    state.phase = 'reading';

    // After a change to how a file is read, the size/mtime shortcut would keep
    // the old interpretation alive forever - so read everything once.
    const force = getMeta('scanner_version') !== SCANNER_VERSION;

    const seen = new Set();
    for (const file of files) {
      seen.add(file);
      try {
        const stat = await fsp.stat(file);
        await indexFile(file, stat, force);
      } catch (err) {
        state.failed += 1;
        console.warn(`Sonorus: could not read ${file}:`, err && err.message ? err.message : err);
      }
      state.done += 1;
    }

    state.phase = 'pruning';
    const known = db.prepare('SELECT id, path FROM tracks').all();
    const gone = known.filter((t) => !seen.has(t.path)).map((t) => t.id);
    if (gone.length) {
      state.removed = retireTracks(gone);
      state.kept = gone.length - state.removed;
    }
    prune();

    // Songs that were missing at import time may exist now.
    resolveIssuesForUser(null);

    setMeta('scanner_version', SCANNER_VERSION);
    setMeta('last_scan', new Date().toISOString());
    state.phase = 'done';
  } catch (err) {
    state.phase = 'error';
    state.error = err && err.message ? err.message : String(err);
    console.error('Sonorus: library scan failed:', err);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }

  return scanState();
}

// Kicks off a scan on start according to SCAN_ON_START (auto | always | never).
export function scanOnStart() {
  const mode = String(process.env.SCAN_ON_START || 'auto').toLowerCase();
  if (mode === 'never') return;
  if (mode === 'auto') {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM tracks').get();
    if (c > 0) return;
  }
  runScan().catch((err) => console.error('Sonorus: initial scan failed:', err));
}
