// Read access to the spoken-word half of the library: the shows, their episodes
// and how far the account asking has got into each one.
//
// An episode is a row in `tracks` exactly like a song is, so everything that
// plays, streams or queues one needs no idea that podcasts exist. What a song
// has no place for is where listening stopped: `episode_progress` is per
// account, the same way ratings and playlists are.

import db from '../db.js';
import {
  TRACK_FIELDS,
  TRACK_FROM,
  PRESENT,
  EPISODE,
  shapeTrack,
  searchWords,
  allWordsIn,
  scoreOf,
  queryParams,
} from './library.js';

// EPISODE is the counterpart to MUSIC in library.js. Together with PRESENT it
// is what every list below selects.
const PRESENT_EPISODE = `${PRESENT} AND ${EPISODE}`;

// The publication date, as exactly as the file knows it - the same fallback the
// music side uses, so a library scanned before the column existed still sorts.
const EPISODE_DATE = "COALESCE(NULLIF(t.release_date, ''), CAST(t.year AS TEXT))";

// How far this account got, as part of the projection: a list of 361 episodes
// has to draw 361 progress bars, and asking per row would be 361 round trips.
const PROGRESS_FIELDS = `
  (SELECT ep.position  FROM episode_progress ep
    WHERE ep.track_id = t.id AND ep.user_id = @userId) AS position,
  (SELECT ep.completed FROM episode_progress ep
    WHERE ep.track_id = t.id AND ep.user_id = @userId) AS completed
`;

// Newest first is the default, because a podcast is a feed and the last episode
// is the one you have not heard. Both orders read the episode number first and
// the date second: a show that numbers its episodes is exact that way, and one
// that does not - the feed is then the only source of order - still sorts right.
export const EPISODE_SORTS = {
  new: `t.episode_no IS NULL, t.episode_no DESC, ${EPISODE_DATE} DESC, t.title COLLATE NOCASE DESC`,
  old: `t.episode_no IS NULL, t.episode_no ASC,  ${EPISODE_DATE} ASC,  t.title COLLATE NOCASE ASC`,
};

// A track projection plus the two things only an episode has.
function shapeEpisode(row) {
  const track = shapeTrack(row);
  if (!track) return null;
  const position = row.position || 0;
  const completed = !!row.completed;
  return {
    ...track,
    position,
    completed,
    // Where playback picks up. A finished episode starts over rather than
    // resuming one second before its own end.
    resumeAt: completed ? 0 : position,
  };
}

const shapeShow = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description || '',
  cover: row.cover ? `/covers/${row.cover}` : null,
  episodeCount: row.episodeCount || 0,
  // What is left to hear. The number the card actually shows, because "330
  // Folgen" says the same thing every time and this one moves.
  unplayedCount: Math.max(0, (row.episodeCount || 0) - (row.playedCount || 0)),
  duration: row.duration || 0,
  latest: row.latest || '',
});

const SHOW_ROW = `
  p.id, p.name, p.description, p.cover,
  COUNT(t.id) AS episodeCount,
  SUM(t.duration) AS duration,
  SUM(CASE WHEN ep.completed = 1 THEN 1 ELSE 0 END) AS playedCount,
  MAX(${EPISODE_DATE}) AS latest
`;

const SHOW_FROM = `
  FROM podcasts p
  LEFT JOIN tracks t ON t.podcast_id = p.id AND t.missing_at = ''
  LEFT JOIN episode_progress ep ON ep.track_id = t.id AND ep.user_id = @userId
`;

export function listPodcasts(userId) {
  return db
    .prepare(
      `SELECT ${SHOW_ROW} ${SHOW_FROM}
        GROUP BY p.id
       HAVING episodeCount > 0
        ORDER BY p.name COLLATE NOCASE ASC`
    )
    .all({ userId })
    .map(shapeShow);
}

