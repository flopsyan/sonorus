// Listening statistics for one account.
//
// Everything here reads the `plays` table, which lives on the server and
// belongs to the account, not to the browser: what you listen to on the phone
// and what you listen to on the desktop count into the same numbers.
//
// A play row is written once a track has run far enough to count, and the
// player keeps reporting how many seconds it really played into `seconds` -
// so skipping away after a minute is a minute, not a full track.

import db from '../db.js';

// Rows written before the player reported its listening time have seconds = 0.
// For those the track length is the only estimate available - a counted play
// did run most of the way through.
const SECONDS = 'CASE WHEN p.seconds > 0 THEN p.seconds ELSE COALESCE(t.duration, 0) END';

const FROM = `
  FROM plays p
  JOIN tracks t ON t.id = p.track_id
`;

// played_at is UTC. The day a play belongs to is a question about the listener,
// not about the server, so the browser sends its own offset and it is applied
// inside the query. Clamped to a real timezone range.
function zone(offsetMinutes) {
  const m = Math.max(-840, Math.min(840, Math.round(Number(offsetMinutes) || 0)));
  return `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`;
}

// The four ways of slicing the history. `key` is what a bucket is grouped by,
// `label` how it is written on the axis.
const BUCKETS = {
  day: { key: "strftime('%Y-%m-%d', p.played_at, @tz)", limit: 14 },
  // The Monday of that week: forward to Sunday, then back six days.
  week: { key: "date(p.played_at, @tz, 'weekday 0', '-6 days')", limit: 12 },
  month: { key: "strftime('%Y-%m', p.played_at, @tz)", limit: 12 },
  year: { key: "strftime('%Y', p.played_at, @tz)", limit: 10 },
};

function bucket(userId, tz, name) {
  const { key, limit } = BUCKETS[name];
  return db
    .prepare(
      `SELECT ${key} AS key, COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM}
        WHERE p.user_id = @userId
        GROUP BY key
        ORDER BY key DESC
        LIMIT ${limit}`
    )
    .all({ userId, tz })
    .reverse();
}

function topTracks(userId, limit) {
  return db
    .prepare(
      `SELECT t.id, t.title, ar.name AS artist, al.title AS album,
              t.album_id AS albumId, t.artist_id AS artistId,
              COALESCE(NULLIF(al.cover, ''), t.cover) AS cover,
              COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM}
         LEFT JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums  al ON al.id = t.album_id
        WHERE p.user_id = @userId
        GROUP BY t.id
        ORDER BY plays DESC, seconds DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

function topArtists(userId, limit) {
  return db
    .prepare(
      `SELECT ar.id, ar.name AS title, COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds,
              COUNT(DISTINCT t.id) AS tracks,
              (SELECT al.cover FROM albums al
                WHERE al.artist_id = ar.id AND al.cover <> '' LIMIT 1) AS cover ${FROM}
         JOIN artists ar ON ar.id = t.artist_id
        WHERE p.user_id = @userId
        GROUP BY ar.id
        ORDER BY plays DESC, seconds DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

function topAlbums(userId, limit) {
  return db
    .prepare(
      `SELECT al.id, al.title, ar.name AS artist, al.cover,
              COUNT(*) AS plays, ROUND(SUM(${SECONDS})) AS seconds ${FROM}
         JOIN albums al ON al.id = t.album_id
         LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE p.user_id = @userId
        GROUP BY al.id
        ORDER BY plays DESC, seconds DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

export function listeningStats(userId, offsetMinutes = 0, top = 10) {
  const tz = zone(offsetMinutes);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS plays, ROUND(COALESCE(SUM(${SECONDS}), 0)) AS seconds,
              MIN(p.played_at) AS firstPlay, MAX(p.played_at) AS lastPlay,
              COUNT(DISTINCT t.id) AS tracks,
              COUNT(DISTINCT t.artist_id) AS artists,
              COUNT(DISTINCT t.album_id) AS albums,
              COUNT(DISTINCT date(p.played_at, @tz)) AS activeDays ${FROM}
        WHERE p.user_id = @userId`
    )
    .get({ userId, tz });

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

  const perDay = totals.seconds / days;

  return {
    totals: { ...totals, days },
    average: {
      day: perDay,
      week: perDay * 7,
      month: perDay * 30.44,
      year: perDay * 365.25,
    },
    buckets: {
      day: bucket(userId, tz, 'day'),
      week: bucket(userId, tz, 'week'),
      month: bucket(userId, tz, 'month'),
      year: bucket(userId, tz, 'year'),
    },
    top: {
      tracks: topTracks(userId, top),
      artists: topArtists(userId, top),
      albums: topAlbums(userId, top),
    },
  };
}
