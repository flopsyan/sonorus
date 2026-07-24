// Boot, routing, sidebar, and the wiring between the DOM and the player.
//
// Sonorus is one page on purpose: navigating between artists, albums and
// playlists must never interrupt playback, so the router swaps the contents of
// <main> and leaves the <audio> element alone.

import { api } from './api.js';
import { icon, paintIcons } from './icons.js';
import * as fmt from './format.js';
import { esc, art, stars, toast, modal, closeModal, confirmDialog, contextMenu, closeContextMenu } from './ui.js';
import * as views from './views.js';
import * as player from './player.js';

const content = document.getElementById('content');
const sidebarNav = document.getElementById('sidebar-nav');
const sidebar = document.getElementById('sidebar');

// Shell state: everything the sidebar and the account menu draw from.
const shell = {
  user: null,
  siteName: 'Sonorus',
  playlists: { folders: [], loose: [] },
  starCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  issues: 0,
};

// What the current view is showing, so the transport buttons know what to play.
let view = { tracks: [], playlistId: null, cleanup: null };

const collapsedFolders = new Set(
  JSON.parse(localStorage.getItem('sonorus-folders-collapsed') || '[]')
);

// ============================================================================
// Routing
// ============================================================================

const ROUTES = [
  [/^\/$/, views.home],
  [/^\/tracks$/, views.tracks],
  [/^\/artists$/, views.artists],
  [/^\/artists\/(\d+)$/, views.artist, ['id']],
  [/^\/albums$/, views.albums],
  [/^\/albums\/(\d+)$/, views.album, ['id']],
  [/^\/genres$/, views.genres],
  [/^\/genres\/(\d+)$/, views.genre, ['id']],
  [/^\/playlists\/(\d+)$/, views.playlist, ['id']],
  [/^\/stars\/([1-5])$/, views.starred, ['stars']],
  [/^\/search$/, views.search],
  [/^\/settings$/, views.settings],
  [/^\/profile$/, views.profile],
];

const ctx = {
  get user() {
    return shell.user;
  },
  setUser(user) {
    shell.user = user;
    renderAccount();
  },
  navigate,
  refreshShell,
};

function navigate(url, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  render();
}

async function render() {
  if (view.cleanup) {
    view.cleanup();
    view.cleanup = null;
  }
  closeContextMenu();

  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);

  const match = ROUTES.map(([pattern, handler, names]) => {
    const m = path.match(pattern);
    return m ? { handler, names, m } : null;
  }).find(Boolean);

  if (!match) {
    content.innerHTML = `<div class="empty"><h3>Seite nicht gefunden</h3><p>Diese Adresse gehört zu keiner Ansicht.</p><a class="btn btn-primary" href="/" data-link>Zur Startseite</a></div>`;
    return;
  }

  const params = { get: (k) => search.get(k) };
  (match.names || []).forEach((name, i) => {
    params[name] = match.m[i + 1];
  });

  content.innerHTML = '<div class="loading">Wird geladen …</div>';
  try {
    const result = await match.handler(params, ctx);
    view.tracks = result.tracks || [];
    view.playlistId = result.playlistId || null;
    content.innerHTML = `<div class="content-inner">${result.html}</div>`;
    document.title = result.title ? `${result.title} · ${shell.siteName}` : shell.siteName;
    paintIcons(content);
    content.scrollTop = 0;
    if (result.after) view.cleanup = result.after(content, ctx) || null;
    markPlayingRow();
  } catch (err) {
    content.innerHTML = `<div class="empty"><h3>Konnte nicht geladen werden</h3><p>${esc(err.message)}</p></div>`;
  }
  renderSidebar();
}

window.addEventListener('popstate', render);

// Any anchor marked data-link navigates without a page load.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(link.getAttribute('href'));
  sidebar.classList.remove('open');
});

// ============================================================================
// Sidebar
// ============================================================================

function navItem({ href, label, iconName, count, active, extra = '' }) {
  return `<a class="nav-item${active ? ' active' : ''}" href="${href}" data-link>
      ${iconName ? icon(iconName, 17) : ''}
      <span class="nav-label">${esc(label)}</span>
      ${count !== undefined ? `<span class="nav-count">${fmt.number(count)}</span>` : ''}
      ${extra}
    </a>`;
}

function starRow(n) {
  const filled = Array.from({ length: 5 }, (_, i) =>
    i < n ? icon('star', 12) : `<span class="off">${icon('star-outline', 12)}</span>`
  ).join('');
  return `<span class="nav-stars" aria-hidden="true">${filled}</span>`;
}

