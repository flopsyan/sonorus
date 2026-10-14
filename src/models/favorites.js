// Favourite artists, albums and genres. Per account, like ratings; all a favourite does is
// stand at the top of its list.

import db from '../db.js';

const KINDS = {
  artist: { table: 'favorite_artists', items: 'artists' },
  album: { table: 'favorite_albums', items: 'albums' },
  genre: { table: 'favorite_genres', items: 'genres' },
};

// `alias` is the item table's alias in the caller's query; binds @userId.
export function favoriteFlag(kind, alias) {
  return `EXISTS (SELECT 1 FROM ${KINDS[kind].table} fav
                   WHERE fav.user_id = @userId AND fav.item_id = ${alias}.id)`;
}

export function setFavorite(userId, kind, itemId, favorite) {
  const spec = KINDS[kind];
  if (!spec) return { error: 'not_found' };
  if (!db.prepare(`SELECT 1 FROM ${spec.items} WHERE id = ?`).get(itemId)) return { error: 'not_found' };

  if (favorite) {
    db.prepare(`INSERT OR IGNORE INTO ${spec.table} (user_id, item_id) VALUES (?, ?)`).run(userId, itemId);
  } else {
    db.prepare(`DELETE FROM ${spec.table} WHERE user_id = ? AND item_id = ?`).run(userId, itemId);
  }
  return { ok: true, favorite: !!favorite };
}
