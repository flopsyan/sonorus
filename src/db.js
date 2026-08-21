import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Storage location of the database and the cover art extracted from the audio
// files. Configurable via DATA_DIR (the Docker volume).
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, 'data');
const coversDir = path.join(dataDir, 'covers');

// The music library itself. Mounted read-only; Sonorus only ever reads from it.
const musicDir = path.resolve(process.env.MUSIC_DIR || path.join(projectRoot, 'music'));

// Spoken word, in a root of its own. It is deliberately not a folder inside the
// music library: since 2026-07-25 the folder structure *is* the library
// (artist / album / track), and a podcast read through that rule would turn
// every show into an interpret and every episode into a single. A second root
// keeps the two apart without a rule that has to guess which is which. Missing
// is fine - an instance without podcasts simply has nothing to scan there.
const podcastDir = path.resolve(process.env.PODCAST_DIR || path.join(projectRoot, 'podcasts'));

// Audiobooks, a third root. Deeper than the podcasts by one level, because a
// book has an author and a show does not: audiobooks/<Author>/<Book>/*.mp3.
// The files inside a book folder are its parts and are never shown - a book is
// one thing to the listener, and the parts only decide the order it plays in.
const audiobookDir = path.resolve(process.env.AUDIOBOOK_DIR || path.join(projectRoot, 'audiobooks'));

fs.mkdirSync(coversDir, { recursive: true });

