import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { getMeta } from '../db.js';
import { requireAuthApi, setSessionCookie } from '../lib/auth.js';
import { runScan, scanState, isScanning } from '../lib/scanner.js';
import {
  PROFILES,
  ORIGINAL,
  profileOf,
  ensure as ensureTranscode,
  batchState,
  cacheStats,
  isFfmpegReady,
} from '../lib/transcode.js';
import { readPlaylistCsv } from '../lib/csv.js';
import {
  listTracks,
  countTracks,
  getTrack,
  getLyrics,
  setLyricsOffset,
  streamTrack,
  tracksByIds,
  listArtists,
  getArtist,
  listAlbums,
  getAlbum,
  listGenres,
  getGenres,
  tracksByStarSelection,
  starCounts,
  recentlyAdded,
  recentlyPlayed,
  mostPlayed,
  newestAlbums,
  randomTracks,
  searchLibrary,
  libraryStats,
} from '../models/library.js';
import {
  listPodcasts,
  getPodcast,
  continueListening,
  setProgress,
  searchEpisodes,
  podcastStats,
} from '../models/podcasts.js';
import {
  listAuthors,
  getAuthor,
  listBooks,
  getBook,
  continueBooks,
  setBookHeard,
  searchBooks,
  audiobookStats,
  BOOK,
  DRAMA,
} from '../models/audiobooks.js';
import {
  listAuthors as listEbookAuthors,
  getAuthor as getEbookAuthor,
  getBook as getEbook,
  progressOf as ebookProgress,
  continueBooks as continueEbooks,
  setProgress as setEbookProgress,
  ebookStats,
  ebookFile,
  readResource,
  readerDocument,
  READER_CSP,
} from '../models/ebooks.js';
import {
  playlistTree,
  listPlaylists,
  getPlaylist,
  createPlaylist,
  createDynamicPlaylist,
  setRules,
  keepPlaylist,
  extendPlaylist,
  updatePlaylist,
  deletePlaylist,
  playlistTracks,
  addTracks,
  removeItem,
  reorderItems,
  reorderPlaylists,
  createFolder,
  renameFolder,
  deleteFolder,
} from '../models/playlists.js';
import { filterOptions } from '../models/dynamic.js';
import {
  setRating,
  recordPlay,
  updatePlaySeconds,
  clearHistory,
} from '../models/ratings.js';
import { listeningStats } from '../models/stats.js';
import {
  updateAlbum,
  updateSingle,
  updateArtistCover,
  updateAuthorCover,
  updateEbook,
  updateBook,
} from '../models/edits.js';
import {
  listIssues,
  countIssues,
  dismissIssue,
  clearIssues,
  resolveIssuesForUser,
} from '../models/issues.js';
import { listMissing, countMissing, dropMissing } from '../models/missing.js';
import { searchVideos } from '../models/videos.js';
import videoRouter from './video.js';
import { fail } from '../lib/errors.js';
import { importEntries, importIntoPlaylist } from '../models/import.js';
import {
  listUsers,
  createUser,
  deleteUser,
  updateProfile,
  changePassword,
  verifyPassword,
  getUserById,
  setUserPref,
  userPrefs,
} from '../models/users.js';

const router = express.Router();

// Everything below the /api prefix needs a logged-in account.
router.use(requireAuthApi);
// Behind the login check, so nobody anonymous makes the server parse 12 MB. The CSV import needs that much.
router.use(express.json({ limit: '12mb' }));

router.use(videoRouter);

function adminOnly(req, res, next) {
  if (!req.user.is_admin) return fail(res, 'admin_only');
  return next();
}

const id = (value) => Number.parseInt(value, 10);

// --- Bootstrap --------------------------------------------------------------

// Everything the client needs to draw the shell on first load.
router.get('/bootstrap', (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.display_name,
      avatar: req.user.avatar,
      isAdmin: !!req.user.is_admin,
    },
    siteName: req.app.locals.siteName,
    stats: libraryStats(),
    playlists: playlistTree(req.user.id),
    stars: starCounts(req.user.id),
    issues: countIssues(req.user.id),
    // Kept apart from the import notices; the client adds both up only for the badge.
    missing: countMissing(req.user.id),
    prefs: userPrefs(req.user),
    scan: scanState(),
    lastScan: getMeta('last_scan'),
  });
});

