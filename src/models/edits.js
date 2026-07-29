// Hand edits to the library.
//
// The music folder is read-only and stays that way: an edit here changes what
// Sonorus shows, never the file. Everything lands in the database (and, for a
// cover, in the data directory), and each edited field sets a lock so the next
// scan puts the file's version back only where nobody has decided otherwise.
//
// What can be edited is what the file has to answer: release date, genres and
// cover.
// Title, artist and track number come from the folder structure - editing those
// here would only last until the next scan reads the folder names again. The
// profile picture of an artist is the one thing that comes from nowhere else at
// all, so it needs no lock: no scan ever writes it.

import fs from 'node:fs/promises';
import path from 'node:path';

import db, { coversDir } from '../db.js';
import { parseReleaseDate, yearOf } from '../lib/dates.js';

// Image types a browser can be trusted to render, with the first bytes every
// one of them has to start with. An uploaded cover is served back to browsers,
// so it is not taken on the word of its content type alone.
const IMAGE_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { ext: '.png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/webp': { ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46] },
};

const MAX_COVER_BYTES = 6 * 1024 * 1024;

// The date is typed in as exactly as it is known: a full day, a month or just a
// year. Empty clears it. The year column is derived from it, so the two can
// never say different things.
function parseDate(value) {
  const date = parseReleaseDate(value);
  if (date === null) return { ok: false };
  return { ok: true, date, year: yearOf(date) };
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

// `baseName` says what the picture belongs to ("album-7", "artist-3",
// "track-91"); the timestamp appended to it is what stops the browser from
// serving the old picture from cache after a replacement.
async function writeCover(baseName, cover) {
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

  const name = `${baseName}-${Date.now()}${type.ext}`;
  await fs.writeFile(path.join(coversDir, name), data);
  return { name };
}

// Deletes a cover file nothing references any more. Best effort: a file left
// behind is harmless, a failed edit would not be.
async function dropCoverFile(name) {
  if (!name) return;
  const inUse = db
    .prepare(
      `SELECT 1 FROM albums  WHERE cover = @name
        UNION ALL
       SELECT 1 FROM artists WHERE cover = @name
        UNION ALL
       SELECT 1 FROM tracks  WHERE cover = @name
       LIMIT 1`
    )
    .get({ name });
  if (inUse) return;
  try {
    await fs.unlink(path.join(coversDir, name));
  } catch {
    // already gone
  }
}

// Genres are stored per track, never on the album - `track_genres` stays the
// single source for the Genres view. So an album edit writes the same list to
// every track of the album, and a single edit to the one track it is about.
const setGenres = db.transaction((trackIds, genres) => {
  const findGenre = db.prepare('SELECT id FROM genres WHERE name = ?');
  const addGenre = db.prepare('INSERT INTO genres (name) VALUES (?)');
  const clear = db.prepare('DELETE FROM track_genres WHERE track_id = ?');
  const link = db.prepare('INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)');
  const lock = db.prepare('UPDATE tracks SET genres_locked = 1 WHERE id = ?');

  const ids = genres.map((name) => {
    const found = findGenre.get(name);
    return found ? found.id : Number(addGenre.run(name).lastInsertRowid);
  });

  for (const trackId of trackIds) {
    clear.run(trackId);
    for (const genreId of ids) link.run(trackId, genreId);
    lock.run(trackId);
  }

  // A genre nobody uses any more should not stay in the sidebar.
  db.exec('DELETE FROM genres WHERE id NOT IN (SELECT genre_id FROM track_genres)');
});

const albumTrackIds = db.prepare('SELECT id FROM tracks WHERE album_id = ?');

// Applies the parts of `patch` that are present. Every field is optional, so
// the dialog can send only what changed.
export async function updateAlbum(albumId, patch) {
  const album = db.prepare('SELECT id, cover FROM albums WHERE id = ?').get(albumId);
  if (!album) return { error: 'not_found' };

  if ('date' in patch) {
    const parsed = parseDate(patch.date);
    if (!parsed.ok) return { error: 'invalid_date' };
    db.prepare(
      'UPDATE albums SET year = ?, release_date = ?, year_locked = 1 WHERE id = ?'
    ).run(parsed.year, parsed.date, album.id);
  }

  if ('genres' in patch) {
    setGenres(
      albumTrackIds.all(album.id).map((row) => row.id),
      parseGenres(patch.genres)
    );
  }

  if ('cover' in patch) {
    const previous = album.cover;
    if (patch.cover === null) {
      db.prepare("UPDATE albums SET cover = '', cover_locked = 1 WHERE id = ?").run(album.id);
    } else {
      const written = await writeCover(`album-${album.id}`, patch.cover || {});
      if (written.error) return { error: written.error };
      db.prepare('UPDATE albums SET cover = ?, cover_locked = 1 WHERE id = ?').run(written.name, album.id);
    }
    await dropCoverFile(previous);
  }

  return { ok: true };
}

// Release date, genres and cover art of a single. An album track takes all
// three from its album, so this is only for the files that belong to none -
// they have nowhere else to carry them. Same deal as an album edit: it lives in
// the database, and the locks keep the next scan from putting the file's version
// back (an emptied date, emptied genres and a removed cover too).
export async function updateSingle(trackId, patch) {
  const track = db.prepare('SELECT id, album_id, cover FROM tracks WHERE id = ?').get(trackId);
  if (!track) return { error: 'not_found' };
  if (track.album_id) return { error: 'not_a_single' };

  if ('date' in patch) {
    const parsed = parseDate(patch.date);
    if (!parsed.ok) return { error: 'invalid_date' };
    db.prepare(
      'UPDATE tracks SET year = ?, release_date = ?, year_locked = 1 WHERE id = ?'
    ).run(parsed.year, parsed.date, track.id);
  }

  if ('genres' in patch) {
    setGenres([track.id], parseGenres(patch.genres));
  }

  if ('cover' in patch) {
    const previous = track.cover;
    if (patch.cover === null) {
      db.prepare("UPDATE tracks SET cover = '', cover_locked = 1 WHERE id = ?").run(track.id);
    } else {
      const written = await writeCover(`track-${track.id}`, patch.cover || {});
      if (written.error) return { error: written.error };
      db.prepare('UPDATE tracks SET cover = ?, cover_locked = 1 WHERE id = ?').run(written.name, track.id);
    }
    await dropCoverFile(previous);
  }

  return { ok: true };
}

// The profile picture of an artist. Nothing else about an artist can be edited:
// the name is the folder name, and the next scan would read it again anyway.
// No lock needed - the scanner never writes this column.
export async function updateArtistCover(artistId, cover) {
  const artist = db.prepare('SELECT id, cover FROM artists WHERE id = ?').get(artistId);
  if (!artist) return { error: 'not_found' };

  const previous = artist.cover;
  if (cover === null) {
    db.prepare("UPDATE artists SET cover = '' WHERE id = ?").run(artist.id);
  } else {
    const written = await writeCover(`artist-${artist.id}`, cover || {});
    if (written.error) return { error: written.error };
    db.prepare('UPDATE artists SET cover = ? WHERE id = ?').run(written.name, artist.id);
  }
  await dropCoverFile(previous);
  return { ok: true };
}
