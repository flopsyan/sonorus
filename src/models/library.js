// Read access to the shared library (artists, albums, genres, tracks). Every track projection
// carries the asking account's rating, so a list renders its stars without a second round trip.

import db from '../db.js';
import { PLAY_COUNTED } from './stats.js';
import { normalize, loosen, primaryArtist, isVarious } from '../lib/normalize.js';
// Out of `public/` on purpose: the browser player deals the same way and can
// only import what is served, so this is the one module both sides run.
import { spreadByArtist } from '../../public/js/shuffle.js';

// A compilation track ("Various") names its own artist in track_artist; it is empty everywhere
// else, so the artist folder answers for an ordinary library.
export const TRACK_ARTIST = "COALESCE(NULLIF(t.track_artist, ''), ar.name, pc.name, au.name)";

// The same question without the podcast fallback, for the one query that brings
// its own FROM and never joins the podcasts table. It selects music only, so
// pc.name could not answer anything there anyway.
const MUSIC_ARTIST = "COALESCE(NULLIF(t.track_artist, ''), ar.name)";

// One projection so every endpoint returns the same track shape; the genre and rating subqueries
// hit their tables' primary keys. Exported because playlists.js adds its own playlist_items.id.
export const TRACK_FIELDS = `
  t.id, t.title, t.track_no AS trackNo, t.disc_no AS discNo, t.year,
  t.release_date AS releaseDate,
  t.duration, t.bitrate, t.codec, t.lossless, t.added_at AS addedAt,
  t.artist_id AS artistId, ${TRACK_ARTIST} AS artist, t.track_artist AS trackArtist,
  t.album_id AS albumId, al.title AS album,
  t.podcast_id AS podcastId, pc.name AS podcast, t.episode_no AS episodeNo,
  t.audiobook_id AS audiobookId, ab.title AS book, ab.kind AS bookKind,
  au.id AS authorId, au.name AS author,
  t.part_no AS partNo,
  -- An episode has no cover of its own: the show carries one and every episode
  -- of it shows that, see storePodcastCover in the scanner.
  COALESCE(NULLIF(al.cover, ''), NULLIF(t.cover, ''), pc.cover, ab.cover) AS cover,
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
  LEFT JOIN podcasts pc ON pc.id = t.podcast_id
  LEFT JOIN audiobooks ab ON ab.id = t.audiobook_id
  LEFT JOIN authors   au ON au.id = ab.author_id
`;

// Tracks whose file is gone are kept for their ratings and playlists, but they
// have no business in the browse views. Everything that lists the library adds
// this; the star playlists and playlists deliberately do not.
export const PRESENT = "t.missing_at = ''";

// Episodes and book parts share the tracks table but must never show up in the music
// library. Every music query carries this; only lookups by id (streaming, queue restore) do not.
export const MUSIC = 't.podcast_id IS NULL AND t.audiobook_id IS NULL';
// The other halves of the same rule, for the two spoken-word models.
export const EPISODE = 't.podcast_id IS NOT NULL';
export const BOOK_PART = 't.audiobook_id IS NOT NULL';
export const PRESENT_MUSIC = `${PRESENT} AND ${MUSIC}`;

// 'YYYY', 'YYYY-MM' and 'YYYY-MM-DD' sort as text the way they run in time, so same-year records
// keep their order. The year stands in for unscanned rows; NULL only when neither is known,
// which the NULLS LAST ordering below relies on.
const ALBUM_DATE = "COALESCE(NULLIF(al.release_date, ''), CAST(al.year AS TEXT))";
const TRACK_DATE = "COALESCE(NULLIF(t.release_date, ''), CAST(t.year AS TEXT))";

// Time listened, not times started - what "am meisten gehört" ranks by, as in stats.js. Plays
// from before the player reported seconds carry 0; the track length stands in for them.
const LISTENED = 'CASE WHEN p.seconds > 0 THEN p.seconds ELSE COALESCE(t.duration, 0) END';