// --- Library ----------------------------------------------------------------

// No page-size cap on purpose: a capped list made play, shuffle and download
// silently act on a slice while the header counted the whole library.
router.get('/tracks', (req, res) => {
  const limit = Math.max(Number(req.query.limit) || 0, 0);
  res.json({
    ok: true,
    total: countTracks({ q: req.query.q }),
    tracks: listTracks({
      userId: req.user.id,
      q: req.query.q,
      sort: req.query.sort,
      dir: req.query.dir,
      limit,
      offset: Number(req.query.offset) || 0,
    }),
  });
});

router.post('/tracks/by-ids', (req, res) => {
  res.json({ ok: true, tracks: tracksByIds(req.body.ids, req.user.id) });
});

router.get('/tracks/:id', (req, res) => {
  const track = getTrack(id(req.params.id), req.user.id);
  if (!track) return fail(res, 'not_found', 'track');
  res.json({ ok: true, track });
});

// Separate from the track projection every list selects, so no list carries the text.
// `lines` is filled only for timed lyrics, which is how a client tells synced from plain.
router.get('/tracks/:id/lyrics', (req, res) => {
  const lyrics = getLyrics(id(req.params.id));
  if (!lyrics) return fail(res, 'not_found', 'lyrics');
  res.json({ ok: true, lyrics });
});

// Not part of PATCH /tracks/:id below: a slider writes it while the song plays,
// so it does one thing and answers with the value really stored.
router.put('/tracks/:id/lyrics-offset', (req, res) => {
  const offset = setLyricsOffset(id(req.params.id), req.body.offset);
  if (offset === null) return fail(res, 'not_found', 'track');
  res.json({ ok: true, offset });
});

// A track can be edited where it has nobody to take the value from: release
// date, genres and cover art of a single. Everything else comes from the folder
// structure or from the album.
router.patch('/tracks/:id', async (req, res) => {
  const patch = {};
  if ('date' in req.body) patch.date = req.body.date;
  if ('genres' in req.body) patch.genres = req.body.genres;
  if ('cover' in req.body) patch.cover = req.body.cover;
  if (!Object.keys(patch).length) return fail(res, 'nothing_to_edit');

  const result = await updateSingle(id(req.params.id), patch);
  if (result.error) return fail(res, result.error, 'track');
  res.json({ ok: true, track: getTrack(id(req.params.id), req.user.id) });
});

router.get('/artists', (req, res) => {
  res.json({ ok: true, artists: listArtists({ q: req.query.q }) });
});

router.get('/artists/:id', (req, res) => {
  const artist = getArtist(id(req.params.id), req.user.id);
  if (!artist) return fail(res, 'not_found', 'artist');
  res.json({ ok: true, artist });
});

// The profile picture, and nothing else: the name of an artist is the name of
// the folder, so the next scan would read it back anyway.
router.patch('/artists/:id', async (req, res) => {
  if (!('cover' in req.body)) return fail(res, 'nothing_to_edit');

  const result = await updateArtistCover(id(req.params.id), req.body.cover);
  if (result.error) return fail(res, result.error, 'artist');
  res.json({ ok: true, artist: getArtist(id(req.params.id), req.user.id) });
});

router.get('/albums', (req, res) => {
  res.json({
    ok: true,
    albums: listAlbums({
      userId: req.user.id,
      q: req.query.q,
      sort: req.query.sort,
      dir: req.query.dir,
    }),
  });
});

router.get('/albums/:id', (req, res) => {
  const album = getAlbum(id(req.params.id), req.user.id);
  if (!album) return fail(res, 'not_found', 'album');
  res.json({ ok: true, album });
});

