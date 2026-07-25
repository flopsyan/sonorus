// Read access to the shared library (artists, albums, genres, tracks).
//
// Every track projection carries the star rating of the account that asked for
// it, so a track list can render its stars without a second round trip. The
// library rows themselves are shared by all accounts.

import db from '../db.js';
import { normalize, loosen, primaryArtist } from '../lib/normalize.js';

// One shared projection so every endpoint returns tracks in the same shape.
// The genre subquery uses the (track_id, genre_id) primary key, the rating
// subquery the (user_id, track_id) one. Exported because playlists.js selects
// the same columns plus its own playlist_items.id.
export const TRACK_FIELDS = `
  t.id, t.title, t.track_no AS trackNo, t.disc_no AS discNo, t.year,
  t.duration, t.bitrate, t.codec, t.lossless, t.added_at AS addedAt,
  t.artist_id AS artistId, ar.name AS artist,
  t.album_id AS albumId, al.title AS album,
  COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
  (SELECT group_concat(g.name, ', ')
     FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
    WHERE tg.track_id = t.id) AS genres,
  (SELECT r.stars FROM ratings r WHERE r.track_id = t.id AND r.user_id = @userId) AS stars
`;

export const TRACK_FROM = `
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums  al ON al.id = t.album_id
`;

// Turns a raw row into the shape the client expects: a cover URL instead of a
// file name, genres as an array, numbers as numbers.
export function shapeTrack(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist || 'Unbekannter Interpret',
    artistId: row.artistId,
    album: row.album || '',
    albumId: row.albumId,
    cover: row.cover ? `/covers/${row.cover}` : null,
    trackNo: row.trackNo,
    discNo: row.discNo,
    year: row.year,
    duration: row.duration || 0,
    bitrate: row.bitrate,
    codec: row.codec || '',
    lossless: !!row.lossless,
    genres: row.genres ? row.genres.split(', ') : [],
    stars: row.stars || 0,
    addedAt: row.addedAt,
  };
}

// Sort keys the "Alle Songs" table offers. Whitelisted, because the value ends
// up in the SQL text.
const SORTS = {
  title: 't.title COLLATE NOCASE',
  artist: 'ar.name COLLATE NOCASE',
  album: 'al.title COLLATE NOCASE',
  duration: 't.duration',
  year: 't.year',
  added: 't.added_at',
  stars: 'stars',
  genre: 'genres',
};

export function listTracks({ userId, q = '', sort = 'title', dir = 'asc', limit = 0, offset = 0 } = {}) {
  const order = SORTS[sort] || SORTS.title;
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const search = String(q || '').trim();

  const where = search
    ? `WHERE t.title LIKE @like OR ar.name LIKE @like OR al.title LIKE @like`
    : '';
  const page = limit ? `LIMIT @limit OFFSET @offset` : '';

  // NULLS LAST for every sort, so untagged tracks never head the list.
  const rows = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM} ${where}
        ORDER BY (${order}) IS NULL, ${order} ${direction}, t.title COLLATE NOCASE ASC
        ${page}`
    )
    .all({ userId, like: `%${search}%`, limit, offset });

  return rows.map(shapeTrack);
}

export function countTracks({ q = '' } = {}) {
  const search = String(q || '').trim();
  if (!search) return db.prepare('SELECT COUNT(*) AS c FROM tracks').get().c;
  return db
    .prepare(
      `SELECT COUNT(*) AS c ${TRACK_FROM}
        WHERE t.title LIKE @like OR ar.name LIKE @like OR al.title LIKE @like`
    )
    .get({ like: `%${search}%` }).c;
}

export function getTrack(id, userId) {
  const row = db
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE t.id = @id`)
    .get({ id, userId });
  return shapeTrack(row);
}

// Path on disk, for streaming. Kept separate from the projection so a file
// path is never part of an API response.
export function trackPath(id) {
  const row = db.prepare('SELECT path FROM tracks WHERE id = ?').get(id);
  return row ? row.path : null;
}

