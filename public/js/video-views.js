// The pages of the video side: Filme, Serien, one film, one series, a film
// series, a person, and the player page. Same contract as views.js: each
// returns { title, html } and may return an `after(root, ctx)` hook.

import { api } from './api.js';
import { icon } from './icons.js';
import * as fmt from './format.js';
import { esc, empty, toast, modal, closeModal, contextMenu } from './ui.js';
import { certLabel, episodeCode, langName, videoCodecLabel, resolutionLabel } from './video-format.js';
import { mountPlayer } from './video-player.js';

// --- Pieces -----------------------------------------------------------------------

function img(src, label, cls = '') {
  if (src) return `<img src="${esc(src)}" alt="" loading="lazy"${cls ? ` class="${cls}"` : ''} />`;
  const initial = String(label || '?').trim().charAt(0) || '?';
  return `<span class="art-fallback" aria-hidden="true">${esc(initial)}</span>`;
}

function progressBar(fraction) {
  const pct = Math.max(2, Math.min(100, Math.round((fraction || 0) * 100)));
  return `<span class="v-progress"><span data-progress="${pct}"></span></span>`;
}

const doneBadge = `<span class="v-done" title="Gesehen">${icon('check', 14)}</span>`;

function movieSub(m) {
  if (m.progress && m.progress.started) return `noch ${fmt.durationLong(m.duration - m.progress.position)}`;
  return [m.year, m.duration ? fmt.durationLong(m.duration) : ''].filter(Boolean).join(' · ');
}

function showSub(s) {
  const seasons = s.seasons ? fmt.plural(s.seasons, 'Staffel', 'Staffeln') : '';
  if (s.watched && s.watched < s.episodes) return `${seasons} · ${s.watched}/${s.episodes} gesehen`;
  return [s.year, seasons].filter(Boolean).join(' · ');
}

/** A poster tile: film, series or film series. */
function posterCard({ href, poster, title, sub, done = false, fraction = 0, playId = null }) {
  return `<a class="card portrait v-card" href="${esc(href)}" data-link>
      <span class="card-art">
        ${img(poster, title)}
        ${done ? doneBadge : ''}
        ${fraction ? progressBar(fraction) : ''}
        ${playId ? `<button type="button" class="card-play" data-watch="${playId}" aria-label="${esc(title)} abspielen">${icon('play', 17)}</button>` : ''}
      </span>
      <span class="card-title">${esc(title)}</span>
      ${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}
    </a>`;
}

const movieCard = (m) =>
  posterCard({
    href: `/movies/${m.id}`,
    poster: m.poster,
    title: m.title,
    sub: movieSub(m),
    done: m.progress && m.progress.completed,
    fraction: m.progress && m.progress.started ? m.progress.fraction : 0,
    playId: m.videoId,
  });

const showCard = (s) =>
  posterCard({
    href: `/shows/${s.id}`,
    poster: s.poster,
    title: s.title,
    sub: showSub(s),
    done: s.episodes > 0 && s.watched >= s.episodes,
  });

/** A 16:9 tile that starts playing: "Weiterschauen". */
function wideCard(item) {
  const t = item.title;
  const v = item.video;
  const picture = item.kind === 'show' ? v.still || t.thumb || t.backdrop : t.thumb || t.backdrop;
  const left = v.duration - (v.progress ? v.progress.position : 0);
  const sub =
    item.kind === 'show'
      ? `${episodeCode(v.season, v.episode, v.episodeEnd)}${v.name ? ` · ${v.name}` : ''}`
      : `noch ${fmt.durationLong(left)}`;
  return `<a class="v-wide" href="/watch/${v.id}" data-link data-continue-title="${t.id}">
      <span class="v-wide-art">
        ${img(picture, t.title)}
        <span class="v-wide-play">${icon('play', 22)}</span>
        ${v.progress && v.progress.started ? progressBar(v.progress.fraction) : ''}
        <button type="button" class="v-wide-done" data-continue-done="${v.id}"
          aria-label="Als gesehen markieren" title="Als gesehen markieren">${icon('check', 16)}</button>
      </span>
      <span class="card-title">${esc(t.title)}</span>
      <span class="card-sub">${esc(sub)}</span>
    </a>`;
}

function shelf(title, cards, more = '') {
  if (!cards.length) return '';
  return `<section class="section">
      <div class="section-head"><h2>${esc(title)}</h2>${more}</div>
      <div class="grid row v-row">${cards.join('')}</div>
    </section>`;
}

function wideShelf(title, items) {
  if (!items.length) return '';
  return `<section class="section" data-continue>
      <div class="section-head"><h2>${esc(title)}</h2></div>
      <div class="v-wide-row">${items.map(wideCard).join('')}</div>
    </section>`;
}

function facts(parts) {
  return parts.filter(Boolean).join(' <span class="dot">·</span> ');
}

function applyProgress(root) {
  root.querySelectorAll('[data-progress]').forEach((bar) => {
    bar.style.width = `${bar.dataset.progress}%`;
  });
}

