// Thin wrapper around the JSON API. Every call returns the parsed body; a
// failed request throws an ApiError carrying a German sentence, so callers can
// show it straight in a toast.

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    // The server's own word for what went wrong, for the callers that have to
    // tell "this can never work" from "not right now". The rating queue is the
    // one that needs it: a track someone deleted must not block everything
    // queued behind it, and nothing else may be dropped.
    this.code = code;
  }
}

/**
 * What a status means when the body does not say it. An answer that is not
 * Sonorus's JSON came from the reverse proxy in front of it, and the status is
 * the only clue there is.
 */
export function statusMessage(status) {
  if (status === 413) return 'Die Anfrage war für den Server zu groß.';
  if (status === 502 || status === 503) {
    return `Sonorus ist nicht erreichbar, der Dienst startet vielleicht gerade neu (HTTP ${status}).`;
  }
  if (status === 504) return 'Der Server hat zu lange nicht geantwortet (HTTP 504).';
  if (status === 429) return 'Zu viele Anfragen, bitte kurz warten (HTTP 429).';
  if (status === 403) return 'Der Zugriff wurde vor Sonorus abgewiesen (HTTP 403).';
  if (status >= 500) return `Der Server hat mit einem Fehler geantwortet (HTTP ${status}).`;
  return `Unerwartete Antwort vom Server (HTTP ${status}).`;
}

/** Why no answer came at all: fetch() only ever says "NetworkError" or "Failed to fetch". */
export function networkMessage() {
  return navigator.onLine === false ? 'Keine Internetverbindung.' : 'Keine Verbindung zum Server.';
}

/**
 * Why an <audio> element gave up on a URL. The element says "not supported"
 * whether the file is gone, the server is down or the format is foreign, so the
 * URL is asked again for one byte. Null when the server delivers - then it was
 * the browser. `stop` is set when every other track would fail the same way.
 */
export async function mediaFailure(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  } catch {
    return { message: networkMessage(), stop: true };
  }
  if (res.status === 401) window.location.href = '/login';
  if (res.ok) return null;
  let message = statusMessage(res.status);
  try {
    message = (await res.json()).message || message;
  } catch {
    // The proxy's HTML page; the status says it.
  }
  return { message, stop: res.status !== 404 };
}

/** The sentence for a toast. Anything that is not an ApiError is a bug in the page. */
export function errorText(err) {
  if (err instanceof ApiError) return err.message;
  console.error(err);
  return `Fehler in der App: ${err && err.message ? err.message : err}`;
}

async function request(method, path, body, extra) {
  const options = { method, headers: {}, ...extra };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(networkMessage(), 'network');
  }

  // The session expired: reload so the server can send us to the login page.
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError('Nicht angemeldet.', 'auth_required');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(statusMessage(res.status), `http_${res.status}`);
  }
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.message || statusMessage(res.status), data.error || `http_${res.status}`);
  }
  return data;
}

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

