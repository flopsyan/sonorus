// What the API says when it refuses. `error` is the stable code a client may
// branch on (the rating queues drop on `not_found`), `message` the German
// sentence it shows.

import crypto from 'node:crypto';

const ERRORS = {
  invalid_username: 'Ungültiger Benutzername (2-32 Zeichen: Buchstaben, Zahlen, . _ -).',
  weak_password: 'Passwort zu kurz (mindestens 4 Zeichen).',
  wrong_password: 'Das aktuelle Passwort stimmt nicht.',
  taken: 'Benutzername ist bereits vergeben.',
  last_user: 'Der letzte Account kann nicht gelöscht werden.',
  last_admin: 'Der letzte Admin kann nicht gelöscht werden.',
  admin_only: 'Das dürfen nur Admins.',
  invalid_name: 'Bitte einen Namen angeben.',
  invalid_stars: 'Bewertung muss zwischen 0 und 5 liegen.',
  invalid_date: 'Bitte ein Datum wie 17.05.2013, 05.2013 oder 2013 angeben.',
  not_a_single:
    'Nur Singles lassen sich einzeln bearbeiten. Songs eines Albums bekommen Datum, Genres und Cover vom Album.',
  nothing_to_edit: 'Es gibt nichts zu ändern.',
  bad_image: 'Das Bild konnte nicht gelesen werden. Erlaubt sind JPG, PNG und WebP.',
  image_too_big: 'Das Bild ist zu groß (maximal 6 MB).',
  not_found: 'Nicht gefunden.',
  no_route: 'Diese Funktion kennt der Server nicht. Ist er auf dem neuesten Stand?',
  empty: 'Die Datei enthält keine Zeilen.',
  no_title_column: 'Der CSV-Datei fehlt eine Spalte mit dem Songtitel.',
  no_tmdb: 'Kein TMDB_API_KEY gesetzt.',
  scanning: 'Ein Scan läuft gerade, bitte danach nochmal.',
  bad_id: 'Bitte eine TMDB-ID angeben.',
};

// A 404 names what is gone - "Nicht gefunden" after a click on an album says
// nothing about whether the album, a song on it or the server went missing.
const MISSING = {
  track: 'Diesen Song gibt es nicht mehr.',
  file: 'Die Datei fehlt auf dem Server.',
  lyrics: 'Zu diesem Song gibt es keinen Liedtext.',
  artist: 'Diesen Interpreten gibt es nicht mehr.',
  album: 'Dieses Album gibt es nicht mehr.',
  genre: 'Dieses Genre gibt es nicht mehr.',
  podcast: 'Diesen Podcast gibt es nicht mehr.',
  spoken: 'Diese Folge oder dieses Hörbuch gibt es nicht mehr.',
  author: 'Diesen Autor gibt es nicht mehr.',
  book: 'Dieses Hörbuch gibt es nicht mehr.',
  drama: 'Dieses Hörspiel gibt es nicht mehr.',
  ebook: 'Dieses E-Book gibt es nicht mehr.',
  ebookFile: 'Die Datei dieses E-Books fehlt auf dem Server.',
  ebookPage: 'Diese Seite fehlt im E-Book.',
  playlist: 'Diese Playlist gibt es nicht mehr.',
  playlistItem: 'Dieser Eintrag ist nicht mehr in der Playlist.',
  folder: 'Diesen Ordner gibt es nicht mehr.',
  notice: 'Diese Mitteilung gibt es nicht mehr.',
  movie: 'Diesen Film gibt es nicht mehr.',
  show: 'Diese Serie gibt es nicht mehr.',
  title: 'Diesen Film oder diese Serie gibt es nicht mehr.',
  collection: 'Diese Filmreihe gibt es nicht mehr.',
  person: 'Diese Person gibt es in der Bibliothek nicht mehr.',
  video: 'Dieses Video gibt es nicht mehr.',
  videoFile: 'Die Videodatei fehlt auf dem Server.',
  download: 'Dieser Download ist abgelaufen. Bitte neu starten.',
  subtitle: 'Diese Untertitelspur gibt es nicht.',
  user: 'Diesen Account gibt es nicht mehr.',
};

const STATUS = { not_found: 404, no_route: 404, admin_only: 403, scanning: 409 };

/** Answers a refusal. `what` names the missing thing for a `not_found`. */
export function fail(res, code, what) {
  const message = (code === 'not_found' && MISSING[what]) || ERRORS[code] || `Fehler: ${code}`;
  return res.status(STATUS[code] || 400).json({ ok: false, error: code, message });
}

/**
 * What a failure of the disk, a mount or the database means, in words the
 * person who has to fix it can act on. Null for anything else.
 */
export function explainSystemError(err) {
  const where = err && err.path ? `: ${err.path}` : '.';
  switch (err && err.code) {
    case 'ENOSPC':
    case 'SQLITE_FULL':
      return 'Auf dem Server ist kein Speicherplatz mehr frei.';
    case 'EACCES':
    case 'EPERM':
      return `Sonorus hat keine Berechtigung${where}`;
    case 'EROFS':
    case 'SQLITE_READONLY':
      return `Der Speicherort ist schreibgeschützt${where}`;
    case 'EIO':
      return `Lesefehler auf dem Datenträger${where}`;
    // What a CIFS, NFS or sshfs mount says when the NAS behind it went away.
    case 'ESTALE':
    case 'ENOTCONN':
    case 'EHOSTDOWN':
      return `Die Netzwerkfreigabe ist nicht erreichbar${where}`;
    case 'SQLITE_BUSY':
    case 'SQLITE_LOCKED':
      return 'Die Datenbank ist gerade belegt. Bitte gleich nochmal versuchen.';
    default:
      return null;
  }
}

/**
 * The answer to an error nobody expected. The stack stays in the log; the
 * person gets the reference that finds it there, and an admin the cause too.
 */
export function unexpected(err, req) {
  const ref = crypto.randomBytes(3).toString('hex');
  console.error(`Sonorus: ${req.method} ${req.originalUrl} failed [${ref}]:`, err);
  const known = explainSystemError(err);
  let text = known ? known.replace(/\.$/, '') : 'Interner Fehler auf dem Server';
  if (!known && req.user && req.user.is_admin && err && err.message) {
    text = `Interner Fehler: ${String(err.message).split('\n')[0].slice(0, 200)}`;
  }
  return { ref, message: `${text} (Fehler-ID ${ref})` };
}
