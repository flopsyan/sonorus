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

- **Alle Songs** - every track in the library, sortable and searchable.
- **Interpreten** - all artists, with their albums, singles and tracks.
- **Alben** - album grid with embedded cover art, track list per album.
- **Genres** - everything grouped by genre (multi-genre tags supported).
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
  comments, MP4 atoms, APE): year, genre, duration, format and the embedded
  cover art. An album with no embedded artwork in any of its files picks up a
  `cover.jpg` / `folder.jpg` / `front.jpg` lying in the album folder.
- **Alben bearbeiten** - the album page has a "Bearbeiten" button for the three
  things the folder names cannot say: year, genres (comma separated, applied to
  every track of the album) and the cover art (JPG, PNG or WebP, uploaded in the
  dialog). The edit is stored in Sonorus, **never written into your files** -
  the music folder stays read-only - and each edited field is locked, so a later
  scan does not put the file's version back. Title, artist and track number are
  not editable: they come from the folder structure, which the next scan reads
  again.
- Rescan on demand from the settings; unchanged files are skipped, removed files
  disappear from the library - **except when you rated them, put them in a
  playlist or listened to them.** Those keep their row and are shown greyed out
  and struck through, with the last known path in the tooltip, so a rating is
  never lost to a moved file. Put the file back and the next scan clears the
  mark.

### Playback

- Play/pause, previous/next track, elapsed and total time.
- The seek bar is the top edge of the transport: full width, grab it anywhere.
- Shuffle and repeat (off / repeat all / repeat one).
- Volume slider with mute.
- **Aktuelle Wiedergabeliste** - the live queue in a side panel, showing the
  real upcoming order even while shuffle is on; drag to reorder, click to jump.
- A live level meter in the transport and a fullscreen **Visualisierung**, both
  driven by the actual audio through a Web Audio analyser.
- Media Session support, so the lock screen and hardware media keys show the
  current track and work as expected.
- The queue, volume and the shuffle/repeat modes survive a reload. Volume,
  shuffle and repeat are stored on the account, so they follow you to another
  device; the queue itself stays in the browser you built it in.

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
- **Sterne-Playlists** - rate any track from 1 to 5 stars from any track list or
  from the transport; Sonorus keeps one automatic playlist per rating that
  always reflects the current ratings. Clicking a track's current rating again
  clears it. **Nicht bewertet** is the counterpart: everything still waiting for
  a rating.
- Automatic views for recently added, recently played and most played tracks.

### Statistik

A page of its own, next to the settings. The listening history lives on the
server and belongs to the account, so the phone and the desktop count into the
same numbers.

- Library at a glance: songs, artists, albums, singles, genres, total playtime.
- Time listened in total, since the first play, with the number of days music
  actually ran.
- Averages per day, week, month and year, over the whole time since the first
  play - quiet days included.
- A column chart of the time listened, by day, week, month or year.
- The most played tracks, artists and albums, with play count and time.

A play is counted once a track has run for 30 seconds (or half its length, for
short tracks). What is counted is the **time actually listened**: the player
keeps reporting how far it really got, so skipping away after a minute counts
as a minute, not as a whole track.

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
