// Playlists and playlist folders. Both belong to exactly one account: every
// query is scoped by user_id, so one account can never see or change another
// account's lists.

import db from '../db.js';
import { TRACK_FIELDS, TRACK_FROM, shapeTrack } from './library.js';

const MAX_NAME = 120;

function cleanName(name, fallback) {
  const s = String(name || '').trim().slice(0, MAX_NAME);
  return s || fallback;
}

// --- Folders ----------------------------------------------------------------

export function listFolders(userId) {
  return db
    .prepare('SELECT id, name FROM playlist_folders WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC')
    .all(userId);
}

export function createFolder(userId, name) {
  const clean = cleanName(name, '');
  if (!clean) return { error: 'invalid_name' };
  const info = db
    .prepare('INSERT INTO playlist_folders (user_id, name) VALUES (?, ?)')
    .run(userId, clean);
  return { folder: { id: Number(info.lastInsertRowid), name: clean } };
}

export function renameFolder(userId, id, name) {
  const clean = cleanName(name, '');
  if (!clean) return { error: 'invalid_name' };
  const info = db
    .prepare('UPDATE playlist_folders SET name = ? WHERE id = ? AND user_id = ?')
    .run(clean, id, userId);
  return info.changes ? { ok: true } : { error: 'not_found' };
}

