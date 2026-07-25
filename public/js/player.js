// The playback engine: queue, transport, shuffle/repeat, volume, the Web Audio
// analyser behind the level meter, and the Media Session integration.
//
// The queue keeps two lists. `queue` is what you added, in the order you added
// it. `order` is a list of positions into `queue` - the order playback actually
// follows. Sequential playback is the identity mapping; shuffle rewrites
// `order` once instead of picking a random track each time, which is what makes
// the queue panel able to show the real upcoming order.

import { api } from './api.js';

const audio = document.getElementById('audio');

export const state = {
  queue: [],
  order: [],
  pos: -1,
  playing: false,
  shuffle: false,
  repeat: 'off', // off | all | one
  volume: 1,
  muted: false,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  source: '',
};

// What was actually played, most recent last, as positions in `queue`. "Back"
// walks this list instead of stepping down `order`: with shuffle on, `order`
// gets re-dealt when the queue wraps around, and the track that came before is
// then anywhere but at pos - 1. Positions in `queue` stay valid because the
// queue is only ever appended to, never spliced.
let history = [];
const HISTORY_MAX = 100;

function pushHistory() {
  const current = state.order[state.pos];
  if (current === undefined) return;
  history.push(current);
  if (history.length > HISTORY_MAX) history.shift();
}

// The last played track that is still in the play order, as an index into
// `order`, or null when there is nothing to go back to.
function popHistory() {
  while (history.length) {
    const at = state.order.indexOf(history.pop());
    if (at >= 0) return at;
  }
  return null;
}

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

export function currentTrack() {
  if (state.pos < 0 || state.pos >= state.order.length) return null;
  return state.queue[state.order[state.pos]] || null;
}

// The tracks still to come, in playback order, for the queue panel.
export function upcoming() {
  return state.order.slice(state.pos + 1).map((i) => state.queue[i]).filter(Boolean);
}

export function orderedQueue() {
  return state.order.map((i) => state.queue[i]).filter(Boolean);
}

// --- Web Audio --------------------------------------------------------------
// The analyser is only wired up once the context is confirmed to be running.
// createMediaElementSource routes all audio through the graph, so connecting it
// to a suspended context would silence playback.

let audioCtx = null;
let analyser = null;
let graphUnavailable = false;

async function ensureGraph() {
  if (audioCtx || graphUnavailable) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    graphUnavailable = true;
    return;
  }
  try {
    const ctx = new Ctx();
    if (ctx.state === 'suspended') await ctx.resume();
    if (ctx.state !== 'running') {
      await ctx.close();
      graphUnavailable = true;
      return;
    }
    const source = ctx.createMediaElementSource(audio);
    const node = ctx.createAnalyser();
    node.fftSize = 128;
    node.smoothingTimeConstant = 0.75;
    source.connect(node);
    node.connect(ctx.destination);
    audioCtx = ctx;
    analyser = node;
  } catch {
    graphUnavailable = true;
  }
}

// Frequency data for the meter and the fullscreen visualizer, or null while no
// analyser exists (before the first play, or where Web Audio is unavailable).
export function levels() {
  if (!analyser) return null;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  return data;
}

// --- Persistence ------------------------------------------------------------

const STORE_KEY = 'sonorus-player';

function save() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        ids: state.queue.map((t) => t.id),
        order: state.order,
        pos: state.pos,
        source: state.source,
        time: Math.floor(state.currentTime),
      })
    );
  } catch {
    // storage full or disabled - the queue simply will not survive a reload
  }
}

let prefTimer = null;
function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    api
      .savePref('player', { volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeat: state.repeat })
      .catch(() => {});
  }, 600);
}

// Restores volume/shuffle/repeat from the account and the queue from this
// browser. Called once at boot.
export async function restore(prefs) {
  const saved = (prefs && prefs.player) || {};
  state.volume = typeof saved.volume === 'number' ? saved.volume : 1;
  state.muted = !!saved.muted;
  state.shuffle = !!saved.shuffle;
  state.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
  audio.volume = state.volume;
  audio.muted = state.muted;

  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    stored = null;
  }
  if (stored && Array.isArray(stored.ids) && stored.ids.length) {
    try {
      const { tracks } = await api.tracksByIds(stored.ids);
      if (tracks.length) {
        state.queue = tracks;
        // Tracks can disappear between sessions, so rebuild the order from the
        // ids that actually came back.
        const validOrder = (stored.order || []).filter((i) => i >= 0 && i < tracks.length);
        state.order = validOrder.length === tracks.length ? validOrder : tracks.map((_, i) => i);
        state.pos = Math.min(Math.max(stored.pos ?? 0, 0), state.order.length - 1);
        state.source = stored.source || '';
        load(currentTrack(), false, stored.time || 0);
      }
    } catch {
      // library changed underneath us - start empty
    }
  }
  emit();
}

// --- Loading and playback ---------------------------------------------------

// How much of the current track was really listened to, and the play row on the
// server that is being kept up to date with it. The statistics count time spent
// listening, so pausing, skipping ahead and leaving early all have to show up -
// which the track length alone would never tell.
let playCounted = false;
let playId = null;
let listened = 0;
let lastTick = 0;
let reported = 0;

