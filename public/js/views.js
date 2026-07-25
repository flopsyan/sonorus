// One renderer per route. Each returns { title, html } and may return an
// `after(root)` hook for wiring up controls that need more than event
// delegation (drag and drop, file pickers, polling).

import { api } from './api.js';
import { icon } from './icons.js';
import * as fmt from './format.js';
import { esc, art, mosaic, stars, trackList, card, empty, toast, modal, closeModal, confirmDialog } from './ui.js';

// --- Shared bits ------------------------------------------------------------

function pageHead(label, title, meta, actions = '') {
  return `<div class="page-head">
      <span class="rack-label">${esc(label)}</span>
      <div class="page-head-row">
        <div>
          <h1>${esc(title)}</h1>
          ${meta ? `<div class="page-meta">${meta}</div>` : ''}
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ''}
      </div>
    </div>`;
}

function detailHead({ label, title, meta, artHtml, round = false, actions }) {
  return `<div class="detail-head">
      <div class="detail-art${round ? ' round' : ''}">${artHtml}</div>
      <div class="detail-text">
        <span class="rack-label">${esc(label)}</span>
        <h1>${esc(title)}</h1>
        <div class="detail-facts">${meta}</div>
        <div class="detail-actions">${actions}</div>
      </div>
    </div>`;
}

// The two buttons every collection gets. `scope` is read back in app.js to
// know which list to hand the player.
function playActions(scope) {
  return `<button type="button" class="btn btn-primary" data-play-all="${scope}">
        ${icon('play', 16)} Abspielen
      </button>
      <button type="button" class="btn btn-ghost" data-shuffle-all="${scope}">
        ${icon('shuffle', 16)} Mischen
      </button>`;
}

function facts(parts) {
  return parts.filter(Boolean).join(' <span class="dot">·</span> ');
}

// --- Home -------------------------------------------------------------------

function shelf(title, items, more) {
  if (!items) return '';
  return `<section class="section">
      <div class="section-head">
        <h2>${esc(title)}</h2>
        ${more ? `<a class="rack-label" href="${more.href}" data-link>${esc(more.label)}</a>` : ''}
      </div>
      <div class="grid row">${items}</div>
    </section>`;
}

export async function home() {
  const data = await api.home();
  const s = data.stats;

  const readout = `<div class="readout">
      <div class="readout-cell"><span class="rack-label">Songs</span><span class="readout-value">${fmt.number(s.tracks)}</span></div>
      <div class="readout-cell"><span class="rack-label">Interpreten</span><span class="readout-value">${fmt.number(s.artists)}</span></div>
      <div class="readout-cell"><span class="rack-label">Alben</span><span class="readout-value">${fmt.number(s.albums)}</span></div>
      <div class="readout-cell"><span class="rack-label">Singles</span><span class="readout-value">${fmt.number(s.singles)}</span></div>
      <div class="readout-cell"><span class="rack-label">Genres</span><span class="readout-value">${fmt.number(s.genres)}</span></div>
      <div class="readout-cell accent"><span class="rack-label">Spielzeit</span><span class="readout-value">${esc(fmt.durationRack(s.duration))}</span></div>
    </div>`;

  if (!s.tracks) {
    return {
      title: 'Start',
      html: `${pageHead('Bibliothek', 'Sonorus', '')}
        ${empty(
          'Noch keine Musik gefunden',
          'Sonorus liest den Ordner, den du unter MUSIC_DIR eingehängt hast. Starte einen Scan, sobald dort Dateien liegen.',
          '<a href="/settings" class="btn btn-primary" data-link>Zu den Einstellungen</a>'
        )}`,
    };
  }

  const albumCards = (albums) =>
    albums
      .map((a) =>
        card({
          href: `/albums/${a.id}`,
          cover: a.cover,
          title: a.title,
          sub: a.artist,
          playAction: `data-play-album="${a.id}"`,
        })
      )
      .join('');

  const trackCards = (tracks) =>
    tracks
      .map((t) =>
        card({
          href: t.albumId ? `/albums/${t.albumId}` : `/artists/${t.artistId}`,
          cover: t.cover,
          title: t.title,
          sub: t.artist,
          playAction: `data-play-track="${t.id}"`,
        })
      )
      .join('');

  return {
    title: 'Start',
    html: `${pageHead('Bibliothek', 'Deine Sammlung', '')}
      ${readout}
      <div class="hero-actions">
        <button type="button" class="btn btn-primary" data-shuffle-library>${icon('shuffle', 16)} Zufallsmix starten</button>
        <a class="btn btn-ghost" href="/tracks" data-link>${icon('music', 16)} Alle Songs</a>
      </div>
      ${shelf('Zuletzt hinzugefügt', albumCards(data.newestAlbums), { href: '/albums', label: 'Alle Alben' })}
      ${data.recentlyPlayed.length ? shelf('Zuletzt gehört', trackCards(data.recentlyPlayed)) : ''}
      ${data.mostPlayed.length ? shelf('Am häufigsten gehört', trackCards(data.mostPlayed)) : ''}`,
  };
}

// --- All songs --------------------------------------------------------------

export async function tracks(params) {
  const sort = params.get('sort') || 'title';
  const dir = params.get('dir') || 'asc';
  const { tracks: list, total } = await api.tracks({ sort, dir, limit: 2000 });

  return {
    title: 'Alle Songs',
    tracks: list,
    html: `${pageHead('Bibliothek', 'Alle Songs', fmt.plural(total, 'Song', 'Songs'), playActions('view'))}
      ${
        list.length
          ? trackList(list, { sort: { key: sort, dir } })
          : empty('Keine Songs', 'Die Bibliothek ist leer. Starte einen Scan in den Einstellungen.')
      }`,
  };
}

