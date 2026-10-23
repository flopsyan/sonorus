// The home page below its three buttons: a song for today and where listening left off.
// The favourites live in library.js, the star counts are starCounts.

import db from '../db.js';
import { ARTIST_COVER, TRACK_FIELDS, TRACK_FROM, PRESENT_MUSIC, shapeTrack } from './library.js';
import { getPlaylist } from './playlists.js';

// --- Heute aufgelegt ----------------------------------------------------------

// Well rated and long unheard: four stars and up, no play for two months.
const MIN_STARS = 4;
const RESTED_DAYS = 60;

// The listener's day, as in the statistics (the container runs in their zone), and its
// midnight in the UTC that plays.played_at is stored in.
const TODAY = "date('now', 'localtime')";
const TODAY_START = "datetime(date('now', 'localtime'), 'utc')";

const pickTrack = db.prepare(
  `SELECT t.id FROM tracks t
     JOIN ratings r ON r.track_id = t.id AND r.user_id = @userId AND r.stars >= ${MIN_STARS}
    WHERE ${PRESENT_MUSIC} AND t.id <> @previous
      AND NOT EXISTS (SELECT 1 FROM plays p
                       WHERE p.user_id = @userId AND p.track_id = t.id
                         AND p.played_at >= datetime('now', '-${RESTED_DAYS} days'))
    ORDER BY RANDOM() LIMIT 1`
);
const playable = db.prepare(`SELECT 1 FROM tracks t WHERE t.id = ? AND ${PRESENT_MUSIC}`);
const keepPick = db.prepare(
  `INSERT INTO daily_tracks (user_id, day, track_id) VALUES (?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET day = excluded.day, track_id = excluded.track_id`
);
// Calendar days to the last play before today (1 is yesterday), so playing it today does not
// turn "vor 7 Monaten" into "heute".
const daysSince = db.prepare(
  `SELECT CAST(julianday(${TODAY}) - julianday(date(MAX(played_at), 'localtime')) AS INTEGER) AS days
     FROM plays WHERE user_id = ? AND track_id = ? AND played_at < ${TODAY_START}`
);

// Null when nothing qualifies, and then nothing is stored: the next rating may change that.
export function dailyTrack(userId) {
  const today = db.prepare(`SELECT ${TODAY} AS day`).get().day;
  const kept = db.prepare('SELECT day, track_id AS trackId FROM daily_tracks WHERE user_id = ?').get(userId);
  let trackId = kept && kept.day === today && playable.get(kept.trackId) ? kept.trackId : null;
  if (!trackId) {
    trackId = pickTrack.get({ userId, previous: kept ? kept.trackId : 0 })?.id;
    if (!trackId) return null;
    keepPick.run(userId, today, trackId);
  }
  const row = db.prepare(`SELECT ${TRACK_FIELDS} ${TRACK_FROM} WHERE t.id = @trackId`).get({ userId, trackId });
  return { track: shapeTrack(row), daysSince: daysSince.get(userId, trackId).days ?? null };
}

// --- Weiterhören --------------------------------------------------------------

const RESUME_MAX = 6;

// Newest first, one tile per list. More keys than tiles are read, because a deleted
// playlist or an album whose files are gone resolves to nothing and is skipped.
export function resumeSources(userId) {
  const keys = db
    .prepare(
      `SELECT source FROM plays WHERE user_id = ? AND source <> ''
        GROUP BY source ORDER BY MAX(played_at) DESC LIMIT 30`
    )
    .all(userId);
  const tiles = [];
  for (const { source } of keys) {
    const tile = resolve(userId, source);
    if (tile) tiles.push({ key: source, ...tile });
    if (tiles.length === RESUME_MAX) break;
  }
  return tiles;
}

function tile({ kind, title, sub, covers = [], round = false, icon = '' }) {
  return { kind, title, sub, cover: covers[0] || null, covers, round, icon };
}

// The keys are cleanSource's (ratings.js), so the parts are known to be well formed.
function resolve(userId, key) {
  const [kind, id, sub, stars] = key.split('/');
  switch (kind) {
    case 'albums':
      return albumTile(Number(id));
    case 'artists':
      return artistTile(userId, Number(id), sub, stars);
    case 'playlists':
      return playlistTile(userId, Number(id));
    case 'genres':
      return genreTile(id.split(',').map(Number));
    case 'stars':
      return starTile(userId, id.split(',').map(Number));
    case 'tracks':
      return tile({ kind: 'tracks', title: 'Alle Songs', sub: 'Bibliothek', icon: 'music' });
    case 'shuffle':
      return tile({ kind: 'shuffle', title: 'Zufallsmix', sub: 'Bibliothek', icon: 'shuffle' });
    case 'shuffle-unrated':
      return tile({ kind: 'shuffle', title: 'Unbewertete', sub: 'Zufallsmix', icon: 'star-outline' });
    default:
      return null;
  }
}

const covers = (rows) => rows.map((r) => `/covers/${r.cover}`);
const RECORD_COVER = "COALESCE(NULLIF(al.cover, ''), t.cover)";

