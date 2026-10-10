// Library scanner: walks the music, podcast, audiobook, audio drama and ebook roots (videos via
// videoscan.js) into the library tables. Artist, album and title come from the folders, not the
// tags, which are inconsistent across a collection; the roots themselves are only ever read.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';

import db, {
  coversDir,
  musicDir,
  podcastDir,
  audiobookDir,
  audiodramaDir,
  ebookDir,
  videoDir,
  movieRoot,
  showRoot,
  getMeta,
  setMeta,
} from '../db.js';
import { readChapters } from './chapters.js';
import { readEpub, mimeOf } from './epub.js';
import { isFfmpegReady, pregenerate, PROFILES } from './transcode.js';
import { normalize, loosen, primaryArtist, isVarious } from './normalize.js';
import { restoreReserved } from './reserved.js';
import { parseReleaseDate, yearOf } from './dates.js';
import { extractLyrics } from './lyrics.js';
import { resolveIssuesForUser } from '../models/issues.js';
import { collectVideoWork, indexVideos, pruneVideos, sweepVideoArt } from './videoscan.js';
import { refreshDueMetadata } from './videometa.js';
import { tmdbEnabled } from './tmdb.js';
import { explainSystemError } from './errors.js';

// Extensions music-metadata can read tags from. Whether a browser can play a
// given file is a separate question (see the README).
const AUDIO_EXT = new Set([
  '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus',
  '.wav', '.wv', '.aif', '.aiff', '.aifc', '.wma', '.ape', '.mpc', '.dsf', '.dff',
]);

// The only ebook format Sonorus reads. A PDF is not a book that reflows, and
// reflowing is the whole of the reading view.
const EBOOK_EXT = new Set(['.epub']);

// Cover files next to the audio, used when a file carries no embedded artwork.
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const COVER_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// Bumped whenever the scanner reads a file differently than it used to. A
// changed version makes the next scan re-read every file instead of skipping
// the unchanged ones, so an existing library picks up the new interpretation.
const SCANNER_VERSION = 'various-single-1';

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
  phase: 'idle', // idle | walking | reading | pruning | transcoding | done | error
  total: 0,
  done: 0,
  added: 0,
  updated: 0,
  removed: 0,
  kept: 0, // files gone, rows kept because a rating or playlist needs them
  skipped: 0,
  failed: 0,
  // What could not be read and why, for the settings page. The log has all of it.
  problems: [],
  startedAt: null,
  finishedAt: null,
  error: '',
};

const MAX_PROBLEMS = 5;

function noteProblem(target, err) {
  if (state.problems.length >= MAX_PROBLEMS) return;
  state.problems.push(explainSystemError(err) || `${target}: ${err && err.message ? err.message : err}`);
}

export function scanState() {
  return {
    ...state,
    musicDir, podcastDir, audiobookDir, audiodramaDir, ebookDir, videoDir,
    movieDir: movieRoot(),
    showDir: showRoot(),
    tmdb: tmdbEnabled(),
    tmdbError: getMeta('tmdb_error') || '',
  };
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

// Keyed by title, author *and* kind: an author is free to have a book and a
// radio play of the same name, and the two roots are two libraries.
const selectBook = db.prepare(
  'SELECT id, cover FROM audiobooks WHERE title = ? AND author_id IS ? AND kind = ?'
);
const insertBook = db.prepare(
  'INSERT INTO audiobooks (title, author_id, kind) VALUES (?, ?, ?)'
);
const setBookCover = db.prepare('UPDATE audiobooks SET cover = ? WHERE id = ?');

function audiobookId(title, aId, kind) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  const found = selectBook.get(clean, aId, kind);
  if (found) return found.id;
  return Number(insertBook.run(clean, aId, kind).lastInsertRowid);
}

