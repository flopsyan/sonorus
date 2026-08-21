// Library scanner: walks the mounted music folder and writes what it finds into
// the library tables.
//
// Who made a track and where it belongs comes from the folder structure, not
// from the file tags - tags are inconsistent across a collection and put songs
// under artists and albums nobody asked for. The layout is the contract:
//
//   music/<Interpret>/<Album>/01 - Titel.flac   album track
//   music/<Interpret>/Titel.flac                single, belongs to no album
//
// One artist folder is read differently, and only that one: under "Various" an
// album is a compilation where every song has an interpret of its own, so the
// file name carries it between the track number and the title:
//
//   music/Various/<Album>/01 - Interpret - Titel.flac
//
// Only what the folders cannot say is still read from the file: release date,
// genre, duration, format and the embedded cover art. Of those, release date and
// genre are read from the file only while nobody has said better: an album that
// was edited by hand hands its own down to every song in it, the ones it gains
// later included.
//
// Spoken word is scanned from a second root, PODCAST_DIR, and read by a rule of
// its own:
//
//   podcasts/<Show>/#001 Titel.mp3               one episode of one show
//
// It is a second root rather than a folder in the music library because the
// rule above would otherwise turn every show into an interpret and every
// episode into a single. Episodes land in the same `tracks` table - so the
// player, the streaming endpoint and the queue need to know nothing about them -
// but they carry a `podcast_id`, and every music query asks for that to be NULL.
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

import db, { coversDir, musicDir, podcastDir, audiobookDir, getMeta, setMeta } from '../db.js';
import { normalize, loosen, primaryArtist } from './normalize.js';
import { parseReleaseDate, yearOf } from './dates.js';
import { extractLyrics } from './lyrics.js';
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

// Bumped whenever the scanner reads a file differently than it used to. A
// changed version makes the next scan re-read every file instead of skipping
// the unchanged ones, so an existing library picks up the new interpretation.
const SCANNER_VERSION = 'audiobooks-1';

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
  kept: 0, // files gone, rows kept because a rating or playlist needs them
  skipped: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  error: '',
};

export function scanState() {
  return { ...state, musicDir, podcastDir, audiobookDir };
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
  `SELECT id, year, release_date, year_locked, genres_locked
     FROM albums WHERE title = ? AND artist_id IS ?`
);
const insertAlbum = db.prepare(
  'INSERT INTO albums (title, artist_id, year, release_date) VALUES (?, ?, ?, ?)'
);
// The album takes the most precise date any of its tracks carries: an empty
// column is filled, and a bare year gives way to the same year with a day on it
// ('2015' -> '2015-05-17'). A date the user typed in by hand is never touched.
const touchAlbumDate = db.prepare(
  `UPDATE albums SET year = @year, release_date = @date
    WHERE id = @id AND year_locked = 0
      AND length(release_date) < length(@date) AND instr(@date, release_date) = 1`
);
const albumGenreNames = db.prepare(
  `SELECT g.name FROM album_genres ag JOIN genres g ON g.id = ag.genre_id
    WHERE ag.album_id = ? ORDER BY g.name COLLATE NOCASE`
);

// The album row this file belongs to, created on first sight. Returned whole
// rather than as an id, because what the caller writes into the track depends on
// what the user has decided about the album.
function albumRow(title, aId, date) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  const found = selectAlbum.get(clean, aId);
  if (found) {
    // A hand-set date is never touched, so the row read above still describes
    // the album afterwards - which is what the caller reads its date back from.
    if (date && !found.year_locked) touchAlbumDate.run({ id: found.id, date, year: yearOf(date) });
    return found;
  }
  const id = Number(insertAlbum.run(clean, aId, yearOf(date), date).lastInsertRowid);
  return { id, year: yearOf(date), release_date: date, year_locked: 0, genres_locked: 0 };
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

