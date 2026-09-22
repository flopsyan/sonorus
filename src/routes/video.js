// The API of the video side. Mounted inside the main API router, behind its login.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { userPrefs } from '../models/users.js';
import { isScanning } from '../lib/scanner.js';
import { refreshTitle } from '../lib/videometa.js';
import { tmdbEnabled } from '../lib/tmdb.js';
import db, { getMeta } from '../db.js';
import {
  planPlayback,
  pipeStream,
  directMime,
  externalCues,
  embeddedCues,
} from '../lib/videostream.js';
import { downloadVariant, prepare, preparedPath, release, touch } from '../lib/videodownload.js';
import {
  absolutePath,
  listMovies,
  listShows,
  videoGenres,
  continueWatching,
  listCollections,
  getMovie,
  getShow,
  getCollection,
  getPerson,
  videoRow,
  playerInfo,
  setVideoProgress,
  setWatched,
  videoIdsOf,
  recordVideoPlay,
  updateVideoPlaySeconds,
} from '../models/videos.js';

const router = express.Router();
const id = (value) => Number.parseInt(value, 10);

function notFound(res) {
  return res.status(404).json({ ok: false, error: 'not_found', message: 'Nicht gefunden.' });
}

// What the client decodes. A browser sends hevc/av1/vp9; the phone adds its
// device's codecs (see `videoPlayable` in videostream.js).
function readCaps(caps = {}) {
  const names = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 20) : []);
  return {
    hevc: !!caps.hevc,
    av1: !!caps.av1,
    vp9: !!caps.vp9,
    hevcMkv: !!caps.hevcMkv,
    tracks: !!caps.tracks,
    video: names(caps.video),
    audio: names(caps.audio),
  };
}

// The Übersicht tab: both lists, and what is running in either, newest first.
router.get('/video-home', (req, res) => {
  const cont = continueWatching(req.user.id);
  res.json({
    ok: true,
    movies: listMovies(req.user.id),
    shows: listShows(req.user.id),
    continue: [...cont.movies, ...cont.shows].sort((a, b) => String(b.at).localeCompare(String(a.at))),
    collections: listCollections(req.user.id),
    tmdb: tmdbEnabled(),
  });
});

router.get('/movies', (req, res) => {
  const cont = continueWatching(req.user.id);
  res.json({
    ok: true,
    movies: listMovies(req.user.id),
    continue: cont.movies,
    genres: videoGenres('movie'),
    collections: listCollections(req.user.id),
    tmdb: tmdbEnabled(),
  });
});

router.get('/movies/:id', (req, res) => {
  const movie = getMovie(id(req.params.id), req.user.id);
  if (!movie) return notFound(res);
  res.json({ ok: true, movie });
});

router.get('/shows', (req, res) => {
  const cont = continueWatching(req.user.id);
  res.json({
    ok: true,
    shows: listShows(req.user.id),
    continue: cont.shows,
    genres: videoGenres('show'),
    tmdb: tmdbEnabled(),
  });
});

router.get('/shows/:id', (req, res) => {
  const show = getShow(id(req.params.id), req.user.id);
  if (!show) return notFound(res);
  res.json({ ok: true, show });
});

router.get('/collections', (req, res) => {
  res.json({ ok: true, collections: listCollections(req.user.id) });
});

router.get('/collections/:id', (req, res) => {
  const collection = getCollection(id(req.params.id), req.user.id);
  if (!collection) return notFound(res);
  res.json({ ok: true, collection });
});

router.get('/people/:id', (req, res) => {
  const person = getPerson(id(req.params.id));
  if (!person) return notFound(res);
  res.json({ ok: true, person });
});

// --- Watched marks ----------------------------------------------------------------