// --- Artists ----------------------------------------------------------------

export async function artists() {
  const { artists: list } = await api.artists();
  return {
    title: 'Interpreten',
    html: `${pageHead('Bibliothek', 'Interpreten', fmt.plural(list.length, 'Interpret', 'Interpreten'))}
      ${
        list.length
          ? `<div class="grid">${list
              .map((a) =>
                card({
                  href: `/artists/${a.id}`,
                  cover: a.cover,
                  title: a.name,
                  sub: fmt.plural(a.trackCount, 'Song', 'Songs'),
                  round: true,
                  playAction: `data-play-artist="${a.id}"`,
                })
              )
              .join('')}</div>`
          : empty('Keine Interpreten', 'Jeder Ordner direkt im Musikordner ist ein Interpret. Starte einen Scan, sobald dort etwas liegt.')
      }`,
  };
}

export async function artist(params) {
  const { artist: data } = await api.artist(params.id);
  const total = data.tracks.reduce((sum, t) => sum + t.duration, 0);

  // Songs lying directly in the artist folder are no album, so they get a
  // folder of their own next to the albums instead of inventing one.
  const singlesCard = data.singles.length
    ? card({
        href: `/artists/${data.id}/singles`,
        cover: (data.singles.find((t) => t.cover) || {}).cover,
        title: 'Singles',
        sub: fmt.plural(data.singles.length, 'Song', 'Songs'),
        playAction: `data-play-singles="${data.id}"`,
      })
    : '';

  return {
    title: data.name,
    tracks: data.tracks,
    html: `${detailHead({
      label: 'Interpret',
      title: data.name,
      round: true,
      artHtml: art(data.albums.find((a) => a.cover)?.cover, data.name),
      meta: facts([
        fmt.plural(data.albums.length, 'Album', 'Alben'),
        data.singles.length ? fmt.plural(data.singles.length, 'Single', 'Singles') : '',
        fmt.plural(data.tracks.length, 'Song', 'Songs'),
        fmt.durationLong(total),
      ]),
      actions: playActions('view'),
    })}
      ${
        data.albums.length || singlesCard
          ? `<section class="section">
              <div class="section-head"><h2>Alben</h2></div>
              <div class="grid">${data.albums
                .map((a) =>
                  card({
                    href: `/albums/${a.id}`,
                    cover: a.cover,
                    title: a.title,
                    sub: a.year ? String(a.year) : fmt.plural(a.trackCount, 'Song', 'Songs'),
                    playAction: `data-play-album="${a.id}"`,
                  })
                )
                .join('')}${singlesCard}</div>
            </section>`
          : ''
      }
      <section class="section">
        <div class="section-head"><h2>Alle Songs</h2></div>
        ${trackList(data.tracks)}
      </section>`,
  };
}

// The singles of one artist: everything that sits directly in the artist
// folder, shown as a collection of its own without pretending to be an album.
export async function artistSingles(params) {
  const { artist: data } = await api.artist(params.id);
  const total = data.singles.reduce((sum, t) => sum + t.duration, 0);

  return {
    title: `${data.name} · Singles`,
    tracks: data.singles,
    html: `${detailHead({
      label: 'Singles',
      title: 'Singles',
      artHtml: mosaic(data.singles, 'Singles'),
      meta: facts([
        `<a href="/artists/${data.id}" data-link>${esc(data.name)}</a>`,
        fmt.plural(data.singles.length, 'Song', 'Songs'),
        fmt.durationLong(total),
      ]),
      actions: data.singles.length ? playActions('view') : '',
    })}
      ${
        data.singles.length
          ? trackList(data.singles)
          : empty(
              'Keine Singles',
              'Einzelne Dateien, die direkt im Ordner des Interpreten liegen, erscheinen hier.'
            )
      }`,
  };
}

// --- Albums -----------------------------------------------------------------

export async function albums(params) {
  const sort = params.get('sort') || 'title';
  const dir = params.get('dir') || 'asc';
  const { albums: list } = await api.albums({ sort, dir });

  const sortOptions = [
    ['title', 'Titel'],
    ['artist', 'Interpret'],
    ['year', 'Jahr'],
    ['tracks', 'Anzahl Songs'],
  ]
    .map(([key, label]) => `<option value="${key}"${key === sort ? ' selected' : ''}>${label}</option>`)
    .join('');

  return {
    title: 'Alben',
    html: `${pageHead(
      'Bibliothek',
      'Alben',
      fmt.plural(list.length, 'Album', 'Alben'),
      `<label class="sr-only" for="album-sort">Sortierung</label>
       <select id="album-sort" data-album-sort>${sortOptions}</select>`
    )}
      ${
        list.length
          ? `<div class="grid">${list
              .map((a) =>
                card({
                  href: `/albums/${a.id}`,
                  cover: a.cover,
                  title: a.title,
                  sub: a.year ? `${a.artist} · ${a.year}` : a.artist,
                  playAction: `data-play-album="${a.id}"`,
                })
              )
              .join('')}</div>`
          : empty('Keine Alben', 'Ein Album ist ein Unterordner im Ordner eines Interpreten. Dateien, die direkt beim Interpreten liegen, sind Singles.')
      }`,
    // Sorting is not a place in the history, it is the same page seen
    // differently - and the router owns the history entries, so it has to do
    // the navigating.
    after(root, ctx) {
      const select = root.querySelector('[data-album-sort]');
      if (select) {
        select.addEventListener('change', () => {
          ctx.navigate(`/albums?sort=${select.value}`, { replace: true });
        });
      }
    },
  };
}