// One show with all of its episodes. `sort` is 'new' or 'old'; anything else is
// the default, so a hand-typed query parameter cannot reach the SQL.
export function getPodcast(id, userId, { sort = 'new' } = {}) {
  const show = db
    .prepare(`SELECT ${SHOW_ROW} ${SHOW_FROM} WHERE p.id = @id GROUP BY p.id`)
    .get({ id, userId });
  if (!show || !show.id) return null;

  const order = EPISODE_SORTS[sort] || EPISODE_SORTS.new;
  const episodes = db
    .prepare(
      `SELECT ${TRACK_FIELDS}, ${PROGRESS_FIELDS} ${TRACK_FROM}
        WHERE t.podcast_id = @id AND ${PRESENT}
        ORDER BY ${order}`
    )
    .all({ id, userId })
    .map(shapeEpisode);

  // The episode "Weiterhören" leads to: the one this account last stopped in
  // the middle of. Asked for separately rather than picked out of the list
  // above, because that list is sorted by episode number and "last" is a
  // question about time.
  const resume = db
    .prepare(
      `SELECT ${TRACK_FIELDS}, ${PROGRESS_FIELDS} ${TRACK_FROM}
         JOIN episode_progress ep ON ep.track_id = t.id AND ep.user_id = @userId
        WHERE t.podcast_id = @id AND ${PRESENT}
          AND ep.completed = 0 AND ep.position > 0
        ORDER BY ep.updated_at DESC LIMIT 1`
    )
    .get({ id, userId });

  return {
    ...shapeShow(show),
    sort: EPISODE_SORTS[sort] ? sort : 'new',
    resume: shapeEpisode(resume),
    episodes,
  };
}

// Everything half-finished, across all shows, most recently listened to first.
// This is the row at the top of the podcast page - the one thing a podcast
// listener opens the app for.
export function continueListening(userId, limit = 12) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, ${PROGRESS_FIELDS} ${TRACK_FROM}
         JOIN episode_progress ep ON ep.track_id = t.id AND ep.user_id = @userId
        WHERE ${PRESENT_EPISODE} AND ep.completed = 0 AND ep.position > 0
        ORDER BY ep.updated_at DESC
        LIMIT @limit`
    )
    .all({ userId, limit })
    .map(shapeEpisode);
}

const isEpisode = db.prepare(
  'SELECT id, duration FROM tracks WHERE id = ? AND podcast_id IS NOT NULL'
);

const writeProgress = db.prepare(`
  INSERT INTO episode_progress (user_id, track_id, position, completed, updated_at)
  VALUES (@userId, @trackId, @position, @completed, datetime('now'))
  ON CONFLICT(user_id, track_id) DO UPDATE
     SET position = excluded.position,
         completed = excluded.completed,
         updated_at = excluded.updated_at
`);

// Where listening stopped, and whether the episode is done with.
//
// A finished episode keeps no position: it would be one second before its own
// end, "Weiterhören" would offer it forever, and playing it again would start
// it there. Marking one unplayed by hand clears the position for the same
// reason - it is the request to start over.
export function setProgress(userId, trackId, { position, completed } = {}) {
  const track = isEpisode.get(trackId);
  if (!track) return { error: 'not_found' };

  const done = completed === undefined ? false : !!completed;
  const at = done ? 0 : Math.max(0, Number(position) || 0);
  writeProgress.run({ userId, trackId, position: at, completed: done ? 1 : 0 });
  return { ok: true, position: at, completed: done, resumeAt: done ? 0 : at };
}

// An episode is looked for under its own title and under the name of its show,
// the same way an album is looked for under its title and its artist. Ranked by
// the same score the music search uses, so "Brainpain Hai" reads as one query.
const EPISODE_SEARCH_FIELDS = ['t.title', 'pc.name'];

export function searchEpisodes({ userId, q = '', limit = 100 } = {}) {
  const list = searchWords(q);
  if (!list.length) return [];
  const where = allWordsIn(EPISODE_SEARCH_FIELDS, list);

  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, ${PROGRESS_FIELDS},
              ${scoreOf('t.title', [[['pc.name'], 15]], list)} AS score ${TRACK_FROM}
        WHERE ${PRESENT_EPISODE} AND ${where.where}
        ORDER BY score DESC, ${EPISODE_SORTS.new}
        LIMIT @limit`
    )
    .all({ userId, ...where.params, ...queryParams(q), limit })
    .map(shapeEpisode);
}

// How much spoken word there is at all, for the empty state and the page head.
export function podcastStats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT t.podcast_id) AS shows, COUNT(*) AS episodes,
              COALESCE(SUM(t.duration), 0) AS duration
         FROM tracks t WHERE ${PRESENT_EPISODE}`
    )
    .get();
  const unplayed = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tracks t
        WHERE ${PRESENT_EPISODE}
          AND NOT EXISTS (SELECT 1 FROM episode_progress ep
                           WHERE ep.track_id = t.id AND ep.user_id = @userId
                             AND ep.completed = 1)`
    )
    .get({ userId }).c;
  return { ...row, unplayed };
}