// A whole film or series, or one season of it (`season` in the body).
router.put('/video-titles/:id/watched', (req, res) => {
  const titleId = id(req.params.id);
  const season = req.body.season === undefined || req.body.season === null ? null : id(req.body.season);
  const ids = videoIdsOf(titleId, season);
  if (!ids.length) return notFound(res);
  res.json(setWatched(req.user.id, ids, !!req.body.watched));
});

router.put('/videos/:id/watched', (req, res) => {
  const videoId = id(req.params.id);
  if (!videoRow(videoId)) return notFound(res);
  res.json(setWatched(req.user.id, [videoId], !!req.body.watched));
});

// Read again from TMDB, optionally under a different TMDB id picked by hand.
router.post('/video-titles/:id/refresh', async (req, res) => {
  const titleId = id(req.params.id);
  const row = db.prepare('SELECT id FROM video_titles WHERE id = ?').get(titleId);
  if (!row) return notFound(res);
  if (!tmdbEnabled()) {
    return res.status(400).json({ ok: false, error: 'no_tmdb', message: 'Kein TMDB_API_KEY gesetzt.' });
  }
  if (isScanning()) {
    return res.status(409).json({ ok: false, error: 'scanning', message: 'Ein Scan läuft gerade, bitte danach nochmal.' });
  }
  const tmdbId = req.body.tmdbId === undefined ? undefined : id(req.body.tmdbId);
  if (tmdbId !== undefined) {
    if (!(tmdbId > 0)) return res.status(400).json({ ok: false, error: 'bad_id', message: 'Bitte eine TMDB-ID angeben.' });
    db.prepare("UPDATE video_titles SET tmdb_id = ?, tmdb_locked = 1, meta_at = '' WHERE id = ?").run(tmdbId, titleId);
    db.prepare('DELETE FROM video_title_genres WHERE title_id = ?').run(titleId);
    db.prepare('DELETE FROM video_credits WHERE title_id = ?').run(titleId);
    db.prepare('UPDATE video_titles SET collection_id = NULL WHERE id = ?').run(titleId);
  }
  try {
    const ok = await refreshTitle(titleId, { force: true });
    res.json({ ok: true, matched: ok });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'tmdb', message: `TMDB: ${err.message}` });
  }
});

router.get('/video-meta', (req, res) => {
  res.json({ ok: true, tmdb: tmdbEnabled(), error: getMeta('tmdb_error') || '' });
});

// --- Playing ----------------------------------------------------------------------

router.get('/videos/:id', (req, res) => {
  const info = playerInfo(id(req.params.id), req.user.id);
  if (!info) return notFound(res);
  res.json({ ok: true, video: info });
});

// The player says where it wants to start, which audio track and which codecs
// the browser decodes; the answer is the URL to load and the clock offset.
router.post('/videos/:id/plan', async (req, res) => {
  const video = videoRow(id(req.params.id));
  if (!video) return notFound(res);
  const file = absolutePath(video, video.kind);
  if (!fs.existsSync(file)) return notFound(res);
  const prefs = userPrefs(req.user);
  const plan = await planPlayback(video, file, {
    audioIndex: req.body.audio === undefined || req.body.audio === null ? undefined : id(req.body.audio),
    langs: [prefs.videoAudioLang].filter(Boolean),
    start: Math.max(0, Math.min(Number(req.body.start) || 0, video.duration || Infinity)),
    caps: readCaps(req.body.caps),
    force: ['remux', 'encode'].includes(req.body.force) ? req.body.force : null,
  });
  res.json({ ok: true, plan });
});