export async function album(params) {
  const { album: data } = await api.album(params.id);
  return {
    title: data.title,
    tracks: data.tracks,
    html: `${detailHead({
      label: 'Album',
      title: data.title,
      artHtml: art(data.cover, data.title),
      meta: facts([
        data.artistId
          ? `<a href="/artists/${data.artistId}" data-link>${esc(data.artist)}</a>`
          : esc(data.artist),
        data.year ? String(data.year) : '',
        fmt.plural(data.trackCount, 'Song', 'Songs'),
        fmt.durationLong(data.duration),
      ]),
      actions: `${playActions('view')}
        <button type="button" class="btn btn-ghost" data-edit-album="${data.id}">
          ${icon('edit', 16)} Bearbeiten
        </button>`,
    })}
      ${trackList(data.tracks, { numbering: 'track' })}`,
  };
}

// --- Genres -----------------------------------------------------------------

export async function genres() {
  const { genres: list } = await api.genres();
  return {
    title: 'Genres',
    html: `${pageHead('Bibliothek', 'Genres', fmt.plural(list.length, 'Genre', 'Genres'))}
      ${
        list.length
          ? `<div class="grid">${list
              .map((g) =>
                card({
                  href: `/genres/${g.id}`,
                  cover: g.cover,
                  title: g.name,
                  sub: fmt.plural(g.trackCount, 'Song', 'Songs'),
                  playAction: `data-play-genre="${g.id}"`,
                })
              )
              .join('')}</div>`
          : empty('Keine Genres', 'Deine Dateien tragen noch keine Genre-Tags.')
      }`,
  };
}

export async function genre(params) {
  const { genre: data } = await api.genre(params.id);
  const total = data.tracks.reduce((sum, t) => sum + t.duration, 0);
  return {
    title: data.name,
    tracks: data.tracks,
    html: `${pageHead(
      'Genre',
      data.name,
      facts([fmt.plural(data.tracks.length, 'Song', 'Songs'), fmt.durationLong(total)]),
      playActions('view')
    )}
      ${trackList(data.tracks)}`,
  };
}

// --- Star playlists ---------------------------------------------------------

export async function starred(params) {
  const value = Number(params.stars);
  const { tracks: list } = await api.starred(value);
  const label = value === 0 ? 'Nicht bewertet' : `${value} ${value === 1 ? 'Stern' : 'Sterne'}`;
  const total = list.reduce((sum, t) => sum + t.duration, 0);

  return {
    title: label,
    tracks: list,
    html: `${pageHead(
      'Automatische Playlist',
      label,
      facts([fmt.plural(list.length, 'Song', 'Songs'), list.length ? fmt.durationLong(total) : '']),
      list.length ? playActions('view') : ''
    )}
      ${
        list.length
          ? trackList(list)
          : empty(
              value === 0 ? 'Alles bewertet' : `Noch nichts mit ${label} bewertet`,
              value === 0
                ? 'Jeder Song in deiner Bibliothek hat eine Bewertung. Neue Songs tauchen hier automatisch auf.'
                : 'Bewerte einen Song über die Sterne in der Titelliste oder unten im Player. Diese Playlist füllt sich dann von selbst.'
            )
      }`,
  };
}

// --- Playlist ---------------------------------------------------------------

export async function playlist(params) {
  const data = await api.playlist(params.id);
  const list = data.tracks;
  const total = list.reduce((sum, t) => sum + t.duration, 0);

  return {
    title: data.playlist.name,
    tracks: list,
    playlistId: data.playlist.id,
    html: `${detailHead({
      label: 'Playlist',
      title: data.playlist.name,
      artHtml: mosaic(list, data.playlist.name),
      meta: facts([fmt.plural(list.length, 'Song', 'Songs'), list.length ? fmt.durationLong(total) : '']),
      actions: `${list.length ? playActions('view') : ''}
        <button type="button" class="btn btn-ghost" data-rename-playlist="${data.playlist.id}">${icon('edit', 16)} Umbenennen</button>
        <button type="button" class="btn btn-quiet" data-delete-playlist="${data.playlist.id}">${icon('trash', 16)} Löschen</button>`,
    })}
      ${
        list.length
          ? trackList(list, { draggable: true })
          : empty(
              'Diese Playlist ist noch leer',
              'Füge Songs über das Menü rechts in einer Titelliste hinzu, oder importiere eine CSV-Datei in den Einstellungen.'
            )
      }`,
  };
}

// --- Search -----------------------------------------------------------------

