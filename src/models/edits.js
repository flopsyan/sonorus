// Hand edits to the library.
//
// The music folder is read-only and stays that way: an edit here changes what
// Sonorus shows, never the file. Everything lands in the database (and, for a
// cover, in the data directory), and each edited field sets a lock so the next
// scan puts the file's version back only where nobody has decided otherwise.
//
// What can be edited is what the file has to answer: year, genres and cover.
// Title, artist and track number come from the folder structure - editing those
// here would only last until the next scan reads the folder names again.

import fs from 'node:fs/promises';
import path from 'node:path';

import db, { coversDir } from '../db.js';

// Image types a browser can be trusted to render, with the first bytes every
// one of them has to start with. An uploaded cover is served back to browsers,
// so it is not taken on the word of its content type alone.
const IMAGE_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { ext: '.png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/webp': { ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46] },
};

const MAX_COVER_BYTES = 6 * 1024 * 1024;

function parseYear(value) {
  if (value === null || value === undefined || value === '') return { ok: true, year: null };
  const year = Number.parseInt(value, 10);
  if (!Number.isInteger(year) || year < 1000 || year > 2999) return { ok: false };
  return { ok: true, year };
}

// "Rock, Indie Pop" -> ['Rock', 'Indie Pop']. Duplicates and empty entries go.
function parseGenres(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Map();
  for (const part of parts) {
    const name = String(part).trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

async function writeCover(albumId, cover) {
  const type = IMAGE_TYPES[String(cover.type || '').toLowerCase()];
  if (!type) return { error: 'bad_image' };

  let data;
  try {
    data = Buffer.from(String(cover.data || ''), 'base64');
  } catch {
    return { error: 'bad_image' };
  }
  if (!data.length || data.length > MAX_COVER_BYTES) return { error: 'image_too_big' };
  if (!type.magic.every((byte, i) => data[i] === byte)) return { error: 'bad_image' };

  // A new name per save, so a replaced cover is not served from the browser
  // cache under the old URL.
  const name = `album-${albumId}-${Date.now()}${type.ext}`;
  await fs.writeFile(path.join(coversDir, name), data);
  return { name };
}

// Deletes a cover file that no album references any more. Best effort: a file
// left behind is harmless, a failed edit would not be.
async function dropCoverFile(name) {
  if (!name) return;
  const inUse = db.prepare('SELECT 1 FROM albums WHERE cover = ?').get(name);
  if (inUse) return;
  try {
    await fs.unlink(path.join(coversDir, name));
  } catch {
    // already gone
  }
}

const setGenres = db.transaction((albumId, genres) => {
  const tracks = db.prepare('SELECT id FROM tracks WHERE album_id = ?').all(albumId);
  const findGenre = db.prepare('SELECT id FROM genres WHERE name = ?');
  const addGenre = db.prepare('INSERT INTO genres (name) VALUES (?)');
  const clear = db.prepare('DELETE FROM track_genres WHERE track_id = ?');
  const link = db.prepare('INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  const lock = db.prepare('UPDATE tracks SET genres_locked = 1 WHERE id = ?');

  const ids = genres.map((name) => {
    const found = findGenre.get(name);
    return found ? found.id : Number(addGenre.run(name).lastInsertRowid);
  });

  for (const track of tracks) {
    clear.run(track.id);
    for (const genreId of ids) link.run(track.id, genreId);
    lock.run(track.id);
  }

  // A genre nobody uses any more should not stay in the sidebar.
  db.exec('DELETE FROM genres WHERE id NOT IN (SELECT genre_id FROM track_genres)');
});

// Applies the parts of `patch` that are present. Every field is optional, so
// the dialog can send only what changed.
export async function updateAlbum(albumId, patch) {
  const album = db.prepare('SELECT id, cover FROM albums WHERE id = ?').get(albumId);
  if (!album) return { error: 'not_found' };

  if ('year' in patch) {
    const year = parseYear(patch.year);
    if (!year.ok) return { error: 'invalid_year' };
    db.prepare('UPDATE albums SET year = ?, year_locked = 1 WHERE id = ?').run(year.year, album.id);
  }

  if ('genres' in patch) {
    setGenres(album.id, parseGenres(patch.genres));
  }

  if ('cover' in patch) {
    const previous = album.cover;
    if (patch.cover === null) {
      db.prepare("UPDATE albums SET cover = '', cover_locked = 1 WHERE id = ?").run(album.id);
    } else {
      const written = await writeCover(album.id, patch.cover || {});
      if (written.error) return { error: written.error };
      db.prepare('UPDATE albums SET cover = ?, cover_locked = 1 WHERE id = ?').run(written.name, album.id);
    }
    await dropCoverFile(previous);
  }

  return { ok: true };
}

// The year of a single. An album track takes its year from its album, so this
// is only for the files that belong to none - they have nowhere else to carry
// one. Same deal as an album edit: it lives in the database, and the lock keeps
// the next scan from putting the file's year back (an emptied year too).
export function updateTrackYear(trackId, value) {
  const track = db.prepare('SELECT id, album_id FROM tracks WHERE id = ?').get(trackId);
  if (!track) return { error: 'not_found' };
  if (track.album_id) return { error: 'not_a_single' };

  const year = parseYear(value);
  if (!year.ok) return { error: 'invalid_year' };

  db.prepare('UPDATE tracks SET year = ?, year_locked = 1 WHERE id = ?').run(year.year, track.id);
  return { ok: true };
}