function renderSidebar() {
  const path = window.location.pathname;
  const { folders, loose } = shell.playlists;

  const library = [
    { href: '/', label: 'Start', iconName: 'home' },
    { href: '/tracks', label: 'Alle Songs', iconName: 'music' },
    { href: '/artists', label: 'Interpreten', iconName: 'user' },
    { href: '/albums', label: 'Alben', iconName: 'disc' },
    { href: '/genres', label: 'Genres', iconName: 'tag' },
  ]
    .map((item) => navItem({ ...item, active: path === item.href }))
    .join('');

  const starItems = [5, 4, 3, 2, 1]
    .map((n) =>
      `<a class="nav-item${path === `/stars/${n}` ? ' active' : ''}" href="/stars/${n}" data-link>
        ${starRow(n)}
        <span class="nav-label sr-only">${n} ${n === 1 ? 'Stern' : 'Sterne'}</span>
        <span class="nav-count push-right">${fmt.number(shell.starCounts[n] || 0)}</span>
      </a>`
    )
    .join('');

  const playlistItem = (p) =>
    navItem({
      href: `/playlists/${p.id}`,
      label: p.name,
      iconName: 'list',
      count: p.trackCount,
      active: path === `/playlists/${p.id}`,
    });

  const folderBlocks = folders
    .map(
      (f) => `<div class="folder${collapsedFolders.has(f.id) ? ' collapsed' : ''}" data-folder="${f.id}">
        <div class="folder-row">
          <button type="button" class="nav-item" data-toggle-folder="${f.id}" data-drop-folder="${f.id}">
            <span class="folder-caret">${icon('chevron-down', 15)}</span>
            <span class="nav-label">${esc(f.name)}</span>
            <span class="nav-count">${fmt.number(f.playlists.length)}</span>
          </button>
          <button type="button" class="icon-btn icon-btn-sm" data-folder-menu="${f.id}"
            data-folder-name="${esc(f.name)}" aria-label="Ordner-Menü">${icon('more', 15)}</button>
        </div>
        <div class="folder-children">${f.playlists.map(playlistItem).join('')}</div>
      </div>`
    )
    .join('');

  const hasPlaylists = folders.length || loose.length;

  sidebarNav.innerHTML = `
    <nav class="nav-group">
      <div class="nav-group-head"><span class="rack-label">Bibliothek</span></div>
      ${library}
    </nav>

    <nav class="nav-group">
      <div class="nav-group-head"><span class="rack-label">Bewertung</span></div>
      ${starItems}
    </nav>

    <nav class="nav-group">
      <div class="nav-group-head">
        <span class="rack-label">Playlists</span>
        <span class="inline-actions">
          <button type="button" class="icon-btn icon-btn-sm" data-new-folder aria-label="Neuer Ordner" title="Neuer Ordner">${icon('folder-plus', 15)}</button>
          <button type="button" class="icon-btn icon-btn-sm" data-new-playlist aria-label="Neue Playlist" title="Neue Playlist">${icon('plus', 15)}</button>
        </span>
      </div>
      ${folderBlocks}
      ${loose.map(playlistItem).join('')}
      ${hasPlaylists ? '' : '<p class="sidebar-empty">Noch keine Playlist. Lege eine an oder importiere eine CSV-Datei.</p>'}
    </nav>

    <nav class="nav-group">
      <div class="nav-group-head"><span class="rack-label">System</span></div>
      ${navItem({
        href: '/settings',
        label: 'Einstellungen',
        iconName: 'settings',
        active: path === '/settings',
        extra: shell.issues ? `<span class="nav-badge">${fmt.number(shell.issues)}</span>` : '',
      })}
    </nav>`;
}

// Refetches the parts of the shell that other actions change.
async function refreshShell() {
  try {
    const data = await api.bootstrap();
    shell.playlists = data.playlists;
    shell.starCounts = data.stars;
    shell.issues = data.issues;
    renderSidebar();
  } catch {
    // offline or logged out - the next navigation will surface it
  }
}

// --- Sidebar interactions ---------------------------------------------------

sidebarNav.addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle-folder]');
  if (toggle) {
    const id = Number(toggle.dataset.toggleFolder);
    if (collapsedFolders.has(id)) collapsedFolders.delete(id);
    else collapsedFolders.add(id);
    localStorage.setItem('sonorus-folders-collapsed', JSON.stringify([...collapsedFolders]));
    renderSidebar();
    return;
  }

  if (e.target.closest('[data-new-playlist]')) {
    promptPlaylist();
    return;
  }

  if (e.target.closest('[data-new-folder]')) {
    promptText({
      title: 'Neuer Ordner',
      label: 'Name des Ordners',
      confirmLabel: 'Ordner anlegen',
      onSubmit: async (name) => {
        await api.createFolder(name);
        await refreshShell();
        toast('Ordner angelegt.');
      },
    });
    return;
  }

  const folderMenu = e.target.closest('[data-folder-menu]');
  if (folderMenu) {
    const id = Number(folderMenu.dataset.folderMenu);
    const name = folderMenu.dataset.folderName;
    const rect = folderMenu.getBoundingClientRect();
    contextMenu(rect.left, rect.bottom + 4, [
      {
        label: 'Umbenennen',
        icon: 'edit',
        onSelect: () =>
          promptText({
            title: 'Ordner umbenennen',
            label: 'Name',
            value: name,
            confirmLabel: 'Speichern',
            onSubmit: async (value) => {
              await api.renameFolder(id, value);
              await refreshShell();
            },
          }),
      },
      {
        label: 'Ordner löschen',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: 'Ordner löschen',
            message: `Der Ordner "${name}" wird gelöscht. Die Playlists darin bleiben erhalten und rutschen nach oben in die Liste.`,
            confirmLabel: 'Ordner löschen',
          });
          if (!ok) return;
          await api.deleteFolder(id);
          await refreshShell();
          toast('Ordner gelöscht.');
        },
      },
    ]);
  }
});

// Right-click a playlist in the sidebar for rename/delete.
sidebarNav.addEventListener('contextmenu', (e) => {
  const link = e.target.closest('a[href^="/playlists/"]');
  if (!link) return;
  e.preventDefault();
  const id = Number(link.getAttribute('href').split('/').pop());
  const name = link.querySelector('.nav-label').textContent;
  playlistMenu(e.clientX, e.clientY, id, name);
});

