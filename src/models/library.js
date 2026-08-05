// Read access to the shared library (artists, albums, genres, tracks).
//
// Every track projection carries the star rating of the account that asked for
// it, so a track list can render its stars without a second round trip. The
// library rows themselves are shared by all accounts.

import db from '../db.js';
import { normalize, loosen, primaryArtist } from '../lib/normalize.js';

// Who made this one song. Normally the artist folder it lies in - but a track
// on a compilation ("Various") carries its own interpret, read off the file
// name by the scanner, and then that one is the answer. Empty everywhere else,
// so the expression costs nothing for an ordinary library.
const TRACK_ARTIST = "COALESCE(NULLIF(t.track_artist, ''), ar.name)";

// One shared projection so every endpoint returns tracks in the same shape.
// The genre subquery uses the (track_id, genre_id) primary key, the rating
// subquery the (user_id, track_id) one. Exported because playlists.js selects
// the same columns plus its own playlist_items.id.
export const TRACK_FIELDS = `
  t.id, t.title, t.track_no AS trackNo, t.disc_no AS discNo, t.year,
  t.release_date AS releaseDate,
  t.duration, t.bitrate, t.codec, t.lossless, t.added_at AS addedAt,
  t.artist_id AS artistId, ${TRACK_ARTIST} AS artist, t.track_artist AS trackArtist,
  t.album_id AS albumId, al.title AS album,
  COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
  (SELECT group_concat(g.name, ', ')
     FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
    WHERE tg.track_id = t.id) AS genres,
  (SELECT r.stars FROM ratings r WHERE r.track_id = t.id AND r.user_id = @userId) AS stars,
  -- Whether there are lyrics at all, never the lyrics themselves: a projection
  -- every list in the app selects has no business carrying a text block per
  -- row. The words come from GET /api/tracks/:id/lyrics, one song at a time.
  (t.lyrics <> '') AS hasLyrics,
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

// What "sort by year" actually sorts by: the release date, as exactly as it is
// known. The year column alone puts two records of the same year in an
// arbitrary order; the date string does not, because 'YYYY', 'YYYY-MM' and
// 'YYYY-MM-DD' compare as text exactly the way they run in time - a bare year
// first, then the dated releases of that year in order.
//
// A row from a library that has not been rescanned since the column was added
// has no date, so the year stands in for it. NULL only when neither is known,
// which keeps the NULLS LAST trick of the queries below working.
const ALBUM_DATE = "COALESCE(NULLIF(al.release_date, ''), CAST(al.year AS TEXT))";
const TRACK_DATE = "COALESCE(NULLIF(t.release_date, ''), CAST(t.year AS TEXT))";

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
    // A song on a compilation names an interpret that has no page of its own:
    // the folder it lies in is "Various", and a link under the name would lead
    // there rather than to the interpret it reads as. So it stays plain text,
    // and the album is the way back to where the song belongs.
    artistId: row.trackArtist ? null : row.artistId,
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
    // Enough to decide whether the lyrics button is worth showing, without
    // putting a text block into every row of every list.
    hasLyrics: !!row.hasLyrics,
    addedAt: row.addedAt,
  };
}

// Sort keys the "Alle Songs" table offers. Whitelisted, because the value ends
// up in the SQL text.
const SORTS = {
  title: 't.title COLLATE NOCASE',
  // The interpret the row prints, so a compilation sorts by its songs' artists
  // and not by "Various" six hundred times.
  artist: `${TRACK_ARTIST} COLLATE NOCASE`,
  album: 'al.title COLLATE NOCASE',
  duration: 't.duration',
  year: TRACK_DATE,
  added: 't.added_at',
  stars: 'stars',
  genre: 'genres',
};

export function listTracks({ userId, q = '', sort = 'title', dir = 'asc', limit = 0, offset = 0 } = {}) {
  const order = SORTS[sort] || SORTS.title;
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const search = String(q || '').trim();

  // Both artist columns are searched: "Various" finds the whole compilation,
  // the name of one of its interpreten finds their songs on it.
  const where = search
    ? `WHERE ${PRESENT} AND (t.title LIKE @like OR ar.name LIKE @like
         OR t.track_artist LIKE @like OR al.title LIKE @like)`
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
        WHERE ${PRESENT} AND (t.title LIKE @like OR ar.name LIKE @like
          OR t.track_artist LIKE @like OR al.title LIKE @like)`
    )
    .get({ like: `%${search}%` }).c;
}

