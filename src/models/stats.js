// Listening statistics for one account. The time covers all six libraries (see byKind); the top
// lists and the Songs / Interpreten / Alben counts stay music. Rankings go by seconds listened,
// not plays started: a twenty-minute suite heard twice outweighs a short song heard five times.

import db from '../db.js';

// Rows from before the player reported its time have seconds = 0; the track length stands in,
// since a counted play ran most of the way. Applied once, in the slicing below.
const RAW_SECONDS = 'CASE WHEN p.seconds > 0 THEN p.seconds ELSE COALESCE(t.duration, 0) END';

// A skip still adds its time; it counts as a play after 30 s, or a third of a shorter track.
// Rows with 0 seconds predate the reporting and were only written once they counted.
const COUNT_AFTER = 30;
export const PLAY_COUNTED = `(p.seconds = 0 OR p.seconds >= CASE WHEN t.duration > 0 AND t.duration < ${COUNT_AFTER}
  THEN t.duration / 3 ELSE ${COUNT_AFTER} END)`;

// The same for films and episodes, scaled up to five minutes.
const VIDEO_COUNT_AFTER = 300;
const VIDEO_COUNTED = `vp.seconds >= CASE WHEN v.duration > 0 AND v.duration < ${VIDEO_COUNT_AFTER}
  THEN v.duration / 3 ELSE ${VIDEO_COUNT_AFTER} END`;

// The end of the hour a moment lies in, and how much of that hour is left.
const HOUR_END = (c) => `datetime(strftime('%Y-%m-%d %H:00:00', ${c}), '+1 hour')`;
const LEFT_IN_HOUR = (c) => `(strftime('%s', ${HOUR_END(c)}) - strftime('%s', ${c}))`;

/**
 * Every play, cut at the hours it crosses, so a long play fills each hourly bar it ran in.
 * Converted out of UTC here only, into server time, so the listener's location cannot move a play.
 * A play across a DST switch is off by an hour, accepted over UTC math that breaks half-hour zones.
 */
// video_plays rows get a negative id, so they never count as the same play as a track's.
const WITH_SLICES = `
WITH RECURSIVE source(id, user_id, track_id, video_id, counted, at, remaining) AS (
  SELECT p.id, p.user_id, p.track_id, NULL, ${PLAY_COUNTED},
         datetime(p.played_at, 'localtime'),
         ${RAW_SECONDS}
    FROM plays p
    JOIN tracks t ON t.id = p.track_id
   WHERE p.user_id = @userId
  UNION ALL
  SELECT -vp.id, vp.user_id, NULL, vp.video_id, ${VIDEO_COUNTED},
         datetime(vp.played_at, 'localtime'), vp.seconds
    FROM video_plays vp
    JOIN videos v ON v.id = vp.video_id
   WHERE vp.user_id = @userId AND vp.seconds > 0
),
slice(id, user_id, track_id, video_id, counted, at, remaining) AS (
  SELECT id, user_id, track_id, video_id, counted, at, remaining FROM source
  UNION ALL
  SELECT id, user_id, track_id, video_id, counted, ${HOUR_END('at')}, remaining - ${LEFT_IN_HOUR('at')}
    FROM slice
   WHERE remaining > ${LEFT_IN_HOUR('at')}
),
sliced AS (
  SELECT id, user_id, track_id, video_id, counted, at AS played_at,
         MIN(remaining, ${LEFT_IN_HOUR('at')}) AS seconds
    FROM slice
)`;

// What a query counts and what it adds up. A slice is a piece of a play, so the
// plays have to be counted by their id - counting rows would make one long
// evening's listening look like three.
const SECONDS = 'p.seconds';
const PLAYS = 'COUNT(DISTINCT CASE WHEN p.counted THEN p.id END)';

