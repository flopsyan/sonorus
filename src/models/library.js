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
  t.release_date AS releaseDate,
  t.duration, t.bitrate, t.codec, t.lossless, t.added_at AS addedAt,
  t.artist_id AS artistId, ar.name AS artist,
  t.album_id AS albumId, al.title AS album,
  COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
  (SELECT group_concat(g.name, ', ')
     FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
    WHERE tg.track_id = t.id) AS genres,
  (SELECT r.stars FROM ratings r WHERE r.track_id = t.id AND r.user_id = @userId) AS stars,
  t.missing_at AS missingAt, t.path AS path
`;

export const TRACK_FROM = `
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums  al ON al.id = t.album_id
`;

// Tracks whose file is gone are kept for their ratings and playlists, but they
// have no business in the browse views. Everything that lists the library adds
// this; the star playlists and playlists deliberately do not.
export const PRESENT = "t.missing_at = ''";

// Turns a raw row into the shape the client expects: a cover URL instead of a
// file name, genres as an array, numbers as numbers.
//
// The file path is the one thing that never leaves the server - except for a
// track whose file is gone, where it is the only useful thing left to show.
export function shapeTrack(row) {
  if (!row) return null;
  const missing = !!row.missingAt;
  return {
    missing,
    ...(missing ? { path: row.path, missingAt: row.missingAt } : {}),
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
    // Falls back to the year, so a library that has not been rescanned since
    // the column was added still says what it knows.
    releaseDate: row.releaseDate || (row.year ? String(row.year) : ''),
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
    ? `WHERE ${PRESENT} AND (t.title LIKE @like OR ar.name LIKE @like OR al.title LIKE @like)`
    : `WHERE ${PRESENT}`;
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
  if (!search) return db.prepare(`SELECT COUNT(*) AS c FROM tracks t WHERE ${PRESENT}`).get().c;
  return db
    .prepare(
      `SELECT COUNT(*) AS c ${TRACK_FROM}
        WHERE ${PRESENT} AND (t.title LIKE @like OR ar.name LIKE @like OR al.title LIKE @like)`
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
                NULLIF(ar.cover, ''),
                (SELECT al.cover FROM albums al
                  WHERE al.artist_id = ar.id AND al.cover <> ''
                  ORDER BY al.year DESC LIMIT 1),
                (SELECT t2.cover FROM tracks t2
                  WHERE t2.artist_id = ar.id AND t2.cover <> '' LIMIT 1)
              ) AS cover
         FROM artists ar
         LEFT JOIN tracks t ON t.artist_id = ar.id AND ${PRESENT}
        ${search ? 'WHERE ar.name LIKE @like' : ''}
        GROUP BY ar.id
       HAVING trackCount > 0
        ORDER BY ar.name COLLATE NOCASE ASC`
    )
    .all({ like: `%${search}%` })
    .map((a) => ({ ...a, cover: a.cover ? `/covers/${a.cover}` : null }));
}