// Tracks for a list of ids, returned in the order the ids were given. Used to
// restore the playback queue after a reload.
export function tracksByIds(ids, userId) {
  const wanted = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!wanted.length) return [];
  // The ids are verified integers above, so inlining them keeps the statement
  // to a single named parameter instead of mixing binding styles.
  const rows = db
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE t.id IN (${wanted.join(',')})`)
    .all({ userId });
  const byId = new Map(rows.map((r) => [r.id, shapeTrack(r)]));
  return wanted.map((id) => byId.get(id)).filter(Boolean);
}

// --- Artists ----------------------------------------------------------------

export function listArtists({ q = '' } = {}) {
  const search = String(q || '').trim();
  return db
    .prepare(
      `SELECT ar.id, ar.name,
              COUNT(DISTINCT t.id)       AS trackCount,
              COUNT(DISTINCT t.album_id) AS albumCount,
              COALESCE(
                (SELECT al.cover FROM albums al
                  WHERE al.artist_id = ar.id AND al.cover <> ''
                  ORDER BY al.year DESC LIMIT 1),
                (SELECT t2.cover FROM tracks t2
                  WHERE t2.artist_id = ar.id AND t2.cover <> '' LIMIT 1)
              ) AS cover
         FROM artists ar
         LEFT JOIN tracks t ON t.artist_id = ar.id
        ${search ? 'WHERE ar.name LIKE @like' : ''}
        GROUP BY ar.id
       HAVING trackCount > 0
        ORDER BY ar.name COLLATE NOCASE ASC`
    )
    .all({ like: `%${search}%` })
    .map((a) => ({ ...a, cover: a.cover ? `/covers/${a.cover}` : null }));
}

export function getArtist(id, userId) {
  const artist = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id);
  if (!artist) return null;

  const albums = db
    .prepare(
      `SELECT al.id, al.title, al.year, al.cover,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
         FROM albums al
         LEFT JOIN tracks t ON t.album_id = al.id
        WHERE al.artist_id = @id
        GROUP BY al.id
        ORDER BY (al.year IS NULL), al.year DESC, al.title COLLATE NOCASE ASC`
    )
    .all({ id })
    .map(shapeAlbum);

  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE t.artist_id = @id
        ORDER BY (al.year IS NULL), al.year DESC, al.title COLLATE NOCASE,
                 t.disc_no, t.track_no, t.title COLLATE NOCASE`
    )
    .all({ id, userId })
    .map(shapeTrack);

  // Files lying directly in the artist folder belong to no album. They get
  // their own section instead of being counted as one.
  const singles = tracks.filter((t) => !t.albumId);

  return { ...artist, albums, tracks, singles };
}

// --- Albums -----------------------------------------------------------------

function shapeAlbum(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist || 'Unbekannter Interpret',
    artistId: row.artistId,
    year: row.year,
    cover: row.cover ? `/covers/${row.cover}` : null,
    trackCount: row.trackCount || 0,
    duration: row.duration || 0,
  };
}

const ALBUM_SORTS = {
  title: 'al.title COLLATE NOCASE',
  artist: 'ar.name COLLATE NOCASE',
  year: 'al.year',
  tracks: 'trackCount',
};

export function listAlbums({ q = '', sort = 'title', dir = 'asc' } = {}) {
  const order = ALBUM_SORTS[sort] || ALBUM_SORTS.title;
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const search = String(q || '').trim();

  return db
    .prepare(
      `SELECT al.id, al.title, al.year, al.cover,
              al.artist_id AS artistId, ar.name AS artist,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
         FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
         LEFT JOIN tracks  t  ON t.album_id = al.id
        ${search ? 'WHERE al.title LIKE @like OR ar.name LIKE @like' : ''}
        GROUP BY al.id
        ORDER BY (${order}) IS NULL, ${order} ${direction}, al.title COLLATE NOCASE ASC`
    )
    .all({ like: `%${search}%` })
    .map(shapeAlbum);
}

export function getAlbum(id, userId) {
  const album = db
    .prepare(
      `SELECT al.id, al.title, al.year, al.cover,
              al.artist_id AS artistId, ar.name AS artist,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
         FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
         LEFT JOIN tracks  t  ON t.album_id = al.id
        WHERE al.id = @id
        GROUP BY al.id`
    )
    .get({ id });
  if (!album || !album.id) return null;

  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE t.album_id = @id
        ORDER BY t.disc_no, t.track_no, t.title COLLATE NOCASE`
    )
    .all({ id, userId })
    .map(shapeTrack);

  return { ...shapeAlbum(album), tracks };
}

// --- Genres -----------------------------------------------------------------

export function listGenres() {
  return db
    .prepare(
      `SELECT g.id, g.name, COUNT(tg.track_id) AS trackCount,
              (SELECT al.cover FROM track_genres t2
                 JOIN tracks tr ON tr.id = t2.track_id
                 JOIN albums al ON al.id = tr.album_id
                WHERE t2.genre_id = g.id AND al.cover <> '' LIMIT 1) AS cover
         FROM genres g
         LEFT JOIN track_genres tg ON tg.genre_id = g.id
        GROUP BY g.id
       HAVING trackCount > 0
        ORDER BY g.name COLLATE NOCASE ASC`
    )
    .all()
    .map((g) => ({ ...g, cover: g.cover ? `/covers/${g.cover}` : null }));
}

export function getGenre(id, userId) {
  const genre = db.prepare('SELECT id, name FROM genres WHERE id = ?').get(id);
  if (!genre) return null;
  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
         JOIN track_genres tg ON tg.track_id = t.id
        WHERE tg.genre_id = @id
        ORDER BY ar.name COLLATE NOCASE, al.title COLLATE NOCASE, t.disc_no, t.track_no`
    )
    .all({ id, userId })
    .map(shapeTrack);
  return { ...genre, tracks };
}