// FROM_ALL counts all six libraries and is what "Spielzeit" means. FROM is music only, for the
// top lists and counts, where one 70-minute episode would outweigh a dozen songs.
const FROM_ALL = `
  FROM sliced p
  LEFT JOIN tracks t ON t.id = p.track_id
  LEFT JOIN audiobooks b ON b.id = t.audiobook_id
  LEFT JOIN videos v ON v.id = p.video_id
  LEFT JOIN video_titles vt ON vt.id = v.title_id
`;

const FROM = `
  FROM sliced p
  JOIN tracks t ON t.id = p.track_id AND t.podcast_id IS NULL AND t.audiobook_id IS NULL
`;

// Which of the six libraries a play belongs to, as one CASE so a play can neither be counted
// twice nor fall between them. Book parts and radio plays differ only by audiobooks.kind.
const KIND = `
  CASE WHEN p.video_id IS NOT NULL THEN (CASE WHEN vt.kind = 'movie' THEN 'movie' ELSE 'show' END)
       WHEN t.podcast_id IS NOT NULL  THEN 'podcast'
       WHEN b.kind = 'drama'          THEN 'drama'
       WHEN t.audiobook_id IS NOT NULL THEN 'book'
       ELSE 'music' END
`;

// A COUNT DISTINCT that only ever counts music. Songs, Interpreten and Alben
// are music words - a podcast episode has no interpret and a book has no album
// - so those three stay music however wide the time standing next to them is.
const musicOnly = (column) =>
  `COUNT(DISTINCT CASE WHEN p.track_id IS NOT NULL AND t.podcast_id IS NULL AND t.audiobook_id IS NULL THEN ${column} END)`;

// `key` both groups a play into a period and selects it ("key = @period"), so the two cannot
// disagree; `inner` breaks a period down for the chart. Functions of a column, so the same rule
// can name the current period from 'now'.
const RANGES = {
  day: {
    key: (c) => `strftime('%Y-%m-%d', ${c})`,
    inner: (c) => `strftime('%H', ${c})`,
  },
  // The Monday of that week: forward to Sunday, then back six days.
  week: {
    key: (c) => `date(${c}, 'weekday 0', '-6 days')`,
    inner: (c) => `strftime('%Y-%m-%d', ${c})`,
  },
  month: {
    key: (c) => `strftime('%Y-%m', ${c})`,
    inner: (c) => `strftime('%Y-%m-%d', ${c})`,
  },
  year: {
    key: (c) => `strftime('%Y', ${c})`,
    inner: (c) => `strftime('%Y-%m', ${c})`,
  },
  all: {
    key: null,
    inner: (c) => `strftime('%Y', ${c})`,
  },
};

export const DEFAULT_RANGE = 'day';

// Bound as a parameter either way; the shape check only keeps a typed URL from quietly showing
// an empty period.
const KEY_SHAPE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

// Account and period live in the same WHERE, so no query on this page can forget one of them.
// The bindings travel with the clause because a named parameter left unbound throws.
function scope(userId, range, period) {
  const { key } = RANGES[range];
  if (!key || !period) return { where: 'p.user_id = @userId', params: { userId } };
  return {
    where: `p.user_id = @userId AND ${key('p.played_at')} = @period`,
    params: { userId, period },
  };
}

// The period of "now" (where the navigator starts) or of the first play (how far back it may
// step). `when` is already server-local time.
const NOW = "datetime('now', 'localtime')";

function periodKey(range, when) {
  const { key } = RANGES[range];
  if (!key || !when) return '';
  if (when === NOW) return db.prepare(`SELECT ${key(NOW)} AS key`).get().key || '';
  return db.prepare(`SELECT ${key('@when')} AS key`).get({ when }).key || '';
}

function periodTotals(userId, range, period) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `${WITH_SLICES} SELECT ${PLAYS} AS plays, ROUND(COALESCE(SUM(${SECONDS}), 0)) AS seconds,
              ${musicOnly('t.id')} AS tracks,
              ${musicOnly('t.artist_id')} AS artists,
              ${musicOnly('t.album_id')} AS albums ${FROM_ALL}
        WHERE ${where}`
    )
    .get(params);
}