const selectPodcast = db.prepare(
  'SELECT id, cover, cover_date, description FROM podcasts WHERE name = ?'
);
const insertPodcast = db.prepare('INSERT INTO podcasts (name) VALUES (?)');
const setPodcastCover = db.prepare(
  'UPDATE podcasts SET cover = ?, cover_date = ? WHERE id = ?'
);
// Written once, by the first episode that carries one. Every episode of a show
// repeats the same show description, so there is nothing to keep up to date.
const setPodcastDescription = db.prepare(
  "UPDATE podcasts SET description = ? WHERE id = ? AND description = ''"
);

function podcastId(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const found = selectPodcast.get(clean);
  if (found) return found.id;
  return Number(insertPodcast.run(clean).lastInsertRowid);
}

const selectAuthor = db.prepare('SELECT id FROM authors WHERE name = ?');
const insertAuthor = db.prepare('INSERT INTO authors (name) VALUES (?)');

function authorId(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const found = selectAuthor.get(clean);
  if (found) return found.id;
  return Number(insertAuthor.run(clean).lastInsertRowid);
}

const selectBook = db.prepare('SELECT id, cover FROM audiobooks WHERE title = ? AND author_id IS ?');
const insertBook = db.prepare('INSERT INTO audiobooks (title, author_id) VALUES (?, ?)');
const setBookCover = db.prepare('UPDATE audiobooks SET cover = ? WHERE id = ?');

function audiobookId(title, aId) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  const found = selectBook.get(clean, aId);
  if (found) return found.id;
  return Number(insertBook.run(clean, aId).lastInsertRowid);
}

// --- Where a file sits in the folder structure -------------------------------

const UNKNOWN_ARTIST = 'Unbekannter Interpret';

// The one artist folder that is read differently: its albums are compilations,
// so the interpret is per song and not per folder. Compared in lower case,
// because artists.name is UNIQUE COLLATE NOCASE and "various" is that folder.
const VARIOUS = 'various';

// A folder inside an album that only groups one disc of it ("CD1", "Disc 2").
const DISC_DIR = /^(?:cd|disc|disk)\s*[-_. ]?(\d{1,2})$/i;

// A name starting with a dot is hidden and never walked (see collectFiles), so
// an album like "...Baby One More Time" would never be scanned. Escaping that
// dot with a backslash - "\...Baby One More Time" - takes the hiding away on
// the filesystem; the backslash is not part of the name and is dropped here, so
// the library shows the title the way it is meant to read.
function unhide(name) {
  return name.startsWith('\\.') ? name.slice(1) : name;
}

// "01 - Titel", "01 Titel", "1-01 Titel". Only used inside an album folder, so
// a single called "1979.flac" keeps its name.
function splitTrackNumber(base) {
  // A disc prefix is written tight ("1-01 Titel"), and that is the only thing
  // that tells it apart from a track number followed by a title that starts
  // with a number: "02 - 400 Lux" is track 2 of "400 Lux", not disc 2 of
  // track 400. So no space is allowed around the separator here.
  const withDisc = base.match(/^(\d{1,2})[-_.](\d{1,3})\s*[-._)]?\s+(.+)$/);
  if (withDisc) {
    return { discNo: Number(withDisc[1]), trackNo: Number(withDisc[2]), title: withDisc[3].trim() };
  }
  const m = base.match(/^(\d{1,3})\s*[-._)]\s*(.+)$/) || base.match(/^(\d{1,3})\s+(.+)$/);
  if (!m) return { discNo: null, trackNo: null, title: base };
  return { discNo: null, trackNo: Number(m[1]), title: m[2].trim() || base };
}

// What is left of a track name on a compilation once the number is gone:
// "Lovejoy - Privately Owned Spiral Galaxy". The *first* separator splits it,
// so the interpret is one segment and the title keeps every dash it has of its
// own - which is the way round that matters, because a title with a dash in it
// is ordinary and an interpret with one is not.
//
// The separator has to be a dash with space on both sides. A hyphenated name
// ("Jay-Z") would otherwise be cut in half, and a file that says nothing about
// an interpret simply keeps its whole title.
function splitTrackArtist(title) {
  const m = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (!m) return { trackArtist: '', title };
  return { trackArtist: m[1].trim(), title: m[2].trim() };
}