// --- Star playlists ---------------------------------------------------------

// The automatic playlist behind a star rating: always the current contents of
// the ratings table, never a stored list.
export function tracksByStars(stars, userId) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
         JOIN ratings r ON r.track_id = t.id AND r.user_id = @userId
        WHERE r.stars = @stars
        ORDER BY r.updated_at DESC`
    )
    .all({ stars, userId })
    .map(shapeTrack);
}

export function starCounts(userId) {
  const rows = db
    .prepare('SELECT stars, COUNT(*) AS c FROM ratings WHERE user_id = ? GROUP BY stars')
    .all(userId);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) counts[r.stars] = r.c;
  return counts;
}

// --- Home page lists --------------------------------------------------------

export function recentlyAdded(userId, limit = 18) {
  return db
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} ORDER BY t.added_at DESC, t.id DESC LIMIT @limit`)
    .all({ userId, limit })
    .map(shapeTrack);
}

export function recentlyPlayed(userId, limit = 18) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, MAX(p.played_at) AS lastPlayed ${TRACK_FROM}
         JOIN plays p ON p.track_id = t.id AND p.user_id = @userId
        GROUP BY t.id
        ORDER BY lastPlayed DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map(shapeTrack);
}

export function mostPlayed(userId, limit = 18) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, COUNT(p.id) AS playCount ${TRACK_FROM}
         JOIN plays p ON p.track_id = t.id AND p.user_id = @userId
        GROUP BY t.id
        ORDER BY playCount DESC, MAX(p.played_at) DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map((r) => ({ ...shapeTrack(r), playCount: r.playCount }));
}

export function newestAlbums(limit = 12) {
  return db
    .prepare(
      `SELECT al.id, al.title, al.year, al.cover,
              al.artist_id AS artistId, ar.name AS artist,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration,
              MAX(t.added_at) AS addedAt
         FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
         LEFT JOIN tracks  t  ON t.album_id = al.id
        GROUP BY al.id
       HAVING trackCount > 0
        ORDER BY addedAt DESC
        LIMIT @limit`
    )
    .all({ limit })
    .map(shapeAlbum);
}

// A handful of random tracks, so "Zufallsmix" on the home page always has
// something to play even on a fresh library with no history.
export function randomTracks(userId, limit = 50) {
  return db
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} ORDER BY RANDOM() LIMIT @limit`)
    .all({ userId, limit })
    .map(shapeTrack);
}

export function libraryStats() {
  const one = (sql) => db.prepare(sql).get().c;
  const duration = db.prepare('SELECT COALESCE(SUM(duration), 0) AS d FROM tracks').get().d;
  return {
    tracks: one('SELECT COUNT(*) AS c FROM tracks'),
    artists: one('SELECT COUNT(*) AS c FROM artists'),
    albums: one('SELECT COUNT(*) AS c FROM albums'),
    singles: one('SELECT COUNT(*) AS c FROM tracks WHERE album_id IS NULL'),
    genres: one('SELECT COUNT(*) AS c FROM genres'),
    duration,
    size: db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM tracks').get().s,
  };
}

// --- Matching an imported row against the library ---------------------------

// Finds the track a CSV row refers to, from strict to forgiving:
//   1. exact title + artist
//   2. loose title (version suffixes dropped) + artist
//   3. loose title + album
//   4. loose title alone, but only when it is unique in the library
// Returns the track id, or null when nothing matches well enough.
export function findTrackForImport({ title, artists, album }) {
  const exact = normalize(title);
  const loose = loosen(title);
  const artist = primaryArtist(artists);
  const albumName = normalize(album);
  if (!loose) return null;

  if (artist) {
    const byExact = db
      .prepare('SELECT id FROM tracks WHERE norm_title = ? AND norm_artist = ? LIMIT 1')
      .get(exact, artist);
    if (byExact) return byExact.id;

    const byLoose = db
      .prepare('SELECT id FROM tracks WHERE loose_title = ? AND norm_artist = ? LIMIT 1')
      .get(loose, artist);
    if (byLoose) return byLoose.id;
  }

  if (albumName) {
    const byAlbum = db
      .prepare(
        `SELECT t.id FROM tracks t
           JOIN albums al ON al.id = t.album_id
          WHERE t.loose_title = ? AND al.title = ? COLLATE NOCASE
          LIMIT 1`
      )
      .get(loose, album);
    if (byAlbum) return byAlbum.id;
  }

  const candidates = db.prepare('SELECT id FROM tracks WHERE loose_title = ? LIMIT 2').all(loose);
  return candidates.length === 1 ? candidates[0].id : null;
}
