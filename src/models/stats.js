// Listening statistics for one account.
//
// Everything here reads the `plays` table, which lives on the server and
// belongs to the account, not to the browser: what you listen to on the phone
// and what you listen to on the desktop count into the same numbers.
//
// A play row is written once a track has run far enough to count, and the
// player keeps reporting how many seconds it really played into `seconds` -
// so skipping away after a minute is a minute, not a full track.
//
// The page reads the history **one period at a time**: pick how wide a period
// is (a day, a week, a month, a year, or everything) and which one, and the
// chart, the readout and the three top lists all answer for that period.
//
// "Meistgehört" is **time listened**, not times started: the top lists rank by
// seconds and fall back to the play count only to break a tie. A twenty-minute
// suite heard twice is more listening than a three-minute song heard five
// times, and ranking by the count said the opposite.
//
// **All four libraries count.** Music, podcasts, audiobooks and radio plays all
// write into `plays`, and the time on this page is the time of all of them -
// broken down per library by `byKind`. Only the music-shaped lists stay music:
// the three top lists and the Songs / Interpreten / Alben counts beside them.

import db from '../db.js';

// Rows written before the player reported its listening time have seconds = 0.
// For those the track length is the only estimate available - a counted play
// did run most of the way through.
const SECONDS = 'CASE WHEN p.seconds > 0 THEN p.seconds ELSE COALESCE(t.duration, 0) END';

// Four libraries write into the same plays table, and this page needs both
// answers, so there are two FROMs.
//
// `FROM_ALL` counts everything and is what "Spielzeit" means: an hour of a
// podcast is an hour spent listening, and a page that hid it would tell the
// account it listened less than it did. `FROM` is music alone and stays under
// the three top lists and the three counts beside them - one 70-minute episode
// outweighs a dozen songs, and mixing them in would turn "Meistgehörte Songs"
// into a list of podcasts.
const FROM_ALL = `
  FROM plays p
  JOIN tracks t ON t.id = p.track_id
  LEFT JOIN audiobooks b ON b.id = t.audiobook_id
`;

const FROM = `
  FROM plays p
  JOIN tracks t ON t.id = p.track_id AND t.podcast_id IS NULL AND t.audiobook_id IS NULL
`;

// Which of the four libraries a play belongs to. Written once, as a CASE rather
// than as four queries, so a play can neither be counted twice nor fall between
// them. A book part is told from a radio play by `audiobooks.kind` alone - both
// live in the same table, which is exactly why the join above is a LEFT one.
const KIND = `
  CASE WHEN t.podcast_id IS NOT NULL  THEN 'podcast'
       WHEN b.kind = 'drama'          THEN 'drama'
       WHEN t.audiobook_id IS NOT NULL THEN 'book'
       ELSE 'music' END
`;

// A COUNT DISTINCT that only ever counts music. Songs, Interpreten and Alben
// are music words - a podcast episode has no interpret and a book has no album
// - so those three stay music however wide the time standing next to them is.
const musicOnly = (column) =>
  `COUNT(DISTINCT CASE WHEN t.podcast_id IS NULL AND t.audiobook_id IS NULL THEN ${column} END)`;

// played_at is UTC. The day a play belongs to is a question about the listener,
// not about the server, so the browser sends its own offset and it is applied
// inside the query. Clamped to a real timezone range.
function zone(offsetMinutes) {
  const m = Math.max(-840, Math.min(840, Math.round(Number(offsetMinutes) || 0)));
  return `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`;
}

// The five ways of slicing the history.
//
// `key` puts a play into one period and is *also* what selects that period
// ("the period shown" is simply "key = @period"), so a period key can never
// mean one thing while grouping and another while filtering. `inner` is how
// that one period is broken down for the chart.
//
// Both are written as functions of the column they read, so the same rule can
// be pointed at `'now'` to name the current period without a second copy of it.
// `all` has no key - it is every period at once and therefore filters nothing.
const RANGES = {
  day: {
    key: (c) => `strftime('%Y-%m-%d', ${c}, @tz)`,
    inner: (c) => `strftime('%H', ${c}, @tz)`,
  },
  // The Monday of that week: forward to Sunday, then back six days.
  week: {
    key: (c) => `date(${c}, @tz, 'weekday 0', '-6 days')`,
    inner: (c) => `strftime('%Y-%m-%d', ${c}, @tz)`,
  },
  month: {
    key: (c) => `strftime('%Y-%m', ${c}, @tz)`,
    inner: (c) => `strftime('%Y-%m-%d', ${c}, @tz)`,
  },
  year: {
    key: (c) => `strftime('%Y', ${c}, @tz)`,
    inner: (c) => `strftime('%Y-%m', ${c}, @tz)`,
  },
  all: {
    key: null,
    inner: (c) => `strftime('%Y', ${c}, @tz)`,
  },
};