// The music folder is read-only, so this only changes what Sonorus shows. Like the
// scan, it edits the shared library and needs a login, not an admin.
router.patch('/albums/:id', async (req, res) => {
  const patch = {};
  if ('date' in req.body) patch.date = req.body.date;
  if ('genres' in req.body) patch.genres = req.body.genres;
  if ('cover' in req.body) patch.cover = req.body.cover;

  const result = await updateAlbum(id(req.params.id), patch);
  if (result.error) return fail(res, result.error, 'album');
  res.json({ ok: true, album: getAlbum(id(req.params.id), req.user.id) });
});

router.get('/genres', (req, res) => {
  res.json({ ok: true, genres: listGenres() });
});

// Several genres can be asked for at once ("1,4"), which gives one combined
// list - the same as the star playlists do with several ratings.
router.get('/genres/:ids', (req, res) => {
  const genre = getGenres(String(req.params.ids).split(',').map((value) => id(value)), req.user.id);
  if (!genre) return fail(res, 'not_found', 'genre');
  res.json({ ok: true, genre });
});

// --- Podcasts ---------------------------------------------------------------

// The spoken-word side of the library. Episodes share the tracks table with the
// songs, so playing and streaming one needs nothing of its own - only browsing
// them and remembering where listening stopped does.
router.get('/podcasts', (req, res) => {
  res.json({
    ok: true,
    podcasts: listPodcasts(req.user.id),
    // What is half-finished, across all shows. The row at the top of the page.
    continue: continueListening(req.user.id, 12),
    stats: podcastStats(req.user.id),
  });
});

router.get('/podcasts/:id', (req, res) => {
  const podcast = getPodcast(id(req.params.id), req.user.id, { sort: req.query.sort });
  if (!podcast) return fail(res, 'not_found', 'podcast');
  res.json({ ok: true, podcast });
});

// Where listening stopped, for anything spoken: a podcast episode or a part of
// an audiobook. One endpoint, because the player does not care which it is -
// it reports a position on a long track it may be leaving.
router.put('/progress/:id', (req, res) => {
  const result = setProgress(req.user.id, id(req.params.id), {
    position: req.body.position,
    completed: req.body.completed,
  });
  if (result.error) return fail(res, result.error, 'spoken');
  res.json(result);
});

// --- Audiobooks -------------------------------------------------------------

// Audiobooks and radio plays are one table underneath and two libraries to the
// listener, so one set of handlers serves both paths. A book's parts only leave
// inside `getBook`, where the player needs them to queue.
function spokenRoutes(base, kind) {
  router.get(`/${base}`, (req, res) => {
    res.json({
      ok: true,
      kind,
      authors: listAuthors(kind),
      continue: continueBooks(req.user.id, 12, kind),
      stats: audiobookStats(req.user.id, kind),
    });
  });

  router.get(`/${base}/authors/:id`, (req, res) => {
    const author = getAuthor(id(req.params.id), req.user.id, kind);
    if (!author) return fail(res, 'not_found', 'author');
    res.json({ ok: true, author });
  });

  // The picture only, as for an artist: the name is the folder name.
  router.patch(`/${base}/authors/:id`, async (req, res) => {
    if (!('cover' in req.body)) return fail(res, 'nothing_to_edit');

    const result = await updateAuthorCover(id(req.params.id), req.body.cover);
    if (result.error) return fail(res, result.error, 'author');
    res.json({ ok: true, author: getAuthor(id(req.params.id), req.user.id, kind) });
  });

  // "books" in both paths on purpose: a play is a book to everything below this
  // line, and a second word for it would only have to be translated back.
  router.get(`/${base}/books/:id`, (req, res) => {
    const book = getBook(id(req.params.id), req.user.id);
    if (!book || book.kind !== kind) return fail(res, 'not_found', kind === DRAMA ? 'drama' : 'book');
    res.json({ ok: true, book });
  });

  // Overrides for a file that is wrong or too coarse (an m4b carries only the year).
  // A radio play has no narrator, so it only ever sends the date.
  router.patch(`/${base}/books/:id`, (req, res) => {
    if (!('narrator' in req.body) && !('date' in req.body)) return fail(res, 'nothing_to_edit');

    const current = getBook(id(req.params.id), req.user.id);
    if (!current || current.kind !== kind) return fail(res, 'not_found', kind === DRAMA ? 'drama' : 'book');

    const patch = kind === DRAMA ? { ...req.body, narrator: undefined } : req.body;
    if (kind === DRAMA) delete patch.narrator;
    const result = updateBook(id(req.params.id), patch);
    if (result.error) return fail(res, result.error, kind === DRAMA ? 'drama' : 'book');
    res.json({ ok: true, book: getBook(id(req.params.id), req.user.id) });
  });

  // Heard or not heard, for the whole thing at once - there is no smaller unit
  // the listener is shown.
  router.put(`/${base}/books/:id/heard`, (req, res) => {
    const result = setBookHeard(req.user.id, id(req.params.id), !!req.body.heard);
    if (result.error) return fail(res, result.error, kind === DRAMA ? 'drama' : 'book');
    res.json({ ...result, book: getBook(id(req.params.id), req.user.id) });
  });
}

