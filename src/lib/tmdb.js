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

// English for the log, `shown` in German for the settings page and the toast.
function tmdbError(log, shown) {
  const err = new Error(log);
  err.shown = shown;
  return err;
}

// fetch() rejects with a bare "fetch failed" and hides the reason in `cause`.
async function reach(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    const reason = (err.cause && err.cause.code) || err.name || err.message;
    throw tmdbError(
      `TMDB unreachable (${reason})`,
      err.name === 'TimeoutError' ? 'TMDB antwortet nicht.' : 'TMDB ist nicht erreichbar. Hat der Server Internet?'
    );
  }
}

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
    const res = await reach(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 401) {
      throw tmdbError('TMDB rejected the key (401)', 'TMDB lehnt den Schlüssel ab. Bitte TMDB_API_KEY prüfen.');
    }
    if (!res.ok) {
      throw tmdbError(`TMDB answered ${res.status} for ${pathname}`, `TMDB hat mit einem Fehler geantwortet (HTTP ${res.status}).`);
    }
    return res.json();
  }
  throw tmdbError(`TMDB kept rate-limiting ${pathname}`, 'TMDB nimmt gerade zu viele Anfragen nicht an. Bitte später nochmal.');
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
  const res = await reach(`${IMAGES}/${size}${filePath}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw tmdbError(`TMDB image ${res.status}: ${filePath}`, `Ein Bild von TMDB kam nicht an (HTTP ${res.status}).`);
  }
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, Buffer.from(await res.arrayBuffer()));
  await fsp.rename(temp, target);
  return name;
}