// Reads artist, album, track number and title off the path. Everything below
// the artist folder that is not an album folder is a single.
function describeFile(filePath) {
  const parts = path.relative(musicDir, filePath).split(path.sep);
  const base = unhide(path.basename(filePath, path.extname(filePath)).trim());

  const artist = parts.length > 1 ? unhide(parts[0].trim()) : UNKNOWN_ARTIST;
  const album = parts.length > 2 ? unhide(parts[1].trim()) : '';
  if (!album) return { artist, trackArtist: '', album: '', title: base, trackNo: null, discNo: null };

  const parsed = splitTrackNumber(base);
  // Only under "Various" does the rest of the name start with an interpret.
  // Everywhere else a dash in a title is just part of the title, so nothing is
  // taken off it - the whole point of restricting this to the one folder.
  const named = artist.toLowerCase() === VARIOUS
    ? splitTrackArtist(parsed.title)
    : { trackArtist: '', title: parsed.title };
  // A disc folder carries the disc number the file name usually leaves out.
  const dirName = unhide(parts[parts.length - 2]);
  const discDir = dirName === album ? null : DISC_DIR.exec(dirName);
  return {
    artist,
    trackArtist: named.trackArtist,
    album,
    title: named.title,
    trackNo: parsed.trackNo,
    discNo: discDir ? Number(discDir[1]) : parsed.discNo,
  };
}

// A folder directly under PODCAST_DIR is a show; a file lying loose in the root
// belongs to none, and gets this one rather than being skipped, so nothing
// silently disappears from the library.
const UNKNOWN_SHOW = 'Unbekannter Podcast';

// "#100 Titel", "100 - Titel", "100. Titel". A bare number followed by a space
// is deliberately *not* read as an episode number: "2020 Jahresrueckblick" is a
// title, and a show that numbers its episodes at all writes the number tightly
// or with a separator. Both shows in Florian's library use the "#NNN " form.
function splitEpisodeNumber(base) {
  const m = base.match(/^#\s*(\d{1,5})\s+(.+)$/) || base.match(/^(\d{1,5})\s*[-._)]\s*(.+)$/);
  if (!m) return { episodeNo: null, title: base };
  return { episodeNo: Number(m[1]), title: m[2].trim() || base };
}

// The show and the episode a podcast file describes. Simpler than the music
// rule on purpose: a show is one folder, everything under it is an episode, and
// there is no album level to get wrong.
function describeEpisode(filePath) {
  const parts = path.relative(podcastDir, filePath).split(path.sep);
  const base = unhide(path.basename(filePath, path.extname(filePath)).trim());
  const show = parts.length > 1 ? unhide(parts[0].trim()) : UNKNOWN_SHOW;
  const parsed = splitEpisodeNumber(base);
  return { show, title: parsed.title, episodeNo: parsed.episodeNo };
}

// A file lying loose directly under AUDIOBOOK_DIR has neither an author nor a
// book folder to name it; these keep it in the library rather than dropping it.
const UNKNOWN_AUTHOR = 'Unbekannter Autor';

// Where a file sits in audiobooks/<Author>/<Book>/<part>.mp3.
//
// The part is the one thing the listener never sees: a book is one thing to
// them, and the files it is made of only decide the order it plays in. So
// nothing here tries to make a nice title out of the file name - only the
// number in front of it matters, and even that only for sorting.
function describeAudiobookPart(filePath) {
  const parts = path.relative(audiobookDir, filePath).split(path.sep);
  const base = unhide(path.basename(filePath, path.extname(filePath)).trim());

  const author = parts.length > 1 ? unhide(parts[0].trim()) : UNKNOWN_AUTHOR;
  // A file directly in the author folder is a book of one part, named after
  // the file. A book folder is the normal case.
  const book = parts.length > 2 ? unhide(parts[1].trim()) : base;
  const m = base.match(/^(\d{1,4})\s*[-._)]?\s+/) || base.match(/^(\d{1,4})$/);
  return { author, book, title: base, partNo: m ? Number(m[1]) : null };
}

