// Authentication for Sonorus. Every page and every API call requires a
// logged-in account - there is no anonymous access. All accounts have equal
// rights; only admins can manage accounts.
//
// The first account is created either through the one-time /setup page (when no
// account exists yet) or bootstrapped from AUTH_USER/AUTH_PASSWORD. Sessions are
// stateless, signed cookies (HMAC-SHA256) - no server-side store. The signature
// binds the account's password hash, so changing a password invalidates that
// account's existing sessions.

import crypto from 'node:crypto';
import { getMeta, setMeta } from '../db.js';
import {
  getUserById,
  getUserByUsername,
  verifyPassword,
  createUser,
  countUsers,
  publicUser,
} from '../models/users.js';

const COOKIE = 'sonorus-session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Stable signing secret: AUTH_SECRET if set, otherwise a random one persisted
// in the database (survives restarts; rotating it logs everyone out).
function sessionSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  let s = getMeta('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setMeta('session_secret', s);
  }
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

// Token layout: "<userId>.<issuedAt>.<signature>"
function makeToken(user) {
  const payload = `${user.id}.${Date.now()}`;
  return `${payload}.${sign(`${payload}.${user.pass_hash.slice(0, 16)}`)}`;
}

function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [idStr, issued, sig] = parts;
  const ts = Number(issued);
  if (!Number.isInteger(Number(idStr)) || !Number.isFinite(ts)) return null;
  if (Date.now() - ts >= MAX_AGE_MS) return null;

  const user = getUserById(Number(idStr));
  if (!user) return null;

  const expected = sign(`${idStr}.${issued}.${user.pass_hash.slice(0, 16)}`);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return user;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Failed-login throttling: after MAX_FAILS failed attempts from one client
// within FAIL_WINDOW_MS, further attempts are rejected until the window ends.
// In-memory (single process). req.ip honours X-Forwarded-For according to
// TRUST_PROXY (default: one reverse proxy hop), so clients behind the proxy
// are told apart correctly.
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, start }

export function loginBlocked(ip) {
  const w = loginFails.get(ip);
  if (!w) return false;
  if (Date.now() - w.start > FAIL_WINDOW_MS) {
    loginFails.delete(ip);
    return false;
  }
  return w.count >= MAX_FAILS;
}

export function recordLoginFailure(ip) {
  // Sweep stale entries once the map grows, so rotating IPs cannot leak memory.
  if (loginFails.size > 1000) {
    for (const [k, w] of loginFails) {
      if (Date.now() - w.start > FAIL_WINDOW_MS) loginFails.delete(k);
    }
  }
  const w = loginFails.get(ip);
  if (!w || Date.now() - w.start > FAIL_WINDOW_MS) {
    loginFails.set(ip, { count: 1, start: Date.now() });
  } else {
    w.count += 1;
  }
}

export function resetLoginFailures(ip) {
  loginFails.delete(ip);
}

// True while no account exists yet -> the one-time setup page must run first.
export function setupRequired() {
  return countUsers() === 0;
}

// Returns the full user row for a request (cached on req), or null.
export function currentUser(req) {
  if (req._user !== undefined) return req._user;
  req._user = userFromToken(readCookie(req, COOKIE)) || null;
  return req._user;
}

// Verifies credentials and returns the user row, or null.
export function authenticate(username, password) {
  const user = getUserByUsername(username);
  if (!user) {
    // Equalize timing a little so missing vs. wrong-password look similar.
    crypto.scryptSync(String(password ?? ''), 'x', 64);
    return null;
  }
  return verifyPassword(user, password) ? user : null;
}

export function setSessionCookie(res, req, user) {
  const secure = req.secure ? ' Secure;' : '';
  res.append(
    'Set-Cookie',
    `${COOKIE}=${makeToken(user)}; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}; HttpOnly; SameSite=Lax;${secure}`
  );
}

export function clearSessionCookie(res, req) {
  const secure = req.secure ? ' Secure;' : '';
  res.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax;${secure}`);
}

// Middleware: expose the auth state to every view.
export function attachAuth(req, res, next) {
  const user = currentUser(req);
  req.user = user;
  res.locals.user = publicUser(user);
  res.locals.authed = !!user;
  res.locals.isAdmin = !!(user && user.is_admin);
  res.locals.setupRequired = setupRequired();
  next();
}

// Middleware: guard a page route (login required for everything).
export function requireAuth(req, res, next) {
  if (currentUser(req)) return next();
  if (setupRequired()) return res.redirect('/setup');
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
}

// Middleware: guard an API route (JSON instead of a redirect).
export function requireAuthApi(req, res, next) {
  if (currentUser(req)) return next();
  return res.status(401).json({ ok: false, error: 'auth_required' });
}

// Middleware: guard an admin-only page route (user management). Logged-in
// non-admins get a 403; logged-out visitors are sent to the login page first.
export function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (setupRequired()) return res.redirect('/setup');
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
  }
  if (!user.is_admin) {
    return res.status(403).render('error', {
      title: 'Kein Zugriff',
      message: 'Diese Aktion ist nur für Administratoren.',
    });
  }
  return next();
}

// Create the first admin from AUTH_USER/AUTH_PASSWORD if no account exists yet.
// Once any account exists, env no longer overrides anything.
export function bootstrapAdmin() {
  const password = process.env.AUTH_PASSWORD;
  if (!password) return; // no bootstrap -> the /setup page creates the first admin
  if (countUsers() > 0) return;
  const username = (process.env.AUTH_USER || 'admin').trim();
  const res = createUser({ username, password, display_name: username, is_admin: 1 });
  if (res.user) console.log(`Bootstrapped admin account "${username}" from AUTH_PASSWORD.`);
  else console.error('Could not bootstrap admin account:', res.error);
}
