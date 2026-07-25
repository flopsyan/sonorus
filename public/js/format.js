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

// Long form for headers: "3 Std. 14 Min.". Always rounded down, like the
// compact readout below, so the same total never reads differently in two
// places - and so 1:59:45 cannot come out as "1 Std. 60 Min.". Under a minute
// it counts seconds instead of claiming zero.
export function durationLong(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h && m) return `${h} Std. ${m} Min.`;
  if (h) return `${h} Std.`;
  if (m) return `${m} Min.`;
  return `${total} Sek.`;
}

// Compact playtime for the front-panel readout, where the value has to stay on
// one line however big the library gets: "1:45 Std.", "312:04 Std.". Under a
// minute it counts seconds - an average that rounds down to "0 Min." says less
// than the truth does.
export function durationRack(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (!h && !m) return `${total} Sek.`;
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

// Just the day: "25. Juli 2026".
export function date(value) {
  if (!value) return '';
  const iso = /^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

// A release date is stored as exactly as it is known: '2015', '2015-05' or
// '2015-05-17'. Printed in full only on the album page - "17. Mai 2015", "Mai
// 2015", "2015"; everywhere else the plain year is what a list has room for.
// Built from the parts instead of a Date, which would shift the day by one in
// any timezone west of UTC.
const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export function releaseDate(value) {
  const [year, month, day] = String(value || '').split('-');
  if (!year) return '';
  const name = month ? MONTHS[Number(month) - 1] : '';
  if (!name) return year;
  return day ? `${Number(day)}. ${name} ${year}` : `${name} ${year}`;
}

// The same date the way it is typed into the edit dialog: 17.05.2015, 05.2015,
// 2015. The server reads that form back.
export function releaseDateInput(value) {
  const [year, month, day] = String(value || '').split('-');
  if (!year) return '';
  if (!month) return year;
  return day ? `${day}.${month}.${year}` : `${month}.${year}`;
}

export function dateTime(value) {
  if (!value) return '';
  // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC.
  const iso = /^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}