spokenRoutes('audiobooks', BOOK);
spokenRoutes('audiodramas', DRAMA);

// --- eBooks -----------------------------------------------------------------
//
// Read, not played: no queue and no rating. `/file` is the whole EPUB for offline
// clients, `/read/*` hands its pieces to the reading view.

router.get('/ebooks', (req, res) => {
  res.json({
    ok: true,
    authors: listEbookAuthors(),
    continue: continueEbooks(req.user.id),
    stats: ebookStats(),
  });
});

router.get('/ebooks/authors/:id', (req, res) => {
  const author = getEbookAuthor(id(req.params.id), req.user.id);
  if (!author) return fail(res, 'not_found', 'author');
  res.json({ ok: true, author });
});

router.get('/ebooks/books/:id', (req, res) => {
  const book = getEbook(id(req.params.id), req.user.id);
  if (!book) return fail(res, 'not_found', 'ebook');
  res.json({ ok: true, book });
});

// The picture only: the name is the folder's. The `authors` table is shared with
// the spoken word, so someone both heard and read has one picture.
router.patch('/ebooks/authors/:id', async (req, res) => {
  if (!('cover' in req.body)) return fail(res, 'nothing_to_edit');
  const result = await updateAuthorCover(id(req.params.id), req.body.cover);
  if (result.error) return fail(res, result.error, 'author');
  res.json({ ok: true, author: getEbookAuthor(id(req.params.id), req.user.id) });
});

// The year, for the book whose EPUB carries the wrong one. Everything else on
// the page is the folder's name or the file's own metadata.
router.patch('/ebooks/books/:id', (req, res) => {
  if (!('date' in req.body)) return fail(res, 'nothing_to_edit');
  const result = updateEbook(id(req.params.id), req.body);
  if (result.error) return fail(res, result.error, 'ebook');
  res.json({ ok: true, book: getEbook(id(req.params.id), req.user.id) });
});

router.put('/ebooks/books/:id/progress', (req, res) => {
  const result = setEbookProgress(req.user.id, id(req.params.id), req.body || {});
  if (result.error) return fail(res, result.error, 'ebook');
  res.json({ ok: true, progress: ebookProgress(id(req.params.id), req.user.id) });
});

// The whole EPUB, for reading offline. `sendFile` accepts ranges, so a broken download resumes.
router.get('/ebooks/books/:id/file', (req, res) => {
  const book = ebookFile(id(req.params.id));
  if (!book) return fail(res, 'not_found', 'ebookFile');
  res.type('application/epub+zip');
  res.sendFile(book.path, (err) => {
    if (err && !res.headersSent) fail(res, 'not_found', 'ebookFile');
  });
});

