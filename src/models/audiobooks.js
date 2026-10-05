// Audiobooks and radio plays share one table, told apart by `kind`, which every export
// passes into its query. A book is one thing and its files are never shown, so lengths
// and positions are sums across parts ("hour 4 of 11", not "part 7 at 320 s").

import db from '../db.js';
import {
  TRACK_FIELDS,
  TRACK_FROM,
  PRESENT,
  BOOK_PART,
  shapeTrack,
  searchWords,
  allWordsIn,
  scoreOf,
  queryParams,
} from './library.js';

const PRESENT_PART = `${PRESENT} AND ${BOOK_PART}`;

// 'book' unless something explicitly asks for the other one - so a caller that
// forgets shows audiobooks rather than a mixed library.
export const BOOK = 'book';
export const DRAMA = 'drama';
const kindOf = (value) => (value === DRAMA ? DRAMA : BOOK);

// The order the files of a book play in: the number in front of the file name
// where there is one, and the path otherwise - which is alphabetical order, and
// that is what a ripper without numbers leaves behind.
const PART_ORDER = 't.part_no IS NULL, t.part_no, t.path';

// Progress lives per track, so a part carries its own. Nothing outside this
// module sees these two numbers; they are summed into a book position below.
const PROGRESS_FIELDS = `
  (SELECT ep.position  FROM episode_progress ep
    WHERE ep.track_id = t.id AND ep.user_id = @userId) AS position,
  (SELECT ep.completed FROM episode_progress ep
    WHERE ep.track_id = t.id AND ep.user_id = @userId) AS completed,
  (SELECT ep.updated_at FROM episode_progress ep
    WHERE ep.track_id = t.id AND ep.user_id = @userId) AS touchedAt
`;

const BOOK_ROW = `
  b.id, b.title, b.cover, b.author_id AS authorId, a.name AS author,
  b.narrator, b.release_date AS releaseDate, b.year, b.kind,
  COUNT(t.id) AS partCount,
  COALESCE(SUM(t.duration), 0) AS duration
`;

const BOOK_FROM = `
  FROM audiobooks b
  LEFT JOIN authors a ON a.id = b.author_id
  LEFT JOIN tracks  t ON t.audiobook_id = b.id AND t.missing_at = ''
`;

// Every list is one library or the other, never both.
const OF_KIND = 'b.kind = @kind';

const shapeBook = (row) =>
  row && row.id
    ? {
        id: row.id,
        title: row.title,
        author: row.author || 'Unbekannter Autor',
        authorId: row.authorId,
        cover: row.cover ? `/covers/${row.cover}` : null,
        kind: row.kind || BOOK,
        // '' rather than absent: one value tells the page whether to print "Gesprochen von".
        // A radio play's cast there would read as one person reading badly.
        narrator: row.kind === DRAMA ? '' : row.narrator || '',
        releaseDate: row.releaseDate || '',
        year: row.year || null,
        duration: row.duration || 0,
        // Not for display: it lets a book with no playable file be dropped.
        parts: row.partCount || 0,
      }
    : null;

// The current part is the one touched last, not the furthest, so jumping back moves the
// position back. Every part before it counts as heard in full: part seven cannot be
// reached without playing past part six.
function placeInBook(parts) {
  const total = parts.reduce((sum, p) => sum + (p.duration || 0), 0);
  const touched = parts.filter((p) => p.touchedAt);

  // Asked before any timestamp is read: marking a book heard writes all parts in one
  // transaction, so they share the same second and there is no "last" one.
  if (parts.length && parts.every((p) => p.completed)) {
    return { total, elapsed: total, started: true, finished: true, index: parts.length - 1, offset: 0 };
  }

  // A row that says "position 0, not completed" is not progress - that is what
  // marking a book unheard leaves behind, and it means "start over".
  const started = touched.some((p) => p.completed || (p.position || 0) > 0);
  if (!started) return { total, elapsed: 0, started: false, finished: false, index: 0, offset: 0 };

  // Where the listener is: the part touched last. Equal timestamps fall back to
  // the later part, because listening only ever moves forward within a second.
  const current = touched
    .filter((p) => p.completed || (p.position || 0) > 0)
    .reduce((a, b) => (b.touchedAt > a.touchedAt
      || (b.touchedAt === a.touchedAt && parts.indexOf(b) > parts.indexOf(a)) ? b : a));
  let index = parts.indexOf(current);
  let offset = current.completed ? 0 : current.position || 0;

  // The part that was finished is behind us: the book carries on with the next
  // one. Finishing the last part finishes the book.
  if (current.completed) {
    if (index >= parts.length - 1) {
      return { total, elapsed: total, started: true, finished: true, index: parts.length - 1, offset: 0 };
    }
    index += 1;
    offset = parts[index].completed ? 0 : parts[index].position || 0;
  }

  const before = parts.slice(0, index).reduce((sum, p) => sum + (p.duration || 0), 0);
  return { total, elapsed: before + offset, started: true, finished: false, index, offset };
}

