import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coversDir } from './db.js'; // initializes database & schema
import pagesRouter from './routes/pages.js';
import apiRouter from './routes/api.js';
import { attachAuth, bootstrapAdmin, setupRequired } from './lib/auth.js';
import { securityHeaders, rejectCrossSite } from './lib/security.js';
import { scanOnStart } from './lib/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Express "trust proxy": how many reverse proxies sit in front of the app.
// Default 1 (the usual single homelab reverse proxy) - req.ip then comes from
// X-Forwarded-For as set by the proxy. Set TRUST_PROXY=false when the app is
// exposed directly, otherwise clients could spoof their IP via that header
// and cycle through the per-IP login limiter.
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

// Static files (CSS, client JS) and the cover art extracted during the scan.
// Covers are content-addressed by album id and rewritten on a rescan, so a
// short cache is safe and keeps the album grid from re-fetching on every view.
app.use('/static', express.static(path.join(projectRoot, 'public'), { maxAge: '1h' }));
app.use('/covers', express.static(coversDir, { maxAge: '1h', fallthrough: false }));

// Container healthcheck (no auth)
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Reject state-changing requests that come from a foreign origin (CSRF)
app.use(rejectCrossSite);

// Body parsers. The CSV import posts the file contents as text, so the JSON
// limit has to fit a large playlist export.
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '12mb' }));

// Per-request view context. Pages and API responses are private and dynamic,
// so they are never cached; static assets and covers keep their cache headers.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.currentPath = req.path;
  next();
});

// Auth state for all views and route guards
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

// Error handling. Details (stack trace) only in development - a bare
// "npm start" without NODE_ENV must not leak internals.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Serverfehler.' });
  }
  res.status(500).render('error', {
    title: 'Fehler',
    message: process.env.NODE_ENV === 'development' ? String(err && err.stack ? err.stack : err) : '',
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
    console.log('Login required. Manage accounts under Einstellungen (admins only).');
  }
  scanOnStart();
});
