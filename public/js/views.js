// One renderer per route. Each returns { title, html } and may return an
// `after(root)` hook for wiring up controls that need more than event
// delegation (drag and drop, file pickers, polling).

import { api } from './api.js';
import { icon } from './icons.js';
import * as fmt from './format.js';
import { esc, art, mosaic, trackList, card, empty, toast, modal, closeModal, confirmDialog } from './ui.js';

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

// `zoom` is the URL of the picture behind the artwork: with one, the tile turns
// into a button that opens the cover at full size.
function detailHead({ label, title, meta, artHtml, round = false, actions, zoom = '' }) {
  const tile = zoom
    ? `<button type="button" class="detail-art zoomable${round ? ' round' : ''}"
         data-zoom="${esc(zoom)}" data-zoom-label="${esc(title)}"
         aria-label="Bild vergrößern">${artHtml}</button>`
    : `<div class="detail-art${round ? ' round' : ''}">${artHtml}</div>`;

  return `<div class="detail-head">
      ${tile}
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

  // The same five counts and the same playtime as the statistics page, so it
  // is laid out the same way: the counts in one row, the playtime across the
  // second, where a four-digit hour count still fits on one line.
  const readout = `<div class="readout split">
      ${readoutCell('Songs', fmt.number(s.tracks))}
      ${readoutCell('Interpreten', fmt.number(s.artists))}
      ${readoutCell('Alben', fmt.number(s.albums))}
      ${readoutCell('Singles', fmt.number(s.singles))}
      ${readoutCell('Genres', fmt.number(s.genres))}
      ${readoutCell('Spielzeit', fmt.durationRack(s.duration), { accent: true, span: 10 })}
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

// The sort survives the session: without one in the URL, the last one the
// account used is the one that applies (app.js writes it on every click).
export async function tracks(params, ctx) {
  const saved = ctx.prefs.trackSort || {};
  const sort = params.get('sort') || saved.key || 'title';
  const dir = params.get('dir') || saved.dir || 'asc';
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
                // No play button on an artist: a round tile clips its corner,
                // and an artist is a place you go to, not a queue you start.
                card({
                  href: `/artists/${a.id}`,
                  cover: a.cover,
                  title: a.name,
                  sub: fmt.plural(a.trackCount, 'Song', 'Songs'),
                  round: true,
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
      artHtml: art(data.cover, data.name),
      zoom: data.cover,
      meta: facts([
        fmt.plural(data.albums.length, 'Album', 'Alben'),
        data.singles.length ? fmt.plural(data.singles.length, 'Single', 'Singles') : '',
        fmt.plural(data.tracks.length, 'Song', 'Songs'),
        fmt.durationLong(total),
      ]),
      actions: `${playActions('view')}
        <button type="button" class="btn btn-ghost" data-edit-artist="${data.id}">
          ${icon('edit', 16)} Bearbeiten
        </button>`,
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
          ? trackList(data.singles, { year: true })
          : empty(
              'Keine Singles',
              'Einzelne Dateien, die direkt im Ordner des Interpreten liegen, erscheinen hier.'
            )
      }`,
  };
}

// --- Albums -----------------------------------------------------------------

// Both directions are spelled out instead of hiding one behind a reverse
// button: "Z-A" says what it does, an arrow next to "Jahr" would not.
const ALBUM_SORTS = [
  ['title', 'asc', 'Titel A-Z'],
  ['title', 'desc', 'Titel Z-A'],
  ['artist', 'asc', 'Interpret A-Z'],
  ['artist', 'desc', 'Interpret Z-A'],
  ['year', 'desc', 'Jahr, neueste zuerst'],
  ['year', 'asc', 'Jahr, älteste zuerst'],
  ['tracks', 'desc', 'Songs, meiste zuerst'],
  ['tracks', 'asc', 'Songs, wenigste zuerst'],
];

export async function albums(params, ctx) {
  // Without a sort in the URL the last one the account picked applies, so a
  // choice made once stays until it is changed again.
  const saved = ctx.prefs.albumSort || {};
  const sort = params.get('sort') || saved.key || 'title';
  const dir = params.get('dir') || saved.dir || 'asc';
  const { albums: list } = await api.albums({ sort, dir });

  const sortOptions = ALBUM_SORTS.map(
    ([key, direction, label]) =>
      `<option value="${key}:${direction}"${
        key === sort && direction === dir ? ' selected' : ''
      }>${label}</option>`
  ).join('');

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
    after(root, ctx2) {
      const select = root.querySelector('[data-album-sort]');
      if (select) {
        select.addEventListener('change', () => {
          const [key, direction] = select.value.split(':');
          ctx2.setPref('albumSort', { key, dir: direction });
          ctx2.navigate(`/albums?sort=${key}&dir=${direction}`, { replace: true });
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
      zoom: data.cover,
      meta: facts([
        data.artistId
          ? `<a href="/artists/${data.artistId}" data-link>${esc(data.artist)}</a>`
          : esc(data.artist),
        // The one place the full release date is spelled out. A grid or a list
        // has room for the year, and that is all they show.
        fmt.releaseDate(data.releaseDate),
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

// "4 und 5 Sterne" is one list, so it needs one name.
function joinAnd(parts) {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
}

export function starSelectionLabel(values) {
  const rated = values.filter((v) => v > 0).sort((a, b) => a - b);
  const parts = [];
  if (rated.length) {
    parts.push(`${joinAnd(rated.map(String))} ${rated.length === 1 && rated[0] === 1 ? 'Stern' : 'Sterne'}`);
  }
  if (values.includes(0)) parts.push('Nicht bewertet');
  return joinAnd(parts);
}

// The ratings this list is made of, each one a switch. Clicking one adds it to
// the selection or takes it out again - that is the whole "mehrere Sterne auf
// einmal". The last one standing cannot be switched off; an empty list would
// have nothing to show.
function starPicker(values) {
  const chip = (value, content, label) => {
    const on = values.includes(value);
    const rest = on ? values.filter((v) => v !== value) : [...values, value];
    const target = (rest.length ? rest : [value]).sort((a, b) => b - a).join(',');
    return `<button type="button" class="star-chip${on ? ' active' : ''}" data-stars="${target}"
              aria-pressed="${on}" title="${esc(label)}">${content}</button>`;
  };

  return `<div class="star-filter" role="group" aria-label="Bewertungen kombinieren">
      ${[5, 4, 3, 2, 1]
        .map((n) => chip(n, `<span class="num">${n}</span>${icon('star', 13)}`, `${n} ${n === 1 ? 'Stern' : 'Sterne'}`))
        .join('')}
      ${chip(0, 'Nicht bewertet', 'Nicht bewertet')}
    </div>`;
}

export async function starred(params) {
  const values = [...new Set(String(params.stars).split(',').map(Number))].filter((n) => n >= 0 && n <= 5);
  const { tracks: list } = await api.starred(values.join(','));
  const label = starSelectionLabel(values);
  const total = list.reduce((sum, t) => sum + t.duration, 0);
  const only = values.length === 1 ? values[0] : null;

  return {
    title: label,
    tracks: list,
    html: `${pageHead(
      'Automatische Playlist',
      label,
      facts([fmt.plural(list.length, 'Song', 'Songs'), list.length ? fmt.durationLong(total) : '']),
      list.length ? playActions('view') : ''
    )}
      ${starPicker(values)}
      ${
        list.length
          ? trackList(list)
          : empty(
              only === null
                ? 'Zu dieser Auswahl gibt es nichts'
                : only === 0
                  ? 'Alles bewertet'
                  : `Noch nichts mit ${label} bewertet`,
              only === null
                ? 'Nimm eine Bewertung dazu oder wieder heraus.'
                : only === 0
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
        <button type="button" class="btn btn-ghost${data.playlist.pinned ? ' is-pinned' : ''}"
          data-pin-playlist="${data.playlist.id}" aria-pressed="${!!data.playlist.pinned}">
          ${icon('pin', 16)} ${data.playlist.pinned ? 'Angepinnt' : 'Anpinnen'}
        </button>
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

// The history is read one period at a time. The switch picks how *wide* a
// period is (a day, a week, a month, a year, or everything), the arrows next to
// it pick *which* one - and the chart, the readout and the three top lists all
// answer for exactly that period. "Meistgehörte Songs" therefore means "in
// this week", not "ever"; "ever" is what the "Gesamt" width is for.

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// "2026-07-25" -> "25.07.2026". Cut from the string, not parsed into a Date, so
// no timezone can move it to the day before.
const dayLabel = (key) => `${key.slice(8)}.${key.slice(5, 7)}.${key.slice(0, 4)}`;

// A period key back into a local Date. Keys are 'YYYY', 'YYYY-MM' or
// 'YYYY-MM-DD' and the parts they do not say start at the beginning of the
// period. Built from the pieces, never handed to `new Date('2026-07-25')` -
// that is parsed as UTC midnight and lands on the 24th west of Greenwich.
function keyDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// The bucket key of a week is its Monday; the label is the calendar week.
function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 86400000));
  return String(week);
}

const monthTitle = (key) => keyDate(key).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

// One entry per width, in the order the switch shows them. `title` names the
// single period the arrows have landed on, `step` walks to the neighbouring
// one, and `slots` lists every bar the period is made of - all of them, because
// the query only returns what was played and a silent Tuesday is a real zero,
// not a missing value. Everything here works in the browser's own timezone,
// the same one the server grouped the plays by.
const RANGES = {
  day: {
    label: 'Tage',
    title: (key) =>
      keyDate(key).toLocaleDateString('de-DE', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      }),
    step: (key, by) => {
      const d = keyDate(key);
      d.setDate(d.getDate() + by);
      return isoDay(d);
    },
    slots: () => Array.from({ length: 24 }, (_, h) => pad2(h)),
    slotLabel: (k) => String(Number(k)),
    slotTitle: (k) => `${Number(k)} Uhr`,
  },
  week: {
    label: 'Wochen',
    title: (key) => {
      const end = keyDate(key);
      end.setDate(end.getDate() + 6);
      return `KW ${isoWeek(key)} · ${dayLabel(key).slice(0, 6)} - ${dayLabel(isoDay(end))}`;
    },
    step: (key, by) => {
      const d = keyDate(key);
      d.setDate(d.getDate() + by * 7);
      return isoDay(d);
    },
    slots: (key) =>
      Array.from({ length: 7 }, (_, i) => {
        const d = keyDate(key);
        d.setDate(d.getDate() + i);
        return isoDay(d);
      }),
    slotLabel: (k) => `${WEEKDAYS[(keyDate(k).getDay() + 6) % 7]} ${k.slice(8)}.`,
    slotTitle: dayLabel,
  },
  month: {
    label: 'Monate',
    // Stepping from the first of the month, so a 31st does not skip a short one.
    title: monthTitle,
    step: (key, by) => {
      const d = keyDate(key);
      d.setMonth(d.getMonth() + by);
      return isoDay(d).slice(0, 7);
    },
    // Day 0 of the next month is the last day of this one.
    slots: (key) => {
      const d = keyDate(key);
      const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      return Array.from({ length: days }, (_, i) => `${key}-${pad2(i + 1)}`);
    },
    slotLabel: (k) => `${Number(k.slice(8))}.`,
    slotTitle: dayLabel,
  },
  year: {
    label: 'Jahre',
    title: (key) => key,
    step: (key, by) => String(Number(key) + by),
    slots: (key) => Array.from({ length: 12 }, (_, i) => `${key}-${pad2(i + 1)}`),
    slotLabel: (k) => MONTHS[Number(k.slice(5, 7)) - 1],
    slotTitle: monthTitle,
  },
  all: {
    label: 'Gesamt',
    title: () => 'Seit dem ersten Anhören',
    // Every period at once, so there is no neighbouring one to step to - which
    // is also what hides the arrows.
    step: null,
    // From the first year something was played to the one running now.
    slots: (key, rows) => {
      if (!rows.length) return [];
      const from = Number(rows[0].key);
      const to = Math.max(from, new Date().getFullYear());
      return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
    },
    slotLabel: (k) => k,
    slotTitle: (k) => k,
  },
};

const RANGE_ORDER = ['day', 'week', 'month', 'year', 'all'];

// Every slot the selected period consists of, carrying what the query found on
// it. The query only returns the slots something was played in, so without this
// two bars a month apart would stand side by side as if they were neighbours.
function series(range, key, rows) {
  const spec = RANGES[range];
  const found = new Map(rows.map((r) => [r.key, r]));
  return spec.slots(key, rows).map((slot) => {
    const row = found.get(slot) || { plays: 0, seconds: 0 };
    return {
      label: spec.slotLabel(slot),
      title: spec.slotTitle(slot),
      plays: row.plays,
      seconds: row.seconds,
    };
  });
}

// Past this many bars the columns get narrow (the 24 hours of a day, the 31
// days of a month) and the labels are allowed to wrap onto a second line
// instead of pushing the whole chart into a horizontal scroll.
const DENSE_FROM = 14;

// A column chart without a library: the bars are divs and their height is set
// through the CSSOM afterwards, because the CSP forbids inline styles. Both
// numbers stand at the bar, listening time above it and plays below - a value
// you only see after hovering is a value you do not see.
function chart(rows) {
  if (!rows.some((r) => r.plays)) {
    return '<div class="empty small"><p>In diesem Zeitraum lief nichts.</p></div>';
  }
  const peak = Math.max(...rows.map((r) => r.seconds), 1);
  return `<div class="chart${rows.length >= DENSE_FROM ? ' dense' : ''}">${rows
    .map(
      (r) => `<div class="chart-col${r.plays ? '' : ' quiet'}" title="${esc(r.title)}: ${esc(fmt.durationLong(r.seconds))} · ${fmt.plural(r.plays, 'Wiedergabe', 'Wiedergaben')}">
          <div class="chart-track">
            <span class="chart-value num">${r.seconds ? esc(fmt.durationRack(r.seconds)) : ''}</span>
            <div class="chart-bar" data-bar="${Math.round((r.seconds / peak) * 100)}"></div>
          </div>
          <span class="chart-key">${esc(r.label)}</span>
          <span class="chart-plays num">${r.plays ? `${fmt.number(r.plays)}×` : ''}</span>
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

// One value on the front panel. `span` is how many of the split readout's ten
// columns the cell takes and `sub` a quiet second line under the number - both
// only used by the library readout, where two values need more room than a
// plain count does.
const readoutCell = (label, value, opts = {}) =>
  `<div class="readout-cell${opts.accent ? ' accent' : ''}${opts.span ? ` span-${opts.span}` : ''}">
    <span class="rack-label">${esc(label)}</span>
    <span class="readout-value">${esc(value)}</span>
    ${opts.sub ? `<span class="readout-sub">${esc(opts.sub)}</span>` : ''}
  </div>`;

// Everything that belongs to the selected period, as one block: the switch, the
// arrows, what that period adds up to, its chart and the three top lists. It is
// re-rendered in one piece whenever the selection changes, so no part of it can
// be left showing the numbers of the period before.
function periodSection(listening) {
  const { range, key, first, current, totals } = listening.period;
  const spec = RANGES[range];

  const switcher = RANGE_ORDER.map(
    (r) =>
      `<button type="button" data-range="${r}"${r === range ? ' class="active"' : ''}>${RANGES[r].label}</button>`
  ).join('');

  // The arrows stop where the history does: at the period the first play falls
  // into, and at the one that is running now. Both ends come from the server as
  // a key of the same shape, so comparing the strings is the whole test.
  const arrow = (dir, label, iconName, off) =>
    `<button type="button" class="icon-btn" data-period="${spec.step(key, dir)}" aria-label="${label}"${
      off ? ' disabled' : ''
    }>${icon(iconName)}</button>`;

  const nav = `<div class="period-nav">
      ${spec.step ? arrow(-1, 'Früherer Zeitraum', 'chevron-left', !first || key <= first) : ''}
      <span class="period-title">${esc(spec.title(key))}</span>
      ${spec.step ? arrow(1, 'Späterer Zeitraum', 'chevron-right', key >= current) : ''}
    </div>`;

  return `<div class="panel">
      <div class="panel-head-row">
        <h2>Zeitraum</h2>
        <div class="seg-switch" role="group" aria-label="Zeitraum">${switcher}</div>
      </div>
      ${nav}
      <div class="readout">
        ${readoutCell('Spielzeit', fmt.durationRack(totals.seconds), { accent: true })}
        ${readoutCell('Wiedergaben', fmt.number(totals.plays))}
        ${readoutCell('Songs', fmt.number(totals.tracks))}
        ${readoutCell('Interpreten', fmt.number(totals.artists))}
        ${readoutCell('Alben', fmt.number(totals.albums))}
      </div>
      <div class="mt-lg">${chart(series(range, key, listening.chart))}</div>
    </div>

    ${topList('Meistgehörte Songs', listening.top.tracks, (r) =>
      r.albumId ? `/albums/${r.albumId}` : `/artists/${r.artistId}`
    )}
    ${topList('Meistgehörte Interpreten', listening.top.artists, (r) => `/artists/${r.id}`)}
    ${topList('Meistgehörte Alben', listening.top.albums, (r) => `/albums/${r.id}`)}`;
}

export async function stats(params, ctx) {
  // The page opens on the width the account picked last - "Gesamt" stays
  // "Gesamt" until it is changed again. Only the width is kept, not which
  // period the arrows walked to: a saved day would be yesterday tomorrow.
  const saved = ctx.prefs.statsRange;
  const { library, listening } = await api.stats(saved ? { range: saved } : {});
  const t = listening.totals;
  // Which period is on screen. The arrows step from it, so it has to survive
  // between two renders of the block.
  let showing = listening.period;
  // The day the most was listened to sits in the library readout - the one
  // panel above the period that speaks for all of the history.
  const best = t.bestDay;

  return {
    title: 'Statistik',
    html: `${pageHead(
      'System',
      'Statistik',
      'Alles, was du gehört hast - über alle Geräte hinweg, gezählt für deinen Account.'
    )}

      <div class="panel">
        <h2>Bibliothek</h2>
        ${
          t.plays
            ? ''
            : '<p class="panel-hint">Sobald du etwas hörst, füllt sich diese Seite von selbst. Ein Song zählt, wenn er 30 Sekunden gelaufen ist.</p>'
        }
        <div class="readout split">
          ${readoutCell('Songs', fmt.number(library.tracks))}
          ${readoutCell('Interpreten', fmt.number(library.artists))}
          ${readoutCell('Alben', fmt.number(library.albums))}
          ${readoutCell('Singles', fmt.number(library.singles))}
          ${readoutCell('Genres', fmt.number(library.genres))}
          ${readoutCell('Spielzeit', fmt.durationRack(library.duration), {
            accent: true,
            span: best ? 5 : 10,
          })}
          ${
            best
              ? readoutCell('Bester Tag', fmt.durationRack(best.seconds), {
                  span: 5,
                  sub: RANGES.day.title(best.day),
                })
              : ''
          }
        </div>
      </div>

      ${
        t.plays
          ? `<div class="panel">
        <h2>Durchschnitt</h2>
        <p class="panel-hint">Alles gemessen, nichts hochgerechnet: Grundlage sind die
          ${fmt.plural(t.days, 'Tag', 'Tage')} seit dem ersten Anhören am ${esc(fmt.date(t.firstPlay))}.
          Ein Hörtag ist ein Tag, an dem wirklich Musik lief
          (${fmt.plural(t.activeDays, 'Tag', 'Tage')}).</p>
        <div class="readout">
          ${readoutCell('Pro Tag', fmt.durationRack(listening.average.day))}
          ${readoutCell('Pro Hörtag', fmt.durationRack(listening.average.activeDay))}
          ${readoutCell('Pro Wiedergabe', `${fmt.duration(listening.average.play)} Min.`)}
          ${readoutCell('Wiedergaben pro Tag', fmt.number(Math.round(listening.average.playsPerDay * 10) / 10))}
        </div>
      </div>`
          : ''
      }

      <div id="period-view">${periodSection(listening)}</div>`,

    after(root, ctx2) {
      applyBars(root);
      const view = root.querySelector('#period-view');
      if (!view) return;

      // One handler for both controls: the switch hands over a width, the
      // arrows a period key. Either way the whole block is fetched again and
      // swapped in - the top lists under the switch must never be older than
      // the switch itself. Changing the width lands on the current period, so
      // picking "Jahre" shows this year and the arrows walk back from there.
      let busy = false;
      view.addEventListener('click', async (e) => {
        const width = e.target.closest('[data-range]');
        const step = e.target.closest('[data-period]');
        if ((!width && !step) || busy) return;
        busy = true;
        view.classList.add('busy');
        try {
          const data = await api.stats(
            width ? { range: width.dataset.range } : { range: showing.range, period: step.dataset.period }
          );
          // Remembered only once the width really answered, so a failed
          // request cannot leave the page opening on something it never showed.
          if (width) ctx2.setPref('statsRange', width.dataset.range);
          showing = data.listening.period;
          view.innerHTML = periodSection(data.listening);
          applyBars(view);
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          busy = false;
          view.classList.remove('busy');
        }
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
          Datum, Genre und Cover kommen weiterhin aus der Datei selbst.</p>
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