function playlistMenu(x, y, id, name) {
  const folders = shell.playlists.folders;
  const items = [
    {
      label: 'Umbenennen',
      icon: 'edit',
      onSelect: () =>
        promptText({
          title: 'Playlist umbenennen',
          label: 'Name',
          value: name,
          confirmLabel: 'Speichern',
          onSubmit: async (value) => {
            await api.updatePlaylist(id, { name: value });
            await refreshShell();
            if (window.location.pathname === `/playlists/${id}`) render();
          },
        }),
    },
  ];

  if (folders.length) {
    items.push({
      label: 'In Ordner verschieben …',
      icon: 'folder',
      onSelect: () => promptFolderTarget(id),
    });
  }

  items.push(null, {
    label: 'Playlist löschen',
    icon: 'trash',
    danger: true,
    onSelect: async () => {
      const ok = await confirmDialog({
        title: 'Playlist löschen',
        message: `Die Playlist "${name}" wird gelöscht. Die Songs selbst bleiben in deiner Bibliothek. Das lässt sich nicht rückgängig machen.`,
        confirmLabel: 'Playlist löschen',
      });
      if (!ok) return;
      await api.deletePlaylist(id);
      await refreshShell();
      if (window.location.pathname === `/playlists/${id}`) navigate('/');
      toast('Playlist gelöscht.');
    },
  });

  contextMenu(x, y, items);
}

function promptFolderTarget(playlistId) {
  const options = [{ id: null, name: 'Kein Ordner (oberste Ebene)' }, ...shell.playlists.folders];
  modal({
    title: 'In Ordner verschieben',
    body: `<div class="picker-list">${options
      .map(
        (f) => `<button type="button" class="picker-item" data-folder="${f.id ?? ''}">
            ${icon(f.id ? 'folder' : 'list', 16)}<span>${esc(f.name)}</span>
          </button>`
      )
      .join('')}</div>`,
    onOpen(root) {
      root.querySelectorAll('[data-folder]').forEach((b) =>
        b.addEventListener('click', async () => {
          const value = b.dataset.folder;
          closeModal();
          await api.updatePlaylist(playlistId, { folderId: value ? Number(value) : null });
          await refreshShell();
        })
      );
    },
  });
}

