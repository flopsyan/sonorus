// Audiobooks: authors, their books, and where in a book the listener is.
//
// The one idea that shapes everything here: **a book is one thing, and its
// files are not shown.** A book folder holds however many parts the ripper
// happened to produce - forty, or one - and the listener is never told. So no
// list of parts, no part titles, no per-part progress in the interface: the
// book has a length and a position in it, and the parts only decide the order
// it plays in.
//
// That means the numbers here are sums across files. Where `episode_progress`
// says "part 7 at 320 s", this module says "hour 4 of 11" - which is the only
// form the question is ever asked in.

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
  b.narrator, b.release_date AS releaseDate, b.year,
  COUNT(t.id) AS partCount,
  COALESCE(SUM(t.duration), 0) AS duration
`;

const BOOK_FROM = `
  FROM audiobooks b
  LEFT JOIN authors a ON a.id = b.author_id
  LEFT JOIN tracks  t ON t.audiobook_id = b.id AND t.missing_at = ''
`;

const shapeBook = (row) =>
  row && row.id
    ? {
        id: row.id,
        title: row.title,
        author: row.author || 'Unbekannter Autor',
        authorId: row.authorId,
        cover: row.cover ? `/covers/${row.cover}` : null,
        // Empty rather than absent: "Gesprochen von" is a line the book page
        // either prints or leaves out, and '' is the answer to both questions
        // ("who reads it" and "is there a line") in one value.
        narrator: row.narrator || '',
        releaseDate: row.releaseDate || '',
        year: row.year || null,
        duration: row.duration || 0,
        // Deliberately not called partCount anywhere the client can see it:
        // how many files a book is made of is nobody's business but the
        // player's. It is here so a book with no playable file can be dropped.
        parts: row.partCount || 0,
      }
    : null;

// Where the listener stands in one book, as one number.
//
// The current part is the one whose progress row was touched last - "where I
// am", not "the furthest I ever got", because jumping back has to move the
// position back with it. Everything before that part counts as heard in full,
// which is what makes a sum across files honest: you cannot reach part seven
// without playing past part six.
function placeInBook(parts) {
  const total = parts.reduce((sum, p) => sum + (p.duration || 0), 0);
  const touched = parts.filter((p) => p.touchedAt);

  // Every part done means the book is done, and that has to be asked before
  // anything reads a timestamp: marking a whole book heard writes all of its
  // parts in one transaction, so they carry the *same* second and there is no
  // "last" one to find.
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

// The chapters of a whole book, as one list with one clock.
//
// The rows are per file and each file's marks start at zero again, so a book of
// several parts needs every chapter shifted by the length of everything before
// it. For the ordinary Audible book - one m4b, forty hours, the marks inside -
// that sum is zero and this is a straight read; the arithmetic exists so a book
// ripped per chapter into forty files behaves the same way.
//
// `end` is filled in here rather than stored: a chapter runs until the next one
// begins, and the last one until the book does. The player needs both ends to
// draw a mark and to answer "which chapter is this second in".
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

// An author has no picture of their own; they borrow one of their books', the
// same way an interpret borrows an album's.
const AUTHOR_COVER = `COALESCE(NULLIF(a.cover, ''),
    (SELECT b2.cover FROM audiobooks b2
      WHERE b2.author_id = a.id AND b2.cover <> '' ORDER BY b2.title LIMIT 1))`;

export function listAuthors() {
  return db
    .prepare(
      `SELECT a.id, a.name, ${AUTHOR_COVER} AS cover,
              COUNT(DISTINCT b.id) AS bookCount,
              COALESCE(SUM(t.duration), 0) AS duration
         FROM authors a
         LEFT JOIN audiobooks b ON b.author_id = a.id
         LEFT JOIN tracks t ON t.audiobook_id = b.id AND t.missing_at = ''
        GROUP BY a.id
       HAVING bookCount > 0
        ORDER BY a.name COLLATE NOCASE ASC`
    )
    .all()
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

export function getAuthor(id, userId) {
  const author = db.prepare('SELECT id, name, cover FROM authors WHERE id = ?').get(id);
  if (!author) return null;
  const books = db
    .prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} WHERE b.author_id = @id GROUP BY b.id
               ORDER BY b.title COLLATE NOCASE`)
    .all({ id })
    .map(shapeBook)
    .filter((b) => b && b.parts > 0)
    .map((b) => ({ ...b, ...listened(b.id, userId) }));

  // The author's own picture wins; without one they borrow a book's, the way an
  // interpret borrows an album's. `hasOwnCover` is what lets the edit dialog
  // offer "Entfernen" only where there is something of their own to remove.
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

export function listBooks(userId) {
  return db
    .prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} GROUP BY b.id ORDER BY b.title COLLATE NOCASE`)
    .all()
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
    // Empty for a book whose files carry no marks, and the page and the player
    // both fall back to the book's own title and one long bar - which is what
    // they did before chapters existed at all.
    chapters: chaptersOf(parts),
    parts,
  };
}

// Books that are begun and not finished, most recently listened to first. The
// row at the top of the Hoerbuecher page.
export function continueBooks(userId, limit = 12) {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.audiobook_id AS id, MAX(ep.updated_at) AS touchedAt
         FROM tracks t JOIN episode_progress ep ON ep.track_id = t.id AND ep.user_id = @userId
        WHERE ${PRESENT_PART}
        GROUP BY t.audiobook_id
        ORDER BY touchedAt DESC
        LIMIT @limit`
    )
    .all({ userId, limit });

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
    .filter(Boolean);
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

export function searchBooks({ userId, q = '', limit = 20 } = {}) {
  const list = searchWords(q);
  if (!list.length) return [];
  const where = allWordsIn(BOOK_SEARCH_FIELDS, list);

  return db
    .prepare(
      `SELECT ${BOOK_ROW}, ${scoreOf('b.title', [[['a.name'], 15]], list)} AS score ${BOOK_FROM}
        WHERE ${where.where}
        GROUP BY b.id
       HAVING partCount > 0
        ORDER BY score DESC, b.title COLLATE NOCASE ASC
        LIMIT @limit`
    )
    .all({ ...where.params, ...queryParams(q), limit })
    .map(shapeBook)
    .map((b) => ({ ...b, ...listened(b.id, userId) }));
}

// How much spoken word of this kind there is, for the page head and the empty
// state.
export function audiobookStats(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT t.audiobook_id) AS books,
              COALESCE(SUM(t.duration), 0) AS duration
         FROM tracks t WHERE ${PRESENT_PART}`
    )
    .get();
  const authors = db
    .prepare(
      `SELECT COUNT(DISTINCT b.author_id) AS c FROM audiobooks b
        WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.audiobook_id = b.id AND t.missing_at = '')`
    )
    .get().c;
  const open = listBooks(userId).filter((b) => !b.finished).length;
  return { ...row, authors, open };
}
