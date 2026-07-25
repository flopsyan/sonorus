// Security middleware: response headers and cross-site request rejection.

// Everything Sonorus serves is same-origin: no CDNs, no external requests.
// Images additionally allow data: URLs (favicon, avatars, canvas exports).
// Inline scripts are disallowed - client code lives under /static/js.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
}

// Rejects state-changing requests that provably come from a different site.
// SameSite=Lax session cookies already keep such requests unauthenticated in
// modern browsers; this is an explicit second layer (CSRF defense in depth).
// Requests without Origin/Sec-Fetch-Site headers (curl, scripts) are
// unaffected - CSRF is strictly a browser problem.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function rejectCrossSite(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  let cross = req.headers['sec-fetch-site'] === 'cross-site';
  const origin = req.headers.origin;
  if (!cross && origin) {
    if (origin === 'null') {
      cross = true; // opaque initiator (sandboxed iframe, data: page, ...)
    } else {
      try {
        cross = new URL(origin).host !== req.headers.host;
      } catch {
        cross = true;
      }
    }
  }
  if (!cross) return next();

  if (req.path.startsWith('/api/')) {
    // `message` is what the client shows - without it the toast falls back to
    // a generic "Da ist etwas schiefgelaufen".
    return res.status(403).json({
      ok: false,
      error: 'cross_site',
      message: 'Anfrage von fremder Herkunft blockiert.',
    });
  }
  return res.status(403).render('error', {
    title: 'Nicht erlaubt',
    message: 'Anfrage von fremder Herkunft blockiert.',
  });
}
