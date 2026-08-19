// The playback engine: queue, transport, shuffle/repeat, volume, the Web Audio
// analyser behind the level meter, and the Media Session integration.
//
// The queue keeps two lists. `queue` is what you added, in the order you added
// it. `order` is a list of positions into `queue` - the order playback actually
// follows. Sequential playback is the identity mapping; shuffle rewrites
// `order` once instead of picking a random track each time, which is what makes
// the queue panel able to show the real upcoming order.

import { api } from './api.js';
import { spreadByArtist } from './shuffle.js';

/** What interpret a position in the queue belongs to, for the spread. */
const artistAt = (i) => state.queue[i]?.artist;

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
  if (state.volume > 0) lastAudible = state.volume;

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
        // Tracks can disappear between sessions, and the answer only carries
        // the ones that are still there. The stored order is positions in the
        // old list, so a single missing track shifts every position behind it
        // onto a different song - it is only usable when everything came back.
        const complete = tracks.length === stored.ids.length;
        const validOrder = complete
          ? (stored.order || []).filter((i) => i >= 0 && i < tracks.length)
          : [];
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

// A track counts as played after this much real playback. Below it, it was a
// skip and does not belong in the statistics at all. A track shorter than that
// can never reach it, so for those a third of the length is the mark.
const COUNT_AFTER = 30;

function countThreshold(duration) {
  return duration < COUNT_AFTER ? duration / 3 : COUNT_AFTER;
}

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

// --- Podcast progress -------------------------------------------------------
// A song is played and forgotten; an episode is 70 minutes long and has to pick
// up where it was left. None of this runs for a song - `progressTrack` is only
// ever set for an episode, and every function below leaves immediately without
// one.
//
// The position is reported on a timer while it plays and once more whenever
// playback leaves the episode: pausing, skipping, closing the tab.

const PROGRESS_EVERY = 15; // seconds of playback between two reports
// Close enough to the end to call it heard. Without it a track stopped during
// the outro stays half-finished forever and keeps offering itself.
//
// Proportional, not a flat 30 s, and that difference is load-bearing: an
// audiobook is cut into parts of whatever length the ripper chose, and against
// a 40-second part a flat half minute would call everything past second ten
// "finished". Five percent is half a minute of a ten-minute part and two
// seconds of a forty-second one.
const NEARLY_DONE = 30;
const nearlyDone = (duration) => Math.min(NEARLY_DONE, (duration || 0) * 0.05);

// Spoken word is anything that remembers where it stopped: a podcast episode
// and a part of an audiobook alike. A song remembers nothing.
const isSpoken = (track) => !!(track && (track.podcastId || track.audiobookId));

let progressTrack = null;
let progressSeconds = 0;
let progressSent = 0;
// Set once this track has been reported as heard, so the tail of it does not
// send the same thing every second. Cleared the moment the playhead moves back
// out of the tail - seeking back into a part is how you un-finish it.
let progressComplete = false;

// Keeps every copy of the episode in the queue in step, so the player bar and
// the list behind it never disagree about how far it got.
export function applyEpisodeProgress(trackId, position, completed) {
  for (const track of state.queue) {
    if (track.id !== trackId) continue;
    track.position = position;
    track.completed = completed;
    track.resumeAt = completed ? 0 : position;
  }
  emit();
}

function armProgress(track, at) {
  progressTrack = isSpoken(track) ? track : null;
  progressSeconds = at;
  progressSent = Math.floor(at);
  progressComplete = false;
}

function sendProgress(track, position, completed, keepalive) {
  applyEpisodeProgress(track.id, position, completed);
  api.saveProgress(track.id, { position, completed }, keepalive).catch(() => {});
}

// Marks the episode finished. Called when it runs out, before the queue moves
// on - `progressTrack` is cleared so the load of the next one cannot write a
// position back over it.
function completeEpisode() {
  const track = progressTrack;
  if (!track) return;
  progressTrack = null;
  sendProgress(track, 0, true, false);
}