// A small single-field dialog, used for every "give this a name" case.
function promptText({ title, label, value = '', confirmLabel = 'Anlegen', onSubmit }) {
  modal({
    title,
    body: `<form id="prompt-form">
        <div class="field">
          <label for="prompt-input">${esc(label)}</label>
          <input type="text" id="prompt-input" value="${esc(value)}" required />
        </div>
      </form>`,
    footer: `<button type="button" class="btn btn-ghost" data-close>Abbrechen</button>
             <button type="submit" form="prompt-form" class="btn btn-primary">${esc(confirmLabel)}</button>`,
    onOpen(root) {
      const input = root.querySelector('#prompt-input');
      input.select();
      root.querySelector('#prompt-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        closeModal();
        try {
          await onSubmit(text);
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    },
  });
}

function promptPlaylist(trackIds) {
  promptText({
    title: 'Neue Playlist',
    label: 'Name der Playlist',
    confirmLabel: 'Playlist anlegen',
    onSubmit: async (name) => {
      const res = await api.createPlaylist(name);
      if (trackIds && trackIds.length) {
        await api.addToPlaylist(res.playlist.id, trackIds);
        toast(`${fmt.plural(trackIds.length, 'Song', 'Songs')} zu „${name}" hinzugefügt.`);
      } else {
        toast('Playlist angelegt.');
      }
      await refreshShell();
    },
  });
}

// "Zu Playlist hinzufügen": pick an existing list, or create one on the spot.
function addToPlaylistDialog(trackIds) {
  const all = [
    ...shell.playlists.folders.flatMap((f) => f.playlists.map((p) => ({ ...p, folder: f.name }))),
    ...shell.playlists.loose.map((p) => ({ ...p, folder: '' })),
  ];

  modal({
    title: `${fmt.plural(trackIds.length, 'Song', 'Songs')} hinzufügen`,
    body: `<button type="button" class="picker-item" data-create>
        ${icon('plus-circle', 17)}<span>Neue Playlist …</span>
      </button>
      ${all.length ? '<div class="dropdown-sep"></div>' : ''}
      <div class="picker-list">${all
        .map(
          (p) => `<button type="button" class="picker-item" data-playlist="${p.id}">
              ${icon('list', 16)}
              <span>${esc(p.name)}${p.folder ? ` <span class="muted">· ${esc(p.folder)}</span>` : ''}</span>
              <span class="count">${fmt.number(p.trackCount)}</span>
            </button>`
        )
        .join('')}</div>`,
    onOpen(root) {
      root.querySelector('[data-create]').addEventListener('click', () => {
        closeModal();
        promptPlaylist(trackIds);
      });
      root.querySelectorAll('[data-playlist]').forEach((b) =>
        b.addEventListener('click', async () => {
          const id = Number(b.dataset.playlist);
          closeModal();
          try {
            const res = await api.addToPlaylist(id, trackIds);
            toast(`${fmt.plural(res.added, 'Song', 'Songs')} hinzugefügt.`);
            await refreshShell();
            if (window.location.pathname === `/playlists/${id}`) render();
          } catch (err) {
            toast(err.message, 'err');
          }
        })
      );
    },
  });
}

// ============================================================================
// Content interactions
// ============================================================================

// Loads the track list behind a "play this collection" button.
async function tracksFor(el) {
  if (el.dataset.playAlbum) return (await api.album(el.dataset.playAlbum)).album.tracks;
  if (el.dataset.playArtist) return (await api.artist(el.dataset.playArtist)).artist.tracks;
  if (el.dataset.playGenre) return (await api.genre(el.dataset.playGenre)).genre.tracks;
  if (el.dataset.playTrack) {
    const found = view.tracks.find((t) => String(t.id) === el.dataset.playTrack);
    return found ? [found] : [(await api.tracks({ q: '' })).tracks.find((t) => String(t.id) === el.dataset.playTrack)];
  }
  return view.tracks;
}

content.addEventListener('click', async (e) => {
  // Star rating
  const star = e.target.closest('[data-rate]');
  if (star) {
    e.preventDefault();
    await rate(Number(star.dataset.trackId), Number(star.dataset.rate));
    return;
  }

  // Play a specific row
  const rowPlay = e.target.closest('[data-play-index]');
  if (rowPlay) {
    const index = Number(rowPlay.dataset.playIndex);
    const track = view.tracks[index];
    if (player.currentTrack() && player.currentTrack().id === track.id) {
      player.toggle();
    } else {
      player.playTracks(view.tracks, index, document.title.split(' · ')[0]);
    }
    return;
  }

  // Collection play / shuffle buttons on cards and page heads
  const play = e.target.closest('[data-play-all], [data-play-album], [data-play-artist], [data-play-genre], [data-play-track]');
  if (play) {
    e.preventDefault();
    e.stopPropagation();
    try {
      const list = await tracksFor(play);
      if (!list || !list.length) return toast('Hier gibt es nichts zum Abspielen.', 'err');
      if (player.state.shuffle) player.setShuffle(false);
      player.playTracks(list, 0, play.closest('.card')?.querySelector('.card-title')?.textContent || '');
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }

  const shuffleAll = e.target.closest('[data-shuffle-all]');
  if (shuffleAll) {
    if (!view.tracks.length) return;
    if (!player.state.shuffle) player.setShuffle(true);
    player.playTracks(view.tracks, Math.floor(Math.random() * view.tracks.length), document.title.split(' · ')[0]);
    return;
  }

  if (e.target.closest('[data-shuffle-library]')) {
    try {
      const { tracks } = await api.shuffle(300);
      if (!tracks.length) return;
      if (!player.state.shuffle) player.setShuffle(true);
      player.playTracks(tracks, 0, 'Zufallsmix');
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }

  // Sortable column headers on "Alle Songs"
  const sortBtn = e.target.closest('[data-sort]');
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    const params = new URLSearchParams(window.location.search);
    const dir = params.get('sort') === key && params.get('dir') !== 'desc' ? 'desc' : 'asc';
    navigate(`${window.location.pathname}?sort=${key}&dir=${dir}`, { replace: true });
    return;
  }

  // Row menu
  const menu = e.target.closest('[data-menu-track]');
  if (menu) {
    const rect = menu.getBoundingClientRect();
    openTrackMenu(rect.right - 210, rect.bottom + 4, Number(menu.dataset.menuTrack));
    return;
  }

  // Playlist header actions
  const rename = e.target.closest('[data-rename-playlist]');
  if (rename) {
    const id = Number(rename.dataset.renamePlaylist);
    promptText({
      title: 'Playlist umbenennen',
      label: 'Name',
      value: document.title.split(' · ')[0],
      confirmLabel: 'Speichern',
      onSubmit: async (value) => {
        await api.updatePlaylist(id, { name: value });
        await refreshShell();
        render();
      },
    });
    return;
  }

  const del = e.target.closest('[data-delete-playlist]');
  if (del) {
    const id = Number(del.dataset.deletePlaylist);
    const ok = await confirmDialog({
      title: 'Playlist löschen',
      message: 'Die Playlist wird gelöscht. Die Songs selbst bleiben in deiner Bibliothek. Das lässt sich nicht rückgängig machen.',
      confirmLabel: 'Playlist löschen',
    });
    if (!ok) return;
    await api.deletePlaylist(id);
    await refreshShell();
    navigate('/');
  }
});

// Right-click anywhere on a track row opens the same menu.
content.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.track-row.item');
  if (!row) return;
  e.preventDefault();
  openTrackMenu(e.clientX, e.clientY, Number(row.dataset.trackId), row.dataset.itemId);
});

function openTrackMenu(x, y, trackId, itemId) {
  const track = view.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const index = view.tracks.indexOf(track);

  const items = [
    { label: 'Jetzt abspielen', icon: 'play', onSelect: () => player.playTracks(view.tracks, index) },
    { label: 'Als Nächstes spielen', icon: 'queue', onSelect: () => { player.playNext([track]); toast('Kommt als Nächstes.'); } },
    { label: 'Zur Warteschlange', icon: 'plus', onSelect: () => { player.enqueue([track]); toast('Zur Warteschlange hinzugefügt.'); } },
    null,
    { label: 'Zu Playlist hinzufügen …', icon: 'list', onSelect: () => addToPlaylistDialog([trackId]) },
  ];

  if (track.albumId) {
    items.push({ label: 'Zum Album', icon: 'disc', onSelect: () => navigate(`/albums/${track.albumId}`) });
  }
  if (track.artistId) {
    items.push({ label: 'Zum Interpreten', icon: 'user', onSelect: () => navigate(`/artists/${track.artistId}`) });
  }

  if (itemId && view.playlistId) {
    items.push(null, {
      label: 'Aus Playlist entfernen',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        await api.removeFromPlaylist(view.playlistId, itemId);
        await refreshShell();
        render();
      },
    });
  }

  contextMenu(x, y, items);
}

