// The playback engine. `order` holds positions into `queue` (what was added, as added); shuffle
// rewrites `order` once instead of picking at random each time, so the queue panel can show the
// real upcoming order.

import { api, mediaFailure } from './api.js';
import { toast } from './ui.js';
import { spreadByArtist } from './shuffle.js';
import { streamUrl } from './quality.js';

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
  // The route the queue was put on, so only the list actually playing lights up in full. Without
  // its query, as sorting "Alle Songs" is still the same list; two searches then share a key,
  // which marks one song a shade too strongly and breaks nothing.
  sourceKey: '',
};

// What was actually played, as positions in `queue`: shuffled "back" walks this, since a wrap
// re-deals `order`. Positions stay valid because `queue` is only appended to, never spliced.
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
        sourceKey: state.sourceKey,
        time: Math.floor(state.currentTime),
      })
    );
  } catch {
    // storage full or disabled - the queue simply will not survive a reload
  }
}

// The playhead is saved every few seconds so a reopened app resumes where the song was left;
// on every `timeupdate` it would write localStorage four times a second.
const SAVE_TIME_EVERY = 5; // seconds of playback between two writes
let savedTimeAt = 0;

function saveTime() {
  savedTimeAt = audio.currentTime;
  save();
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
        // The stored order is positions in the old list, so one track gone since then shifts
        // every later position onto another song: only usable when every track came back.
        const complete = tracks.length === stored.ids.length;
        const validOrder = complete
          ? (stored.order || []).filter((i) => i >= 0 && i < tracks.length)
          : [];
        // Shorter than the queue is normal: removing a track only takes it out of the order.
        state.order = validOrder.length ? validOrder : tracks.map((_, i) => i);
        state.pos = Math.min(Math.max(stored.pos ?? 0, 0), state.order.length - 1);
        state.source = stored.source || '';
        state.sourceKey = stored.sourceKey || '';
        load(currentTrack(), false, stored.time || 0);
      }
    } catch {
      // library changed underneath us - start empty
    }
  }
  emit();
}

// --- Loading and playback ---------------------------------------------------

// Time really listened to and the play row it updates: statistics count listening, so pausing,
// skipping ahead and leaving early have to show up, which the track length never tells.
let playWritten = false;
let playId = null;
let playSeq = 0; // bumped per track, so a late answer cannot hand over its play row
let listened = 0;
let lastTick = 0;
let reported = 0;

const REPORT_EVERY = 20; // seconds of listening between two reports

// The row is written after the first second, so a skip still counts as time. The server makes
// it a play after COUNT_AFTER seconds (stats.js), a third of a shorter track; this side only
// reports the moment it gets there.
const START_AFTER = 1;
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
  playSeq += 1;
  playWritten = false;
  playId = null;
  listened = 0;
  lastTick = 0;
  reported = 0;
}

// --- Podcast progress -------------------------------------------------------
// Spoken word resumes where it was left; a song is played and forgotten. Everything below leaves
// at once without `progressTrack`, which is only set for an episode or an audiobook part.

const PROGRESS_EVERY = 15; // seconds of playback between two reports
// Close enough to the end to call it heard, or a track stopped in the outro keeps offering itself.
// Capped at 5%: audiobook parts can be 40 s long, and a flat 30 s would call those finished early.
const NEARLY_DONE = 30;
const nearlyDone = (duration) => Math.min(NEARLY_DONE, (duration || 0) * 0.05);

// Spoken word is anything that remembers where it stopped: a podcast episode
// and a part of an audiobook alike. A song remembers nothing.
export const isSpoken = (track) => !!(track && (track.podcastId || track.audiobookId));

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

// The pending start position. Replaced, not stacked: a source that never opened
// must not hand its seek to the next one.
let seekOnOpen = null;
function seekWhenOpen(fn) {
  audio.removeEventListener('loadedmetadata', seekOnOpen);
  seekOnOpen = fn;
  if (fn) audio.addEventListener('loadedmetadata', fn, { once: true });
}