// Narrator and date live on the book, not the parts, so a renamed part file cannot take them
// along; a hand edit is never overwritten. `composer` is the narrator on an Audible m4b - what
// Audible writes and Audiobookshelf reads back as `narrators`.
const selectBookMeta = db.prepare(
  'SELECT narrator, release_date, narrator_locked, date_locked FROM audiobooks WHERE id = ?'
);
const setBookNarrator = db.prepare('UPDATE audiobooks SET narrator = ? WHERE id = ?');
const setBookDate = db.prepare('UPDATE audiobooks SET release_date = ?, year = ? WHERE id = ?');

function storeBookMeta(bookId, common, kind) {
  const book = selectBookMeta.get(bookId);
  if (!book) return;

  // A radio play has a cast, not a narrator: six actors under "Gesprochen von" read as one
  // person doing a bad job. The date is read for both.
  if (kind !== 'drama' && !book.narrator_locked) {
    // Several names mean a full cast, which is a radio play read as a book -
    // they are kept as they stand, comma separated, and the interface decides
    // whether to print them.
    const spoken = [].concat(common.composer || []).map((n) => String(n).trim()).filter(Boolean);
    const narrator = spoken.join(', ');
    if (narrator && narrator !== book.narrator) setBookNarrator.run(narrator, bookId);
  }

  if (!book.date_locked) {
    const date = parseReleaseDate(common.date || common.year || '');
    // A tag that is not a date at all leaves what is there alone rather than
    // clearing it; only a real answer overwrites.
    if (date && date !== book.release_date) setBookDate.run(date, yearOf(date), bookId);
  }
}

// The marks inside one part, replaced whole - a file that was re-ripped has
// different ones, and merging two versions of a chapter list is meaningless.
const clearChapters = db.prepare('DELETE FROM chapters WHERE track_id = ?');
const insertChapter = db.prepare(
  'INSERT INTO chapters (track_id, idx, title, start) VALUES (@trackId, @idx, @title, @start)'
);

const writeChapters = db.transaction((trackId, list) => {
  clearChapters.run(trackId);
  list.forEach((chapter, idx) => {
    insertChapter.run({ trackId, idx, title: chapter.title, start: chapter.start });
  });
});

// --- Where a file sits in the folder structure -------------------------------

const UNKNOWN_ARTIST = 'Unbekannter Interpret';

// A folder inside an album that only groups one disc of it ("CD1", "Disc 2").
const DISC_DIR = /^(?:cd|disc|disk)\s*[-_. ]?(\d{1,2})$/i;

// A leading dot hides a name from the walk, so "...Baby One More Time" is stored with a
// backslash in front, dropped here. Look-alikes of reserved characters are read back too.
function nameOf(name) {
  return restoreReserved(name.startsWith('\\.') ? name.slice(1) : name);
}

// "01 - Titel", "01 Titel", "1-01 Titel". Only used inside an album folder, so
// a single called "1979.flac" keeps its name.
function splitTrackNumber(base) {
  // No space around the disc separator ("1-01 Titel"): that alone keeps "02 - 400 Lux" track 2
  // of "400 Lux" rather than disc 2, track 400.
  const withDisc = base.match(/^(\d{1,2})[-_.](\d{1,3})\s*[-._)]?\s+(.+)$/);
  if (withDisc) {
    return { discNo: Number(withDisc[1]), trackNo: Number(withDisc[2]), title: withDisc[3].trim() };
  }
  const m = base.match(/^(\d{1,3})\s*[-._)]\s*(.+)$/) || base.match(/^(\d{1,3})\s+(.+)$/);
  if (!m) return { discNo: null, trackNo: null, title: base };
  return { discNo: null, trackNo: Number(m[1]), title: m[2].trim() || base };
}

// "Lovejoy - Privately Owned Spiral Galaxy": split at the first " - ", since a dash in a title
// is ordinary and one in an artist name is not. Spaces on both sides keep "Jay-Z" whole.
function splitTrackArtist(title) {
  const m = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (!m) return { trackArtist: '', title };
  return { trackArtist: m[1].trim(), title: m[2].trim() };
}

