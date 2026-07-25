import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { getMeta } from '../db.js';
import { requireAuthApi, setSessionCookie } from '../lib/auth.js';
import { runScan, scanState, isScanning } from '../lib/scanner.js';
import { readPlaylistCsv } from '../lib/csv.js';
import {
  listTracks,
  countTracks,
  getTrack,
  trackPath,
  tracksByIds,
  listArtists,
  getArtist,
  listAlbums,
  getAlbum,
  listGenres,
  getGenre,
  tracksByStarSelection,
  starCounts,
  recentlyAdded,
  recentlyPlayed,
  mostPlayed,
  newestAlbums,
  randomTracks,
  libraryStats,
} from '../models/library.js';
import {
  playlistTree,
  listPlaylists,
  getPlaylist,
  createPlaylist,
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
import { setRating, recordPlay, updatePlaySeconds, clearHistory, historyCount } from '../models/ratings.js';
import { listeningStats } from '../models/stats.js';
import { updateAlbum, updateSingle, updateArtistCover } from '../models/edits.js';
import {
  listIssues,
  countIssues,
  dismissIssue,
  clearIssues,
  resolveIssuesForUser,
} from '../models/issues.js';
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

// German messages for the error codes the models return.
const ERRORS = {
  invalid_username: 'Ungültiger Benutzername (2-32 Zeichen: Buchstaben, Zahlen, . _ -).',
  weak_password: 'Passwort zu kurz (mindestens 4 Zeichen).',
  taken: 'Benutzername ist bereits vergeben.',
  last_user: 'Der letzte Account kann nicht gelöscht werden.',
  last_admin: 'Der letzte Admin kann nicht gelöscht werden.',
  invalid_name: 'Bitte einen Namen angeben.',
  invalid_stars: 'Bewertung muss zwischen 0 und 5 liegen.',
  invalid_date: 'Bitte ein Datum wie 17.05.2013, 05.2013 oder 2013 angeben.',
  not_a_single: 'Nur Singles lassen sich einzeln bearbeiten. Songs eines Albums bekommen Datum und Cover vom Album.',
  nothing_to_edit: 'Es gibt nichts zu ändern.',
  bad_image: 'Das Bild konnte nicht gelesen werden. Erlaubt sind JPG, PNG und WebP.',
  image_too_big: 'Das Bild ist zu groß (maximal 6 MB).',
  not_found: 'Nicht gefunden.',
  empty: 'Die Datei enthält keine Zeilen.',
  no_title_column: 'Der CSV-Datei fehlt eine Spalte mit dem Songtitel.',
};

function fail(res, code, status = 400) {
  return res.status(status).json({ ok: false, error: code, message: ERRORS[code] || 'Fehler.' });
}

function adminOnly(req, res, next) {
  if (!req.user.is_admin) return fail(res, 'admin_only', 403);
  return next();
}

const id = (value) => Number.parseInt(value, 10);

// --- Bootstrap --------------------------------------------------------------

// Everything the client needs to draw the shell on first load: the sidebar
// tree, the counts next to the star playlists, the notice badge and the saved
// player preferences.
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
    prefs: userPrefs(req.user),
    scan: scanState(),
    lastScan: getMeta('last_scan'),
  });
});

// --- Library ----------------------------------------------------------------

router.get('/tracks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 0, 5000);
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
  if (!track) return fail(res, 'not_found', 404);
  res.json({ ok: true, track });
});

// A track can be edited where it has nobody to take the value from: release
// date and cover art of a single. Everything else comes from the folder
// structure or from the album.
router.patch('/tracks/:id', async (req, res) => {
  const patch = {};
  if ('date' in req.body) patch.date = req.body.date;
  if ('cover' in req.body) patch.cover = req.body.cover;
  if (!Object.keys(patch).length) return fail(res, 'nothing_to_edit');

  const result = await updateSingle(id(req.params.id), patch);
  if (result.error) return fail(res, result.error, result.error === 'not_found' ? 404 : 400);
  res.json({ ok: true, track: getTrack(id(req.params.id), req.user.id) });
});

router.get('/artists', (req, res) => {
  res.json({ ok: true, artists: listArtists({ q: req.query.q }) });
});

router.get('/artists/:id', (req, res) => {
  const artist = getArtist(id(req.params.id), req.user.id);
  if (!artist) return fail(res, 'not_found', 404);
  res.json({ ok: true, artist });
});

