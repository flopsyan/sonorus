// Turning a parsed CSV into playlists.
//
// One CSV may describe several playlists (a "playlist" column), or a single
// one (no such column - then the file name is used). Every row is matched
// against the library; what matches goes into the playlist, what does not
// becomes an import notice the user can act on later.

import db from '../db.js';
import { findTrackForImport } from './library.js';
import { createPlaylist, addTracks, getPlaylist } from './playlists.js';
import { addIssues } from './issues.js';

// A CSV import can be large (thousands of rows), so the whole thing runs in one
// transaction: either the playlists and their notices are all there, or none
// of it happened.
export const importEntries = db.transaction((userId, entries, { fallbackName, folderId = null, source = '' } = {}) => {
  // Group the rows by playlist, keeping the order they appear in the file.
  const groups = new Map();
  for (const entry of entries) {
    const name = (entry.playlist || '').trim() || fallbackName || 'Import';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(entry);
  }

  const playlists = [];
  const issues = [];
  let matched = 0;

  for (const [name, rows] of groups) {
    const created = createPlaylist(userId, name, folderId);
    if (created.error) continue;
    const playlist = created.playlist;

    const trackIds = [];
    for (const row of rows) {
      const trackId = findTrackForImport(row);
      if (trackId) {
        trackIds.push(trackId);
      } else {
        issues.push({
          playlistId: playlist.id,
          playlistName: name,
          title: row.title,
          artists: row.artists,
          album: row.album,
          source,
        });
      }
    }

    if (trackIds.length) addTracks(userId, playlist.id, trackIds);
    matched += trackIds.length;
    playlists.push({
      id: playlist.id,
      name: playlist.name,
      matched: trackIds.length,
      missing: rows.length - trackIds.length,
    });
  }

  if (issues.length) addIssues(userId, issues);

  return {
    ok: true,
    playlists,
    total: entries.length,
    matched,
    missing: issues.length,
  };
});

// Adds the rows of a CSV to a playlist that already exists, instead of creating
// new ones. Used by "In bestehende Playlist importieren".
export const importIntoPlaylist = db.transaction((userId, playlistId, entries, { source = '' } = {}) => {
  const playlist = getPlaylist(userId, playlistId);
  if (!playlist) return { error: 'not_found' };

  const trackIds = [];
  const issues = [];
  for (const row of entries) {
    const trackId = findTrackForImport(row);
    if (trackId) {
      trackIds.push(trackId);
    } else {
      issues.push({
        playlistId: playlist.id,
        playlistName: playlist.name,
        title: row.title,
        artists: row.artists,
        album: row.album,
        source,
      });
    }
  }

  if (trackIds.length) addTracks(userId, playlist.id, trackIds);
  if (issues.length) addIssues(userId, issues);

  return {
    ok: true,
    playlists: [
      { id: playlist.id, name: playlist.name, matched: trackIds.length, missing: issues.length },
    ],
    total: entries.length,
    matched: trackIds.length,
    missing: issues.length,
  };
});