const keep = (keepalive) => (keepalive ? { keepalive: true } : undefined);

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),

  videoHome: () => request('GET', '/api/video-home'),
  movies: () => request('GET', '/api/movies'),
  movie: (id) => request('GET', `/api/movies/${id}`),
  shows: () => request('GET', '/api/shows'),
  show: (id) => request('GET', `/api/shows/${id}`),
  collections: () => request('GET', '/api/collections'),
  collection: (id) => request('GET', `/api/collections/${id}`),
  person: (id) => request('GET', `/api/people/${id}`),
  video: (id) => request('GET', `/api/videos/${id}`),
  videoPlan: (id, body) => request('POST', `/api/videos/${id}/plan`, body),
  videoSubtitles: (id, key) => request('GET', `/api/videos/${id}/subtitles/${key}`),
  videoProgress: (id, body, keepalive = false) =>
    request('PUT', `/api/videos/${id}/progress`, body, keep(keepalive)),
  videoWatched: (id, watched) => request('PUT', `/api/videos/${id}/watched`, { watched }),
  titleWatched: (id, watched, season = null) =>
    request('PUT', `/api/video-titles/${id}/watched`, { watched, season }),
  refreshTitle: (id, tmdbId) =>
    request('POST', `/api/video-titles/${id}/refresh`, tmdbId ? { tmdbId } : {}),
  videoMeta: () => request('GET', '/api/video-meta'),
  videoPlay: (videoId) => request('POST', '/api/video-plays', { videoId }),
  videoPlayTime: (playId, seconds, keepalive = false) =>
    request('PUT', `/api/video-plays/${playId}`, { seconds }, keep(keepalive)),


  tracks: (params) => request('GET', `/api/tracks${query(params)}`),
  tracksByIds: (ids) => request('POST', '/api/tracks/by-ids', { ids }),
  saveLyricsOffset: (id, offset) => request('PUT', `/api/tracks/${id}/lyrics-offset`, { offset }),
  artists: (params) => request('GET', `/api/artists${query(params)}`),
  artist: (id) => request('GET', `/api/artists/${id}`),
  updateArtist: (id, patch) => request('PATCH', `/api/artists/${id}`, patch),
  albums: (params) => request('GET', `/api/albums${query(params)}`),
  album: (id) => request('GET', `/api/albums/${id}`),
  updateAlbum: (id, patch) => request('PATCH', `/api/albums/${id}`, patch),
  // Year and cover art of a single - an album track takes both from its album.
  updateTrack: (id, patch) => request('PATCH', `/api/tracks/${id}`, patch),
  genres: () => request('GET', '/api/genres'),
  // Spoken word. The shows, one show with its episodes, and where listening
  // stopped - the last one keepalive so the final report survives a closing tab.
  podcasts: () => request('GET', '/api/podcasts'),
  podcast: (id, sort) => request('GET', `/api/podcasts/${id}${query({ sort })}`),
  // Hörbücher. Ein Buch ist eine Einheit - die Teile kommen nur mit, damit der
  // Player weiß, was er einreihen soll.
  // `base` is 'audiobooks' or 'audiodramas'. Two libraries to the listener, the
  // same endpoints on the server - see spokenRoutes in src/routes/api.js.
  spoken: (base) => request('GET', `/api/${base}`),
  spokenAuthor: (base, id) => request('GET', `/api/${base}/authors/${id}`),
  spokenBook: (base, id) => request('GET', `/api/${base}/books/${id}`),
  setBookHeard: (base, id, heard) => request('PUT', `/api/${base}/books/${id}/heard`, { heard }),
  updateAuthor: (base, id, patch) => request('PATCH', `/api/${base}/authors/${id}`, patch),
  updateBook: (base, id, patch) => request('PATCH', `/api/${base}/books/${id}`, patch),
  // E-Books: the shelf, one author, one book, and where the reader got to.
  ebooks: () => request('GET', '/api/ebooks'),
  ebookAuthor: (id) => request('GET', `/api/ebooks/authors/${id}`),
  ebook: (id) => request('GET', `/api/ebooks/books/${id}`),
  ebookProgress: (id, body, keepalive = false) =>
    request('PUT', `/api/ebooks/books/${id}/progress`, body, keepalive ? { keepalive: true } : undefined),
  updateEbook: (id, patch) => request('PATCH', `/api/ebooks/books/${id}`, patch),
  updateEbookAuthor: (id, patch) => request('PATCH', `/api/ebooks/authors/${id}`, patch),
  // Gilt fuer Podcast-Folgen und Hoerbuch-Teile gleichermassen.
  saveProgress: (id, body, keepalive = false) =>
    request('PUT', `/api/progress/${id}`, body, keepalive ? { keepalive: true } : undefined),
  // One id or a comma list of them - several genres are one combined list.
  genre: (ids) => request('GET', `/api/genres/${ids}`),
  starred: (stars) => request('GET', `/api/stars/${stars}`),
  // The words of one song, asked for separately: they are far too big to ride
  // along in every track of every list.
  lyrics: (id) => request('GET', `/api/tracks/${id}/lyrics`),
  home: () => request('GET', '/api/home'),
  // `unrated` narrows the random run to what has no star yet.
  shuffle: (limit, unrated = false) =>
    request('GET', `/api/shuffle${query({ limit, unrated: unrated ? '1' : '' })}`),
  search: (q) => request('GET', `/api/search${query({ q })}`),

  rate: (trackId, stars) => request('PUT', `/api/tracks/${trackId}/rating`, { stars }),
  // The stars on a whole record, which no song of it knows about. No counts come
  // back: an album rating feeds no star playlist.
  play: (trackId, seconds) => request('POST', '/api/plays', { trackId, seconds }),
  // keepalive lets the last report survive the page being closed.
  playTime: (playId, seconds, keepalive = false) =>
    request('PUT', `/api/plays/${playId}`, { seconds }, keepalive ? { keepalive: true } : undefined),
  clearHistory: () => request('DELETE', '/api/plays'),
  // The statistics answer for one period; `range` and `period` say which one.
  // No offset any more: the hour, the day and the year a play belongs to are
  // the server's, so the same history reads the same from every device.
  stats: (params) =>
    request('GET', `/api/stats${query(params)}`),

  playlists: () => request('GET', '/api/playlists'),
  playlist: (id) => request('GET', `/api/playlists/${id}`),
  createPlaylist: (name, folderId) => request('POST', '/api/playlists', { name, folderId }),
  updatePlaylist: (id, patch) => request('PATCH', `/api/playlists/${id}`, patch),
  deletePlaylist: (id) => request('DELETE', `/api/playlists/${id}`),
  addToPlaylist: (id, trackIds) => request('POST', `/api/playlists/${id}/tracks`, { trackIds }),
  removeFromPlaylist: (id, itemId) => request('DELETE', `/api/playlists/${id}/items/${itemId}`),
  reorderPlaylist: (id, itemIds) => request('PUT', `/api/playlists/${id}/order`, { itemIds }),
  // The sidebar order of one container: a folder, or the top level (null).
  reorderPlaylists: (folderId, ids) => request('PUT', '/api/playlists/order', { folderId, ids }),

  createFolder: (name) => request('POST', '/api/folders', { name }),
  renameFolder: (id, name) => request('PATCH', `/api/folders/${id}`, { name }),
  deleteFolder: (id) => request('DELETE', `/api/folders/${id}`),

  importCsv: (payload) => request('POST', '/api/import/csv', payload),
  issues: () => request('GET', '/api/import/issues'),
  recheckIssues: () => request('POST', '/api/import/issues/recheck'),
  dismissIssue: (id) => request('DELETE', `/api/import/issues/${id}`),
  clearIssues: () => request('DELETE', '/api/import/issues'),
  missing: () => request('GET', '/api/library/missing'),
  dropMissing: (id) => request('DELETE', `/api/library/missing/${id}`),

  quality: () => request('GET', '/api/quality'),
  scanStatus: () => request('GET', '/api/scan'),
  startScan: () => request('POST', '/api/scan'),

  savePref: (key, value) => request('PUT', '/api/prefs', { key, value }),

  users: () => request('GET', '/api/users'),
  createUser: (payload) => request('POST', '/api/users', payload),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),
  saveProfile: (payload) => request('PUT', '/api/profile', payload),
};