// The profile picture, and nothing else: the name of an artist is the name of
// the folder, so the next scan would read it back anyway.
router.patch('/artists/:id', async (req, res) => {
  if (!('cover' in req.body)) return fail(res, 'nothing_to_edit');

  const result = await updateArtistCover(id(req.params.id), req.body.cover);
  if (result.error) return fail(res, result.error, result.error === 'not_found' ? 404 : 400);
  res.json({ ok: true, artist: getArtist(id(req.params.id), req.user.id) });
});

router.get('/albums', (req, res) => {
  res.json({
    ok: true,
    albums: listAlbums({ q: req.query.q, sort: req.query.sort, dir: req.query.dir }),
  });
});

router.get('/albums/:id', (req, res) => {
  const album = getAlbum(id(req.params.id), req.user.id);
  if (!album) return fail(res, 'not_found', 404);
  res.json({ ok: true, album });
});

// Hand edits to what the file cannot be asked about: release date, genres,
// cover. The music folder is read-only, so this only changes what Sonorus
// shows. Like the scan and the CSV import, this touches the shared library and
// needs a login, not an admin - see the account model in the README.
router.patch('/albums/:id', async (req, res) => {
  const patch = {};
  if ('date' in req.body) patch.date = req.body.date;
  if ('genres' in req.body) patch.genres = req.body.genres;
  if ('cover' in req.body) patch.cover = req.body.cover;

  const result = await updateAlbum(id(req.params.id), patch);
  if (result.error) return fail(res, result.error, result.error === 'not_found' ? 404 : 400);
  res.json({ ok: true, album: getAlbum(id(req.params.id), req.user.id) });
});

router.get('/genres', (req, res) => {
  res.json({ ok: true, genres: listGenres() });
});

router.get('/genres/:id', (req, res) => {
  const genre = getGenre(id(req.params.id), req.user.id);
  if (!genre) return fail(res, 'not_found', 404);
  res.json({ ok: true, genre });
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
    newestAlbums: newestAlbums(12),
    recentlyAdded: recentlyAdded(req.user.id, 12),
    recentlyPlayed: recentlyPlayed(req.user.id, 12),
    mostPlayed: mostPlayed(req.user.id, 12),
  });
});

router.get('/shuffle', (req, res) => {
  res.json({ ok: true, tracks: randomTracks(req.user.id, Math.min(Number(req.query.limit) || 60, 500)) });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, q, tracks: [], artists: [], albums: [] });
  res.json({
    ok: true,
    q,
    tracks: listTracks({ userId: req.user.id, q, limit: 100 }),
    artists: listArtists({ q }),
    albums: listAlbums({ q }),
  });
});

// --- Ratings and history ----------------------------------------------------

router.put('/tracks/:id/rating', (req, res) => {
  const result = setRating(req.user.id, id(req.params.id), req.body.stars);
  if (result.error) return fail(res, result.error, result.error === 'not_found' ? 404 : 400);
  res.json({ ok: true, stars: result.stars, counts: starCounts(req.user.id) });
});

router.post('/plays', (req, res) => {
  const result = recordPlay(req.user.id, id(req.body.trackId), req.body.seconds);
  if (result.error) return fail(res, result.error, 404);
  res.json({ ok: true, playId: result.id });
});

// The player keeps this up to date while a track runs, so the statistics count
// the time actually listened instead of the length of the file.
router.put('/plays/:id', (req, res) => {
  updatePlaySeconds(req.user.id, id(req.params.id), req.body.seconds);
  res.json({ ok: true });
});

