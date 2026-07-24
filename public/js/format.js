// Formatting helpers. All output is German; durations and counts are meant to
// be read in monospace, so they never change width unnecessarily.

// m:ss, or h:mm:ss once a track passes an hour.
export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Long form for headers: "3 Std. 14 Min.".
export function durationLong(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h && m) return `${h} Std. ${m} Min.`;
  if (h) return `${h} Std.`;
  return `${m} Min.`;
}

// Compact playtime for the front-panel readout, where the value has to stay on
// one line however big the library gets: "1:45 Std.", "312:04 Std.".
export function durationRack(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (!h) return `${m} Min.`;
  return `${h}:${String(m).padStart(2, '0')} Std.`;
}

export function number(value) {
  return new Intl.NumberFormat('de-DE').format(Number(value) || 0);
}

export function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[i]}`;
}

// "Songs" / "Song", "Alben" / "Album" - the counts in headers read badly
// without this.
export function plural(count, one, many) {
  return `${number(count)} ${count === 1 ? one : many}`;
}

export function dateTime(value) {
  if (!value) return '';
  // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC.
  const iso = /^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}
