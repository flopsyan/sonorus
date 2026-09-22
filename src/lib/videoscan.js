// Films and series: walks VIDEO_DIR/movies and VIDEO_DIR/shows and writes what
// it finds into the video tables. The layout is the one Jellyfin and Kodi use:
//
//   videos/movies/<Titel (Jahr)>/<Titel (Jahr)>.mkv
//   videos/shows/<Serie (Jahr)>/Season 01/01 - Titel.mkv     (also S01E01, 1x01)
//   videos/shows/<Serie (Jahr)>/Specials/...                  season 0
//
// Artwork lying next to the files (folder.jpg, backdrop.jpg, logo.png,
// season01-poster.jpg, <Folge>-thumb.jpg) wins over anything TMDB offers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import db, { movieRoot, showRoot, videoArtDir, getMeta, setMeta } from '../db.js';
import { probeVideo, resizeImage } from './media.js';

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.avi', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv']);
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);

// Bumped when a file is read differently, which re-probes everything once.
const VIDEO_SCANNER_VERSION = 'video-1';

// Folders Jellyfin reserves for bonus material. Never a season, never the film.
const EXTRAS_DIR = /^(extras?|featurettes?|behind the scenes|deleted scenes|interviews?|scenes|shorts|trailers?|samples?|other|clips|bonus)$/i;
const SAMPLE_FILE = /(^|[\s._-])(sample|trailer)([\s._-]|$)/i;

export const ART_WIDTH = { poster: 500, backdrop: 1280, logo: 600, thumb: 640, still: 480, season: 400 };

// --- Names --------------------------------------------------------------------

/** "Fight Club (1999) [tmdbid-550]" -> { title, year, tmdbId }. */
export function parseTitleFolder(name) {
  let rest = String(name).trim();
  let tmdbId = null;
  rest = rest.replace(/\s*[[{](?:tmdbid|tmdb)[-=](\d+)[\]}]\s*/i, (_, n) => {
    tmdbId = Number(n);
    return ' ';
  });
  rest = rest.replace(/\s*[[{](?:imdbid|tvdbid|imdb|tvdb)[-=][^\]}]+[\]}]\s*/gi, ' ').trim();
  let year = null;
  const m = rest.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (m) {
    rest = m[1].trim();
    year = Number(m[2]);
  }
  return { title: rest || String(name).trim(), year, tmdbId };
}

/** The season a folder stands for, null for a folder that is none. */
export function seasonOfDir(name) {
  const n = String(name).trim();
  if (/^(specials?|season\s*0+|staffel\s*0+)$/i.test(n)) return 0;
  const m = n.match(/^(?:season|staffel|series|serie|s)\s*[-_.]?\s*(\d{1,3})$/i);
  return m ? Number(m[1]) : null;
}

/** Episode number and name from a file name without its extension. */
export function parseEpisode(base) {
  const clean = (s) => String(s || '').replace(/^[\s._-]+|[\s._-]+$/g, '').replace(/[._]+/g, ' ').trim();
  let m = base.match(/[Ss](\d{1,3})[\s._-]?[Ee](\d{1,3})(?:[\s._-]?-?[Ee](\d{1,3}))?(.*)$/);
  if (m) {
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      episodeEnd: m[3] ? Number(m[3]) : null,
      name: clean(m[4]),
    };
  }
  m = base.match(/(?:^|[\s._-])(\d{1,2})x(\d{2,3})(.*)$/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), episodeEnd: null, name: clean(m[3]) };
  // "2021-01 - South Park Post COVID": a date, not an episode number.
  m = base.match(/^\d{4}-\d{2}(?:-\d{2})?\s*-\s*(.+)$/);
  if (m) return { season: null, episode: null, episodeEnd: null, name: clean(m[1]) };
  m = base.match(/^[Ee]?(\d{1,3})(?:\s*-\s*[Ee]?(\d{1,3})(?=\s*[-._]))?\s*[-._ ]\s*(.*)$/);
  if (m) {
    return {
      season: null,
      episode: Number(m[1]),
      episodeEnd: m[2] ? Number(m[2]) : null,
      name: clean(m[3]),
    };
  }
  if (/^\d{1,3}$/.test(base)) return { season: null, episode: Number(base), episodeEnd: null, name: '' };
  return { season: null, episode: null, episodeEnd: null, name: clean(base) };
}