// --- The release date -------------------------------------------------------

// The most precise date the tags of one file agree on. `date` is the primary
// tag, the other two only refine it: a source that says the same year with a
// month or a day on it wins, one that says another year does not - it is a
// different release then, and the primary tag decides which one this file is.
// Without any usable date the bare year tag is still a date.
function releaseDate(common) {
  let best = '';
  for (const raw of [common.date, common.releasedate, common.originaldate]) {
    const date = parseReleaseDate(raw);
    if (!date) continue;
    if (!best) best = date;
    else if (date.length > best.length && date.startsWith(best)) best = date;
  }
  return best || parseReleaseDate(common.year) || '';
}

// --- Cover art --------------------------------------------------------------

const setAlbumCover = db.prepare('UPDATE albums SET cover = ? WHERE id = ?');
const setTrackCover = db.prepare('UPDATE tracks SET cover = ? WHERE id = ?');

// Writes one artwork file into the covers directory and returns its name, or
// an empty string when the file carries none. `fromFolder` allows a cover image
// lying next to the audio: right for an album folder, wrong for a single, where
// the image next to it belongs to the artist and not to that one song.
async function storeCoverFile(meta, filePath, baseName, fromFolder) {
  const picture = meta.common.picture && meta.common.picture[0];
  if (picture && picture.data && picture.data.length) {
    const ext = COVER_MIME_EXT[String(picture.format || '').toLowerCase()] || '.jpg';
    const name = `${baseName}${ext}`;
    await fsp.writeFile(path.join(coversDir, name), Buffer.from(picture.data));
    return name;
  }
  if (!fromFolder) return '';

  const dir = path.dirname(filePath);
  for (const base of COVER_NAMES) {
    for (const ext of COVER_EXT) {
      try {
        const buf = await fsp.readFile(path.join(dir, base + ext));
        const name = `${baseName}${ext === '.jpeg' ? '.jpg' : ext}`;
        await fsp.writeFile(path.join(coversDir, name), buf);
        return name;
      } catch {
        // no such file - try the next candidate
      }
    }
  }
  return '';
}

// The album keeps the first artwork any of its tracks turns up - unless the
// user picked one, in which case that one stays, even if it was removed.
async function storeAlbumCover(albumId_, meta, filePath) {
  const album = db.prepare('SELECT id, cover, cover_locked FROM albums WHERE id = ?').get(albumId_);
  if (!album || album.cover || album.cover_locked) return;
  const name = await storeCoverFile(meta, filePath, `album-${album.id}`, true);
  if (name) setAlbumCover.run(name, album.id);
}

// The show wears the artwork of its newest episode, and only the show does.
// Measured on the real library: 361 Brainpain episodes carry 37 different
// pictures and 330 Serienkiller episodes carry 10 - a show rebrands, it does not
// draw one cover per episode. Storing one file per episode would write those 47
// pictures 691 times for nothing, so the show keeps one and every episode of it
// shows that. The date is what decides "newest" without reading anything twice.
async function storePodcastCover(id, meta, filePath, date) {
  const show = db.prepare('SELECT id, cover, cover_date FROM podcasts WHERE id = ?').get(id);
  if (!show) return;
  if (show.cover && show.cover_date >= (date || '')) return;
  const name = await storeCoverFile(meta, filePath, `podcast-${show.id}`, true);
  if (name) setPodcastCover.run(name, date || '', show.id);
}

