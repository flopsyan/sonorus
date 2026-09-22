// Searching inside the list that is already on screen.
//
// Ctrl+F on an album, a playlist, a genre or "Alle Songs" opens a field over
// the page and narrows that list to what matches. It is not the search in the
// top bar: that one asks the server about the whole library and takes you to a
// different page, and on a record of twelve songs it is the wrong instrument
// entirely. Florian, 2026-09-22, naming the model: "ähnlich wie Spotify es hat,
// dass, wenn man Strg+F drückt, ein Suchfeld erscheint (das davor nie zu sehen
// ist)".
//
// **Song title first, then interpret, then album.** A word that is in a title
// is almost always the one that was meant, so matches are grouped by where they
// hit and the groups are re-appended in that order. Nothing is rewritten while
// it moves: a row carries its own `data-play-index` into the unfiltered list, so
// playing one from a narrowed list still starts the list it belongs to at the
// right song.
//
// With no list on the page this does nothing at all and says so to its caller,
// which then leaves the key to the browser - on a settings page Ctrl+F should
// still find text the ordinary way.

import { icon } from './icons.js';

// Rows are hidden with the `hidden` attribute, and a `.track-row` is a grid, so
// the attribute alone would lose to the class. The rule that fixes that lives in
// the stylesheet next to the bar; this is only here to say why it is needed.

let bar = null;
let input = null;
let counter = null;
let lists = [];

// Accent-blind and case-blind: "bjork" has to find "Björk", the way the
// server's own search does.
function fold(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function cell(row, selector) {
  const el = row.querySelector(selector);
  return el ? fold(el.textContent.trim()) : '';
}

// One pass over the page, kept for as long as the field is open. Reading the
// three fields off the DOM rather than writing them into every row is what keeps
// the whole library from costing three more attributes per line.
function collect() {
  return [...document.querySelectorAll('#content .tracks')]
    .map((container) => {
      const items = [...container.querySelectorAll('.track-row.item')];
      return {
        container,
        order: items,
        rows: items.map((el) => ({
          el,
          title: cell(el, '.track-title'),
          artist: cell(el, '.track-artist'),
          album: cell(el, '.col-album'),
        })),
      };
    })
    .filter((list) => list.rows.length);
}

function restore(list) {
  list.rows.forEach((r) => r.el.removeAttribute('hidden'));
  list.container.append(...list.order);
}

function apply(query) {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  let shown = 0;
  let total = 0;

  for (const list of lists) {
    total += list.rows.length;
    if (!words.length) {
      restore(list);
      shown += list.rows.length;
      continue;
    }

    // Four buckets and not three: a query that spans two fields ("queen
    // bohemian") belongs behind the clean hits rather than nowhere.
    const groups = [[], [], [], []];
    for (const row of list.rows) {
      const all = `${row.title} ${row.artist} ${row.album}`;
      const hits = (hay) => words.every((w) => hay.includes(w));
      const rank = hits(row.title) ? 0 : hits(row.artist) ? 1 : hits(row.album) ? 2 : hits(all) ? 3 : -1;
      if (rank < 0) {
        row.el.setAttribute('hidden', '');
      } else {
        row.el.removeAttribute('hidden');
        groups[rank].push(row.el);
      }
    }
    const matched = groups.flat();
    shown += matched.length;
    // Appended after the hidden ones, which take no room, so what the reader
    // sees under the header is the ranked list.
    list.container.append(...matched);
  }

  counter.textContent = words.length ? `${shown} von ${total}` : '';
  if (words.length) {
    const content = document.getElementById('content');
    if (content) content.scrollTop = 0;
  }
}

function build() {
  bar = document.createElement('div');
  bar.className = 'find-bar';
  bar.innerHTML = `<span class="find-icon">${icon('search', 16)}</span>
    <input type="text" class="find-input" placeholder="In dieser Liste suchen"
      aria-label="In dieser Liste suchen" autocomplete="off" spellcheck="false" />
    <span class="find-count"></span>
    <button type="button" class="icon-btn icon-btn-sm find-close"
      aria-label="Suche schließen" title="Schließen">${icon('x', 15)}</button>`;
  document.body.append(bar);

  input = bar.querySelector('.find-input');
  counter = bar.querySelector('.find-count');

  input.addEventListener('input', () => apply(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  bar.querySelector('.find-close').addEventListener('click', close);
}

/**
 * Opens the field over whatever list is on the page. Answers false when there
 * is none, so the caller can leave the key alone.
 */
export function open() {
  const found = collect();
  if (!found.length) return false;
  if (!bar) build();
  lists = found;
  bar.classList.add('is-on');
  input.focus();
  input.select();
  apply(input.value);
  return true;
}

export function close() {
  if (!bar || !bar.classList.contains('is-on')) return;
  lists.forEach(restore);
  lists = [];
  bar.classList.remove('is-on');
  input.value = '';
  counter.textContent = '';
}

/**
 * The page underneath has been replaced. Nothing to put back - those rows are
 * gone - so the field simply goes away with them.
 */
export function reset() {
  if (!bar) return;
  lists = [];
  bar.classList.remove('is-on');
  input.value = '';
  counter.textContent = '';
}

export function isOpen() {
  return !!bar && bar.classList.contains('is-on');
}
