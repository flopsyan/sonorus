// Rendering helpers shared by every view: escaping, artwork, star widgets,
// track lists, plus the small overlays (toast, modal, confirm, context menu).

import { icon, paintIcons } from './icons.js';
import { duration, releaseDate } from './format.js';
import { draft } from './pending.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Every text from data goes through this before innerHTML (numbers and server-normalised
// dates go in as they are): track titles come from file tags, which are arbitrary text.
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

// A 2x2 mosaic for a collection without artwork of its own (playlist, star playlist, genre).
// Below four covers it shows the first alone, without any the typographic panel.
export function coverMosaic(covers, label) {
  const list = (covers || []).slice(0, 4);
  if (!list.length) return art(null, label);
  if (list.length < 4) return `<span class="mosaic single">${art(list[0], label)}</span>`;
  return `<span class="mosaic">${list.map((c) => art(c, label)).join('')}</span>`;
}

// The same artwork for a collection that is at hand as its track list.
export function mosaic(tracks, label) {
  return coverMosaic(albumCovers(tracks), label);
}

// One cover per record, not per song: four songs off one album would otherwise show the
// same cover four times. A single belongs to no album and stands for itself.
function albumCovers(tracks) {
  const covers = [];
  const seen = new Set();
  for (const track of tracks || []) {
    if (!track.cover) continue;
    const record = track.albumId ? `album-${track.albumId}` : `track-${track.id}`;
    if (seen.has(record)) continue;
    seen.add(record);
    covers.push(track.cover);
    if (covers.length === 4) break;
  }
  return covers;
}

// Rendered 5..1 so CSS can light up "this one and lower" on hover (.stars in the stylesheet).
// Read-only stars are spans, not buttons: inside a card's <a> a nested button is invalid
// markup and swallows the click that should open the record.
function starRow(value, attrs, readonly) {
  const current = Number(value) || 0;
  const tag = readonly ? 'span' : 'button';
  const parts = [];
  for (let n = 5; n >= 1; n -= 1) {
    const on = n <= current ? ' on' : '';
    const label = `${n} ${n === 1 ? 'Stern' : 'Sterne'}`;
    parts.push(
      readonly
        ? `<span class="star${on}" aria-hidden="true">${icon(n <= current ? 'star' : 'star-outline', 15)}</span>`
        : `<${tag} type="button" class="star${on}" ${attrs(n)}
             aria-label="${label}" title="${label}">${icon(n <= current ? 'star' : 'star-outline', 15)}</${tag}>`
    );
  }
  return parts.join('');
}

