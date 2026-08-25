// Which quality this browser streams in.
//
// A fact about **the device**, not about the account, and that is the point of
// keeping it in `localStorage` rather than in `users.prefs`: the desktop on the
// LAN wants the original file and the laptop on a hotel connection does not, and
// they are the same account. The app on the phone keeps its own copy of the same
// decision in its own SharedPreferences for exactly the same reason.
//
// There are two answers and no ladder in between: the file as it lies in the
// music folder, or one small enough for a mobile connection.

const KEY = 'sonorus-quality';

/** The name the server uses for "leave the file as it is". */
export const ORIGINAL = 'original';

export const QUALITIES = [
  { value: ORIGINAL, label: 'Original', hint: 'Die Datei so, wie sie im Musikordner liegt.' },
  { value: 'opus128', label: 'Opus 128 kbps', hint: 'Ungefähr ein Drittel der Größe, spart Daten.' },
];

const NAMES = QUALITIES.map((q) => q.value);

export function current() {
  try {
    const saved = localStorage.getItem(KEY);
    if (NAMES.includes(saved)) return saved;
  } catch {
    // Storage disabled. The original is the default anyway.
  }
  return ORIGINAL;
}

export function set(value) {
  const next = NAMES.includes(value) ? value : ORIGINAL;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Nothing to do - the choice then lasts for this page and no longer.
  }
  return next;
}

/**
 * The query the stream URL carries, empty for the original.
 *
 * Empty and not `?q=original` on purpose: the URL of a stream is what the
 * browser caches and what a `Range` request is made against, so the plain URL
 * has to stay the plain URL.
 */
export function streamQuery() {
  const value = current();
  return value === ORIGINAL ? '' : `?q=${encodeURIComponent(value)}`;
}

export function streamUrl(trackId) {
  return `/api/stream/${trackId}${streamQuery()}`;
}

export function labelOf(value) {
  return QUALITIES.find((q) => q.value === value)?.label || 'Original';
}
