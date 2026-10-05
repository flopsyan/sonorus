import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { restoreReserved } from './lib/reserved.js';

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

// A root of its own, not a folder in the music library: read as artist / album / track, every
// show would become an artist and every episode a single. May be missing.
const podcastDir = path.resolve(process.env.PODCAST_DIR || path.join(projectRoot, 'podcasts'));

// audiobooks/<Author>/<Book>/*.mp3. The files in a book folder are its parts: never shown,
// they only decide the order the book plays in.
const audiobookDir = path.resolve(process.env.AUDIOBOOK_DIR || path.join(projectRoot, 'audiobooks'));

// audiodramas/<Author>/<Title>/*.m4b, laid out like the audiobooks. Apart on disk, but one
// table (audiobooks.kind) carries both, so no audiobook feature has to be built twice.
const audiodramaDir = path.resolve(process.env.AUDIODRAMA_DIR || path.join(projectRoot, 'audiodramas'));

// ebooks/<Author>/<Title>/*.epub. Shares the authors table with the audiobooks, so an author
// both heard and read is one author.
const ebookDir = path.resolve(process.env.EBOOK_DIR || path.join(projectRoot, 'ebooks'));

// Films and series share one root with a folder for each, laid out the way
// Jellyfin and Kodi lay them out so an existing library can be copied over as it
// is. Jellyfin's own folder names (Movies, Shows) are found as well.
const videoDir = path.resolve(process.env.VIDEO_DIR || path.join(projectRoot, 'videos'));