// The same, per track of the account asking - as a correlated subquery, so it
// can order a list that does not join `plays` at all.
const TRACK_LISTENED = `(SELECT COALESCE(SUM(${LISTENED}), 0)
    FROM plays p WHERE p.track_id = t.id AND p.user_id = @userId)`;

// The file path never leaves the server - except for a track whose file is gone, where it is
// the only useful thing left to show.
export function shapeTrack(row) {
  if (!row) return null;
  const missing = !!row.missingAt;
  return {
    missing,
    ...(missing ? { path: row.path, missingAt: row.missingAt } : {}),
    id: row.id,
    title: row.title,
    artist: row.artist || 'Unbekannter Interpret',
    // A compilation song's artist has no page of its own (the folder is "Various"), so no link.
    artistId: row.trackArtist ? null : row.artistId,
    album: row.album || '',
    albumId: row.albumId,
    // Set only on a podcast episode. The client reads it as "this is spoken
    // word": no stars, no playlists, and a resume position instead.
    podcastId: row.podcastId || null,
    podcast: row.podcast || '',
    episodeNo: row.episodeNo ?? null,
    // A book part. The file name is never shown: `title` above is overridden
    // with the book below, because to the listener the book is the one thing
    // there is - the parts only decide the order it plays in.
    audiobookId: row.audiobookId || null,
    book: row.book || '',
    // 'book' or 'drama'. The client builds /audiobooks/... or /audiodramas/...
    // from it: two libraries to the listener, one table underneath.
    bookKind: row.bookKind || '',
    author: row.author || '',
    bookAuthorId: row.authorId || null,
    partNo: row.partNo ?? null,
    ...(row.audiobookId ? { title: row.book || row.title } : {}),
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

// --- Searching --------------------------------------------------------------
//
// Every word of a query has to match some field, not the same one, so "Fame Bowie Americans"
// can name one song by title, artist and album together.

// A query longer than this is a mistake, and every word costs one LIKE per row.
const MAX_WORDS = 8;

export function searchWords(q) {
  return String(q || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

// "every word is found in one of these fields", as a WHERE fragment and the
// parameters it binds. Null for an empty query, so a caller can tell "no filter"
// from "a filter that matches nothing".
export function allWordsIn(fields, list) {
  if (!list.length) return null;
  const params = {};
  const where = list
    .map((word, i) => {
      params[`w${i}`] = `%${word}%`;
      return `(${fields.map((f) => `${f} LIKE @w${i}`).join(' OR ')})`;
    })
    .join(' AND ');
  return { where, params };
}

// Puts songs called "Fame" above those on "The Fame Monster": the whole query in the main field
// beats its words there, which beat the same words elsewhere. `others` is a list of
// [fields, weight] - several fields because a song's artist lives in two columns.
export function scoreOf(main, others, list) {
  const parts = [
    `CASE WHEN ${main} LIKE @qExact THEN 1000
          WHEN ${main} LIKE @qStart THEN 400
          WHEN ${main} LIKE @qLike  THEN 200 ELSE 0 END`,
  ];
  list.forEach((_, i) => {
    parts.push(`CASE WHEN ${main} LIKE @w${i} THEN 40 ELSE 0 END`);
    for (const [fields, weight] of others) {
      parts.push(
        `CASE WHEN ${fields.map((f) => `${f} LIKE @w${i}`).join(' OR ')} THEN ${weight} ELSE 0 END`
      );
    }
  });
  return parts.map((p) => `(${p})`).join(' + ');
}

// The three forms of the whole query the score compares against.
export function queryParams(q) {
  const whole = String(q || '').trim();
  return { qExact: whole, qStart: `${whole}%`, qLike: `%${whole}%` };
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

// The fields a song is looked for in. Both artist columns are there: "Various"
// finds the whole compilation, the name of one of its interpreten finds their
// songs on it.
const TRACK_SEARCH_FIELDS = ['t.title', 'ar.name', 't.track_artist', 'al.title'];

// NULLS LAST for every sort, so untagged tracks never head the list.
export function trackOrder(sort, dir) {
  const order = SORTS[sort] || SORTS.title;
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `(${order}) IS NULL, ${order} ${direction}, t.title COLLATE NOCASE ASC`;
}

export function listTracks({ userId, q = '', sort = 'title', dir = 'asc', limit = 0, offset = 0 } = {}) {
  const search = allWordsIn(TRACK_SEARCH_FIELDS, searchWords(q));

  const where = search ? `WHERE ${PRESENT_MUSIC} AND ${search.where}` : `WHERE ${PRESENT_MUSIC}`;
  const page = limit ? `LIMIT @limit OFFSET @offset` : '';

  const rows = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM} ${where}
        ORDER BY ${trackOrder(sort, dir)}
        ${page}`
    )
    .all({ userId, ...(search ? search.params : {}), limit, offset });

  return rows.map(shapeTrack);
}

export function countTracks({ q = '' } = {}) {
  const search = allWordsIn(TRACK_SEARCH_FIELDS, searchWords(q));
  if (!search) return db.prepare(`SELECT COUNT(*) AS c FROM tracks t WHERE ${PRESENT_MUSIC}`).get().c;
  return db
    .prepare(`SELECT COUNT(*) AS c ${TRACK_FROM} WHERE ${PRESENT_MUSIC} AND ${search.where}`)
    .get(search.params).c;
}

export function getTrack(id, userId) {
  const row = db
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE t.id = @id`)
    .get({ id, userId });
  return shapeTrack(row);
}

// How far the text may be pushed either way. Five seconds is far more than any
// mis-stamped file needs and still small enough that the slider keeps a usable
// resolution at a tenth of a second per step.
export const LYRICS_OFFSET_MAX = 5;

// The words of one song, and when each line is sung if the file said so.
// Returns null for a track that does not exist; a track without lyrics answers
// with empty ones, which is a different thing and the client draws it as such.
export function getLyrics(id) {
  const row = db.prepare('SELECT lyrics, lyrics_sync, lyrics_offset FROM tracks WHERE id = ?').get(id);
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
  return {
    text: row.lyrics || '',
    lines,
    synced: lines.length > 0,
    offset: row.lyrics_offset || 0,
  };
}

// Seconds, positive for later. Clamped rather than rejected, since the slider cannot go further;
// rounded to its tenth step so 0.30000000000000004 does not sit between two notches.
export function setLyricsOffset(id, seconds) {
  const row = db.prepare('SELECT id FROM tracks WHERE id = ?').get(id);
  if (!row) return null;
  const value = Number(seconds);
  const offset = Number.isFinite(value)
    ? Math.round(Math.max(-LYRICS_OFFSET_MAX, Math.min(LYRICS_OFFSET_MAX, value)) * 10) / 10
    : 0;
  db.prepare('UPDATE tracks SET lyrics_offset = ? WHERE id = ?').run(offset, id);
  return offset;
}

// Path on disk, for streaming. API responses carry a path only for a missing track (shapeTrack).
export function trackPath(id) {
  const row = db.prepare('SELECT path FROM tracks WHERE id = ?').get(id);
  return row ? row.path : null;
}

// What the transcode cache needs, and nothing a response may carry: size and mtime invalidate an
// entry, lossless alone decides the re-encode (willTranscode in lib/transcode.js).
const STREAM_FIELDS = 'id, path, size, mtime, lossless';

export function streamTrack(id) {
  return db.prepare(`SELECT ${STREAM_FIELDS} FROM tracks WHERE id = ?`).get(id) || null;
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

// The picture the user picked wins; without one the artist borrows the artwork
// of their newest album, and failing that of one of their singles.
const ARTIST_COVER = `COALESCE(
    NULLIF(ar.cover, ''),
    (SELECT al.cover FROM albums al
      WHERE al.artist_id = ar.id AND al.cover <> ''
      ORDER BY al.year DESC LIMIT 1),
    (SELECT t2.cover FROM tracks t2
      WHERE t2.artist_id = ar.id AND t2.cover <> '' LIMIT 1)
  )`;

const ARTIST_ROW = `
  ar.id, ar.name,
  COUNT(DISTINCT t.id)       AS trackCount,
  COUNT(DISTINCT t.album_id) AS albumCount,
  ${ARTIST_COVER} AS cover,
  -- Only to decide whether a mosaic is drawn; dropped again by shapeArtistRow.
  ar.cover AS ownCover
`;

const ARTIST_FROM = `
  FROM artists ar
  LEFT JOIN tracks t ON t.artist_id = ar.id AND ${PRESENT_MUSIC}
`;

const shapeArtistRow = ({ ownCover, ...a }) => ({
  ...a,
  cover: a.cover ? `/covers/${a.cover}` : null,
});

// Only "Various" gets a mosaic: its newest compilation's cover says nothing about the rest, while
// any other artist's newest record stands for them fine. Same order as the artist page;
// `COALESCE(t.album_id, -t.id)` buckets by record, as in GENRE_COVERS.
const VARIOUS_COVERS = `
  SELECT COALESCE(NULLIF(al.cover, ''), t.cover) AS cover
    FROM tracks t
    LEFT JOIN albums al ON al.id = t.album_id
   WHERE t.artist_id = @id AND ${PRESENT_MUSIC}
     AND COALESCE(NULLIF(al.cover, ''), t.cover) <> ''
   GROUP BY COALESCE(t.album_id, -t.id)
   ORDER BY (${ALBUM_DATE}) IS NULL, ${ALBUM_DATE} DESC, al.title COLLATE NOCASE
   LIMIT 4
`;

// Empty also with a hand-picked picture or fewer than four covers: the clients then fall back to
// the single cover, and half-filled tiles would look broken.
function mosaicCovers({ id, name, ownCover }) {
  if (!isVarious(name) || ownCover) return [];
  const covers = db.prepare(VARIOUS_COVERS).all({ id });
  return covers.length === 4 ? covers.map((c) => `/covers/${c.cover}`) : [];
}

export function listArtists({ q = '' } = {}) {
  const search = allWordsIn(['ar.name'], searchWords(q));
  return db
    .prepare(
      `SELECT ${ARTIST_ROW} ${ARTIST_FROM}
        ${search ? `WHERE ${search.where}` : ''}
        GROUP BY ar.id
       HAVING trackCount > 0
        ORDER BY ar.name COLLATE NOCASE ASC`
    )
    .all(search ? search.params : {})
    .map((a) => ({ ...shapeArtistRow(a), covers: mosaicCovers(a) }));
}

export function getArtist(id, userId) {
  const artist = db.prepare('SELECT id, name, cover FROM artists WHERE id = ?').get(id);
  if (!artist) return null;

  const albums = db
    .prepare(
      `SELECT al.id, al.title, al.year, al.release_date AS releaseDate, al.cover,
              COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
         FROM albums al
         LEFT JOIN tracks t ON t.album_id = al.id AND ${PRESENT_MUSIC}
        WHERE al.artist_id = @id
        GROUP BY al.id
       HAVING trackCount > 0
        ORDER BY (${ALBUM_DATE}) IS NULL, ${ALBUM_DATE} DESC, al.title COLLATE NOCASE ASC`
    )
    .all({ id })
    .map(shapeAlbum);

  // Most listened first: opening an artist asks what you actually play by them. Unplayed songs
  // keep the discography order, so the tail still reads like one.
  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS}, ${TRACK_LISTENED} AS listened ${TRACK_FROM}
        WHERE t.artist_id = @id AND ${PRESENT_MUSIC}
        ORDER BY listened DESC,
                 (${ALBUM_DATE}) IS NULL, ${ALBUM_DATE} DESC, al.title COLLATE NOCASE,
                 t.disc_no, t.track_no, t.title COLLATE NOCASE`
    )
    .all({ id, userId })
    .map(shapeTrack);

  // Files directly in the artist folder get their own section, by title: a single has no album
  // date, disc or track number to sort by.
  const singles = tracks
    .filter((t) => !t.albumId)
    .sort((a, b) => a.title.localeCompare(b.title, 'de', { sensitivity: 'base' }));

  // The picture the user picked wins; without one the artist borrows the
  // artwork of an album, and failing that of one of the singles.
  const cover = artist.cover
    ? `/covers/${artist.cover}`
    : (albums.find((a) => a.cover) || singles.find((t) => t.cover) || {}).cover || null;

  return {
    ...artist,
    cover,
    covers: mosaicCovers({ ...artist, ownCover: artist.cover }),
    hasOwnCover: !!artist.cover,
    albums,
    tracks,
    singles,
  };
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

const ALBUM_ROW = `
  al.id, al.title, al.year, al.release_date AS releaseDate, al.cover,
  al.artist_id AS artistId, ar.name AS artist,
  COUNT(t.id) AS trackCount, SUM(t.duration) AS duration
`;

const ALBUM_FROM = `
  FROM albums al
  LEFT JOIN artists ar ON ar.id = al.artist_id
  LEFT JOIN tracks  t  ON t.album_id = al.id AND ${PRESENT_MUSIC}
`;

// An album is looked for under its own title and under its artist's name, so
// "Bowie Young Americans" is one query and not two.
const ALBUM_SEARCH_FIELDS = ['al.title', 'ar.name'];

export function listAlbums({ userId, q = '', sort = 'title', dir = 'asc' } = {}) {
  const order = ALBUM_SORTS[sort] || ALBUM_SORTS.title;
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const search = allWordsIn(ALBUM_SEARCH_FIELDS, searchWords(q));

  return db
    .prepare(
      `SELECT ${ALBUM_ROW} ${ALBUM_FROM}
        ${search ? `WHERE ${search.where}` : ''}
        GROUP BY al.id
       HAVING trackCount > 0
        ORDER BY (${order}) IS NULL, ${order} ${direction}, al.title COLLATE NOCASE ASC`
    )
    .all({ userId, ...(search ? search.params : {}) })
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
         LEFT JOIN tracks  t  ON t.album_id = al.id AND ${PRESENT_MUSIC}
        WHERE al.id = @id
        GROUP BY al.id`
    )
    .get({ id, userId });
  if (!album || !album.id) return null;

  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE t.album_id = @id AND ${PRESENT_MUSIC}
        ORDER BY t.disc_no, t.track_no, t.title COLLATE NOCASE`
    )
    .all({ id, userId })
    .map(shapeTrack);

  // The album's own genre list once it has one, empty included. Before that the union of the
  // files' genres, so opening the edit dialog and saving does not wipe them.
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

// Up to four covers per genre, singles included, in the order of the genre's track list. One per
// record, so one album cannot fill all four tiles: ids are positive on both tables, so the
// negated track id in `COALESCE(t.album_id, -t.id)` never collides with an album.
const GENRE_COVERS = `
  WITH per_record AS (
    SELECT tg.genre_id AS genreId,
           COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
           ${MUSIC_ARTIST} AS artist, al.title AS album,
           ROW_NUMBER() OVER (PARTITION BY tg.genre_id, COALESCE(t.album_id, -t.id)
                              ORDER BY t.disc_no, t.track_no, t.id) AS inRecord
      FROM track_genres tg
      JOIN tracks t ON t.id = tg.track_id AND ${PRESENT_MUSIC}
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
         LEFT JOIN tracks t ON t.id = tg.track_id AND ${PRESENT_MUSIC}
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

// A set of track ids rather than a join, so a track in two of the genres appears once. Null for
// any unknown id, so a made-up address stays a 404 instead of a shorter selection.
export function getGenres(ids, userId) {
  // Validated integers, so they are safe to inline into the IN lists.
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
          AND ${PRESENT_MUSIC}
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
const UNRATED = `${PRESENT_MUSIC} AND NOT EXISTS
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
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE ${PRESENT_MUSIC}
        ORDER BY t.added_at DESC, t.id DESC LIMIT @limit`
    )
    .all({ userId, limit })
    .map(shapeTrack);
}

export function recentlyPlayed(userId, limit = 18) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, MAX(p.played_at) AS lastPlayed ${TRACK_FROM}
         JOIN plays p ON p.track_id = t.id AND p.user_id = @userId AND ${PLAY_COUNTED}
        WHERE ${PRESENT_MUSIC}
        GROUP BY t.id
        ORDER BY lastPlayed DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map(shapeTrack);
}

// Ranked by time listened, like the statistics; the play count comes along but does not decide.
export function mostPlayed(userId, limit = 18) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, COUNT(CASE WHEN ${PLAY_COUNTED} THEN p.id END) AS playCount,
              ROUND(SUM(${LISTENED})) AS listened ${TRACK_FROM}
         JOIN plays p ON p.track_id = t.id AND p.user_id = @userId
        WHERE ${PRESENT_MUSIC}
        GROUP BY t.id
        ORDER BY listened DESC, playCount DESC, MAX(p.played_at) DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map((r) => ({ ...shapeTrack(r), playCount: r.playCount, listened: r.listened }));
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
         LEFT JOIN tracks  t  ON t.album_id = al.id AND ${PRESENT_MUSIC}
        GROUP BY al.id
       HAVING trackCount > 0
        ORDER BY addedAt DESC
        LIMIT @limit`
    )
    .all({ limit })
    .map(shapeAlbum);
}

// `unrated` narrows the draw to songs without a star, for rating by ear. Every song is equally
// likely, but the order is spread by artist (public/js/shuffle.js): a uniform permutation puts
// the same artist side by side more often than feels random.
export function randomTracks(userId, limit = 50, { unrated = false } = {}) {
  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS} ${TRACK_FROM}
        WHERE ${unrated ? UNRATED : PRESENT_MUSIC}
        ORDER BY RANDOM() LIMIT @limit`
    )
    .all({ userId, limit })
    .map(shapeTrack);
  return spreadByArtist(tracks, (t) => t.artist);
}

