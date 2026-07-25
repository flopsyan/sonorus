// Release dates, as exactly as they are known.
//
// A file tag says anything from a bare year to a full day, so a release date is
// kept as the text 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' - the length of the string
// is how precise it is. The album page prints the whole thing, everything else
// prints the year, which is why the year stays its own column.
//
// One parser for both sources: the file tags (ISO-ish) and the edit dialog,
// where a German date is what a German UI invites ("17.05.2015").

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function build(year, month, day) {
  if (year < 1000 || year > 2999) return null;
  if (month === null) return String(year);
  if (month < 1 || month > 12) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}`;
  if (day === null) return iso;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const max = month === 2 && !leap ? 28 : DAYS[month - 1];
  if (day < 1 || day > max) return null;
  return `${iso}-${String(day).padStart(2, '0')}`;
}

const num = (value) => (value === undefined ? null : Number.parseInt(value, 10));

// Returns the normalised date, '' for an empty input and null for something
// that is not a date at all - the caller has to tell those two apart.
export function parseReleaseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  // A full ISO timestamp is what an ID3v2.4 date tag may hold; the time part is
  // no business of a release date, so it is dropped rather than refused.
  const iso = text.match(/^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2})(?:[T ][\d:.+Z-]*)?)?)?$/);
  if (iso) return build(num(iso[1]), num(iso[2]), num(iso[3]));

  // The German way round: 17.05.2015, or 05.2015 for a month.
  const de = text.match(/^(?:(\d{1,2})\.)?(\d{1,2})\.(\d{4})$/);
  if (de) return build(num(de[3]), num(de[2]), num(de[1]));

  return null;
}

// The year that goes with a normalised date, for the column everything but the
// album page reads.
export function yearOf(date) {
  return date ? Number.parseInt(date.slice(0, 4), 10) : null;
}
