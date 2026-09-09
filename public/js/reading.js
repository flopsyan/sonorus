// The browser's half of the reading view.
//
// The page inside the frame is the same one the Android app hosts - it is
// served with the book (`public/reader/`), it does the pagination, and it talks
// to whoever hosts it through two objects: `window.Reader` going in and
// `window.SonorusReader` coming back. The frame is same-origin, so the host
// simply hangs its own object on the frame's window after the load.
//
// What differs from the app is the furniture, and deliberately: a phone hides
// its bars until the reader taps the middle of the page, because the screen is
// the book. A browser window has room, and a bar that has to be summoned with a
// click nobody would guess at is worse here than one that is simply there.

import { api } from './api.js';
import { esc } from './ui.js';

const STYLE_KEY = 'sonorus.reader.style';
const PAGES_KEY = 'sonorus.reader.pages';

const FONTS = [
  { wire: 'ubuntu', label: 'Ubuntu', css: "'Ubuntu', system-ui, sans-serif" },
  { wire: 'serif', label: 'Serif', css: "Georgia, 'Times New Roman', serif" },
  { wire: 'sans', label: 'Sans', css: "system-ui, 'Segoe UI', sans-serif" },
  { wire: 'mono', label: 'Mono', css: 'ui-monospace, monospace' },
];

const LIMITS = {
  size: { min: 6, max: 30, step: 1 },
  leading: { min: 1.2, max: 2.2, step: 0.1 },
  margin: { min: 8, max: 80, step: 2 },
};

const DEFAULT_STYLE = { font: 'ubuntu', size: 18, leading: 1.6, margin: 32 };

function loadStyle() {
  try {
    return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(STYLE_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_STYLE };
  }
}

function saveStyle(style) {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(style));
  } catch {
    /* a browser that refuses to remember still reads books */
  }
}

/**
 * The widest a line of text may get, in pixels.
 *
 * A browser window is a metre wide and a book is not: a column that filled it
 * would be a hundred characters to the line, which nobody reads twice. The
 * margin grows with the window instead, so the text stays a column and sits in
 * the middle - and the page keeps the book's own page count honest, because the
 * column is what the pagination measures.
 */
const MEASURE = 760;

/** The shape `Reader.style()` in the frame expects. */
function cssOf(style, width = 0) {
  const face = FONTS.find((f) => f.wire === style.font) || FONTS[0];
  const margin = width > 0 ? Math.max(style.margin, Math.round((width - MEASURE) / 2)) : style.margin;
  return {
    font: face.css,
    size: `${style.size}px`,
    leading: String(style.leading),
    padH: `${margin}px`,
    padV: `${style.margin + 6}px`,
  };
}

/**
 * How many pages a book has, and which one is on screen.
 *
 * The same problem the app has and the same answer: there is no page count
 * until every chapter has been laid out at this size in this window, so it is
 * measured once in a frame nobody sees and kept. Until that is done the count
 * is estimated from the character counts the server sends, calibrated against
 * whatever has been laid out already - so a book opens with a number rather
 * than with a wait.
 */
class Paging {
  constructor(book) {
    this.book = book;
    this.lengths = book.lengths && book.lengths.length === book.documents ? book.lengths : [];
    this.counts = new Array(Math.max(1, book.documents)).fill(null);
  }

  saw(doc, pages) {
    if (doc < 0 || doc >= this.counts.length || pages < 1) return false;
    if (this.counts[doc] === pages) return false;
    this.counts[doc] = pages;
    return true;
  }

  seen(doc) {
    return this.counts[doc];
  }

  load(list) {
    if (Array.isArray(list) && list.length === this.counts.length) this.counts = list.slice();
  }

  complete() {
    return this.counts.every((c) => c !== null) ? this.counts.slice() : null;
  }

  forget() {
    this.counts = new Array(this.counts.length).fill(null);
  }

