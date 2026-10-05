// A streaming export rarely spells a track like the file: normalize() gives the import
// a strict key, loosen() a forgiving one without version suffixes. Both are stored per
// track at scan time, so matching an import is an indexed lookup, not a table walk.

// Drops accents, lowercases, and reduces punctuation to single spaces. Keeps
// letters and digits from every alphabet (\p{L}/\p{N}), so non-latin titles
// survive instead of collapsing to an empty string.
export function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Suffixes that describe a version rather than a different song. Everything
// from the marker on is dropped, so "Creep - Acoustic Version" and "Creep"
// end up as the same loose key.
const VERSION_WORDS =
  /\b(remaster(ed)?|remastered version|single version|album version|radio edit|radio version|mono|stereo|live|acoustic|demo|instrumental|edit|mix|remix|version|bonus track|deluxe|extended|explicit|clean|feat|featuring|from|aus|taken from)\b/;

// Loose key: normalize(), plus bracketed additions and a trailing " - ..." tail
// when that tail looks like a version marker rather than part of the title.
// Both cut their input: the regexes are quadratic, and a CSV cell can be megabytes long.
const MAX_FIELD = 500;

export function loosen(value) {
  let s = String(value ?? '').slice(0, MAX_FIELD)
    // "(Remastered 2011)", "[Live at Wembley]"
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ');

  // " - Single Version", " - From Sons of Anarchy", " - 2005 Remaster"
  const dash = s.indexOf(' - ');
  if (dash > 0) {
    const tail = normalize(s.slice(dash + 3));
    if (tail && VERSION_WORDS.test(tail)) s = s.slice(0, dash);
  }
  return normalize(s);
}

// Exports join artists with commas, local files also with "feat.", "&" or "/".
// The first name identifies the track, so both sides match on that.
export function primaryArtist(value) {
  const first = String(value ?? '').slice(0, MAX_FIELD)
    .split(/\s*(?:,|;|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|&)\s*/i)[0];
  return normalize(stripLeadingArticle(first || ''));
}

// "The Doors" and "Doors" should match; the leading article is decoration.
function stripLeadingArticle(value) {
  return String(value).replace(/^\s*(the|der|die|das|le|la|les|el|los)\s+/i, '');
}

// The one folder of compilations, whose artist is per song. Compared in lower case,
// because artists.name is UNIQUE COLLATE NOCASE.
export const VARIOUS = 'various';

export function isVarious(name) {
  return String(name ?? '').trim().toLowerCase() === VARIOUS;
}