// Mirrors the path inside the zip, so the book's own relative links (images, CSS
// `url()`) resolve against this URL without rewriting every document.
router.get('/ebooks/books/:id/read/*name', (req, res) => {
  const name = Array.isArray(req.params.name) ? req.params.name.join('/') : req.params.name;
  let piece;
  try {
    piece = readResource(id(req.params.id), name);
  } catch {
    return fail(res, 'not_found', 'ebookPage');
  }
  if (!piece) return fail(res, 'not_found', 'ebookPage');

  // The book's own CSP: it may style itself, which an EPUB does inline, and load nothing from elsewhere.
  res.set('Content-Security-Policy', READER_CSP);
  if (piece.document >= 0) {
    res.type('text/html; charset=utf-8');
    return res.send(readerDocument(piece.data, piece.language));
  }
  res.type(piece.mime);
  res.set('Cache-Control', 'private, max-age=3600');
  return res.send(piece.data);
});

// 0 is the list of everything that has no rating yet. Several ratings can be
// asked for at once ("4,5"), which gives one combined list.
router.get('/stars/:stars', (req, res) => {
  const stars = [...new Set(String(req.params.stars).split(',').map((v) => id(v)))];
  if (!stars.length || stars.some((n) => !(n >= 0 && n <= 5))) return fail(res, 'invalid_stars');
  res.json({ ok: true, stars, tracks: tracksByStarSelection(stars, req.user.id) });
});

// The home page: what is new, what was played, what gets played most.
router.get('/home', (req, res) => {
  res.json({
    ok: true,
    stats: libraryStats(),
    // How much is still waiting for a star. Per account, so it is not part of
    // libraryStats - and it is what decides whether the page offers a random
    // run through the unrated songs at all.
    unrated: starCounts(req.user.id)[0],
    newestAlbums: newestAlbums(12),
    recentlyAdded: recentlyAdded(req.user.id, 12),
    recentlyPlayed: recentlyPlayed(req.user.id, 12),
    mostPlayed: mostPlayed(req.user.id, 12),
  });
});

// `unrated=1` draws only from what has no star yet - the same random run, but
// aimed at the part of the library that is still waiting to be judged.
router.get('/shuffle', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 500);
  const unrated = req.query.unrated === '1' || req.query.unrated === 'true';
  res.json({ ok: true, unrated, tracks: randomTracks(req.user.id, limit, { unrated }) });
});

// One query, eight lists. Episodes, books and plays stay apart from the songs:
// they are separate libraries to the listener, and 691 episodes would bury the songs.
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json({
    ok: true,
    q,
    ...searchLibrary({ userId: req.user.id, q, limit: 100 }),
    episodes: searchEpisodes({ userId: req.user.id, q, limit: 40 }),
    books: searchBooks({ userId: req.user.id, q, limit: 20, kind: BOOK }),
    dramas: searchBooks({ userId: req.user.id, q, limit: 20, kind: DRAMA }),
    ...searchVideos(q),
  });
});

// --- Ratings and history ----------------------------------------------------

router.put('/tracks/:id/rating', (req, res) => {
  const result = setRating(req.user.id, id(req.params.id), req.body.stars);
  if (result.error) return fail(res, result.error, 'track');
  res.json({ ok: true, stars: result.stars, counts: starCounts(req.user.id) });
});

// `playedAt` only comes with a play queued offline (see recordPlay); otherwise the
// play is stamped on arrival.
router.post('/plays', (req, res) => {
  const result = recordPlay(req.user.id, id(req.body.trackId), req.body.seconds, req.body.playedAt);
  if (result.error) return fail(res, result.error, 'track');
  res.json({ ok: true, playId: result.id });
});

// The player keeps this up to date while a track runs, so the statistics count
// the time actually listened instead of the length of the file.
router.put('/plays/:id', (req, res) => {
  updatePlaySeconds(req.user.id, id(req.params.id), req.body.seconds);
  res.json({ ok: true });
});

// One period at a time: `range` says how wide a period is, `period` which one.
// Both are optional - without them the current period of the default range
// comes back, which is what the page asks for on its first load.
router.get('/stats', (req, res) => {
  res.json({
    ok: true,
    library: libraryStats(),
    // The three spoken libraries, each answering its own head's question. They
    // are read here rather than folded into `libraryStats`, because that one
    // knows nothing but music and every other caller of it wants it that way.
    spoken: {
      podcasts: podcastStats(req.user.id),
      books: audiobookStats(req.user.id, BOOK),
      dramas: audiobookStats(req.user.id, DRAMA),
    },
    listening: listeningStats(req.user.id, {
      range: req.query.range,
      period: req.query.period,
    }),
  });
});