export function getTrack(id, userId) {
  const row = db
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE t.id = @id`)
    .get({ id, userId });
  return shapeTrack(row);
}

// The words of one song, and when each line is sung if the file said so.
// Returns null for a track that does not exist; a track without lyrics answers
// with empty ones, which is a different thing and the client draws it as such.
export function getLyrics(id) {
  const row = db.prepare('SELECT lyrics, lyrics_sync FROM tracks WHERE id = ?').get(id);
  if (!row) return null;
  // A line list that cannot be read back is treated as "not timed" rather than
  // as an error - the plain text below it is still worth showing.
  let lines = [];
  if (row.lyrics_sync) {
    try {
      const parsed = JSON.parse(row.lyrics_sync);
      if (Array.isArray(parsed)) lines = parsed;
    } catch {
      lines = [];
    }
  }
  return { text: row.lyrics || '', lines, synced: lines.length > 0 };
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
        ORDER BY (${ALBUM_DATE}) IS NULL, ${ALBUM_DATE} DESC, al.title COLLATE NOCASE ASC`
    )
    .all({ id })
    .map(shapeAlbum);

  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE t.artist_id = @id AND ${PRESENT}
        ORDER BY (${ALBUM_DATE}) IS NULL, ${ALBUM_DATE} DESC, al.title COLLATE NOCASE,
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
  year: ALBUM_DATE,
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
              al.artist_id AS artistId, ar.name AS artist, al.genres_locked AS genresLocked,
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

  // What the edit dialog has to show. Once the album carries a genre list of its
  // own that list is the answer, empty included - the user emptied it. Before
  // that there is nothing to show but what the files say, and offering the union
  // of them is what keeps opening the dialog and saving from wiping them.
  const genres = album.genresLocked
    ? db
        .prepare(
          `SELECT g.name FROM album_genres ag JOIN genres g ON g.id = ag.genre_id
            WHERE ag.album_id = @id ORDER BY g.name COLLATE NOCASE`
        )
        .all({ id })
        .map((row) => row.name)
    : [...new Set(tracks.flatMap((t) => t.genres))];

  return { ...shapeAlbum(album), genres, tracks };
}

// --- Genres -----------------------------------------------------------------

// The artwork of every genre: up to four covers, in the order the genre's own
// track list has them, so a card in the grid and the head of the page it leads
// to show the same picture.
//
// Two things it does that the single-cover subquery before it did not, and both
// are the reason a genre could come up blank:
//   - it takes the cover of a **single** too (`t.cover`), not only an album's.
//     A genre made of loose files had no album to ask, so it had nothing.
//   - it counts *records*, not songs: four tracks off one album would fill all
//     four tiles with the same picture. `COALESCE(t.album_id, -t.id)` is that
//     bucket - ids are positive on both tables, so the negated track id can
//     never collide with an album - and a single stands for itself.
const GENRE_COVERS = `
  WITH per_record AS (
    SELECT tg.genre_id AS genreId,
           COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
           ${TRACK_ARTIST} AS artist, al.title AS album,
           ROW_NUMBER() OVER (PARTITION BY tg.genre_id, COALESCE(t.album_id, -t.id)
                              ORDER BY t.disc_no, t.track_no, t.id) AS inRecord
      FROM track_genres tg
      JOIN tracks t ON t.id = tg.track_id AND ${PRESENT}
      LEFT JOIN artists ar ON ar.id = t.artist_id
      LEFT JOIN albums al ON al.id = t.album_id
     WHERE COALESCE(NULLIF(al.cover, ''), t.cover) <> ''
  )
  SELECT genreId, cover FROM (
    SELECT genreId, cover,
           ROW_NUMBER() OVER (PARTITION BY genreId
                              ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE) AS pos
      FROM per_record WHERE inRecord = 1
  ) WHERE pos <= 4
   ORDER BY genreId, pos
`;

export function listGenres() {
  const covers = new Map();
  for (const row of db.prepare(GENRE_COVERS).all()) {
    if (!covers.has(row.genreId)) covers.set(row.genreId, []);
    covers.get(row.genreId).push(`/covers/${row.cover}`);
  }

  return db
    .prepare(
      `SELECT g.id, g.name, COUNT(t.id) AS trackCount
         FROM genres g
         LEFT JOIN track_genres tg ON tg.genre_id = g.id
         LEFT JOIN tracks t ON t.id = tg.track_id AND ${PRESENT}
        GROUP BY g.id
       HAVING trackCount > 0
        ORDER BY g.name COLLATE NOCASE ASC`
    )
    .all()
    .map((g) => {
      const list = covers.get(g.id) || [];
      // `cover` is the first of them, kept because the server and the phone app
      // are deployed apart: an APK that has not been rebuilt yet still reads it.
      return { ...g, covers: list, cover: list[0] || null };
    });
}

// One list for a selection of genres, the same idea as the star playlists:
// "Rock und Jazz" is one list, not two. A track that carries both is in it once
// - which is why the genres are asked for as a set of track ids instead of
// joined onto the track, where every extra genre would repeat the row.
//
// Returns null when any of the ids is unknown, so a made-up address stays a 404
// instead of quietly showing a shorter selection.
export function getGenres(ids, userId) {
  // Validated integers, so inlining them keeps the statement to named
  // parameters only - better-sqlite3 refuses the two styles mixed.
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))].filter(
    (n) => Number.isInteger(n) && n > 0
  );
  if (!wanted.length) return null;

  const genres = db
    .prepare(`SELECT id, name FROM genres WHERE id IN (${wanted.join(',')}) ORDER BY name COLLATE NOCASE`)
    .all();
  if (genres.length !== wanted.length) return null;

  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE t.id IN (SELECT tg.track_id FROM track_genres tg
                        WHERE tg.genre_id IN (${wanted.join(',')}))
          AND ${PRESENT}
        ORDER BY ${TRACK_ARTIST} COLLATE NOCASE, al.title COLLATE NOCASE, t.disc_no, t.track_no`
    )
    .all({ userId })
    .map(shapeTrack);

  return {
    ids: genres.map((g) => g.id),
    // The single-genre case keeps the shape it always had, so everything that
    // only wants a heading can go on reading `name`.
    id: genres[0].id,
    name: genres.map((g) => g.name).join(', '),
    names: genres.map((g) => g.name),
    tracks,
  };
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
        ORDER BY ${TRACK_ARTIST} COLLATE NOCASE, al.title COLLATE NOCASE,
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
