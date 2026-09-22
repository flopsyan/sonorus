// The songs whose files are gone and which somebody still wants.
//
// A scan does not delete a track whose file has disappeared if anything still
// refers to it - see `retireTracks` in lib/scanner.js. That is what keeps a
// rating alive across a renamed file, and it is right: the file comes back
// under its new name at the next scan and nothing was lost. What it also
// produces is the other case, where the file is really gone for good, and then
// the row is a corpse that shows up in the star playlists and nowhere else.
//
// Until now the only trace of them was one number in the scan summary
// ("2 fehlen, aber bewertet"), which says that something is wrong and not what.
// Florian, 2026-09-22: "ich kann schlecht herausfinden, um welche Lieder es sich
// handelt."
//
// **Rated and in a playlist, not merely played.** A row kept only by the play
// history was never marked by hand, and listing those would bury the two or
// three that were meant under hundreds nobody chose.

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
         -- Whether the record it was on is still a page worth linking to. The
         -- album row outlives its last file, so the test is what is left in it.
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

/**
 * Anything that would lose something if the row went. The same rule the scanner
 * prunes by, asked here for one track - see `isReferenced` in lib/scanner.js.
 *
 * `plays` is the interesting member: a play is minutes in the statistics, and
 * they are worth more than a tidy table. Florian, on being asked what the button
 * should cost: "vor allem die Minuten sind mir da wichtig dass die in der
 * Statistik bleiben".
 */
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

/**
 * Lets go of one corpse: this account's rating and its places in this account's
 * playlists, and then the row itself if that was the last thing holding it.
 *
 * A song that was listened to keeps its row, because `plays` hangs off it and
 * would cascade away with it. It is invisible either way - every browse view
 * filters on `missing_at`, and the two that do not are exactly the star
 * playlists and the playlists this has just taken it out of - so what is left is
 * a row nothing draws, holding the minutes.
 */
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
