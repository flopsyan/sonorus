# Sonorus

Self-hosted music player for your own audio files. Sonorus scans a music folder
you mount into the container and turns your folder structure into a browsable
library: artists, albums, singles, genres, all tracks, and your own playlists.

The interface is a single page - navigating between artists, albums and
playlists never interrupts playback. Design-wise it takes a loose cue from the
classic media players (library tree on the left, transport bar across the
bottom) and treats the app as a piece of audio equipment: a deep ink chassis,
one warm amber accent, hi-fi style section labels and monospace readouts for
every number. Dark is the default; a light theme and an "Auto" mode that
follows the operating system are one click away in the header.

Everything lives behind a login; there is no public access. The library itself
is shared by all accounts, while playlists, star ratings and listening history
belong to the account that created them.

## Features

### Library

- **Alle Songs** - every track in the library, sortable and searchable. Clicking
  a column header sorts by it, clicking it again reverses the direction, and the
  sort is remembered on your account until you change it again.
- **Interpreten** - all artists, with their albums, singles and tracks.
- **Alben** - album grid with embedded cover art, track list per album. Sortable
  by title, artist, year or number of songs, each in both directions ("Titel
  Z-A", "Jahr, älteste zuerst"), and the choice is remembered like the one on
  Alle Songs.
- **Cover groß ansehen** - clicking the artwork on an album or artist page opens
  it at full size; click anywhere or press Escape to close it again.
- **Genres** - everything grouped by genre (multi-genre tags supported).
- **Several genres at once.** A genre page has a row of switches above it, one
  per genre: switch on Rock and Jazz as well and you get one combined list of
  both (`/genres/1,4`), every song in it once. Same idea as the star playlists
  further down.
- **The folder structure is the library.** Artist, album, track number and title
  come from the layout, not from the file tags:

  ```
  music/
    Twenty One Pilots/
      Vessel/
        01 - Ode to Sleep.flac     album track, number 1 of "Vessel"
        02 - Holding on to You.flac
      Heathens.flac                single: no album, own "Singles" folder
  ```

  A folder directly under the music folder is an artist, a folder inside it is
  an album, and a leading number in the file name is the track number
  (`01 - Titel`, `01 Titel`, `1-01 Titel` for disc 1). Files lying loose in an
  artist folder are singles: they belong to no album and are not counted as one.
  A `CD1` / `Disc 2` folder inside an album only supplies the disc number.
- What a folder name cannot say is still read from the file (ID3v1/ID3v2, Vorbis
  comments, MP4 atoms, APE): release date, genre, duration, format and the
  embedded cover art. An album with no embedded artwork in any of its files picks
  up a `cover.jpg` / `folder.jpg` / `front.jpg` lying in the album folder.
- **The release date is kept as exactly as the file knows it** - a full day, a
  month or a bare year. The **album page** is the one place that spells it out
  ("17. Mai 2013"); every list, grid and card shows the year, which is all they
  have room for. A file that only carries a year therefore only ever shows one.
- **Alben bearbeiten** - the album page has a "Bearbeiten" button for the three
  things the folder names cannot say: the release date, genres (comma separated,
  applied to every track of the album) and the cover art (JPG, PNG or WebP,
  uploaded in the dialog). The date is typed in as exactly as it is known -
  `17.05.2013`, `05.2013` or `2013`. The edit is stored in Sonorus, **never
  written into your files** - the music folder stays read-only - and each edited
  field is locked, so a later scan does not put the file's version back. Title,
  artist and track number are not editable: they come from the folder structure,
  which the next scan reads again.
- **Singles bearbeiten** - a single belongs to no album, so nothing else can
  carry its release date, its genres or its cover art: the list under "Singles"
  has a Jahr column, and "Single bearbeiten" in the track's context menu sets all
  three. Genres are comma separated like on an album, and an empty field removes
  them. Locked and never written into the file, exactly like an album edit. The
  Singles folder itself has no year - only the songs in it do.
- **Interpret bearbeiten** - the artist page has a "Bearbeiten" button for the
  profile picture. Without one the artist keeps borrowing the cover of one of the
  albums, which is what it did before. The name is not editable: it is the name
  of the folder, and the next scan would read it back again.
- **Bildausschnitt verschieben** - a picture that is not exactly square is
  **dragged inside the frame** of the dialog to pick which square of it becomes
  the cover: left and right on a wide picture, up and down on a tall one. The
  frame shows the result while you drag, and that square is what gets saved -
  covers are shown square in every grid, on the detail page and in the phone's
  notification, so the section is decided once, when the picture is added.
  Works for album, single and artist pictures alike.
- Every uploaded picture (album, single, artist) is **scaled down in the browser**
  to at most 1000 px on its longer side and re-encoded as JPEG before it is sent.
  A cover is never shown larger than that, and it keeps the upload small enough
  for a reverse proxy in front of Sonorus to let it through - nginx, for one,
  allows a 1 MB request body by default.
- Rescan on demand from the settings; unchanged files are skipped, removed files
  disappear from the library - **except when you rated them, put them in a
  playlist or listened to them.** Those keep their row and are shown greyed out
  and struck through, with the last known path in the tooltip, so a rating is
  never lost to a moved file. Put the file back and the next scan clears the
  mark.

### Playback

- Play/pause, previous/next track, elapsed and total time. "Back" starts the
  running track over once it is more than three seconds in; press it again and
  it goes to the track that really played before, shuffle included.
- The seek bar is the top edge of the transport: full width, grab it anywhere.
- Shuffle and repeat (off / repeat all / repeat one).
- Volume slider with mute. The mouse wheel over it works too: up is louder.
- **Aktuelle Wiedergabeliste** - the live queue in a side panel, showing the
  real upcoming order even while shuffle is on; drag to reorder, click to jump.
- A live level meter in the transport and a fullscreen **Visualisierung**, both
  driven by the actual audio through a Web Audio analyser.
- Media Session support, so the lock screen and hardware media keys show the
  current track and work as expected: the card with cover art, previous and
  next, and the progress bar the notification draws from the reported position.
  Whether the notification then shows all of it is the browser's decision - the
  Wiedergabe panel under Einstellungen says what it accepted, and "nicht
  verfügbar" there almost always means the page was opened over plain HTTP,
  where the Media Session API does not exist.
- The queue, volume and the shuffle/repeat modes survive a reload. Volume,
  shuffle and repeat are stored on the account, so they follow you to another
  device; the queue itself stays in the browser you built it in.

### On a phone

The whole app is one layout; below 900 px it rearranges itself rather than
dropping features.

- **The transport opens as a full screen.** Tap what is playing and the bar
  becomes a screen with big artwork, the stars and a seek bar a thumb can hit.
  It arrives and leaves as a sheet, and a wipe down over the artwork follows the
  finger.
- **The back button closes what lies over the page** - the full screen, the
  drawer, the queue, a dialog, a menu - before it leaves the app.
- **Holding a track opens its menu**, the same one the "..." button opens, as a
  sheet from the bottom edge. A tap on the row plays it.
- **Rating** happens in the full screen player or through "Bewerten …" in that
  menu; the star column has no room in a narrow track list.
- The seek bar can be dragged, the theme is picked under Einstellungen (the
  topbar has no room for it), and nothing keeps a hover state after a tap.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | 5 seconds back / forward |
| `Shift` + `←` / `→` | Previous / next track |
| `1` - `5` | Rate the current track |
| `0` | Clear the rating |
| `S` | Toggle shuffle |
| `R` | Cycle repeat |
| `M` | Mute |
| `Q` | Show / hide the queue |
| `V` | Fullscreen visualizer |
| `/` | Jump to the search field |

### Playlists

- Create, rename and delete playlists; add tracks from any view.
- **Playlist folders** to group playlists in the sidebar.
- Drag and drop to reorder tracks inside a playlist.
- **Drag and drop in the sidebar** to arrange the playlists themselves: up and
  down inside their list, onto a folder to move them in, or back out to the top
  level. The order is stored on your account.
- **Anpinnen** keeps a playlist at the top of its list, marked with a pin.
  Right-click it in the sidebar, or use the button on the playlist page.
- **Sterne-Playlists** - rate any track from 1 to 5 stars from any track list or
  from the transport; Sonorus keeps one automatic playlist per rating that
  always reflects the current ratings. Clicking a track's current rating again
  clears it. **Nicht bewertet** is the counterpart: everything still waiting for
  a rating.
- **Several ratings at once.** Every star playlist has a row of switches above
  it, one per rating: switch on 4 and 5 and you get one combined list of both
  (`/stars/5,4`), best rated first. "Nicht bewertet" can join in too.
- Automatic views for recently added, recently played and most played tracks.

### Statistik

A page of its own, next to the settings. The listening history lives on the
server and belongs to the account, so the phone and the desktop count into the
same numbers.

- Library at a glance: songs, artists, albums, singles, genres, total playtime.
- Time listened in total, since the first play, with the number of days music
  actually ran and the day the most of it ran.
- Averages: per day (quiet days included), per day music actually ran, per play,
  and plays per day. **Measured, never projected** - there is no "per year" after
  two days of listening.
- A column chart of the time listened, by day, week, month or year, with the
  time above each bar and the number of plays below it. A period nothing was
  played in is shown as the zero it is instead of being left out.
- The most played tracks, artists and albums, with play count and time.

A play is counted once a track has run for 30 seconds - a third of its length
for tracks shorter than that, which can never reach the mark. What is counted is
the **time actually listened**: the player keeps reporting how far it really
got, so skipping away after a minute counts as a minute, not as a whole track.

### CSV import

Playlists exported from a streaming service can be imported as CSV. Expected
columns (header row required, order does not matter):

| Column | Meaning | Also accepted |
| --- | --- | --- |
| `playlist` | Playlist name; one CSV may contain several playlists | `playlist name` |
| `title` | Track title | `track name`, `track`, `song`, `name`, `titel` |
| `artists` | Artist, or several artists separated by commas | `artist`, `artist name(s)`, `interpret` |
| `album` | Album title | `album name` |

Only `title` is required. Comma, semicolon and tab separated files are all
recognised, as are quoted fields and a UTF-8 BOM. Without a `playlist` column
the whole file becomes one playlist, named after the file.

Sonorus matches every row against the library in four passes, strict first:

1. exact title plus artist,
2. title plus artist with case, accents, punctuation and version suffixes
   (`- Remastered 2011`, `(Live)`, `- Single Version`) ignored,
3. that same loose title plus the album,
4. the loose title on its own, but only when it is unique in the library.

Matched rows go into the playlist.

Rows that cannot be matched are **not** silently dropped: they are recorded as
import issues and stay visible under **Einstellungen -> Mitteilungen** with
playlist, title, artist and album, so you know exactly which songs are missing
from your library. Entries stay until you dismiss them, and disappear
automatically once a matching file shows up in a later scan.

## Quick start (Docker)

```bash
git clone https://github.com/flopsyan/sonorus.git
cd sonorus
cp .env.example .env      # set MUSIC_DIR to your music folder
docker compose up -d --build
```

Open http://localhost:3000. On the first visit you are guided through a one-time
setup page to create the first administrator account. After that, log in and
manage further accounts under **Einstellungen** (admins only).

Alternatively, bootstrap the first admin non-interactively by setting
`AUTH_PASSWORD` (and optionally `AUTH_USER`) in `.env` before the first start.

The first scan starts automatically once the library is empty; you can trigger
further scans any time under **Einstellungen**.

## Configuration

All settings are read from the environment (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUSIC_DIR` | `./music` | Host path of your music folder, mounted read-only into the container |
| `PORT` | `3000` | Host port the app is reachable on |
| `SITE_NAME` | `Sonorus` | Name shown in the header and browser tab |
| `AUTH_USER` | `admin` | Username for the bootstrapped first admin |
| `AUTH_PASSWORD` | *(empty)* | Set to bootstrap the first admin without the setup page |
| `AUTH_SECRET` | *(random)* | Secret for signing session cookies; a stable random one is generated and stored if unset |
| `TRUST_PROXY` | `1` | Reverse proxies in front of the app; set to `false` when exposed directly |
| `SCAN_ON_START` | `auto` | `auto` scans only when the library is empty, `always` scans on every start, `never` disables it |

## Supported formats

Sonorus streams the original file - there is no transcoding, so playback depends
on what your browser can decode. Tags are read for MP3, M4A/AAC/ALAC, FLAC, OGG,
Opus, WAV, AIFF, WMA, APE, WavPack and Musepack; of those, current Firefox and
Chromium play MP3, M4A/AAC, FLAC, OGG, Opus and WAV.

## Data & backup

Your music folder is mounted **read-only** - Sonorus never writes to it. Only
the database (library index, accounts, playlists, ratings, import issues) and
the extracted cover art live in the `sonorus-data` Docker volume under
`/app/data`. Back up that volume to keep your playlists and ratings; the library
itself can always be rebuilt with a rescan.

## Running without Docker

```bash
npm install
MUSIC_DIR=/path/to/music npm start
```

Requires Node 20 or newer. The database and covers are written to `./data`
(override with `DATA_DIR`).

## License

Apache License 2.0 - see [LICENSE](LICENSE).