function partsOf(bookId, userId) {
  return db
    .prepare(
      `SELECT ${TRACK_FIELDS}, ${PROGRESS_FIELDS} ${TRACK_FROM}
        WHERE t.audiobook_id = @id AND ${PRESENT}
        ORDER BY ${PART_ORDER}`
    )
    .all({ id: bookId, userId })
    .map((row) => ({
      ...shapeTrack(row),
      position: row.position || 0,
      completed: !!row.completed,
      touchedAt: row.touchedAt || '',
      // Where playback of this part picks up, which is what the player reads.
      resumeAt: row.completed ? 0 : row.position || 0,
    }));
}

// --- Chapters ---------------------------------------------------------------

// One clock for the whole book: each file's marks restart at zero, so they are shifted
// by everything before. `end` is derived (next start, or the book's end) because the
// player needs both ends to draw a mark and find the chapter of a second.
const selectChapters = db.prepare(
  'SELECT idx, title, start FROM chapters WHERE track_id = ? ORDER BY idx'
);

function chaptersOf(parts) {
  const list = [];
  let before = 0;
  for (const part of parts) {
    for (const row of selectChapters.all(part.id)) {
      list.push({
        // Numbered across the whole book, which is what "Kapitel 12 von 59"
        // means to a listener - a per-file index would restart mid-book.
        index: list.length,
        title: row.title,
        start: before + row.start,
        // Which file to open and where in it, so a chapter can be jumped to
        // without the player having to work the sum back out.
        part: parts.indexOf(part),
        offset: row.start,
      });
    }
    before += part.duration || 0;
  }
  // A book whose only mark sits at second zero has no chapters worth showing -
  // that is one file with a decorative title, not a structure.
  if (list.length < 2) return [];
  return list.map((chapter, i) => ({
    ...chapter,
    end: i + 1 < list.length ? list[i + 1].start : before,
  }));
}

// --- Authors ----------------------------------------------------------------

// An author without a picture borrows one of their books', as an artist borrows an album's.
const AUTHOR_COVER = `COALESCE(NULLIF(a.cover, ''),
    (SELECT b2.cover FROM audiobooks b2
      WHERE b2.author_id = a.id AND b2.kind = @kind AND b2.cover <> ''
      ORDER BY b2.title LIMIT 1))`;

// An author of both books and plays stands in each list with that library's works only;
// the join carries the kind, so one with nothing of it counts zero and the HAVING drops them.
export function listAuthors(kind) {
  return db
    .prepare(
      `SELECT a.id, a.name, ${AUTHOR_COVER} AS cover,
              COUNT(DISTINCT b.id) AS bookCount,
              COALESCE(SUM(t.duration), 0) AS duration
         FROM authors a
         LEFT JOIN audiobooks b ON b.author_id = a.id AND b.kind = @kind
         LEFT JOIN tracks t ON t.audiobook_id = b.id AND t.missing_at = ''
        GROUP BY a.id
       HAVING bookCount > 0
        ORDER BY a.name COLLATE NOCASE ASC`
    )
    .all({ kind: kindOf(kind) })
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

export function getAuthor(id, userId, kind) {
  const author = db.prepare('SELECT id, name, cover FROM authors WHERE id = ?').get(id);
  if (!author) return null;
  const books = db
    .prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} WHERE b.author_id = @id AND ${OF_KIND} GROUP BY b.id
               ORDER BY b.title COLLATE NOCASE`)
    .all({ id, kind: kindOf(kind) })
    .map(shapeBook)
    .filter((b) => b && b.parts > 0)
    .map((b) => ({ ...b, ...listened(b.id, userId) }));

  // The author's own picture wins over a borrowed one. `hasOwnCover` lets the edit
  // dialog offer "Entfernen" only where there is something of their own to remove.
  const borrowed = (books.find((b) => b.cover) || {}).cover || null;
  return {
    id: author.id,
    name: author.name,
    cover: author.cover ? `/covers/${author.cover}` : borrowed,
    hasOwnCover: !!author.cover,
    books,
  };
}

// The position in one book, without pulling its whole track list into a list
// view - the cards need "noch 6 Std." and nothing else.
function listened(bookId, userId) {
  const place = placeInBook(partsOf(bookId, userId));
  return { elapsed: place.elapsed, started: place.started, finished: place.finished };
}

// --- Books ------------------------------------------------------------------

export function listBooks(userId, kind) {
  return db
    .prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} WHERE ${OF_KIND} GROUP BY b.id
               ORDER BY b.title COLLATE NOCASE`)
    .all({ kind: kindOf(kind) })
    .map(shapeBook)
    .filter((b) => b && b.parts > 0)
    .map((b) => ({ ...b, ...listened(b.id, userId) }));
}