export const DEFAULT_RANGE = 'day';

// A period key is only ever produced by the expressions above, so anything that
// does not have their shape (YYYY, YYYY-MM, YYYY-MM-DD) did not come from here.
// It is bound as a parameter either way; this only keeps a typed URL honest
// instead of quietly showing an empty period.
const KEY_SHAPE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

// Account and period live in the same WHERE, so no query on this page can
// forget one of them. better-sqlite3 refuses parameters a statement does not
// use, which is why the bindings are handed back together with the clause.
function scope(userId, range, period) {
  const { key } = RANGES[range];
  if (!key || !period) return { where: 'p.user_id = @userId', params: { userId } };
  return {
    where: `p.user_id = @userId AND ${key('p.played_at')} = @period`,
    params: { userId, period },
  };
}

// Which period a moment in time falls into - used for "now" (where the
// navigator starts) and for the first play (how far back it may step).
function periodKey(range, tz, when) {
  const { key } = RANGES[range];
  if (!key || !when) return '';
  return db.prepare(`SELECT ${key('@when')} AS key`).get({ tz, when }).key || '';
}

function periodTotals(userId, tz, range, period) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `SELECT COUNT(*) AS plays, ROUND(COALESCE(SUM(${SECONDS}), 0)) AS seconds,
              ${musicOnly('t.id')} AS tracks,
              ${musicOnly('t.artist_id')} AS artists,
              ${musicOnly('t.album_id')} AS albums ${FROM_ALL}
        WHERE ${where}`
    )
    .get(params.period ? { ...params, tz } : params);
}

// The four libraries a period's listening time came from, and what they add up
// to. Every kind comes back, zeroes included: a row reading "Podcasts 0:00"
// tells the reader that podcasts are counted here, and a missing row tells them
// nothing at all.
const KINDS = ['music', 'podcast', 'book', 'drama'];

function byKind(userId, tz, range, period) {
  const { where, params } = scope(userId, range, period);
  const rows = db
    .prepare(
      // `GROUP BY 1` and not `GROUP BY kind`, and that is not a style choice:
      // `audiobooks.kind` is a real column of a table this query joins, so the
      // bare name resolves to *it* rather than to the alias above. The four
      // libraries then collapse into three groups (NULL for music and for
      // podcasts alike) and the CASE is evaluated for whichever row of the
      // group came first - which filed every music play under "podcast".
      `SELECT ${KIND} AS kind, COUNT(*) AS plays,
              ROUND(COALESCE(SUM(${SECONDS}), 0)) AS seconds ${FROM_ALL}
        WHERE ${where}
        GROUP BY 1`
    )
    .all(params.period ? { ...params, tz } : params);

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

// The bars inside the selected period: hours of a day, days of a week or month,
// months of a year, years of everything. Only the slots something was played in
// come back - the client fills the quiet ones, because it knows how long a
// period is and the query does not.
function chart(userId, tz, range, period) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `SELECT ${RANGES[range].inner('p.played_at')} AS key,
              COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM_ALL}
        WHERE ${where}
        GROUP BY key
        ORDER BY key ASC`
    )
    .all({ ...params, tz });
}

function topTracks(userId, tz, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      // The interpret of the song, which on a compilation is not the folder it
      // lies in. The top *artists* below deliberately keep grouping by the
      // folder: the album belongs to "Various", and that is what was listened to.
      `SELECT t.id, t.title, COALESCE(NULLIF(t.track_artist, ''), ar.name) AS artist,
              al.title AS album,
              t.album_id AS albumId, t.artist_id AS artistId,
              COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
              COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM}
         LEFT JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums  al ON al.id = t.album_id
        WHERE ${where}
        GROUP BY t.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit, ...(params.period ? { tz } : {}) })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

function topArtists(userId, tz, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `SELECT ar.id, ar.name AS title, COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds,
              COUNT(DISTINCT t.id) AS tracks,
              (SELECT al.cover FROM albums al
                WHERE al.artist_id = ar.id AND al.cover <> '' LIMIT 1) AS cover ${FROM}
         JOIN artists ar ON ar.id = t.artist_id
        WHERE ${where}
        GROUP BY ar.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit, ...(params.period ? { tz } : {}) })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