router.get('/stats', (req, res) => {
  res.json({
    ok: true,
    library: libraryStats(),
    listening: listeningStats(req.user.id, req.query.offset),
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
  const result = createPlaylist(req.user.id, req.body.name, id(req.body.folderId) || null);
  if (result.error) return fail(res, result.error);
  res.json({ ok: true, playlist: result.playlist, tree: playlistTree(req.user.id) });
});

// The sidebar order of one container after a drag. Declared before the :id
// routes so "order" is never read as a playlist id.
router.put('/playlists/order', (req, res) => {
  const folderId = id(req.body.folderId) || null;
  const result = reorderPlaylists(req.user.id, folderId, req.body.ids || []);
  if (result.error) return fail(res, result.error, 404);
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

router.get('/playlists/:id', (req, res) => {
  const playlist = getPlaylist(req.user.id, id(req.params.id));
  if (!playlist) return fail(res, 'not_found', 404);
  res.json({ ok: true, playlist, tracks: playlistTracks(req.user.id, playlist.id) });
});

router.patch('/playlists/:id', (req, res) => {
  const patch = {};
  if ('name' in req.body) patch.name = req.body.name;
  if ('folderId' in req.body) patch.folderId = id(req.body.folderId) || null;
  if ('pinned' in req.body) patch.pinned = !!req.body.pinned;
  const result = updatePlaylist(req.user.id, id(req.params.id), patch);
  if (result.error) return fail(res, result.error, 404);
  res.json({ ok: true, playlist: result.playlist, tree: playlistTree(req.user.id) });
});

router.delete('/playlists/:id', (req, res) => {
  const result = deletePlaylist(req.user.id, id(req.params.id));
  if (result.error) return fail(res, result.error, 404);
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

router.post('/playlists/:id/tracks', (req, res) => {
  const ids = Array.isArray(req.body.trackIds) ? req.body.trackIds : [req.body.trackId];
  const result = addTracks(req.user.id, id(req.params.id), ids);
  if (result.error) return fail(res, result.error, 404);
  res.json({ ok: true, added: result.added, tree: playlistTree(req.user.id) });
});

router.delete('/playlists/:id/items/:itemId', (req, res) => {
  const result = removeItem(req.user.id, id(req.params.id), id(req.params.itemId));
  if (result.error) return fail(res, result.error, 404);
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

router.put('/playlists/:id/order', (req, res) => {
  const result = reorderItems(req.user.id, id(req.params.id), req.body.itemIds || []);
  if (result.error) return fail(res, result.error, 404);
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
  if (result.error) return fail(res, result.error, result.error === 'not_found' ? 404 : 400);
  res.json({ ok: true, tree: playlistTree(req.user.id) });
});

router.delete('/folders/:id', (req, res) => {
  const result = deleteFolder(req.user.id, id(req.params.id));
  if (result.error) return fail(res, result.error, 404);
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

  if (result.error) return fail(res, result.error, 404);
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
  if (result.error) return fail(res, result.error, 404);
  res.json({ ok: true, issues: countIssues(req.user.id) });
});

router.delete('/import/issues', (req, res) => {
  const result = clearIssues(req.user.id);
  res.json({ ok: true, removed: result.removed });
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

router.get('/users', (req, res) => {
  res.json({ ok: true, users: listUsers(), historyCount: historyCount(req.user.id) });
});

router.post('/users', adminOnly, (req, res) => {
  const result = createUser({
    username: req.body.username,
    password: req.body.password,
    display_name: req.body.displayName,
    is_admin: req.body.isAdmin ? 1 : 0,
  });
  if (result.error) return fail(res, result.error);
  res.json({ ok: true, users: listUsers() });
});

router.delete('/users/:id', adminOnly, (req, res) => {
  const result = deleteUser(id(req.params.id));
  if (result.error) return fail(res, result.error);
  res.json({ ok: true, users: listUsers(), self: id(req.params.id) === req.user.id });
});

router.put('/profile', (req, res) => {
  updateProfile(req.user.id, { display_name: req.body.displayName, avatar: req.body.avatar });

  const newPassword = String(req.body.newPassword || '');
  if (newPassword) {
    if (!verifyPassword(getUserById(req.user.id), req.body.currentPassword)) {
      return fail(res, 'wrong_password');
    }
    const result = changePassword(req.user.id, newPassword);
    if (result.error) return fail(res, result.error);
    // A new password invalidates the old cookie signature - refresh it, so the
    // user is not logged out of the tab they are sitting in.
    setSessionCookie(res, req, getUserById(req.user.id));
  }

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

router.get('/stream/:id', (req, res) => {
  const file = trackPath(id(req.params.id));
  if (!file || !fs.existsSync(file)) return fail(res, 'not_found', 404);
  const mime = AUDIO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.sendFile(file, { headers: { 'Content-Type': mime }, acceptRanges: true }, (err) => {
    // A browser that seeks or skips aborts the request - that is not an error.
    if (err && !res.headersSent) res.status(404).end();
  });
});

export default router;