router.delete('/plays', (req, res) => {
  clearHistory(req.user.id);
  res.json({ ok: true });
});

// --- Playlists --------------------------------------------------------------

router.get('/playlists', (req, res) => {
  res.json({ ok: true, tree: playlistTree(req.user.id), playlists: listPlaylists(req.user.id) });
});

router.post('/playlists', (req, res) => {
  const folderId = id(req.body.folderId) || null;
  const result = req.body.dynamic
    ? createDynamicPlaylist(req.user.id, folderId)
    : createPlaylist(req.user.id, req.body.name, folderId);
  if (result.error) return fail(res, result.error, 'folder');
  res.json({ ok: true, playlist: result.playlist, tree: playlistTree(req.user.id) });
});

// The sidebar order of one container after a drag. Declared before the :id
// routes so "order" is never read as a playlist id.
router.put('/playlists/order', (req, res) => {
  const folderId = id(req.body.folderId) || null;
  const result = reorderPlaylists(req.user.id, folderId, req.body.ids || []);
  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

// `sort` and `dir` only order a dynamic list; an ordinary one keeps its own order.
router.get('/playlists/:id', (req, res) => {
  const playlist = getPlaylist(req.user.id, id(req.params.id));
  if (!playlist) return fail(res, 'not_found', 'playlist');
  const order = { sort: req.query.sort, dir: req.query.dir };
  res.json({ ok: true, playlist, tracks: playlistTracks(req.user.id, playlist.id, order) });
});

// --- Dynamic playlists --------------------------------------------------------

router.get('/dynamic-options', (req, res) => {
  res.json({ ok: true, ...filterOptions() });
});

router.put('/playlists/:id/rules', (req, res) => {
  const result = setRules(req.user.id, id(req.params.id), req.body.rules);
  if (result.error) return fail(res, result.error, 'playlist');
  const order = { sort: req.query.sort, dir: req.query.dir };
  res.json({
    ok: true,
    playlist: result.playlist,
    tracks: playlistTracks(req.user.id, result.playlist.id, order),
    tree: playlistTree(req.user.id),
  });
});

router.post('/playlists/:id/keep', (req, res) => {
  const result = keepPlaylist(req.user.id, id(req.params.id), req.body.name);
  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ok: true, playlist: result.playlist, tree: playlistTree(req.user.id) });
});

router.post('/playlists/:id/extend', (req, res) => {
  const result = extendPlaylist(req.user.id, id(req.params.id));
  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ok: true, playlist: result.playlist, tree: playlistTree(req.user.id) });
});

router.patch('/playlists/:id', (req, res) => {
  const patch = {};
  if ('name' in req.body) patch.name = req.body.name;
  if ('folderId' in req.body) patch.folderId = id(req.body.folderId) || null;
  if ('pinned' in req.body) patch.pinned = !!req.body.pinned;
  const result = updatePlaylist(req.user.id, id(req.params.id), patch);
  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ok: true, playlist: result.playlist, tree: playlistTree(req.user.id) });
});

router.delete('/playlists/:id', (req, res) => {
  const result = deletePlaylist(req.user.id, id(req.params.id));
  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

router.post('/playlists/:id/tracks', (req, res) => {
  const ids = Array.isArray(req.body.trackIds) ? req.body.trackIds : [req.body.trackId];
  const result = addTracks(req.user.id, id(req.params.id), ids);
  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ok: true, added: result.added, tree: playlistTree(req.user.id) });
});

router.delete('/playlists/:id/items/:itemId', (req, res) => {
  const result = removeItem(req.user.id, id(req.params.id), id(req.params.itemId));
  if (result.error) return fail(res, result.error, 'playlistItem');
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

router.put('/playlists/:id/order', (req, res) => {
  const result = reorderItems(req.user.id, id(req.params.id), req.body.itemIds || []);
  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ok: true });
});

// --- Playlist folders -------------------------------------------------------