// "01 - Pilot.en.forced.srt" next to "01 - Pilot.mkv".
function parseSubtitleFile(file, videoBase) {
  const ext = path.extname(file).toLowerCase();
  const stem = path.basename(file, path.extname(file));
  if (!stem.startsWith(videoBase)) return null;
  const tags = stem.slice(videoBase.length).split('.').filter(Boolean).map((t) => t.toLowerCase());
  if (stem.length > videoBase.length && stem[videoBase.length] !== '.') return null;
  const forced = tags.includes('forced');
  const sdh = tags.includes('sdh') || tags.includes('cc') || tags.includes('hi');
  const langTag = tags.find((t) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(t) && !['sdh', 'cc', 'hi'].includes(t));
  return { file, format: ext.slice(1), lang: langTag || '', forced, sdh };
}

// --- Walking ------------------------------------------------------------------

async function readDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isDir(full, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fsp.stat(full)).isDirectory();
  } catch {
    return false;
  }
}

const isVideo = (name) => VIDEO_EXT.has(path.extname(name).toLowerCase()) && !SAMPLE_FILE.test(path.basename(name, path.extname(name)));

// Every video file under `dir`, extras folders left out.
async function videosUnder(dir, depth = 0) {
  const out = [];
  for (const entry of await readDir(dir)) {
    if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
    const full = path.join(dir, entry.name);
    if (await isDir(full, entry)) {
      if (depth < 3 && !EXTRAS_DIR.test(entry.name)) out.push(...(await videosUnder(full, depth + 1)));
    } else if (isVideo(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * What lies on disk: one entry per film and per series, with the video files
 * that belong to it. Read before anything is written, so the scan can count.
 */
export async function collectVideoWork() {
  const movieDir = movieRoot();
  const showDir = showRoot();
  const work = { movies: [], shows: [], files: 0, roots: {}, dirs: { movie: movieDir, show: showDir } };

  work.roots.movie = fs.existsSync(movieDir);
  for (const entry of work.roots.movie ? await readDir(movieDir) : []) {
    if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
    const full = path.join(movieDir, entry.name);
    if (await isDir(full, entry)) {
      const files = await videosUnder(full);
      if (!files.length) continue;
      // Several files in one film folder are versions or parts; the largest is the film.
      const sized = await Promise.all(files.map(async (f) => ({ f, size: (await fsp.stat(f)).size })));
      sized.sort((a, b) => b.size - a.size);
      work.movies.push({ folder: entry.name, dir: full, files: [sized[0].f] });
    } else if (isVideo(entry.name)) {
      work.movies.push({ folder: entry.name, dir: movieDir, files: [full], loose: true });
    }
  }

  work.roots.show = fs.existsSync(showDir);
  for (const entry of work.roots.show ? await readDir(showDir) : []) {
    if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
    const full = path.join(showDir, entry.name);
    if (!(await isDir(full, entry))) continue;
    const files = await videosUnder(full);
    if (files.length) work.shows.push({ folder: entry.name, dir: full, files });
  }

  work.files =
    work.movies.reduce((n, m) => n + m.files.length, 0) +
    work.shows.reduce((n, s) => n + s.files.length, 0);
  return work;
}

// --- Artwork ------------------------------------------------------------------

// The first file in `dir` whose name (without extension) matches.
async function findImage(dir, names, exts = IMAGE_EXT) {
  const entries = await readDir(dir);
  const byName = new Map(entries.filter((e) => !e.isDirectory()).map((e) => [e.name.toLowerCase(), e.name]));
  for (const n of names) {
    for (const ext of exts) {
      const hit = byName.get(`${n.toLowerCase()}${ext}`);
      if (hit) return path.join(dir, hit);
    }
  }
  return null;
}

/**
 * A resized copy of a local image, named after the source's path, size and
 * mtime: an unchanged file is never converted twice, a replaced one gets a new
 * name and the stale copy is swept after the scan.
 */
export async function localArt(source, width) {
  if (!source) return '';
  try {
    const st = await fsp.stat(source);
    const lower = source.toLowerCase();
    // PNG and WebP are the ones that carry transparency - a logo - and they keep
    // it; everything else is a photograph and becomes a JPEG.
    const alpha = lower.endsWith('.png') || lower.endsWith('.webp');
    const ext = lower.endsWith('.svg') ? '.svg' : alpha ? '.png' : '.jpg';
    // `a2` renames every transparent copy once, so the flattened ones made
    // before the fix are replaced rather than kept under the same name.
    const key = crypto
      .createHash('sha1')
      .update(`${source}:${st.size}:${st.mtimeMs}:${width}${alpha ? ':a2' : ''}`)
      .digest('hex')
      .slice(0, 20);
    const name = `l-${key}${ext}`;
    await resizeImage(source, path.join(videoArtDir, name), width);
    return name;
  } catch (err) {
    console.warn(`Sonorus: could not convert ${source}:`, err && err.message ? err.message : err);
    return '';
  }
}

async function titleArt(dir, base) {
  const extra = base ? [base] : [];
  const [poster, backdrop, logo, thumb] = await Promise.all([
    findImage(dir, ['folder', 'poster', 'cover', 'movie', 'show', ...extra.map((b) => `${b}-poster`)]),
    findImage(dir, ['backdrop', 'fanart', 'background', 'backdrop1', ...extra.map((b) => `${b}-fanart`)]),
    findImage(dir, ['logo', 'clearlogo', ...extra.map((b) => `${b}-logo`)], ['.png', '.svg', '.webp']),
    findImage(dir, ['landscape', 'thumb', ...extra.map((b) => `${b}-landscape`)]),
  ]);
  return {
    poster: await localArt(poster, ART_WIDTH.poster),
    backdrop: await localArt(backdrop, ART_WIDTH.backdrop),
    logo: await localArt(logo, ART_WIDTH.logo),
    thumb: await localArt(thumb, ART_WIDTH.thumb),
  };
}

// --- Writing ------------------------------------------------------------------

const selectTitle = db.prepare('SELECT * FROM video_titles WHERE kind = ? AND folder = ?');
const insertTitle = db.prepare(
  'INSERT INTO video_titles (kind, folder, title, year, tmdb_id) VALUES (?, ?, ?, ?, ?)'
);
const updateTitleName = db.prepare('UPDATE video_titles SET title = ?, year = ? WHERE id = ?');
const selectVideo = db.prepare('SELECT id, size, mtime FROM videos WHERE title_id = ? AND path = ?');

// Local art is the file on disk; an empty slot keeps whatever TMDB put there.
function applyLocalArt(table, where, art, current) {
  const sets = [];
  const values = [];
  for (const [col, name] of Object.entries(art)) {
    if (name && current[col] !== name) {
      sets.push(`${col} = ?`);
      values.push(name);
    }
  }
  if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.sql}`).run(...values, ...where.args);
}

// A film lying loose in the root is named by its file, without the extension.
function titleRow(kind, folder, loose = false) {
  const parsed = parseTitleFolder(loose ? path.basename(folder, path.extname(folder)) : folder);
  let row = selectTitle.get(kind, folder);
  if (!row) {
    const id = Number(insertTitle.run(kind, folder, parsed.title, parsed.year, parsed.tmdbId).lastInsertRowid);
    return { row: selectTitle.get(kind, folder), id };
  }
  if (row.title !== parsed.title || row.year !== parsed.year) updateTitleName.run(parsed.title, parsed.year, row.id);
  if (parsed.tmdbId && !row.tmdb_locked && row.tmdb_id !== parsed.tmdbId) {
    db.prepare("UPDATE video_titles SET tmdb_id = ?, meta_at = '' WHERE id = ?").run(parsed.tmdbId, row.id);
  }
  return { row, id: row.id };
}

async function subtitleFiles(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const list = [];
  for (const entry of await readDir(dir)) {
    if (entry.isDirectory() || !SUB_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const sub = parseSubtitleFile(entry.name, base);
    if (sub) list.push(sub);
  }
  return list.sort((a, b) => a.file.localeCompare(b.file));
}

// Probes one file unless it is unchanged. Returns the row id.
async function indexVideo(titleId, root, file, place, force, stats) {
  const rel = path.relative(root, file);
  const st = await fsp.stat(file);
  const size = st.size;
  const mtime = Math.floor(st.mtimeMs);
  const known = selectVideo.get(titleId, rel);
  const subtitles = JSON.stringify(await subtitleFiles(file));

  if (known && !force && known.size === size && known.mtime === mtime) {
    db.prepare(
      'UPDATE videos SET season = ?, episode = ?, episode_end = ?, name = ?, subtitles = ? WHERE id = ?'
    ).run(place.season, place.episode, place.episodeEnd, place.name, subtitles, known.id);
    stats.skipped += 1;
    return known.id;
  }

  const info = await probeVideo(file);
  const row = {
    title_id: titleId,
    path: rel,
    season: place.season,
    episode: place.episode,
    episode_end: place.episodeEnd,
    name: place.name,
    duration: info.duration,
    width: info.video ? info.video.width : null,
    height: info.video ? info.video.height : null,
    container: info.container,
    streams: JSON.stringify({ video: info.video, audio: info.audio, subs: info.subs }),
    subtitles,
    size,
    mtime,
  };
  if (known) {
    db.prepare(`
      UPDATE videos SET season = @season, episode = @episode, episode_end = @episode_end, name = @name,
             duration = @duration, width = @width, height = @height, container = @container,
             streams = @streams, subtitles = @subtitles, size = @size, mtime = @mtime
       WHERE id = @id`).run({ ...row, id: known.id });
    stats.updated += 1;
    return known.id;
  }
  const id = Number(
    db.prepare(`
      INSERT INTO videos (title_id, path, season, episode, episode_end, name, duration, width, height,
                          container, streams, subtitles, size, mtime)
      VALUES (@title_id, @path, @season, @episode, @episode_end, @name, @duration, @width, @height,
              @container, @streams, @subtitles, @size, @mtime)`).run(row).lastInsertRowid
  );
  stats.added += 1;
  return id;
}

/**
 * Reads every film and series in `work`. `stats` is the scan's own progress
 * object; `done`, `added`, `updated`, `skipped` and `failed` are counted into it.
 * Returns the ids of every row that is still on disk, for the prune.
 */
export async function indexVideos(work, stats) {
  const force = getMeta('video_scanner_version') !== VIDEO_SCANNER_VERSION;
  const seenTitles = new Set();
  const seenVideos = new Set();

  const tryFile = async (fn) => {
    try {
      const id = await fn();
      if (id) seenVideos.add(id);
    } catch (err) {
      stats.failed += 1;
      console.warn('Sonorus: could not read video:', err && err.message ? err.message : err);
    }
    stats.done += 1;
  };

  for (const movie of work.movies) {
    const { row, id } = titleRow('movie', movie.folder, movie.loose);
    seenTitles.add(id);
    const file = movie.files[0];
    const base = path.basename(file, path.extname(file));
    await tryFile(() => indexVideo(id, work.dirs.movie, file, { season: null, episode: null, episodeEnd: null, name: '' }, force, stats));
    if (!movie.loose) applyLocalArt('video_titles', { sql: 'id = ?', args: [id] }, await titleArt(movie.dir, base), row);
  }

  for (const show of work.shows) {
    const { row, id } = titleRow('show', show.folder);
    seenTitles.add(id);
    const seasons = new Map();

    // Specials without a number sort by name and get none; the rest keep theirs.
    for (const file of show.files.sort((a, b) => a.localeCompare(b, 'de', { numeric: true }))) {
      const rel = path.relative(show.dir, file).split(path.sep);
      const base = path.basename(file, path.extname(file));
      const parsed = parseEpisode(base);
      let season = null;
      for (let i = rel.length - 2; i >= 0 && season === null; i -= 1) season = seasonOfDir(rel[i]);
      if (season === null) season = parsed.season ?? 1;
      const place = { season, episode: parsed.episode, episodeEnd: parsed.episodeEnd, name: parsed.name };
      await tryFile(async () => {
        const videoId = await indexVideo(id, work.dirs.show, file, place, force, stats);
        const still = await localArt(
          await findImage(path.dirname(file), [`${base}-thumb`, base]),
          ART_WIDTH.still
        );
        if (still) db.prepare('UPDATE videos SET still = ? WHERE id = ? AND still <> ?').run(still, videoId, still);
        return videoId;
      });
      if (!seasons.has(season)) seasons.set(season, path.dirname(file));
    }

    applyLocalArt('video_titles', { sql: 'id = ?', args: [id] }, await titleArt(show.dir, null), row);

    for (const [season, dir] of seasons) {
      db.prepare('INSERT OR IGNORE INTO video_seasons (title_id, season) VALUES (?, ?)').run(id, season);
      const names = season === 0
        ? ['season-specials-poster', 'season00-poster']
        : [`season${String(season).padStart(2, '0')}-poster`, `season${season}-poster`];
      let source = await findImage(show.dir, names);
      if (!source && dir !== show.dir) source = await findImage(dir, ['folder', 'poster', 'cover']);
      const poster = await localArt(source, ART_WIDTH.season);
      const current = db.prepare('SELECT poster FROM video_seasons WHERE title_id = ? AND season = ?').get(id, season);
      applyLocalArt('video_seasons', { sql: 'title_id = ? AND season = ?', args: [id, season] }, { poster }, current);
    }
    db.prepare(
      `DELETE FROM video_seasons WHERE title_id = ? AND season NOT IN (${[...seasons.keys()].map(() => '?').join(',') || 'NULL'})`
    ).run(id, ...seasons.keys());
  }

  setMeta('video_scanner_version', VIDEO_SCANNER_VERSION);
  return { seenTitles, seenVideos };
}

/**
 * Drops what is no longer on disk. A root that is missing or came back empty
 * while rows exist is left alone: that is an unmounted share, not a library
 * somebody emptied, and deleting it would take every position with it.
 */
export function pruneVideos(work, seen) {
  let removed = 0;
  for (const kind of ['movie', 'show']) {
    const found = kind === 'movie' ? work.movies.length : work.shows.length;
    const rows = db.prepare('SELECT COUNT(*) AS c FROM video_titles WHERE kind = ?').get(kind).c;
    if ((!work.roots[kind] || !found) && rows) {
      console.warn(`Sonorus: ${work.dirs[kind]} is missing or empty, keeping its ${rows} titles.`);
      continue;
    }
    const videos = db
      .prepare('SELECT v.id FROM videos v JOIN video_titles t ON t.id = v.title_id WHERE t.kind = ?')
      .all(kind);
    for (const v of videos) {
      if (!seen.seenVideos.has(v.id)) {
        db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
        removed += 1;
      }
    }
    for (const t of db.prepare('SELECT id FROM video_titles WHERE kind = ?').all(kind)) {
      if (!seen.seenTitles.has(t.id)) db.prepare('DELETE FROM video_titles WHERE id = ?').run(t.id);
    }
  }
  db.exec(`
    DELETE FROM video_titles WHERE id NOT IN (SELECT title_id FROM videos);
    DELETE FROM video_genres WHERE id NOT IN (SELECT genre_id FROM video_title_genres);
    DELETE FROM video_people WHERE id NOT IN (SELECT person_id FROM video_credits);
    DELETE FROM video_collections WHERE id NOT IN (SELECT collection_id FROM video_titles WHERE collection_id IS NOT NULL);
  `);
  return removed;
}

/** Deletes artwork files no row points at any more. */
export function sweepVideoArt() {
  const used = new Set();
  const add = (v) => v && used.add(v);
  for (const r of db.prepare('SELECT poster, backdrop, logo, thumb FROM video_titles').all()) Object.values(r).forEach(add);
  for (const r of db.prepare('SELECT poster FROM video_seasons').all()) add(r.poster);
  for (const r of db.prepare("SELECT still FROM videos WHERE still <> ''").all()) add(r.still);
  for (const r of db.prepare("SELECT photo FROM video_people WHERE photo <> ''").all()) add(r.photo);
  for (const r of db.prepare('SELECT poster, backdrop FROM video_collections').all()) Object.values(r).forEach(add);
  let removed = 0;
  for (const name of fs.readdirSync(videoArtDir)) {
    if (!used.has(name) && !name.includes('.tmp')) {
      fs.rmSync(path.join(videoArtDir, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}