// A rating still on its way to the server is drawn instead of `value`, marked `waiting`.
// Reading the queue here, not at the call sites, keeps that across re-render and reload.
export function stars(value, trackId, readonly = false) {
  const waiting = draft(trackId);
  const inner = starRow(
    waiting ? waiting.shown : value,
    (n) => `data-rate="${n}" data-track-id="${trackId}"`,
    readonly
  );
  return `<div class="stars${readonly ? ' readonly' : ''}${waiting ? ' waiting' : ''}"
            data-stars-for="${trackId}" role="group" aria-label="Bewertung">${inner}</div>`;
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

// `numbering` 'track' uses the tag's track number; `year` puts the year in the album column
// (singles); `draggable` is for reorderable playlist rows; without `sort` headers are plain.
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
      // Written onto the row because the number is not always the position in
      // the list: an album numbers by tag, a podcast by episode. markPlayingRow
      // rebuilds this cell when playback moves on and reads it back from here.
      const num = ` data-num="${shown}"`;
      // A track whose file is gone keeps its rating, so it keeps its row. It is
      // greyed out, cannot be played, and says on hover where the file was.
      const gone = !!track.missing;
      return `<div class="track-row item${gone ? ' missing' : ''}" data-track-id="${track.id}" data-index="${i}"${num}
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
            <span class="track-title" data-clip>${esc(track.title)}${
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

// --- Episode list -----------------------------------------------------------

// Same `.track-row.item` as a song on purpose: play on click, long press, right-click and the
// playing marker are wired to that class in app.js. `offset` is for the search page, where
// the episodes follow the songs in one array that data-play-index points into.
export function episodeList(episodes, { offset = 0, showName = false } = {}) {
  if (!episodes.length) return '';

  const rows = episodes
    .map((ep, i) => {
      const gone = !!ep.missing;
      const at = offset + i;
      const shown = ep.episodeNo != null ? ep.episodeNo : at + 1;
      const left = Math.max(0, (ep.duration || 0) - (ep.position || 0));
      const state = ep.completed
        ? `<span class="ep-done">${icon('check-circle', 14)}<span class="ep-word">Gehört</span></span>`
        : ep.position > 0 && ep.duration
          ? // The width is applied by the view's `after` hook: the CSP is style-src 'self',
            // so an inline style attribute would be dropped and the bar stay at zero.
            `<span class="ep-progress" title="Noch ${duration(left)}">
               <span class="ep-bar"><span data-progress="${Math.min(100, Math.round((ep.position / ep.duration) * 100))}"></span></span>
               <span class="ep-left">noch ${duration(left)}</span>
             </span>`
          : '';

      return `<div class="track-row item episode-row${gone ? ' missing' : ''}${ep.completed ? ' heard' : ''}"
             data-track-id="${ep.id}" data-index="${at}" data-num="${shown}"
             ${gone ? `data-missing="1" title="Datei nicht gefunden. Zuletzt hier: ${esc(ep.path)}"` : ''}>
        <span class="track-index">
          ${
            gone
              ? `<span class="num-label">${shown}</span>`
              : `<button type="button" data-play-index="${at}" aria-label="${esc(ep.title)} abspielen">
                  <span class="num-label">${shown}</span>
                  <span class="play-hint">${icon('play', 13)}</span>
                </button>`
          }
        </span>
        <span class="track-main">
          <span class="track-art">${art(ep.cover, ep.podcast || ep.title)}</span>
          <span class="track-text">
            <span class="track-title" data-clip>${esc(ep.title)}${
              gone ? ' <span class="badge gone">fehlt</span>' : ''
            }</span>
            <span class="track-artist">${
              showName && ep.podcast ? `${esc(ep.podcast)} <span class="dot">·</span> ` : ''
            }${esc(releaseDate(ep.releaseDate))}</span>
          </span>
        </span>
        <span class="episode-state">${state}</span>
        <span class="track-time col-time">${duration(ep.duration)}</span>
        <span><button type="button" class="icon-btn icon-btn-sm row-menu" data-menu-track="${ep.id}"
              aria-label="Weitere Aktionen">${icon('more', 16)}</button></span>
      </div>`;
    })
    .join('');

  return `<div class="tracks episodes">${rows}</div>`;
}

// --- Cards ------------------------------------------------------------------

// `rating` is ready-made markup because only the caller knows what is rated; it must be the
// read-only widget, as a control inside the link eats its click. `portrait` is for book
// covers, whose title at the top a square tile would crop off.
export function card({
  href, cover, covers, title, sub, round = false, portrait = false, playAction, rating = '',
}) {
  const cls = `card${round ? ' round' : ''}${portrait ? ' portrait' : ''}`;
  // A single under "Various" has no page to open, so its whole card plays instead.
  const tag = href ? 'a' : 'div';
  return `<${tag} class="${cls}" ${href ? `href="${esc(href)}" data-link` : playAction}>
      <span class="card-art">
        ${covers?.length ? coverMosaic(covers, title) : art(cover, title)}
        ${playAction ? `<button type="button" class="card-play" ${playAction} aria-label="${esc(title)} abspielen">${icon('play', 17)}</button>` : ''}
      </span>
      <span class="card-title">${esc(title)}</span>
      ${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}
      ${rating ? `<span class="card-stars">${rating}</span>` : ''}
    </${tag}>`;
}

// `card` as a row, built to a track row's height so a list of albums reads like a list of
// songs. `meta` is the count on the right.
export function listRow({ href, cover, covers, title, sub, meta, round = false, playAction, rating = '' }) {
  return `<a class="list-row" href="${esc(href)}" data-link>
      <span class="list-art${round ? ' round' : ''}">${covers?.length ? coverMosaic(covers, title) : art(cover, title)}</span>
      <span class="list-text">
        <span class="list-title" data-clip>${esc(title)}</span>
        ${sub ? `<span class="list-sub">${esc(sub)}</span>` : ''}
      </span>
      ${rating ? `<span class="list-stars">${rating}</span>` : ''}
      ${meta ? `<span class="list-meta">${esc(meta)}</span>` : ''}
      ${
        playAction
          ? `<button type="button" class="icon-btn icon-btn-sm list-play" ${playAction}
               aria-label="${esc(title)} abspielen">${icon('play', 15)}</button>`
          : '<span class="list-play-gap"></span>'
      }
    </a>`;
}

export function empty(title, text, action = '') {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

// --- Overlays ---------------------------------------------------------------

// On a phone the back button closes overlays: app.js hangs its history bookkeeping in here.
let overlayHooks = { push: () => {}, drop: () => {} };

export function setOverlayHooks(hooks) {
  overlayHooks = hooks;
}

// A finger drives this: no hover to reveal anything, and a keyboard that costs
// half the screen the moment something is focused.
const isTouch = () => window.matchMedia('(hover: none)').matches;

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
    if (!wrap.isConnected) return;
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    overlayHooks.drop('lightbox');
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  wrap.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  overlayHooks.push('lightbox', close);
  // A phone has no Escape and needs no focus ring on the way in - it taps the
  // picture to get out again.
  if (!isTouch()) wrap.querySelector('.lightbox-close').focus();
}

let closeModalFn = null;

// Only one modal is open at a time. `autofocus` defaults to off on touch, where the
// keyboard would cover half the dialog before anything is decided.
export function modal({ title, body, footer = '', wide = false, autofocus, onOpen }) {
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
    overlayHooks.drop('modal');
  };
  overlayHooks.push('modal', closeModal);

  paintIcons(root);
  const field = (autofocus === undefined ? !isTouch() : autofocus)
    ? root.querySelector('input, textarea, select')
    : null;
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
      observer.disconnect();
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

// `items` are { label, icon, danger, onSelect }, null draws a separator. On touch there is no
// pointer to anchor to, so it becomes a full-width sheet from the bottom edge.
export function contextMenu(x, y, items) {
  closeContextMenu();

  const sheet = isTouch();
  const scrim = sheet ? document.createElement('div') : null;
  if (scrim) {
    scrim.className = 'sheet-scrim';
    document.body.appendChild(scrim);
  }

  const menu = document.createElement('div');
  menu.className = `context-menu${sheet ? ' sheet' : ''}`;
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

  // Keep the menu inside the viewport. The sheet has no pointer to follow: the
  // stylesheet pins it to the bottom edge.
  if (!sheet) {
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  const openedAt = performance.now();
  menu.addEventListener('click', (e) => {
    const button = e.target.closest('[data-item]');
    if (!button) return;
    // The long press that opened the sheet ends in a synthetic click that can land on an entry;
    // 260 ms is a bit longer than the sheet takes to arrive, far shorter than a second tap.
    if (sheet && performance.now() - openedAt < 260) return;
    const item = items[Number(button.dataset.item)];
    closeContextMenu();
    if (item && item.onSelect) item.onSelect();
  });

  // pointerdown, not mousedown: on a touch screen the mouse events are
  // synthesised when the finger *lifts*, so the release of the long press that
  // opened this menu would close it again right away.
  const onAway = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeContextMenu();
  };
  // No click handler on the scrim: the long press's release click lands on it and would close
  // the menu at once. A tap on it is a pointerdown outside, which `onAway` answers.
  setTimeout(() => {
    document.addEventListener('pointerdown', onAway);
    document.addEventListener('keydown', onKey);
  }, 0);

  openMenu = () => {
    document.removeEventListener('pointerdown', onAway);
    document.removeEventListener('keydown', onKey);
    menu.remove();
    if (scrim) scrim.remove();
    openMenu = null;
    overlayHooks.drop('menu');
  };
  overlayHooks.push('menu', closeContextMenu);
}

export function closeContextMenu() {
  if (openMenu) openMenu();
}