export async function search(params) {
  const q = params.get('q') || '';
  if (!q.trim()) {
    return { title: 'Suche', html: pageHead('Suche', 'Suche', 'Tippe oben etwas ein.') };
  }
  const data = await api.search(q);
  const nothing = !data.tracks.length && !data.artists.length && !data.albums.length;

  return {
    title: `Suche: ${q}`,
    tracks: data.tracks,
    html: `${pageHead('Suche', `„${q}“`, nothing ? '' : facts([
      data.artists.length ? fmt.plural(data.artists.length, 'Interpret', 'Interpreten') : '',
      data.albums.length ? fmt.plural(data.albums.length, 'Album', 'Alben') : '',
      data.tracks.length ? fmt.plural(data.tracks.length, 'Song', 'Songs') : '',
    ]))}
      ${
        nothing
          ? empty('Nichts gefunden', `Zu „${q}“ gibt es in deiner Bibliothek keinen Treffer.`)
          : `
        ${
          data.artists.length
            ? `<section class="section"><div class="section-head"><h2>Interpreten</h2></div>
                <div class="grid">${data.artists
                  .slice(0, 12)
                  .map((a) =>
                    card({
                      href: `/artists/${a.id}`,
                      cover: a.cover,
                      title: a.name,
                      sub: fmt.plural(a.trackCount, 'Song', 'Songs'),
                      round: true,
                      playAction: `data-play-artist="${a.id}"`,
                    })
                  )
                  .join('')}</div></section>`
            : ''
        }
        ${
          data.albums.length
            ? `<section class="section"><div class="section-head"><h2>Alben</h2></div>
                <div class="grid">${data.albums
                  .slice(0, 12)
                  .map((a) =>
                    card({
                      href: `/albums/${a.id}`,
                      cover: a.cover,
                      title: a.title,
                      sub: a.artist,
                      playAction: `data-play-album="${a.id}"`,
                    })
                  )
                  .join('')}</div></section>`
            : ''
        }
        ${
          data.tracks.length
            ? `<section class="section"><div class="section-head"><h2>Songs</h2>
                <button type="button" class="btn btn-ghost btn-sm" data-play-all="view">${icon('play', 14)} Alle abspielen</button></div>
                ${trackList(data.tracks)}</section>`
            : ''
        }`
      }`,
  };
}

// --- Profile ----------------------------------------------------------------

