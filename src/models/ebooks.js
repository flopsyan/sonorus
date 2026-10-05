// eBooks are not played, so they stay out of `tracks`, but share `authors` with the spoken word.
// Progress is a spine document plus a fraction through it, never a page: a page depends on
// font size and screen, so a stored one would land elsewhere on another device.

import fs from 'node:fs';
import path from 'node:path';

import db from '../db.js';
import { openEpub, mimeOf } from '../lib/epub.js';

const BOOK_ROW = `
  b.id, b.title, b.cover, b.author_id AS authorId, a.name AS author,
  b.language, b.publisher, b.release_date AS releaseDate, b.year,
  b.description, b.documents, b.size
`;

const BOOK_FROM = `
  FROM ebooks b
  LEFT JOIN authors a ON a.id = b.author_id
`;

const shapeBook = (row) =>
  row && row.id
    ? {
        id: row.id,
        title: row.title,
        author: row.author || 'Unbekannter Autor',
        authorId: row.authorId,
        cover: row.cover ? `/covers/${row.cover}` : null,
        language: row.language || '',
        publisher: row.publisher || '',
        releaseDate: row.releaseDate || '',
        year: row.year || null,
        description: row.description || '',
        documents: row.documents || 0,
        size: row.size || 0,
      }
    : null;

const selectProgress = db.prepare(
  'SELECT doc, ratio, finished, updated_at AS touchedAt FROM ebook_progress WHERE user_id = ? AND ebook_id = ?'
);

/**
 * Where the reader stopped. The share counts documents, roughly a chapter each, because
 * counting characters would mean unzipping the whole book to answer a list view.
 */
function placeIn(row, userId) {
  const progress = selectProgress.get(userId, row.id);
  const total = Math.max(1, row.documents || 1);
  const doc = progress ? Math.min(progress.doc, total - 1) : 0;
  const ratio = progress ? progress.ratio : 0;
  const finished = !!(progress && progress.finished);
  return {
    doc,
    ratio,
    finished,
    started: !!progress && (doc > 0 || ratio > 0 || finished),
    // 1 for a finished book however far into the last document it was left.
    read: finished ? 1 : Math.min(1, (doc + ratio) / total),
    touchedAt: progress ? progress.touchedAt : '',
  };
}

// --- Authors ------------------------------------------------------------------

// An author has no picture of their own; they borrow one of their books', the
// same way the spoken word does it. Without this the shelf is a wall of blanks,
// because the scanner only ever fills a book's cover, never an author's.
const AUTHOR_COVER = `COALESCE(NULLIF(a.cover, ''),
    (SELECT b2.cover FROM ebooks b2
      WHERE b2.author_id = a.id AND b2.cover <> ''
      ORDER BY b2.title LIMIT 1))`;

export function listAuthors() {
  return db
    .prepare(
      `SELECT a.id, a.name, ${AUTHOR_COVER} AS cover, COUNT(b.id) AS bookCount
         FROM authors a
         JOIN ebooks b ON b.author_id = a.id
        GROUP BY a.id
        ORDER BY a.name COLLATE NOCASE ASC`
    )
    .all()
    .map((r) => ({ ...r, cover: r.cover ? `/covers/${r.cover}` : null }));
}