// Deleting a folder keeps its playlists - they move back to the top level
// (folder_id becomes NULL through the foreign key).
export function deleteFolder(userId, id) {
  const info = db
    .prepare('DELETE FROM playlist_folders WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return info.changes ? { ok: true } : { error: 'not_found' };
}

// --- Playlists --------------------------------------------------------------

// The sidebar order, and the only one there is: pinned lists first, then the
// order the user dragged them into. Everything nobody has moved yet shares
// position 0 and therefore still sorts by name.
const PLAYLIST_ORDER = 'p.pinned DESC, p.position ASC, p.name COLLATE NOCASE ASC';

export function listPlaylists(userId) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.folder_id AS folderId, p.updated_at AS updatedAt,
              p.pinned, p.position,
              COUNT(i.id) AS trackCount,
              COALESCE(SUM(t.duration), 0) AS duration
         FROM playlists p
         LEFT JOIN playlist_items i ON i.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = i.track_id
        WHERE p.user_id = ?
        GROUP BY p.id
        ORDER BY ${PLAYLIST_ORDER}`
    )
    .all(userId)
    .map((p) => ({ ...p, pinned: !!p.pinned }));
}

// Folders with their playlists, plus the playlists that sit at the top level.
// This is what the sidebar renders.
export function playlistTree(userId) {
  const folders = listFolders(userId);
  const playlists = listPlaylists(userId);
  return {
    folders: folders.map((f) => ({
      ...f,
      playlists: playlists.filter((p) => p.folderId === f.id),
    })),
    loose: playlists.filter((p) => !p.folderId),
  };
}

export function getPlaylist(userId, id) {
  const row = db
    .prepare(
      `SELECT id, name, folder_id AS folderId, pinned, position, created_at AS createdAt
         FROM playlists WHERE id = ? AND user_id = ?`
    )
    .get(id, userId);
  return row ? { ...row, pinned: !!row.pinned } : row;
}

// A new list goes to the end of the sidebar, not into the middle of an order
// the user arranged by hand.
const nextPlaylistPosition = db.prepare(
  'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM playlists WHERE user_id = ?'
);

export function createPlaylist(userId, name, folderId = null) {
  const clean = cleanName(name, '');
  if (!clean) return { error: 'invalid_name' };
  const folder = folderId ? db.prepare('SELECT id FROM playlist_folders WHERE id = ? AND user_id = ?').get(folderId, userId) : null;
  const info = db
    .prepare('INSERT INTO playlists (user_id, folder_id, name, position) VALUES (?, ?, ?, ?)')
    .run(userId, folder ? folder.id : null, clean, nextPlaylistPosition.get(userId).pos);
  return { playlist: getPlaylist(userId, Number(info.lastInsertRowid)) };
}

// Renames a playlist, pins it, and/or moves it into another folder. Every field
// is only applied when the caller passed the key at all, so a rename cannot
// silently move the list out of its folder or unpin it.
export function updatePlaylist(userId, id, { name, folderId, pinned } = {}) {
  const current = getPlaylist(userId, id);
  if (!current) return { error: 'not_found' };

  const nextName = name === undefined ? current.name : cleanName(name, current.name);
  const nextPinned = pinned === undefined ? current.pinned : !!pinned;
  let nextFolder = current.folderId;
  if (folderId !== undefined) {
    nextFolder = folderId
      ? (db.prepare('SELECT id FROM playlist_folders WHERE id = ? AND user_id = ?').get(folderId, userId) || {}).id ?? null
      : null;
  }

  db.prepare(
    `UPDATE playlists SET name = ?, folder_id = ?, pinned = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`
  ).run(nextName, nextFolder, nextPinned ? 1 : 0, id, userId);
  return { playlist: getPlaylist(userId, id) };
}

// Writes the sidebar order of one container - a folder, or the top level when
// `folderId` is null. The client sends the ids of everything in that container
// in their new order after a drag, which is also how a list moves from one
// folder into another: it simply arrives in the target's list.
export const reorderPlaylists = db.transaction((userId, folderId, ids) => {
  const folder = folderId
    ? db.prepare('SELECT id FROM playlist_folders WHERE id = ? AND user_id = ?').get(folderId, userId)
    : null;
  if (folderId && !folder) return { error: 'not_found' };

  const own = new Set(
    db.prepare('SELECT id FROM playlists WHERE user_id = ?').all(userId).map((r) => r.id)
  );
  const update = db.prepare(
    `UPDATE playlists SET folder_id = ?, position = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`
  );

  let pos = 0;
  for (const raw of ids) {
    const id = Number(raw);
    if (!own.has(id)) continue;
    update.run(folder ? folder.id : null, pos, id, userId);
    own.delete(id);
    pos += 1;
  }
  return { ok: true };
});

export function deletePlaylist(userId, id) {
  const info = db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes ? { ok: true } : { error: 'not_found' };
}

// --- Playlist contents ------------------------------------------------------

// Tracks of a playlist in their stored order. The item id comes along so the
// client can remove or reorder a single entry - the same track may appear
// several times in one playlist.
export function playlistTracks(userId, id) {
  const playlist = getPlaylist(userId, id);
  if (!playlist) return null;
  return db
    .prepare(
      `SELECT i.id AS itemId, ${TRACK_FIELDS} ${TRACK_FROM}
         JOIN playlist_items i ON i.track_id = t.id
        WHERE i.playlist_id = @id
        ORDER BY i.position ASC, i.id ASC`
    )
    .all({ id, userId })
    .map((row) => ({ itemId: row.itemId, ...shapeTrack(row) }));
}

const nextPosition = db.prepare(
  'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM playlist_items WHERE playlist_id = ?'
);
const insertItem = db.prepare(
  'INSERT INTO playlist_items (playlist_id, track_id, position) VALUES (?, ?, ?)'
);
const touchPlaylist = db.prepare(
  `UPDATE playlists SET updated_at = datetime('now') WHERE id = ?`
);

// Appends tracks to the end of a playlist. Ids that do not exist are skipped;
// duplicates are allowed on purpose (a playlist may repeat a song).
export const addTracks = db.transaction((userId, id, trackIds) => {
  const playlist = getPlaylist(userId, id);
  if (!playlist) return { error: 'not_found' };

  let pos = nextPosition.get(id).pos;
  let added = 0;
  // Songs only. A podcast episode belongs to its show, not to a playlist, and
  // an id that names one is skipped like any other id that leads nowhere.
  const exists = db.prepare('SELECT id FROM tracks WHERE id = ? AND podcast_id IS NULL');
  for (const raw of trackIds) {
    const trackId = Number(raw);
    if (!Number.isInteger(trackId) || !exists.get(trackId)) continue;
    insertItem.run(id, trackId, pos);
    pos += 1;
    added += 1;
  }
  touchPlaylist.run(id);
  return { ok: true, added };
});

export function removeItem(userId, id, itemId) {
  const playlist = getPlaylist(userId, id);
  if (!playlist) return { error: 'not_found' };
  const info = db
    .prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?')
    .run(itemId, id);
  touchPlaylist.run(id);
  return info.changes ? { ok: true } : { error: 'not_found' };
}

// Writes a new order for the whole playlist. The client sends the item ids in
// their new order after a drag; ids that do not belong to this playlist are
// ignored.
export const reorderItems = db.transaction((userId, id, itemIds) => {
  const playlist = getPlaylist(userId, id);
  if (!playlist) return { error: 'not_found' };

  const own = new Set(
    db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').all(id).map((r) => r.id)
  );
  const update = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
  let pos = 0;
  for (const raw of itemIds) {
    const itemId = Number(raw);
    if (!own.has(itemId)) continue;
    update.run(pos, itemId);
    own.delete(itemId);
    pos += 1;
  }
  // Anything the client did not mention keeps its relative order at the end.
  for (const itemId of own) {
    update.run(pos, itemId);
    pos += 1;
  }
  touchPlaylist.run(id);
  return { ok: true };
});