  charsPerPage() {
    if (!this.lengths.length) return 1400;
    let chars = 0;
    let pages = 0;
    this.counts.forEach((measured, i) => {
      if (measured !== null) {
        chars += this.lengths[i] || 0;
        pages += measured;
      }
    });
    return chars > 0 && pages > 0 ? Math.max(1, chars / pages) : 1400;
  }

  pagesOf(doc) {
    if (this.counts[doc] !== null && this.counts[doc] !== undefined) return this.counts[doc];
    const chars = this.lengths[doc];
    if (chars === undefined) return 1;
    return Math.max(1, Math.round(chars / this.charsPerPage()));
  }

  total() {
    let sum = 0;
    for (let i = 0; i < this.counts.length; i += 1) sum += this.pagesOf(i);
    return Math.max(1, sum);
  }

  before(doc) {
    let sum = 0;
    for (let i = 0; i < doc; i += 1) sum += this.pagesOf(i);
    return sum;
  }

  pageOfBook(doc, page) {
    return Math.min(this.total(), Math.max(1, this.before(doc) + page + 1));
  }

  /**
   * How far through the book, weighted by how much text each document holds
   * rather than by their number - eight one-line front-matter pages would
   * otherwise be "18 % read" before the first sentence.
   */
  share(doc, ratio) {
    if (!this.lengths.length) {
      const total = Math.max(1, this.book.documents);
      return Math.min(1, Math.max(0, (doc + ratio) / total));
    }
    const total = Math.max(1, this.lengths.reduce((a, b) => a + b, 0));
    const before = this.lengths.slice(0, doc).reduce((a, b) => a + b, 0);
    const here = (this.lengths[doc] || 0) * ratio;
    return Math.min(1, Math.max(0, (before + here) / total));
  }

  /** The reverse: the place a share of the book names. */
  placeAt(share) {
    const at = Math.min(1, Math.max(0, share));
    if (!this.lengths.length) {
      const docs = Math.max(1, this.book.documents);
      const exact = at * docs;
      const doc = Math.min(docs - 1, Math.max(0, Math.floor(exact)));
      return { doc, ratio: Math.min(1, Math.max(0, exact - doc)) };
    }
    const total = Math.max(1, this.lengths.reduce((a, b) => a + b, 0));
    let wanted = at * total;
    for (let i = 0; i < this.lengths.length; i += 1) {
      const len = this.lengths[i];
      if (wanted <= len || i === this.lengths.length - 1) {
        return { doc: i, ratio: len > 0 ? Math.min(1, Math.max(0, wanted / len)) : 0 };
      }
      wanted -= len;
    }
    return { doc: 0, ratio: 0 };
  }
}

const percent = (share) =>
  `${(Math.min(1, Math.max(0, share)) * 100).toFixed(1).replace('.', ',')} %`;

/** Everything a page count depends on, as one string. */
const pagesKey = (book, style, w, h) =>
  `${book.id}/${style.font}/${style.size}/${style.leading}/${style.margin}/${w}x${h}`;

function storedPages(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(PAGES_KEY) || '{}');
    return raw.key === key && Array.isArray(raw.pages) ? raw.pages : null;
  } catch {
    return null;
  }
}

function storePages(key, pages) {
  try {
    localStorage.setItem(PAGES_KEY, JSON.stringify({ key, pages }));
  } catch {
    /* nothing to do - the count is simply measured again next time */
  }
}

/**
 * Hangs the reading view into [root] and answers the cleanup for it.
 *
 * The whole view is one function on purpose: everything here is about one book
 * in one window, and half of it is state the other half reads on every turn.
 */