async function rate(trackId, value) {
  const track = view.tracks.find((t) => t.id === trackId) || player.currentTrack();
  // Clicking the star a track already has clears the rating - the usual way to
  // undo a rating without a separate control.
  const next = track && track.stars === value ? 0 : value;
  try {
    const res = await api.rate(trackId, next);
    shell.starCounts = res.counts;
    for (const t of view.tracks) if (t.id === trackId) t.stars = res.stars;
    // The player bar redraws itself through applyRating -> renderPlayer, so
    // only the widgets inside the current view are replaced here.
    player.applyRating(trackId, res.stars);
    content.querySelectorAll(`[data-stars-for="${trackId}"]`).forEach((node) => {
      node.outerHTML = stars(res.stars, trackId, node.classList.contains('readonly'));
    });
    renderSidebar();
    // The star playlists are generated, so the list you are looking at changes.
    if (window.location.pathname.startsWith('/stars/')) render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// --- Drag and drop inside a playlist ---------------------------------------

let dragIndex = null;

content.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.track-row.item[draggable="true"]');
  if (!row) return;
  dragIndex = Number(row.dataset.index);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragIndex));
});

content.addEventListener('dragover', (e) => {
  const row = e.target.closest('.track-row.item[draggable="true"]');
  if (!row || dragIndex === null) return;
  e.preventDefault();
  const rect = row.getBoundingClientRect();
  const below = e.clientY > rect.top + rect.height / 2;
  content.querySelectorAll('.drop-above, .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  row.classList.add(below ? 'drop-below' : 'drop-above');
});

content.addEventListener('dragend', () => {
  content.querySelectorAll('.dragging, .drop-above, .drop-below')
    .forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below'));
  dragIndex = null;
});

content.addEventListener('drop', async (e) => {
  const row = e.target.closest('.track-row.item[draggable="true"]');
  if (!row || dragIndex === null || !view.playlistId) return;
  e.preventDefault();

  const rect = row.getBoundingClientRect();
  const below = e.clientY > rect.top + rect.height / 2;
  let target = Number(row.dataset.index) + (below ? 1 : 0);
  if (dragIndex < target) target -= 1;

  const list = [...view.tracks];
  const [moved] = list.splice(dragIndex, 1);
  list.splice(target, 0, moved);
  dragIndex = null;

  try {
    await api.reorderPlaylist(view.playlistId, list.map((t) => t.itemId));
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ============================================================================
// Player UI
// ============================================================================

const el = {
  playBtn: document.getElementById('btn-play'),
  prevBtn: document.getElementById('btn-prev'),
  nextBtn: document.getElementById('btn-next'),
  shuffleBtn: document.getElementById('btn-shuffle'),
  repeatBtn: document.getElementById('btn-repeat'),
  muteBtn: document.getElementById('btn-mute'),
  queueBtn: document.getElementById('btn-queue'),
  visualBtn: document.getElementById('btn-visualizer'),
  volume: document.getElementById('volume'),
  seek: document.getElementById('seek'),
  seekFill: document.getElementById('seek-fill'),
  seekBuffer: document.getElementById('seek-buffer'),
  seekKnob: document.getElementById('seek-knob'),
  elapsed: document.getElementById('time-elapsed'),
  total: document.getElementById('time-total'),
  nowArt: document.getElementById('now-art'),
  nowTitle: document.getElementById('now-title'),
  nowArtist: document.getElementById('now-artist'),
  nowStars: document.getElementById('now-stars'),
  queue: document.getElementById('queue'),
  queueList: document.getElementById('queue-list'),
  queueSource: document.getElementById('queue-source'),
  meter: document.getElementById('meter'),
};

el.playBtn.addEventListener('click', () => player.toggle());
el.prevBtn.addEventListener('click', () => player.previous());
el.nextBtn.addEventListener('click', () => player.next(true));
el.shuffleBtn.addEventListener('click', () => player.setShuffle(!player.state.shuffle));
el.repeatBtn.addEventListener('click', () => player.cycleRepeat());
el.muteBtn.addEventListener('click', () => player.toggleMute());
el.volume.addEventListener('input', () => player.setVolume(Number(el.volume.value) / 100));
el.queueBtn.addEventListener('click', () => el.queue.classList.toggle('open'));
document.getElementById('queue-close').addEventListener('click', () => el.queue.classList.remove('open'));
el.visualBtn.addEventListener('click', openVisualizer);

el.nowArt.addEventListener('click', () => {
  const track = player.currentTrack();
  if (track && track.albumId) navigate(`/albums/${track.albumId}`);
});

el.nowStars.addEventListener('click', (e) => {
  const star = e.target.closest('[data-rate]');
  if (star) rate(Number(star.dataset.trackId), Number(star.dataset.rate));
});

// --- Seeking ----------------------------------------------------------------

let seeking = false;

function seekFromEvent(e) {
  const rect = el.seek.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  player.seekTo(x / rect.width);
}

el.seek.addEventListener('mousedown', (e) => {
  seeking = true;
  el.seek.classList.add('dragging');
  seekFromEvent(e);
});
window.addEventListener('mousemove', (e) => {
  if (seeking) seekFromEvent(e);
});
window.addEventListener('mouseup', () => {
  seeking = false;
  el.seek.classList.remove('dragging');
});

// Keyboard access for the rail: it is a slider, so arrows should move it.
el.seek.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 30 : 5;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    player.seekTo((player.state.currentTime + step) / (player.state.duration || 1));
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    player.seekTo((player.state.currentTime - step) / (player.state.duration || 1));
  }
});

// --- Rendering the transport ------------------------------------------------

const REPEAT_LABEL = { off: 'Wiederholen: aus', all: 'Wiederholen: alle', one: 'Wiederholen: aktueller Titel' };

// The player emits on every timeupdate, several times a second. Only the
// counter and the seek rail may be touched that often; rebuilding the track
// info, the star buttons or the queue at that rate would destroy hover, focus
// and drag state under the user's pointer. Everything else is redrawn only
// when the value behind it actually changed.
let lastPlayerKey = '';

function renderPlayer(s) {
  const track = player.currentTrack();

  // Always cheap: the transport position.
  const total = s.duration || 0;
  const percent = total ? Math.min(100, (s.currentTime / total) * 100) : 0;
  el.seekFill.style.width = `${percent}%`;
  el.seekKnob.style.left = `${percent}%`;
  el.seekBuffer.style.width = total ? `${Math.min(100, (s.buffered / total) * 100)}%` : '0%';
  el.elapsed.textContent = fmt.duration(s.currentTime);
  el.total.textContent = fmt.duration(total);
  el.seek.setAttribute('aria-valuenow', String(Math.round(percent)));
  el.seek.setAttribute('aria-valuetext', `${fmt.duration(s.currentTime)} von ${fmt.duration(total)}`);

  const key = [
    track ? track.id : 0,
    track ? track.stars : 0,
    s.playing,
    s.shuffle,
    s.repeat,
    s.muted,
    Math.round(s.volume * 100),
    s.pos,
    s.order.length,
    s.source,
  ].join('|');
  if (key === lastPlayerKey) return;
  lastPlayerKey = key;

  el.playBtn.innerHTML = icon(s.playing ? 'pause' : 'play', 19);
  el.playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Wiedergabe');
  el.playBtn.disabled = !track;

  el.shuffleBtn.classList.toggle('is-on', s.shuffle);
  el.shuffleBtn.setAttribute('aria-pressed', String(s.shuffle));
  el.repeatBtn.classList.toggle('is-on', s.repeat !== 'off');
  el.repeatBtn.classList.toggle('repeat-one', s.repeat === 'one');
  el.repeatBtn.setAttribute('aria-label', REPEAT_LABEL[s.repeat]);

  el.muteBtn.innerHTML = icon(s.muted || s.volume === 0 ? 'volume-mute' : s.volume < 0.5 ? 'volume-low' : 'volume-high', 18);
  el.muteBtn.setAttribute('aria-label', s.muted ? 'Ton einschalten' : 'Stumm schalten');
  if (document.activeElement !== el.volume) el.volume.value = String(Math.round(s.volume * 100));

  if (track) {
    el.nowArt.innerHTML = art(track.cover, track.album || track.title);
    el.nowTitle.textContent = track.title;
    el.nowArtist.innerHTML = track.artistId
      ? `<a href="/artists/${track.artistId}" data-link>${esc(track.artist)}</a>${
          track.albumId ? ` · <a href="/albums/${track.albumId}" data-link>${esc(track.album)}</a>` : ''
        }`
      : esc(track.artist);
    el.nowStars.innerHTML = starButtons(track.stars, track.id);
  } else {
    el.nowArt.innerHTML = '';
    el.nowTitle.textContent = 'Nichts ausgewählt';
    el.nowArtist.textContent = 'Wähle einen Titel aus der Bibliothek';
    el.nowStars.innerHTML = '';
  }

  markPlayingRow();
  renderQueue(s);
}

// #now-stars is itself the .stars container in the shell markup, so it takes
// the buttons only - wrapping them in a second .stars would nest the widget.
function starButtons(value, trackId) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = stars(value, trackId);
  el.nowStars.dataset.starsFor = trackId;
  return wrapper.firstElementChild.innerHTML;
}