function albumTile(id) {
  const album = db
    .prepare(
      `SELECT al.title, al.cover FROM albums al
        WHERE al.id = ? AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${PRESENT_MUSIC})`
    )
    .get(id);
  if (!album) return null;
  return tile({ kind: 'album', title: album.title, sub: 'Album', covers: album.cover ? [`/covers/${album.cover}`] : [] });
}

function artistTile(userId, id, sub, stars) {
  const artist = db
    .prepare(
      `SELECT ar.name, ${ARTIST_COVER} AS cover FROM artists ar
        WHERE ar.id = ? AND EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = ar.id AND ${PRESENT_MUSIC})`
    )
    .get(id);
  if (!artist) return null;
  const pictures = artist.cover ? [`/covers/${artist.cover}`] : [];
  // A narrowed list can run empty while the artist stays, and a tile that plays nothing is a dud.
  if (sub === 'singles') {
    const any = db.prepare(`SELECT 1 FROM tracks t WHERE t.artist_id = ? AND t.album_id IS NULL AND ${PRESENT_MUSIC}`).get(id);
    return any ? tile({ kind: 'singles', title: artist.name, sub: 'Singles', covers: pictures }) : null;
  }
  if (sub === 'stars') {
    const values = stars.split(',').map(Number);
    const any = db
      .prepare(
        `SELECT 1 FROM tracks t LEFT JOIN ratings r ON r.track_id = t.id AND r.user_id = ?
          WHERE t.artist_id = ? AND ${PRESENT_MUSIC} AND COALESCE(r.stars, 0) IN (${values.join(',')})`
      )
      .get(userId, id);
    return any ? tile({ kind: 'artist-stars', title: artist.name, sub: starLabel(values), covers: pictures }) : null;
  }
  return tile({ kind: 'artist', title: artist.name, sub: 'Interpret', covers: pictures, round: true });
}

// A dynamic list draws its songs from its filters on every read, too dear for a tile,
// so it shows its sidebar icon instead of covers.
function playlistTile(userId, id) {
  const playlist = getPlaylist(userId, id);
  if (!playlist) return null;
  if (playlist.dynamic) return tile({ kind: 'playlist', title: playlist.name, sub: 'Playlist', icon: 'filter' });
  const rows = db
    .prepare(
      `SELECT ${RECORD_COVER} AS cover FROM playlist_items i
         JOIN tracks t ON t.id = i.track_id
         LEFT JOIN albums al ON al.id = t.album_id
        WHERE i.playlist_id = ? AND ${RECORD_COVER} <> ''
        GROUP BY 1 ORDER BY MIN(i.position) LIMIT 4`
    )
    .all(id);
  return tile({ kind: 'playlist', title: playlist.name, sub: 'Playlist', covers: covers(rows) });
}

function genreTile(ids) {
  const genres = db.prepare(`SELECT name FROM genres WHERE id IN (${ids.join(',')}) ORDER BY name COLLATE NOCASE`).all();
  if (genres.length !== ids.length) return null;
  const rows = db
    .prepare(
      `SELECT ${RECORD_COVER} AS cover FROM track_genres tg
         JOIN tracks t ON t.id = tg.track_id AND ${PRESENT_MUSIC}
         LEFT JOIN albums al ON al.id = t.album_id
        WHERE tg.genre_id IN (${ids.join(',')}) AND ${RECORD_COVER} <> ''
        GROUP BY 1 ORDER BY MIN(al.title) LIMIT 4`
    )
    .all();
  return tile({ kind: 'genre', title: genres.map((g) => g.name).join(', '), sub: 'Genre', covers: covers(rows) });
}

// The covers of the songs rated last, as the star list itself runs. "Nicht bewertet" alone
// has no rating to order by and shows the icon of its button on the home page.
function starTile(userId, values) {
  const rated = values.filter((v) => v > 0);
  const title = starLabel(values);
  if (!rated.length) return tile({ kind: 'stars', title, sub: 'Bewertung', icon: 'star-outline' });
  const rows = db
    .prepare(
      `SELECT ${RECORD_COVER} AS cover FROM ratings r
         JOIN tracks t ON t.id = r.track_id AND ${PRESENT_MUSIC}
         LEFT JOIN albums al ON al.id = t.album_id
        WHERE r.user_id = ? AND r.stars IN (${rated.join(',')}) AND ${RECORD_COVER} <> ''
        GROUP BY 1 ORDER BY MAX(r.updated_at) DESC LIMIT 4`
    )
    .all(userId);
  return tile({ kind: 'stars', title, sub: 'Bewertung', covers: covers(rows), icon: 'star' });
}

// The same words as starSelectionLabel in the web client: "4 und 5 Sterne", "1 Stern".
function joinAnd(parts) {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
}

function starLabel(values) {
  const rated = values.filter((v) => v > 0).sort((a, b) => a - b);
  const parts = [];
  if (rated.length) {
    parts.push(`${joinAnd(rated.map(String))} ${rated.length === 1 && rated[0] === 1 ? 'Stern' : 'Sterne'}`);
  }
  if (values.includes(0)) parts.push('Nicht bewertet');
  return joinAnd(parts);
}