// Looked up on every call, so a folder created after the start is found by the
// next scan without a restart.
function videoRoot(names) {
  for (const name of names) {
    const candidate = path.join(videoDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(videoDir, names[0]);
}
export const movieRoot = () => videoRoot(['movies', 'Movies']);
export const showRoot = () => videoRoot(['shows', 'Shows']);

// Posters, backdrops, stills and portraits, resized once. Apart from the music
// covers because a rescan of the video side rewrites it independently.
const videoArtDir = path.join(dataDir, 'video-art');
// Embedded subtitles, extracted on first use: that means reading the whole file.
const subtitleDir = path.join(dataDir, 'subtitles');

// A root of its own, not inside dataDir: the re-encoded library runs to tens of gigabytes and
// does not belong in the volume a backup wants.
const transcodeDir = path.resolve(process.env.TRANSCODE_DIR || path.join(dataDir, 'transcodes'));

fs.mkdirSync(coversDir, { recursive: true });
fs.mkdirSync(transcodeDir, { recursive: true });
fs.mkdirSync(videoArtDir, { recursive: true });
fs.mkdirSync(subtitleDir, { recursive: true });

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
// Not disposable: locks, album_genres, artist covers, lyrics_offset and kept missing rows live
// only here. Albums are keyed by (title, album artist), so two artists can each have a
// "Greatest Hits".
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
    -- 'book' or 'drama'. One table carries both libraries; this is the only
    -- thing that tells them apart. An older database gets it from the addColumn
    -- call below, and it has to stand here as well or a *fresh* database fails
    -- on the UNIQUE that reads it - which is what happened until 2026-08-30.
    -- (No backticks in this block: it is inside a template literal.)
    kind      TEXT NOT NULL DEFAULT 'book',
    -- The kind is part of the key: one author may have a book and a radio play
    -- of the same name, and moving a title from one root to the other has both
    -- rows alive at once - the old one is not pruned until after the read.
    UNIQUE (title, author_id, kind)
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
// Seconds the timed lyrics are shifted, positive = later. On the track, not per account: a
// mis-stamped file is off for everybody. No scan writes it, so it needs no lock.
addColumn('tracks', 'lyrics_offset', 'REAL NOT NULL DEFAULT 0');
// The full release date next to the year. Filled by the next scan, which
// re-reads every file after the scanner version bump.
addColumn('albums', 'release_date', "TEXT NOT NULL DEFAULT ''");
addColumn('tracks', 'release_date', "TEXT NOT NULL DEFAULT ''");

// Where a playlist sits in the sidebar: pinned to the top, and the order the
// user dragged it into.
addColumn('playlists', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('playlists', 'position', 'INTEGER NOT NULL DEFAULT 0');
// A dynamic playlist stores its filters instead of items (JSON, '' = an ordinary
// list), and a temporary one the ISO instant it goes away ('' = kept).
addColumn('playlists', 'rules', "TEXT NOT NULL DEFAULT ''");
addColumn('playlists', 'expires_at', "TEXT NOT NULL DEFAULT ''");

// The album decides the genres of its songs, not the other way round.
addColumn('albums', 'genres_locked', 'INTEGER NOT NULL DEFAULT 0');

// NULL means "a song", which every music query filters on, so an existing library needs no
// data migration. ALTER may add a foreign key here only because the default is NULL.
addColumn('tracks', 'podcast_id', 'INTEGER REFERENCES podcasts(id) ON DELETE SET NULL');
addColumn('tracks', 'episode_no', 'INTEGER');
// The audiobook side of the same idea.
addColumn('tracks', 'audiobook_id', 'INTEGER REFERENCES audiobooks(id) ON DELETE SET NULL');
addColumn('tracks', 'part_no', 'INTEGER');
// When the cover's episode came out; added after the podcasts table itself.
addColumn('podcasts', 'cover_date', "TEXT NOT NULL DEFAULT ''");

// Read from the file (composer, date) and editable, since the file often knows only the year.
// date_locked covers release date and year together, like year_locked on an album.
addColumn('audiobooks', 'narrator', "TEXT NOT NULL DEFAULT ''");
addColumn('audiobooks', 'release_date', "TEXT NOT NULL DEFAULT ''");
addColumn('audiobooks', 'year', 'INTEGER');
addColumn('audiobooks', 'narrator_locked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('audiobooks', 'date_locked', 'INTEGER NOT NULL DEFAULT 0');

// 'book' or 'drama'. Every reader of the table takes it as an argument, so both libraries share
// every query while staying apart for the listener.
addColumn('audiobooks', 'kind', "TEXT NOT NULL DEFAULT 'book'");

// After the column exists, never before: on an existing database the CREATE
// TABLE block above is a no-op and podcast_id only arrives here.
db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_podcast ON tracks(podcast_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_audiobook ON tracks(audiobook_id)');

// --- Chapters ---------------------------------------------------------------
// Keyed to the track, not the book: each part's chapters start at zero, and chaptersOf merges
// them, so replacing a part cannot corrupt the rest. `start` is seconds into the file; a
// chapter runs until the next one starts.
db.exec(`
  CREATE TABLE IF NOT EXISTS chapters (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    idx      INTEGER NOT NULL,
    title    TEXT NOT NULL DEFAULT '',
    start    REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (track_id, idx)
  );
`);

// --- eBooks -----------------------------------------------------------------
// Keyed by title and author, not path, so renaming the file keeps the row and the reading
// position. `documents` is the number of spine pieces the reader pages through.
db.exec(`
  CREATE TABLE IF NOT EXISTS ebooks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id    INTEGER REFERENCES authors(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    path         TEXT NOT NULL,
    cover        TEXT NOT NULL DEFAULT '',
    language     TEXT NOT NULL DEFAULT '',
    publisher    TEXT NOT NULL DEFAULT '',
    release_date TEXT NOT NULL DEFAULT '',
    year         INTEGER,
    description  TEXT NOT NULL DEFAULT '',
    documents    INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    mtime        INTEGER NOT NULL DEFAULT 0,
    added_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (title, author_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ebooks_author ON ebooks(author_id);

  -- Where the reading stopped: which document of the spine, and how far into
  -- it. A fraction rather than a character offset, because the same document
  -- is a different number of pages at a different font size.
  CREATE TABLE IF NOT EXISTS ebook_progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ebook_id   INTEGER NOT NULL REFERENCES ebooks(id) ON DELETE CASCADE,
    doc        INTEGER NOT NULL DEFAULT 0,
    ratio      REAL NOT NULL DEFAULT 0,
    finished   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, ebook_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ebook_progress_user
    ON ebook_progress(user_id, updated_at DESC);
`);

// Must stand below the ebooks CREATE TABLE: above it, a fresh database dies on "no such table".
// Locked so a correction survives the next scan of an EPUB with the wrong year.
addColumn('ebooks', 'date_locked', 'INTEGER NOT NULL DEFAULT 0');

// --- Films and series ---------------------------------------------------------
// A title is one folder under movies/ or shows/, and the folder is its identity; TMDB only adds
// to it. Paths in `videos` are relative to the root, so a remount keeps every position.
db.exec(`
  CREATE TABLE IF NOT EXISTS video_collections (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id   INTEGER NOT NULL UNIQUE,
    name      TEXT NOT NULL,
    overview  TEXT NOT NULL DEFAULT '',
    poster    TEXT NOT NULL DEFAULT '',
    backdrop  TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS video_titles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    folder        TEXT NOT NULL,
    title         TEXT NOT NULL,
    year          INTEGER,
    tmdb_id       INTEGER,
    -- Set when the match was picked by hand, so no scan second-guesses it.
    tmdb_locked   INTEGER NOT NULL DEFAULT 0,
    original_title TEXT NOT NULL DEFAULT '',
    overview      TEXT NOT NULL DEFAULT '',
    tagline       TEXT NOT NULL DEFAULT '',
    release_date  TEXT NOT NULL DEFAULT '',
    end_date      TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT '',
    certification TEXT NOT NULL DEFAULT '',
    vote          REAL,
    studios       TEXT NOT NULL DEFAULT '[]',
    collection_id INTEGER REFERENCES video_collections(id) ON DELETE SET NULL,
    poster        TEXT NOT NULL DEFAULT '',
    backdrop      TEXT NOT NULL DEFAULT '',
    logo          TEXT NOT NULL DEFAULT '',
    thumb         TEXT NOT NULL DEFAULT '',
    meta_at       TEXT NOT NULL DEFAULT '',
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, folder)
  );
  CREATE INDEX IF NOT EXISTS idx_video_titles_kind ON video_titles(kind, title COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS video_seasons (
    title_id  INTEGER NOT NULL REFERENCES video_titles(id) ON DELETE CASCADE,
    season    INTEGER NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    overview  TEXT NOT NULL DEFAULT '',
    air_date  TEXT NOT NULL DEFAULT '',
    poster    TEXT NOT NULL DEFAULT '',
    meta_at   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (title_id, season)
  );

  -- One playable file: the film itself, or one episode.
  CREATE TABLE IF NOT EXISTS videos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title_id    INTEGER NOT NULL REFERENCES video_titles(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    season      INTEGER,
    episode     INTEGER,
    episode_end INTEGER,
    name        TEXT NOT NULL DEFAULT '',
    overview    TEXT NOT NULL DEFAULT '',
    air_date    TEXT NOT NULL DEFAULT '',
    still       TEXT NOT NULL DEFAULT '',
    duration    REAL NOT NULL DEFAULT 0,
    width       INTEGER,
    height      INTEGER,
    container   TEXT NOT NULL DEFAULT '',
    -- The streams ffprobe found and the subtitle files lying next to the video,
    -- as JSON. Read whole by the player, never queried.
    streams     TEXT NOT NULL DEFAULT '{}',
    subtitles   TEXT NOT NULL DEFAULT '[]',
    size        INTEGER NOT NULL DEFAULT 0,
    mtime       INTEGER NOT NULL DEFAULT 0,
    added_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (title_id, path)
  );
  CREATE INDEX IF NOT EXISTS idx_videos_title ON videos(title_id, season, episode);

  CREATE TABLE IF NOT EXISTS video_genres (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS video_title_genres (
    title_id INTEGER NOT NULL REFERENCES video_titles(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES video_genres(id) ON DELETE CASCADE,
    PRIMARY KEY (title_id, genre_id)
  );
  CREATE INDEX IF NOT EXISTS idx_video_title_genres_genre ON video_title_genres(genre_id);

  CREATE TABLE IF NOT EXISTS video_people (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL UNIQUE,
    name    TEXT NOT NULL,
    photo   TEXT NOT NULL DEFAULT ''
  );
  -- role: 'cast', 'director', 'writer', 'creator', 'composer'.
  CREATE TABLE IF NOT EXISTS video_credits (
    title_id  INTEGER NOT NULL REFERENCES video_titles(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES video_people(id) ON DELETE CASCADE,
    role      TEXT NOT NULL,
    character TEXT NOT NULL DEFAULT '',
    ord       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (title_id, person_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_video_credits_person ON video_credits(person_id);

  CREATE TABLE IF NOT EXISTS video_progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    position   REAL NOT NULL DEFAULT 0,
    completed  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, video_id)
  );
  CREATE INDEX IF NOT EXISTS idx_video_progress_user ON video_progress(user_id, updated_at DESC);

  -- Stars for a film or a series. Nothing reads them since they left the UI on
  -- 2026-09-22; kept so the stars already given are not thrown away.
  CREATE TABLE IF NOT EXISTS video_ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title_id   INTEGER NOT NULL REFERENCES video_titles(id) ON DELETE CASCADE,
    stars      INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, title_id)
  );

  -- Time watched, for the statistics. The twin of plays, which cannot carry a
  -- video because its track_id is NOT NULL.
  CREATE TABLE IF NOT EXISTS video_plays (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id  INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    seconds   INTEGER NOT NULL DEFAULT 0,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_video_plays_user ON video_plays(user_id, played_at DESC);
`);

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

// Lifts hand-edited genres and dates from the tracks onto their album and pushes them back over
// every song of it, so a renamed or new song no longer falls back to its file's tags.
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

// Album ratings were never used. Song ratings are a separate feature and stay.
once('drop_album_ratings', () => {
  db.exec('DROP TABLE IF EXISTS album_ratings;');
});

// The scanner reads "AC∕DC" as "AC/DC". Rows are found by name, so without this a scan would
// make new rows and lose the old ids with their edits and progress. OR IGNORE: where the real
// name is taken, the scan merges the two instead.
once('restore_reserved_characters', () => {
  const named = [
    ['artists', 'name'], ['authors', 'name'], ['podcasts', 'name'],
    ['albums', 'title'], ['audiobooks', 'title'], ['ebooks', 'title'],
  ];
  for (const [table, column] of named) {
    const rename = db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE id = ?`);
    for (const row of db.prepare(`SELECT id, ${column} AS name FROM ${table}`).all()) {
      const name = restoreReserved(row.name);
      if (name !== row.name) rename.run(name, row.id);
    }
  }
});

// Rebuilds audiobooks for the key (title, author_id, kind): moving a title between roots has
// both rows alive until the prune. Not in once(): PRAGMA foreign_keys is a no-op inside a
// transaction, and with it on DROP TABLE would SET NULL every tracks.audiobook_id. Ids are kept.
const audiobooksSchema = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audiobooks'")
  .get();

if (audiobooksSchema && !audiobooksSchema.sql.includes('UNIQUE (title, author_id, kind)')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE audiobooks_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        author_id INTEGER REFERENCES authors(id) ON DELETE SET NULL,
        title     TEXT NOT NULL,
        cover     TEXT NOT NULL DEFAULT '',
        narrator  TEXT NOT NULL DEFAULT '',
        release_date TEXT NOT NULL DEFAULT '',
        year      INTEGER,
        narrator_locked INTEGER NOT NULL DEFAULT 0,
        date_locked     INTEGER NOT NULL DEFAULT 0,
        kind      TEXT NOT NULL DEFAULT 'book',
        UNIQUE (title, author_id, kind)
      );
      INSERT INTO audiobooks_new
        (id, author_id, title, cover, narrator, release_date, year,
         narrator_locked, date_locked, kind)
        SELECT id, author_id, title, cover, narrator, release_date, year,
               narrator_locked, date_locked, kind FROM audiobooks;
      DROP TABLE audiobooks;
      ALTER TABLE audiobooks_new RENAME TO audiobooks;
    `);
  })();
  db.pragma('foreign_keys = ON');
}

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

export {
  dbPath,
  dataDir,
  coversDir,
  transcodeDir,
  musicDir,
  podcastDir,
  audiobookDir,
  audiodramaDir,
  ebookDir,
  videoDir,
  videoArtDir,
  subtitleDir,
};
export default db;