// The book keeps the first artwork any of its parts turns up, and a cover.jpg
// lying in the book folder counts - that is the usual way an audiobook carries
// its picture. The author has none of their own; the query borrows one of their
// books' covers, the same way an artist borrows an album's.
async function storeBookCover(id, meta, filePath) {
  const book = db.prepare('SELECT id, cover FROM audiobooks WHERE id = ?').get(id);
  if (!book || book.cover) return;
  const name = await storeCoverFile(meta, filePath, `book-${book.id}`, true);
  if (name) setBookCover.run(name, book.id);
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

const selectTrackByPath = db.prepare(
  `SELECT id, size, mtime, year, release_date, cover, missing_at, genres_locked, year_locked,
          cover_locked
     FROM tracks WHERE path = ?`
);
const markFound = db.prepare("UPDATE tracks SET missing_at = '' WHERE id = ?");
const insertTrack = db.prepare(`
  INSERT INTO tracks (path, title, artist_id, track_artist, album_id, track_no, disc_no, year,
                      release_date, duration, bitrate, codec, lossless, cover, lyrics,
                      lyrics_sync, missing_at,
                      genres_locked, year_locked, cover_locked, size, mtime, norm_title,
                      loose_title, norm_artist, podcast_id, episode_no,
                      audiobook_id, part_no)
  VALUES (@path, @title, @artist_id, @track_artist, @album_id, @track_no, @disc_no, @year,
          @release_date, @duration, @bitrate, @codec, @lossless, @cover, @lyrics,
          @lyrics_sync, @missing_at,
          @genres_locked, @year_locked, @cover_locked, @size, @mtime, @norm_title,
          @loose_title, @norm_artist, @podcast_id, @episode_no,
          @audiobook_id, @part_no)
`);
const updateTrack = db.prepare(`
  UPDATE tracks SET title = @title, artist_id = @artist_id, track_artist = @track_artist,
                    album_id = @album_id,
                    track_no = @track_no, disc_no = @disc_no, year = @year,
                    release_date = @release_date, duration = @duration,
                    bitrate = @bitrate, codec = @codec, lossless = @lossless, cover = @cover,
                    lyrics = @lyrics, lyrics_sync = @lyrics_sync,
                    missing_at = @missing_at, genres_locked = @genres_locked,
                    year_locked = @year_locked, cover_locked = @cover_locked,
                    size = @size, mtime = @mtime,
                    norm_title = @norm_title, loose_title = @loose_title, norm_artist = @norm_artist,
                    podcast_id = @podcast_id, episode_no = @episode_no,
                    audiobook_id = @audiobook_id, part_no = @part_no
   WHERE id = @id
`);
const clearTrackGenres = db.prepare('DELETE FROM track_genres WHERE track_id = ?');
const linkTrackGenre = db.prepare(
  'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)'
);

// `keepGenres` is set for a track whose genres the user edited by hand - the
// file's genres would otherwise win back on the next scan.
const writeTrack = db.transaction((row, genres, existingId, keepGenres) => {
  let id = existingId;
  if (id) {
    updateTrack.run({ ...row, id });
  } else {
    id = Number(insertTrack.run(row).lastInsertRowid);
  }
  if (keepGenres) return id;

  clearTrackGenres.run(id);
  for (const name of genres) {
    const gid = genreId(name);
    if (gid) linkTrackGenre.run(id, gid);
  }
  return id;
});

async function indexFile(filePath, stat, force) {
  const existing = selectTrackByPath.get(filePath);
  if (!force && existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs)) {
    // A file that was marked missing and is back unchanged never reaches the
    // write below, so it is cleared here.
    if (existing.missing_at) markFound.run(existing.id);
    state.skipped += 1;
    return;
  }

  const meta = await parseFile(filePath, { duration: true });
  const common = meta.common || {};
  const format = meta.format || {};

  // The folders decide artist, album, title and track number; the file only
  // fills in what a folder name cannot say.
  const place = describeFile(filePath);
  const date = releaseDate(common);
  const lyrics = extractLyrics(common);
  const aId = artistId(place.artist);
  const album = place.album ? albumRow(place.album, aId, date) : null;
  const alId = album ? album.id : null;

  // A date the user typed in by hand on a single stays - the file's would
  // otherwise win it back on the next scan.
  const yearLocked = !!(existing && existing.year_locked);

  // An album that was edited by hand decides the date and the genres of every
  // song in it, this one included - whether it has been in the album all along
  // or is arriving now under a new name. The lock is the condition and not the
  // value behind it: a date or a genre list the user deliberately emptied has to
  // clear the song too, and would otherwise fall back to the file.
  const albumDate = !!(album && album.year_locked);
  const albumGenres = album && album.genres_locked
    ? albumGenreNames.all(album.id).map((row) => row.name)
    : null;

  const row = {
    path: filePath,
    title: place.title,
    artist_id: aId,
    // Only a compilation fills this: the album still belongs to "Various", the
    // song says who made it. Empty means "the artist folder is the answer".
    track_artist: place.trackArtist,
    album_id: alId,
    track_no: place.trackNo,
    disc_no: place.discNo,
    year: albumDate ? album.year : yearLocked ? existing.year : yearOf(date),
    release_date: albumDate ? album.release_date : yearLocked ? existing.release_date : date,
    duration: format.duration || 0,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    codec: String(format.codec || format.container || ''),
    lossless: format.lossless ? 1 : 0,
    // Only singles carry their own artwork; an album track shows its album's,
    // which is also why a track moving into an album loses the lock with it.
    cover: alId ? '' : (existing && existing.cover) || '',
    // What the file itself sings. There is nowhere else to get it from, so an
    // untagged song simply has none.
    lyrics: lyrics.text,
    lyrics_sync: lyrics.lines.length ? JSON.stringify(lyrics.lines) : '',
    missing_at: '',
    genres_locked: albumGenres ? 1 : (existing && existing.genres_locked) || 0,
    year_locked: yearLocked ? 1 : 0,
    cover_locked: alId ? 0 : (existing && existing.cover_locked) || 0,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    norm_title: normalize(place.title),
    loose_title: loosen(place.title),
    // A CSV export names the artist of the *song*, so on a compilation that is
    // what an import has to match against - not the "Various" folder.
    norm_artist: primaryArtist(place.trackArtist || place.artist),
    // This is music. Every library query asks for exactly that.
    podcast_id: null,
    episode_no: null,
    audiobook_id: null,
    part_no: null,
  };

  const trackId = writeTrack(
    row,
    albumGenres || (Array.isArray(common.genre) ? common.genre : []),
    existing && existing.id,
    // The album's list is written every time, so its songs cannot drift apart.
    // Only a single keeps a list of its own untouched.
    !albumGenres && !!(existing && existing.genres_locked)
  );

  if (existing) state.updated += 1;
  else state.added += 1;

  if (alId) {
    await storeAlbumCover(alId, meta, filePath);
    // A cover the user picked for the single stays, and one the user removed
    // stays removed - the embedded picture would win it back otherwise.
  } else if (!row.cover && !row.cover_locked) {
    const name = await storeCoverFile(meta, filePath, `track-${trackId}`, false);
    if (name) setTrackCover.run(name, trackId);
  }
}