export function mountReader(root, book) {
  const frame = root.querySelector('.reader-frame');
  const measurer = root.querySelector('.reader-measure');
  if (!frame) return null;

  const paging = new Paging(book);
  const lastDoc = Math.max(0, book.documents - 1);
  let style = loadStyle();
  let doc = Math.min(lastDoc, Math.max(0, book.progress.doc || 0));
  let place = { page: 0, pages: 1, ratio: 0 };
  let enterAt = book.progress.ratio || 0;
  let enterFromEnd = false;
  let jumpBack = null;
  let jumpTimer = 0;
  let measuring = 0;
  let alive = true;

  const el = (name) => root.querySelector(`[data-reader="${name}"]`);
  const href = (i) => book.spine[i] || book.spine[0] || '';
  const chapterOf = (i) => {
    let title = '';
    for (const c of book.chapters) if (c.index <= i) title = c.title;
    return title;
  };

  const send = (keepalive = false) => {
    api
      .ebookProgress(
        book.id,
        { doc, ratio: place.ratio, finished: !!book.progress.finished },
        keepalive
      )
      .catch(() => {});
  };

  function draw() {
    const share = paging.share(doc, place.ratio);
    const bookPage = paging.pageOfBook(doc, place.page);
    const total = paging.total();
    el('page').textContent = `Seite ${bookPage} von ${total}`;
    el('share').textContent = `${percent(share)} gelesen`;
    el('chapter-page').textContent =
      `Seite ${place.page + 1} von ${place.pages} des Kapitels`;
    el('chapter').textContent = chapterOf(doc);
    const bar = el('bar');
    bar.value = String(Math.round(share * 1000));
    el('fill').style.width = `${share * 100}%`;
    // The same line the app writes into the book's own bottom margin.
    const inside = frame.contentWindow;
    if (inside && inside.Reader) {
      inside.Reader.footer(`${bookPage}/${total} (${percent(share)})`);
    }
    const back = el('back-chip');
    back.hidden = !jumpBack;
    if (jumpBack) back.textContent = `Zurück zu Seite ${jumpBack.page}`;
  }

  function rememberJump() {
    jumpBack = { doc, ratio: place.ratio, page: paging.pageOfBook(doc, place.page) };
    clearTimeout(jumpTimer);
    // Half a minute is long enough to look around after a jump and still find
    // the way home, and short enough not to become furniture.
    jumpTimer = setTimeout(() => {
      jumpBack = null;
      draw();
    }, 30000);
  }

  function open(next, { at = 0, fromEnd = false, remember = false } = {}) {
    const target = Math.min(lastDoc, Math.max(0, next));
    if (remember) rememberJump();
    send();
    if (target === doc) {
      const inside = frame.contentWindow;
      if (inside && inside.Reader) inside.Reader.goToRatio(at);
      return;
    }
    enterAt = fromEnd ? 1 : at;
    enterFromEnd = fromEnd;
    doc = target;
    frame.src = `/api/ebooks/books/${book.id}/read/${href(doc)}`;
  }

  // What the page in the frame calls back into.
  const bridge = {
    onState(json) {
      const state = JSON.parse(json);
      place = { page: state.page, pages: Math.max(1, state.pages), ratio: state.ratio };
      // The chapter on screen is a measurement too, and the first one to arrive.
      paging.saw(doc, place.pages);
      if (state.reason === 'turn') send();
      draw();
    },
    onTap() {
      /* the browser keeps its bars, so a click in the middle has nothing to do */
    },
    onEdge(where) {
      if (where === 'end') open(doc + 1, { at: 0 });
      else open(doc - 1, { fromEnd: true });
    },
    onLink(link) {
      const clean = String(link).split('#')[0];
      const target = book.spine.findIndex((h) => h.endsWith(clean));
      if (target >= 0) open(target, { at: 0, remember: true });
    },
  };

  function onFrameLoad() {
    const inside = frame.contentWindow;
    if (!inside) return;
    inside.SonorusReader = bridge;
    if (!inside.Reader) return;
    inside.Reader.style(cssOf(style, frame.clientWidth));
    if (enterFromEnd) inside.Reader.goToEnd();
    else inside.Reader.goToRatio(enterAt);
    enterFromEnd = false;
  }

  // --- Counting the whole book -------------------------------------------------

  function measureNow(win) {
    if (!win || !win.Reader || !win.Reader.measureNow) return null;
    try {
      return JSON.parse(win.Reader.measureNow());
    } catch {
      return null;
    }
  }

  function measureChapter(i) {
    return new Promise((resolve) => {
      let tries = 0;
      const ask = () => {
        if (!alive) return resolve(null);
        const win = measurer.contentWindow;
        const seen = measureNow(win);
        if (seen && (seen.fonts || tries > 12)) return resolve(Math.max(1, seen.pages));
        tries += 1;
        // Given up on: answered as null so the run is not written down as fact.
        if (tries > 25) return resolve(seen ? Math.max(1, seen.pages) : null);
        setTimeout(ask, 80);
      };
      measurer.onload = () => {
        const win = measurer.contentWindow;
        if (win && win.Reader) win.Reader.style(cssOf(style, measurer.clientWidth));
        setTimeout(ask, 60);
      };
      measurer.src = `/api/ebooks/books/${book.id}/read/${href(i)}`;
    });
  }

  async function measureBook() {
    if (!measurer) return;
    const run = (measuring += 1);
    const key = pagesKey(book, style, frame.clientWidth, frame.clientHeight);
    const kept = storedPages(key);
    if (kept) {
      paging.load(kept);
      draw();
      return;
    }
    paging.forget();
    draw();
    let failed = false;
    for (let i = 0; i < book.documents; i += 1) {
      if (!alive || run !== measuring) return;
      if (paging.seen(i) !== null) continue;
      const pages = await measureChapter(i);
      if (!pages) failed = true;
      paging.saw(i, pages || 1);
      draw();
    }
    const done = paging.complete();
    // A run that gave up on a chapter is not worth keeping: it would be read
    // back as fact every time this book is opened at this size.
    if (done && !failed && alive && run === measuring) storePages(key, done);
  }

  // --- The furniture -----------------------------------------------------------

  const turn = (forward) => {
    const inside = frame.contentWindow;
    if (!inside || !inside.Reader) return;
    if (forward) {
      if (!inside.Reader.next()) open(doc + 1, { at: 0 });
    } else if (!inside.Reader.previous()) {
      open(doc - 1, { fromEnd: true });
    }
  };

  const onKey = (event) => {
    if (event.target.closest && event.target.closest('input, select, textarea')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault();
      turn(true);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      turn(false);
    }
  };

  const applyStyle = () => {
    saveStyle(style);
    const inside = frame.contentWindow;
    if (inside && inside.Reader) inside.Reader.style(cssOf(style, frame.clientWidth));
    root.querySelectorAll('[data-font]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.font === style.font);
    });
    el('size-out').textContent = `${style.size} px`;
    el('leading-out').textContent = style.leading.toFixed(1).replace('.', ',');
    el('margin-out').textContent = `${style.margin} px`;
    measureBook();
  };

  const onClick = (event) => {
    const target = event.target;
    if (target.closest('[data-reader="prev"]')) return turn(false);
    if (target.closest('[data-reader="next"]')) return turn(true);
    if (target.closest('[data-reader="back-chip"]')) {
      const to = jumpBack;
      jumpBack = null;
      clearTimeout(jumpTimer);
      if (to) open(to.doc, { at: to.ratio });
      draw();
      return;
    }
    const chapter = target.closest('[data-chapter]');
    if (chapter) {
      open(Number(chapter.dataset.chapter), { at: 0, remember: true });
      root.querySelector('.reader-panel-chapters').hidden = true;
      return;
    }
    const panel = target.closest('[data-panel]');
    if (panel) {
      const wanted = panel.dataset.panel;
      root.querySelectorAll('.reader-panel').forEach((p) => {
        p.hidden = p.dataset.for !== wanted ? true : !p.hidden;
      });
      return;
    }
    const font = target.closest('[data-font]');
    if (font) {
      style = { ...style, font: font.dataset.font };
      applyStyle();
    }
  };

  const onInput = (event) => {
    const input = event.target;
    if (input.dataset.reader === 'bar') {
      const at = paging.placeAt(Number(input.value) / 1000);
      el('page').textContent =
        `Seite ${Math.min(paging.total(), paging.before(at.doc) + Math.round(at.ratio * (paging.pagesOf(at.doc) - 1)) + 1)} von ${paging.total()}`;
      el('fill').style.width = `${(Number(input.value) / 1000) * 100}%`;
      return;
    }
    if (input.dataset.style) {
      const key = input.dataset.style;
      style = { ...style, [key]: key === 'leading' ? Number(input.value) : Number(input.value) };
      applyStyle();
    }
  };

  const onSeek = (event) => {
    if (event.target.dataset.reader !== 'bar') return;
    const at = paging.placeAt(Number(event.target.value) / 1000);
    open(at.doc, { at: at.ratio, remember: true });
  };

  const onLeave = () => send(true);

  frame.addEventListener('load', onFrameLoad);
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onSeek);
  document.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', onLeave);

  frame.src = `/api/ebooks/books/${book.id}/read/${href(doc)}`;
  applyStyle();
  draw();

  return () => {
    alive = false;
    clearTimeout(jumpTimer);
    send(true);
    frame.removeEventListener('load', onFrameLoad);
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onSeek);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pagehide', onLeave);
  };
}