const REPORT_EVERY = 20; // seconds of listening between two reports

// Sends the current total for this play. Called on a timer while playing, when
// the track changes and when the page goes away.
function reportListening(keepalive = false) {
  if (!playId || Math.round(listened) <= reported) return;
  reported = Math.round(listened);
  api.playTime(playId, reported, keepalive).catch(() => {});
}

function resetListening() {
  reportListening();
  playCounted = false;
  playId = null;
  listened = 0;
  lastTick = 0;
  reported = 0;
}

function load(track, autoplay, startAt = 0) {
  if (!track) return;
  resetListening();
  audio.src = `/api/stream/${track.id}`;
  if (startAt > 0) {
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = Math.min(startAt, audio.duration || startAt);
    }, { once: true });
  }
  state.duration = track.duration || 0;
  state.currentTime = startAt;
  updateMediaSession(track);
  if (autoplay) start();
  else emit();
}

async function start() {
  await ensureGraph();
  if (audioCtx && audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch {
      // keep playing without the meter
    }
  }
  try {
    await audio.play();
  } catch {
    state.playing = false;
    emit();
  }
}

// Replaces the queue and starts at `startIndex`. Tracks whose file is gone are
// still listed (they keep their rating), but they never enter the queue - so
// the index has to be mapped onto the filtered list.
export function playTracks(tracks, startIndex = 0, source = '') {
  const all = (tracks || []).filter(Boolean);
  const wanted = all[startIndex];
  const list = all.filter((t) => !t.missing);
  if (!list.length) return;
  state.queue = list;
  state.source = source;
  history = [];
  buildOrder(wanted ? Math.max(0, list.indexOf(wanted)) : 0);
  load(currentTrack(), true);
  save();
  emit();
}

// Builds `order` for the current shuffle setting, keeping `startIndex` first
// when shuffling so the track you clicked is the one that plays.
function buildOrder(startIndex) {
  const indices = state.queue.map((_, i) => i);
  if (!state.shuffle) {
    state.order = indices;
    state.pos = Math.min(Math.max(startIndex, 0), indices.length - 1);
    return;
  }
  const rest = indices.filter((i) => i !== startIndex);
  shuffleInPlace(rest);
  state.order = [startIndex, ...rest];
  state.pos = 0;
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function toggle() {
  if (!currentTrack()) return;
  if (audio.paused) start();
  else audio.pause();
}

export function next(manual = false) {
  if (!state.order.length) return;

  if (state.repeat === 'one' && !manual) {
    audio.currentTime = 0;
    start();
    return;
  }
  pushHistory();
  if (state.pos + 1 < state.order.length) {
    state.pos += 1;
  } else if (state.repeat === 'all' || manual) {
    // Wrapping while shuffled deals a fresh order, so a repeated queue does not
    // play the same random sequence forever.
    if (state.shuffle) {
      const indices = state.queue.map((_, i) => i);
      shuffleInPlace(indices);
      state.order = indices;
    }
    state.pos = 0;
  } else {
    return stop();
  }
  load(currentTrack(), true);
  save();
  emit();
}

// Seconds after which "back" starts the running track over instead of leaving
// it. The second press then falls inside this window and goes back for real.
const RESTART_AFTER = 3;

// Back either starts the track over or goes back to the one that played before
// - and "before" comes from `history`, never from `pos - 1`. Stepping down the
// play order is what made this feel broken in shuffle: the queue re-deals its
// order when it wraps, so the track that played before is anywhere but one
// position back, and the restart rule then silently swallowed the press.
export function previous() {
  if (!state.order.length) return;

  if (audio.currentTime > RESTART_AFTER) {
    audio.currentTime = 0;
    return;
  }

  const target = popHistory();
  if (target === null) {
    // Nothing played before this one: start it over.
    audio.currentTime = 0;
    return;
  }
  state.pos = target;
  load(currentTrack(), true);
  save();
  emit();
}

export function jumpTo(orderIndex) {
  if (orderIndex < 0 || orderIndex >= state.order.length) return;
  pushHistory();
  state.pos = orderIndex;
  load(currentTrack(), true);
  save();
  emit();
}

function stop() {
  audio.pause();
  audio.currentTime = 0;
  state.playing = false;
  emit();
}

export function seekTo(fraction) {
  const total = audio.duration || state.duration;
  if (!total || !Number.isFinite(total)) return;
  audio.currentTime = Math.max(0, Math.min(1, fraction)) * total;
}

// --- Queue edits ------------------------------------------------------------

// Appends to the end of the queue. With shuffle on the new tracks are appended
// to the play order too, so "als Nächstes" stays predictable.
export function enqueue(tracks, source = '') {
  const list = (tracks || []).filter((t) => t && !t.missing);
  if (!list.length) return;
  // Filling an empty queue only cues the first track up; adding to the queue
  // should never start playing on its own.
  if (!state.queue.length) {
    state.queue = list;
    state.order = list.map((_, i) => i);
    state.pos = 0;
    state.source = source;
    load(currentTrack(), false);
    save();
    emit();
    return;
  }
  const base = state.queue.length;
  state.queue = state.queue.concat(list);
  state.order = state.order.concat(list.map((_, i) => base + i));
  save();
  emit();
}

// Inserts right after the current track.
export function playNext(tracks) {
  const list = (tracks || []).filter((t) => t && !t.missing);
  if (!list.length) return;
  if (!state.queue.length) {
    playTracks(list, 0);
    return;
  }
  const base = state.queue.length;
  state.queue = state.queue.concat(list);
  state.order.splice(state.pos + 1, 0, ...list.map((_, i) => base + i));
  save();
  emit();
}

export function removeFromQueue(orderIndex) {
  if (orderIndex < 0 || orderIndex >= state.order.length) return;
  state.order.splice(orderIndex, 1);
  if (orderIndex < state.pos) state.pos -= 1;
  else if (orderIndex === state.pos) {
    if (state.pos >= state.order.length) state.pos = state.order.length - 1;
    if (state.pos < 0) return clearQueue();
    load(currentTrack(), state.playing);
  }
  save();
  emit();
}

export function moveInQueue(from, to) {
  if (from === to || from < 0 || from >= state.order.length) return;
  const current = state.order[state.pos];
  const [moved] = state.order.splice(from, 1);
  state.order.splice(to, 0, moved);
  state.pos = state.order.indexOf(current);
  save();
  emit();
}

export function clearQueue() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  history = [];
  state.queue = [];
  state.order = [];
  state.pos = -1;
  state.playing = false;
  state.source = '';
  state.currentTime = 0;
  state.duration = 0;
  save();
  emit();
}

