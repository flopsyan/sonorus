// Songs whose file is gone but that someone rated or put in a playlist. A row
// kept only by its plays was never chosen by hand and would bury the few that were.

import db from '../db.js';

const LIST = `
  SELECT t.id,
         t.title,
         t.path,
         t.missing_at                         AS missingAt,
         t.artist_id                          AS artistId,
         COALESCE(ar.name, t.track_artist, '') AS artist,
         t.album_id                           AS albumId,
         COALESCE(al.title, '')               AS album,
         COALESCE(r.stars, 0)                 AS stars,
         -- The album row outlives its last file, so it is linked only while files remain.
         (SELECT COUNT(*) FROM tracks t2
           WHERE t2.album_id = t.album_id AND t2.missing_at = '') AS albumTracks,
         (SELECT GROUP_CONCAT(p.name, ' · ')
            FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
           WHERE pi.track_id = t.id AND p.user_id = @userId) AS playlists
    FROM tracks t
    LEFT JOIN artists ar ON ar.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    LEFT JOIN ratings r  ON r.track_id = t.id AND r.user_id = @userId
   WHERE t.missing_at != ''
     AND (r.stars IS NOT NULL OR playlists IS NOT NULL)
   ORDER BY r.stars DESC, t.title COLLATE NOCASE ASC
`;

export function listMissing(userId) {
  return db
    .prepare(LIST)
    .all({ userId })
    .map((row) => ({
      ...row,
      albumId: row.albumTracks > 0 ? row.albumId : null,
      playlists: row.playlists ? row.playlists.split(' · ') : [],
    }));
}

export function countMissing(userId) {
  return listMissing(userId).length;
}

// The scanner's `isReferenced` rule for one track. Plays count: they are minutes
// in the statistics.
const stillWanted = db.prepare(`
  SELECT 1 FROM ratings          WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM playlist_items   WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM plays            WHERE track_id = @id
   UNION ALL
  SELECT 1 FROM episode_progress WHERE track_id = @id
   LIMIT 1
`);

// Drops this account's rating and playlist places, then the row once nothing holds
// it. A played song keeps its row, since deleting it would cascade the plays away.
export const dropMissing = db.transaction((userId, trackId) => {
  const row = db
    .prepare("SELECT id FROM tracks WHERE id = @id AND missing_at != ''")
    .get({ id: trackId });
  if (!row) return { error: 'not_found' };

  db.prepare('DELETE FROM ratings WHERE track_id = @id AND user_id = @userId')
    .run({ id: trackId, userId });
  db.prepare(
    `DELETE FROM playlist_items
      WHERE track_id = @id
        AND playlist_id IN (SELECT id FROM playlists WHERE user_id = @userId)`
  ).run({ id: trackId, userId });

  const kept = !!stillWanted.get({ id: trackId });
  if (!kept) db.prepare('DELETE FROM tracks WHERE id = @id').run({ id: trackId });
  return { ok: true, deleted: !kept };
});