function markPlayingRow() {
  const track = player.currentTrack();
  content.querySelectorAll('.track-row.item').forEach((row) => {
    const isPlaying = track && Number(row.dataset.trackId) === track.id;
    row.classList.toggle('playing', !!isPlaying);
    const index = row.querySelector('.track-index');
    if (!index) return;
    const existing = index.querySelector('.eq');
    if (isPlaying && !existing) {
      index.innerHTML = `<span class="eq${player.state.playing ? '' : ' paused'}"><span></span><span></span><span></span></span>`;
    } else if (isPlaying && existing) {
      existing.classList.toggle('paused', !player.state.playing);
    } else if (!isPlaying && existing) {
      const i = Number(row.dataset.index);
      const shown = view.tracks[i] ? i + 1 : '';
      index.innerHTML = `<button type="button" data-play-index="${i}" aria-label="Abspielen">
          <span class="num-label">${shown}</span>
          <span class="play-hint">${icon('play', 13)}</span>
        </button>`;
    }
  });
}

// --- Queue panel ------------------------------------------------------------

function renderQueue(s) {
  el.queueSource.textContent = s.source || 'Warteschlange';
  const list = player.orderedQueue();

  if (!list.length) {
    el.queueList.innerHTML = '<div class="empty small"><p>Die Warteschlange ist leer.</p></div>';
    return;
  }

  // "Als Nächstes" is a label between the current track and the rest, so the
  // panel reads as: what is playing, then what follows - in the real order,
  // shuffled or not.
  const nextIndex = s.pos + 1;
  const header = `<div class="queue-section rack-label">Als Nächstes${s.shuffle ? ' (gemischt)' : ''}</div>`;

  el.queueList.innerHTML = list
    .map((track, i) => {
      const isCurrent = i === s.pos;
      const position = isCurrent
        ? `<span class="eq${s.playing ? '' : ' paused'}"><span></span><span></span><span></span></span>`
        : i + 1;
      const item = `<div class="queue-item${isCurrent ? ' playing' : ''}" data-queue-index="${i}" draggable="true">
          <span class="queue-pos">${position}</span>
          <span class="queue-text">
            <span class="queue-title">${esc(track.title)}</span>
            <span class="queue-artist">${esc(track.artist)}</span>
          </span>
          <button type="button" class="icon-btn icon-btn-sm" data-queue-remove="${i}"
            aria-label="Aus der Warteschlange entfernen">${icon('x', 14)}</button>
        </div>`;
      return i === nextIndex ? header + item : item;
    })
    .join('');
}

