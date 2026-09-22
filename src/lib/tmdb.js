// The Movie Database: the one place Sonorus goes online, and only with a key.
// Without TMDB_API_KEY nothing here runs and the video side lives on the
// folder names and the artwork next to the files.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { videoArtDir } from '../db.js';

const API = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p';

const key = () => String(process.env.TMDB_API_KEY || '').trim();
export const LANGUAGE = process.env.TMDB_LANGUAGE || 'de-DE';
export const FALLBACK_LANGUAGE = 'en-US';

export function tmdbEnabled() {
  return !!key();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET one API path. Null for a 404; throws on anything else that is not ok. */
export async function tmdb(pathname, params = {}) {
  const url = new URL(`${API}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { accept: 'application/json' };
  // The long read-access token goes in a header, the short v3 key in the URL.
  if (key().startsWith('eyJ')) headers.authorization = `Bearer ${key()}`;
  else url.searchParams.set('api_key', key());

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 401) throw new Error('TMDB rejected the key (401). Check TMDB_API_KEY.');
    if (!res.ok) throw new Error(`TMDB answered ${res.status} for ${pathname}`);
    return res.json();
  }
  throw new Error(`TMDB kept rate-limiting ${pathname}`);
}

/**
 * Downloads one image into the artwork folder once and returns its file name.
 * TMDB names its files by content, so the name alone says it is already here.
 */
export async function tmdbImage(filePath, size) {
  if (!filePath) return '';
  const name = `t-${size}-${path.basename(filePath)}`;
  const target = path.join(videoArtDir, name);
  if (fs.existsSync(target)) return name;
  const res = await fetch(`${IMAGES}/${size}${filePath}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`TMDB image ${res.status}: ${filePath}`);
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, Buffer.from(await res.arrayBuffer()));
  await fsp.rename(temp, target);
  return name;
}