/** The markup the view hands to [mountReader]. */
export function readerHtml(book) {
  const style = loadStyle();
  const chapters = book.chapters
    .map(
      (c) =>
        `<button type="button" class="reader-chapter" data-chapter="${c.index}">${esc(
          c.title || 'Ohne Titel'
        )}</button>`
    )
    .join('');
  const fonts = FONTS.map(
    (f) =>
      `<button type="button" class="chip" data-font="${f.wire}">${esc(f.label)}</button>`
  ).join('');
  const slider = (key, value) =>
    `<input type="range" data-style="${key}" min="${LIMITS[key].min}" max="${LIMITS[key].max}"
        step="${LIMITS[key].step}" value="${value}">`;

  return `<div class="reader">
    <header class="reader-top">
      <a class="btn btn-ghost" href="/ebooks/books/${book.id}" data-link>Zurück</a>
      <div class="reader-title">
        <strong>${esc(book.title)}</strong>
        <span data-reader="chapter"></span>
      </div>
      <button type="button" class="btn btn-ghost" data-panel="chapters">Kapitel</button>
      <button type="button" class="btn btn-ghost" data-panel="font">Schrift</button>
    </header>

    <div class="reader-stage">
      <button type="button" class="reader-zone reader-zone-prev" data-reader="prev"
        aria-label="Vorherige Seite"></button>
      <iframe class="reader-frame" title="${esc(book.title)}"></iframe>
      <button type="button" class="reader-zone reader-zone-next" data-reader="next"
        aria-label="Nächste Seite"></button>
      <button type="button" class="reader-back" data-reader="back-chip" hidden></button>
      <iframe class="reader-measure" title="" aria-hidden="true" tabindex="-1"></iframe>
    </div>

    <div class="reader-panel reader-panel-chapters" data-for="chapters" hidden>${chapters}</div>
    <div class="reader-panel" data-for="font" hidden>
      <div class="reader-fonts">${fonts}</div>
      <label>Größe <span data-reader="size-out"></span>${slider('size', style.size)}</label>
      <label>Zeilenabstand <span data-reader="leading-out"></span>${slider('leading', style.leading)}</label>
      <label>Rand <span data-reader="margin-out"></span>${slider('margin', style.margin)}</label>
    </div>

    <footer class="reader-foot">
      <div class="reader-numbers">
        <span data-reader="page"></span>
        <span data-reader="share"></span>
      </div>
      <div class="reader-bar">
        <span class="reader-fill" data-reader="fill"></span>
        <input type="range" min="0" max="1000" value="0" data-reader="bar" aria-label="Im Buch springen">
      </div>
      <p class="reader-chapter-page" data-reader="chapter-page"></p>
    </footer>

  </div>`;
}