// The big picture at the top of Filme and Serien, and of every detail page.
function hero({ backdrop, logo, title, label, meta, overview, actions, poster = '', zoom = '' }) {
  return `<section class="v-hero${backdrop ? '' : ' no-backdrop'}">
      ${backdrop ? `<img class="v-hero-bg" src="${esc(backdrop)}" alt="" />` : ''}
      <div class="v-hero-shade"></div>
      <div class="v-hero-inner">
        ${
          poster !== ''
            ? `<button type="button" class="v-hero-poster zoomable" ${zoom ? `data-zoom="${esc(zoom)}" data-zoom-label="${esc(title)}"` : 'disabled'}
                 aria-label="Poster vergrößern">${img(poster, title)}</button>`
            : ''
        }
        <div class="v-hero-text">
          ${label ? `<span class="rack-label">${esc(label)}</span>` : ''}
          ${logo ? `<h1 class="v-hero-logo"><img src="${esc(logo)}" alt="${esc(title)}" /></h1>` : `<h1 class="v-hero-title">${esc(title)}</h1>`}
          ${meta ? `<div class="v-hero-facts">${meta}</div>` : ''}
          ${overview ? `<p class="v-hero-overview">${esc(overview)}</p>` : ''}
          ${actions ? `<div class="v-hero-actions">${actions}</div>` : ''}
        </div>
      </div>
    </section>`;
}

// --- Sorting and filtering the "Alle" grids ------------------------------------------

const SORTS = {
  title: { label: 'Titel', cmp: (a, b) => a.title.localeCompare(b.title, 'de', { sensitivity: 'base', numeric: true }) },
  year: { label: 'Jahr', cmp: (a, b) => (b.year || 0) - (a.year || 0) },
  added: { label: 'Neu hinzugefügt', cmp: (a, b) => String(b.newest || b.addedAt).localeCompare(String(a.newest || a.addedAt)) },
  vote: { label: 'TMDB-Wertung', cmp: (a, b) => (b.vote || 0) - (a.vote || 0) },
  watched: { label: 'Zuletzt gesehen', cmp: (a, b) => String(b.watchedAt || '').localeCompare(String(a.watchedAt || '')) },
};

const isDone = (t) => (t.kind === 'movie' ? t.progress && t.progress.completed : t.episodes > 0 && t.watched >= t.episodes);

function browseState(ctx, key) {
  const saved = (ctx.prefs.videoBrowse || {})[key] || {};
  return { sort: SORTS[saved.sort] ? saved.sort : 'title', genre: Number(saved.genre) || 0, unwatched: !!saved.unwatched };
}

