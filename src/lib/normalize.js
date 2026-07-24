// Text normalisation shared by the library scanner and the CSV import.
//
// A CSV exported from a streaming service almost never spells a track exactly
// the way the local file does: different case, accents, punctuation, and
// suffixes like " - 2011 Remaster" or "(Live)". Two levels of normalisation
// give the import a strict and a forgiving pass:
//
//   normalize()  - case, accents, punctuation and whitespace only
//   loosen()     - additionally drops bracketed and trailing-dash suffixes
//
// Both are computed once per track during the scan and stored on the row, so
// matching an import is an indexed lookup instead of a table walk.

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
export function loosen(value) {
  let s = String(value ?? '')
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

// The first artist of a multi-artist field. Streaming exports write them as one
// comma-separated string ("The Piano Guys, Julie Ann Nelson"); local files use
// commas, "feat.", "&" or "/". The first name is the one that identifies the
// track, so that is what both sides match on.
export function primaryArtist(value) {
  const first = String(value ?? '')
    .split(/\s*(?:,|;|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|&)\s*/i)[0];
  return normalize(stripLeadingArticle(first || ''));
}

// "The Doors" and "Doors" should match; the leading article is decoration.
function stripLeadingArticle(value) {
  return String(value).replace(/^\s*(the|der|die|das|le|la|les|el|los)\s+/i, '');
}