export async function profile(_params, ctx) {
  const user = ctx.user;
  return {
    title: 'Profil',
    html: `${pageHead('Konto', 'Profil', 'Dein Anzeigename und dein Passwort.')}
      <div class="panel">
        <h2>Anzeigename</h2>
        <p class="panel-hint">So wirst du in Sonorus angezeigt. Der Benutzername (@${esc(user.username)}) bleibt gleich.</p>
        <form id="profile-form">
          <div class="field">
            <label for="pf-name">Anzeigename</label>
            <input type="text" id="pf-name" value="${esc(user.displayName)}" />
          </div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Speichern</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>Passwort ändern</h2>
        <p class="panel-hint">Nach einer Änderung wirst du auf anderen Geräten abgemeldet.</p>
        <form id="password-form">
          <div class="field">
            <label for="pf-current">Aktuelles Passwort</label>
            <input type="password" id="pf-current" autocomplete="current-password" />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="pf-new">Neues Passwort</label>
              <input type="password" id="pf-new" autocomplete="new-password" />
            </div>
            <div class="field">
              <label for="pf-confirm">Wiederholen</label>
              <input type="password" id="pf-confirm" autocomplete="new-password" />
            </div>
          </div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Passwort ändern</button></div>
        </form>
      </div>`,
    after(root, ctx2) {
      root.querySelector('#profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const res = await api.saveProfile({ displayName: root.querySelector('#pf-name').value });
          ctx2.setUser(res.user);
          toast('Profil gespeichert.');
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      root.querySelector('#password-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const current = root.querySelector('#pf-current').value;
        const next = root.querySelector('#pf-new').value;
        const confirm = root.querySelector('#pf-confirm').value;
        if (!next) return toast('Bitte ein neues Passwort eingeben.', 'err');
        if (next !== confirm) return toast('Die beiden Passwörter stimmen nicht überein.', 'err');
        try {
          await api.saveProfile({
            displayName: ctx2.user.displayName,
            currentPassword: current,
            newPassword: next,
          });
          root.querySelector('#password-form').reset();
          toast('Passwort geändert.');
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    },
  };
}

// --- Statistics -------------------------------------------------------------

// The four ways of slicing the history, in the order the switch shows them.
const RANGES = [
  ['day', 'Tage', (key) => key.slice(8) + '.' + key.slice(5, 7) + '.'],
  ['week', 'Wochen', (key) => 'KW ' + isoWeek(key)],
  ['month', 'Monate', (key) => MONTHS[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(2, 4)],
  ['year', 'Jahre', (key) => key],
];

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

// The bucket key of a week is its Monday; the label is the calendar week.
function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 86400000));
  return String(week);
}

// A column chart without a library: the bars are divs and their height is set
// through the CSSOM afterwards, because the CSP forbids inline styles.
function chart(rows, label) {
  if (!rows.length) return '<div class="empty small"><p>Für diesen Zeitraum gibt es noch nichts.</p></div>';
  const peak = Math.max(...rows.map((r) => r.seconds), 1);
  return `<div class="chart">${rows
    .map(
      (r) => `<div class="chart-col" title="${esc(label(r.key))}: ${esc(fmt.durationLong(r.seconds))} · ${fmt.plural(r.plays, 'Wiedergabe', 'Wiedergaben')}">
          <div class="chart-track">
            <div class="chart-bar" data-bar="${Math.round((r.seconds / peak) * 100)}"></div>
          </div>
          <span class="chart-key">${esc(label(r.key))}</span>
        </div>`
    )
    .join('')}</div>`;
}

function topList(title, rows, href) {
  if (!rows.length) return '';
  const peak = Math.max(...rows.map((r) => r.plays), 1);
  return `<section class="top-list">
      <div class="section-head"><h2>${esc(title)}</h2></div>
      ${rows
        .map(
          (r, i) => `<a class="top-row" href="${href(r)}" data-link>
            <span class="top-rank num">${i + 1}</span>
            <span class="top-art">${art(r.cover, r.title)}</span>
            <span class="top-text">
              <span class="top-title">${esc(r.title)}</span>
              <span class="top-sub">${esc(r.artist || fmt.plural(r.tracks || 0, 'Song', 'Songs'))}</span>
            </span>
            <span class="top-meter"><span class="chart-bar" data-bar="${Math.round((r.plays / peak) * 100)}"></span></span>
            <span class="top-count num">${fmt.number(r.plays)}×</span>
            <span class="top-time num">${esc(fmt.durationRack(r.seconds))}</span>
          </a>`
        )
        .join('')}
    </section>`;
}

export async function stats() {
  const { library, listening } = await api.stats();
  const t = listening.totals;

  const cell = (label, value, accent = false) =>
    `<div class="readout-cell${accent ? ' accent' : ''}">
      <span class="rack-label">${esc(label)}</span>
      <span class="readout-value">${esc(value)}</span>
    </div>`;

  const ranges = RANGES.map(
    ([key, label], i) =>
      `<button type="button" data-range="${key}"${i === 0 ? ' class="active"' : ''}>${label}</button>`
  ).join('');

  const charts = RANGES.map(
    ([key, , label], i) =>
      `<div class="chart-panel" data-range-panel="${key}"${i === 0 ? '' : ' hidden'}>
        ${chart(listening.buckets[key], label)}
      </div>`
  ).join('');

  return {
    title: 'Statistik',
    html: `${pageHead(
      'System',
      'Statistik',
      'Alles, was du gehört hast - über alle Geräte hinweg, gezählt für deinen Account.'
    )}

      <div class="panel">
        <h2>Bibliothek</h2>
        <div class="readout">
          ${cell('Songs', fmt.number(library.tracks))}
          ${cell('Interpreten', fmt.number(library.artists))}
          ${cell('Alben', fmt.number(library.albums))}
          ${cell('Singles', fmt.number(library.singles))}
          ${cell('Genres', fmt.number(library.genres))}
          ${cell('Spielzeit', fmt.durationRack(library.duration), true)}
        </div>
      </div>

      <div class="panel">
        <h2>Gehört</h2>
        <p class="panel-hint">${
          t.plays
            ? `Seit dem ${esc(fmt.date(t.firstPlay))} - das sind ${fmt.plural(t.days, 'Tag', 'Tage')}, an ${fmt.plural(t.activeDays, 'Tag', 'Tagen')} davon lief Musik.`
            : 'Sobald du etwas hörst, füllt sich diese Seite von selbst. Ein Song zählt, wenn er 30 Sekunden gelaufen ist.'
        }</p>
        <div class="readout">
          ${cell('Gesamt', fmt.durationRack(t.seconds), true)}
          ${cell('Wiedergaben', fmt.number(t.plays))}
          ${cell('Songs', fmt.number(t.tracks))}
          ${cell('Interpreten', fmt.number(t.artists))}
        </div>
      </div>

      <div class="panel">
        <h2>Durchschnitt</h2>
        <p class="panel-hint">Gerechnet über die gesamte Zeit seit dem ersten Anhören, stille Tage eingeschlossen.</p>
        <div class="readout">
          ${cell('Pro Tag', fmt.durationRack(listening.average.day))}
          ${cell('Pro Woche', fmt.durationRack(listening.average.week))}
          ${cell('Pro Monat', fmt.durationRack(listening.average.month))}
          ${cell('Pro Jahr', fmt.durationRack(listening.average.year))}
        </div>
      </div>

      <div class="panel">
        <div class="panel-head-row">
          <h2>Spielzeit</h2>
          <div class="seg-switch" role="group" aria-label="Zeitraum">${ranges}</div>
        </div>
        ${charts}
      </div>

      ${topList('Meistgehörte Songs', listening.top.tracks, (r) =>
        r.albumId ? `/albums/${r.albumId}` : `/artists/${r.artistId}`
      )}
      ${topList('Meistgehörte Interpreten', listening.top.artists, (r) => `/artists/${r.id}`)}
      ${topList('Meistgehörte Alben', listening.top.albums, (r) => `/albums/${r.id}`)}`,

    after(root) {
      applyBars(root);
      const switcher = root.querySelector('[aria-label="Zeitraum"]');
      if (!switcher) return;
      switcher.addEventListener('click', (e) => {
        const button = e.target.closest('[data-range]');
        if (!button) return;
        switcher.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b === button));
        root.querySelectorAll('[data-range-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.rangePanel !== button.dataset.range;
        });
        applyBars(root);
      });
    },
  };
}

// Bar sizes are data, not markup - same reason as the scan progress bar.
function applyBars(root) {
  root.querySelectorAll('[data-bar]').forEach((bar) => {
    const percent = `${bar.dataset.bar}%`;
    if (bar.closest('.top-meter')) bar.style.width = percent;
    else bar.style.height = percent;
  });
}

// --- Settings ---------------------------------------------------------------

