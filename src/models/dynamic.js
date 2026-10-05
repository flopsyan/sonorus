// A dynamic playlist is only its filters, re-read on every request, so a new record that
// fits turns up by itself. A category stores the shorter of "only these" and "all except
// these", which keeps an artist added later in a list that said "everyone but Queen".

import db from '../db.js';
import { TRACK_FIELDS, TRACK_FROM, TRACK_ARTIST, PRESENT_MUSIC, shapeTrack, trackOrder } from './library.js';

export const LIFETIME_MS = 24 * 60 * 60 * 1000;
const CATEGORIES = ['genres', 'artists', 'albums', 'decades', 'stars'];
const STARS = [5, 4, 3, 2, 1, 0];
const MAX_RANGES = 20;

// The rows a song without a genre or without an album is filed under.
const NONE = 0;

export const expiry = () => new Date(Date.now() + LIFETIME_MS).toISOString();

export function defaultRules() {
  return { v: 1, ...Object.fromEntries(CATEGORIES.map((c) => [c, { mode: 'all', ids: [] }])), ranges: [] };
}

export function parseRules(text) {
  try {
    const rules = JSON.parse(text);
    return rules && rules.v === 1 ? rules : null;
  } catch {
    return null;
  }
}

const starName = (n) => (n === 0 ? 'Nicht bewertet' : n === 1 ? '1 Stern' : `${n} Sterne`);

/** Everything each filter can offer right now, in the order the lists show it. */
export function filterOptions() {
  const genres = db
    .prepare(
      `SELECT g.id, g.name FROM genres g
        WHERE EXISTS (SELECT 1 FROM track_genres tg JOIN tracks t ON t.id = tg.track_id
                       WHERE tg.genre_id = g.id AND ${PRESENT_MUSIC})
        ORDER BY g.name COLLATE NOCASE`
    )
    .all();
  const bare = db
    .prepare(
      `SELECT 1 FROM tracks t WHERE ${PRESENT_MUSIC}
          AND NOT EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id) LIMIT 1`
    )
    .get();
  if (bare) genres.push({ id: NONE, name: 'Ohne Genre' });

  const artists = db
    .prepare(
      `SELECT ar.id, ar.name FROM artists ar
        WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = ar.id AND ${PRESENT_MUSIC})
        ORDER BY ar.name COLLATE NOCASE`
    )
    .all();

  const albums = db
    .prepare(
      `SELECT al.id, al.title AS name, ar.name AS artist, al.year FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${PRESENT_MUSIC})
        ORDER BY ar.name COLLATE NOCASE, al.year, al.title COLLATE NOCASE`
    )
    .all()
    .map((a) => ({ id: a.id, name: a.name, artist: a.artist || '', year: a.year || null }));
  const singles = db.prepare(`SELECT 1 FROM tracks t WHERE ${PRESENT_MUSIC} AND t.album_id IS NULL LIMIT 1`).get();
  if (singles) albums.push({ id: NONE, name: 'Singles', artist: '', year: null });

  // Only the decades the library has: a 1940s record added later adds the 1940s.
  const decades = db
    .prepare(`SELECT DISTINCT (t.year / 10) * 10 AS id FROM tracks t WHERE ${PRESENT_MUSIC} AND t.year > 0 ORDER BY id DESC`)
    .all()
    .map((d) => ({ id: d.id, name: `${d.id}er` }));

  const stars = STARS.map((n) => ({ id: n, name: starName(n) }));
  return { genres, artists, albums, decades, stars };
}

// --- Between what a client ticks and what is stored ----------------------------

function ticked(sel, universe) {
  if (sel.mode === 'all') return universe.map((o) => o.id);
  const ids = new Set(sel.ids);
  return universe.filter((o) => (sel.mode === 'only' ? ids.has(o.id) : !ids.has(o.id))).map((o) => o.id);
}

function store(value, universe) {
  if (value === 'all' || !Array.isArray(value)) return { mode: 'all', ids: [] };
  const on = new Set(value.map(Number).filter(Number.isInteger));
  const inside = universe.filter((o) => on.has(o.id)).map((o) => o.id);
  if (inside.length >= universe.length) return { mode: 'all', ids: [] };
  const off = universe.filter((o) => !on.has(o.id)).map((o) => o.id);
  return off.length < inside.length ? { mode: 'except', ids: off } : { mode: 'only', ids: inside };
}

function cleanRanges(list) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!Array.isArray(r)) continue;
    const a = Number.parseInt(r[0], 10);
    const b = Number.parseInt(r[1] ?? r[0], 10);
    if (!(a >= 1000 && a <= 2999 && b >= 1000 && b <= 2999)) continue;
    const range = [Math.min(a, b), Math.max(a, b)];
    const key = range.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(range);
    if (out.length >= MAX_RANGES) break;
  }
  return out;
}

/** What a client sends ({ genres: 'all' | [ids], ..., ranges }) as it is stored. */
export function rulesFromClient(input, options = filterOptions()) {
  const body = input || {};
  const rules = { v: 1, ranges: cleanRanges(body.ranges) };
  for (const c of CATEGORIES) rules[c] = store(body[c], options[c]);
  return rules;
}

/** The stored rules as the client ticks them: 'all' or the ids that are on. */
export function rulesForClient(rules, options = filterOptions()) {
  const out = { ranges: rules.ranges || [] };
  for (const c of CATEGORIES) {
    const sel = rules[c] || { mode: 'all', ids: [] };
    out[c] = sel.mode === 'all' ? 'all' : ticked(sel, options[c]);
  }
  return out;
}