function load(track, autoplay, startAt = 0) {
  if (!track) return;
  // Where the episode being left off stood, before anything points at the new
  // one.
  flushProgress();
  resetListening();
  // An explicit startAt (queue restore, chapter jump, error recovery in start()) wins over
  // the episode's saved resume point: it describes this very session.
  const at = startAt || (isSpoken(track) ? track.resumeAt || 0 : 0);
  armProgress(track, at);
  audio.src = streamUrl(track.id);
  seekWhenOpen(at > 0 ? () => (audio.currentTime = Math.min(at, audio.duration || at)) : null);
  state.duration = track.duration || 0;
  state.currentTime = at;
  savedTimeAt = at;
  updateMediaSession(track);
  // The length is already known from the database, so the bar can show the new
  // track right away instead of staying on the previous one until it opens.
  updatePositionState(true);
  if (autoplay) start();
  else emit();
}

async function start() {
  // An element that failed does not load again by itself; setting the source
  // again clears the error.
  if (audio.error && currentTrack()) return load(currentTrack(), true, state.currentTime);
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
export function playTracks(tracks, startIndex = 0, source = '', sourceKey = '') {
  const all = (tracks || []).filter(Boolean);
  const wanted = all[startIndex];
  const list = all.filter((t) => !t.missing);
  if (!list.length) return;
  state.queue = list;
  state.source = source;
  state.sourceKey = sourceKey;
  history = [];
  buildOrder(wanted ? Math.max(0, list.indexOf(wanted)) : 0);
  load(currentTrack(), true);
  save();
  emit();
}

// From a "Mischen" button nothing was clicked, so the opener is drawn at random, not row 0 every
// time - and only from playable tracks, as a missing one would fall back to the front.
export function shuffleTracks(tracks, source = '', sourceKey = '') {
  const pool = (tracks || []).filter((t) => t && !t.missing);
  if (!pool.length) return;
  if (!state.shuffle) setShuffle(true);
  playTracks(pool, Math.floor(Math.random() * pool.length), source, sourceKey);
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

  // Only when somebody pressed it. A file that simply ended has to move on to
  // the next part of the book, not to the next chapter of the one that just
  // finished - there is none.
  if (manual && skipChapter(1)) {
    resetListening();
    return;
  }

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
    // A fresh deal per wrap, so a repeated queue does not replay one random sequence. Dealt from
    // `order`, not `queue`, which still holds tracks that were taken out.
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

// --- Chapters ---------------------------------------------------------------
// The marks "back" and "forward" move between inside a book. Held per track, as the playhead is
// a second inside one file; app.js fills them in when the running track belongs to another book
// (see loadChapters).

let chapterBook = null;
let chapterTotal = 0;
let chaptersByTrack = new Map();

/**
 * `list` is the book's chapters from `GET /api/audiobooks/books/:id`, each with its part and
 * offset; `parts` turns a part index into a track id here, so nothing downstream knows the indexing.
 */
export function setChapters(bookId, list, parts) {
  chapterBook = bookId;
  chapterTotal = (list || []).length;
  chaptersByTrack = new Map();
  for (const chapter of list || []) {
    const part = (parts || [])[chapter.part];
    if (!part) continue;
    const forTrack = chaptersByTrack.get(part.id) || [];
    forTrack.push({ index: chapter.index, title: chapter.title, start: chapter.offset });
    chaptersByTrack.set(part.id, forTrack);
  }
}

export function clearChapters() {
  chapterBook = null;
  chapterTotal = 0;
  chaptersByTrack = new Map();
}

/** Which book the chapters in hand belong to. */
export function chapterBookId() {
  return chapterBook;
}

/** The chapters inside the running file, in order. Empty for anything else. */
export function chaptersHere() {
  const track = currentTrack();
  if (!track || track.audiobookId !== chapterBook) return [];
  return chaptersByTrack.get(track.id) || [];
}

/** How many chapters the whole book has. */
export function chapterCount() {
  return chapterTotal;
}

/** The one the playhead is inside, or null. */
export function currentChapter() {
  const list = chaptersHere();
  if (!list.length) return null;
  const at = audio.currentTime || state.currentTime || 0;
  let found = list[0];
  for (const chapter of list) {
    if (chapter.start <= at + 0.01) found = chapter;
    else break;
  }
  return found;
}

/**
 * One chapter back or forward. Back restarts the running chapter, like a track; only a second press
 * within [RESTART_AFTER] leaves it. False at either end, so the queue moves on to the next part.
 */
export function skipChapter(delta) {
  const list = chaptersHere();
  if (!list.length) return false;
  const here = currentChapter();
  const at = list.indexOf(here);
  const into = (audio.currentTime || 0) - (here ? here.start : 0);

  if (delta < 0) {
    if (into > RESTART_AFTER || at <= 0) {
      if (at <= 0 && into <= RESTART_AFTER) return false; // let previous() decide
      seekToTime(here.start);
      return true;
    }
    seekToTime(list[at - 1].start);
    return true;
  }

  if (at + 1 >= list.length) return false; // let next() move on to the next part
  seekToTime(list[at + 1].start);
  return true;
}

// Seconds after which "back" starts the running track over instead of leaving
// it. The second press then falls inside this window and goes back for real.
const RESTART_AFTER = 3;

// Shuffled, "before" comes from `history`, as a wrap re-deals the order. Unshuffled it is one step
// down the order on screen: reading history there kept walking the old random path.
// `restartFirst: false` is a wipe over the title, which always means the song before.
export function previous({ restartFirst = true } = {}) {
  if (!state.order.length) return;

  // Inside a book "back" means one chapter, not one file.
  if (skipChapter(-1)) {
    resetListening();
    return;
  }

  if (restartFirst && audio.currentTime > RESTART_AFTER) {
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

// `startAt` is for a chapter that lies in another part of the same book: the
// file has to be opened *and* seeked, and doing the seek afterwards would race
// the load. `load` already takes an offset for the queue restore.
export function jumpTo(orderIndex, startAt = 0) {
  if (orderIndex < 0 || orderIndex >= state.order.length) return;
  pushHistory();
  state.pos = orderIndex;
  load(currentTrack(), true, startAt);
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

// The same jump in seconds, for callers like a lyric line that only know the second.
export function seekToTime(seconds) {
  const total = audio.duration || state.duration;
  if (!total || !Number.isFinite(total) || !Number.isFinite(seconds)) return;
  audio.currentTime = Math.max(0, Math.min(total, seconds));
}

/** One skip in spoken word, in seconds; Android's `PlayerController` holds the same number. */
export const SKIP_SECONDS = 15;

/**
 * A jump of [seconds] from the playhead, clamped to the file: the spoken-word skip buttons,
 * since mid-chapter stepping to another file is not what "back" means.
 */
export function skipBy(seconds) {
  seekToTime((audio.currentTime || 0) + seconds);
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
    // Nothing named a list here - the queue was built by hand out of single
    // tracks, so there is no page it belongs to and every row marks itself as
    // playing from somewhere else. Which is what happened.
    state.sourceKey = '';
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
  state.sourceKey = '';
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

/**
 * Reopens the running track at the quality set now, keeping position and play state, so
 * changing the setting costs the buffer and nothing else.
 */
export function reopenAtCurrentQuality() {
  const track = currentTrack();
  if (!track) return;
  const at = audio.currentTime || 0;
  const wasPlaying = !audio.paused;
  audio.src = streamUrl(track.id);
  seekWhenOpen(() => {
    audio.currentTime = Math.min(at, audio.duration || at);
    if (wasPlaying) audio.play().catch(() => {});
  });
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
// The phone's notification needs all three: metadata fills the card, a registered action
// handler makes a button exist at all, and setPositionState draws the progress bar.

const session = 'mediaSession' in navigator ? navigator.mediaSession : null;
const canPosition = !!session && typeof session.setPositionState === 'function';

function updateMediaSession(track) {
  if (!session || !track) return;
  wireMediaSession(isSpoken(track));
  const artwork = track.cover
    ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
    : [];
  // A book shows chapter, book and author in place of title, interpret and album, so the
  // lock screen moves on while one file plays.
  const chapter = track.audiobookId ? currentChapter() : null;
  const meta = chapter
    ? { title: chapter.title || `Kapitel ${chapter.index + 1}`, artist: track.book || track.title, album: track.author || '' }
    : track.audiobookId
      ? { title: track.title, artist: track.author || track.artist, album: '' }
      : { title: track.title, artist: track.artist, album: track.album || '' };
  shownChapter = chapter ? chapter.index : -1;
  try {
    session.metadata = new window.MediaMetadata({ ...meta, artwork });
  } catch {
    // MediaMetadata unavailable - the lock screen just shows less
  }
}

// Which chapter the notification currently names, so it is rebuilt when the
// playhead crosses into the next one and not on every timeupdate.
let shownChapter = -1;

function followChapter() {
  const track = currentTrack();
  if (!session || !track || !track.audiobookId) return;
  const chapter = currentChapter();
  const index = chapter ? chapter.index : -1;
  if (index === shownChapter) return;
  updateMediaSession(track);
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

// Which of the two sets is registered, so the swap only runs when the kind of
// track changes rather than on every load.
let wiredSpoken = null;

/**
 * The browser picks the notification's few buttons from what is registered, so only one pair can
 * be on: track skips for a song, the 15 s jumps for spoken word, where "next" would mean the next
 * file. A null handler takes a button away again.
 */
function wireMediaSession(spoken) {
  if (!session || wiredSpoken === spoken) return;
  wiredSpoken = spoken;
  const handlers = {
    play: () => start(),
    pause: () => audio.pause(),
    previoustrack: spoken ? null : () => previous(),
    nexttrack: spoken ? null : () => next(true),
    seekbackward: spoken ? (d) => skipBy(-((d && d.seekOffset) || SKIP_SECONDS)) : null,
    seekforward: spoken ? (d) => skipBy((d && d.seekOffset) || SKIP_SECONDS) : null,
    seekto: (details) => {
      if (!details || typeof details.seekTime !== 'number') return;
      if (details.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(details.seekTime);
      else audio.currentTime = details.seekTime;
      updatePositionState(true);
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // action not supported by this browser
    }
  }
}

/** Takes the media keys and the notification back after the video player had them. */
export function reclaimMediaSession() {
  if (!session) return;
  wiredSpoken = null;
  const track = currentTrack();
  if (track) {
    updateMediaSession(track);
    setPlaybackState(audio.paused ? 'paused' : 'playing');
  } else {
    clearMediaSession();
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
  // its position has to be safe. The same goes for the playhead of a song,
  // which is what the next start of the app comes back to.
  flushProgress();
  saveTime();
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
  followChapter();

  // Seeking counts as much as playing on, hence the absolute difference: a jump
  // backwards has to be written down too, or the app reopens further along than
  // it was left.
  if (Math.abs(audio.currentTime - savedTimeAt) >= SAVE_TIME_EVERY) saveTime();

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

  if (!playWritten) {
    if (listened >= START_AFTER) {
      playWritten = true;
      reported = Math.round(listened);
      const track = currentTrack();
      const seq = playSeq;
      if (track) {
        api
          .play(track.id, reported)
          .then((res) => {
            if (seq === playSeq) playId = res.playId;
          })
          .catch(() => {});
      }
    }
  } else if (playId) {
    const mark = countThreshold(state.duration || COUNT_AFTER);
    if (listened - reported >= REPORT_EVERY || (reported < mark && listened >= mark)) reportListening();
  }

  emit();
});

// The last seconds of a track would otherwise never be reported, and neither
// would the place an episode was left at.
window.addEventListener('pagehide', () => {
  reportListening(true);
  flushProgress(true);
  // The last seconds of the playhead, so the way back in is exact rather than
  // up to SAVE_TIME_EVERY seconds old.
  saveTime();
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

// Tracks in a row that would not play. Once it is the whole queue, skipping on
// would only go round in circles.
let failedInRow = 0;
audio.addEventListener('playing', () => {
  failedInRow = 0;
});

audio.addEventListener('error', async () => {
  const src = audio.getAttribute('src');
  const track = currentTrack();
  if (!src || !track) return;
  const code = audio.error ? audio.error.code : 0;
  // Asked without the quality: the plain stream is what says whether the file is there.
  const failure = await mediaFailure(`/api/stream/${track.id}`);
  if (audio.getAttribute('src') !== src) return;

  if (failure && failure.stop) {
    // Server or network gone: the next track would fail the same way. Play
    // picks up here again - see `start`.
    audio.pause();
    state.playing = false;
    emit();
    toast(failure.message, 'err');
    return;
  }
  const why = failure
    ? failure.message
    : code === 3
      ? 'Die Datei ließ sich nicht dekodieren.'
      : 'Dieses Format spielt der Browser nicht ab.';
  toast(`„${track.title}“: ${why}`, 'err');
  failedInRow += 1;
  if (failedInRow < state.order.length) next(true);
  else stop();
});

// Music until a track says otherwise; `updateMediaSession` does the swap.
wireMediaSession(false);