function browseBar(key, genres, state) {
  return `<div class="v-browse" data-browse="${key}">
      <select data-browse-genre aria-label="Genre">
        <option value="0">Alle Genres</option>
        ${genres.map((g) => `<option value="${g.id}"${g.id === state.genre ? ' selected' : ''}>${esc(g.name)} (${g.count})</option>`).join('')}
      </select>
      <select data-browse-sort aria-label="Sortierung">
        ${Object.entries(SORTS).map(([k, s]) => `<option value="${k}"${k === state.sort ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
      <label class="checkbox v-unwatched"><input type="checkbox" data-browse-unwatched${state.unwatched ? ' checked' : ''} /> Nur ungesehene</label>
      <span class="v-browse-count rack-label" data-browse-count></span>
    </div>`;
}

function wireBrowse(root, ctx, key, items, card) {
  const bar = root.querySelector(`[data-browse="${key}"]`);
  const grid = root.querySelector(`[data-browse-grid="${key}"]`);
  if (!bar || !grid) return;
  const draw = () => {
    const state = browseState(ctx, key);
    const list = items
      .filter((t) => !state.genre || t.genreIds.includes(state.genre))
      .filter((t) => !state.unwatched || !isDone(t))
      .sort((a, b) => SORTS[state.sort].cmp(a, b) || SORTS.title.cmp(a, b));
    grid.innerHTML = list.length ? list.map(card).join('') : '<p class="v-none">Nichts gefunden.</p>';
    bar.querySelector('[data-browse-count]').textContent = fmt.plural(list.length, 'Titel', 'Titel');
    applyProgress(grid);
  };
  const save = (patch) => {
    const all = { ...(ctx.prefs.videoBrowse || {}) };
    all[key] = { ...browseState(ctx, key), ...patch };
    ctx.setPref('videoBrowse', all);
    draw();
  };
  bar.querySelector('[data-browse-genre]').addEventListener('change', (e) => save({ genre: Number(e.target.value) }));
  bar.querySelector('[data-browse-sort]').addEventListener('change', (e) => save({ sort: e.target.value }));
  bar.querySelector('[data-browse-unwatched]').addEventListener('change', (e) => save({ unwatched: e.target.checked }));
  draw();
}

function noTmdbHint(data) {
  if (data.tmdb) return '';
  return `<p class="v-hint">${icon('info', 15)} Ohne <code>TMDB_API_KEY</code> zeigt Sonorus nur, was in den Ordnern liegt: keine Beschreibungen, keine Besetzung, keine Genres.</p>`;
}

// --- Filme & Serien: Übersicht, Filme, Serien ---------------------------------------------

// One sidebar entry, three tabs. The tabs are links, so each has its own address.
function tabs(active) {
  const tab = (href, key, label) =>
    `<a class="v-tab${key === active ? ' active' : ''}" href="${href}" data-link role="tab" aria-selected="${key === active}">${label}</a>`;
  return `<nav class="v-tabs" role="tablist" aria-label="Filme und Serien">
      ${tab('/videos', 'home', 'Übersicht')}${tab('/movies', 'movies', 'Filme')}${tab('/shows', 'shows', 'Serien')}
    </nav>`;
}

function pickFeatured(list) {
  const withArt = list.filter((t) => t.backdrop);
  if (!withArt.length) return null;
  const fresh = withArt.filter((t) => !isDone(t));
  const pool = (fresh.length ? fresh : withArt).slice().sort((a, b) => String(b.newest || b.addedAt).localeCompare(String(a.newest || a.addedAt))).slice(0, 8);
  // Changes once a day rather than on every visit.
  const day = Math.floor(Date.now() / 86_400_000);
  return pool[day % pool.length];
}

function featuredHero(t) {
  const film = t.kind === 'movie';
  return hero({
    backdrop: t.backdrop,
    logo: t.logo,
    title: t.title,
    label: film ? 'Film-Tipp' : 'Serien-Tipp',
    meta: facts([
      t.year,
      certLabel(t.certification),
      film ? (t.duration ? fmt.durationLong(t.duration) : '') : t.seasons ? fmt.plural(t.seasons, 'Staffel', 'Staffeln') : '',
    ]),
    overview: t.overview,
    actions: film
      ? `<a class="btn btn-primary" href="/watch/${t.videoId}" data-link>${icon('play', 16)} ${t.progress.started ? 'Fortsetzen' : 'Abspielen'}</a>
         <a class="btn btn-ghost" href="/movies/${t.id}" data-link>${icon('info', 16)} Mehr Infos</a>`
      : `<a class="btn btn-primary" href="/shows/${t.id}" data-link>${icon('info', 16)} Zur Serie</a>`,
  });
}

const settingsLink = '<a href="/settings" class="btn btn-primary" data-link>Zu den Einstellungen</a>';

export async function videos() {
  const data = await api.videoHome();
  if (!data.movies.length && !data.shows.length) {
    return {
      title: 'Filme & Serien',
      html: `${tabs('home')}
        ${empty('Noch keine Filme und Serien gefunden', 'Sonorus liest den Ordner unter VIDEO_DIR: darin "movies" mit einem Ordner je Film und "shows" mit einem Ordner je Serie. Starte einen Scan, sobald dort etwas liegt.', settingsLink)}`,
    };
  }
  const featured = pickFeatured([...data.movies, ...data.shows]);
  const newMovies = data.movies.slice().sort(SORTS.added.cmp).slice(0, 16);
  const newShows = data.shows.slice().sort(SORTS.added.cmp).slice(0, 16);

  return {
    title: 'Filme & Serien',
    html: `${tabs('home')}
      ${featured ? featuredHero(featured) : ''}
      ${noTmdbHint(data)}
      ${wideShelf('Weiterschauen', data.continue)}
      ${shelf('Neue Filme', newMovies.map(movieCard), data.movies.length ? '<a class="rack-label" href="/movies" data-link>Alle Filme</a>' : '')}
      ${shelf('Neue Folgen', newShows.map(showCard), data.shows.length ? '<a class="rack-label" href="/shows" data-link>Alle Serien</a>' : '')}
      ${shelf(
        'Filmreihen',
        data.collections.map((c) =>
          posterCard({
            href: `/collections/${c.id}`,
            poster: c.poster,
            title: c.name,
            sub: `${fmt.plural(c.movies, 'Film', 'Filme')}${c.watched ? ` · ${c.watched} gesehen` : ''}`,
            done: c.watched >= c.movies,
          })
        ),
        data.collections.length ? '<a class="rack-label" href="/collections" data-link>Alle Reihen</a>' : ''
      )}`,
    after: (root) => {
      applyProgress(root);
      return wireContinueDone(root);
    },
  };
}

// The check on a Weiterschauen tile. A series swaps in its next episode, a film
// (or a series at its last episode) leaves the row. Only the touched tiles are
// redrawn, so the tip at the top cannot change under the click.
function wireContinueDone(root) {
  let live = true;
  const onClick = async (e) => {
    const button = e.target.closest('[data-continue-done]');
    if (!button) return;
    // The tile is a link, and app.js would follow it.
    e.preventDefault();
    e.stopPropagation();
    const tile = button.closest('[data-continue-title]');
    const titleId = Number(tile.dataset.continueTitle);
    button.disabled = true;
    try {
      await api.videoWatched(Number(button.dataset.continueDone), true);
      const data = await api.videoHome();
      if (!live) return;
      const item = data.continue.find((c) => c.title.id === titleId);
      if (item) tile.outerHTML = wideCard(item);
      else tile.remove();
      const section = root.querySelector('[data-continue]');
      if (section && !section.querySelector('[data-continue-title]')) section.remove();
      const movie = data.movies.find((m) => m.id === titleId);
      const series = data.shows.find((x) => x.id === titleId);
      const poster = movie ? [`/movies/${titleId}`, movieCard(movie)] : series ? [`/shows/${titleId}`, showCard(series)] : null;
      if (poster) {
        root.querySelectorAll(`.v-card[href="${poster[0]}"]`).forEach((card) => {
          card.outerHTML = poster[1];
        });
      }
      applyProgress(root);
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'error');
    }
  };
  root.addEventListener('click', onClick);
  return () => {
    live = false;
    root.removeEventListener('click', onClick);
  };
}

// The whole list of one kind, with the filters.
async function browsePage(ctx, key) {
  const film = key === 'movies';
  const data = film ? await api.movies() : await api.shows();
  const items = film ? data.movies : data.shows;
  const title = film ? 'Filme' : 'Serien';
  if (!items.length) {
    return {
      title,
      html: `${tabs(key)}
        ${empty(
          film ? 'Noch keine Filme gefunden' : 'Noch keine Serien gefunden',
          film
            ? 'Sonorus liest VIDEO_DIR/movies: ein Ordner je Film, etwa "Fight Club (1999)", darin die Videodatei.'
            : 'Sonorus liest VIDEO_DIR/shows: ein Ordner je Serie, darin "Season 01" usw. mit den Folgen.',
          settingsLink
        )}`,
    };
  }
  return {
    title,
    html: `${tabs(key)}
      ${browseBar(key, data.genres, browseState(ctx, key))}
      <div class="grid v-grid" data-browse-grid="${key}"></div>`,
    after: (root) => wireBrowse(root, ctx, key, items, film ? movieCard : showCard),
  };
}

export const movies = (_params, ctx) => browsePage(ctx, 'movies');
export const shows = (_params, ctx) => browsePage(ctx, 'shows');

// --- Shared detail parts ------------------------------------------------------------------

function peopleRow(title, people) {
  if (!people.length) return '';
  return `<section class="section">
      <div class="section-head"><h2>${esc(title)}</h2></div>
      <div class="v-people">${people
        .map(
          (p) => `<a class="v-person" href="/people/${p.id}" data-link>
            <span class="v-person-photo">${img(p.photo, p.name)}</span>
            <span class="v-person-name">${esc(p.name)}</span>
            ${p.character ? `<span class="v-person-role">${esc(p.character)}</span>` : ''}
          </a>`
        )
        .join('')}</div>
    </section>`;
}

const CREW_WORDS = { director: 'Regie', writer: 'Drehbuch', creator: 'Idee', composer: 'Musik' };

function crewLine(crew, studios) {
  const by = {};
  for (const c of crew) (by[c.role] ||= []).push(`<a href="/people/${c.id}" data-link>${esc(c.name)}</a>`);
  const rows = Object.entries(by).map(([role, names]) => `<div><dt>${CREW_WORDS[role] || role}</dt><dd>${names.slice(0, 4).join(', ')}</dd></div>`);
  if (studios.length) rows.push(`<div><dt>${studios.length > 1 ? 'Studios' : 'Studio'}</dt><dd>${studios.map(esc).join(', ')}</dd></div>`);
  return rows.length ? `<dl class="v-crew">${rows.join('')}</dl>` : '';
}

function genreLinks(genres, base) {
  return genres.map((g) => `<a class="chip" href="${base}" data-genre-link="${g.id}" data-link>${esc(g.name)}</a>`).join('');
}

function metaMenuButton(t) {
  return `<button type="button" class="btn btn-ghost v-more" data-title-menu="${t.id}" aria-label="Weitere Aktionen">${icon('more', 16)}</button>`;
}

// Links to a genre open the list filtered by it, the way the filter would.
function wireGenreLinks(root, ctx, key) {
  root.querySelectorAll('[data-genre-link]').forEach((a) =>
    a.addEventListener('click', () => {
      const all = { ...(ctx.prefs.videoBrowse || {}) };
      all[key] = { ...(all[key] || {}), genre: Number(a.dataset.genreLink) };
      ctx.setPref('videoBrowse', all);
    })
  );
}

// Re-renders in place: no loading placeholder, the scroll position stays.
function reload(ctx) {
  ctx.refresh();
}

// Watched toggles and the "..." menu of a detail page. `changed` redraws what
// a watched mark touched; by default the whole page, in place.
function wireTitleActions(root, ctx, changed = () => reload(ctx)) {
  const onClick = async (e) => {
    const watched = e.target.closest('[data-title-watched]');
    if (watched) {
      const season = watched.dataset.season === undefined ? null : Number(watched.dataset.season);
      try {
        await api.titleWatched(Number(watched.dataset.titleWatched), watched.dataset.done !== '1', season);
        changed();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const episodeDone = e.target.closest('[data-video-watched]');
    if (episodeDone) {
      e.preventDefault();
      try {
        await api.videoWatched(Number(episodeDone.dataset.videoWatched), episodeDone.dataset.done !== '1');
        changed();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const menu = e.target.closest('[data-title-menu]');
    if (menu) {
      const id = Number(menu.dataset.titleMenu);
      const rect = menu.getBoundingClientRect();
      contextMenu(rect.left, rect.bottom + 6, [
        { label: 'Metadaten neu laden', icon: 'refresh', onSelect: () => refresh(ctx, id) },
        { label: 'Anderen TMDB-Treffer wählen …', icon: 'edit', onSelect: () => identify(ctx, id) },
      ]);
    }
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

async function refresh(ctx, id, tmdbId) {
  toast('Metadaten werden geladen …');
  try {
    const result = await api.refreshTitle(id, tmdbId);
    toast(result.matched ? 'Metadaten aktualisiert.' : 'Bei TMDB nichts gefunden.');
    reload(ctx);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function identify(ctx, id) {
  modal({
    title: 'TMDB-Treffer wählen',
    body: `<p class="v-modal-text">Die Nummer steht in der Adresse der Seite auf themoviedb.org, etwa <code>themoviedb.org/movie/550</code>.</p>
      <div class="field"><label for="tmdb-id">TMDB-ID</label><input type="number" id="tmdb-id" min="1" inputmode="numeric" /></div>`,
    footer: `<button type="button" class="btn btn-ghost" data-close>Abbrechen</button>
      <button type="button" class="btn btn-primary" id="tmdb-apply">Übernehmen</button>`,
    autofocus: true,
    onOpen: (root) => {
      root.querySelector('#tmdb-apply').addEventListener('click', () => {
        const value = Number(root.querySelector('#tmdb-id').value);
        if (!(value > 0)) return;
        closeModal();
        refresh(ctx, id, value);
      });
    },
  });
}

function techSection(tech) {
  if (!tech) return '';
  const audio = tech.audio.map((a) => `${langName(a.lang) || 'Unbekannt'} (${a.codec.toUpperCase()}${a.channels ? ` ${a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : a.channels === 2 ? 'Stereo' : a.channels}` : ''})`);
  const subs = tech.subtitles.map((s) => `${langName(s.lang) || 'Unbekannt'}${s.forced ? ' (erzwungen)' : ''}${s.text === false ? ' (Bild)' : ''}`);
  return `<section class="section">
      <div class="section-head"><h2>Technik</h2></div>
      <dl class="v-crew v-tech">
        <div><dt>Bild</dt><dd>${esc([resolutionLabel(tech.height, tech.width), videoCodecLabel(tech.video), tech.hdr ? 'HDR' : ''].filter(Boolean).join(' · '))}</dd></div>
        ${audio.length ? `<div><dt>Ton</dt><dd>${esc(audio.join(', '))}</dd></div>` : ''}
        ${subs.length ? `<div><dt>Untertitel</dt><dd>${esc([...new Set(subs)].join(', '))}</dd></div>` : ''}
      </dl>
    </section>`;
}

// --- One film ----------------------------------------------------------------------------

export async function movie(params, ctx) {
  const { movie: m } = await api.movie(params.id);
  const v = m.video;
  const started = v && v.progress.started;
  const cast = m.cast.slice(0, 20);

  const actions = v
    ? `<a class="btn btn-primary" href="/watch/${v.id}" data-link>${icon('play', 16)} ${started ? `Fortsetzen (noch ${fmt.durationLong(v.duration - v.progress.position)})` : 'Abspielen'}</a>
       ${started ? `<a class="btn btn-ghost" href="/watch/${v.id}?t=0" data-link>${icon('refresh', 16)} Von vorne</a>` : ''}
       <button type="button" class="btn btn-ghost" data-title-watched="${m.id}" data-done="${v.progress.completed ? '1' : '0'}">
         ${icon(v.progress.completed ? 'eye-off' : 'check-circle', 16)} ${v.progress.completed ? 'Als ungesehen markieren' : 'Als gesehen markieren'}
       </button>
       ${metaMenuButton(m)}`
    : '';

  return {
    title: m.title,
    html: `${hero({
      backdrop: m.backdrop,
      logo: m.logo,
      title: m.title,
      label: 'Film',
      poster: m.poster || null,
      zoom: m.poster,
      meta: `${facts([
        m.year,
        v && v.duration ? fmt.durationLong(v.duration) : '',
        m.certification ? `<span class="v-cert">${esc(certLabel(m.certification))}</span>` : '',
        m.vote ? `<span class="v-vote" title="TMDB-Wertung">${icon('star', 12)} ${m.vote.toFixed(1)}</span>` : '',
        v && v.tech ? esc(resolutionLabel(v.tech.height, v.tech.width)) : '',
      ])}`,
      overview: '',
      actions,
    })}
      ${started ? `<div class="v-detail-progress">${progressBar(v.progress.fraction)}</div>` : ''}
      <div class="v-detail-body">
        ${m.tagline ? `<p class="v-tagline">${esc(m.tagline)}</p>` : ''}
        ${m.overview ? `<p class="prose v-overview">${esc(m.overview)}</p>` : ''}
        ${m.originalTitle ? `<p class="v-original">Originaltitel: ${esc(m.originalTitle)}</p>` : ''}
        ${m.genres.length ? `<div class="chip-row v-genres">${genreLinks(m.genres, '/movies')}</div>` : ''}
        ${crewLine(m.crew, m.studios)}
      </div>
      ${peopleRow('Besetzung', cast)}
      ${
        m.collection
          ? shelf(
              m.collection.name,
              m.collection.movies.map((x) => movieCard(x).replace('class="card portrait v-card"', `class="card portrait v-card${x.id === m.id ? ' is-current' : ''}"`)),
              `<a class="rack-label" href="/collections/${m.collection.id}" data-link>Zur Reihe</a>`
            )
          : ''
      }
      ${shelf('Ähnliche Filme', m.similar.map((x) => posterCard({ href: `/movies/${x.id}`, poster: x.poster, title: x.title, sub: String(x.year || '') })))}
      ${techSection(v && v.tech)}`,
    after: (root) => {
      applyProgress(root);
      wireGenreLinks(root, ctx, 'movies');
      return wireTitleActions(root, ctx);
    },
  };
}

// --- One series ------------------------------------------------------------------------

function episodeCheck(e) {
  const done = e.progress.completed;
  return `<button type="button" class="icon-btn v-episode-check${done ? ' is-on' : ''}" data-video-watched="${e.id}" data-done="${done ? '1' : '0'}"
      aria-label="${done ? 'Als ungesehen markieren' : 'Als gesehen markieren'}" title="${done ? 'Gesehen' : 'Als gesehen markieren'}">${icon('check-circle', 20)}</button>`;
}

function episodeRow(e) {
  const code = e.season === 0 ? (e.episode != null ? `Special ${e.episode}` : 'Special') : `Folge ${e.episode ?? '?'}${e.episodeEnd ? `-${e.episodeEnd}` : ''}`;
  return `<div class="v-episode${e.progress.completed ? ' is-done' : ''}" data-episode="${e.id}">
      <a class="v-episode-art" href="/watch/${e.id}" data-link aria-label="${esc(e.name || code)} abspielen">
        ${img(e.still, e.name || code)}
        <span class="v-wide-play">${icon('play', 20)}</span>
        ${e.progress.started ? progressBar(e.progress.fraction) : ''}
      </a>
      <div class="v-episode-text">
        <div class="v-episode-head">
          <span class="rack-label">${esc(code)}</span>
          <span class="v-episode-time num">${e.duration ? fmt.durationLong(e.duration) : ''}</span>
        </div>
        <a class="v-episode-name" href="/watch/${e.id}" data-link>${esc(e.name || code)}</a>
        ${e.overview ? `<p class="v-episode-overview">${esc(e.overview)}</p>` : ''}
        ${e.airDate ? `<span class="v-episode-date">${esc(fmt.releaseDate(e.airDate))}</span>` : ''}
      </div>
      ${episodeCheck(e)}
    </div>`;
}

function showFacts(s) {
  const years = s.endDate && s.year && s.endDate.slice(0, 4) !== String(s.year) ? `${s.year}-${s.endDate.slice(0, 4)}` : s.year;
  return facts([
    years,
    fmt.plural(s.seasons.filter((x) => x.season !== 0).length, 'Staffel', 'Staffeln'),
    fmt.plural(s.episodes, 'Folge', 'Folgen'),
    s.certification ? `<span class="v-cert">${esc(certLabel(s.certification))}</span>` : '',
    s.vote ? `<span class="v-vote" title="TMDB-Wertung">${icon('star', 12)} ${s.vote.toFixed(1)}</span>` : '',
    s.watched ? `${s.watched}/${s.episodes} gesehen` : '',
  ]);
}

function showActions(s) {
  const next = s.next;
  const label = next ? episodeCode(next.season, next.episode, next.episodeEnd) : '';
  const allDone = s.episodes > 0 && s.watched >= s.episodes;
  return `${
    next
      ? `<a class="btn btn-primary" href="/watch/${next.id}" data-link>${icon('play', 16)} ${
          next.progress.started ? `${label} fortsetzen` : s.watched ? `${label} abspielen` : 'Abspielen'
        }</a>`
      : ''
  }
    <button type="button" class="btn btn-ghost" data-title-watched="${s.id}" data-done="${allDone ? '1' : '0'}">
      ${icon(allDone ? 'eye-off' : 'check-circle', 16)} ${allDone ? 'Als ungesehen markieren' : 'Alles als gesehen markieren'}
    </button>
    ${metaMenuButton(s)}`;
}

function seasonFacts(x) {
  return facts([fmt.plural(x.episodes.length, 'Folge', 'Folgen'), x.airDate ? x.airDate.slice(0, 4) : '', x.watched ? `${x.watched} gesehen` : '']);
}

function seasonButton(s, x) {
  const done = x.watched >= x.episodes.length;
  return `<button type="button" class="btn btn-ghost btn-sm" data-title-watched="${s.id}" data-season="${x.season}" data-done="${done ? '1' : '0'}">
      ${icon(done ? 'eye-off' : 'check-circle', 15)} ${done ? 'Staffel als ungesehen markieren' : 'Staffel als gesehen markieren'}
    </button>`;
}

// A watched mark changes counts, buttons and the next episode, never a picture.
// Patching those instead of rendering the page again keeps the scroll position,
// the open season, and every click of a quick run down the list.
function patchShow(root, s) {
  root.querySelector('.v-hero-facts').innerHTML = showFacts(s);
  root.querySelector('.v-hero-actions').innerHTML = showActions(s);
  for (const x of s.seasons) {
    const block = root.querySelector(`.v-season[data-season="${x.season}"]`);
    if (!block) continue;
    block.querySelector('.v-season-facts').innerHTML = seasonFacts(x);
    block.querySelector('.v-season-head [data-title-watched]').outerHTML = seasonButton(s, x);
    for (const e of x.episodes) {
      const row = block.querySelector(`[data-episode="${e.id}"]`);
      if (!row) continue;
      row.classList.toggle('is-done', e.progress.completed);
      const art = row.querySelector('.v-episode-art');
      art.querySelector('.v-progress')?.remove();
      if (e.progress.started) art.insertAdjacentHTML('beforeend', progressBar(e.progress.fraction));
      row.querySelector('[data-video-watched]').outerHTML = episodeCheck(e);
    }
  }
  applyProgress(root);
}

export async function show(params, ctx) {
  const { show: s } = await api.show(params.id);
  const startSeason = Number(params.get('season'));
  const shownSeason = s.seasons.some((x) => x.season === startSeason)
    ? startSeason
    : s.next
      ? s.next.season
      : (s.seasons[0] || {}).season;

  const seasonTabs = s.seasons.length > 1
    ? `<div class="v-season-tabs" role="tablist">${s.seasons
        .map((x) => `<button type="button" role="tab" class="v-season-tab${x.season === shownSeason ? ' active' : ''}" data-season-tab="${x.season}">${esc(x.name)}</button>`)
        .join('')}</div>`
    : '';

  const seasonBlocks = s.seasons
    .map(
      (x) => `<div class="v-season" data-season="${x.season}"${x.season === shownSeason ? '' : ' hidden'}>
        <div class="v-season-head">
          ${x.poster ? `<span class="v-season-poster">${img(x.poster, x.name)}</span>` : ''}
          <div class="v-season-text">
            <h2>${esc(x.name)}</h2>
            <div class="v-season-facts">${seasonFacts(x)}</div>
            ${x.overview ? `<p class="v-season-overview">${esc(x.overview)}</p>` : ''}
            ${seasonButton(s, x)}
          </div>
        </div>
        <div class="v-episodes">${x.episodes.map(episodeRow).join('')}</div>
      </div>`
    )
    .join('');

  return {
    title: s.title,
    html: `${hero({
      backdrop: s.backdrop,
      logo: s.logo,
      title: s.title,
      label: 'Serie',
      poster: s.poster || null,
      zoom: s.poster,
      meta: showFacts(s),
      overview: '',
      actions: showActions(s),
    })}
      <div class="v-detail-body">
        ${s.tagline ? `<p class="v-tagline">${esc(s.tagline)}</p>` : ''}
        ${s.overview ? `<p class="prose v-overview">${esc(s.overview)}</p>` : ''}
        ${s.genres.length ? `<div class="chip-row v-genres">${genreLinks(s.genres, '/shows')}</div>` : ''}
        ${crewLine(s.crew, s.studios)}
      </div>
      <section class="section">
        ${seasonTabs}
        ${seasonBlocks}
      </section>
      ${peopleRow('Besetzung', s.cast.slice(0, 20))}
      ${shelf('Ähnliche Serien', s.similar.map((x) => posterCard({ href: `/shows/${x.id}`, poster: x.poster, title: x.title, sub: String(x.year || '') })))}`,
    after: (root) => {
      applyProgress(root);
      wireGenreLinks(root, ctx, 'shows');
      root.querySelectorAll('[data-season-tab]').forEach((tab) =>
        tab.addEventListener('click', () => {
          const season = tab.dataset.seasonTab;
          root.querySelectorAll('[data-season-tab]').forEach((t) => t.classList.toggle('active', t === tab));
          root.querySelectorAll('.v-season[data-season]').forEach((b) => {
            b.hidden = b.dataset.season !== season;
          });
          window.history.replaceState(window.history.state, '', `/shows/${s.id}?season=${season}`);
        })
      );
      // Only the newest answer is drawn: two quick marks can come back out of
      // order. `root` is the app's content box and outlives the page, so an
      // answer that lands after leaving it must not be drawn at all.
      let seq = 0;
      let live = true;
      const changed = async () => {
        const mine = (seq += 1);
        try {
          const { show: fresh } = await api.show(s.id);
          if (mine === seq && live) patchShow(root, fresh);
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      const unwire = wireTitleActions(root, ctx, changed);
      return () => {
        live = false;
        unwire();
      };
    },
  };
}

// --- Film series ------------------------------------------------------------------------

export async function collections(_params, ctx) {
  const { collections: list } = await api.collections();
  return {
    title: 'Filmreihen',
    html: `<div class="page-head"><span class="rack-label">Filme</span><h1>Filmreihen</h1>
        <div class="page-meta">${fmt.plural(list.length, 'Reihe', 'Reihen')}</div></div>
      ${
        list.length
          ? `<div class="grid v-grid">${list
              .map((c) =>
                posterCard({
                  href: `/collections/${c.id}`,
                  poster: c.poster,
                  title: c.name,
                  sub: `${fmt.plural(c.movies, 'Film', 'Filme')}${c.watched ? ` · ${c.watched} gesehen` : ''}`,
                  done: c.watched >= c.movies,
                })
              )
              .join('')}</div>`
          : empty('Keine Filmreihen', 'Eine Reihe erscheint, sobald mindestens zwei ihrer Filme in der Bibliothek liegen und TMDB sie kennt.')
      }`,
    after: applyProgress,
  };
}

export async function collection(params) {
  const { collection: c } = await api.collection(params.id);
  const next = c.movies.find((m) => !m.progress.completed) || c.movies[0];
  const watched = c.movies.filter((m) => m.progress.completed).length;
  return {
    title: c.name,
    html: `${hero({
      backdrop: c.backdrop,
      title: c.name,
      label: 'Filmreihe',
      poster: c.poster || null,
      zoom: c.poster,
      meta: facts([fmt.plural(c.movies.length, 'Film', 'Filme'), watched ? `${watched} gesehen` : '']),
      overview: c.overview,
      actions: next
        ? `<a class="btn btn-primary" href="/watch/${next.videoId}" data-link>${icon('play', 16)} ${esc(
            next.progress.started ? `${next.title} fortsetzen` : watched ? `Weiter mit ${next.title}` : 'Mit dem ersten Film beginnen'
          )}</a>`
        : '',
    })}
      <section class="section">
        <div class="section-head"><h2>In der Reihe</h2></div>
        <div class="grid v-grid v-numbered">${c.movies.map(movieCard).join('')}</div>
      </section>`,
    after: applyProgress,
  };
}

// --- A person ---------------------------------------------------------------------------

export async function person(params) {
  const { person: p } = await api.person(params.id);
  const card = (t) =>
    posterCard({
      href: `/${t.kind === 'movie' ? 'movies' : 'shows'}/${t.id}`,
      poster: t.poster,
      title: t.title,
      sub: [t.year, t.roles.join(', ')].filter(Boolean).join(' · '),
    });
  return {
    title: p.name,
    html: `<div class="detail-head">
        <div class="detail-art round">${img(p.photo, p.name)}</div>
        <div class="detail-text">
          <span class="rack-label">Person</span>
          <h1>${esc(p.name)}</h1>
          <div class="detail-facts">${facts([
            p.movies.length ? fmt.plural(p.movies.length, 'Film', 'Filme') : '',
            p.shows.length ? fmt.plural(p.shows.length, 'Serie', 'Serien') : '',
          ])} <span class="dot">·</span> in deiner Bibliothek</div>
        </div>
      </div>
      ${p.movies.length ? `<section class="section"><div class="section-head"><h2>Filme</h2></div><div class="grid v-grid">${p.movies.map(card).join('')}</div></section>` : ''}
      ${p.shows.length ? `<section class="section"><div class="section-head"><h2>Serien</h2></div><div class="grid v-grid">${p.shows.map(card).join('')}</div></section>` : ''}`,
  };
}

// --- The player ------------------------------------------------------------------------

export async function watch(params, ctx) {
  const { video } = await api.video(params.id);
  const t = params.get('t');
  const start = t !== null && t !== '' ? Math.max(0, Number(t) || 0) : video.progress.position || 0;
  const heading = video.kind === 'show'
    ? `${video.title.title} · ${episodeCode(video.season, video.episode, video.episodeEnd)}`
    : video.title.title;
  return {
    title: video.kind === 'show' ? `${video.name || heading} · ${video.title.title}` : video.title.title,
    full: true,
    html: `<div class="vp" id="vp" data-heading="${esc(heading)}"></div>`,
    after: (root) => mountPlayer(root.querySelector('#vp'), video, ctx, { start }),
  };
}

export { applyProgress as applyVideoProgress };
