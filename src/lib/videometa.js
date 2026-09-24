// What TMDB adds to a film or a series: text, genres, studio, age rating, cast
// and crew with portraits, film series, and every picture the folder did not
// bring. Fills gaps only - local artwork and the folder name always win.

import db, { setMeta } from '../db.js';
import { tmdb, tmdbImage, tmdbEnabled, LANGUAGE, FALLBACK_LANGUAGE } from './tmdb.js';
import { explainSystemError } from './errors.js';

const CAST_LIMIT = 24;
const CREW_JOBS = {
  Director: 'director',
  Screenplay: 'writer',
  Writer: 'writer',
  'Original Music Composer': 'composer',
};

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

// Images are a nicety: a failed download leaves the slot empty for the next scan.
async function image(filePath, size) {
  try {
    return await tmdbImage(filePath, size);
  } catch (err) {
    console.warn('Sonorus:', err.message);
    return '';
  }
}

// --- Matching -----------------------------------------------------------------

async function findId(kind, title, year) {
  // "The Final Destination (4)" is how a folder numbers a series, not a title.
  const query = title.replace(/\s*\(\d{1,2}\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const endpoint = kind === 'movie' ? '/search/movie' : '/search/tv';
  const yearParam = kind === 'movie' ? 'year' : 'first_air_date_year';
  const attempts = year ? [{ [yearParam]: year }, {}] : [{}];
  for (const extra of attempts) {
    const data = await tmdb(endpoint, { query, language: LANGUAGE, include_adult: 'false', ...extra });
    const results = (data && data.results) || [];
    if (!results.length) continue;
    const wanted = norm(query);
    const exact = results.find((r) =>
      [r.title, r.original_title, r.name, r.original_name].some((n) => norm(n) === wanted)
    );
    return (exact || results[0]).id;
  }
  return null;
}

// --- Writing ------------------------------------------------------------------

function pickImage(list, languages) {
  const all = list || [];
  for (const lang of languages) {
    const hit = all.find((i) => (i.iso_639_1 || null) === lang);
    if (hit) return hit;
  }
  return all[0] || null;
}

function setGenres(titleId, genres) {
  db.prepare('DELETE FROM video_title_genres WHERE title_id = ?').run(titleId);
  for (const g of genres || []) {
    const name = String(g.name || '').trim();
    if (!name) continue;
    db.prepare('INSERT OR IGNORE INTO video_genres (name) VALUES (?)').run(name);
    const { id } = db.prepare('SELECT id FROM video_genres WHERE name = ?').get(name);
    db.prepare('INSERT OR IGNORE INTO video_title_genres (title_id, genre_id) VALUES (?, ?)').run(titleId, id);
  }
}

// Every credit is written first and the portraits are fetched after, in one go.
async function setCredits(titleId, credits) {
  db.prepare('DELETE FROM video_credits WHERE title_id = ?').run(titleId);
  const photos = [];
  const write = db.transaction(() => {
    for (const c of credits) {
      db.prepare(
        `INSERT INTO video_people (tmdb_id, name) VALUES (?, ?)
         ON CONFLICT(tmdb_id) DO UPDATE SET name = excluded.name`
      ).run(c.tmdbId, c.name);
      const person = db.prepare('SELECT id, photo FROM video_people WHERE tmdb_id = ?').get(c.tmdbId);
      db.prepare(
        'INSERT OR IGNORE INTO video_credits (title_id, person_id, role, character, ord) VALUES (?, ?, ?, ?, ?)'
      ).run(titleId, person.id, c.role, c.character || '', c.ord);
      if (!person.photo && c.profile) photos.push({ id: person.id, profile: c.profile });
    }
  });
  write();
  await pool(photos, 4, async (p) => {
    const name = await image(p.profile, 'w185');
    if (name) db.prepare('UPDATE video_people SET photo = ? WHERE id = ?').run(name, p.id);
  });
}

function crewCredits(crew, offset) {
  const out = [];
  const seen = new Set();
  for (const c of crew || []) {
    const role = CREW_JOBS[c.job];
    if (!role || seen.has(`${c.id}:${role}`)) continue;
    seen.add(`${c.id}:${role}`);
    out.push({ tmdbId: c.id, name: c.name, role, profile: c.profile_path, ord: offset + out.length });
  }
  return out;
}

// Only the slots that are still empty; the scan has already put local art in.
async function fillArt(table, where, current, wanted) {
  const sets = [];
  const values = [];
  for (const [col, [filePath, size]] of Object.entries(wanted)) {
    if (current[col] || !filePath) continue;
    const name = await image(filePath, size);
    if (name) {
      sets.push(`${col} = ?`);
      values.push(name);
    }
  }
  if (sets.length) db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.sql}`).run(...values, ...where.args);
}

function logoOf(images) {
  const logo = pickImage(images && images.logos, ['de', 'en', null]);
  if (!logo) return [null, ''];
  return [logo.file_path, logo.file_path.endsWith('.svg') ? 'original' : 'w500'];
}

function certificationOf(list, get) {
  for (const country of ['DE', 'US']) {
    const entry = (list || []).find((r) => r.iso_3166_1 === country);
    const value = entry && get(entry);
    if (value) return `${country}:${value}`;
  }
  return '';
}

async function upsertCollection(c) {
  if (!c) return null;
  db.prepare(
    `INSERT INTO video_collections (tmdb_id, name) VALUES (?, ?)
     ON CONFLICT(tmdb_id) DO UPDATE SET name = excluded.name`
  ).run(c.id, c.name);
  const row = db.prepare('SELECT * FROM video_collections WHERE tmdb_id = ?').get(c.id);
  if (!row.overview || !row.poster || !row.backdrop) {
    const data = await tmdb(`/collection/${c.id}`, { language: LANGUAGE });
    if (data) {
      if (!row.overview && data.overview) {
        db.prepare('UPDATE video_collections SET overview = ? WHERE id = ?').run(data.overview, row.id);
      }
      await fillArt('video_collections', { sql: 'id = ?', args: [row.id] }, row, {
        poster: [data.poster_path, 'w500'],
        backdrop: [data.backdrop_path, 'w1280'],
      });
    }
  }
  return row.id;
}

async function refreshMovie(row) {
  const params = {
    language: LANGUAGE,
    append_to_response: 'credits,release_dates,images',
    include_image_language: 'de,en,null',
  };
  const data = await tmdb(`/movie/${row.tmdb_id}`, params);
  if (!data) return false;
  let { overview, tagline } = data;
  if (!overview) {
    const en = await tmdb(`/movie/${row.tmdb_id}`, { language: FALLBACK_LANGUAGE });
    if (en) ({ overview, tagline } = { overview: en.overview, tagline: tagline || en.tagline });
  }
  const collectionId = await upsertCollection(data.belongs_to_collection);

  db.prepare(`
    UPDATE video_titles
       SET original_title = ?, overview = ?, tagline = ?, release_date = ?, certification = ?,
           vote = ?, studios = ?, collection_id = ?
     WHERE id = ?`).run(
    data.original_title || '',
    overview || '',
    tagline || '',
    data.release_date || '',
    certificationOf(data.release_dates && data.release_dates.results, (e) =>
      (e.release_dates || []).map((d) => d.certification).find(Boolean)
    ),
    data.vote_count ? data.vote_average : null,
    JSON.stringify((data.production_companies || []).slice(0, 3).map((c) => c.name)),
    collectionId,
    row.id
  );
  setGenres(row.id, data.genres);

  const cast = ((data.credits && data.credits.cast) || [])
    .slice(0, CAST_LIMIT)
    .map((c, i) => ({ tmdbId: c.id, name: c.name, role: 'cast', character: c.character, profile: c.profile_path, ord: i }));
  await setCredits(row.id, [...cast, ...crewCredits(data.credits && data.credits.crew, 1000)]);

  const poster = pickImage(data.images && data.images.posters, ['de', 'en', null]);
  await fillArt('video_titles', { sql: 'id = ?', args: [row.id] }, row, {
    poster: [(poster && poster.file_path) || data.poster_path, 'w500'],
    backdrop: [data.backdrop_path, 'w1280'],
    logo: logoOf(data.images),
  });
  return true;
}

async function refreshSeason(showRow, season) {
  const data = await tmdb(`/tv/${showRow.tmdb_id}/season/${season}`, { language: LANGUAGE });
  if (!data) {
    db.prepare("UPDATE video_seasons SET meta_at = datetime('now') WHERE title_id = ? AND season = ?").run(showRow.id, season);
    return;
  }
  const episodes = data.episodes || [];
  let fallback = null;
  if (episodes.some((e) => !e.overview)) {
    const en = await tmdb(`/tv/${showRow.tmdb_id}/season/${season}`, { language: FALLBACK_LANGUAGE });
    fallback = new Map(((en && en.episodes) || []).map((e) => [e.episode_number, e]));
  }
  const current = db.prepare('SELECT * FROM video_seasons WHERE title_id = ? AND season = ?').get(showRow.id, season);
  db.prepare(
    "UPDATE video_seasons SET name = ?, overview = ?, air_date = ?, meta_at = datetime('now') WHERE title_id = ? AND season = ?"
  ).run(data.name || '', data.overview || '', data.air_date || '', showRow.id, season);
  await fillArt('video_seasons', { sql: 'title_id = ? AND season = ?', args: [showRow.id, season] }, current, {
    poster: [data.poster_path, 'w342'],
  });

  const locals = db
    .prepare('SELECT id, episode, name, overview, still FROM videos WHERE title_id = ? AND season = ?')
    .all(showRow.id, season);
  for (const v of locals) {
    const ep =
      (v.episode != null && episodes.find((e) => e.episode_number === v.episode)) ||
      (v.name && episodes.find((e) => norm(e.name) && (norm(v.name).includes(norm(e.name)) || norm(e.name).includes(norm(v.name))))) ||
      null;
    if (!ep) continue;
    const en = fallback && fallback.get(ep.episode_number);
    db.prepare(
      "UPDATE videos SET overview = ?, air_date = ?, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?"
    ).run(ep.overview || (en && en.overview) || '', ep.air_date || '', ep.name || '', v.id);
    if (!v.still && ep.still_path) {
      const still = await image(ep.still_path, 'w300');
      if (still) db.prepare('UPDATE videos SET still = ? WHERE id = ?').run(still, v.id);
    }
  }
}

async function refreshShow(row, { force = false } = {}) {
  const data = await tmdb(`/tv/${row.tmdb_id}`, {
    language: LANGUAGE,
    append_to_response: 'aggregate_credits,content_ratings,images',
    include_image_language: 'de,en,null',
  });
  if (!data) return false;
  let { overview, tagline } = data;
  if (!overview) {
    const en = await tmdb(`/tv/${row.tmdb_id}`, { language: FALLBACK_LANGUAGE });
    if (en) ({ overview, tagline } = { overview: en.overview, tagline: tagline || en.tagline });
  }
  const ended = ['Ended', 'Canceled'].includes(data.status);
  db.prepare(`
    UPDATE video_titles
       SET original_title = ?, overview = ?, tagline = ?, release_date = ?, end_date = ?, status = ?,
           certification = ?, vote = ?, studios = ?
     WHERE id = ?`).run(
    data.original_name || '',
    overview || '',
    tagline || '',
    data.first_air_date || '',
    ended ? data.last_air_date || '' : '',
    data.status || '',
    certificationOf(data.content_ratings && data.content_ratings.results, (e) => e.rating),
    data.vote_count ? data.vote_average : null,
    JSON.stringify((data.networks || []).slice(0, 3).map((n) => n.name)),
    row.id
  );
  setGenres(row.id, data.genres);

  const cast = ((data.aggregate_credits && data.aggregate_credits.cast) || [])
    .slice()
    .sort((a, b) => (b.total_episode_count || 0) - (a.total_episode_count || 0) || a.order - b.order)
    .slice(0, CAST_LIMIT)
    .map((c, i) => ({
      tmdbId: c.id,
      name: c.name,
      role: 'cast',
      character: ((c.roles || [])[0] || {}).character || '',
      profile: c.profile_path,
      ord: i,
    }));
  const creators = (data.created_by || []).map((c, i) => ({
    tmdbId: c.id, name: c.name, role: 'creator', profile: c.profile_path, ord: 1000 + i,
  }));
  await setCredits(row.id, [...cast, ...creators]);

  const poster = pickImage(data.images && data.images.posters, ['de', 'en', null]);
  await fillArt('video_titles', { sql: 'id = ?', args: [row.id] }, row, {
    poster: [(poster && poster.file_path) || data.poster_path, 'w500'],
    backdrop: [data.backdrop_path, 'w1280'],
    logo: logoOf(data.images),
  });

  const seasons = db.prepare('SELECT season, meta_at FROM video_seasons WHERE title_id = ?').all(row.id);
  for (const s of seasons) {
    if (force || !s.meta_at || seasonHasNewEpisodes(row.id, s)) await refreshSeason(row, s.season);
  }
  return true;
}

function seasonHasNewEpisodes(titleId, s) {
  return !!db
    .prepare('SELECT 1 FROM videos WHERE title_id = ? AND season = ? AND added_at > ? LIMIT 1')
    .get(titleId, s.season, s.meta_at);
}

/** Reads one title from TMDB, matching it first when it has no id yet. */
export async function refreshTitle(titleId, { force = false } = {}) {
  let row = db.prepare('SELECT * FROM video_titles WHERE id = ?').get(titleId);
  if (!row) return false;
  if (!row.tmdb_id) {
    const found = await findId(row.kind, row.title, row.year);
    if (!found) {
      db.prepare("UPDATE video_titles SET meta_at = datetime('now') WHERE id = ?").run(row.id);
      return false;
    }
    db.prepare('UPDATE video_titles SET tmdb_id = ? WHERE id = ?').run(found, row.id);
    row = db.prepare('SELECT * FROM video_titles WHERE id = ?').get(titleId);
  }
  const ok = row.kind === 'movie' ? await refreshMovie(row) : await refreshShow(row, { force });
  db.prepare("UPDATE video_titles SET meta_at = datetime('now') WHERE id = ?").run(row.id);
  return ok;
}

/** Titles never read, and series whose seasons gained something since. */
function dueTitles() {
  return db
    .prepare(`
      SELECT t.id FROM video_titles t
       WHERE t.meta_at = ''
          OR (t.kind = 'show' AND EXISTS (
                SELECT 1 FROM video_seasons s
                 WHERE s.title_id = t.id
                   AND (s.meta_at = '' OR EXISTS (
                         SELECT 1 FROM videos v
                          WHERE v.title_id = t.id AND v.season = s.season AND v.added_at > s.meta_at))))
       ORDER BY t.id`)
    .all()
    .map((r) => r.id);
}

/**
 * The metadata phase of a scan. Reports through `state` like every other phase.
 * A rejected key stops the phase after the first title rather than failing
 * each of them one by one; the reason is kept for the settings page.
 */
export async function refreshDueMetadata(state) {
  if (!tmdbEnabled()) return;
  const ids = dueTitles();
  if (!ids.length) return;
  state.phase = 'metadata';
  state.total = ids.length;
  state.done = 0;
  setMeta('tmdb_error', '');
  for (const id of ids) {
    try {
      await refreshTitle(id);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`Sonorus: TMDB failed for title ${id}:`, message);
      setMeta('tmdb_error', (err && err.shown) || explainSystemError(err) || message);
      if (/401/.test(message)) break;
    }
    state.done += 1;
  }
}
