// Full-window player on a plain <video>. A remuxed or re-encoded stream cannot seek, so the
// player keeps its own clock (`offset` + the element's time) and requests a new stream on a jump.

import { api, errorText } from './api.js';
import { icon, paintIcons } from './icons.js';
import * as fmt from './format.js';
import { esc, toast } from './ui.js';
import { audioLabel, subtitleLabel, episodeCode } from './video-format.js';
import { reclaimMediaSession } from './player.js';

const NEXT_LEAD = 30;
const HIDE_AFTER_MS = 3000;
const SAVE_EVERY = 10;
const PLAY_REPORT_EVERY = 30;
const COMPLETE_AT = 0.9;
const SKIP = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const MODE_NAMES = { direct: 'Direkt', remux: 'Umverpackt', encode: 'Umgewandelt' };
const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', vc1: 'VC-1' };

// Module-wide, so the overlay stays open from one episode to the next.
let statsOpen = false;

function browserCaps() {
  const v = document.createElement('video');
  const ok = (type) => v.canPlayType(type) !== '';
  return {
    hevc: ok('video/mp4; codecs="hvc1.1.6.L120.90"'),
    av1: ok('video/mp4; codecs="av01.0.08M.08"'),
    vp9: ok('video/webm; codecs="vp9"'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ahead = (sec) => (sec < 100 ? `${Math.max(0, Math.round(sec))} s` : fmt.duration(sec));

// Cue text is escaped whole, then the three tags the server lets through come back.
function cueHtml(text) {
  return esc(text)
    .replace(/&lt;(\/?)([ibu])&gt;/g, '<$1$2>')
    .replace(/\n/g, '<br>');
}

function template(info, heading) {
  const isShow = info.kind === 'show';
  return `
    <video class="vp-video" playsinline preload="auto"></video>
    <div class="vp-stage" data-vp="stage"></div>
    <div class="vp-subs" aria-live="off"></div>
    <div class="vp-spinner" aria-hidden="true"></div>
    <div class="vp-flash" aria-hidden="true"></div>
    <dl class="vp-stats num" hidden></dl>
    <button type="button" class="vp-bigplay" data-vp="play" hidden aria-label="Abspielen">${icon('play', 44)}</button>

    <div class="vp-top">
      <button type="button" class="vp-btn" data-vp="back" aria-label="Zurück" title="Zurück">${icon('arrow-left', 24)}</button>
      <div class="vp-heading">
        <span class="rack-label">${esc(heading)}</span>
        <h1>${esc(isShow ? info.name || episodeCode(info.season, info.episode, info.episodeEnd) : info.title.title)}</h1>
      </div>
    </div>

    <div class="vp-bottom">
      <div class="vp-rail" data-vp="rail" role="slider" tabindex="-1" aria-label="Position" aria-valuemin="0" aria-valuemax="100">
        <div class="vp-track"><div class="vp-buffer"></div><div class="vp-fill"></div><div class="vp-knob"></div></div>
        <div class="vp-tip num" hidden></div>
      </div>
      <div class="vp-bar">
        <div class="vp-group">
          <button type="button" class="vp-btn vp-play" id="vp-play" data-vp="toggle" aria-label="Abspielen" title="Abspielen (Leertaste)">${icon('play', 26)}</button>
          <button type="button" class="vp-btn" id="vp-back10" data-vp="back10" aria-label="10 Sekunden zurück" title="10 Sekunden zurück">${icon('skip-back-10', 24)}</button>
          <button type="button" class="vp-btn" id="vp-fwd10" data-vp="fwd10" aria-label="10 Sekunden vor" title="10 Sekunden vor">${icon('skip-forward-10', 24)}</button>
          <div class="vp-volume">
            <button type="button" class="vp-btn" data-vp="mute" aria-label="Stumm schalten" title="Stumm schalten (M)">${icon('volume-high', 22)}</button>
            <input type="range" class="vp-volume-range" min="0" max="1" step="0.02" aria-label="Lautstärke" />
          </div>
          <span class="vp-time num"><span data-vp-now>0:00</span><span class="vp-sep">/</span><span data-vp-total>${fmt.duration(info.duration)}</span></span>
        </div>
        <div class="vp-group">
          ${info.next ? `<button type="button" class="vp-btn" id="vp-next" data-vp="next" aria-label="Nächste Folge" title="Nächste Folge (N)">${icon('skip-forward', 22)}</button>` : ''}
          ${isShow ? `<button type="button" class="vp-btn" data-vp="episodes" aria-label="Folgen" title="Folgen">${icon('layers', 22)}</button>` : ''}
          <button type="button" class="vp-btn" data-vp="tracks" aria-label="Ton und Untertitel" title="Ton und Untertitel (C)">${icon('captions', 22)}</button>
          <button type="button" class="vp-btn" data-vp="settings" aria-label="Wiedergabe" title="Geschwindigkeit und Autoplay">${icon('gauge', 22)}</button>
          <button type="button" class="vp-btn" data-vp="fullscreen" aria-label="Vollbild" title="Vollbild (F)">${icon('maximize', 22)}</button>
        </div>
      </div>
    </div>

    <div class="vp-panel vp-menu" data-panel="tracks" hidden></div>
    <div class="vp-panel vp-menu vp-menu-small" data-panel="settings" hidden></div>
    <div class="vp-panel vp-episodes-panel" data-panel="episodes" hidden></div>

    ${
      info.next
        ? `<div class="vp-next" hidden>
            <div class="vp-next-art">${info.next.still ? `<img src="${esc(info.next.still)}" alt="" />` : ''}</div>
            <div class="vp-next-text">
              <span class="rack-label">Nächste Folge</span>
              <strong>${esc(episodeCode(info.next.season, info.next.episode, info.next.episodeEnd))}${info.next.name ? ` · ${esc(info.next.name)}` : ''}</strong>
              <div class="vp-next-actions">
                <button type="button" class="btn btn-primary vp-next-go" data-vp="next"><span class="vp-next-fill"></span><span class="vp-next-label">${icon('play', 15)} Jetzt ansehen</span></button>
                <button type="button" class="btn btn-ghost" data-vp="credits">Abspann ansehen</button>
              </div>
            </div>
          </div>`
        : ''
    }
    <div class="vp-end" hidden>
      <span class="rack-label">Zu Ende</span>
      <h2>${esc(info.title.title)}</h2>
      <div class="vp-end-actions">
        <button type="button" class="btn btn-primary" data-vp="again">${icon('refresh', 16)} Nochmal ansehen</button>
        <button type="button" class="btn btn-ghost" data-vp="back">${icon('arrow-left', 16)} Zurück</button>
      </div>
    </div>`;
}

/**
 * Builds the player into `el` and starts `info` at `start` seconds. Returns the
 * cleanup the router calls when the page is left.
 */
export function mountPlayer(el, info, ctx, { start = 0 } = {}) {
  const heading = el.dataset.heading || info.title.title;
  el.innerHTML = template(info, heading);
  const $ = (sel) => el.querySelector(sel);
  const video = $('.vp-video');
  const subsEl = $('.vp-subs');
  const rail = $('[data-vp="rail"]');
  const fill = $('.vp-fill');
  const knob = $('.vp-knob');
  const buffer = $('.vp-buffer');
  const tip = $('.vp-tip');
  const nowEl = el.querySelector('[data-vp-now]');
  const nextCard = $('.vp-next');
  const endCard = $('.vp-end');
  const bigPlay = $('.vp-bigplay');
  const volumeRange = $('.vp-volume-range');

  const caps = browserCaps();
  const prefs = ctx.prefs || {};
  const s = {
    offset: 0,
    mode: null,
    audio: null,
    sub: null,
    subSeq: 0,
    cues: [],
    cueShown: '',
    loadSeq: 0,
    pending: null,
    pendingTimer: null,
    lastSaved: -1,
    lastSaveAt: 0,
    playId: null,
    playPending: false,
    watched: 0,
    reported: 0,
    tick: null,
    nextDismissed: false,
    forceComplete: false,
    keepFullscreen: false,
    dragging: false,
    destroyed: false,
    failed: 0,
    recoveredAt: 0,
    frame: 0,
    plan: null,
    server: null,
    statsTimer: null,
    statsBusy: false,
  };
  const duration = info.duration || 0;

  document.body.classList.add('watching');
  // The music stops when a film starts.
  const music = document.getElementById('audio');
  if (music && !music.paused) music.pause();

  video.volume = clamp(Number(prefs.videoVolume ?? 1), 0, 1);
  video.muted = !!prefs.videoMuted;

  const now = () => (s.pending !== null ? s.pending : s.offset + (video.currentTime || 0));

  // --- Loading -----------------------------------------------------------------------

  async function load(at, { audio, force, paused = false } = {}) {
    const seq = (s.loadSeq += 1);
    el.classList.add('is-loading');
    s.pending = at;
    let plan;
    try {
      ({ plan } = await api.videoPlan(info.id, {
        start: at,
        audio: audio !== undefined ? audio : s.audio,
        caps,
        force,
      }));
    } catch (err) {
      toast(errorText(err), 'err');
      el.classList.remove('is-loading');
      if (seq === s.loadSeq) s.pending = null;
      return;
    }
    if (seq !== s.loadSeq || s.destroyed) return;
    s.mode = plan.mode;
    s.audio = plan.audio;
    s.plan = plan;
    if (plan.mode === 'direct') {
      const url = new URL(plan.url, window.location.href).href;
      s.offset = 0;
      if (video.src !== url) {
        video.src = url;
        await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
        if (seq !== s.loadSeq || s.destroyed) return;
      }
      video.currentTime = at;
    } else {
      s.offset = plan.offset;
      video.src = plan.url;
    }
    s.pending = null;
    if (!paused) play();
    renderTracksMenu();
  }

  function play() {
    const attempt = video.play();
    if (attempt && attempt.catch) {
      attempt.catch(() => {
        bigPlay.hidden = false;
        el.classList.remove('is-loading');
      });
    }
  }

  function toggle() {
    if (!nextCard || nextCard.hidden) endCard.hidden = true;
    if (video.paused) {
      bigPlay.hidden = true;
      if (video.ended) seek(0);
      if (!video.ended || s.mode === 'direct') play();
    } else {
      video.pause();
    }
    flash(video.paused ? 'pause' : 'play');
  }

  // A direct file seeks itself; a stream is asked for again, a moment after the
  // last key press so holding an arrow does not start twenty ffmpegs.
  function seek(t) {
    const target = clamp(t, 0, Math.max(0, duration - 0.5));
    if (target < duration - NEXT_LEAD) s.nextDismissed = false;
    endCard.hidden = true;
    if (s.mode === 'direct') {
      video.currentTime = target;
    } else {
      s.pending = target;
      clearTimeout(s.pendingTimer);
      const paused = video.paused && !video.ended;
      s.pendingTimer = setTimeout(() => load(target, { paused }), 350);
    }
    paint(true);
    save();
  }

  // --- Saving where we are -------------------------------------------------------------

  function save(keepalive = false) {
    if (!duration) return;
    const at = now();
    const completed = s.forceComplete || at >= duration * COMPLETE_AT;
    if (!keepalive && !completed && Math.abs(at - s.lastSaved) < 2) return;
    s.lastSaved = at;
    s.lastSaveAt = at;
    api.videoProgress(info.id, { position: at, completed }, keepalive).catch(() => {});
  }

  function countWatching() {
    const t = performance.now();
    if (s.tick !== null && !video.paused) {
      const d = (t - s.tick) / 1000;
      if (d > 0 && d < 2) s.watched += d;
    }
    s.tick = video.paused ? null : t;
    if (!s.playId && !s.playPending && s.watched >= 10) {
      s.playPending = true;
      api
        .videoPlay(info.id)
        .then((r) => {
          s.playId = r.playId;
        })
        .catch(() => {})
        .finally(() => {
          s.playPending = false;
        });
    }
    if (s.playId && s.watched - s.reported >= PLAY_REPORT_EVERY) reportWatched();
  }

  function reportWatched(keepalive = false) {
    if (!s.playId) return;
    s.reported = s.watched;
    api.videoPlayTime(s.playId, Math.round(s.watched), keepalive).catch(() => {});
  }

  // --- Painting ------------------------------------------------------------------------

  function paint(force = false) {
    const at = now();
    const frac = duration ? clamp(at / duration, 0, 1) : 0;
    if (!s.dragging || force) {
      fill.style.width = `${frac * 100}%`;
      knob.style.left = `${frac * 100}%`;
      nowEl.textContent = fmt.duration(at);
      rail.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
      rail.setAttribute('aria-valuetext', fmt.duration(at));
    }
    buffer.style.width = `${duration ? clamp(bufferedEnd() / duration, 0, 1) * 100 : 0}%`;
    renderCue(at);
    checkNext(at);
  }

  // After a jump the last range can lie far ahead of the playhead; only the one it sits in counts.
  function bufferedEnd() {
    const b = video.buffered;
    const t = video.currentTime;
    let end = 0;
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) <= t + 1 && t <= b.end(i)) end = s.offset + b.end(i);
    }
    return end;
  }

  function loop() {
    paint();
    countWatching();
    const at = now();
    if (!video.paused && Math.abs(at - s.lastSaveAt) >= SAVE_EVERY) save();
    s.frame = requestAnimationFrame(loop);
  }

  function flash(name) {
    const f = $('.vp-flash');
    f.innerHTML = icon(name, 46);
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  function renderPlayState() {
    const playing = !video.paused;
    const button = $('[data-vp="toggle"]');
    button.innerHTML = icon(playing ? 'pause' : 'play', 26);
    button.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
    button.title = playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)';
    el.classList.toggle('is-paused', !playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function renderVolume() {
    const level = video.muted ? 0 : video.volume;
    volumeRange.value = String(level);
    volumeRange.style.setProperty('--level', `${level * 100}%`);
    const name = level === 0 ? 'volume-mute' : level < 0.5 ? 'volume-low' : 'volume-high';
    $('[data-vp="mute"]').innerHTML = icon(name, 22);
  }

  // --- Subtitles -----------------------------------------------------------------------

  function renderCue(at) {
    if (!s.cues.length) {
      if (s.cueShown) {
        subsEl.innerHTML = '';
        s.cueShown = '';
      }
      return;
    }
    const active = s.cues.filter((c) => c.s <= at && at <= c.e);
    const text = active.map((c) => c.t).join('\n');
    if (text === s.cueShown) return;
    s.cueShown = text;
    subsEl.innerHTML = text ? `<span>${cueHtml(text)}</span>` : '';
  }

  async function setSubtitle(key, { remember = true } = {}) {
    s.sub = key;
    s.cues = [];
    renderCue(now());
    const seq = (s.subSeq += 1);
    const track = info.subtitles.find((x) => x.key === key);
    if (remember) ctx.setPref('videoSubLang', track ? track.lang || 'und' : '');
    renderTracksMenu();
    if (!track) return;
    let told = false;
    for (;;) {
      let res;
      try {
        res = await api.videoSubtitles(info.id, key);
      } catch (err) {
        toast(errorText(err), 'err');
        return;
      }
      if (seq !== s.subSeq || s.destroyed) return;
      if (!res.pending) {
        s.cues = res.cues || [];
        if (told) toast('Untertitel sind da.');
        renderCue(now());
        return;
      }
      if (!told) {
        toast('Untertitel werden aus der Datei gelesen, das dauert einen Moment …');
        told = true;
      }
      await sleep(3000);
    }
  }

  function defaultSubtitle() {
    const lang = prefs.videoSubLang;
    if (!lang) return null;
    const usable = info.subtitles.filter((x) => x.supported && (x.lang || 'und') === lang);
    const pick = usable.find((x) => !x.forced && !x.sdh) || usable[0];
    return pick ? pick.key : null;
  }

  function cycleSubtitle() {
    const usable = info.subtitles.filter((x) => x.supported);
    if (!usable.length) return;
    const at = usable.findIndex((x) => x.key === s.sub);
    const next = at + 1 < usable.length ? usable[at + 1].key : null;
    setSubtitle(next);
    const label = next && subtitleLabel(usable[at + 1]);
    toast(next ? `Untertitel: ${label.main} · ${label.sub}` : 'Untertitel aus');
  }

  // --- Menus ----------------------------------------------------------------------------

  function renderTracksMenu() {
    const panel = $('[data-panel="tracks"]');
    const audio = info.audio
      .map((a) => {
        const label = audioLabel(a);
        const on = a.index === s.audio;
        return `<button type="button" class="vp-option${on ? ' active' : ''}" data-audio="${a.index}">
            <span class="vp-check">${on ? icon('check', 16) : ''}</span>
            <span class="vp-option-text"><span>${esc(label.main)}</span><small>${esc(label.sub)}</small></span>
          </button>`;
      })
      .join('');
    const subs = [
      `<button type="button" class="vp-option${s.sub ? '' : ' active'}" data-sub="">
         <span class="vp-check">${s.sub ? '' : icon('check', 16)}</span><span class="vp-option-text"><span>Aus</span></span>
       </button>`,
      ...info.subtitles.map((x) => {
        const on = x.key === s.sub;
        const label = subtitleLabel(x);
        const sub = x.supported ? (x.external ? `${label.sub} · Datei` : label.sub) : 'Bild-Untertitel, nicht unterstützt';
        return `<button type="button" class="vp-option${on ? ' active' : ''}" data-sub="${x.key}"${x.supported ? '' : ' disabled'}>
            <span class="vp-check">${on ? icon('check', 16) : ''}</span>
            <span class="vp-option-text"><span>${esc(label.main)}</span><small>${esc(sub)}</small></span>
          </button>`;
      }),
    ].join('');
    panel.innerHTML = `<div class="vp-menu-col">
        <span class="rack-label">Ton</span>
        ${audio || '<p class="vp-empty">Keine Tonspur</p>'}
      </div>
      <div class="vp-menu-col">
        <span class="rack-label">Untertitel</span>
        ${subs}
      </div>`;
  }

  function autoplayOn() {
    return (ctx.prefs || {}).videoAutoplay !== false;
  }

  function renderSettingsMenu() {
    const panel = $('[data-panel="settings"]');
    panel.innerHTML = `<div class="vp-menu-col">
        <span class="rack-label">Geschwindigkeit</span>
        ${SPEEDS.map((r) => `<button type="button" class="vp-option${video.playbackRate === r ? ' active' : ''}" data-speed="${r}">
            <span class="vp-check">${video.playbackRate === r ? icon('check', 16) : ''}</span>
            <span class="vp-option-text"><span>${r === 1 ? 'Normal' : `${String(r).replace('.', ',')}x`}</span></span>
          </button>`).join('')}
        ${
          info.kind === 'show'
            ? `<span class="rack-label vp-menu-gap">Serien</span>
               <label class="vp-option vp-switch"><input type="checkbox" data-autoplay${autoplayOn() ? ' checked' : ''} />
                 <span class="vp-option-text"><span>Nächste Folge automatisch</span></span></label>`
            : ''
        }
        <span class="rack-label vp-menu-gap">Anzeige</span>
        <label class="vp-option vp-switch"><input type="checkbox" data-stats${statsOpen ? ' checked' : ''} />
          <span class="vp-option-text"><span>Technische Infos</span></span></label>
      </div>`;
  }

  let episodesLoaded = false;
  async function renderEpisodes() {
    const panel = $('[data-panel="episodes"]');
    if (episodesLoaded) return;
    episodesLoaded = true;
    panel.innerHTML = '<p class="vp-empty">Wird geladen …</p>';
    try {
      const { show } = await api.show(info.title.id);
      const season = show.seasons.find((x) => x.season === info.season) || show.seasons[0];
      panel.innerHTML = `<div class="vp-episodes-head"><span class="rack-label">${esc(show.title)}</span><strong>${esc(season.name)}</strong></div>
        <div class="vp-episodes-list">${season.episodes
          .map(
            (e) => `<a class="vp-episode${e.id === info.id ? ' active' : ''}" href="/watch/${e.id}" data-episode-link>
              <span class="vp-episode-art">${e.still ? `<img src="${esc(e.still)}" alt="" loading="lazy" />` : ''}${
                e.progress.started ? `<span class="v-progress"><span data-progress="${Math.round(e.progress.fraction * 100)}"></span></span>` : ''
              }</span>
              <span class="vp-episode-text"><small class="rack-label">${esc(episodeCode(e.season, e.episode, e.episodeEnd))}${e.progress.completed ? ' · gesehen' : ''}</small>
              <span>${esc(e.name || '')}</span></span>
            </a>`
          )
          .join('')}</div>`;
      panel.querySelectorAll('[data-progress]').forEach((bar) => {
        bar.style.width = `${bar.dataset.progress}%`;
      });
      const active = panel.querySelector('.vp-episode.active');
      if (active) active.scrollIntoView({ block: 'center' });
    } catch (err) {
      panel.innerHTML = `<p class="vp-empty">${esc(errorText(err))}</p>`;
    }
  }

  function openPanel(name) {
    el.querySelectorAll('[data-panel]').forEach((p) => {
      const open = p.dataset.panel === name && p.hidden;
      p.hidden = !open;
      if (open && name === 'tracks') renderTracksMenu();
      if (open && name === 'settings') renderSettingsMenu();
      if (open && name === 'episodes') renderEpisodes();
    });
    el.classList.toggle('panel-open', !!el.querySelector('[data-panel]:not([hidden])'));
    poke();
  }

  function closePanels() {
    el.querySelectorAll('[data-panel]').forEach((p) => {
      p.hidden = true;
    });
    el.classList.remove('panel-open');
  }

  // --- Stats overlay ------------------------------------------------------------------------

  function soundConverted() {
    return !!s.plan && s.mode !== 'direct' && new URL(s.plan.url, window.location.href).searchParams.get('ac') === 'aac';
  }

  function renderStats() {
    const box = $('.vp-stats');
    box.hidden = !statsOpen;
    if (!statsOpen) return;
    const at = now();
    const src = s.server && s.server.source;
    const stream = s.server && s.server.stream;
    const rows = [['Modus', MODE_NAMES[s.mode] || '-']];
    if (src) {
      const depth = /p(10|12)/.exec(src.pixFmt || '');
      const codec = `${CODEC_NAMES[src.codec] || String(src.codec).toUpperCase()}${depth ? ` ${depth[1]} bit` : ''}${src.hdr ? ' HDR' : ''}`;
      rows.push(['Bild', `${codec} · ${src.width}×${src.height}${s.mode === 'encode' ? ' → H.264' : ''}`]);
    }
    const track = info.audio.find((a) => a.index === s.audio);
    if (track) rows.push(['Ton', `${audioLabel(track).sub}${soundConverted() ? ' → AAC Stereo' : ''}`]);
    rows.push(['Puffer', ahead(bufferedEnd() - at)]);
    if (s.mode !== 'direct' && stream) {
      rows.push(['Server voraus', ahead(s.offset + stream.ready - at)]);
      const rate = stream.rate === null ? 'wird gemessen' : `${stream.rate.toFixed(1).replace('.', ',')}x`;
      rows.push(['Servertempo', stream.done ? 'fertig' : stream.waiting ? `${rate} · Platte voll` : rate]);
    }
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    if (q) {
      const n = (x) => x.toLocaleString('de-DE');
      rows.push(['Ausgelassen', `${n(q.droppedVideoFrames)} von ${n(q.totalVideoFrames)} Bildern`]);
    }
    box.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  }

  async function pollStats() {
    if (s.statsBusy) return;
    s.statsBusy = true;
    try {
      s.server = await api.videoPlayback(info.id);
    } catch {
      // keeps the last numbers
    } finally {
      s.statsBusy = false;
    }
    if (!s.destroyed) renderStats();
  }

  function setStats(open) {
    statsOpen = open;
    clearInterval(s.statsTimer);
    s.statsTimer = open ? setInterval(pollStats, 1000) : null;
    if (open) pollStats();
    renderStats();
    if (!$('[data-panel="settings"]').hidden) renderSettingsMenu();
  }

  // --- The end, and what follows it --------------------------------------------------------

  function checkNext(at) {
    if (!nextCard || !duration || duration < 120) return;
    const left = duration - at;
    const show = !s.nextDismissed && left <= NEXT_LEAD && left > 0.3 && s.pending === null;
    if (nextCard.hidden === show) nextCard.hidden = !show;
    if (show) {
      const frac = autoplayOn() ? clamp(1 - left / NEXT_LEAD, 0, 1) : 0;
      nextCard.querySelector('.vp-next-fill').style.width = `${frac * 100}%`;
    }
  }

  function goNext() {
    if (!info.next) return;
    s.forceComplete = true;
    s.keepFullscreen = true;
    ctx.navigate(`/watch/${info.next.id}`, { replace: true });
  }

  function onEnded() {
    s.forceComplete = true;
    save();
    if (info.next && autoplayOn() && !s.nextDismissed) {
      goNext();
      return;
    }
    if (info.next) {
      s.nextDismissed = false;
      nextCard.hidden = false;
      nextCard.querySelector('.vp-next-fill').style.width = '0%';
    } else {
      endCard.hidden = false;
    }
    el.classList.add('show-ui');
  }

  function leave() {
    const state = window.history.state || {};
    if (Number.isInteger(state.idx) && state.idx > 0) window.history.back();
    else ctx.navigate(info.kind === 'show' ? `/shows/${info.title.id}` : `/movies/${info.title.id}`);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function renderFullscreen() {
    const on = !!document.fullscreenElement;
    $('[data-vp="fullscreen"]').innerHTML = icon(on ? 'minimize' : 'maximize', 22);
    $('[data-vp="fullscreen"]').setAttribute('aria-label', on ? 'Vollbild beenden' : 'Vollbild');
  }

  // --- Controls hiding --------------------------------------------------------------------

  let hideTimer = null;
  function poke() {
    el.classList.add('show-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused && !s.dragging && !el.classList.contains('panel-open')) el.classList.remove('show-ui');
    }, HIDE_AFTER_MS);
  }

  // --- Events -----------------------------------------------------------------------------

  const onClick = (e) => {
    const option = e.target.closest('[data-audio], [data-sub], [data-speed]');
    if (option) {
      if (option.dataset.audio !== undefined) {
        const index = Number(option.dataset.audio);
        const track = info.audio.find((a) => a.index === index);
        if (track) ctx.setPref('videoAudioLang', track.lang || '');
        load(now(), { audio: index, paused: video.paused });
      } else if (option.dataset.sub !== undefined) {
        setSubtitle(option.dataset.sub || null);
      } else {
        video.playbackRate = Number(option.dataset.speed);
        renderSettingsMenu();
      }
      renderTracksMenu();
      return;
    }
    const episode = e.target.closest('[data-episode-link]');
    if (episode) {
      e.preventDefault();
      save();
      s.keepFullscreen = true;
      ctx.navigate(episode.getAttribute('href'), { replace: true });
      return;
    }
    const button = e.target.closest('[data-vp]');
    if (!button) {
      if (!e.target.closest('.vp-panel')) closePanels();
      return;
    }
    switch (button.dataset.vp) {
      case 'stage':
        if (el.classList.contains('panel-open')) closePanels();
        else toggle();
        break;
      case 'play':
      case 'toggle':
        toggle();
        break;
      case 'back':
        leave();
        break;
      case 'back10':
        seek(now() - SKIP);
        break;
      case 'fwd10':
        seek(now() + SKIP);
        break;
      case 'mute':
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 0.5;
        break;
      case 'next':
        goNext();
        break;
      case 'credits':
        s.nextDismissed = true;
        nextCard.hidden = true;
        break;
      case 'again':
        seek(0);
        if (s.mode === 'direct') play();
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'tracks':
      case 'settings':
      case 'episodes':
        openPanel(button.dataset.vp);
        break;
      default:
    }
  };

  const onChange = (e) => {
    if (e.target.matches('[data-autoplay]')) ctx.setPref('videoAutoplay', e.target.checked);
    if (e.target.matches('[data-stats]')) setStats(e.target.checked);
  };

  const onDblClick = (e) => {
    if (e.target.closest('[data-vp="stage"]')) toggleFullscreen();
  };

  volumeRange.addEventListener('input', () => {
    video.volume = Number(volumeRange.value);
    video.muted = video.volume === 0;
  });
  let volumeSave = null;
  video.addEventListener('volumechange', () => {
    renderVolume();
    clearTimeout(volumeSave);
    volumeSave = setTimeout(() => {
      ctx.setPref('videoVolume', Math.round(video.volume * 100) / 100);
      ctx.setPref('videoMuted', video.muted);
    }, 800);
  });

  // Dragging along the rail shows where it would land and seeks on release.
  const railFrac = (e) => {
    const r = rail.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  rail.addEventListener('pointerdown', (e) => {
    s.dragging = true;
    rail.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    const f = railFrac(e);
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
  });
  rail.addEventListener('pointermove', (e) => {
    const f = railFrac(e);
    tip.hidden = false;
    tip.textContent = fmt.duration(f * duration);
    tip.style.left = `${f * 100}%`;
    if (s.dragging) {
      fill.style.width = `${f * 100}%`;
      knob.style.left = `${f * 100}%`;
      nowEl.textContent = fmt.duration(f * duration);
    }
  });
  rail.addEventListener('pointerleave', () => {
    if (!s.dragging) tip.hidden = true;
  });
  const endDrag = (e) => {
    if (!s.dragging) return;
    s.dragging = false;
    el.classList.remove('is-dragging');
    tip.hidden = true;
    seek(railFrac(e) * duration);
  };
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', () => {
    s.dragging = false;
    el.classList.remove('is-dragging');
  });

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.modal-backdrop')) return;
    const onRange = e.target === volumeRange;
    let handled = true;
    switch (e.key) {
      case ' ':
      case 'k':
        toggle();
        break;
      case 'ArrowLeft':
      case 'j':
        if (onRange) return;
        seek(now() - SKIP);
        break;
      case 'ArrowRight':
      case 'l':
        if (onRange) return;
        seek(now() + SKIP);
        break;
      case 'ArrowUp':
        video.muted = false;
        video.volume = clamp(video.volume + 0.05, 0, 1);
        break;
      case 'ArrowDown':
        video.volume = clamp(video.volume - 0.05, 0, 1);
        break;
      case 'm':
        video.muted = !video.muted;
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'c':
        cycleSubtitle();
        break;
      case 'n':
        goNext();
        break;
      case 'i':
        setStats(!statsOpen);
        break;
      case 'Escape':
        if (el.classList.contains('panel-open')) closePanels();
        else if (!document.fullscreenElement) leave();
        break;
      default:
        if (/^[0-9]$/.test(e.key)) seek((Number(e.key) / 10) * duration);
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      poke();
    }
  };

  const onVideoError = () => {
    if (s.destroyed || !video.error) return;
    // Firefox does not reconnect a stream a proxy dropped while it was not reading; it
    // plays out its buffer and fails. That is picked up where it was, not converted.
    if (video.error.code === 2 && s.mode !== 'direct' && Date.now() - s.recoveredAt > 10_000) {
      s.recoveredAt = Date.now();
      load(now(), { paused: video.paused });
      return;
    }
    s.failed += 1;
    // What the browser refused as it is gets one more try the expensive way.
    const force = s.mode === 'direct' ? 'remux' : s.mode === 'remux' ? 'encode' : null;
    if (force && s.failed < 3) {
      load(now(), { force });
    } else {
      el.classList.remove('is-loading');
      explainFailure(video.error.code).then((text) => {
        if (!s.destroyed) toast(text, 'err');
      });
    }
  };

  // The element names no cause, so the server is asked whether it still has the
  // video at all before the browser gets the blame.
  async function explainFailure(code) {
    try {
      await api.video(info.id);
    } catch (err) {
      return errorText(err);
    }
    if (code === 2) return 'Die Verbindung ist beim Laden des Videos abgebrochen.';
    if (s.mode === 'encode') return 'Auch die umgewandelte Fassung ließ sich nicht abspielen.';
    return 'Dieses Video lässt sich hier nicht abspielen.';
  }

  video.addEventListener('play', () => {
    renderPlayState();
    bigPlay.hidden = true;
    poke();
  });
  video.addEventListener('pause', () => {
    renderPlayState();
    s.tick = null;
    save();
    reportWatched();
    el.classList.add('show-ui');
  });
  video.addEventListener('waiting', () => el.classList.add('is-loading'));
  video.addEventListener('playing', () => el.classList.remove('is-loading'));
  video.addEventListener('canplay', () => el.classList.remove('is-loading'));
  video.addEventListener('seeked', () => el.classList.remove('is-loading'));
  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onVideoError);

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('dblclick', onDblClick);
  el.addEventListener('pointermove', poke);
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', renderFullscreen);
  const onHide = () => {
    save(true);
    reportWatched(true);
  };
  window.addEventListener('pagehide', onHide);

  // --- Media keys -----------------------------------------------------------------------

  const session = 'mediaSession' in navigator ? navigator.mediaSession : null;
  if (session) {
    try {
      const art = info.title.poster || info.still;
      session.metadata = new window.MediaMetadata({
        title: info.kind === 'show' ? info.name || episodeCode(info.season, info.episode) : info.title.title,
        artist: info.kind === 'show' ? `${info.title.title} · ${episodeCode(info.season, info.episode, info.episodeEnd)}` : String(info.title.year || ''),
        album: '',
        artwork: art ? [{ src: art, sizes: '500x750', type: 'image/jpeg' }] : [],
      });
      const handlers = {
        play: () => play(),
        pause: () => video.pause(),
        seekbackward: () => seek(now() - SKIP),
        seekforward: () => seek(now() + SKIP),
        seekto: (d) => d && typeof d.seekTime === 'number' && seek(d.seekTime),
        nexttrack: info.next ? () => goNext() : null,
        previoustrack: null,
      };
      for (const [action, handler] of Object.entries(handlers)) {
        try {
          session.setActionHandler(action, handler);
        } catch {
          // not supported here
        }
      }
    } catch {
      // MediaMetadata missing
    }
  }

  // --- Start -------------------------------------------------------------------------------

  paintIcons(el);
  renderVolume();
  renderFullscreen();
  renderPlayState();
  const startAt = start >= duration - 5 ? 0 : start;
  load(startAt);
  if (statsOpen) setStats(true);
  const firstSub = defaultSubtitle();
  if (firstSub) setSubtitle(firstSub, { remember: false });
  poke();
  s.frame = requestAnimationFrame(loop);

  return () => {
    s.destroyed = true;
    cancelAnimationFrame(s.frame);
    clearTimeout(hideTimer);
    clearTimeout(s.pendingTimer);
    clearInterval(s.statsTimer);
    save(true);
    reportWatched(true);
    video.pause();
    video.removeAttribute('src');
    video.load();
    el.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', renderFullscreen);
    window.removeEventListener('pagehide', onHide);
    document.body.classList.remove('watching');
    if (document.fullscreenElement && !s.keepFullscreen) document.exitFullscreen().catch(() => {});
    reclaimMediaSession();
  };
}
