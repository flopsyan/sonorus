// Rendering helpers shared by every view: escaping, artwork, star widgets,
// track lists, plus the small overlays (toast, modal, confirm, context menu).

import { icon, paintIcons } from './icons.js';
import { duration, releaseDate } from './format.js';

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

// A 2x2 mosaic of four covers, used wherever a collection has no artwork of its
// own: a playlist, a star playlist, a genre.
//
// Below four it falls back to the first cover alone, the way the genre cards
// have always looked, and without any cover at all to the typographic panel.
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

// The cover of each of the first four records in a track list, in the order the
// list has them. It counts *albums*, not songs: four songs off one record would
// otherwise show the same cover four times, which says nothing about what is in
// the list - so a record only ever contributes its first track, and a single,
// which belongs to no album, stands for itself.
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

// The episodes of one show. Built out of the same `.track-row.item` as a song,
// on purpose and not by accident: clicking a row to play it, the long press
// that opens its menu, the right-click, and the equaliser that marks what is
// playing are all wired to that class in app.js, and an episode wants every one
// of them. Only the cells differ, because the questions differ - a song asks
// which album and how many stars, an episode asks how much of it is left.
// `offset` is where this list starts inside the page's own track list. Only the
// search page needs it, where the episodes sit behind the songs in one array
// and data-play-index has to point at the right entry of it.
//
// `showName` names the podcast on every row. Off inside one show, where the
// page already says which one it is; on wherever the list spans several -
// "Weiterhören" and the search results.
export function episodeList(episodes, { offset = 0, showName = false } = {}) {
  if (!episodes.length) return '';

  const rows = episodes
    .map((ep, i) => {
      const gone = !!ep.missing;
      const at = offset + i;
      const shown = ep.episodeNo != null ? ep.episodeNo : at + 1;
      const left = Math.max(0, (ep.duration || 0) - (ep.position || 0));
      // Three states, and each says something the other two do not: finished,
      // part-way through with the rest named, or untouched.
      const state = ep.completed
        ? `<span class="ep-done">${icon('check-circle', 14)}<span class="ep-word">Gehört</span></span>`
        : ep.position > 0 && ep.duration
          ? // The width goes on as a data attribute and is applied by the view's
            // `after` hook: the CSP is style-src 'self', so an inline style
            // attribute is simply dropped and the bar would stay at zero. Same
            // construction as the scan progress in the settings.
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

// `covers` is the collection case: a card for something that has no artwork of
// its own carries the covers of what is in it, the same mosaic as its page.
export function card({ href, cover, covers, title, sub, round = false, playAction }) {
  return `<a class="card${round ? ' round' : ''}" href="${esc(href)}" data-link>
      <span class="card-art">
        ${covers ? coverMosaic(covers, title) : art(cover, title)}
        ${playAction ? `<button type="button" class="card-play" ${playAction} aria-label="${esc(title)} abspielen">${icon('play', 17)}</button>` : ''}
      </span>
      <span class="card-title">${esc(title)}</span>
      ${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}
    </a>`;
}

// The same thing as a row instead of a tile: one line per entry, built to the
// height of a track row so a list of albums reads like a list of songs. Takes
// exactly what `card` takes, plus the count that sits on the right.
export function listRow({ href, cover, covers, title, sub, meta, round = false, playAction }) {
  return `<a class="list-row" href="${esc(href)}" data-link>
      <span class="list-art${round ? ' round' : ''}">${covers ? coverMosaic(covers, title) : art(cover, title)}</span>
      <span class="list-text">
        <span class="list-title" data-clip>${esc(title)}</span>
        ${sub ? `<span class="list-sub">${esc(sub)}</span>` : ''}
      </span>
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

// Everything in here lies over the page, and on a phone the back button is what
// closes that. app.js hangs its history bookkeeping into these two hooks; with
// nothing hooked in they do nothing and the overlays behave as they always did.
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

// Opens a modal and returns its root element so the caller can wire up its
// own controls. Only one modal is open at a time.
//
// `autofocus` decides whether the first field is focused. On a desktop that is
// what everybody expects; on a phone it throws the keyboard over half the
// dialog before anything has been decided, so only the dialogs that exist to be
// typed into ask for it there.
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
//
// Without a pointer there is nothing to anchor it to, and a menu of 210 px in
// the middle of a phone screen is a menu for a mouse: on a touch screen it
// comes up from the bottom edge instead, full width, over a scrim.
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
    // The press that opened the sheet is still on its way: a long press ends in
    // a synthetic click, and by then the sheet can be standing under the finger
    // that asked for it. Ignoring the first moment is what keeps that click
    // from picking an entry nobody aimed at - a little longer than the sheet
    // takes to arrive, and far shorter than a deliberate second tap.
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
  // The scrim needs no handler of its own: a tap on it is a pointerdown outside
  // the menu, which is what `onAway` already answers. Giving it a click handler
  // instead is what closed the menu the moment the long press let go - the
  // browser sends that click to whatever lies under the finger afterwards, and
  // by then the scrim does.
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
