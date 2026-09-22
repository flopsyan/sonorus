// Reading the video library for the pages and the player, and what one account
// does with it: positions, watched marks and time watched.

import path from 'node:path';

import db, { movieRoot, showRoot } from '../db.js';

const art = (name) => (name ? `/video-art/${name}` : null);
const json = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

// Specials sort last and never count towards "watched" or "next".
const EPISODE_ORDER = `v.season = 0, v.season, v.episode IS NULL, v.episode, v.name COLLATE NOCASE, v.path`;
// Under this many seconds a position is a click, not a start.
const RESUME_MIN = 30;

export function absolutePath(video, kind) {
  return path.join(kind === 'movie' ? movieRoot() : showRoot(), video.path);
}

function genresOf(titleId) {
  return db
    .prepare(
      `SELECT g.id, g.name FROM video_title_genres tg JOIN video_genres g ON g.id = tg.genre_id
        WHERE tg.title_id = ? ORDER BY g.name`
    )
    .all(titleId);
}

function progressShape(p, duration) {
  const position = p && !p.completed ? p.position || 0 : 0;
  return {
    position,
    completed: !!(p && p.completed),
    started: position >= RESUME_MIN,
    fraction: duration ? Math.min(1, position / duration) : 0,
  };
}

function titleShape(t) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    year: t.year,
    originalTitle: t.original_title && t.original_title !== t.title ? t.original_title : '',
    overview: t.overview,
    tagline: t.tagline,
    releaseDate: t.release_date,
    endDate: t.end_date,
    status: t.status,
    certification: t.certification,
    vote: t.vote,
    studios: json(t.studios, []),
    poster: art(t.poster),
    backdrop: art(t.backdrop),
    logo: art(t.logo),
    thumb: art(t.thumb),
    addedAt: t.added_at,
    tmdbId: t.tmdb_id,
    matched: !!t.tmdb_id,
  };
}

// --- Lists ----------------------------------------------------------------------

const TITLE_FIELDS = `t.*,
  (SELECT GROUP_CONCAT(genre_id) FROM video_title_genres WHERE title_id = t.id) AS genre_ids`;

/** Every film, with its one video's length and the account's position in it. */
export function listMovies(userId) {
  return db
    .prepare(
      `SELECT ${TITLE_FIELDS}, v.id AS video_id, v.duration, p.position, p.completed, p.updated_at AS watched_at
         FROM video_titles t
         JOIN videos v ON v.title_id = t.id
         LEFT JOIN video_progress p ON p.video_id = v.id AND p.user_id = @userId
        WHERE t.kind = 'movie'
        GROUP BY t.id
        ORDER BY t.title COLLATE NOCASE`
    )
    .all({ userId })
    .map((t) => ({
      ...titleShape(t),
      genreIds: t.genre_ids ? t.genre_ids.split(',').map(Number) : [],
      videoId: t.video_id,
      duration: t.duration,
      progress: progressShape(t, t.duration),
      watchedAt: t.watched_at,
    }));
}

/** Every series, with how much of it the account has seen. */
export function listShows(userId) {
  return db
    .prepare(
      `SELECT ${TITLE_FIELDS},
              COUNT(DISTINCT CASE WHEN v.season > 0 THEN v.season END) AS seasons,
              SUM(CASE WHEN v.season <> 0 THEN 1 ELSE 0 END) AS episodes,
              SUM(CASE WHEN v.season <> 0 AND p.completed = 1 THEN 1 ELSE 0 END) AS watched,
              MAX(v.added_at) AS newest,
              MAX(p.updated_at) AS watched_at
         FROM video_titles t
         JOIN videos v ON v.title_id = t.id
         LEFT JOIN video_progress p ON p.video_id = v.id AND p.user_id = @userId
        WHERE t.kind = 'show'
        GROUP BY t.id
        ORDER BY t.title COLLATE NOCASE`
    )
    .all({ userId })
    .map((t) => ({
      ...titleShape(t),
      genreIds: t.genre_ids ? t.genre_ids.split(',').map(Number) : [],
      seasons: t.seasons,
      episodes: t.episodes,
      watched: t.watched,
      newest: t.newest,
      watchedAt: t.watched_at,
    }));
}