// music/<Artist>/<Album>/01 - Title.flac is an album track, music/<Artist>/Title.flac a single;
// under "Various" the file name is "01 - Artist - Title", a single there "Artist - Title".
function describeFile(filePath) {
  const parts = path.relative(musicDir, filePath).split(path.sep);
  const base = nameOf(path.basename(filePath, path.extname(filePath)).trim());

  const artist = parts.length > 1 ? nameOf(parts[0].trim()) : UNKNOWN_ARTIST;
  const album = parts.length > 2 ? nameOf(parts[1].trim()) : '';
  if (!album) {
    const single = isVarious(artist) ? splitTrackArtist(base) : { trackArtist: '', title: base };
    return { artist, ...single, album: '', trackNo: null, discNo: null };
  }

  const parsed = splitTrackNumber(base);
  // Only under "Various" does the rest of the name start with an interpret.
  // Everywhere else a dash in a title is just part of the title, so nothing is
  // taken off it - the whole point of restricting this to the one folder.
  const named = isVarious(artist)
    ? splitTrackArtist(parsed.title)
    : { trackArtist: '', title: parsed.title };
  // A disc folder carries the disc number the file name usually leaves out.
  const dirName = nameOf(parts[parts.length - 2]);
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

// "#100 Titel", "100 - Titel", "100. Titel". A bare number plus space is not an episode
// number: "2020 Jahresrueckblick" is a title.
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
  const base = nameOf(path.basename(filePath, path.extname(filePath)).trim());
  const show = parts.length > 1 ? nameOf(parts[0].trim()) : UNKNOWN_SHOW;
  const parsed = splitEpisodeNumber(base);
  return { show, title: parsed.title, episodeNo: parsed.episodeNo };
}

// A file lying loose directly under AUDIOBOOK_DIR has neither an author nor a
// book folder to name it; these keep it in the library rather than dropping it.
const UNKNOWN_AUTHOR = 'Unbekannter Autor';

// audiobooks/<Author>/<Book>/<part>.mp3. Parts are never shown, so only the leading number of
// the file name matters, and only for the play order.
function describeAudiobookPart(filePath, root) {
  const parts = path.relative(root, filePath).split(path.sep);
  const base = nameOf(path.basename(filePath, path.extname(filePath)).trim());

  const author = parts.length > 1 ? nameOf(parts[0].trim()) : UNKNOWN_AUTHOR;
  // A file directly in the author folder is a book of one part, named after
  // the file. A book folder is the normal case.
  const book = parts.length > 2 ? nameOf(parts[1].trim()) : base;
  const m = base.match(/^(\d{1,4})\s*[-._)]?\s+/) || base.match(/^(\d{1,4})$/);
  return { author, book, title: base, partNo: m ? Number(m[1]) : null };
}

// --- The release date -------------------------------------------------------

// `date` is the primary tag; the others only refine it with a month or day of the same year.
// Another year means another release, and the primary tag decides which one this file is.
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

// `fromFolder` allows a cover image next to the audio: right for an album folder, wrong for a
// single, where that image belongs to the artist.
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

// One cover per show, from its newest episode: shows rebrand rarely (361 episodes measured with
// 37 pictures), so a file per episode would be waste. The date decides "newest" without re-reading.
async function storePodcastCover(id, meta, filePath, date) {
  const show = db.prepare('SELECT id, cover, cover_date FROM podcasts WHERE id = ?').get(id);
  if (!show) return;
  if (show.cover && show.cover_date >= (date || '')) return;
  const name = await storeCoverFile(meta, filePath, `podcast-${show.id}`, true);
  if (name) setPodcastCover.run(name, date || '', show.id);
}

// The folder a part's book lives in, or null for a book of one file lying in the author folder.
function bookFolder(filePath, root) {
  const parts = path.relative(root, filePath).split(path.sep);
  return parts.length > 2 ? path.join(root, parts[0], parts[1]) : null;
}

