// Reading an EPUB with nothing but what Node ships.
//
// An EPUB is a zip of XHTML and `zlib` inflates its entries, so the only piece
// missing is the zip's own central directory - a hundred lines against the
// first dependency this project would take on for one file format.
//
// Deliberately no XML parser either. The three files that are read here - the
// container, the OPF and the table of contents - are machine-written and
// shallow, and the alternative is a second dependency for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

/** Extensions this library knows how to serve out of a book. */
export const RESOURCE_MIME = {
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function mimeOf(name) {
  return RESOURCE_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function readAt(fd, length, position) {
  const buf = Buffer.allocUnsafe(length);
  fs.readSync(fd, buf, 0, length, position);
  return buf;
}

/**
 * The entries of a zip and a reader for one of them.
 *
 * Only the central directory is held; an entry is inflated when it is asked
 * for. The handle owns a file descriptor and has to be closed.
 */
export function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // The end record is last, followed only by a comment of at most 64 KB.
    const tailLength = Math.min(size, 66000);
    const tail = readAt(fd, tailLength, size - tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error('Keine Zip-Struktur gefunden.');

    const count = tail.readUInt16LE(at + 10);
    const directorySize = tail.readUInt32LE(at + 12);
    const directoryAt = tail.readUInt32LE(at + 16);
    if (directoryAt === 0xffffffff) throw new Error('Zip64 wird nicht gelesen.');

    const directory = readAt(fd, directorySize, directoryAt);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= directory.length; i++) {
      if (directory.readUInt32LE(p) !== SIG_CENTRAL) break;
      const nameLength = directory.readUInt16LE(p + 28);
      entries.set(directory.toString('utf8', p + 46, p + 46 + nameLength), {
        method: directory.readUInt16LE(p + 10),
        compressed: directory.readUInt32LE(p + 20),
        size: directory.readUInt32LE(p + 24),
        header: directory.readUInt32LE(p + 42),
      });
      p += 46 + nameLength + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
    }

    const read = (name) => {
      const entry = entries.get(name);
      if (!entry) return null;
      // The local header repeats the name and carries its own extra field, so
      // the data does not start at a length the directory knows.
      const local = readAt(fd, 30, entry.header);
      const start = entry.header + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = readAt(fd, entry.compressed, start);
      return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
    };

    return { entries, read, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

// --- A very small amount of XML ----------------------------------------------

function decode(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m =
    tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) ||
    tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? decode(m[1]) : '';
}

function openingTags(xml, name) {
  return xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>`, 'gi')) || [];
}

function element(xml, name) {
  const m = xml.match(
    new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i')
  );
  return m ? m[1] : '';
}

// Decoded before the tags are cut, not after: a description is regularly
// stored as escaped HTML, and stripping first would leave the markup behind as
// real tags.
function plainText(xml) {
  return decode(xml).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Resolves an EPUB href against the directory its document lies in. */
function resolve(base, href) {
  const clean = decodeURIComponent(String(href).split('#')[0]);
  return path.posix.normalize(path.posix.join(base, clean)).replace(/^\/+/, '');
}

// --- The book ----------------------------------------------------------------

/**
 * Opens a book: its metadata, the order its documents are read in, and the
 * table of contents. The handle owns a file descriptor and has to be closed.
 */
export function openEpub(file) {
  const zip = openZip(file);
  try {
    const container = zip.read('META-INF/container.xml')?.toString('utf8') || '';
    const opfPath = attr(openingTags(container, 'rootfile')[0] || '', 'full-path');
    if (!opfPath) throw new Error('Das Buch nennt keine OPF-Datei.');
    const opf = zip.read(opfPath)?.toString('utf8');
    if (!opf) throw new Error('Die OPF-Datei fehlt im Buch.');
    const root = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);

    const metadata = element(opf, 'metadata');
    const meta = {
      title: plainText(element(metadata, 'title')),
      author: plainText(element(metadata, 'creator')),
      language: plainText(element(metadata, 'language')),
      publisher: plainText(element(metadata, 'publisher')),
      // Only the day matters, and a book carries a full timestamp.
      date: plainText(element(metadata, 'date')).slice(0, 10),
      description: plainText(element(metadata, 'description')),
    };

    const manifest = new Map();
    for (const tag of openingTags(element(opf, 'manifest'), 'item')) {
      const id = attr(tag, 'id');
      if (!id) continue;
      manifest.set(id, {
        id,
        href: resolve(root, attr(tag, 'href')),
        type: attr(tag, 'media-type'),
        properties: attr(tag, 'properties'),
      });
    }

    const spineXml = element(opf, 'spine');
    const spine = openingTags(spineXml, 'itemref')
      .map((tag) => manifest.get(attr(tag, 'idref')))
      .filter((item) => item && zip.entries.has(item.href))
      .map((item, index) => ({ index, id: item.id, href: item.href }));

    return {
      file,
      root,
      meta,
      manifest,
      spine,
      toc: tableOfContents(zip, manifest, spineXml, spine),
      cover: coverName(manifest, metadata),
      read: zip.read,
      has: (name) => zip.entries.has(name),
      close: zip.close,
    };
  } catch (error) {
    zip.close();
    throw error;
  }
}

/**
 * The chapter list, as an index into the spine.
 *
 * EPUB 3 keeps it in a nav document and EPUB 2 in an NCX; both are read,
 * because a book from 2011 is as likely as one from last year. An entry that
 * points at a document the spine does not have is dropped rather than guessed
 * at.
 */
function tableOfContents(zip, manifest, spineXml, spine) {
  const bySpine = new Map(spine.map((item) => [item.href, item.index]));
  const found = [];

  const nav = [...manifest.values()].find((item) => /\bnav\b/.test(item.properties));
  if (nav) {
    const xml = zip.read(nav.href)?.toString('utf8') || '';
    const toc = xml.match(/<nav\b[^>]*epub:type\s*=\s*"[^"]*\btoc\b[^"]*"[^>]*>([\s\S]*?)<\/nav>/i);
    const base = path.posix.dirname(nav.href);
    for (const link of (toc?.[1] || '').match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []) {
      const href = attr(link, 'href');
      if (href) found.push({ title: plainText(link), href: resolve(base, href) });
    }
  }

  if (found.length === 0) {
    const ncx = manifest.get(attr(spineXml, 'toc'));
    if (ncx) {
      const xml = zip.read(ncx.href)?.toString('utf8') || '';
      const base = path.posix.dirname(ncx.href);
      for (const point of xml.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) || []) {
        const href = attr(openingTags(point, 'content')[0] || '', 'src');
        if (href) found.push({ title: plainText(element(point, 'text')), href: resolve(base, href) });
      }
    }
  }

  const seen = new Set();
  return found
    .map((entry) => ({ title: entry.title, index: bySpine.get(entry.href) }))
    .filter((entry) => {
      if (entry.index === undefined || seen.has(entry.index)) return false;
      seen.add(entry.index);
      return true;
    });
}

/** The cover image, named the EPUB 3 way or the EPUB 2 way. */
function coverName(manifest, metadata) {
  const marked = [...manifest.values()].find((item) => /\bcover-image\b/.test(item.properties));
  if (marked) return marked.href;
  const named = openingTags(metadata, 'meta').find((tag) => attr(tag, 'name') === 'cover');
  if (!named) return '';
  const id = attr(named, 'content');
  // Written as an id by the standard and as a file name by some tools.
  return manifest.get(id)?.href || [...manifest.values()].find((i) => i.id === id)?.href || '';
}

/**
 * What the scanner keeps about a book. Reads the whole file once, so nothing
 * is left open.
 */
export function readEpub(file) {
  const book = openEpub(file);
  try {
    const cover = book.cover ? book.read(book.cover) : null;
    return {
      ...book.meta,
      chapters: book.toc.length,
      documents: book.spine.length,
      cover: cover ? { data: cover, mime: mimeOf(book.cover) } : null,
    };
  } finally {
    book.close();
  }
}
