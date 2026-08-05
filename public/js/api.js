// Thin wrapper around the JSON API. Every call returns the parsed body; a
// failed request throws an Error carrying the German message the server sent,
// so callers can show it straight in a toast.

async function request(method, path, body, extra) {
  const options = { method, headers: {}, ...extra };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(path, options);

  // The session expired: reload so the server can send us to the login page.
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Nicht angemeldet.');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON means the answer did not come from the app itself: a reverse
    // proxy refusing the request size, a gateway error, a route that does not
    // exist. The status is the only clue there is, so it goes into the message -
    // a bare "Unerwartete Antwort" names no cause at all.
    throw new Error(
      res.status === 413
        ? 'Die Anfrage war für den Server zu groß.'
        : `Unerwartete Antwort vom Server (HTTP ${res.status}).`
    );
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || 'Da ist etwas schiefgelaufen.');
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

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),

  tracks: (params) => request('GET', `/api/tracks${query(params)}`),
  tracksByIds: (ids) => request('POST', '/api/tracks/by-ids', { ids }),
  artists: (params) => request('GET', `/api/artists${query(params)}`),
  artist: (id) => request('GET', `/api/artists/${id}`),
  updateArtist: (id, patch) => request('PATCH', `/api/artists/${id}`, patch),
  albums: (params) => request('GET', `/api/albums${query(params)}`),
  album: (id) => request('GET', `/api/albums/${id}`),
  updateAlbum: (id, patch) => request('PATCH', `/api/albums/${id}`, patch),
  // Year and cover art of a single - an album track takes both from its album.
  updateTrack: (id, patch) => request('PATCH', `/api/tracks/${id}`, patch),
  genres: () => request('GET', '/api/genres'),
  // One id or a comma list of them - several genres are one combined list.
  genre: (ids) => request('GET', `/api/genres/${ids}`),
  starred: (stars) => request('GET', `/api/stars/${stars}`),
  // The words of one song, asked for separately: they are far too big to ride
  // along in every track of every list.
  lyrics: (id) => request('GET', `/api/tracks/${id}/lyrics`),
  home: () => request('GET', '/api/home'),
  shuffle: (limit) => request('GET', `/api/shuffle${query({ limit })}`),
  search: (q) => request('GET', `/api/search${query({ q })}`),

  rate: (trackId, stars) => request('PUT', `/api/tracks/${trackId}/rating`, { stars }),
  play: (trackId, seconds) => request('POST', '/api/plays', { trackId, seconds }),
  // keepalive lets the last report survive the page being closed.
  playTime: (playId, seconds, keepalive = false) =>
    request('PUT', `/api/plays/${playId}`, { seconds }, keepalive ? { keepalive: true } : undefined),
  clearHistory: () => request('DELETE', '/api/plays'),
  // The statistics answer for one period; `range` and `period` say which one.
  // The offset is what makes a day the listener's day, not the server's.
  stats: (params) =>
    request('GET', `/api/stats${query({ offset: -new Date().getTimezoneOffset(), ...params })}`),

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

  scanStatus: () => request('GET', '/api/scan'),
  startScan: () => request('POST', '/api/scan'),

  savePref: (key, value) => request('PUT', '/api/prefs', { key, value }),

  users: () => request('GET', '/api/users'),
  createUser: (payload) => request('POST', '/api/users', payload),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),
  saveProfile: (payload) => request('PUT', '/api/profile', payload),
};
