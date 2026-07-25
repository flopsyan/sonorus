// Rendering helpers shared by every view: escaping, artwork, star widgets,
// track lists, plus the small overlays (toast, modal, confirm, context menu).

import { icon, paintIcons } from './icons.js';
import { duration } from './format.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Everything that ends up in innerHTML goes through this. Track titles come
// from file tags, which are arbitrary text.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Artwork with a typographic fallback: the first letter over a tinted panel,
// so a library without embedded covers still looks deliberate.
export function art(src, label, alt = '') {
  if (src) return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" />`;
  const initial = String(label || '?').trim().charAt(0) || '?';
  return `<span class="art-fallback" aria-hidden="true">${esc(initial)}</span>`;
}

// A 2x2 mosaic of the first covers, used when a playlist has no artwork of its
// own. Falls back to a single cover, then to the typographic panel.
export function mosaic(tracks, label) {
  const covers = [];
  for (const track of tracks || []) {
    if (track.cover && !covers.includes(track.cover)) covers.push(track.cover);
    if (covers.length === 4) break;
  }
  if (!covers.length) return art(null, label);
  if (covers.length < 4) return `<span class="mosaic single">${art(covers[0], label)}</span>`;
  return `<span class="mosaic">${covers.map((c) => art(c, label)).join('')}</span>`;
}

// Five star buttons. Rendered 5..1 so CSS can light up "this one and lower"
// on hover (see .stars in the stylesheet).
export function stars(value, trackId, readonly = false) {
  const current = Number(value) || 0;
  const buttons = [];
  for (let n = 5; n >= 1; n -= 1) {
    const on = n <= current ? ' on' : '';
    const label = `${n} ${n === 1 ? 'Stern' : 'Sterne'}`;
    buttons.push(
      `<button type="button" class="star${on}" data-rate="${n}" data-track-id="${trackId}"
         aria-label="${label}" title="${label}">${icon(n <= current ? 'star' : 'star-outline', 15)}</button>`
    );
  }
  return `<div class="stars${readonly ? ' readonly' : ''}" data-stars-for="${trackId}"
            role="group" aria-label="Bewertung">${buttons.join('')}</div>`;
}

// --- Track list -------------------------------------------------------------

const COLUMNS = [
  { key: 'title', label: 'Titel' },
  { key: 'album', label: 'Album', cls: 'col-album' },
  { key: 'genre', label: 'Genre', cls: 'col-genre' },
  { key: 'stars', label: 'Bewertung', cls: 'col-stars' },
  { key: 'duration', label: 'Zeit', cls: 'col-time' },
];

// Singles belong to no album, so that column would stay empty for them - it
// carries their year instead, which is the one thing they have of their own.
const YEAR_COLUMN = { key: 'year', label: 'Jahr', cls: 'col-year' };

function sortHead(col, sort) {
  if (!sort) return `<span class="${col.cls || ''}">${col.label}</span>`;
  const active = sort.key === col.key;
  const caret = active ? (sort.dir === 'desc' ? '▾' : '▴') : '';
  return `<span class="${col.cls || ''}"><button type="button" class="th-sort${active ? ' active' : ''}"
     data-sort="${col.key}">${col.label}<span class="sort-caret">${caret}</span></button></span>`;
}

// options:
//   sort      { key, dir }  - renders sortable headers, or omit for a plain one
//   numbering 'index' | 'track' - running number, or the track number from tags
//   draggable true          - playlist rows that can be reordered
//   year      true          - the album column shows the year instead (singles)
export function trackList(tracks, options = {}) {
  if (!tracks.length) return '';
  const { sort = null, numbering = 'index', draggable = false, year = false } = options;

  const columns = year ? COLUMNS.map((c) => (c.key === 'album' ? YEAR_COLUMN : c)) : COLUMNS;
  const head = `<div class="track-row track-head">
      <span></span>
      ${columns.map((c) => sortHead(c, sort)).join('')}
      <span></span>
    </div>`;

  const rows = tracks
    .map((track, i) => {
      const shown = numbering === 'track' ? track.trackNo || i + 1 : i + 1;
      // A track whose file is gone keeps its rating, so it keeps its row. It is
      // greyed out, cannot be played, and says on hover where the file was.
      const gone = !!track.missing;
      return `<div class="track-row item${gone ? ' missing' : ''}" data-track-id="${track.id}" data-index="${i}"
             ${gone ? `data-missing="1" title="Datei nicht gefunden. Zuletzt hier: ${esc(track.path)}"` : ''}
             ${track.itemId ? `data-item-id="${track.itemId}"` : ''}
             ${draggable ? 'draggable="true"' : ''}>
        <span class="track-index">
          ${
            gone
              ? `<span class="num-label">${shown}</span>`
              : `<button type="button" data-play-index="${i}" aria-label="${esc(track.title)} abspielen">
                  <span class="num-label">${shown}</span>
                  <span class="play-hint">${icon('play', 13)}</span>
                </button>`
          }
        </span>
        <span class="track-main">
          <span class="track-art">${art(track.cover, track.album || track.title)}</span>
          <span class="track-text">
            <span class="track-title">${esc(track.title)}${
              gone ? ' <span class="badge gone">fehlt</span>' : ''
            }</span>
            <span class="track-artist">${
              track.artistId
                ? `<a href="/artists/${track.artistId}" data-link>${esc(track.artist)}</a>`
                : esc(track.artist)
            }</span>
          </span>
        </span>
        ${
          year
            ? `<span class="track-cell col-year num">${track.year || ''}</span>`
            : `<span class="track-cell col-album">${
                track.albumId ? `<a href="/albums/${track.albumId}" data-link>${esc(track.album)}</a>` : ''
              }</span>`
        }
        <span class="track-cell col-genre">${esc(track.genres.join(', '))}</span>
        <span class="col-stars">${stars(track.stars, track.id)}</span>
        <span class="track-time col-time">${duration(track.duration)}</span>
        <span><button type="button" class="icon-btn icon-btn-sm row-menu" data-menu-track="${track.id}"
              aria-label="Weitere Aktionen">${icon('more', 16)}</button></span>
      </div>`;
    })
    .join('');

  return `<div class="tracks">${head}${rows}</div>`;
}