export function videoGenres(kind) {
  return db
    .prepare(
      `SELECT g.id, g.name, COUNT(*) AS count
         FROM video_genres g
         JOIN video_title_genres tg ON tg.genre_id = g.id
         JOIN video_titles t ON t.id = tg.title_id AND t.kind = ?
        GROUP BY g.id ORDER BY g.name COLLATE NOCASE`
    )
    .all(kind);
}

// --- Episodes and what comes next -------------------------------------------------

function episodesOf(titleId, userId) {
  return db
    .prepare(
      `SELECT v.*, p.position, p.completed, p.updated_at AS progress_at
         FROM videos v
         LEFT JOIN video_progress p ON p.video_id = v.id AND p.user_id = ?
        WHERE v.title_id = ?
        ORDER BY ${EPISODE_ORDER}`
    )
    .all(userId, titleId);
}

function episodeShape(v) {
  return {
    id: v.id,
    season: v.season,
    episode: v.episode,
    episodeEnd: v.episode_end,
    name: v.name,
    overview: v.overview,
    airDate: v.air_date,
    still: art(v.still),
    duration: v.duration,
    height: v.height,
    progress: progressShape(v, v.duration),
  };
}

/**
 * The episode to put under "Weiterschauen": one that was started and not
 * finished, else the first unfinished one after the last finished one. Specials
 * only when the account is inside them already.
 */
function nextUp(episodes) {
  const started = episodes
    .filter((e) => !e.completed && (e.position || 0) >= RESUME_MIN)
    .sort((a, b) => String(b.progress_at).localeCompare(String(a.progress_at)))[0];
  if (started) return started;
  const regular = episodes.filter((e) => e.season !== 0);
  let lastDone = -1;
  let lastAt = '';
  regular.forEach((e, i) => {
    if (e.completed && String(e.progress_at) >= lastAt) {
      lastAt = String(e.progress_at);
      lastDone = i;
    }
  });
  if (lastDone < 0) return null;
  return regular.slice(lastDone + 1).find((e) => !e.completed) || null;
}

export function continueWatching(userId) {
  const movies = db
    .prepare(
      `SELECT t.*, v.id AS video_id, v.duration, p.position, p.completed, p.updated_at
         FROM video_progress p
         JOIN videos v ON v.id = p.video_id
         JOIN video_titles t ON t.id = v.title_id AND t.kind = 'movie'
        WHERE p.user_id = ? AND p.completed = 0 AND p.position >= ?
        ORDER BY p.updated_at DESC LIMIT 20`
    )
    .all(userId, RESUME_MIN)
    .map((t) => ({
      kind: 'movie',
      at: t.updated_at,
      title: titleShape(t),
      video: { id: t.video_id, duration: t.duration, progress: progressShape(t, t.duration) },
    }));

  const shows = db
    .prepare(
      `SELECT t.*, MAX(p.updated_at) AS at
         FROM video_progress p
         JOIN videos v ON v.id = p.video_id
         JOIN video_titles t ON t.id = v.title_id AND t.kind = 'show'
        WHERE p.user_id = ?
        GROUP BY t.id ORDER BY at DESC LIMIT 30`
    )
    .all(userId)
    .map((t) => {
      const next = nextUp(episodesOf(t.id, userId));
      return next ? { kind: 'show', at: t.at, title: titleShape(t), video: episodeShape(next) } : null;
    })
    .filter(Boolean);

  return { movies, shows };
}

// --- Detail pages -------------------------------------------------------------------

function creditsOf(titleId) {
  const rows = db
    .prepare(
      `SELECT c.role, c.character, c.ord, pe.id, pe.name, pe.photo
         FROM video_credits c JOIN video_people pe ON pe.id = c.person_id
        WHERE c.title_id = ? ORDER BY c.ord`
    )
    .all(titleId);
  const shape = (r) => ({ id: r.id, name: r.name, character: r.character, photo: art(r.photo), role: r.role });
  return {
    cast: rows.filter((r) => r.role === 'cast').map(shape),
    crew: rows.filter((r) => r.role !== 'cast').map(shape),
  };
}

