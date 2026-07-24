// CSV parsing for the playlist import.
//
// Small RFC 4180 reader: quoted fields, doubled quotes inside them, and line
// breaks within a quoted field. The delimiter is detected per file, because
// exports made on a German system use semicolons.

const DELIMITERS = [',', ';', '\t'];

// Picks the delimiter that splits the header line into the most fields. Only
// the part before the first line break is looked at, and quoted sections are
// skipped so a comma inside "Last Name, First" cannot win the vote.
function detectDelimiter(text) {
  let header = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    header += ch;
  }

  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (const ch of header) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

// Parses the whole file into rows of raw string cells.
export function parseCsv(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return [];

  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // Skip the trailing empty line most exports end with.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length) endRow();

  return rows;
}

// Header names accepted for each column, lowercased. The first group is the
// plain form Sonorus documents; the rest cover the common streaming exports,
// which write "Track Name" / "Artist Name(s)" / "Album Name".
const COLUMN_ALIASES = {
  playlist: ['playlist', 'playlist name', 'playlistname', 'liste'],
  title: ['title', 'track name', 'track', 'song', 'song name', 'name', 'titel'],
  artists: ['artists', 'artist', 'artist name(s)', 'artist name', 'artist names', 'interpret', 'künstler', 'kuenstler'],
  album: ['album', 'album name', 'album title'],
};

function headerIndex(header) {
  const cells = header.map((h) => String(h || '').trim().toLowerCase());
  const found = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    found[key] = cells.findIndex((c) => aliases.includes(c));
  }
  return found;
}

// Reads a playlist CSV into plain rows. Returns an error when the file has no
// usable header, so the UI can say what is missing instead of importing
// nothing.
export function readPlaylistCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'empty' };

  const index = headerIndex(rows[0]);
  if (index.title === -1) return { error: 'no_title_column', header: rows[0] };

  const cell = (row, pos) => (pos === -1 ? '' : String(row[pos] ?? '').trim());
  const entries = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const title = cell(row, index.title);
    if (!title) continue;
    entries.push({
      playlist: cell(row, index.playlist),
      title,
      artists: cell(row, index.artists),
      album: cell(row, index.album),
    });
  }

  return {
    entries,
    hasPlaylistColumn: index.playlist !== -1,
    columns: Object.fromEntries(
      Object.entries(index).map(([k, v]) => [k, v === -1 ? null : rows[0][v]])
    ),
  };
}