// --- Cards ------------------------------------------------------------------

export function card({ href, cover, title, sub, round = false, playAction }) {
  return `<a class="card${round ? ' round' : ''}" href="${esc(href)}" data-link>
      <span class="card-art">
        ${art(cover, title)}
        ${playAction ? `<button type="button" class="card-play" ${playAction} aria-label="${esc(title)} abspielen">${icon('play', 17)}</button>` : ''}
      </span>
      <span class="card-title">${esc(title)}</span>
      ${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}
    </a>`;
}

export function empty(title, text, action = '') {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

// --- Overlays ---------------------------------------------------------------

export function toast(message, kind = '') {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${kind ? ` ${kind}` : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// Artwork at full size. Deliberately not a modal: no chrome, no title bar - the
// picture is the whole dialog. A click anywhere and Escape close it again.
export function lightbox(src, label) {
  const wrap = document.createElement('div');
  wrap.className = 'lightbox';
  wrap.innerHTML = `<img src="${esc(src)}" alt="${esc(label || '')}" />
    <button type="button" class="icon-btn lightbox-close" aria-label="Schließen">${icon('x', 20)}</button>`;
  document.body.appendChild(wrap);

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  wrap.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.lightbox-close').focus();
}

let closeModalFn = null;

// Opens a modal and returns its root element so the caller can wire up its
// own controls. Only one modal is open at a time.
export function modal({ title, body, footer = '', wide = false, onOpen }) {
  closeModal();

  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop">
      <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <h2>${esc(title)}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Schließen">${icon('x', 18)}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;

  const backdrop = root.firstElementChild;
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));

  const onKey = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', onKey);
  closeModalFn = () => {
    document.removeEventListener('keydown', onKey);
    root.innerHTML = '';
    closeModalFn = null;
  };

  paintIcons(root);
  const field = root.querySelector('input, textarea, select');
  if (field) field.focus();
  if (onOpen) onOpen(root);
  return root;
}

export function closeModal() {
  if (closeModalFn) closeModalFn();
}

// Confirmation for anything destructive. Resolves true only when the user
// picks the confirm button.
export function confirmDialog({ title, message, confirmLabel = 'Löschen', danger = true }) {
  return new Promise((resolve) => {
    let decided = false;
    const root = modal({
      title,
      body: `<p>${esc(message)}</p>`,
      footer: `<button type="button" class="btn btn-ghost" data-cancel>Abbrechen</button>
               <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
    });
    root.querySelector('[data-confirm]').addEventListener('click', () => {
      decided = true;
      closeModal();
      resolve(true);
    });
    root.querySelector('[data-cancel]').addEventListener('click', () => closeModal());
    const observer = new MutationObserver(() => {
      if (!root.firstElementChild && !decided) {
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(root, { childList: true });
  });
}

let openMenu = null;

// A context menu anchored to the pointer. `items` is a list of
// { label, icon, danger, onSelect } - a null entry draws a separator.
export function contextMenu(x, y, items) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = items
    .map((item, i) =>
      item === null
        ? '<div class="dropdown-sep"></div>'
        : `<button type="button" class="dropdown-item${item.danger ? ' danger' : ''}" data-item="${i}">
             ${item.icon ? icon(item.icon, 16) : ''}<span>${esc(item.label)}</span>
           </button>`
    )
    .join('');
  document.body.appendChild(menu);

  // Keep the menu inside the viewport.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  menu.addEventListener('click', (e) => {
    const button = e.target.closest('[data-item]');
    if (!button) return;
    const item = items[Number(button.dataset.item)];
    closeContextMenu();
    if (item && item.onSelect) item.onSelect();
  });

  const onAway = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onAway);
    document.addEventListener('keydown', onKey);
  }, 0);

  openMenu = () => {
    document.removeEventListener('mousedown', onAway);
    document.removeEventListener('keydown', onKey);
    menu.remove();
    openMenu = null;
  };
}

export function closeContextMenu() {
  if (openMenu) openMenu();
}