// Every kind comes back, zeroes included: "Podcasts 0:00" tells the reader podcasts are
// counted, a missing row tells them nothing.
const KINDS = ['music', 'podcast', 'book', 'drama', 'movie', 'show'];

function byKind(userId, range, period) {
  const { where, params } = scope(userId, range, period);
  const rows = db
    .prepare(
      // GROUP BY 1, not GROUP BY kind: the bare name resolves to the joined audiobooks.kind
      // column rather than the alias, which collapsed the libraries and filed music as "podcast".
      `${WITH_SLICES} SELECT ${KIND} AS kind, ${PLAYS} AS plays,
              ROUND(COALESCE(SUM(${SECONDS}), 0)) AS seconds ${FROM_ALL}
        WHERE ${where}
        GROUP BY 1`
    )
    .all(params);

  const out = { total: { plays: 0, seconds: 0 } };
  for (const kind of KINDS) out[kind] = { plays: 0, seconds: 0 };
  for (const row of rows) {
    if (!out[row.kind]) continue;
    out[row.kind] = { plays: row.plays, seconds: row.seconds };
    out.total.plays += row.plays;
    out.total.seconds += row.seconds;
  }
  return out;
}

// Only slots with plays come back; the client fills the quiet ones, because it knows how long
// a period is and the query does not.
function chart(userId, range, period) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `${WITH_SLICES} SELECT ${RANGES[range].inner('p.played_at')} AS key,
              ${PLAYS} AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM_ALL}
        WHERE ${where}
        GROUP BY key
        ORDER BY key ASC`
    )
    .all(params);
}

function topTracks(userId, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      // The interpret of the song, which on a compilation is not the folder it
      // lies in. The top *artists* below deliberately keep grouping by the
      // folder: the album belongs to "Various", and that is what was listened to.
      `${WITH_SLICES} SELECT t.id, t.title, COALESCE(NULLIF(t.track_artist, ''), ar.name) AS artist,
              al.title AS album,
              t.album_id AS albumId, t.artist_id AS artistId,
              COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
              ${PLAYS} AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM}
         LEFT JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums  al ON al.id = t.album_id
        WHERE ${where}
        GROUP BY t.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

function topArtists(userId, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `${WITH_SLICES} SELECT ar.id, ar.name AS title, ${PLAYS} AS plays, ROUND(SUM(${SECONDS})) AS seconds,
              COUNT(DISTINCT t.id) AS tracks,
              (SELECT al.cover FROM albums al
                WHERE al.artist_id = ar.id AND al.cover <> '' LIMIT 1) AS cover ${FROM}
         JOIN artists ar ON ar.id = t.artist_id
        WHERE ${where}
        GROUP BY ar.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

function topAlbums(userId, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `${WITH_SLICES} SELECT al.id, al.title, ar.name AS artist, al.cover,
              ${PLAYS} AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM}
         JOIN albums al ON al.id = t.album_id
         LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE ${where}
        GROUP BY al.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

// One list for the three spoken libraries, ranked by show or book rather than by file: a top
// list of parts would name the same book forty times.
function topSpoken(userId, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `${WITH_SLICES} SELECT 'podcast' AS kind, pc.id AS id, pc.name AS title, '' AS artist,
              pc.cover AS cover, ${PLAYS} AS plays, ROUND(SUM(${SECONDS})) AS seconds
         FROM sliced p
         JOIN tracks t ON t.id = p.track_id
         JOIN podcasts pc ON pc.id = t.podcast_id
        WHERE ${where}
        GROUP BY pc.id
        UNION ALL
       SELECT b.kind, b.id, b.title, COALESCE(au.name, ''),
              b.cover, ${PLAYS}, ROUND(SUM(${SECONDS}))
         FROM sliced p
         JOIN tracks t ON t.id = p.track_id
         JOIN audiobooks b ON b.id = t.audiobook_id
         LEFT JOIN authors au ON au.id = b.author_id
        WHERE ${where}
        GROUP BY b.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

// Films and series, ranked as a whole: a series is one thing, not its episodes.
function topVideos(userId, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `${WITH_SLICES} SELECT vt.kind, vt.id, vt.title, vt.poster AS cover,
              ${PLAYS} AS plays, ROUND(SUM(${SECONDS})) AS seconds
         FROM sliced p
         JOIN videos v ON v.id = p.video_id
         JOIN video_titles vt ON vt.id = v.title_id
        WHERE ${where}
        GROUP BY vt.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/video-art/${r.cover}` : null }));
}

