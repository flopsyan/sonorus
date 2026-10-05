// Playlists and playlist folders. Both belong to exactly one account: every
// query is scoped by user_id, so one account can never see or change another
// account's lists.

import db from '../db.js';
import { TRACK_FIELDS, TRACK_FROM, shapeTrack } from './library.js';
import {
  autoName,
  defaultRules,
  dynamicTotals,
  dynamicTracks,
  expiry,
  filterOptions,
  parseRules,
  rulesForClient,
  rulesFromClient,
} from './dynamic.js';

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

// A temporary dynamic list first (it is about to go), then pinned, then the dragged order.
// Lists nobody has moved share position 0 and so still sort by name.
const PLAYLIST_ORDER = "(p.expires_at <> '') DESC, p.pinned DESC, p.position ASC, p.name COLLATE NOCASE ASC";

// A temporary list is gone once its time is up. Swept on every read of the
// lists, so no timer has to run and an expired one can never be shown.
function purgeExpired() {
  db.prepare("DELETE FROM playlists WHERE expires_at <> '' AND expires_at <= ?").run(new Date().toISOString());
}

// The name, count and length of a dynamic list come from its filters.
function withRules(userId, p, options) {
  const rules = p.rules ? parseRules(p.rules) : null;
  const { rules: _raw, expiresAt, ...rest } = p;
  if (!rules) return { ...rest, dynamic: false, expiresAt: '' };
  return {
    ...rest,
    ...dynamicTotals(userId, rules),
    name: p.name || autoName(rules, options()),
    dynamic: true,
    expiresAt: expiresAt || '',
  };
}

// Asked once per call and only when a dynamic list needs it.
function lazyOptions() {
  let cached = null;
  return () => (cached ||= filterOptions());
}

export function listPlaylists(userId) {
  purgeExpired();
  const options = lazyOptions();
  return db
    .prepare(
      `SELECT p.id, p.name, p.folder_id AS folderId, p.updated_at AS updatedAt,
              p.pinned, p.position, p.rules, p.expires_at AS expiresAt,
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
    .map((p) => withRules(userId, { ...p, pinned: !!p.pinned }, options));
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

const selectRow = db.prepare(
  `SELECT id, name, folder_id AS folderId, pinned, position, created_at AS createdAt, rules, expires_at AS expiresAt
     FROM playlists WHERE id = ? AND user_id = ?`
);

// For a dynamic list also its filters as the client ticks them, the name they
// write, and whether the name on it was given by hand.
export function getPlaylist(userId, id) {
  purgeExpired();
  const row = selectRow.get(id, userId);
  if (!row) return row;
  const { rules: text, expiresAt, ...base } = row;
  const rules = text ? parseRules(text) : null;
  if (!rules) return { ...base, pinned: !!row.pinned, dynamic: false, expiresAt: '' };
  const options = filterOptions();
  const auto = autoName(rules, options);
  return {
    ...base,
    pinned: !!row.pinned,
    name: row.name || auto,
    autoName: auto,
    named: !!row.name,
    dynamic: true,
    expiresAt: expiresAt || '',
    rules: rulesForClient(rules, options),
  };
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

// No name is asked for: the filters write one, and it lives for a day unless kept.
export function createDynamicPlaylist(userId, folderId = null) {
  const folder = folderId ? db.prepare('SELECT id FROM playlist_folders WHERE id = ? AND user_id = ?').get(folderId, userId) : null;
  const info = db
    .prepare("INSERT INTO playlists (user_id, folder_id, name, position, rules, expires_at) VALUES (?, ?, '', ?, ?, ?)")
    .run(userId, folder ? folder.id : null, nextPlaylistPosition.get(userId).pos, JSON.stringify(defaultRules()), expiry());
  return { playlist: getPlaylist(userId, Number(info.lastInsertRowid)) };
}

function dynamicRow(userId, id) {
  const row = selectRow.get(id, userId);
  return row && row.rules ? row : null;
}

export function setRules(userId, id, input) {
  if (!dynamicRow(userId, id)) return { error: 'not_found' };
  const rules = rulesFromClient(input);
  db.prepare("UPDATE playlists SET rules = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(
    JSON.stringify(rules),
    id,
    userId
  );
  return { playlist: getPlaylist(userId, id) };
}

// Kept for good: it needs a name of its own from here on, and no longer expires.
export function keepPlaylist(userId, id, name) {
  if (!dynamicRow(userId, id)) return { error: 'not_found' };
  const clean = cleanName(name, '');
  if (!clean) return { error: 'invalid_name' };
  db.prepare("UPDATE playlists SET name = ?, expires_at = '', updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(
    clean,
    id,
    userId
  );
  return { playlist: getPlaylist(userId, id) };
}

export function extendPlaylist(userId, id) {
  const row = dynamicRow(userId, id);
  if (!row) return { error: 'not_found' };
  if (row.expiresAt) db.prepare('UPDATE playlists SET expires_at = ? WHERE id = ? AND user_id = ?').run(expiry(), id, userId);
  return { playlist: getPlaylist(userId, id) };
}

// Renames a playlist, pins it, and/or moves it into another folder. Every field
// is only applied when the caller passed the key at all, so a rename cannot
// silently move the list out of its folder or unpin it.
export function updatePlaylist(userId, id, { name, folderId, pinned } = {}) {
  const current = getPlaylist(userId, id);
  if (!current) return { error: 'not_found' };

  // A dynamic list stores '' for "the name the filters write", so it keeps
  // following them until somebody really names it.
  const raw = selectRow.get(id, userId).name;
  let nextName = name === undefined ? raw : cleanName(name, raw);
  if (current.dynamic && name !== undefined) {
    const clean = cleanName(name, '');
    const temporary = !!current.expiresAt;
    if (!clean) nextName = temporary ? '' : raw;
    else nextName = temporary && clean === current.autoName ? '' : clean;
  }
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

// The sidebar order of one folder, or the top level when `folderId` is null. A list
// moves between folders the same way: it simply arrives in the target's id list.
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
export function playlistTracks(userId, id, { sort, dir } = {}) {
  const playlist = getPlaylist(userId, id);
  if (!playlist) return null;
  if (playlist.dynamic) return dynamicTracks(userId, parseRules(selectRow.get(id, userId).rules), { sort, dir });
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
  if (playlist.dynamic) return { error: 'dynamic_playlist' };

  let pos = nextPosition.get(id).pos;
  let added = 0;
  // Songs only. Spoken word belongs to its show or its book, not to a playlist, and
  // an id that names one is skipped like any other id that leads nowhere.
  const exists = db.prepare('SELECT id FROM tracks WHERE id = ? AND podcast_id IS NULL AND audiobook_id IS NULL');
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