async function folderImage(dir) {
  let names;
  try {
    names = new Set(await fsp.readdir(dir));
  } catch {
    return null;
  }
  for (const base of COVER_NAMES) {
    for (const ext of COVER_EXT) {
      if (!names.has(base + ext)) continue;
      const file = path.join(dir, base + ext);
      const stat = await fsp.stat(file);
      return { file, ext: ext === '.jpeg' ? '.jpg' : ext, sig: `${stat.size}:${Math.floor(stat.mtimeMs)}` };
    }
  }
  return null;
}

// Book folders looked at in this scan, so a book of forty parts is looked at once.
const bookFoldersSeen = new Set();
const selectBookCoverSrc = db.prepare('SELECT cover, cover_src FROM audiobooks WHERE id = ?');
const setBookFolderCover = db.prepare('UPDATE audiobooks SET cover = ?, cover_src = ? WHERE id = ?');

// An image in the book folder wins over the one in the files: a part's own art is often small
// or a series placeholder, and the folder is where a book is given its real cover. Looked at on
// every scan, so one dropped in later is taken without the audio changing. The timestamp in the
// name keeps clients from showing the old picture out of their cache.
async function syncBookFolderCover(bookId, folder) {
  if (!folder || bookFoldersSeen.has(folder)) return;
  bookFoldersSeen.add(folder);
  const found = await folderImage(folder);
  if (!found) return;
  const book = selectBookCoverSrc.get(bookId);
  if (!book || book.cover_src === found.sig) return;
  const name = `book-${bookId}-${Date.now()}${found.ext}`;
  await fsp.copyFile(found.file, path.join(coversDir, name));
  setBookFolderCover.run(name, found.sig, bookId);
  if (book.cover) await fsp.unlink(path.join(coversDir, book.cover)).catch(() => {});
}

// A cover.jpg in the book folder counts: that is how an audiobook usually carries its picture.
async function storeBookCover(id, meta, filePath) {
  const book = db.prepare('SELECT id, cover FROM audiobooks WHERE id = ?').get(id);
  if (!book || book.cover) return;
  const name = await storeCoverFile(meta, filePath, `book-${book.id}`, true);
  if (name) setBookCover.run(name, book.id);
}

// --- Walking the folder -----------------------------------------------------

// Folders the last walk could not open. Nothing below them counts as deleted:
// a mount with the wrong owner would otherwise cost every rating-less track its row.
let unreadable = [];

// Every .lrc the walk passed, keyed by its path without the extension, so a song finds its
// sidecar without one more look at the disk per file.
let lyricFiles = new Map();