// --- The search page --------------------------------------------------------

// A song may be named by title, artist and album together, an album by title and artist, an
// artist only by name - so "Fame Bowie Americans" finds just the song, "Bowie" all three.
export function searchLibrary({ userId, q = '', limit = 100 } = {}) {
  const list = searchWords(q);
  if (!list.length) return { tracks: [], artists: [], albums: [] };
  const whole = queryParams(q);

  const trackWhere = allWordsIn(TRACK_SEARCH_FIELDS, list);
  const trackScore = scoreOf(
    't.title',
    [
      [['ar.name', 't.track_artist'], 15],
      [['al.title'], 8],
    ],
    list
  );
  const tracks = db
    .prepare(
      `SELECT ${TRACK_FIELDS}, ${trackScore} AS score ${TRACK_FROM}
        WHERE ${PRESENT_MUSIC} AND ${trackWhere.where}
        ORDER BY score DESC, t.title COLLATE NOCASE ASC
        LIMIT @limit`
    )
    .all({ userId, ...trackWhere.params, ...whole, limit })
    .map(shapeTrack);

  const artistWhere = allWordsIn(['ar.name'], list);
  const artists = db
    .prepare(
      `SELECT ${ARTIST_ROW}, ${scoreOf('ar.name', [], list)} AS score ${ARTIST_FROM}
        WHERE ${artistWhere.where}
        GROUP BY ar.id
       HAVING trackCount > 0
        ORDER BY score DESC, ar.name COLLATE NOCASE ASC`
    )
    .all({ ...artistWhere.params, ...whole })
    .map((a) => ({ ...shapeArtistRow(a), covers: mosaicCovers(a) }));

  const albumWhere = allWordsIn(ALBUM_SEARCH_FIELDS, list);
  const albums = db
    .prepare(
      `SELECT ${ALBUM_ROW}, ${scoreOf('al.title', [[['ar.name'], 15]], list)} AS score ${ALBUM_FROM}
        WHERE ${albumWhere.where}
        GROUP BY al.id
       HAVING trackCount > 0
        ORDER BY score DESC, al.title COLLATE NOCASE ASC`
    )
    .all({ userId, ...albumWhere.params, ...whole })
    .map(shapeAlbum);

  return { tracks, artists, albums };
}

