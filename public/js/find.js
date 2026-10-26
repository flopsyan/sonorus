// Ctrl+F narrows the list already on screen (the top-bar search asks the server instead).
// Title hits rank first, a title word being almost always the one meant; each row keeps its
// `data-play-index`, so playing from a narrowed list still starts the full list at that song.

import { icon } from './icons.js';
import * as vlist from './vlist.js';

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

// One pass over the page's lists, kept for as long as the field is open. It reads
// the data, not the rows: a long list only has the rows near the viewport drawn.
function collect() {
  const content = document.getElementById('content');
  return (content ? vlist.listsIn(content) : [])
    .map((list) => ({
      list,
      rows: list.items.map((item, i) => {
        const [title, artist, album] = list.fields(item).map((text) => fold(text.trim()));
        return { i, title, artist, album };
      }),
    }))
    .filter((entry) => entry.rows.length);
}

function restore(entry) {
  if (entry.list.order) entry.list.setOrder(null);
}

function apply(query) {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  let shown = 0;
  let total = 0;

  for (const entry of lists) {
    total += entry.rows.length;
    if (!words.length) {
      restore(entry);
      shown += entry.rows.length;
      continue;
    }

    // Four buckets and not three: a query that spans two fields ("queen
    // bohemian") belongs behind the clean hits rather than nowhere.
    const groups = [[], [], [], []];
    for (const row of entry.rows) {
      const all = `${row.title} ${row.artist} ${row.album}`;
      const hits = (hay) => words.every((w) => hay.includes(w));
      const rank = hits(row.title) ? 0 : hits(row.artist) ? 1 : hits(row.album) ? 2 : hits(all) ? 3 : -1;
      if (rank >= 0) groups[rank].push(row.i);
    }
    const matched = groups.flat();
    shown += matched.length;
    entry.list.setOrder(matched);
  }

  counter.textContent = words.length ? `${shown} von ${total}` : '';
  if (words.length) {
    const content = document.getElementById('content');
    if (content) content.scrollTop = 0;
    vlist.update();
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
  if (isOpen()) {
    input.focus();
    input.select();
    return true;
  }
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
