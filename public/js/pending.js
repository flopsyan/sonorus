// Ratings the server has not confirmed yet, so a dropped connection cannot silently lose one.
// One entry per track, last value wins (as Android's `PendingWrites`); in localStorage because
// a closed tab or a shut laptop must not lose it before the next visit sends it.

const KEY = 'sonorus-pending-ratings';

// `shown` is what the widget draws while waiting. It differs from `stars` only when a rating
// is taken away: the old stars stay on screen, pale, until the server agrees.
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

// With `stars`, only that draft: a newer click may have replaced it while this one was in flight.
export function clear(trackId, stars) {
  if (stars !== undefined && drafts[trackId]?.stars !== stars) return;
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