// --- Modes ------------------------------------------------------------------

export function setShuffle(on) {
  state.shuffle = !!on;
  if (state.order.length) {
    const current = state.order[state.pos];
    if (state.shuffle) {
      const rest = state.order.filter((i) => i !== current);
      shuffleInPlace(rest);
      state.order = [current, ...rest];
      state.pos = 0;
    } else {
      state.order = state.queue.map((_, i) => i);
      state.pos = state.order.indexOf(current);
    }
  }
  save();
  savePrefs();
  emit();
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  savePrefs();
  emit();
}

export function setVolume(value) {
  state.volume = Math.max(0, Math.min(1, value));
  audio.volume = state.volume;
  if (state.volume > 0 && state.muted) {
    state.muted = false;
    audio.muted = false;
  }
  savePrefs();
  emit();
}

export function toggleMute() {
  state.muted = !state.muted;
  audio.muted = state.muted;
  savePrefs();
  emit();
}

// Updates a rating that is already in the queue, so the player bar and the
// queue panel stay in sync with the list the user rated from.
export function applyRating(trackId, starValue) {
  let touched = false;
  for (const track of state.queue) {
    if (track.id === trackId) {
      track.stars = starValue;
      touched = true;
    }
  }
  if (touched) emit();
}

// --- Media Session ----------------------------------------------------------

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return;
  const artwork = track.cover
    ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
    : [];
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      artwork,
    });
  } catch {
    // MediaMetadata unavailable - the lock screen just shows less
  }
}

function wireMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => start(),
    pause: () => audio.pause(),
    previoustrack: () => previous(),
    nexttrack: () => next(true),
    seekto: (details) => {
      if (details && typeof details.seekTime === 'number') audio.currentTime = details.seekTime;
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // action not supported by this browser
    }
  }
}

// --- Audio element events ---------------------------------------------------

audio.addEventListener('play', () => {
  state.playing = true;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  emit();
});

audio.addEventListener('pause', () => {
  state.playing = false;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  emit();
});

audio.addEventListener('timeupdate', () => {
  state.currentTime = audio.currentTime;
  if (audio.buffered.length) {
    state.buffered = audio.buffered.end(audio.buffered.length - 1);
  }

  // Time really spent listening: the step between two timeupdates, but only
  // when it looks like playback. A jump (seeking) or a step backwards is not
  // listening time.
  const step = audio.currentTime - lastTick;
  if (step > 0 && step < 2) listened += step;
  lastTick = audio.currentTime;

  // Count a play once the track has run long enough to mean something.
  if (!playCounted && state.duration) {
    const threshold = Math.min(30, state.duration * 0.5);
    if (listened >= threshold) {
      playCounted = true;
      reported = Math.round(listened);
      const track = currentTrack();
      if (track) {
        api
          .play(track.id, reported)
          .then((res) => {
            playId = res.playId;
          })
          .catch(() => {});
      }
    }
  } else if (playId && listened - reported >= REPORT_EVERY) {
    reportListening();
  }

  emit();
});

// The last seconds of a track would otherwise never be reported.
window.addEventListener('pagehide', () => reportListening(true));

audio.addEventListener('durationchange', () => {
  if (Number.isFinite(audio.duration)) state.duration = audio.duration;
  emit();
});

audio.addEventListener('ended', () => next(false));

audio.addEventListener('error', () => {
  // A file the browser cannot decode should not stall the queue.
  if (audio.getAttribute('src')) next(true);
});

wireMediaSession();