el.queueList.addEventListener('click', (e) => {
  const remove = e.target.closest('[data-queue-remove]');
  if (remove) {
    e.stopPropagation();
    player.removeFromQueue(Number(remove.dataset.queueRemove));
    return;
  }
  const item = e.target.closest('[data-queue-index]');
  if (item) player.jumpTo(Number(item.dataset.queueIndex));
});

let queueDrag = null;
el.queueList.addEventListener('dragstart', (e) => {
  const item = e.target.closest('[data-queue-index]');
  if (!item) return;
  queueDrag = Number(item.dataset.queueIndex);
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
el.queueList.addEventListener('dragover', (e) => {
  const item = e.target.closest('[data-queue-index]');
  if (!item || queueDrag === null) return;
  e.preventDefault();
  const rect = item.getBoundingClientRect();
  el.queueList.querySelectorAll('.drop-above, .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  item.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drop-below' : 'drop-above');
});
el.queueList.addEventListener('dragend', () => {
  el.queueList.querySelectorAll('.dragging, .drop-above, .drop-below')
    .forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below'));
  queueDrag = null;
});
el.queueList.addEventListener('drop', (e) => {
  const item = e.target.closest('[data-queue-index]');
  if (!item || queueDrag === null) return;
  e.preventDefault();
  const rect = item.getBoundingClientRect();
  let target = Number(item.dataset.queueIndex) + (e.clientY > rect.top + rect.height / 2 ? 1 : 0);
  if (queueDrag < target) target -= 1;
  player.moveInQueue(queueDrag, target);
  queueDrag = null;
});

// ============================================================================
// Level meter and visualizer
// ============================================================================

const meterCtx = el.meter.getContext('2d');
let visualizerCanvas = null;

function accentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f5a524';
}

function drawBars(canvasCtx, width, height, data, barCount, mirrored) {
  canvasCtx.clearRect(0, 0, width, height);
  if (!data) return;

  const gap = Math.max(1, Math.round(width / barCount / 6));
  const barWidth = (width - gap * (barCount - 1)) / barCount;
  const color = accentColor();

  for (let i = 0; i < barCount; i += 1) {
    // The low bins carry almost all the energy in music, so sample the first
    // half of the spectrum on a curve instead of linearly.
    const t = i / barCount;
    const bin = Math.floor(t ** 1.6 * (data.length * 0.7));
    const value = data[bin] / 255;
    const barHeight = Math.max(1.5, value * height * (mirrored ? 0.5 : 1));
    const x = i * (barWidth + gap);

    canvasCtx.fillStyle = color;
    canvasCtx.globalAlpha = 0.35 + value * 0.65;
    if (mirrored) {
      canvasCtx.fillRect(x, height / 2 - barHeight, barWidth, barHeight * 2);
    } else {
      canvasCtx.fillRect(x, height - barHeight, barWidth, barHeight);
    }
  }
  canvasCtx.globalAlpha = 1;
}

function frame() {
  const data = player.state.playing ? player.levels() : null;
  drawBars(meterCtx, el.meter.width, el.meter.height, data, 18, false);

  if (visualizerCanvas) {
    const c = visualizerCanvas;
    if (c.width !== c.clientWidth * 2 || c.height !== c.clientHeight * 2) {
      c.width = c.clientWidth * 2;
      c.height = c.clientHeight * 2;
    }
    drawBars(c.getContext('2d'), c.width, c.height, data, 64, true);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function openVisualizer() {
  const track = player.currentTrack();
  const wrap = document.createElement('div');
  wrap.className = 'visualizer';
  wrap.innerHTML = `<canvas></canvas>
    <div class="visualizer-bar">
      <div>
        <div class="visualizer-title">${esc(track ? track.title : 'Nichts ausgewählt')}</div>
        <div class="visualizer-artist">${esc(track ? [track.artist, track.album].filter(Boolean).join(' · ') : '')}</div>
      </div>
      <button type="button" class="btn btn-ghost visualizer-close">${icon('x', 16)} Schließen</button>
    </div>`;
  document.body.appendChild(wrap);
  visualizerCanvas = wrap.querySelector('canvas');

  const close = () => {
    visualizerCanvas = null;
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  wrap.querySelector('.visualizer-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

// ============================================================================
// Topbar, account menu, theme, shortcuts
// ============================================================================

const searchInput = document.getElementById('search-input');
let searchTimer = null;

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  navigate(`/search?q=${encodeURIComponent(searchInput.value)}`);
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const value = searchInput.value.trim();
  searchTimer = setTimeout(() => {
    if (!value) return;
    navigate(`/search?q=${encodeURIComponent(value)}`, {
      replace: window.location.pathname === '/search',
    });
  }, 320);
});

document.getElementById('nav-back').addEventListener('click', () => window.history.back());
document.getElementById('nav-forward').addEventListener('click', () => window.history.forward());
document.getElementById('menu-toggle').addEventListener('click', () => sidebar.classList.toggle('open'));

// Theme switch
function applyTheme(choice) {
  const resolved =
    choice === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
      : choice;
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    localStorage.setItem('sonorus-theme', choice);
  } catch {
    // storage disabled - the choice just will not persist
  }
  document.querySelectorAll('[data-theme-choice]').forEach((b) =>
    b.classList.toggle('active', b.dataset.themeChoice === choice)
  );
}

document.querySelectorAll('[data-theme-choice]').forEach((b) =>
  b.addEventListener('click', () => applyTheme(b.dataset.themeChoice))
);

// Account menu
const avatarBtn = document.getElementById('avatar-btn');
const userDropdown = document.getElementById('user-dropdown');

function renderAccount() {
  const user = shell.user;
  const initial = (user.displayName || user.username).charAt(0).toUpperCase();
  const avatarInner = user.avatar ? `<img src="${esc(user.avatar)}" alt="" />` : esc(initial);
  document.getElementById('topbar-avatar').innerHTML = avatarInner;

  userDropdown.innerHTML = `<div class="dropdown-user">
      <span class="avatar avatar-md">${avatarInner}</span>
      <span class="dropdown-user-text">
        <span class="dropdown-user-name">${esc(user.displayName || user.username)}${
          user.isAdmin ? ' <span class="badge admin">Admin</span>' : ''
        }</span>
        <span class="dropdown-user-sub">@${esc(user.username)}</span>
      </span>
    </div>
    <a href="/profile" class="dropdown-item" data-link>${icon('user', 16)} Profil</a>
    <a href="/settings" class="dropdown-item" data-link>${icon('settings', 16)} Einstellungen</a>
    <button type="button" class="dropdown-item" data-shortcuts>${icon('list', 16)} Tastaturkürzel</button>
    <div class="dropdown-sep"></div>
    <form method="post" action="/logout">
      <button type="submit" class="dropdown-item danger">${icon('logout', 16)} Abmelden</button>
    </form>`;
}

avatarBtn.addEventListener('click', () => {
  const open = userDropdown.hidden;
  userDropdown.hidden = !open;
  avatarBtn.setAttribute('aria-expanded', String(open));
});

document.addEventListener('click', (e) => {
  if (!userDropdown.hidden && !e.target.closest('#user-menu')) {
    userDropdown.hidden = true;
    avatarBtn.setAttribute('aria-expanded', 'false');
  }
  if (e.target.closest('[data-shortcuts]')) showShortcuts();
});

const SHORTCUTS = [
  ['Leertaste', 'Wiedergabe / Pause'],
  ['← / →', '5 Sekunden zurück / vor'],
  ['Umschalt + ← / →', 'Vorheriger / nächster Titel'],
  ['1 – 5', 'Aktuellen Titel bewerten'],
  ['0', 'Bewertung entfernen'],
  ['S', 'Zufallswiedergabe umschalten'],
  ['R', 'Wiederholen umschalten'],
  ['M', 'Stummschalten'],
  ['Q', 'Warteschlange ein- / ausblenden'],
  ['V', 'Visualisierung'],
  ['/', 'Suche'],
];

function showShortcuts() {
  modal({
    title: 'Tastaturkürzel',
    body: `<div class="picker-list">${SHORTCUTS.map(
      ([key, what]) => `<div class="setting-row">
          <span class="setting-label">${esc(what)}</span>
          <kbd class="rack-label">${esc(key)}</kbd>
        </div>`
    ).join('')}</div>`,
    footer: '<button type="button" class="btn btn-primary" data-close>Schließen</button>',
  });
}

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('.modal-backdrop')) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      player.toggle();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) player.next(true);
      else player.seekTo((player.state.currentTime + 5) / (player.state.duration || 1));
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) player.previous();
      else player.seekTo((player.state.currentTime - 5) / (player.state.duration || 1));
      break;
    case 's':
      player.setShuffle(!player.state.shuffle);
      break;
    case 'r':
      player.cycleRepeat();
      break;
    case 'm':
      player.toggleMute();
      break;
    case 'q':
      el.queue.classList.toggle('open');
      break;
    case 'v':
      openVisualizer();
      break;
    default: {
      if (/^[0-5]$/.test(e.key)) {
        const track = player.currentTrack();
        if (track) rate(track.id, Number(e.key));
      }
    }
  }
});