// Titles that share the most genres with this one.
function similar(title, limit = 12) {
  return db
    .prepare(
      `SELECT t.*, COUNT(*) AS shared
         FROM video_title_genres a
         JOIN video_title_genres b ON b.genre_id = a.genre_id AND b.title_id <> a.title_id
         JOIN video_titles t ON t.id = b.title_id AND t.kind = ?
        WHERE a.title_id = ?
        GROUP BY t.id ORDER BY shared DESC, COALESCE(t.vote, 0) DESC LIMIT ?`
    )
    .all(title.kind, title.id, limit)
    .map((t) => titleShape(t));
}

function technical(v) {
  const s = json(v.streams, {});
  return {
    container: v.container,
    width: v.width,
    height: v.height,
    video: s.video ? s.video.codec : '',
    hdr: !!(s.video && s.video.hdr),
    audio: (s.audio || []).map((a) => ({ codec: a.codec, lang: a.lang, channels: a.channels, title: a.title })),
    subtitles: [
      ...json(v.subtitles, []).map((x) => ({ lang: x.lang, forced: x.forced, external: true })),
      ...(s.subs || []).map((x) => ({ lang: x.lang, forced: x.forced, text: x.text })),
    ],
  };
}

export function getMovie(id, userId) {
  const t = db.prepare("SELECT * FROM video_titles WHERE id = ? AND kind = 'movie'").get(id);
  if (!t) return null;
  const v = db.prepare('SELECT * FROM videos WHERE title_id = ? ORDER BY id LIMIT 1').get(t.id);
  const p = v && db.prepare('SELECT * FROM video_progress WHERE user_id = ? AND video_id = ?').get(userId, v.id);
  const collection = t.collection_id ? getCollection(t.collection_id, userId) : null;
  return {
    ...titleShape(t),
    genres: genresOf(t.id),
    ...creditsOf(t.id),
    video: v ? { id: v.id, duration: v.duration, progress: progressShape(p, v.duration), tech: technical(v) } : null,
    collection: collection && collection.movies.length > 1 ? collection : null,
    similar: similar(t),
  };
}

export function getShow(id, userId) {
  const t = db.prepare("SELECT * FROM video_titles WHERE id = ? AND kind = 'show'").get(id);
  if (!t) return null;
  const episodes = episodesOf(t.id, userId);
  const seasonRows = db.prepare('SELECT * FROM video_seasons WHERE title_id = ?').all(t.id);
  const bySeason = new Map();
  for (const e of episodes) {
    if (!bySeason.has(e.season)) bySeason.set(e.season, []);
    bySeason.get(e.season).push(episodeShape(e));
  }
  const seasons = [...bySeason.entries()]
    .sort(([a], [b]) => (a === 0) - (b === 0) || a - b)
    .map(([season, list]) => {
      const row = seasonRows.find((s) => s.season === season) || {};
      return {
        season,
        name: row.name || (season === 0 ? 'Specials' : `Staffel ${season}`),
        overview: row.overview || '',
        airDate: row.air_date || '',
        poster: art(row.poster),
        episodes: list,
        watched: list.filter((e) => e.progress.completed).length,
      };
    });
  const next = nextUp(episodes) || episodes.find((e) => e.season !== 0) || episodes[0];
  const regular = episodes.filter((e) => e.season !== 0);
  return {
    ...titleShape(t),
    genres: genresOf(t.id),
    ...creditsOf(t.id),
    seasons,
    episodes: regular.length,
    watched: regular.filter((e) => e.completed).length,
    next: next ? episodeShape(next) : null,
    similar: similar(t),
  };
}