// The running scan reports its progress here, right under the button that
// started it - that is the whole feedback, there is no toast for it.
function scanBlock(scan, lastScan) {
  const running = scan.running;
  // While the folder is still being walked the file count is unknown, so there
  // is no honest percentage yet and the bar runs indeterminate.
  const measured = running && scan.total > 0;
  const percent = measured ? Math.round((scan.done / scan.total) * 100) : 0;
  const phases = { walking: 'Ordner wird gelesen', reading: 'Dateien werden ausgelesen', pruning: 'Aufräumen' };

  return `<div id="scan-block">
      <div class="setting-row">
        <div>
          <div class="setting-label">Musikordner</div>
          <div class="setting-sub num">${esc(scan.musicDir)}</div>
        </div>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">Letzter Scan</div>
          <div class="setting-sub">${lastScan ? esc(fmt.dateTime(lastScan.replace('T', ' ').slice(0, 19))) : 'Noch nie'}</div>
        </div>
        <button type="button" class="btn btn-ghost" data-scan ${running ? 'disabled' : ''}>
          ${icon('refresh', 16)} ${running ? 'Läuft …' : 'Bibliothek scannen'}
        </button>
      </div>
      ${
        running
          ? `<div class="scan-progress">
              <div class="scan-progress-head">
                <span class="setting-sub">${esc(phases[scan.phase] || 'Scan läuft')}${
                  measured ? ` · ${fmt.number(scan.done)} von ${fmt.number(scan.total)}` : ''
                }</span>
                ${measured ? `<span class="setting-sub num">${percent} %</span>` : ''}
              </div>
              <div class="progress${measured ? '' : ' indeterminate'}">
                <div class="progress-fill"${measured ? ` data-progress="${percent}"` : ''}></div>
              </div>
            </div>`
          : ''
      }
      ${
        !running && scan.phase === 'done' && scan.finishedAt
          ? `<div class="setting-sub mt-sm">
              ${fmt.number(scan.added)} neu · ${fmt.number(scan.updated)} aktualisiert · ${fmt.number(scan.removed)} entfernt${
                scan.kept ? ` · ${fmt.number(scan.kept)} fehlen, aber bewertet` : ''
              }${scan.failed ? ` · ${fmt.number(scan.failed)} nicht lesbar` : ''}
            </div>`
          : ''
      }
      ${scan.error ? `<div class="flash err mt-md">${esc(scan.error)}</div>` : ''}
    </div>`;
}

function issueRows(issues) {
  if (!issues.length) {
    return `<div class="empty small"><p>Alles gefunden. Hier landen Songs aus einem CSV-Import, die es in deiner Bibliothek nicht gibt.</p></div>`;
  }
  return `<div class="issue-list">${issues
    .map(
      (i) => `<div class="issue" data-issue="${i.id}">
        <div class="issue-text">
          <div class="issue-playlist">${esc(i.currentPlaylistName || i.playlistName || 'Ohne Playlist')}</div>
          <div class="issue-title">${esc(i.title)}</div>
          <div class="issue-sub">${esc([i.artists, i.album].filter(Boolean).join(' · '))}</div>
        </div>
        <button type="button" class="icon-btn icon-btn-sm" data-dismiss-issue="${i.id}"
          aria-label="Meldung verwerfen" title="Meldung verwerfen">${icon('x', 15)}</button>
      </div>`
    )
    .join('')}</div>`;
}

export async function settings(_params, ctx) {
  const [status, issueData, userData] = await Promise.all([api.scanStatus(), api.issues(), api.users()]);
  const isAdmin = ctx.user.isAdmin;

  return {
    title: 'Einstellungen',
    html: `${pageHead('Konto & Bibliothek', 'Einstellungen', '')}

      <div class="panel">
        <h2>Bibliothek</h2>
        <p class="panel-hint">Sonorus liest den eingehängten Ordner nur - deine Dateien werden nie verändert.
          Die Zuordnung kommt aus der Ordnerstruktur: <code>Interpret / Album / 01 - Titel.flac</code>.
          Dateien, die direkt im Ordner eines Interpreten liegen, zählen als Single.
          Jahr, Genre und Cover kommen weiterhin aus der Datei selbst.</p>
        ${scanBlock(status.scan, status.lastScan)}
      </div>

      <div class="panel">
        <h2>Playlist aus CSV importieren</h2>
        <p class="panel-hint">Erwartet eine Kopfzeile mit den Spalten <strong>playlist</strong>, <strong>title</strong>, <strong>artists</strong> und <strong>album</strong>. Die Spaltennamen gängiger Streaming-Exporte werden ebenfalls erkannt.</p>
        <div class="drop-zone" id="csv-drop" tabindex="0" role="button">
          ${icon('upload', 22)}
          <div class="mt-sm">CSV-Datei hierher ziehen oder klicken zum Auswählen</div>
        </div>
        <input type="file" id="csv-input" accept=".csv,text/csv" hidden />
      </div>

      <div class="panel">
        <h2>Mitteilungen
          ${issueData.issues.length ? `<span class="issue-count">${fmt.number(issueData.issues.length)}</span>` : ''}
        </h2>
        <p class="panel-hint">Songs aus einem CSV-Import, zu denen keine Datei in der Bibliothek passt. Sie bleiben hier stehen, bis du sie verwirfst - oder bis ein späterer Scan die Datei findet und sie automatisch in die Playlist einsortiert.</p>
        <div id="issues-block">${issueRows(issueData.issues)}</div>
        ${
          issueData.issues.length
            ? `<div class="form-actions">
                <button type="button" class="btn btn-ghost" data-recheck-issues>${icon('refresh', 15)} Erneut prüfen</button>
                <button type="button" class="btn btn-danger" data-clear-issues>Alle verwerfen</button>
              </div>`
            : ''
        }
      </div>

      <div class="panel">
        <h2>Wiedergabe-Verlauf</h2>
        <p class="panel-hint">Grundlage für "Zuletzt gehört" und "Am häufigsten gehört". Nur deine eigenen Wiedergaben.</p>
        <div class="setting-row">
          <div>
            <div class="setting-label">Gespeicherte Wiedergaben</div>
            <div class="setting-sub num">${fmt.number(userData.historyCount)}</div>
          </div>
          <button type="button" class="btn btn-ghost" data-clear-history ${userData.historyCount ? '' : 'disabled'}>Verlauf löschen</button>
        </div>
      </div>

      <div class="panel">
        <h2>Konten</h2>
        <p class="panel-hint">${
          isAdmin
            ? 'Alle Konten teilen sich die Bibliothek. Playlists, Bewertungen und Verlauf gehören jeweils einem Konto.'
            : 'Nur Administratoren können Konten anlegen oder löschen.'
        }</p>
        <div id="users-block">${userRows(userData.users, ctx.user, isAdmin)}</div>
        ${
          isAdmin
            ? `<form id="user-form" class="mt-lg">
                <div class="field-row">
                  <div class="field">
                    <label for="nu-user">Benutzername</label>
                    <input type="text" id="nu-user" required />
                  </div>
                  <div class="field">
                    <label for="nu-name">Anzeigename</label>
                    <input type="text" id="nu-name" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label for="nu-pass">Passwort</label>
                    <input type="password" id="nu-pass" autocomplete="new-password" required />
                  </div>
                  <div class="field field-bottom">
                    <label class="checkbox"><input type="checkbox" id="nu-admin" /> Administrator</label>
                  </div>
                </div>
                <div class="form-actions"><button type="submit" class="btn btn-primary">Konto anlegen</button></div>
              </form>`
            : ''
        }
      </div>`,

    // The return value is the router's cleanup hook - without passing it on,
    // the wiring would never be torn down.
    after(root, ctx2) {
      return wireSettings(root, ctx2);
    },
  };
}

