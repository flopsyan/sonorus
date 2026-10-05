import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coversDir, videoArtDir } from './db.js'; // initializes database & schema
import pagesRouter from './routes/pages.js';
import apiRouter from './routes/api.js';
import { attachAuth, bootstrapAdmin, setupRequired } from './lib/auth.js';
import { securityHeaders, rejectCrossSite } from './lib/security.js';
import { scanOnStart } from './lib/scanner.js';
import { probeFfmpeg } from './lib/transcode.js';
import { hwEncode } from './lib/media.js';
import { unexpected } from './lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Default 1 reverse proxy, so req.ip comes from X-Forwarded-For. Set TRUST_PROXY=false
// when exposed directly, or clients spoof their IP and dodge the per-IP login limiter.
function parseTrustProxy(value) {
  if (value == null || value === '') return 1;
  const s = String(value).trim();
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^(true|yes|on)$/i.test(s)) return true;
  const n = Number(s);
  return Number.isFinite(n) ? n : s; // hop count, or an Express subnet/preset list
}

const app = express();
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// View engine (EJS) + templates
app.set('view engine', 'ejs');
app.set('views', path.join(projectRoot, 'views'));

app.locals.siteName = process.env.SITE_NAME || 'Sonorus';
// Changes on every (re)start -> busts the browser cache for CSS/JS after deploys
app.locals.assetVersion = process.env.ASSET_VERSION || String(Date.now());

// Security response headers (CSP etc.) for everything, including static files
app.use(securityHeaders);

// Covers are named by album id and overwritten in place on a rescan, so their cache must stay short.
// JS revalidates: imported modules carry no `?v=` buster, so a cached one would run stale after a deploy.
app.use(
  '/static',
  express.static(path.join(projectRoot, 'public'), {
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
app.use('/covers', express.static(coversDir, { maxAge: '1h', fallthrough: false }));
// Named after their content, so a changed picture is a new name and can be cached long.
app.use('/video-art', express.static(videoArtDir, { maxAge: '30d', immutable: true, fallthrough: false }));

// Container healthcheck (no auth)
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Reject state-changing requests that come from a foreign origin (CSRF)
app.use(rejectCrossSite);

// The login and setup forms. The JSON parser sits behind the API's login check.
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Pages and API responses are private and dynamic, so they are never cached;
// static assets and covers keep their cache headers.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.currentPath = req.path;
  next();
});

// Sets req.user for the route guards
app.use(attachAuth);

// Routes
app.use('/api', apiRouter);
app.use('/', pagesRouter);

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Nicht gefunden',
    message: 'Diese Seite gibt es nicht.',
  });
});

// Error handling. The stack goes to the log under a short reference, and the
// answer carries that reference - see `unexpected` in lib/errors.js.
app.use((err, req, res, next) => {
  // A 4xx (an oversized or broken body, a missing cover, an undecodable URL) is
  // the request's fault, not a crash worth a stack trace.
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  const tooLarge = status === 413;
  const badJson = err && err.type === 'entity.parse.failed';
  if (status < 500) console.warn(`Sonorus: ${req.method} ${req.originalUrl}: ${err.message}`);
  const failure = status < 500 ? null : unexpected(err, req);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) {
    if (tooLarge) {
      return res.status(413).json({ ok: false, error: 'too_large', message: 'Die Daten sind zu groß für den Server.' });
    }
    if (badJson) {
      return res.status(400).json({ ok: false, error: 'bad_json', message: 'Die Anfrage war kein gültiges JSON.' });
    }
    if (!failure) {
      return res.status(status).json({ ok: false, error: 'bad_request', message: 'Die Anfrage konnte nicht gelesen werden.' });
    }
    return res.status(500).json({ ok: false, error: 'server_error', ref: failure.ref, message: failure.message });
  }
  res.status(status).render('error', {
    title: 'Fehler',
    message: failure
      ? process.env.NODE_ENV === 'development'
        ? String(err && err.stack ? err.stack : err)
        : failure.message
      : 'Die Anfrage konnte nicht gelesen werden.',
  });
});

// Create the first admin account from AUTH_USER/AUTH_PASSWORD if configured
try {
  bootstrapAdmin();
} catch (e) {
  console.error('Could not bootstrap admin account:', e);
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`${app.locals.siteName} is running at http://localhost:${port}`);
  if (setupRequired()) {
    console.log('No account yet - open the app to run the one-time setup, or set AUTH_PASSWORD.');
  } else {
    console.log('Login required. Manage accounts from the account menu (admins only).');
  }
  // Probed once, not per stream. Without ffmpeg only the original quality exists,
  // and GET /api/quality tells the clients so they offer no setting that cannot work.
  probeFfmpeg().then((ready) => {
    console.log(
      ready
        ? 'ffmpeg found - the smaller quality can be served.'
        : 'ffmpeg missing - only the original quality is served.'
    );
    if (ready && hwEncode) console.log('Films are encoded on the GPU (VAAPI).');
    scanOnStart();
  });
});
