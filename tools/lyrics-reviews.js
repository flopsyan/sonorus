// Carries out the verdicts given in the app on lyrics from a .lrc: a .lrc that does not fit
// is deleted, one that fits is listed, to be written into its song by hand. Runs outside the
// server, whose music mount stays read-only.
//
//   node tools/lyrics-reviews.js --db <copy of sonorus.sqlite> --music <music folder>
//     [--apply] [--list <file.tsv>]
//
// Without --apply nothing is deleted, only reported. --list writes the songs that fit.
// A .lrc changed since its verdict is left alone: the verdict was given for other words.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// The music folder as the server sees it; the paths in the database start with it.
const SERVER_MUSIC_DIR = '/music';

function options(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      opts[argv[i].slice(2)] = true;
    } else {
      opts[argv[i].slice(2)] = value;
      i++;
    }
  }
  if (!opts.db || !opts.music) throw new Error('Usage: lyrics-reviews.js --db <file> --music <folder> [--apply] [--list <file>]');
  return opts;
}

function main() {
  const opts = options(process.argv.slice(2));
  const musicDir = path.resolve(opts.music);

  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const reviews = db
    .prepare(
      `SELECT r.fits, r.lrc, r.created_at AS at, COALESCE(u.username, '') AS who, t.path,
              COALESCE(NULLIF(t.track_artist, ''), ar.name, '') AS artist,
              COALESCE(al.title, '') AS album, t.title
         FROM lyrics_reviews r
         JOIN tracks t ON t.id = r.track_id
         LEFT JOIN artists ar ON ar.id = t.artist_id
         LEFT JOIN albums al ON al.id = t.album_id
         LEFT JOIN users u ON u.id = r.user_id
        ORDER BY t.path`
    )
    .all()
    .filter((review) => review.path.startsWith(SERVER_MUSIC_DIR + '/'));
  db.close();

  const counts = { deleted: 0, 'to-delete': 0, fits: 0, changed: 0, gone: 0 };
  const fitting = [];

  for (const review of reviews) {
    const rel = path.relative(SERVER_MUSIC_DIR, review.path);
    const lrcRel = rel.slice(0, -path.extname(rel).length) + '.lrc';
    const lrc = path.join(musicDir, lrcRel);
    const stat = fs.statSync(lrc, { throwIfNoEntry: false });

    let kind;
    // Deleted already, or written into the song by hand: nothing left to do.
    if (!stat) kind = 'gone';
    // The scanner's signature, so a verdict counts for exactly the file it was given for.
    else if (`${stat.size}:${Math.floor(stat.mtimeMs)}` !== review.lrc) kind = 'changed';
    else if (review.fits) {
      kind = 'fits';
      fitting.push([review.artist, review.album, review.title, lrcRel, review.at, review.who].join('\t'));
    } else if (opts.apply) {
      fs.unlinkSync(lrc);
      kind = 'deleted';
    } else {
      kind = 'to-delete';
    }

    counts[kind] += 1;
    if (kind !== 'gone') console.log(`${kind}\t${lrcRel}`);
  }

  if (opts.list) {
    fs.writeFileSync(opts.list, ['artist\talbum\ttitle\tlrc\tjudged\tby', ...fitting].join('\n') + '\n');
  }
  console.log(JSON.stringify(counts));
  if (counts['to-delete']) console.log('Dry run: nothing deleted. Run again with --apply.');
  if (counts.deleted) console.log('Run a scan under Einstellungen so the server notices.');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