// One episode of one show. Far shorter than indexFile because almost everything
// that makes a music track complicated has no counterpart here: an episode
// belongs to no artist and no album, carries no genre worth browsing by, and
// nobody hand-edits it - so there is nothing to lock and nothing to inherit.
async function indexEpisode(filePath, stat, force) {
  const existing = selectTrackByPath.get(filePath);
  if (!force && existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs)) {
    if (existing.missing_at) markFound.run(existing.id);
    state.skipped += 1;
    return;
  }

  const meta = await parseFile(filePath, { duration: true });
  const common = meta.common || {};
  const format = meta.format || {};

  const place = describeEpisode(filePath);
  const date = releaseDate(common);
  const pId = podcastId(place.show);

  // The show description, written once. music-metadata reports the ID3 TDES
  // frame here, and every episode of a show repeats the same text.
  const described = Array.isArray(common.description) ? common.description[0] : common.description;
  if (pId && described) setPodcastDescription.run(String(described).trim(), pId);

  const row = {
    path: filePath,
    title: place.title,
    artist_id: null,
    track_artist: '',
    album_id: null,
    track_no: null,
    disc_no: null,
    year: yearOf(date),
    release_date: date,
    duration: format.duration || 0,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    codec: String(format.codec || format.container || ''),
    lossless: format.lossless ? 1 : 0,
    // The show carries the artwork, see storePodcastCover.
    cover: '',
    lyrics: '',
    lyrics_sync: '',
    missing_at: '',
    genres_locked: 0,
    year_locked: 0,
    cover_locked: 0,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    norm_title: normalize(place.title),
    loose_title: loosen(place.title),
    // The show stands where the interpret stands for a song, so the search
    // finds an episode under the name of its podcast.
    norm_artist: primaryArtist(place.show),
    podcast_id: pId,
    episode_no: place.episodeNo,
    audiobook_id: null,
    part_no: null,
  };

  // No genres: "Podcast" is the only tag these files carry, and a genre that
  // every episode shares says nothing and would sit in the music library's
  // genre list.
  writeTrack(row, [], existing && existing.id, false);

  if (existing) state.updated += 1;
  else state.added += 1;

  if (pId) await storePodcastCover(pId, meta, filePath, date);
}