// One book, with everything the page and the player need. `parts` is for the
// player only - the page never draws it, see the note at the top.
export function getBook(id, userId) {
  const row = db.prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} WHERE b.id = @id GROUP BY b.id`).get({ id });
  const book = shapeBook(row);
  if (!book || !book.parts) return null;

  const parts = partsOf(id, userId);
  const place = placeInBook(parts);

  return {
    ...book,
    duration: place.total,
    elapsed: place.elapsed,
    remaining: Math.max(0, place.total - place.elapsed),
    started: place.started,
    finished: place.finished,
    // Which file to start with and how far into it. The player takes these two
    // and the listener sees a book carrying on where it stopped.
    resume: { index: place.index, offset: place.offset },
    // Empty when the files carry no marks; page and player then show the title and one long bar.
    chapters: chaptersOf(parts),
    parts,
  };
}

// Books that are begun and not finished, most recently listened to first. The
// row at the top of the Hoerbuecher page.
export function continueBooks(userId, limit = 12, kind) {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.audiobook_id AS id, MAX(ep.updated_at) AS touchedAt
         FROM tracks t
         JOIN audiobooks b2 ON b2.id = t.audiobook_id AND b2.kind = @kind
         JOIN episode_progress ep ON ep.track_id = t.id AND ep.user_id = @userId
        WHERE ${PRESENT_PART}
        GROUP BY t.audiobook_id
        ORDER BY touchedAt DESC`
    )
    .all({ userId, kind: kindOf(kind) });

  return rows
    .map((r) => {
      const book = db
        .prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} WHERE b.id = @id GROUP BY b.id`)
        .get({ id: r.id });
      const shaped = shapeBook(book);
      if (!shaped || !shaped.parts) return null;
      const place = placeInBook(partsOf(r.id, userId));
      return place.finished || !place.started
        ? null
        : { ...shaped, elapsed: place.elapsed, remaining: Math.max(0, place.total - place.elapsed), started: true, finished: false };
    })
    .filter(Boolean)
    .slice(0, limit);
}

// --- Marking a whole book ---------------------------------------------------

const writeProgress = db.prepare(`
  INSERT INTO episode_progress (user_id, track_id, position, completed, updated_at)
  VALUES (@userId, @trackId, 0, @completed, datetime('now'))
  ON CONFLICT(user_id, track_id) DO UPDATE
     SET position = 0, completed = excluded.completed, updated_at = excluded.updated_at
`);

// A book is heard, or it is not - and that is one decision for the whole thing,
// because the listener never sees the parts it is made of. Marking it unheard
// clears the position too: it is the request to start over.
export const setBookHeard = db.transaction((userId, bookId, heard) => {
  const parts = db
    .prepare(`SELECT t.id FROM tracks t WHERE t.audiobook_id = ? AND ${PRESENT}`)
    .all(bookId);
  if (!parts.length) return { error: 'not_found' };
  for (const part of parts) {
    writeProgress.run({ userId, trackId: part.id, completed: heard ? 1 : 0 });
  }
  return { ok: true, completed: !!heard };
});

// --- Search -----------------------------------------------------------------

// A book is looked for under its title and under its author, the same way an
// album is looked for under its title and its artist.
const BOOK_SEARCH_FIELDS = ['b.title', 'a.name'];

export function searchBooks({ userId, q = '', limit = 20, kind } = {}) {
  const list = searchWords(q);
  if (!list.length) return [];
  const where = allWordsIn(BOOK_SEARCH_FIELDS, list);

  return db
    .prepare(
      `SELECT ${BOOK_ROW}, ${scoreOf('b.title', [[['a.name'], 15]], list)} AS score ${BOOK_FROM}
        WHERE ${where.where} AND ${OF_KIND}
        GROUP BY b.id
       HAVING partCount > 0
        ORDER BY score DESC, b.title COLLATE NOCASE ASC
        LIMIT @limit`
    )
    .all({ ...where.params, ...queryParams(q), limit, kind: kindOf(kind) })
    .map(shapeBook)
    .map((b) => ({ ...b, ...listened(b.id, userId) }));
}

// How much spoken word of this kind there is, for the page head and the empty
// state.
export function audiobookStats(userId, kind) {
  const of = kindOf(kind);
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT t.audiobook_id) AS books,
              COALESCE(SUM(t.duration), 0) AS duration
         FROM tracks t
         JOIN audiobooks b ON b.id = t.audiobook_id AND ${OF_KIND}
        WHERE ${PRESENT_PART}`
    )
    .get({ kind: of });
  const authors = db
    .prepare(
      `SELECT COUNT(DISTINCT b.author_id) AS c FROM audiobooks b
        WHERE ${OF_KIND}
          AND EXISTS (SELECT 1 FROM tracks t WHERE t.audiobook_id = b.id AND t.missing_at = '')`
    )
    .get({ kind: of }).c;
  const open = listBooks(userId, of).filter((b) => !b.finished).length;
  return { ...row, authors, open };
}
