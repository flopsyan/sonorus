// Star ratings and the listening history. Both belong to one account.

import db from '../db.js';

// Sets a rating from 1 to 5; 0 (or anything else) clears it. The star
// playlists read straight from this table, so they update with the rating.
export function setRating(userId, trackId, stars) {
  const value = Number(stars);
  if (!Number.isInteger(value) || value < 0 || value > 5) return { error: 'invalid_stars' };

  // Songs only: neither an episode nor a book part is rated, so the star playlists cannot fill up
  // with episodes even if something asks the API directly.
  const track = db
    .prepare('SELECT id FROM tracks WHERE id = ? AND podcast_id IS NULL AND audiobook_id IS NULL')
    .get(trackId);
  if (!track) return { error: 'not_found' };

  if (value === 0) {
    db.prepare('DELETE FROM ratings WHERE user_id = ? AND track_id = ?').run(userId, trackId);
    return { ok: true, stars: 0 };
  }

  db.prepare(
    `INSERT INTO ratings (user_id, track_id, stars) VALUES (?, ?, ?)
     ON CONFLICT(user_id, track_id) DO UPDATE
       SET stars = excluded.stars, updated_at = datetime('now')`
  ).run(userId, trackId, value);
  return { ok: true, stars: value };
}

// Records that a track was listened to. The client calls this once a track has
// played far enough to count, not when playback merely started. The id comes
// back so the player can keep reporting how long it really played.
//
// `playedAt` is for a play the client could not report when it happened: the
// Android app queues what is heard offline and sends it on the next connection,
// and without a timestamp every holiday would land on the day it came home.
// Left out - which is what every online play does - the row timestamps itself.
export function recordPlay(userId, trackId, seconds = 0, playedAt = '') {
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId);
  if (!track) return { error: 'not_found' };
  const when = plausibleTime(playedAt);
  const info = when
    ? db
        .prepare('INSERT INTO plays (user_id, track_id, seconds, played_at) VALUES (?, ?, ?, ?)')
        .run(userId, trackId, clampSeconds(seconds), when)
    : db
        .prepare('INSERT INTO plays (user_id, track_id, seconds) VALUES (?, ?, ?)')
        .run(userId, trackId, clampSeconds(seconds));
  return { ok: true, id: Number(info.lastInsertRowid) };
}

// A play backdated by the client is worth having, its timestamp is not worth
// trusting blind - a phone whose clock is wrong would otherwise push a play
// into next year and stretch every chart to reach it. So: parseable, not ahead
// of us by more than a minute of clock skew, and not older than a year. What
// fails any of those is not rejected - the play still counts, it is simply
// filed under now, which is the honest answer to "when, then?".
const BACKDATE_LIMIT_MS = 365 * 24 * 3600 * 1000;

function plausibleTime(value) {
  if (!value) return '';
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) return '';
  const skew = at.getTime() - Date.now();
  if (skew > 60 * 1000 || skew < -BACKDATE_LIMIT_MS) return '';
  // The column holds UTC in SQLite's own datetime('now') shape, which is what
  // every date() in stats.js reads with the listener's zone applied to it.
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

// The player reports the seconds it has played of the current track, several
// times per track. Only ever upwards, and never more than a plausible day, so
// a wrong value cannot poison the statistics.
export function updatePlaySeconds(userId, playId, seconds) {
  const value = clampSeconds(seconds);
  const info = db
    .prepare('UPDATE plays SET seconds = ? WHERE id = ? AND user_id = ? AND seconds < ?')
    .run(value, playId, userId, value);
  return { ok: true, updated: info.changes > 0 };
}

function clampSeconds(seconds) {
  const value = Math.round(Number(seconds) || 0);
  return Math.max(0, Math.min(24 * 3600, value));
}

export function clearHistory(userId) {
  db.prepare('DELETE FROM plays WHERE user_id = ?').run(userId);
  return { ok: true };
}

export function historyCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM plays WHERE user_id = ?').get(userId).c;
}