// One part of one book. Shorter still than an episode: a part has no title
// worth showing, no date, no genre and nothing anybody edits - it exists only
// so the book has something to play, in the right order.
async function indexAudiobookPart(filePath, stat, force) {
  const existing = selectTrackByPath.get(filePath);
  if (!force && existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs)) {
    if (existing.missing_at) markFound.run(existing.id);
    state.skipped += 1;
    return;
  }

  const meta = await parseFile(filePath, { duration: true });
  const common = meta.common || {};
  const format = meta.format || {};

  const place = describeAudiobookPart(filePath);
  const aId = authorId(place.author);
  const bId = audiobookId(place.book, aId);

  const row = {
    path: filePath,
    // The file name, and it is never shown - see describeAudiobookPart. The
    // book title is what the listener reads, and that comes from the folder.
    title: place.title,
    artist_id: null,
    track_artist: '',
    album_id: null,
    track_no: null,
    disc_no: null,
    year: null,
    release_date: '',
    duration: format.duration || 0,
    bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    codec: String(format.codec || format.container || ''),
    lossless: format.lossless ? 1 : 0,
    // The book carries the artwork, like a show does for its episodes.
    cover: '',
    lyrics: '',
    lyrics_sync: '',
    missing_at: '',
    genres_locked: 0,
    year_locked: 0,
    cover_locked: 0,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    // Searched for under the book and the author, which is what a listener
    // would type - never under the name of a part file.
    norm_title: normalize(place.book),
    loose_title: loosen(place.book),
    norm_artist: primaryArtist(place.author),
    podcast_id: null,
    episode_no: null,
    audiobook_id: bId,
    part_no: place.partNo,
  };

  writeTrack(row, [], existing && existing.id, false);

  if (existing) state.updated += 1;
  else state.added += 1;

  if (bId) await storeBookCover(bId, meta, filePath);
}

// --- Pruning ----------------------------------------------------------------