export function getArtist(id, userId) {
  const artist = db.prepare('SELECT id, name, cover FROM artists WHERE id = ?').get(id);
  if (!artist) return null;

  const albums = db
    .prepare(
      `SELECT al.id, al.title, al.year, al.release_date AS releaseDate, al.cover,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
         FROM albums al
         LEFT JOIN tracks t ON t.album_id = al.id AND ${PRESENT}
        WHERE al.artist_id = @id
        GROUP BY al.id
       HAVING trackCount > 0
        ORDER BY (al.year IS NULL), al.year DESC, al.title COLLATE NOCASE ASC`
    )
    .all({ id })
    .map(shapeAlbum);

  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE t.artist_id = @id AND ${PRESENT}
        ORDER BY (al.year IS NULL), al.year DESC, al.title COLLATE NOCASE,
                 t.disc_no, t.track_no, t.title COLLATE NOCASE`
    )
    .all({ id, userId })
    .map(shapeTrack);

  // Files lying directly in the artist folder belong to no album. They get
  // their own section instead of being counted as one.
  const singles = tracks.filter((t) => !t.albumId);

  // The picture the user picked wins; without one the artist borrows the
  // artwork of an album, and failing that of one of the singles.
  const cover = artist.cover
    ? `/covers/${artist.cover}`
    : (albums.find((a) => a.cover) || singles.find((t) => t.cover) || {}).cover || null;

  return { ...artist, cover, hasOwnCover: !!artist.cover, albums, tracks, singles };
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
    // Falls back to the year, so a library that has not been rescanned since
    // the column was added still says what it knows.
    releaseDate: row.releaseDate || (row.year ? String(row.year) : ''),
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
      `SELECT al.id, al.title, al.year, al.release_date AS releaseDate, al.cover,
              al.artist_id AS artistId, ar.name AS artist,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
         FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
         LEFT JOIN tracks  t  ON t.album_id = al.id AND ${PRESENT}
        ${search ? 'WHERE al.title LIKE @like OR ar.name LIKE @like' : ''}
        GROUP BY al.id
       HAVING trackCount > 0
        ORDER BY (${order}) IS NULL, ${order} ${direction}, al.title COLLATE NOCASE ASC`
    )
    .all({ like: `%${search}%` })
    .map(shapeAlbum);
}

export function getAlbum(id, userId) {
  const album = db
    .prepare(
      `SELECT al.id, al.title, al.year, al.release_date AS releaseDate, al.cover,
              al.artist_id AS artistId, ar.name AS artist,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
         FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
         LEFT JOIN tracks  t  ON t.album_id = al.id AND ${PRESENT}
        WHERE al.id = @id
        GROUP BY al.id`
    )
    .get({ id });
  if (!album || !album.id) return null;

  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE t.album_id = @id AND ${PRESENT}
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
      `SELECT g.id, g.name, COUNT(t.id) AS trackCount,
              (SELECT al.cover FROM track_genres t2
                 JOIN tracks tr ON tr.id = t2.track_id
                 JOIN albums al ON al.id = tr.album_id
                WHERE t2.genre_id = g.id AND al.cover <> '' LIMIT 1) AS cover
         FROM genres g
         LEFT JOIN track_genres tg ON tg.genre_id = g.id
         LEFT JOIN tracks t ON t.id = tg.track_id AND ${PRESENT}
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
        WHERE tg.genre_id = @id AND ${PRESENT}
        ORDER BY ar.name COLLATE NOCASE, al.title COLLATE NOCASE, t.disc_no, t.track_no`
    )
    .all({ id, userId })
    .map(shapeTrack);
  return { ...genre, tracks };
}

// --- Star playlists ---------------------------------------------------------

// The automatic playlist behind a star rating: always the current contents of
// the ratings table, never a stored list. Several ratings can be asked for at
// once ("4 und 5 Sterne"), which is one list, not two - the best rated first.
export function tracksByStars(stars, userId) {
  // Validated integers, so inlining them keeps the statement to a single named
  // parameter instead of mixing binding styles.
  const wanted = [...new Set((Array.isArray(stars) ? stars : [stars]).map(Number))].filter(
    (n) => Number.isInteger(n) && n >= 1 && n <= 5
  );
  if (!wanted.length) return [];

  return db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
         JOIN ratings r ON r.track_id = t.id AND r.user_id = @userId
        WHERE r.stars IN (${wanted.join(',')})
        ORDER BY t.missing_at <> '', r.stars DESC, r.updated_at DESC`
    )
    .all({ userId })
    .map(shapeTrack);
}

// One list for a selection of ratings, 0 being "Nicht bewertet". Kept here so
// the route stays a lookup: the rated ones come first, the unrated tail after.
export function tracksByStarSelection(values, userId) {
  const list = tracksByStars(values, userId);
  return values.includes(0) ? list.concat(unratedTracks(userId)) : list;
}

// The counterpart to the star playlists: everything still waiting for a
// rating. Only playable tracks - a file that is gone cannot be rated by ear.
const UNRATED = `${PRESENT} AND NOT EXISTS
  (SELECT 1 FROM ratings r WHERE r.track_id = t.id AND r.user_id = @userId)`;

