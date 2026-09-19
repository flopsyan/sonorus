// Ratings the server has not confirmed yet.
//
// The web app had no queue at all: `rate()` sent the request and, when it
// failed, showed a toast and forgot the rating. On a connection that drops for
// a second that is one rating lost per hiccup, and the loss is silent - the
// song simply turns up unrated again days later, in the middle of a random run.
//
// One entry per track and the last value wins, the same two rules the Android
// queue follows (`PendingWrites`): the server only ever sees the last number
// anyway, and a queue that grew by one entry per tap on a star row would send a
// dozen requests to set one.
//
// It lives in `localStorage` rather than in memory because the case it exists
// for outlives the page: the tab is closed, the laptop is shut, and the rating
// still has to go up on the next visit.

const KEY = 'sonorus-pending-ratings';

// `stars` is the value being written. `shown` is what the widget draws while it
// waits, and the two differ for exactly one case: taking a rating away keeps the
// old stars on screen, pale, until the server agrees - otherwise the row would
// go empty at once and the pale state would have nothing left to show.
let drafts = read();

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    // A private window, or storage the browser refuses. The queue is then a
    // session's worth rather than nothing at all.
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // Nothing to do about it here, and losing the *persistence* of a rating is
    // still better than losing the rating.
  }
}

/** The draft for one track, or null. Read on every render, so it stays cheap. */
export function draft(trackId) {
  return drafts[trackId] || null;
}

/** What a rating currently is as far as the user is concerned. */
export function currentStars(trackId, fromServer) {
  const d = drafts[trackId];
  return d ? d.stars : fromServer;
}

export function put(trackId, stars, shown) {
  drafts[trackId] = { stars, shown };
  save();
}

export function clear(trackId) {
  delete drafts[trackId];
  save();
}

/** The waiting drafts as pairs, for the replay. */
export function entries() {
  return Object.entries(drafts).map(([id, d]) => [Number(id), d.stars]);
}

export function count() {
  return Object.keys(drafts).length;
}