// A star rating outlives its file: deleting the row would cascade the rating
// away, so a track someone has rated, put in a playlist or listened to is only
// marked as missing and stays visible - greyed out, with its path. Everything
// else nobody would miss is deleted as before.
const isReferenced = db.prepare(`
  SELECT 1 FROM ratings        WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM playlist_items WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM plays          WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM episode_progress WHERE track_id = @id
   LIMIT 1
`);
const markMissing = db.prepare('UPDATE tracks SET missing_at = @now WHERE id = @id');
const deleteTrack = db.prepare('DELETE FROM tracks WHERE id = ?');

const retireTracks = db.transaction((ids) => {
  const now = new Date().toISOString();
  let removed = 0;
  for (const id of ids) {
    if (isReferenced.get({ id })) markMissing.run({ id, now });
    else {
      deleteTrack.run(id);
      removed += 1;
    }
  }
  return removed;
});

// Removes the artists, albums and genres that no track references any more.
// Playlist entries and ratings pointing at a deleted track cascade away with it.
//
// The albums go first, so an album that is gone takes its own genre list with it
// (album_genres cascades) before the genres are counted - and a list that is
// still standing keeps its genres, which the songs of that album carry anyway.
//
// An album someone has rated stays, for the same reason a rated track is only
// marked missing instead of deleted: the rating is the user's and would cascade
// away with the row. A record whose folder is gone keeps no songs, so no view
// lists it any more - but rename the folder back and the stars are still on it.
const prune = db.transaction(() => {
  db.exec(`
    DELETE FROM albums
     WHERE id NOT IN (SELECT album_id FROM tracks WHERE album_id IS NOT NULL)
       AND id NOT IN (SELECT album_id FROM album_ratings);
    DELETE FROM artists
     WHERE id NOT IN (SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL)
       AND id NOT IN (SELECT artist_id FROM albums WHERE artist_id IS NOT NULL);
    DELETE FROM genres
     WHERE id NOT IN (SELECT genre_id FROM track_genres)
       AND id NOT IN (SELECT genre_id FROM album_genres);
    DELETE FROM podcasts
     WHERE id NOT IN (SELECT podcast_id FROM tracks WHERE podcast_id IS NOT NULL);
    DELETE FROM audiobooks
     WHERE id NOT IN (SELECT audiobook_id FROM tracks WHERE audiobook_id IS NOT NULL);
    DELETE FROM authors
     WHERE id NOT IN (SELECT author_id FROM audiobooks WHERE author_id IS NOT NULL);
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
    kept: 0,
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
    // A second root, and it is allowed to be missing: an instance without
    // spoken word simply has nothing there. Only the music folder is required.
    const episodes = fs.existsSync(podcastDir) ? await collectFiles(podcastDir) : [];
    // And a third, on the same terms: missing is fine.
    const bookParts = fs.existsSync(audiobookDir) ? await collectFiles(audiobookDir) : [];
    state.total = files.length + episodes.length + bookParts.length;
    state.phase = 'reading';

    // After a change to how a file is read, the size/mtime shortcut would keep
    // the old interpretation alive forever - so read everything once.
    const force = getMeta('scanner_version') !== SCANNER_VERSION;

    const seen = new Set();
    const readAll = async (list, index) => {
      for (const file of list) {
        seen.add(file);
        try {
          const stat = await fsp.stat(file);
          await index(file, stat, force);
        } catch (err) {
          state.failed += 1;
          console.warn(`Sonorus: could not read ${file}:`, err && err.message ? err.message : err);
        }
        state.done += 1;
      }
    };
    await readAll(files, indexFile);
    await readAll(episodes, indexEpisode);
    await readAll(bookParts, indexAudiobookPart);

    state.phase = 'pruning';
    const known = db.prepare('SELECT id, path FROM tracks').all();
    const gone = known.filter((t) => !seen.has(t.path)).map((t) => t.id);
    if (gone.length) {
      state.removed = retireTracks(gone);
      state.kept = gone.length - state.removed;
    }
    prune();

    // Songs that were missing at import time may exist now.
    resolveIssuesForUser(null);

    setMeta('scanner_version', SCANNER_VERSION);
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
