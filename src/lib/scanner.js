// Library scanner: walks the mounted music folder, reads the tags out of every
// audio file and writes the result into the library tables.
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

import db, { coversDir, musicDir, setMeta } from '../db.js';
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

// --- Cover art --------------------------------------------------------------

const setAlbumCover = db.prepare('UPDATE albums SET cover = ? WHERE id = ?');

// Stores the album artwork once per album: the embedded picture if the file has
// one, otherwise a cover image sitting next to the audio file.
async function storeCover(album, meta, filePath) {
  if (!album || album.cover) return;

  const picture = meta.common.picture && meta.common.picture[0];
  if (picture && picture.data && picture.data.length) {
    const ext = COVER_MIME_EXT[String(picture.format || '').toLowerCase()] || '.jpg';
    const name = `album-${album.id}${ext}`;
    await fsp.writeFile(path.join(coversDir, name), Buffer.from(picture.data));
    setAlbumCover.run(name, album.id);
    album.cover = name;
    return;
  }

  const dir = path.dirname(filePath);
  for (const base of COVER_NAMES) {
    for (const ext of COVER_EXT) {
      const candidate = path.join(dir, base + ext);
      try {
        const buf = await fsp.readFile(candidate);
        const name = `album-${album.id}${ext === '.jpeg' ? '.jpg' : ext}`;
        await fsp.writeFile(path.join(coversDir, name), buf);
        setAlbumCover.run(name, album.id);
        album.cover = name;
        return;
      } catch {
        // no such file - try the next candidate
      }
    }
  }
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

const selectTrackByPath = db.prepare('SELECT id, size, mtime FROM tracks WHERE path = ?');
const insertTrack = db.prepare(`
  INSERT INTO tracks (path, title, artist_id, album_id, track_no, disc_no, year, duration,
                      bitrate, codec, lossless, size, mtime, norm_title, loose_title, norm_artist)
  VALUES (@path, @title, @artist_id, @album_id, @track_no, @disc_no, @year, @duration,
          @bitrate, @codec, @lossless, @size, @mtime, @norm_title, @loose_title, @norm_artist)
`);
const updateTrack = db.prepare(`
  UPDATE tracks SET title = @title, artist_id = @artist_id, album_id = @album_id,
                    track_no = @track_no, disc_no = @disc_no, year = @year, duration = @duration,
                    bitrate = @bitrate, codec = @codec, lossless = @lossless, size = @size,
                    mtime = @mtime, norm_title = @norm_title, loose_title = @loose_title,
                    norm_artist = @norm_artist
   WHERE id = @id
`);
const clearTrackGenres = db.prepare('DELETE FROM track_genres WHERE track_id = ?');
const linkTrackGenre = db.prepare(
  'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
);

// A file with no title tag still deserves a name: use the file name.
function titleFrom(meta, filePath) {
  const tagged = String(meta.common.title || '').trim();
  if (tagged) return tagged;
  return path.basename(filePath, path.extname(filePath));
}

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

async function indexFile(filePath, stat) {
  const existing = selectTrackByPath.get(filePath);
  if (existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs)) {
    state.skipped += 1;
    return;
  }

  const meta = await parseFile(filePath, { duration: true });
  const common = meta.common || {};
  const format = meta.format || {};

  const trackArtist = String(common.artist || '').trim() || 'Unbekannter Interpret';
  const albumArtist = String(common.albumartist || '').trim() || trackArtist;
  const aId = artistId(trackArtist);
  const albumArtistId = artistId(albumArtist);
  const alId = albumId(common.album, albumArtistId, common.year);

  const title = titleFrom(meta, filePath);
  const row = {
    path: filePath,
    title,
    artist_id: aId,
    album_id: alId,
    track_no: (common.track && common.track.no) || null,
    disc_no: (common.disk && common.disk.no) || null,
    year: common.year || null,
    duration: format.duration || 0,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    codec: String(format.codec || format.container || ''),
    lossless: format.lossless ? 1 : 0,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    norm_title: normalize(title),
    loose_title: loosen(title),
    norm_artist: primaryArtist(trackArtist),
  };

  writeTrack(row, Array.isArray(common.genre) ? common.genre : [], existing && existing.id);

  if (existing) state.updated += 1;
  else state.added += 1;

  if (alId) {
    const album = db.prepare('SELECT id, cover FROM albums WHERE id = ?').get(alId);
    await storeCover(album, meta, filePath);
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

    const seen = new Set();
    for (const file of files) {
      seen.add(file);
      try {
        const stat = await fsp.stat(file);
        await indexFile(file, stat);
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