export function getAuthor(id, userId) {
  const author = db.prepare('SELECT id, name, cover FROM authors WHERE id = ?').get(id);
  if (!author) return null;
  const books = db
    .prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} WHERE b.author_id = ? ORDER BY b.title COLLATE NOCASE`)
    .all(id)
    .map(shapeBook)
    .map((b) => ({ ...b, progress: placeIn(b, userId) }));
  if (books.length === 0) return null;

  // The author's own picture wins over one borrowed from a book.
  const borrowed = (books.find((b) => b.cover) || {}).cover || null;
  return {
    id: author.id,
    name: author.name,
    cover: author.cover ? `/covers/${author.cover}` : borrowed,
    hasOwnCover: !!author.cover,
    books,
  };
}

// --- Books --------------------------------------------------------------------

export function listBooks(userId) {
  return db
    .prepare(`SELECT ${BOOK_ROW} ${BOOK_FROM} ORDER BY b.title COLLATE NOCASE`)
    .all()
    .map(shapeBook)
    .map((b) => ({ ...b, progress: placeIn(b, userId) }));
}

/** Where an account stands in one book, without opening its file. */
export function progressOf(id, userId) {
  const row = db.prepare('SELECT id, documents FROM ebooks WHERE id = ?').get(id);
  return row ? placeIn(row, userId) : null;
}

/** Begun and not finished, most recently read first. The "Weiterlesen" row. */
export function continueBooks(userId, limit = 12) {
  return db
    .prepare(
      `SELECT ${BOOK_ROW} ${BOOK_FROM}
         JOIN ebook_progress p ON p.ebook_id = b.id AND p.user_id = @userId
        WHERE p.finished = 0
        ORDER BY p.updated_at DESC`
    )
    .all({ userId })
    .map(shapeBook)
    .map((b) => ({ ...b, progress: placeIn(b, userId) }))
    .filter((b) => b.progress.started)
    .slice(0, limit);
}

/**
 * One book with its chapters, read from the file rather than the database: they change
 * only with the file, and the zip directory is a few kilobytes.
 */
export function getBook(id, userId) {
  const row = db.prepare(`SELECT ${BOOK_ROW}, b.path ${BOOK_FROM} WHERE b.id = ?`).get(id);
  const book = shapeBook(row);
  if (!book || !fs.existsSync(row.path)) return null;

  let chapters = [];
  let lengths = [];
  // The spine by position, because everything else here names a document by its
  // index and only this says which file that is.
  let spine = [];
  try {
    const epub = openEpub(row.path);
    try {
      chapters = epub.toc;
      spine = epub.spine.map((item) => item.href);
      book.documents = epub.spine.length;
      // Text per document turns "page 3 of 12 in this chapter" into a page of the book.
      // Counted here, or the phone would inflate every document at every chapter.
      lengths = epub.spine.map((item) => textLength(epub.read(item.href)));
    } finally {
      epub.close();
    }
  } catch {
    // A file that cannot be opened still has a row worth showing; the reader
    // is what will say so.
  }
  return { ...book, chapters, spine, lengths, progress: placeIn(book, userId) };
}

/** Roughly how many characters of prose a document holds. */
function textLength(buffer) {
  if (!buffer) return 0;
  return buffer
    .toString('utf8')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

// --- Serving a document to the reader -----------------------------------------

// Static files rather than inline: the site's CSP forbids inline script and style, and a
// book's document gets its own CSP that only relaxes what an EPUB really needs.
const READER_HEAD =
  '<meta name="viewport" content="width=device-width, initial-scale=1, ' +
  'maximum-scale=1, user-scalable=no">' +
  '<link rel="stylesheet" href="/static/reader/reader.css">' +
  '<script defer src="/static/reader/reader.js"></script>';

/** What a book's own document may do: style itself and run the reader's script, never its own. */
export const READER_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Served as `text/html`, not XHTML: an XHTML parser shows a blank page at the first
 * error, and a book that displays beats one that is well-formed.
 */
export function readerDocument(buffer, language = '') {
  let html = String(buffer)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');

  // Hyphenation needs to know the language, and a chapter of an EPUB usually
  // carries none - the language lives in the book's metadata. Without it a
  // justified column tears holes instead of breaking words.
  if (language && !/<html[^>]*\slang=/i.test(html)) {
    html = html.replace(/<html\b/i, `<html lang="${language.replace(/"/g, '')}"`);
  }

  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${READER_HEAD}</head>`);
  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/<body\b[^>]*>/i, (tag) => `<head>${READER_HEAD}</head>${tag}`);
  }
  return `<!doctype html><html><head>${READER_HEAD}</head><body>${html}</body></html>`;
}

export function setProgress(userId, id, { doc, ratio, finished }) {
  const row = db.prepare('SELECT id, documents FROM ebooks WHERE id = ?').get(id);
  if (!row) return { error: 'not_found' };

  const total = Math.max(1, row.documents || 1);
  const at = Math.min(Math.max(0, Math.trunc(Number(doc) || 0)), total - 1);
  const into = Math.min(1, Math.max(0, Number(ratio) || 0));
  db.prepare(
    `INSERT INTO ebook_progress (user_id, ebook_id, doc, ratio, finished, updated_at)
     VALUES (@userId, @id, @doc, @ratio, @finished, datetime('now'))
     ON CONFLICT(user_id, ebook_id) DO UPDATE
        SET doc = excluded.doc, ratio = excluded.ratio,
            finished = excluded.finished, updated_at = excluded.updated_at`
  ).run({ userId, id, doc: at, ratio: into, finished: finished ? 1 : 0 });
  return { ok: true };
}

/**
 * The EPUB's path, not its bytes: the route sends the file, which makes the
 * offline download resumable for free.
 */
export function ebookFile(id) {
  const row = db.prepare('SELECT path, title FROM ebooks WHERE id = ?').get(id);
  if (!row || !row.path || !fs.existsSync(row.path)) return null;
  return { path: row.path, title: row.title || 'Buch' };
}

export function ebookStats() {
  const row = db
    .prepare('SELECT COUNT(*) AS books, COUNT(DISTINCT author_id) AS authors FROM ebooks')
    .get();
  return { books: row.books || 0, authors: row.authors || 0 };
}

export function searchEbooks(userId, words, limit = 10) {
  if (words.length === 0) return [];
  return listBooks(userId)
    .filter((b) => words.every((w) => `${b.title} ${b.author}`.toLowerCase().includes(w)))
    .slice(0, limit);
}

// --- Reading ------------------------------------------------------------------

/**
 * One file by its path inside the zip. The caller's path is checked against the zip's
 * own directory rather than trusted, which also makes `..` harmless.
 */
export function readResource(id, name) {
  const row = db.prepare('SELECT path, title, language FROM ebooks WHERE id = ?').get(id);
  if (!row) return null;

  const epub = openEpub(row.path);
  try {
    const clean = path.posix.normalize(name).replace(/^(\.\.\/|\/)+/, '');
    if (!epub.has(clean)) return null;
    const spine = epub.spine.find((item) => item.href === clean);
    return {
      data: epub.read(clean),
      mime: mimeOf(clean),
      document: spine ? spine.index : -1,
      spine: epub.spine,
      toc: epub.toc,
      title: row.title,
      language: row.language || '',
    };
  } finally {
    epub.close();
  }
}

/** Where a document of the spine lies inside the book, for the first open. */
export function documentHref(id, index) {
  const row = db.prepare('SELECT path FROM ebooks WHERE id = ?').get(id);
  if (!row) return null;
  const epub = openEpub(row.path);
  try {
    const at = Math.min(Math.max(0, index), Math.max(0, epub.spine.length - 1));
    return epub.spine[at] ? epub.spine[at].href : null;
  } finally {
    epub.close();
  }
}
