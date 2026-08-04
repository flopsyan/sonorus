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
    UNIQUE (title, artist_id)
  );

  CREATE TABLE IF NOT EXISTS genres (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

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
// The full release date next to the year. Filled by the next scan, which
// re-reads every file after the scanner version bump.
addColumn('albums', 'release_date', "TEXT NOT NULL DEFAULT ''");
addColumn('tracks', 'release_date', "TEXT NOT NULL DEFAULT ''");

// Where a playlist sits in the sidebar: pinned to the top, and the order the
// user dragged it into.
addColumn('playlists', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('playlists', 'position', 'INTEGER NOT NULL DEFAULT 0');

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

export { dbPath, dataDir, coversDir, musicDir };
export default db;