// --- The name that writes itself ---------------------------------------------

function pickPart(sel, universe, noun, few) {
  if (!sel || sel.mode === 'all') return '';
  const on = ticked(sel, universe);
  if (!on.length) return `keine ${noun}`;
  const name = new Map(universe.map((o) => [o.id, o.name]));
  const off = universe.filter((o) => !on.includes(o.id));
  if (on.length <= few) return on.map((id) => name.get(id)).join(', ');
  if (off.length <= 2) return `ohne ${off.map((o) => o.name).join(', ')}`;
  return `${on.length} ${noun}`;
}

function starsPart(sel) {
  if (!sel || sel.mode === 'all') return '';
  const on = ticked(sel, STARS.map((id) => ({ id })));
  if (!on.length) return 'keine Bewertung';
  const nums = on.filter((n) => n > 0).sort((a, b) => a - b);
  const parts = [];
  if (nums.length === 1) parts.push(starName(nums[0]));
  else if (nums.length > 1) {
    const run = nums[nums.length - 1] - nums[0] + 1 === nums.length;
    parts.push(run ? `${nums[0]}-${nums[nums.length - 1]} Sterne` : `${nums.join(', ')} Sterne`);
  }
  if (on.includes(0)) parts.push('unbewertet');
  return parts.join(', ');
}

function yearPart(rules, universe) {
  if (!rules.decades || rules.decades.mode === 'all') return '';
  const ranges = (rules.ranges || []).map(([a, b]) => (a === b ? String(a) : `${a}-${b}`));
  const none = !ticked(rules.decades, universe).length;
  if (none) return ranges.join(', ') || 'keine Jahre';
  return [pickPart(rules.decades, universe, 'Jahrzehnte', 3), ...ranges].join(', ');
}

export function autoName(rules, options = filterOptions()) {
  const parts = [
    pickPart(rules.genres, options.genres, 'Genres', 2),
    yearPart(rules, options.decades),
    pickPart(rules.artists, options.artists, 'Interpreten', 2),
    pickPart(rules.albums, options.albums, 'Alben', 2),
    starsPart(rules.stars),
  ].filter(Boolean);
  return (parts.join(' · ') || 'Alle Songs').slice(0, 120);
}

// --- The songs -------------------------------------------------------------------

const list = (key) => `(SELECT value FROM json_each(@${key}))`;

function pick(expr, sel, key, params) {
  params[key] = JSON.stringify(sel.ids);
  return sel.mode === 'only' ? `${expr} IN ${list(key)}` : `${expr} NOT IN ${list(key)}`;
}

// A song passes when one of its genres is ticked, so "Rock" keeps a song filed
// under Rock and Pop even with Pop switched off.
function genreCondition(sel, params) {
  params.genres = JSON.stringify(sel.ids);
  const bare = 'NOT EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id)';
  const noneOn = sel.mode === 'only' ? sel.ids.includes(NONE) : !sel.ids.includes(NONE);
  const some = `EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id AND tg.genre_id ${
    sel.mode === 'only' ? 'IN' : 'NOT IN'
  } ${list('genres')})`;
  return noneOn ? `(${some} OR ${bare})` : some;
}

function yearCondition(rules, params) {
  const parts = [];
  if (rules.decades.mode === 'only' ? rules.decades.ids.length : true) {
    parts.push(`(t.year > 0 AND ${pick('(t.year / 10) * 10', rules.decades, 'decades', params)})`);
  }
  (rules.ranges || []).forEach(([a, b], i) => {
    params[`ra${i}`] = a;
    params[`rb${i}`] = b;
    parts.push(`t.year BETWEEN @ra${i} AND @rb${i}`);
  });
  return parts.length ? `(${parts.join(' OR ')})` : '0';
}

function conditions(rules, params) {
  const out = [];
  if (rules.genres.mode !== 'all') out.push(genreCondition(rules.genres, params));
  if (rules.artists.mode !== 'all') out.push(pick('COALESCE(t.artist_id, 0)', rules.artists, 'artists', params));
  if (rules.albums.mode !== 'all') out.push(pick('COALESCE(t.album_id, 0)', rules.albums, 'albums', params));
  if (rules.decades.mode !== 'all') out.push(yearCondition(rules, params));
  if (rules.stars.mode !== 'all') {
    out.push(pick('COALESCE((SELECT r.stars FROM ratings r WHERE r.track_id = t.id AND r.user_id = @userId), 0)', rules.stars, 'stars', params));
  }
  return out.length ? out.join(' AND ') : '1';
}

/** The songs of a dynamic playlist; without a sort, artist > album > track. */
export function dynamicTracks(userId, rules, { sort, dir } = {}) {
  const params = { userId };
  const where = conditions(rules, params);
  const order = sort
    ? trackOrder(sort, dir)
    : `${TRACK_ARTIST} COLLATE NOCASE, al.year, al.title COLLATE NOCASE, t.disc_no, t.track_no`;
  return db
    .prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE ${PRESENT_MUSIC} AND ${where} ORDER BY ${order}`)
    .all(params)
    .map(shapeTrack);
}

export function dynamicTotals(userId, rules) {
  const params = { userId };
  const where = conditions(rules, params);
  return db
    .prepare(
      `SELECT COUNT(*) AS trackCount, COALESCE(SUM(t.duration), 0) AS duration
         FROM tracks t WHERE ${PRESENT_MUSIC} AND ${where}`
    )
    .get(params);
}