// ============================================================================
// Boot
// ============================================================================

async function boot() {
  let data;
  try {
    data = await api.bootstrap();
  } catch (err) {
    content.innerHTML = `<div class="empty"><h3>Verbindung fehlgeschlagen</h3><p>${esc(err.message)}</p></div>`;
    return;
  }

  shell.user = data.user;
  shell.siteName = data.siteName;
  shell.playlists = data.playlists;
  shell.starCounts = data.stars;
  shell.issues = data.issues;

  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem('sonorus-theme');
  } catch {
    savedTheme = null;
  }
  applyTheme(['light', 'dark', 'system'].includes(savedTheme) ? savedTheme : 'dark');

  paintIcons(document);
  renderAccount();
  renderSidebar();

  player.onChange(renderPlayer);
  await player.restore(data.prefs);
  renderPlayer(player.state);

  await render();

  // A scan kicked off by the server on start finishes without anyone watching;
  // refresh the shell once it is done so the counts are right.
  if (data.scan.running) {
    const poll = setInterval(async () => {
      try {
        const { scan } = await api.scanStatus();
        if (!scan.running) {
          clearInterval(poll);
          await refreshShell();
          if (window.location.pathname === '/') render();
        }
      } catch {
        clearInterval(poll);
      }
    }, 2000);
  }
}

boot();
