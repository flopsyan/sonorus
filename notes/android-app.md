# Turning Sonorus into an Android app

Written 2026-07-30 after reading the code. Nothing built, no decision made.
The question was for a real APK on the phone, not a web app inside a browser.

## The finding the effort hangs on

Does the app's page still come from the server, or from inside the APK?

**Page origin stays `https://sonorus.example.com` -> no server change at all.**
Sonorus is already a single-page app behind a clean JSON API, and
`GET /api/stream/:id` uses `res.sendFile(..., { acceptRanges: true })`, so Range
requests and therefore seeking work for any client.

**Frontend bundled into the APK -> origin becomes something like
`https://localhost`, and three things break at once:**

- `rejectCrossSite` (`src/lib/security.js`) answers 403 `cross_site` to every
  POST/PUT/PATCH/DELETE whose `Origin` host differs from `Host` - ratings,
  playlists, plays, scan, every write.
- The session cookie is `SameSite=Lax`, so it would not be sent on those
  requests anyway. A bundled client needs token auth (the signed token in
  `src/lib/auth.js` already is one, it just travels in a cookie) plus CORS.
- `public/js/api.js` uses relative paths and answers a 401 with
  `window.location.href = '/login'`. Both assume the server served the page.

The CSP in `security.js` is not in the way either way - it only applies to pages
the server itself serves.

## The five options

| | Effort (rough) | What it gives |
| --- | --- | --- |
| **A) TWA** (Bubblewrap / PWABuilder) | an afternoon, no code change | Real APK, launcher icon, no browser UI. Chrome underneath, so the existing Media Session keeps working as it does today. Needs a signing key and `assetlinks.json` under `/.well-known/` on the domain. No offline, no background playback. |
| **B) Capacitor, WebView pointed at the live URL** | half a day, no server change | Like A, but a plain WebView instead of Chrome - which is where the risk sits (below). Only worth it over A because it opens the door to native plugins. |
| **C) Capacitor with the frontend bundled** | + 1-2 days of server work | Downloads into the app's private storage, no browser quota, no eviction. Costs CORS + token auth first (see above). |
| **D) Native Kotlin + `androidx.media3`** (ExoPlayer, `MediaSessionService`) | MVP 1-2 weeks, feature parity much more | The only route that definitely delivers background playback, a real system notification, offline downloads and Android Auto, because the app owns the player instead of a WebView. Also a second client to maintain forever, next to ~10.700 lines of frontend. |
| **E) Speak Subsonic/OpenSubsonic on the server**, use a finished client (Tempo, Symfonium) | 2-4 days for a playable subset | Mature offline and Android Auto, and the data still lands in Sonorus's own database, so ratings stay in one place. |

Catch with E: **`scrobble` reports an event, not seconds.** Sonorus counts time
actually listened (`plays.seconds`, reported by the player while it runs) and
the Statistik page is deliberately "measured, never projected". A foreign client
can only say "this track played", so its plays would have to be booked as a full
track length or a flat value - which contradicts the rule the statistics were
built on.

## Two risks that need a device, not a code reading

Both unverified. They are the reason A beats B despite B looking nicer on paper.

1. **Does a raw WebView post a media notification at all?**
   `navigator.mediaSession` exists in a Chromium WebView, but the notification is
   drawn by the embedding app, and Android System WebView does not bring one
   along. Chrome does. If that holds, a Capacitor wrapper loses the lock-screen
   card, and the fix is a plugin mirroring the state into a real Android
   `MediaSession` plus a foreground service - i.e. writing the native half anyway.
2. **Background playback.** The `<audio>` element is routed through
   `createMediaElementSource` for the level meter (`public/js/player.js`), and an
   `AudioContext` may be suspended when the app goes to the background. Without a
   foreground service, Android is free to stop the audio.

## Recommendation given

**A now.** An afternoon, a real APK, Chrome's Media Session kept, not one line of
Sonorus changed.

Decide between D and E only once the open Pixel 7 notification question is
settled on the device: if the deployed instance simply predated `38651c1` (the
commit that added `setPositionState`), Chrome already does everything, and the
expensive routes only buy offline playback and Android Auto.