export function listCollections(userId) {
  return db
    .prepare(
      `SELECT c.*, COUNT(t.id) AS movies,
              SUM(CASE WHEN p.completed = 1 THEN 1 ELSE 0 END) AS watched
         FROM video_collections c
         JOIN video_titles t ON t.collection_id = c.id
         JOIN videos v ON v.title_id = t.id
         LEFT JOIN video_progress p ON p.video_id = v.id AND p.user_id = ?
        GROUP BY c.id HAVING COUNT(t.id) > 1
        ORDER BY c.name COLLATE NOCASE`
    )
    .all(userId)
    .map((c) => ({
      id: c.id, name: c.name, overview: c.overview, poster: art(c.poster), backdrop: art(c.backdrop),
      movies: c.movies, watched: c.watched,
    }));
}

export function getCollection(id, userId) {
  const c = db.prepare('SELECT * FROM video_collections WHERE id = ?').get(id);
  if (!c) return null;
  const members = new Set(
    db.prepare('SELECT id FROM video_titles WHERE collection_id = ?').all(c.id).map((r) => r.id)
  );
  const movies = listMovies(userId)
    .filter((m) => members.has(m.id))
    .sort((a, b) => String(a.releaseDate || a.year).localeCompare(String(b.releaseDate || b.year)));
  return { id: c.id, name: c.name, overview: c.overview, poster: art(c.poster), backdrop: art(c.backdrop), movies };
}

const ROLE_WORDS = { director: 'Regie', writer: 'Drehbuch', creator: 'Idee', composer: 'Musik' };

export function getPerson(id) {
  const person = db.prepare('SELECT * FROM video_people WHERE id = ?').get(id);
  if (!person) return null;
  const rows = db
    .prepare(
      `SELECT t.*, c.role, c.character FROM video_credits c JOIN video_titles t ON t.id = c.title_id
        WHERE c.person_id = ? ORDER BY COALESCE(NULLIF(t.release_date, ''), t.year) DESC`
    )
    .all(id);
  const byTitle = new Map();
  for (const r of rows) {
    const entry = byTitle.get(r.id) || { ...titleShape(r), roles: [] };
    entry.roles.push(r.role === 'cast' ? r.character || 'Darsteller' : ROLE_WORDS[r.role] || r.role);
    byTitle.set(r.id, entry);
  }
  const titles = [...byTitle.values()];
  return {
    id: person.id,
    name: person.name,
    photo: art(person.photo),
    tmdbId: person.tmdb_id,
    movies: titles.filter((t) => t.kind === 'movie'),
    shows: titles.filter((t) => t.kind === 'show'),
  };
}

// --- The player -------------------------------------------------------------------

export function videoRow(id) {
  const v = db
    .prepare('SELECT v.*, t.kind, t.title AS show_title FROM videos v JOIN video_titles t ON t.id = v.title_id WHERE v.id = ?')
    .get(id);
  return v || null;
}

/** Everything the player needs to start one video and to know what follows. */
export function playerInfo(id, userId) {
  const v = videoRow(id);
  if (!v) return null;
  const t = db.prepare('SELECT * FROM video_titles WHERE id = ?').get(v.title_id);
  const p = db.prepare('SELECT * FROM video_progress WHERE user_id = ? AND video_id = ?').get(userId, v.id);
  const streams = json(v.streams, {});
  let next = null;
  let prev = null;
  if (t.kind === 'show') {
    const list = episodesOf(t.id, userId).filter((e) => (v.season === 0) === (e.season === 0));
    const at = list.findIndex((e) => e.id === v.id);
    if (at >= 0 && at + 1 < list.length) next = episodeShape(list[at + 1]);
    if (at > 0) prev = episodeShape(list[at - 1]);
  }
  return {
    id: v.id,
    kind: t.kind,
    title: titleShape(t),
    season: v.season,
    episode: v.episode,
    episodeEnd: v.episode_end,
    name: v.name,
    still: art(v.still),
    duration: v.duration,
    progress: progressShape(p, v.duration),
    audio: (streams.audio || []).map((a) => ({
      index: a.index, codec: a.codec, lang: a.lang, title: a.title, channels: a.channels, default: a.default,
    })),
    subtitles: [
      ...json(v.subtitles, []).map((s, i) => ({
        key: `x${i}`, lang: s.lang, title: '', forced: s.forced, sdh: s.sdh, supported: true, external: true,
      })),
      ...(streams.subs || []).map((s) => ({
        key: `s${s.index}`, lang: s.lang, title: s.title, forced: s.forced, sdh: false, supported: s.text, external: false,
      })),
    ],
    next,
    prev,
  };
}