// Counts what is actually there: a track whose file is gone still has a row for
// its rating, but it is not part of the library any more.
export function libraryStats() {
  const one = (sql) => db.prepare(sql).get().c;
  return {
    tracks: one(`SELECT COUNT(*) AS c FROM tracks t WHERE ${PRESENT_MUSIC}`),
    artists: one(
      `SELECT COUNT(*) AS c FROM artists ar
        WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = ar.id AND ${PRESENT_MUSIC})`
    ),
    albums: one(
      `SELECT COUNT(*) AS c FROM albums al
        WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${PRESENT_MUSIC})`
    ),
    singles: one(`SELECT COUNT(*) AS c FROM tracks t WHERE t.album_id IS NULL AND ${PRESENT_MUSIC}`),
    genres: one(
      `SELECT COUNT(DISTINCT tg.genre_id) AS c FROM track_genres tg
         JOIN tracks t ON t.id = tg.track_id AND ${PRESENT_MUSIC}`
    ),
    missing: one(`SELECT COUNT(*) AS c FROM tracks t WHERE t.missing_at <> ''`),
    duration: db.prepare(`SELECT COALESCE(SUM(t.duration), 0) AS d FROM tracks t WHERE ${PRESENT_MUSIC}`).get().d,
    size: db.prepare(`SELECT COALESCE(SUM(t.size), 0) AS s FROM tracks t WHERE ${PRESENT_MUSIC}`).get().s,
  };
}

