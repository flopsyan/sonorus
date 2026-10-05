// Stream quality per device, so localStorage and not `users.prefs`: the desktop on the
// LAN wants the original, the laptop on hotel wifi does not, on the same account.

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
 * Empty for the original, not `?q=original`: the stream URL is what the browser caches and
 * makes `Range` requests against, so the plain URL has to stay plain.
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