// Collects the files with the given extensions under one root. Symlinked directories are
// followed but remembered, so a loop cannot make the walk run forever.
async function collectFiles(root, extensions = AUDIO_EXT) {
  const files = [];
  const seenDirs = new Set();

  async function walk(dir) {
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch {
      unreadable.push(path.join(dir, path.sep));
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Said out loud: a mount with the wrong owner otherwise reads as an empty
      // folder, and the scan reports success over a library it just emptied.
      console.warn(`Sonorus: could not open ${dir}:`, err && err.message ? err.message : err);
      noteProblem(dir, err);
      unreadable.push(path.join(dir, path.sep));
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.lrc') {
        lyricFiles.set(full.slice(0, -'.lrc'.length), full);
      } else if (entry.isSymbolicLink()) {
        try {
          const st = await fsp.stat(full);
          if (st.isDirectory()) await walk(full);
          else if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
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
          cover_locked, audiobook_id, lyrics_src
     FROM tracks WHERE path = ?`
);
const markFound = db.prepare("UPDATE tracks SET missing_at = '' WHERE id = ?");
const setLyricsSrc = db.prepare('UPDATE tracks SET lyrics_src = ? WHERE id = ?');
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
  const lrcPath = lyricFiles.get(filePath.slice(0, -path.extname(filePath).length));
  const lrcStat = lrcPath ? await fsp.stat(lrcPath).catch(() => null) : null;
  const lrcSig = lrcStat ? `${lrcStat.size}:${Math.floor(lrcStat.mtimeMs)}` : '';
  if (
    !force && existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs) &&
    existing.lyrics_src === lrcSig
  ) {
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
  const sidecar = lrcStat ? await fsp.readFile(lrcPath, 'utf8').catch(() => '') : '';
  const lyrics = extractLyrics(common, sidecar);
  const aId = artistId(place.artist);
  const album = place.album ? albumRow(place.album, aId, date) : null;
  const alId = album ? album.id : null;

  // A date the user typed in by hand on a single stays - the file's would
  // otherwise win it back on the next scan.
  const yearLocked = !!(existing && existing.year_locked);

  // A hand-edited album decides date and genres of every song in it, new ones included. The lock
  // is the condition, not the value: an emptied date or genre list must clear the song too.
  const albumDate = !!(album && album.year_locked);
  const albumGenres = album && album.genres_locked
    ? albumGenreNames.all(album.id).map((row) => row.name)
    : null;

  const row = {
    path: filePath,
    title: place.title,
    artist_id: aId,
    // Only a song under "Various" fills this: it still belongs to "Various", the
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
    // What the file sings, or the .lrc next to it. Nothing is fetched from elsewhere.
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
  setLyricsSrc.run(lrcSig, trackId);

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

// An episode has no artist, album, browsable genre or hand edits: nothing to lock or inherit.
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

// A part only gives the book something to play, in order. Narrator, release date and chapter
// marks are read from it but are facts about the book, so they go on the book row.
async function indexAudiobookPart(filePath, stat, force, root, kind) {
  const existing = selectTrackByPath.get(filePath);
  if (!force && existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs)) {
    if (existing.missing_at) markFound.run(existing.id);
    if (existing.audiobook_id) await syncBookFolderCover(existing.audiobook_id, bookFolder(filePath, root));
    state.skipped += 1;
    return;
  }

  const meta = await parseFile(filePath, { duration: true });
  const common = meta.common || {};
  const format = meta.format || {};

  const place = describeAudiobookPart(filePath, root);
  const aId = authorId(place.author);
  const bId = audiobookId(place.book, aId, kind);

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

  const trackId = writeTrack(row, [], existing && existing.id, false);

  if (existing) state.updated += 1;
  else state.added += 1;

  if (bId) {
    await syncBookFolderCover(bId, bookFolder(filePath, root));
    await storeBookCover(bId, meta, filePath);
    storeBookMeta(bId, common, kind);
  }

  // Last, because it costs an ffprobe process: an Audible m4b keeps its marks in the file, not
  // in a tag. Only re-read files get here; the size/mtime shortcut returned for the rest.
  if (trackId) writeChapters(trackId, await readChapters(filePath));
}

// --- Pruning ----------------------------------------------------------------

// Deleting a row would cascade its ratings, playlist entries and plays away, so a referenced
// track is only marked missing and stays visible, greyed out with its path.
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
// What the summary counts as kept: the rows Mitteilungen lists. One held only by
// its plays is invisible there, so counting it left a number nothing could clear.
const isMarked = db.prepare(`
  SELECT 1 FROM ratings        WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM playlist_items WHERE track_id = @id
   LIMIT 1
`);
// Only the first scan that misses the file stamps it, so "Fehlt seit" keeps that day.
const markMissing = db.prepare(
  "UPDATE tracks SET missing_at = @now WHERE id = @id AND missing_at = ''"
);
const deleteTrack = db.prepare('DELETE FROM tracks WHERE id = ?');

const retireTracks = db.transaction((ids) => {
  const now = new Date().toISOString();
  let removed = 0;
  let kept = 0;
  for (const id of ids) {
    if (isReferenced.get({ id })) {
      markMissing.run({ id, now });
      if (isMarked.get({ id })) kept += 1;
    } else {
      deleteTrack.run(id);
      removed += 1;
    }
  }
  return { removed, kept };
});

// --- Writing one ebook ------------------------------------------------------

// ebooks/<Author>/<Title>/<file>.epub. The folders win over the EPUB metadata, which on Calibre
// exports reads like "Collins, Suzanne - The Ballad of Songbirds and Snakes".
function describeEbook(filePath) {
  const parts = path.relative(ebookDir, filePath).split(path.sep);
  const base = nameOf(path.basename(filePath, path.extname(filePath)).trim());
  return {
    author: parts.length > 1 ? nameOf(parts[0].trim()) : UNKNOWN_AUTHOR,
    title: parts.length > 2 ? nameOf(parts[1].trim()) : base,
  };
}

const selectEbook = db.prepare(
  'SELECT id, size, mtime, cover, date_locked FROM ebooks WHERE title = ? AND author_id IS ?'
);
const insertEbook = db.prepare(
  'INSERT INTO ebooks (title, author_id, path) VALUES (?, ?, ?)'
);
const updateEbook = db.prepare(`
  UPDATE ebooks
     SET path = @path, language = @language, publisher = @publisher,
         release_date = @release_date, year = @year, description = @description,
         documents = @documents, size = @size, mtime = @mtime
   WHERE id = @id
`);

// The same, for a book whose year somebody has corrected by hand. A locked date
// is a decision, and a scan is not allowed to talk it out of the reader.
const updateEbookKeepingDate = db.prepare(`
  UPDATE ebooks
     SET path = @path, language = @language, publisher = @publisher,
         description = @description,
         documents = @documents, size = @size, mtime = @mtime
   WHERE id = @id
`);
const setEbookCover = db.prepare('UPDATE ebooks SET cover = ? WHERE id = ?');

// One EPUB. Answers the row id so the walk can tell which books it has seen,
// also for the ones it skipped as unchanged.
async function indexEbook(filePath, stat, force) {
  const place = describeEbook(filePath);
  const aId = authorId(place.author);
  const known = selectEbook.get(place.title, aId);
  const size = stat.size;
  const mtime = Math.floor(stat.mtimeMs);
  if (known && !force && known.size === size && known.mtime === mtime) {
    state.skipped += 1;
    return known.id;
  }

  const book = readEpub(filePath);
  const id = known ? known.id : Number(insertEbook.run(place.title, aId, filePath).lastInsertRowid);
  const fields = {
    id,
    path: filePath,
    language: book.language,
    publisher: book.publisher,
    description: book.description,
    documents: book.documents,
    size,
    mtime,
  };
  if (known && known.date_locked) {
    updateEbookKeepingDate.run(fields);
  } else {
    const date = parseReleaseDate(book.date) || '';
    updateEbook.run({ ...fields, release_date: date, year: yearOf(date) });
  }

  const row = db.prepare('SELECT cover FROM ebooks WHERE id = ?').get(id);
  if (book.cover && !row.cover) {
    const name = `ebook-${id}${COVER_MIME_EXT[book.cover.mime] || '.jpg'}`;
    await fsp.writeFile(path.join(coversDir, name), book.cover.data);
    setEbookCover.run(name, id);
  }

  if (known) state.updated += 1;
  else state.added += 1;
  return id;
}

// Removes the parent rows nothing references any more. Albums go first, so a gone album takes
// its album_genres along (cascade) before the genres are counted.
const prune = db.transaction(() => {
  db.exec(`
    DELETE FROM albums
     WHERE id NOT IN (SELECT album_id FROM tracks WHERE album_id IS NOT NULL);
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
     WHERE id NOT IN (SELECT author_id FROM audiobooks WHERE author_id IS NOT NULL)
       AND id NOT IN (SELECT author_id FROM ebooks WHERE author_id IS NOT NULL);
  `);
});

// --- The scan ---------------------------------------------------------------

// Runs one full scan. Returns immediately if a scan is already running, so a
// double click on "Bibliothek scannen" cannot start two walks.
export async function runScan() {
  if (state.running) return scanState();
  bookFoldersSeen.clear();

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
    problems: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: '',
  });
  unreadable = [];
  lyricFiles = new Map();

  try {
    if (!fs.existsSync(musicDir)) {
      throw new Error(`Musikordner nicht gefunden: ${musicDir}`);
    }

    const files = await collectFiles(musicDir);
    // The other roots may be missing; a missing one is walked as unreadable, so a
    // dropped mount keeps its rows instead of deleting them.
    const episodes = await collectFiles(podcastDir);
    const bookParts = await collectFiles(audiobookDir);
    const dramaParts = await collectFiles(audiodramaDir);
    const ebooks = await collectFiles(ebookDir, EBOOK_EXT);
    const videoWork = await collectVideoWork();
    state.total =
      files.length + episodes.length + bookParts.length + dramaParts.length + ebooks.length +
      videoWork.files;
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
          noteProblem(file, err);
        }
        state.done += 1;
      }
    };
    await readAll(files, indexFile);
    await readAll(episodes, indexEpisode);
    await readAll(bookParts, (file, stat, force) =>
      indexAudiobookPart(file, stat, force, audiobookDir, 'book'));
    await readAll(dramaParts, (file, stat, force) =>
      indexAudiobookPart(file, stat, force, audiodramaDir, 'drama'));

    // The ebooks are counted by row rather than by path: the row is keyed by
    // title and author, so a renamed file is the same book.
    const seenBooks = new Set();
    await readAll(ebooks, async (file, stat, force) => {
      const id = await indexEbook(file, stat, force);
      if (id) seenBooks.add(id);
    });
    const seenVideos = await indexVideos(videoWork, state);

    state.phase = 'pruning';
    const known = db.prepare('SELECT id, path FROM tracks').all();
    const unseen = (file) => !seen.has(file) && !unreadable.some((dir) => file.startsWith(dir));
    const gone = known.filter((t) => unseen(t.path)).map((t) => t.id);
    if (gone.length) Object.assign(state, retireTracks(gone));
    // A book whose file is gone is gone: nothing refers to it but the place it
    // was read to, and that is worth less than a shelf full of dead rows.
    // `unseen` also spares a book whose file is there but failed to read this time.
    for (const row of db.prepare('SELECT id, path FROM ebooks').all()) {
      if (!seenBooks.has(row.id) && unseen(row.path)) {
        db.prepare('DELETE FROM ebooks WHERE id = ?').run(row.id);
        state.removed += 1;
      }
    }
    prune();
    state.removed += pruneVideos(videoWork, seenVideos);

    // Songs that were missing at import time may exist now.
    resolveIssuesForUser(null);

    setMeta('scanner_version', SCANNER_VERSION);
    setMeta('last_scan', new Date().toISOString());

    await refreshDueMetadata(state);
    sweepVideoArt();

    // Last on purpose: only now is the library known to be current. Batched here rather than
    // encoded on each song's first play.
    await transcodeBatch();

    state.phase = 'done';
  } catch (err) {
    state.phase = 'error';
    state.error = explainSystemError(err) || (err && err.message ? err.message : String(err));
    console.error('Sonorus: library scan failed:', err);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }

  return scanState();
}

// Reports through the scan's own progress, so the settings page draws one bar for the whole job.
// Skipped without ffmpeg rather than failing: such an instance serves only the originals.
async function transcodeBatch() {
  if (!isFfmpegReady()) return;
  // Read straight from the database rather than through the library model: the
  // model imports nothing of the scanner today, and a scanner that imports it
  // back is one refactor away from a cycle.
  const tracks = db
    .prepare("SELECT id, path, size, mtime, bitrate, lossless, duration FROM tracks WHERE missing_at = '' ORDER BY id")
    .all();
  state.phase = 'transcoding';
  state.total = tracks.length;
  state.done = 0;
  await pregenerate(tracks, PROFILES.opus128, (done, total) => {
    state.done = done;
    state.total = total;
  });
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