/**
 * Everything the statistics page shows, for one account. The server's clock decides which hour,
 * day and year a play belongs to, so the history reads the same from every device.
 */
export function listeningStats(userId, options = {}) {
  const range = RANGES[options.range] ? options.range : DEFAULT_RANGE;
  const top = Math.max(1, Math.min(50, Math.round(Number(options.top) || 10)));

  const totals = db
    .prepare(
      `${WITH_SLICES} SELECT ${PLAYS} AS plays, ROUND(COALESCE(SUM(${SECONDS}), 0)) AS seconds,
              MIN(p.played_at) AS firstPlay, MAX(p.played_at) AS lastPlay,
              ${musicOnly('t.id')} AS tracks,
              ${musicOnly('t.artist_id')} AS artists,
              ${musicOnly('t.album_id')} AS albums,
              COUNT(DISTINCT date(p.played_at)) AS activeDays ${FROM_ALL}
        WHERE p.user_id = @userId`
    )
    .get({ userId });

  // The two ends the navigator may not step past: the period the first play
  // falls into, and the one that is running right now.
  const current = periodKey(range, NOW);
  const first = periodKey(range, totals.firstPlay);
  const asked = String(options.period || '');
  const period = KEY_SHAPE.test(asked) ? asked : current;

  // Averages run over the whole time since the first play, not only over the
  // days something was played - "pro Tag" should include the quiet ones.
  const days = totals.firstPlay
    ? Math.max(
        1,
        db
          .prepare(
            `SELECT CAST(julianday(date(${NOW})) - julianday(date(@first)) AS INTEGER) + 1 AS d`
          )
          .get({ first: totals.firstPlay }).d
      )
    : 1;

  // The day the most was listened to. Measured like everything else here.
  const bestDay = db
    .prepare(
      `${WITH_SLICES} SELECT date(p.played_at) AS day, ${PLAYS} AS plays,
              ROUND(SUM(${SECONDS})) AS seconds ${FROM_ALL}
        WHERE p.user_id = @userId
        GROUP BY day
        ORDER BY seconds DESC
        LIMIT 1`
    )
    .get({ userId }) || null;

  return {
    totals: { ...totals, days, bestDay },
    // Divided by time that has really passed: a "pro Jahr" after two days would be a guess.
    average: {
      day: totals.seconds / days,
      activeDay: totals.activeDays ? totals.seconds / totals.activeDays : 0,
      play: totals.plays ? totals.seconds / totals.plays : 0,
      playsPerDay: totals.plays / days,
    },
    // The client steps from `key` to its neighbours itself and stops at `first` / `current`, so
    // greying out an arrow needs no round trip.
    period: {
      range,
      key: period,
      first,
      current,
      totals: periodTotals(userId, range, period),
      // The same period, split by the library it was listened to in.
      kinds: byKind(userId, range, period),
    },
    chart: chart(userId, range, period),
    top: {
      tracks: topTracks(userId, range, period, top),
      artists: topArtists(userId, range, period, top),
      albums: topAlbums(userId, range, period, top),
      spoken: topSpoken(userId, range, period, top),
      videos: topVideos(userId, range, period, top),
    },
  };
}