// --- What one account does ---------------------------------------------------------

const writeProgress = db.prepare(`
  INSERT INTO video_progress (user_id, video_id, position, completed, updated_at)
  VALUES (@userId, @videoId, @position, @completed, datetime('now'))
  ON CONFLICT(user_id, video_id) DO UPDATE SET
    position = excluded.position, completed = excluded.completed, updated_at = excluded.updated_at
`);

/** A finished video keeps no position, so it never shows up under "Weiterschauen". */
export function setVideoProgress(userId, videoId, { position, completed } = {}) {
  if (!videoRow(videoId)) return { error: 'not_found' };
  const done = !!completed;
  const at = done ? 0 : Math.max(0, Number(position) || 0);
  writeProgress.run({ userId, videoId, position: at, completed: done ? 1 : 0 });
  return { ok: true, position: at, completed: done };
}

/** Marks a list of videos as seen or unseen in one go (a season, a whole series). */
export const setWatched = db.transaction((userId, videoIds, watched) => {
  for (const videoId of videoIds) {
    if (watched) writeProgress.run({ userId, videoId, position: 0, completed: 1 });
    else db.prepare('DELETE FROM video_progress WHERE user_id = ? AND video_id = ?').run(userId, videoId);
  }
  return { ok: true, count: videoIds.length };
});

export function videoIdsOf(titleId, season = null) {
  const rows =
    season === null
      ? db.prepare('SELECT id FROM videos WHERE title_id = ?').all(titleId)
      : db.prepare('SELECT id FROM videos WHERE title_id = ? AND season = ?').all(titleId, season);
  return rows.map((r) => r.id);
}

export function recordVideoPlay(userId, videoId) {
  if (!videoRow(videoId)) return { error: 'not_found' };
  const info = db.prepare('INSERT INTO video_plays (user_id, video_id) VALUES (?, ?)').run(userId, videoId);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

// Only ever upwards and never beyond a day, like the audio plays.
export function updateVideoPlaySeconds(userId, playId, seconds) {
  const value = Math.max(0, Math.min(24 * 3600, Math.round(Number(seconds) || 0)));
  db.prepare('UPDATE video_plays SET seconds = ? WHERE id = ? AND user_id = ? AND seconds < ?').run(
    value, playId, userId, value
  );
  return { ok: true };
}

// --- Search and counts ---------------------------------------------------------------

export function searchVideos(q, limit = 24) {
  const words = String(q || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { movies: [], shows: [] };
  const where = words.map((_, i) => `(t.title LIKE @w${i} OR t.original_title LIKE @w${i})`).join(' AND ');
  const params = Object.fromEntries(words.map((w, i) => [`w${i}`, `%${w.replace(/[%_]/g, '')}%`]));
  const rows = db
    .prepare(`SELECT t.* FROM video_titles t WHERE ${where} ORDER BY t.title COLLATE NOCASE LIMIT @limit`)
    .all({ ...params, limit })
    .map((t) => titleShape(t));
  return { movies: rows.filter((t) => t.kind === 'movie'), shows: rows.filter((t) => t.kind === 'show') };
}

export function videoLibraryStats() {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM video_titles WHERE kind = 'movie') AS movies,
         (SELECT COUNT(*) FROM video_titles WHERE kind = 'show') AS shows,
         (SELECT COUNT(*) FROM videos v JOIN video_titles t ON t.id = v.title_id WHERE t.kind = 'show') AS episodes,
         (SELECT COALESCE(SUM(duration), 0) FROM videos) AS duration`
    )
    .get();
  return row;
}
