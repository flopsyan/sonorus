# Sonorus

Self-hosted music player for your own audio files. Sonorus scans a music folder
you mount into the container, reads the tags out of every file and turns them
into a browsable library: artists, albums, genres, all tracks, and your own
playlists.

The interface is a single page - navigating between artists, albums and
playlists never interrupts playback. Design-wise it takes a loose cue from the
classic media players (library tree on the left, transport bar across the
bottom) but in a modern, dark first look.

Everything lives behind a login; there is no public access. The library itself
is shared by all accounts, while playlists, star ratings and listening history
belong to the account that created them.

## Features

### Library

- **Alle Songs** - every track in the library, sortable and searchable.
- **Interpreten** - all artists, with their albums and tracks.
- **Alben** - album grid with embedded cover art, track list per album.
- **Genres** - everything grouped by genre (multi-genre tags supported).
- Tags are read from the files themselves (ID3v1/ID3v2, Vorbis comments, MP4
  atoms, APE) - title, artist, album artist, album, genre, year, track and disc
  number, duration and embedded cover art.
- Rescan on demand from the settings; unchanged files are skipped, removed files
  disappear from the library.

### Playback

- Play/pause, previous/next track, seek bar with elapsed and total time.
- Shuffle and repeat (off / repeat all / repeat one).
- Volume slider with mute.
- **Aktuelle Wiedergabeliste** - the live queue in a side panel, showing the
  real upcoming order even while shuffle is on; drag to reorder, click to jump.
- Keyboard shortcuts for the transport controls.
- Media Session support, so the lock screen and hardware media keys show the
  current track and work as expected.

### Playlists

- Create, rename and delete playlists; add tracks from any view.
- **Playlist folders** to group playlists in the sidebar.
- Drag and drop to reorder tracks inside a playlist.
- **Sterne-Playlists** - rate any track from 1 to 5 stars; Sonorus keeps one
  automatic playlist per rating that always reflects the current ratings.
- Automatic views for recently added, recently played and most played tracks.

### CSV import

Playlists exported from a streaming service can be imported as CSV. Expected
columns (header row required, order does not matter):

| Column | Meaning |
| --- | --- |
| `playlist` | Playlist name; one CSV may contain several playlists |
| `title` | Track title |
| `artists` | Artist, or several artists separated by commas |
| `album` | Album title |

Sonorus matches every row against the library (title plus artist, falling back
to a normalised match that ignores case, punctuation and suffixes such as
`- Remastered 2011` or `- Single Version`). Matched rows go into the playlist.

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