// --- Matching an imported row against the library ---------------------------

// The track a CSV row refers to, from strict to forgiving (loose = version suffixes dropped).
// A loose title alone only counts when it is unique in the library.
export function findTrackForImport({ title, artists, album }) {
  const exact = normalize(title);
  const loose = loosen(title);
  const artist = primaryArtist(artists);
  const albumName = normalize(album);
  if (!loose) return null;

  if (artist) {
    const byExact = db
      .prepare(`SELECT id FROM tracks t WHERE norm_title = ? AND norm_artist = ? AND ${PRESENT_MUSIC} LIMIT 1`)
      .get(exact, artist);
    if (byExact) return byExact.id;

    const byLoose = db
      .prepare(`SELECT id FROM tracks t WHERE loose_title = ? AND norm_artist = ? AND ${PRESENT_MUSIC} LIMIT 1`)
      .get(loose, artist);
    if (byLoose) return byLoose.id;
  }

  if (albumName) {
    const byAlbum = db
      .prepare(
        `SELECT t.id FROM tracks t
           JOIN albums al ON al.id = t.album_id
          WHERE t.loose_title = ? AND al.title = ? COLLATE NOCASE AND ${PRESENT_MUSIC}
          LIMIT 1`
      )
      .get(loose, album);
    if (byAlbum) return byAlbum.id;
  }

  const candidates = db
    .prepare(`SELECT id FROM tracks t WHERE loose_title = ? AND ${PRESENT_MUSIC} LIMIT 2`)
    .all(loose);
  return candidates.length === 1 ? candidates[0].id : null;
}