function userRows(users, me, isAdmin) {
  return users
    .map(
      (u) => `<div class="user-row">
        <span class="avatar avatar-md">${
          u.avatar ? `<img src="${esc(u.avatar)}" alt="" />` : esc((u.display_name || u.username).charAt(0).toUpperCase())
        }</span>
        <div class="user-row-text">
          <div class="user-row-name">${esc(u.display_name || u.username)}
            ${u.is_admin ? '<span class="badge admin">Admin</span>' : ''}
            ${u.id === me.id ? '<span class="badge you">Du</span>' : ''}
          </div>
          <div class="user-row-sub">@${esc(u.username)}</div>
        </div>
        ${
          isAdmin
            ? `<button type="button" class="icon-btn danger" data-delete-user="${u.id}"
                 data-user-name="${esc(u.display_name || u.username)}"
                 aria-label="Konto löschen">${icon('trash', 16)}</button>`
            : ''
        }
      </div>`
    )
    .join('');
}

// The progress bar's width is data, not markup: the CSP forbids inline style
// attributes, so it is applied through the CSSOM after the HTML is in place.
function applyProgress(root) {
  root.querySelectorAll('[data-progress]').forEach((bar) => {
    bar.style.width = `${bar.dataset.progress}%`;
  });
}

// Settings is the one view with enough interaction to warrant its own wiring.
function wireSettings(root, ctx) {
  let scanTimer = null;
  // root is #content and outlives the view, so the delegated listener below has
  // to go when the view does - otherwise a second visit to the settings page
  // leaves two handlers behind and every click fires twice.
  const wiring = new AbortController();
  applyProgress(root);

  const stopPolling = () => {
    clearInterval(scanTimer);
    scanTimer = null;
  };

  const drawScan = (scan, lastScan) => {
    const block = root.querySelector('#scan-block');
    if (!block) return false;
    block.outerHTML = scanBlock(scan, lastScan);
    applyProgress(root);
    return true;
  };

  const refreshScan = async () => {
    const status = await api.scanStatus();
    if (!drawScan(status.scan, status.lastScan)) return stopPolling();
    if (!status.scan.running) {
      stopPolling();
      ctx.refreshShell();
    }
  };

  root.addEventListener('click', async (e) => {
    const scanBtn = e.target.closest('[data-scan]');
    if (scanBtn) {
      scanBtn.disabled = true;
      try {
        // The POST already answers with the started scan, so the progress bar
        // is on screen before the first poll comes back.
        const res = await api.startScan();
        drawScan(res.scan, res.lastScan);
        if (!scanTimer) scanTimer = setInterval(refreshScan, 600);
      } catch (err) {
        scanBtn.disabled = false;
        toast(err.message, 'err');
      }
      return;
    }

    const dismiss = e.target.closest('[data-dismiss-issue]');
    if (dismiss) {
      try {
        await api.dismissIssue(dismiss.dataset.dismissIssue);
        dismiss.closest('.issue').remove();
        ctx.refreshShell();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }

    if (e.target.closest('[data-recheck-issues]')) {
      try {
        const res = await api.recheckIssues();
        toast(
          res.resolved
            ? `${res.resolved} ${res.resolved === 1 ? 'Song' : 'Songs'} gefunden und einsortiert.`
            : 'Keine der fehlenden Songs ist inzwischen in der Bibliothek.'
        );
        ctx.navigate('/settings', { replace: true });
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }

    if (e.target.closest('[data-clear-issues]')) {
      const ok = await confirmDialog({
        title: 'Alle Mitteilungen verwerfen',
        message:
          'Alle Einträge über fehlende Songs werden gelöscht. Die Information, welche Songs deiner Bibliothek fehlen, ist danach weg. Das lässt sich nicht rückgängig machen.',
        confirmLabel: 'Alle verwerfen',
      });
      if (!ok) return;
      await api.clearIssues();
      ctx.navigate('/settings', { replace: true });
      return;
    }

    if (e.target.closest('[data-clear-history]')) {
      const ok = await confirmDialog({
        title: 'Verlauf löschen',
        message:
          'Dein kompletter Wiedergabe-Verlauf wird gelöscht. "Zuletzt gehört" und "Am häufigsten gehört" starten danach bei null. Das lässt sich nicht rückgängig machen.',
        confirmLabel: 'Verlauf löschen',
      });
      if (!ok) return;
      await api.clearHistory();
      ctx.navigate('/settings', { replace: true });
      return;
    }

    const del = e.target.closest('[data-delete-user]');
    if (del) {
      const ok = await confirmDialog({
        title: 'Konto löschen',
        message: `Das Konto "${del.dataset.userName}" wird gelöscht, zusammen mit seinen Playlists, Bewertungen und seinem Verlauf. Die Musikdateien bleiben unberührt. Das lässt sich nicht rückgängig machen.`,
        confirmLabel: 'Konto löschen',
      });
      if (!ok) return;
      try {
        const res = await api.deleteUser(del.dataset.deleteUser);
        if (res.self) return window.location.reload();
        root.querySelector('#users-block').innerHTML = userRows(res.users, ctx.user, ctx.user.isAdmin);
        toast('Konto gelöscht.');
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  }, { signal: wiring.signal });

  const userForm = root.querySelector('#user-form');
  if (userForm) {
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api.createUser({
          username: root.querySelector('#nu-user').value,
          displayName: root.querySelector('#nu-name').value,
          password: root.querySelector('#nu-pass').value,
          isAdmin: root.querySelector('#nu-admin').checked,
        });
        userForm.reset();
        root.querySelector('#users-block').innerHTML = userRows(res.users, ctx.user, true);
        toast('Konto angelegt.');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  // CSV import: read the file in the browser and post its text.
  const drop = root.querySelector('#csv-drop');
  const input = root.querySelector('#csv-input');

  const handleFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    openImportDialog(text, file.name, ctx);
  };

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    })
  );
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  // A scan started elsewhere (or on server start) should show its progress here
  // too. The interval belongs to this view; leaving the page must stop it.
  api.scanStatus().then(({ scan, lastScan }) => {
    if (!scan.running || scanTimer) return;
    drawScan(scan, lastScan);
    scanTimer = setInterval(refreshScan, 600);
  });

  return () => {
    stopPolling();
    wiring.abort();
  };
}

// The import dialog: confirm the target, then show what matched and what did
// not. The missing songs are never dropped silently.
function openImportDialog(text, fileName, ctx) {
  const suggested = fileName.replace(/\.csv$/i, '');
  modal({
    title: 'CSV importieren',
    body: `<p class="panel-hint">Aus <strong>${esc(fileName)}</strong>. Enthält die Datei eine Spalte <code>playlist</code>, wird pro Name eine eigene Playlist angelegt.</p>
      <div class="field">
        <label for="imp-name">Playlist-Name (falls die Datei keine Spalte dafür hat)</label>
        <input type="text" id="imp-name" value="${esc(suggested)}" />
      </div>`,
    footer: `<button type="button" class="btn btn-ghost" data-close>Abbrechen</button>
             <button type="button" class="btn btn-primary" data-run>Importieren</button>`,
    onOpen(root) {
      root.querySelector('[data-run]').addEventListener('click', async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        button.textContent = 'Wird importiert …';
        try {
          const result = await api.importCsv({
            text,
            name: root.querySelector('#imp-name').value || suggested,
          });
          closeModal();
          showImportResult(result, ctx);
          ctx.refreshShell();
        } catch (err) {
          toast(err.message, 'err');
          button.disabled = false;
          button.textContent = 'Importieren';
        }
      });
    },
  });
}

