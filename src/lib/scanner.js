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
// Only what the folders cannot say is still read from the file: year, genre,
// duration, format and the embedded cover art.
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
const SCANNER_VERSION = 'folders-1';

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
  'SELECT id, year, cover FROM albums WHERE title = ? AND artist_id IS ?'
);
const insertAlbum = db.prepare('INSERT INTO albums (title, artist_id, year) VALUES (?, ?, ?)');
const touchAlbumYear = db.prepare('UPDATE albums SET year = ? WHERE id = ? AND year IS NULL');

function albumId(title, aId, year) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  const found = selectAlbum.get(clean, aId);
  if (found) {
    if (year && !found.year) touchAlbumYear.run(year, found.id);
    return found.id;
  }
  return Number(insertAlbum.run(clean, aId, year || null).lastInsertRowid);
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

// "01 - Titel", "01 Titel", "1-01 Titel". Only used inside an album folder, so
// a single called "1979.flac" keeps its name.
function splitTrackNumber(base) {
  const withDisc = base.match(/^(\d{1,2})\s*[-_.]\s*(\d{1,3})\s*[-._)]?\s+(.+)$/);
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
  const base = path.basename(filePath, path.extname(filePath)).trim();

  const artist = parts.length > 1 ? parts[0].trim() : UNKNOWN_ARTIST;
  const album = parts.length > 2 ? parts[1].trim() : '';
  if (!album) return { artist, album: '', title: base, trackNo: null, discNo: null };

  const parsed = splitTrackNumber(base);
  // A disc folder carries the disc number the file name usually leaves out.
  const dirName = parts[parts.length - 2];
  const discDir = dirName === album ? null : DISC_DIR.exec(dirName);
  return {
    artist,
    album,
    title: parsed.title,
    trackNo: parsed.trackNo,
    discNo: discDir ? Number(discDir[1]) : parsed.discNo,
  };
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

// The album keeps the first artwork any of its tracks turns up.
async function storeAlbumCover(albumId_, meta, filePath) {
  const album = db.prepare('SELECT id, cover FROM albums WHERE id = ?').get(albumId_);
  if (!album || album.cover) return;
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

const selectTrackByPath = db.prepare('SELECT id, size, mtime, cover FROM tracks WHERE path = ?');
const insertTrack = db.prepare(`
  INSERT INTO tracks (path, title, artist_id, album_id, track_no, disc_no, year, duration,
                      bitrate, codec, lossless, cover, size, mtime, norm_title, loose_title, norm_artist)
  VALUES (@path, @title, @artist_id, @album_id, @track_no, @disc_no, @year, @duration,
          @bitrate, @codec, @lossless, @cover, @size, @mtime, @norm_title, @loose_title, @norm_artist)
`);
const updateTrack = db.prepare(`
  UPDATE tracks SET title = @title, artist_id = @artist_id, album_id = @album_id,
                    track_no = @track_no, disc_no = @disc_no, year = @year, duration = @duration,
                    bitrate = @bitrate, codec = @codec, lossless = @lossless, cover = @cover,
                    size = @size, mtime = @mtime, norm_title = @norm_title,
                    loose_title = @loose_title, norm_artist = @norm_artist
   WHERE id = @id
`);
const clearTrackGenres = db.prepare('DELETE FROM track_genres WHERE track_id = ?');
const linkTrackGenre = db.prepare(
  'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
);

const writeTrack = db.transaction((row, genres, existingId) => {
  let id = existingId;
  if (id) {
    updateTrack.run({ ...row, id });
  } else {
    id = Number(insertTrack.run(row).lastInsertRowid);
  }
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
    state.skipped += 1;
    return;
  }

  const meta = await parseFile(filePath, { duration: true });
  const common = meta.common || {};
  const format = meta.format || {};

  // The folders decide artist, album, title and track number; the file only
  // fills in what a folder name cannot say.
  const place = describeFile(filePath);
  const aId = artistId(place.artist);
  const alId = place.album ? albumId(place.album, aId, common.year) : null;

  const row = {
    path: filePath,
    title: place.title,
    artist_id: aId,
    album_id: alId,
    track_no: place.trackNo,
    disc_no: place.discNo,
    year: common.year || null,
    duration: format.duration || 0,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    codec: String(format.codec || format.container || ''),
    lossless: format.lossless ? 1 : 0,
    // Only singles carry their own artwork; an album track shows its album's.
    cover: alId ? '' : (existing && existing.cover) || '',
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    norm_title: normalize(place.title),
    loose_title: loosen(place.title),
    norm_artist: primaryArtist(place.artist),
  };

  const trackId = writeTrack(row, Array.isArray(common.genre) ? common.genre : [], existing && existing.id);

  if (existing) state.updated += 1;
  else state.added += 1;

  if (alId) {
    await storeAlbumCover(alId, meta, filePath);
  } else if (!row.cover) {
    const name = await storeCoverFile(meta, filePath, `track-${trackId}`, false);
    if (name) setTrackCover.run(name, trackId);
  }
}

// --- Pruning ----------------------------------------------------------------

// Removes rows whose file is gone, then the artists, albums and genres that no
// track references any more. Playlist entries and ratings pointing at a removed
// track cascade away with it.
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
      const del = db.prepare('DELETE FROM tracks WHERE id = ?');
      db.transaction(() => gone.forEach((id) => del.run(id)))();
      state.removed = gone.length;
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