const dbPath = path.join(dataDir, 'sonorus.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Accounts and key/value meta --------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL DEFAULT '',
    pass_hash     TEXT NOT NULL,
    pass_salt     TEXT NOT NULL,
    avatar        TEXT NOT NULL DEFAULT '',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    prefs         TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- Library ----------------------------------------------------------------
// Rebuilt from the files on every scan, so it is safe to throw away. Artists
// and albums are their own rows so the browse tabs are plain indexed lookups.
// Albums are keyed by (title, album artist): two different artists can each
// have a "Greatest Hits" without colliding.
db.exec(`
  CREATE TABLE IF NOT EXISTS artists (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    -- A profile picture the user picked. Empty means "show the artwork of one
    -- of the albums"; the scanner never writes this column.
    cover TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS albums (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    year      INTEGER,
    -- The release date as exactly as the file knows it: 'YYYY-MM-DD', 'YYYY-MM'
    -- or just 'YYYY'. Only the album page shows it in full; everywhere else the
    -- year above is what is printed - but sorting by year goes by this column,
    -- so two records of the same year keep their real order.
    release_date TEXT NOT NULL DEFAULT '',
    cover     TEXT NOT NULL DEFAULT '',
    -- Set once the user has edited the field by hand, so the scanner leaves it
    -- alone from then on. Year and release date are one field to the user, so
    -- year_locked covers both.
    year_locked  INTEGER NOT NULL DEFAULT 0,
    cover_locked INTEGER NOT NULL DEFAULT 0,
    -- The genres of this album were set by hand. What they are is in
    -- album_genres; this says the album decides them and not the files.
    genres_locked INTEGER NOT NULL DEFAULT 0,
    UNIQUE (title, artist_id)
  );

  CREATE TABLE IF NOT EXISTS genres (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  -- A podcast show: one folder under PODCAST_DIR, one row. The counterpart to
  -- artists for spoken word, and separate from it on purpose - a show is not
  -- an interpret and must not turn up in the music library.
  CREATE TABLE IF NOT EXISTS podcasts (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
    -- What the episodes say about the show. Every episode of a show repeats the
    -- same text in its description tag, so it is stored once, here.
    description TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    -- The release date of the episode cover was taken from. A show rebrands,
    -- and 361 episodes carry 37 different pictures - so the newest one wins,
    -- and this is what lets the scanner tell newer from older without reading
    -- every file again.
    cover_date TEXT NOT NULL DEFAULT ''
  );

  -- Who wrote the book. Deliberately not the artists table: an author is not an
  -- interpret and has no business in the music library's Interpreten list.
  CREATE TABLE IF NOT EXISTS authors (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
    cover TEXT NOT NULL DEFAULT ''
  );

  -- One book: one folder under an author. Its files are parts, never shown.
  CREATE TABLE IF NOT EXISTS audiobooks (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER REFERENCES authors(id) ON DELETE SET NULL,
    title     TEXT NOT NULL,
    cover     TEXT NOT NULL DEFAULT '',
    UNIQUE (title, author_id)
  );
  CREATE INDEX IF NOT EXISTS idx_audiobooks_author ON audiobooks(author_id);

  CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    artist_id   INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    -- The interpret of this one song, when it is not the artist folder it lies
    -- in. Only ever filled under "Various", where every track of an album has
    -- an interpret of its own and the file name carries it. Empty everywhere
    -- else, which is what makes artist_id the answer for the whole library.
    track_artist TEXT NOT NULL DEFAULT '',
    album_id    INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    track_no    INTEGER,
    disc_no     INTEGER,
    year        INTEGER,
    -- The exact release date behind that year, see albums.release_date.
    release_date TEXT NOT NULL DEFAULT '',
    duration    REAL NOT NULL DEFAULT 0,
    bitrate     INTEGER,
    codec       TEXT NOT NULL DEFAULT '',
    lossless    INTEGER NOT NULL DEFAULT 0,
    cover       TEXT NOT NULL DEFAULT '',
    -- The lyrics embedded in the file, as plain text. Empty when it carries
    -- none; Sonorus never looks them up anywhere else.
    lyrics      TEXT NOT NULL DEFAULT '',
    -- The same lyrics with a timestamp per line, as JSON, when the file says
    -- when each one is sung. Empty means "there, but not timed".
    lyrics_sync TEXT NOT NULL DEFAULT '',
    -- Set when the file is gone but the row has to stay: a rating, a playlist
    -- entry or a play refers to it. Empty means the file is there.
    missing_at  TEXT NOT NULL DEFAULT '',
    -- The genres were set by hand, so the scanner keeps the file's out.
    genres_locked INTEGER NOT NULL DEFAULT 0,
    -- Same for the year of a single, which has no album to carry it.
    year_locked   INTEGER NOT NULL DEFAULT 0,
    -- And for its artwork, which an album track takes from its album.
    cover_locked  INTEGER NOT NULL DEFAULT 0,
    size        INTEGER NOT NULL DEFAULT 0,
    mtime       INTEGER NOT NULL DEFAULT 0,
    norm_title  TEXT NOT NULL DEFAULT '',
    loose_title TEXT NOT NULL DEFAULT '',
    norm_artist TEXT NOT NULL DEFAULT '',
    -- The show this row is an episode of. NULL for everything in the music
    -- library, which is what tells the two apart in every query.
    podcast_id  INTEGER REFERENCES podcasts(id) ON DELETE SET NULL,
    -- The number in front of the file name ("#100 ..."). NULL for a show that
    -- does not number its episodes, which is what the date is for.
    episode_no  INTEGER,
    -- The book this row is a part of, and where the part sits in it. Both NULL
    -- for everything that is not an audiobook.
    audiobook_id INTEGER REFERENCES audiobooks(id) ON DELETE SET NULL,
    part_no     INTEGER,
    added_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_title  ON tracks(title COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_tracks_loose  ON tracks(loose_title);
  CREATE INDEX IF NOT EXISTS idx_tracks_added  ON tracks(added_at DESC);

  CREATE TABLE IF NOT EXISTS track_genres (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (track_id, genre_id)
  );
  CREATE INDEX IF NOT EXISTS idx_track_genres_genre ON track_genres(genre_id);

  -- The genre list a user set on an album. track_genres stays the single source
  -- for the Genres view - this is where the *decision* lives, so a song that is
  -- renamed, retagged or newly added takes the album's list instead of falling
  -- back to whatever its own file happens to say.
  CREATE TABLE IF NOT EXISTS album_genres (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (album_id, genre_id)
  );
  CREATE INDEX IF NOT EXISTS idx_album_genres_genre ON album_genres(genre_id);
`);

// --- Per-account data -------------------------------------------------------
// The library is shared, everything below belongs to one account: playlists
// (optionally grouped in folders), star ratings and the listening history.
db.exec(`
  CREATE TABLE IF NOT EXISTS playlist_folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_folders_user ON playlist_folders(user_id);

  CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id  INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    -- Where the list sits in the sidebar. Pinned lists come first, then the
    -- order the user dragged them into; equal positions fall back to the name.
    pinned     INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);

  CREATE TABLE IF NOT EXISTS playlist_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_items_playlist ON playlist_items(playlist_id, position);

  CREATE TABLE IF NOT EXISTS ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    stars      INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, track_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ratings_stars ON ratings(user_id, stars);

  -- The stars on a whole record, and deliberately a table of its own rather
  -- than a column next to the track ratings: an album is rated as an album and
  -- knows nothing about how its songs were rated. A 5-star record may hold a
  -- song nobody ever gave a star, and both statements stay true side by side.
  --
  -- Unlike the track ratings this feeds no playlist. There is no star playlist
  -- for records, on purpose - the rating is there to sort the Alben tab by, and
  -- that is all it is for.
  CREATE TABLE IF NOT EXISTS album_ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    stars      INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, album_id)
  );
  CREATE INDEX IF NOT EXISTS idx_album_ratings_stars ON album_ratings(user_id, stars);

  CREATE TABLE IF NOT EXISTS plays (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    -- Seconds actually listened, reported by the player while it plays. Not
    -- the track length: skipping away after a minute is a minute.
    seconds   INTEGER NOT NULL DEFAULT 0,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_plays_user ON plays(user_id, played_at DESC);

  -- Where listening to an episode stopped, and whether it was finished. This is
  -- the one thing a podcast needs that a song does not: plays records that a
  -- track was played, never where you left off, and a 70-minute episode that
  -- starts from the beginning every time is unusable.
  CREATE TABLE IF NOT EXISTS episode_progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    -- Seconds into the episode. Reset to 0 once it is finished, so "Weiterhören"
    -- never offers an episode that has nothing left to hear.
    position   REAL NOT NULL DEFAULT 0,
    completed  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, track_id)
  );
  CREATE INDEX IF NOT EXISTS idx_progress_user ON episode_progress(user_id, updated_at DESC);

  -- Rows from a CSV import that no file in the library matches. Kept until the
  -- user dismisses them, or until a later scan turns up a matching file.
  CREATE TABLE IF NOT EXISTS import_issues (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    playlist_id   INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    playlist_name TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL DEFAULT '',
    artists       TEXT NOT NULL DEFAULT '',
    album         TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_issues_user ON import_issues(user_id, created_at DESC);
`);

// --- Columns added after the first release ----------------------------------
// CREATE TABLE only runs on a fresh database, so an existing one gets them here.
function addColumn(table, name, definition) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

// A single has no album, so it carries its own artwork.
addColumn('tracks', 'cover', "TEXT NOT NULL DEFAULT ''");
// A rated track survives its file: the row stays and is marked instead.
addColumn('tracks', 'missing_at', "TEXT NOT NULL DEFAULT ''");
// Listening time per play, for the statistics.
addColumn('plays', 'seconds', 'INTEGER NOT NULL DEFAULT 0');

// What the user edited by hand. The music folder is read-only, so an edit is
// stored here instead of in the file - and the scanner has to be told to keep
// its hands off, or the next scan would put the file's version back.
addColumn('albums', 'year_locked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('albums', 'cover_locked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tracks', 'genres_locked', 'INTEGER NOT NULL DEFAULT 0');
// A single carries its own year: no album row is there to hold it.
addColumn('tracks', 'year_locked', 'INTEGER NOT NULL DEFAULT 0');
// Same for its cover art.
addColumn('tracks', 'cover_locked', 'INTEGER NOT NULL DEFAULT 0');
// The profile picture of an artist, which comes from nowhere but a hand edit.
addColumn('artists', 'cover', "TEXT NOT NULL DEFAULT ''");
// The interpret of a single song on a compilation. Filled by the next scan,
// which re-reads every file after the scanner version bump.
addColumn('tracks', 'track_artist', "TEXT NOT NULL DEFAULT ''");
// The lyrics the file carries, plain and timed. Same story: they stay empty
// until a scan runs, because only the file knows them.
addColumn('tracks', 'lyrics', "TEXT NOT NULL DEFAULT ''");
addColumn('tracks', 'lyrics_sync', "TEXT NOT NULL DEFAULT ''");
// How far the timed text has to be pushed against the song, in seconds, because
// the file's own stamps are early or late. A fact about the file rather than
// about a listener, so it sits on the track and not per account - the library is
// shared, and a lyric that runs a second late runs a second late for everybody.
// Positive means the words appear later. No scan writes it, so it needs no lock.
addColumn('tracks', 'lyrics_offset', 'REAL NOT NULL DEFAULT 0');
// The full release date next to the year. Filled by the next scan, which
// re-reads every file after the scanner version bump.
addColumn('albums', 'release_date', "TEXT NOT NULL DEFAULT ''");
addColumn('tracks', 'release_date', "TEXT NOT NULL DEFAULT ''");

// Where a playlist sits in the sidebar: pinned to the top, and the order the
// user dragged it into.
addColumn('playlists', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('playlists', 'position', 'INTEGER NOT NULL DEFAULT 0');

// The album decides the genres of its songs, not the other way round.
addColumn('albums', 'genres_locked', 'INTEGER NOT NULL DEFAULT 0');

// Podcast episodes share the tracks table with the music. NULL is "this is a
// song", which is what every music query filters on - so an existing library
// becomes a library of pure music the moment the column exists, without a
// migration. A foreign key may be added this way because the default is NULL.
addColumn('tracks', 'podcast_id', 'INTEGER REFERENCES podcasts(id) ON DELETE SET NULL');
addColumn('tracks', 'episode_no', 'INTEGER');
// The audiobook side of the same idea, added 2026-08-19.
addColumn('tracks', 'audiobook_id', 'INTEGER REFERENCES audiobooks(id) ON DELETE SET NULL');
addColumn('tracks', 'part_no', 'INTEGER');
// The show a cover was taken from, added after the podcasts table itself.
addColumn('podcasts', 'cover_date', "TEXT NOT NULL DEFAULT ''");

// After the column exists, never before: on an existing database the CREATE
// TABLE block above is a no-op and podcast_id only arrives here.
db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_podcast ON tracks(podcast_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_audiobook ON tracks(audiobook_id)');

// --- One-off data migrations ------------------------------------------------
// Unlike the columns above, these rewrite rows, so they must not run twice. The
// key in `meta` is what makes that so.
function once(key, run) {
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key)) return;
  db.transaction(run)();
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    key,
    new Date().toISOString()
  );
}

// An album edit used to be written into its tracks and nowhere else, so the
// album itself did not know it had been edited: a song that was renamed or
// added afterwards was a fresh row, and a fresh row takes the file's genres and
// the file's date. Both are the album's from now on, so what is already in the
// library is lifted onto the album here and pushed back down over every song of
// it - including the ones that had already fallen back to their file.
once('album_owns_genres_and_date', () => {
  db.exec(`
    -- 1. What the hand-edited tracks carry is what the album was set to.
    INSERT OR IGNORE INTO album_genres (album_id, genre_id)
      SELECT t.album_id, tg.genre_id
        FROM tracks t JOIN track_genres tg ON tg.track_id = t.id
       WHERE t.album_id IS NOT NULL AND t.genres_locked = 1;

    -- 2. An edited song is proof its album was edited - also when the user
    --    emptied the list, which leaves nothing for the step above to find.
    UPDATE albums SET genres_locked = 1
     WHERE id IN (SELECT album_id FROM tracks
                   WHERE album_id IS NOT NULL AND genres_locked = 1);

    -- 3. Every song of such an album takes that list, the ones that had lost it
    --    included. That is the reset itself, undone.
    DELETE FROM track_genres
     WHERE track_id IN (SELECT id FROM tracks
                         WHERE album_id IN (SELECT id FROM albums WHERE genres_locked = 1));
    INSERT OR IGNORE INTO track_genres (track_id, genre_id)
      SELECT t.id, ag.genre_id FROM tracks t JOIN album_genres ag ON ag.album_id = t.album_id;
    UPDATE tracks SET genres_locked = 1
     WHERE album_id IN (SELECT id FROM albums WHERE genres_locked = 1);

    -- 4. The date the same way. It was never written to the songs at all, so
    --    sorting "Alle Songs" by year still went by the file.
    UPDATE tracks
       SET year         = (SELECT al.year         FROM albums al WHERE al.id = tracks.album_id),
           release_date = (SELECT al.release_date FROM albums al WHERE al.id = tracks.album_id)
     WHERE album_id IN (SELECT id FROM albums WHERE year_locked = 1);

    -- 5. A genre the replaced tags were the last to use has no place left.
    DELETE FROM genres
     WHERE id NOT IN (SELECT genre_id FROM track_genres)
       AND id NOT IN (SELECT genre_id FROM album_genres);
  `);
});

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

export { dbPath, dataDir, coversDir, musicDir, podcastDir, audiobookDir };
export default db;