router.get('/videos/:id/file', (req, res) => {
  const video = videoRow(id(req.params.id));
  if (!video) return notFound(res);
  const file = absolutePath(video, video.kind);
  res.sendFile(file, { headers: { 'Content-Type': directMime(file) }, acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

router.get('/videos/:id/stream', (req, res) => {
  const video = videoRow(id(req.params.id));
  if (!video) return notFound(res);
  const file = absolutePath(video, video.kind);
  if (!fs.existsSync(file)) return notFound(res);
  const audio = req.query.audio === undefined ? null : id(req.query.audio);
  pipeStream(req, res, video, file, {
    start: Math.max(0, Number(req.query.start) || 0),
    vc: req.query.vc === 'copy' ? 'copy' : 'h264',
    audio,
    ac: req.query.ac === 'copy' ? 'copy' : 'aac',
    userId: req.user.id,
  });
});

// --- Downloads (the phone) -----------------------------------------------------------

// What the phone gets for "original" or "small", and whether it is ready. The
// phone asks again until it is; asking is also what starts the preparation.
router.post('/videos/:id/download', (req, res) => {
  const video = videoRow(id(req.params.id));
  if (!video) return notFound(res);
  const file = absolutePath(video, video.kind);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return notFound(res);
  const prefs = userPrefs(req.user);
  const variant = downloadVariant(video, file, {
    quality: req.body.quality === 'small' ? 'small' : 'original',
    caps: readCaps(req.body.caps),
    langs: [prefs.videoAudioLang].filter(Boolean),
  });
  const audio = variant.audio ? variant.audio.index : null;
  if (variant.kind === 'file') {
    return res.json({
      ok: true, ready: true, kind: 'file', key: null, audio, size: stat.size,
      ext: path.extname(file).slice(1).toLowerCase(), url: `/api/videos/${video.id}/file`,
    });
  }
  const state = prepare(video, file, variant);
  res.json({
    ok: true, kind: variant.kind, audio, ext: 'mp4', ...state,
    url: state.ready ? `/api/videos/${video.id}/download/${state.key}` : null,
  });
});

const preparedKey = (req) => {
  const key = String(req.params.key);
  return /^[\w-]+$/.test(key) && key.startsWith(`${id(req.params.id)}-`) ? key : null;
};

router.get('/videos/:id/download/:key', (req, res) => {
  const key = preparedKey(req);
  if (!key) return notFound(res);
  touch(key);
  res.sendFile(preparedPath(key), { headers: { 'Content-Type': 'video/mp4' }, acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// The phone has it, or cancelled: the copy is not kept for anyone.
router.delete('/videos/:id/download/:key', (req, res) => {
  const key = preparedKey(req);
  if (!key) return notFound(res);
  release(key);
  res.json({ ok: true });
});

// Cues as JSON; 202 while an embedded track is still being read out of the file.
router.get('/videos/:id/subtitles/:key', async (req, res) => {
  const video = videoRow(id(req.params.id));
  if (!video) return notFound(res);
  const file = absolutePath(video, video.kind);
  const key = String(req.params.key);
  try {
    if (key.startsWith('x')) {
      const sub = JSON.parse(video.subtitles || '[]')[id(key.slice(1))];
      if (!sub) return notFound(res);
      return res.json({ ok: true, cues: await externalCues(file, sub) });
    }
    if (key.startsWith('s')) {
      const index = id(key.slice(1));
      const streams = JSON.parse(video.streams || '{}');
      const sub = (streams.subs || []).find((s) => s.index === index);
      if (!sub || !sub.text) return notFound(res);
      const cues = await embeddedCues(video, file, index);
      if (!cues) return res.status(202).json({ ok: true, pending: true });
      return res.json({ ok: true, cues });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'subtitle', message: `Untertitel: ${err.message}` });
  }
  return notFound(res);
});

router.put('/videos/:id/progress', (req, res) => {
  const result = setVideoProgress(req.user.id, id(req.params.id), req.body || {});
  if (result.error) return notFound(res);
  res.json(result);
});

router.post('/video-plays', (req, res) => {
  const result = recordVideoPlay(req.user.id, id(req.body.videoId));
  if (result.error) return notFound(res);
  res.json({ ok: true, playId: result.id });
});

router.put('/video-plays/:id', (req, res) => {
  res.json(updateVideoPlaySeconds(req.user.id, id(req.params.id), req.body.seconds));
});

export default router;