function flushProgress(keepalive = false) {
  const track = progressTrack;
  if (!track) return;
  const at = Math.floor(progressSeconds);
  const total = track.duration || 0;
  // Stopped in the tail: that counts as heard, and saying so here means the
  // rule holds however playback left the track.
  if (total > 0 && total - at <= nearlyDone(total)) {
    // Already said so - the rest of the tail has nothing to add.
    if (progressComplete) return;
    progressComplete = true;
    progressSent = at;
    sendProgress(track, 0, true, keepalive);
    return;
  }

  // Back out of the tail: this is being listened to again, not finished.
  progressComplete = false;
  if (at <= 0 || at === progressSent) return;
  progressSent = at;
  sendProgress(track, at, false, keepalive);
}

function load(track, autoplay, startAt = 0) {
  if (!track) return;
  // Where the episode being left off stood, before anything points at the new
  // one.
  flushProgress();
  resetListening();
  // An episode picks up where it was left. An explicit startAt wins: it comes
  // from the queue restore and describes this very session.
  const at = startAt || (isSpoken(track) ? track.resumeAt || 0 : 0);
  armProgress(track, at);
  audio.src = `/api/stream/${track.id}`;
  if (at > 0) {
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = Math.min(at, audio.duration || at);
    }, { once: true });
  }
  state.duration = track.duration || 0;
  state.currentTime = at;
  updateMediaSession(track);
  // The length is already known from the database, so the bar can show the new
  // track right away instead of staying on the previous one until it opens.
  updatePositionState(true);
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

// A collection put on from its "Mischen" button.
//
// Nothing was clicked here, so no song has earned the front of the queue -
// `buildOrder` keeps the index it is given in front while shuffling, and a fixed
// zero would open every random run of a genre or an artist with the same song,
// the first row of the list. The opener is drawn like every other position.
//
// Drawn from what can actually be played rather than from `tracks`: a missing
// file never enters the queue, and drawing one would fall back to the front of
// the list - exactly the song this is here to avoid.
export function shuffleTracks(tracks, source = '') {
  const pool = (tracks || []).filter((t) => t && !t.missing);
  if (!pool.length) return;
  if (!state.shuffle) setShuffle(true);
  playTracks(pool, Math.floor(Math.random() * pool.length), source);
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
  const rest = spreadByArtist(
    indices.filter((i) => i !== startIndex),
    artistAt,
    // The clicked track stays in front, so its own interpret following straight
    // after it is the one repeat the spread cannot see by itself.
    { avoid: artistAt(startIndex) }
  );
  state.order = [startIndex, ...rest];
  state.pos = 0;
}

export function toggle() {
  if (!currentTrack()) return;
  if (audio.paused) start();
  else audio.pause();
}