function topAlbums(userId, tz, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `SELECT al.id, al.title, ar.name AS artist, al.cover,
              COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM}
         JOIN albums al ON al.id = t.album_id
         LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE ${where}
        GROUP BY al.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit, ...(params.period ? { tz } : {}) })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

// One list for all three spoken libraries rather than three lists of five rows.
// What is ranked is the *thing* - the show, the book, the radio play - and not
// the file it is made of: a book is one thing whose parts are never shown, so a
// top list of parts would name the same book forty times over.
function topSpoken(userId, tz, range, period, limit) {
  const { where, params } = scope(userId, range, period);
  return db
    .prepare(
      `SELECT 'podcast' AS kind, pc.id AS id, pc.name AS title, '' AS artist,
              pc.cover AS cover, COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds
         FROM plays p
         JOIN tracks t ON t.id = p.track_id
         JOIN podcasts pc ON pc.id = t.podcast_id
        WHERE ${where}
        GROUP BY pc.id
        UNION ALL
       SELECT b.kind, b.id, b.title, COALESCE(au.name, ''),
              b.cover, COUNT(*), ROUND(SUM(${SECONDS}))
         FROM plays p
         JOIN tracks t ON t.id = p.track_id
         JOIN audiobooks b ON b.id = t.audiobook_id
         LEFT JOIN authors au ON au.id = b.author_id
        WHERE ${where}
        GROUP BY b.id
        ORDER BY seconds DESC, plays DESC
        LIMIT @limit`
    )
    .all({ ...params, limit, ...(params.period ? { tz } : {}) })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

export function listeningStats(userId, offsetMinutes = 0, options = {}) {
  const tz = zone(offsetMinutes);
  const range = RANGES[options.range] ? options.range : DEFAULT_RANGE;
  const top = Math.max(1, Math.min(50, Math.round(Number(options.top) || 10)));

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS plays, ROUND(COALESCE(SUM(${SECONDS}), 0)) AS seconds,
              MIN(p.played_at) AS firstPlay, MAX(p.played_at) AS lastPlay,
              ${musicOnly('t.id')} AS tracks,
              ${musicOnly('t.artist_id')} AS artists,
              ${musicOnly('t.album_id')} AS albums,
              COUNT(DISTINCT date(p.played_at, @tz)) AS activeDays ${FROM_ALL}
        WHERE p.user_id = @userId`
    )
    .get({ userId, tz });

  // The two ends the navigator may not step past: the period the first play
  // falls into, and the one that is running right now.
  const current = periodKey(range, tz, 'now');
  const first = periodKey(range, tz, totals.firstPlay);
  const asked = String(options.period || '');
  const period = KEY_SHAPE.test(asked) ? asked : current;

  // Averages run over the whole time since the first play, not only over the
  // days something was played - "pro Tag" should include the quiet ones.
  const days = totals.firstPlay
    ? Math.max(
        1,
        db
          .prepare(
            `SELECT CAST(julianday(date('now', @tz)) - julianday(date(@first, @tz)) AS INTEGER) + 1 AS d`
          )
          .get({ tz, first: totals.firstPlay }).d
      )
    : 1;

  // The day the most was listened to. Measured like everything else here.
  const bestDay = db
    .prepare(
      `SELECT date(p.played_at, @tz) AS day, COUNT(*) AS plays,
              ROUND(SUM(${SECONDS})) AS seconds ${FROM_ALL}
        WHERE p.user_id = @userId
        GROUP BY day
        ORDER BY seconds DESC
        LIMIT 1`
    )
    .get({ userId, tz }) || null;

  return {
    totals: { ...totals, days, bestDay },
    // Every one of these divides time that was really listened to by a span
    // that has really passed. Nothing is projected onto a week, month or year
    // that has not happened yet - a "pro Jahr" after two days of listening
    // would be a guess, and this page does not guess.
    average: {
      day: totals.seconds / days,
      activeDay: totals.activeDays ? totals.seconds / totals.activeDays : 0,
      play: totals.plays ? totals.seconds / totals.plays : 0,
      playsPerDay: totals.plays / days,
    },
    // What the selection currently shows, and the two ends it can move between.
    // The client walks from `key` to its neighbour in its own timezone and uses
    // `first` / `current` to know when to stop, so no round trip is needed just
    // to grey out an arrow.
    period: {
      range,
      key: period,
      first,
      current,
      totals: periodTotals(userId, tz, range, period),
      // The same period, split by the library it was listened to in.
      kinds: byKind(userId, tz, range, period),
    },
    chart: chart(userId, tz, range, period),
    top: {
      tracks: topTracks(userId, tz, range, period, top),
      artists: topArtists(userId, tz, range, period, top),
      albums: topAlbums(userId, tz, range, period, top),
      spoken: topSpoken(userId, tz, range, period, top),
    },
  };
}
