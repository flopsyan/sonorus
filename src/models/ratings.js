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
// played far enough to count, not when playback merely started.
export function recordPlay(userId, trackId) {
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId);
  if (!track) return { error: 'not_found' };
  db.prepare('INSERT INTO plays (user_id, track_id) VALUES (?, ?)').run(userId, trackId);
  return { ok: true };
}

export function clearHistory(userId) {
  db.prepare('DELETE FROM plays WHERE user_id = ?').run(userId);
  return { ok: true };
}

export function historyCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM plays WHERE user_id = ?').get(userId).c;
}