export function next(manual = false) {
  if (!state.order.length) return;

  if (state.repeat === 'one' && !manual) {
    // Playing it again is a second listen. Without closing the running play
    // here, a track on loop would report ever more seconds into the one row it
    // opened and count as a single play forever.
    resetListening();
    // Never reaches load(), so the position has to be re-armed by hand.
    armProgress(currentTrack(), 0);
    audio.currentTime = 0;
    start();
    return;
  }
  pushHistory();
  if (state.pos + 1 < state.order.length) {
    state.pos += 1;
  } else if (state.repeat === 'all' || manual) {
    // Wrapping while shuffled deals a fresh order, so a repeated queue does not
    // play the same random sequence forever. Dealt from the order, not from the
    // queue: `queue` still holds everything ever added, so rebuilding from it
    // would bring tracks back that were taken out of the queue.
    if (state.shuffle) {
      const last = state.order[state.pos];
      // A new round must not open with the interpret that just finished, which
      // covers the track itself as well.
      const dealt = spreadByArtist(state.order, artistAt, { avoid: artistAt(last) });
      if (dealt.length > 1 && dealt[0] === last) {
        const swap = 1 + Math.floor(Math.random() * (dealt.length - 1));
        [dealt[0], dealt[swap]] = [dealt[swap], dealt[0]];
      }
      state.order = dealt;
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

// Back either starts the track over or goes back to the one that played before,
// and what "before" means depends on the mode. Shuffled it comes from
// `history`: the queue re-deals its order when it wraps, so the track that
// played is anywhere but one position back. Without shuffle the play order *is*
// the order on screen, so "before" is one step down it - reading the history
// there is what made switching shuffle off feel broken, because the list played
// in its normal order again while "back" still walked the random path from
// before and, once its entries ran out, landed on the track that run started on.
export function previous() {
  if (!state.order.length) return;

  if (audio.currentTime > RESTART_AFTER) {
    resetListening();
    audio.currentTime = 0;
    return;
  }

  const target = state.shuffle ? popHistory() : state.pos - 1;
  if (target === null || target < 0) {
    // Nothing played before this one: start it over.
    resetListening();
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
  seekToTime(Math.max(0, Math.min(1, fraction)) * (audio.duration || state.duration));
}

// The same jump in seconds. The rail drags a fraction of the width around and
// never knows the running time; a lyric line only ever knows the second it is
// sung at, and turning that back into a fraction here would be arithmetic for
// nothing.
export function seekToTime(seconds) {
  const total = audio.duration || state.duration;
  if (!total || !Number.isFinite(total) || !Number.isFinite(seconds)) return;
  audio.currentTime = Math.max(0, Math.min(total, seconds));
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
    state.source = source;
    // Through buildOrder, so a queue filled while shuffle is on is dealt
    // shuffled - the toggle is lit and the queue panel says "gemischt".
    buildOrder(0);
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
  flushProgress();
  armProgress(null, 0);
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
  clearMediaSession();
  save();
  emit();
}

// --- Modes ------------------------------------------------------------------

export function setShuffle(on) {
  state.shuffle = !!on;
  if (state.order.length) {
    const current = state.order[state.pos];
    if (state.shuffle) {
      const rest = spreadByArtist(
        state.order.filter((i) => i !== current),
        artistAt,
        { avoid: artistAt(current) }
      );
      state.order = [current, ...rest];
      state.pos = 0;
    } else {
      // Back to the order the tracks were added in - sorted from what is in the
      // play order, because `queue` still holds everything ever added and
      // rebuilding from it would put removed tracks back into the queue.
      state.order = [...state.order].sort((a, b) => a - b);
      state.pos = state.order.indexOf(current);
    }
  }
  // The history is the record of the shuffled walk. Sequential playback does
  // not read it, and a later shuffle must not carry on the path of an earlier
  // one - the tracks in between were played in a completely different order.
  if (!state.shuffle) history = [];
  save();
  savePrefs();
  emit();
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  savePrefs();
  emit();
}

// The level to come back to when the sound is switched on again. Kept out of
// the prefs on purpose: it only ever matters within a session, and restore()
// seeds it from the stored volume.
let lastAudible = 1;

export function setVolume(value) {
  state.volume = Math.max(0, Math.min(1, value));
  audio.volume = state.volume;
  if (state.volume > 0) {
    lastAudible = state.volume;
    if (state.muted) {
      state.muted = false;
      audio.muted = false;
    }
  }
  savePrefs();
  emit();
}

// What the control shows: mute and a slider at zero are the same silence, and
// the UI has to say so with one number - otherwise the slider and the sound
// drift apart (thumb at the far right, nothing audible).
export function shownVolume() {
  return state.muted ? 0 : state.volume;
}

// One button for both ways of being silent: the mute flag and a slider dragged
// to zero. Pressing it while silent brings back the last level that was
// audible, so switching the sound off and on again is symmetric.
export function toggleMute() {
  if (state.muted || state.volume === 0) {
    state.muted = false;
    if (state.volume === 0) state.volume = lastAudible;
  } else {
    lastAudible = state.volume;
    state.muted = true;
  }
  audio.muted = state.muted;
  audio.volume = state.volume;
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
// This is the whole notification the phone shows while something is playing.
// It has three halves and it needs all of them: the metadata fills the card,
// a registered action handler is what makes a button exist at all, and
// setPositionState is what draws the progress bar. Without the last one the
// notification has a title and a play button and nothing else.

const session = 'mediaSession' in navigator ? navigator.mediaSession : null;
const canPosition = !!session && typeof session.setPositionState === 'function';

function updateMediaSession(track) {
  if (!session || !track) return;
  const artwork = track.cover
    ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
    : [];
  try {
    session.metadata = new window.MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      artwork,
    });
  } catch {
    // MediaMetadata unavailable - the lock screen just shows less
  }
}

function setPlaybackState(value) {
  if (session) session.playbackState = value;
}

// The playhead the notification draws. The browser interpolates between two
// calls from playbackRate, so this does not need to run per timeupdate - once a
// second corrects the drift, and every jump of the playhead forces one.
let positionAt = 0;
const POSITION_EVERY = 1000; // ms between two unforced updates

function updatePositionState(force = false) {
  if (!canPosition) return;
  // audio.duration is the truth once the file is open; before that the length
  // from the database keeps the bar from starting out empty.
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
  if (!duration || !Number.isFinite(duration)) return;
  const now = performance.now();
  if (!force && now - positionAt < POSITION_EVERY) return;
  positionAt = now;
  try {
    session.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      // Clamped on purpose: a position past the duration is a TypeError, and
      // right after a track change the element still reports the old playhead.
      position: Math.min(Math.max(audio.currentTime || 0, 0), duration),
    });
  } catch {
    // an implementation that rejects these values must not take the
    // timeupdate handler down with it
  }
}

function clearMediaSession() {
  if (!session) return;
  session.metadata = null;
  setPlaybackState('none');
  if (canPosition) {
    try {
      session.setPositionState();
    } catch {
      // nothing to clear
    }
  }
}

function wireMediaSession() {
  if (!session) return;
  const handlers = {
    play: () => start(),
    pause: () => audio.pause(),
    previoustrack: () => previous(),
    nexttrack: () => next(true),
    seekto: (details) => {
      if (!details || typeof details.seekTime !== 'number') return;
      if (details.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(details.seekTime);
      else audio.currentTime = details.seekTime;
      updatePositionState(true);
    },
  };
  // Deliberately no seekbackward/seekforward: a notification only has room for
  // a few buttons and the browser picks them from what is registered, so those
  // two would compete with skipping a track - which is what this is for.
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // action not supported by this browser
    }
  }
}