function showImportResult(result, ctx) {
  const lists = result.playlists
    .map(
      (p) =>
        `<div class="setting-row">
          <div>
            <div class="setting-label">${esc(p.name)}</div>
            <div class="setting-sub">${fmt.number(p.matched)} übernommen${p.missing ? ` · ${fmt.number(p.missing)} fehlen` : ''}</div>
          </div>
          <a class="btn btn-ghost btn-sm" href="/playlists/${p.id}" data-link data-close>Öffnen</a>
        </div>`
    )
    .join('');

  modal({
    title: 'Import abgeschlossen',
    wide: true,
    body: `<div class="import-summary">
        <div class="import-stat"><span class="rack-label">Zeilen</span><span class="value num">${fmt.number(result.total)}</span></div>
        <div class="import-stat matched"><span class="rack-label">Übernommen</span><span class="value num">${fmt.number(result.matched)}</span></div>
        <div class="import-stat missing"><span class="rack-label">Nicht gefunden</span><span class="value num">${fmt.number(result.missing)}</span></div>
      </div>
      ${lists}
      ${
        result.missing
          ? `<p class="panel-hint mt-lg">Die ${fmt.number(result.missing)} fehlenden Songs stehen ab jetzt unter <strong>Einstellungen → Mitteilungen</strong>, mit Titel, Interpret und Album. Sobald du die Dateien ergänzt und neu scannst, wandern sie automatisch in die Playlist.</p>`
          : ''
      }`,
    footer: `<button type="button" class="btn btn-primary" data-close>Fertig</button>`,
    onOpen(root) {
      root.querySelectorAll('a[data-link]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          closeModal();
          ctx.navigate(a.getAttribute('href'));
        })
      );
    },
  });
}
