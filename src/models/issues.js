// Import notices: the rows of a CSV import that no file in the library matched.
//
// They are deliberately persistent. An import that silently drops half a
// playlist is worse than useless, so every unmatched row is kept with enough
// detail (playlist, title, artist, album) to go and find the file by hand. The
// notices show up under Einstellungen and stay until dismissed - or until a
// later scan turns up the file, at which point the track is added to its
// playlist and the notice disappears on its own.

import db from '../db.js';
import { findTrackForImport } from './library.js';
import { addTracks } from './playlists.js';

export function listIssues(userId) {
  return db
    .prepare(
      `SELECT i.id, i.playlist_id AS playlistId, i.playlist_name AS playlistName,
              i.title, i.artists, i.album, i.source, i.created_at AS createdAt,
              p.name AS currentPlaylistName
         FROM import_issues i
         LEFT JOIN playlists p ON p.id = i.playlist_id
        WHERE i.user_id = ?
        ORDER BY i.created_at DESC, i.id DESC`
    )
    .all(userId);
}

export function countIssues(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM import_issues WHERE user_id = ?').get(userId).c;
}

export const addIssues = db.transaction((userId, rows) => {
  const insert = db.prepare(
    `INSERT INTO import_issues (user_id, playlist_id, playlist_name, title, artists, album, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      userId,
      row.playlistId || null,
      String(row.playlistName || ''),
      String(row.title || ''),
      String(row.artists || ''),
      String(row.album || ''),
      String(row.source || '')
    );
  }
  return rows.length;
});

export function dismissIssue(userId, id) {
  const info = db
    .prepare('DELETE FROM import_issues WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return info.changes ? { ok: true } : { error: 'not_found' };
}

export function clearIssues(userId) {
  const info = db.prepare('DELETE FROM import_issues WHERE user_id = ?').run(userId);
  return { ok: true, removed: info.changes };
}

// Re-checks open notices against the library. Called after every scan, and on
// demand from the settings page. A notice whose song now exists is added to its
// playlist (when that playlist still exists) and then removed.
//
// Pass a user id to check one account, or null for all of them.
export function resolveIssuesForUser(userId = null) {
  const open = userId
    ? db.prepare('SELECT * FROM import_issues WHERE user_id = ?').all(userId)
    : db.prepare('SELECT * FROM import_issues').all();

  let resolved = 0;
  for (const issue of open) {
    const trackId = findTrackForImport({
      title: issue.title,
      artists: issue.artists,
      album: issue.album,
    });
    if (!trackId) continue;

    if (issue.playlist_id) {
      const result = addTracks(issue.user_id, issue.playlist_id, [trackId]);
      // The playlist is gone: drop the notice anyway, the song is in the
      // library now and there is nothing left to fix.
      if (result.error && result.error !== 'not_found') continue;
    }
    db.prepare('DELETE FROM import_issues WHERE id = ?').run(issue.id);
    resolved += 1;
  }
  return resolved;
}