router.post('/folders', (req, res) => {
  const result = createFolder(req.user.id, req.body.name);
  if (result.error) return fail(res, result.error);
  res.json({ ok: true, folder: result.folder, tree: playlistTree(req.user.id) });
});

router.patch('/folders/:id', (req, res) => {
  const result = renameFolder(req.user.id, id(req.params.id), req.body.name);
  if (result.error) return fail(res, result.error, 'folder');
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

router.delete('/folders/:id', (req, res) => {
  const result = deleteFolder(req.user.id, id(req.params.id));
  if (result.error) return fail(res, result.error, 'folder');
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

// --- CSV import -------------------------------------------------------------

// The client reads the file and posts its text, so there is no upload handling
// and nothing is written to disk.
router.post('/import/csv', (req, res) => {
  const parsed = readPlaylistCsv(req.body.text);
  if (parsed.error) return fail(res, parsed.error);
  if (!parsed.entries.length) return fail(res, 'empty');

  const source = String(req.body.name || 'CSV-Import').slice(0, 120);
  const fallbackName = source.replace(/\.csv$/i, '');
  const targetId = id(req.body.playlistId);

  const result = targetId
    ? importIntoPlaylist(req.user.id, targetId, parsed.entries, { source })
    : importEntries(req.user.id, parsed.entries, {
        fallbackName,
        folderId: id(req.body.folderId) || null,
        source,
      });

  if (result.error) return fail(res, result.error, 'playlist');
  res.json({ ...result, tree: playlistTree(req.user.id), issues: countIssues(req.user.id) });
});

// --- Import notices ---------------------------------------------------------

router.get('/import/issues', (req, res) => {
  res.json({ ok: true, issues: listIssues(req.user.id) });
});

router.post('/import/issues/recheck', (req, res) => {
  const resolved = resolveIssuesForUser(req.user.id);
  res.json({ ok: true, resolved, issues: listIssues(req.user.id) });
});

router.delete('/import/issues/:id', (req, res) => {
  const result = dismissIssue(req.user.id, id(req.params.id));
  if (result.error) return fail(res, result.error, 'notice');
  res.json({ ok: true, issues: countIssues(req.user.id) });
});

router.delete('/import/issues', (req, res) => {
  const result = clearIssues(req.user.id);
  res.json({ ok: true, removed: result.removed });
});

// --- Songs whose file is gone but which are still wanted ---------------------

router.get('/library/missing', (req, res) => {
  res.json({ ok: true, missing: listMissing(req.user.id) });
});

// Lets go of one of them. The answer says whether the row itself went with it,
// because it does not when the song was ever played - see models/missing.js.
router.delete('/library/missing/:id', (req, res) => {
  const result = dropMissing(req.user.id, id(req.params.id));
  if (result.error) return fail(res, result.error, 'notice');
  res.json({ ok: true, deleted: result.deleted, missing: listMissing(req.user.id) });
});

// --- Library scan -----------------------------------------------------------

router.get('/scan', (req, res) => {
  res.json({ ok: true, scan: scanState(), lastScan: getMeta('last_scan') });
});

// The response carries the same shape as GET, so the settings page can draw the
// progress bar from it right away instead of waiting for the first poll.
router.post('/scan', (req, res) => {
  if (isScanning()) {
    return res.json({ ok: true, scan: scanState(), lastScan: getMeta('last_scan'), alreadyRunning: true });
  }
  // Runs in the background; the client polls GET /api/scan for progress.
  runScan().catch((err) => console.error('Sonorus: scan failed:', err));
  res.json({ ok: true, scan: scanState(), lastScan: getMeta('last_scan') });
});

// --- Preferences ------------------------------------------------------------

// Player settings (volume, shuffle, repeat) live on the account, so they follow
// the user to another device.
router.put('/prefs', (req, res) => {
  const key = String(req.body.key || '');
  if (!key) return fail(res, 'invalid_name');
  setUserPref(req.user.id, key, req.body.value);
  res.json({ ok: true });
});

// --- Accounts ---------------------------------------------------------------

// Admin-only like creating and deleting: who else has an account is not shown to normal users.
router.get('/users', adminOnly, (req, res) => {
  res.json({ ok: true, users: listUsers() });
});

router.post('/users', adminOnly, (req, res) => {
  const result = createUser({
    username: req.body.username,
    password: req.body.password,
    display_name: req.body.displayName,
    is_admin: req.body.isAdmin ? 1 : 0,
  });
  if (result.error) return fail(res, result.error, 'user');
  res.json({ ok: true, users: listUsers() });
});

router.delete('/users/:id', adminOnly, (req, res) => {
  const result = deleteUser(id(req.params.id));
  if (result.error) return fail(res, result.error, 'user');
  res.json({ ok: true, users: listUsers(), self: id(req.params.id) === req.user.id });
});

router.put('/profile', (req, res) => {
  const newPassword = String(req.body.newPassword || '');
  if (newPassword) {
    if (!verifyPassword(getUserById(req.user.id), req.body.currentPassword)) {
      return fail(res, 'wrong_password');
    }
    const result = changePassword(req.user.id, newPassword);
    if (result.error) return fail(res, result.error, 'user');
    // A new password invalidates the old cookie signature - refresh it, so the
    // user is not logged out of the tab they are sitting in.
    setSessionCookie(res, req, getUserById(req.user.id));
  }
  updateProfile(req.user.id, { display_name: req.body.displayName, avatar: req.body.avatar });

  const user = getUserById(req.user.id);
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, isAdmin: !!user.is_admin },
  });
});

// --- Streaming --------------------------------------------------------------

// Content types the browser needs to pick a decoder. Range requests (seeking)
// are handled by res.sendFile.
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-monkeys-audio',
  '.wv': 'audio/x-wavpack',
  '.mpc': 'audio/x-musepack',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
};