// --- Audio element events ---------------------------------------------------

audio.addEventListener('play', () => {
  state.playing = true;
  setPlaybackState('playing');
  updatePositionState(true);
  emit();
});

audio.addEventListener('pause', () => {
  state.playing = false;
  setPlaybackState('paused');
  // Pausing is the most common way to leave an episode, so it is the moment
  // its position has to be safe.
  flushProgress();
  // The notification stops interpolating from the last reported position, so
  // without this the bar would sit wherever the final update left it.
  updatePositionState(true);
  emit();
});

audio.addEventListener('seeked', () => updatePositionState(true));

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
  updatePositionState();

  // Where the episode stands, reported every PROGRESS_EVERY seconds. Unlike the
  // listening time this follows the playhead itself, seeking included - the
  // question is "where do I carry on", not "how much did I hear".
  if (progressTrack) {
    progressSeconds = audio.currentTime;
    const moved = Math.abs(Math.floor(progressSeconds) - progressSent);
    // Ordinary playback reports every PROGRESS_EVERY seconds. A jump backwards
    // out of the tail is reported at once, which is what lets seeking back into
    // a part undo the "heard" it had just earned.
    if (moved >= PROGRESS_EVERY
      || (progressComplete && Math.floor(progressSeconds) < progressSent)) flushProgress();
  }

  // Count a play once the track has run long enough to mean something.
  if (!playCounted && state.duration) {
    if (listened >= countThreshold(state.duration)) {
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

// The last seconds of a track would otherwise never be reported, and neither
// would the place an episode was left at.
window.addEventListener('pagehide', () => {
  reportListening(true);
  flushProgress(true);
});

audio.addEventListener('durationchange', () => {
  if (Number.isFinite(audio.duration)) state.duration = audio.duration;
  updatePositionState(true);
  emit();
});

audio.addEventListener('ended', () => {
  // Running to the end is what "gehört" means. Recorded before the queue moves
  // on, because next() loads the following track and that flushes a position.
  completeEpisode();
  next(false);
});

audio.addEventListener('error', () => {
  // A file the browser cannot decode should not stall the queue.
  if (audio.getAttribute('src')) next(true);
});

wireMediaSession();
