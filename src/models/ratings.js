// Star ratings and the listening history. Both belong to one account.

import db from '../db.js';

// Sets a rating from 1 to 5; 0 (or anything else) clears it. The star
// playlists read straight from this table, so they update with the rating.
export function setRating(userId, trackId, stars) {
  const value = Number(stars);
  if (!Number.isInteger(value) || value < 0 || value > 5) return { error: 'invalid_stars' };

  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId);
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
export function recordPlay(userId, trackId, seconds = 0) {
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId);
  if (!track) return { error: 'not_found' };
  const info = db
    .prepare('INSERT INTO plays (user_id, track_id, seconds) VALUES (?, ?, ?)')
    .run(userId, trackId, clampSeconds(seconds));
  return { ok: true, id: Number(info.lastInsertRowid) };
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