// `?q=` picks the quality on the same route, so downloads and their resume logic need
// no second endpoint. `X-Sonorus-Quality` says what is really served, which is not
// always what was asked for (see `willTranscode`); `X-Sonorus-Format` names the container.
router.get('/stream/:id', async (req, res) => {
  const track = streamTrack(id(req.params.id));
  if (!track || !track.path) return fail(res, 'not_found', 'track');
  if (!fs.existsSync(track.path)) return fail(res, 'not_found', 'file');

  const profile = profileOf(req.query.q);
  let file = track.path;
  let quality = ORIGINAL;

  if (profile && isFfmpegReady()) {
    try {
      const cached = await ensureTranscode(track, profile);
      if (cached) {
        file = cached;
        quality = profile.name;
      }
    } catch (err) {
      // A failed encode is not a failed request: the original is still here and
      // playing the song at full size beats not playing it at all.
      console.warn(
        `Sonorus: falling back to the original of ${track.path}:`,
        err && err.message ? err.message : err
      );
    }
  }

  const extension = path.extname(file).toLowerCase();
  const mime = AUDIO_MIME[extension] || 'application/octet-stream';
  res.sendFile(
    file,
    {
      headers: {
        'Content-Type': mime,
        'X-Sonorus-Quality': quality,
        'X-Sonorus-Format': extension.replace('.', ''),
      },
      acceptRanges: true,
    },
    (err) => {
      // A browser that seeks or skips aborts the request - that is not an error.
      if (err && !res.headersSent) res.status(404).end();
    }
  );
});

// --- Quality ----------------------------------------------------------------

// What the clients need to draw their quality picker: the profiles this server
// can actually serve, and how much disk the cache is using. `ready` is false on
// an instance without ffmpeg, and then `original` is the only honest answer.
router.get('/quality', (req, res) => {
  res.json({
    ok: true,
    ready: isFfmpegReady(),
    profiles: Object.values(PROFILES).map((p) => ({
      name: p.name,
      label: p.label,
      codec: p.codec,
      bitrate: p.bitrate,
    })),
    cache: cacheStats(),
    batch: batchState(),
  });
});


// A path nothing above answers. JSON like every other answer here, so the client
// can say what it means: usually an app that is newer than its server.
router.use((req, res) => fail(res, 'no_route'));

export default router;