export function unratedTracks(userId) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE ${UNRATED}
        ORDER BY ar.name COLLATE NOCASE, al.title COLLATE NOCASE,
                 t.disc_no, t.track_no, t.title COLLATE NOCASE`
    )
    .all({ userId })
    .map(shapeTrack);
}

// Key 0 is the "Nicht bewertet" list, 1 to 5 are the star playlists.
export function starCounts(userId) {
  const rows = db
    .prepare('SELECT stars, COUNT(*) AS c FROM ratings WHERE user_id = ? GROUP BY stars')
    .all(userId);
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) counts[r.stars] = r.c;
  counts[0] = db
    .prepare(`SELECT COUNT(*) AS c FROM tracks t WHERE ${UNRATED}`)
    .get({ userId }).c;
  return counts;
}

// --- Home page lists --------------------------------------------------------

export function recentlyAdded(userId, limit = 18) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE ${PRESENT}
        ORDER BY t.added_at DESC, t.id DESC LIMIT @limit`
    )
    .all({ userId, limit })
    .map(shapeTrack);
}

export function recentlyPlayed(userId, limit = 18) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, MAX(p.played_at) AS lastPlayed ${TRACK_FROM}
         JOIN plays p ON p.track_id = t.id AND p.user_id = @userId
        WHERE ${PRESENT}
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
        WHERE ${PRESENT}
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
      `SELECT al.id, al.title, al.year, al.release_date AS releaseDate, al.cover,
              al.artist_id AS artistId, ar.name AS artist,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration,
              MAX(t.added_at) AS addedAt
         FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
         LEFT JOIN tracks  t  ON t.album_id = al.id AND ${PRESENT}
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
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE ${PRESENT} ORDER BY RANDOM() LIMIT @limit`)
    .all({ userId, limit })
    .map(shapeTrack);
}

// Counts what is actually there: a track whose file is gone still has a row for
// its rating, but it is not part of the library any more.
export function libraryStats() {
  const one = (sql) => db.prepare(sql).get().c;
  return {
    tracks: one(`SELECT COUNT(*) AS c FROM tracks t WHERE ${PRESENT}`),
    artists: one(
      `SELECT COUNT(*) AS c FROM artists ar
        WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = ar.id AND ${PRESENT})`
    ),
    albums: one(
      `SELECT COUNT(*) AS c FROM albums al
        WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${PRESENT})`
    ),
    singles: one(`SELECT COUNT(*) AS c FROM tracks t WHERE t.album_id IS NULL AND ${PRESENT}`),
    genres: one(
      `SELECT COUNT(DISTINCT tg.genre_id) AS c FROM track_genres tg
         JOIN tracks t ON t.id = tg.track_id AND ${PRESENT}`
    ),
    missing: one(`SELECT COUNT(*) AS c FROM tracks t WHERE t.missing_at <> ''`),
    duration: db.prepare(`SELECT COALESCE(SUM(t.duration), 0) AS d FROM tracks t WHERE ${PRESENT}`).get().d,
    size: db.prepare(`SELECT COALESCE(SUM(t.size), 0) AS s FROM tracks t WHERE ${PRESENT}`).get().s,
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
      .prepare(`SELECT id FROM tracks t WHERE norm_title = ? AND norm_artist = ? AND ${PRESENT} LIMIT 1`)
      .get(exact, artist);
    if (byExact) return byExact.id;

    const byLoose = db
      .prepare(`SELECT id FROM tracks t WHERE loose_title = ? AND norm_artist = ? AND ${PRESENT} LIMIT 1`)
      .get(loose, artist);
    if (byLoose) return byLoose.id;
  }

  if (albumName) {
    const byAlbum = db
      .prepare(
        `SELECT t.id FROM tracks t
           JOIN albums al ON al.id = t.album_id
          WHERE t.loose_title = ? AND al.title = ? COLLATE NOCASE AND ${PRESENT}
          LIMIT 1`
      )
      .get(loose, album);
    if (byAlbum) return byAlbum.id;
  }

  const candidates = db
    .prepare(`SELECT id FROM tracks t WHERE loose_title = ? AND ${PRESENT} LIMIT 2`)
    .all(loose);
  return candidates.length === 1 ? candidates[0].id : null;
}
