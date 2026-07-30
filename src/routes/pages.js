import express from 'express';

import {
  requireAuth,
  setupRequired,
  loginBlocked,
  recordLoginFailure,
  resetLoginFailures,
  authenticate,
  setSessionCookie,
  clearSessionCookie,
} from '../lib/auth.js';
import { createUser } from '../models/users.js';

const router = express.Router();

const USER_ERRORS = {
  invalid_username: 'Ungültiger Benutzername (2-32 Zeichen: Buchstaben, Zahlen, . _ -).',
  weak_password: 'Passwort zu kurz (mindestens 4 Zeichen).',
  taken: 'Benutzername ist bereits vergeben.',
};

// Restrict a redirect target to local paths (no open redirects).
function safeNext(next) {
  const n = String(next || '/');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

// --- One-time setup (first admin) ------------------------------------------
router.get('/setup', (req, res) => {
  if (!setupRequired()) return res.redirect('/');
  res.render('setup', { title: 'Einrichtung', error: '' });
});

router.post('/setup', (req, res) => {
  if (!setupRequired()) return res.redirect('/');
  const r = createUser({
    username: req.body.username,
    password: req.body.password,
    display_name: req.body.display_name,
    is_admin: 1,
  });
  if (r.error) {
    return res.status(400).render('setup', { title: 'Einrichtung', error: USER_ERRORS[r.error] || 'Fehler.' });
  }
  setSessionCookie(res, req, r.user);
  res.redirect('/');
});

// --- Login / logout --------------------------------------------------------
router.get('/login', (req, res) => {
  if (setupRequired()) return res.redirect('/setup');
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Anmelden', error: '', next: safeNext(req.query.next) });
});

router.post('/login', (req, res) => {
  if (setupRequired()) return res.redirect('/setup');
  const next = safeNext(req.body.next);
  if (loginBlocked(req.ip)) {
    return res
      .status(429)
      .render('login', { title: 'Anmelden', error: 'Zu viele Fehlversuche. Bitte kurz warten.', next });
  }
  const user = authenticate(req.body.username, req.body.password);
  if (user) {
    resetLoginFailures(req.ip);
    setSessionCookie(res, req, user);
    return res.redirect(next);
  }
  recordLoginFailure(req.ip);
  res.status(401).render('login', { title: 'Anmelden', error: 'Benutzername oder Passwort falsch.', next });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res, req);
  res.redirect('/login');
});

// --- The app ---------------------------------------------------------------
// Sonorus is one page: navigating between artists, albums and playlists must
// never interrupt playback, so the server hands out the same shell for every
// library route and the client renders the view. Listing the routes explicitly
// (instead of a catch-all) keeps unknown URLs a real 404.
const APP_ROUTES = [
  '/',
  '/tracks',
  '/artists',
  '/artists/:id',
  '/artists/:id/singles',
  '/albums',
  '/albums/:id',
  '/genres',
  // One id or a comma list of them, the same as /stars/:stars
  '/genres/:ids',
  '/playlists/:id',
  '/stars/:stars',
  '/search',
  '/settings',
  '/stats',
  '/profile',
];

for (const route of APP_ROUTES) {
  router.get(route, requireAuth, (req, res) => {
    res.render('app', { title: '' });
  });
}

export default router;
