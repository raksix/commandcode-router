import crypto from 'node:crypto';
import { data, markDirty } from './store.js';

// ---- Master key auth (for /v1/*) ----
export function requireMasterKey(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] || '');
  if (!token || token !== data.config.masterKey) {
    res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'invalid x-api-key'
      }
    });
    return;
  }
  next();
}

// ---- Admin session (cookie-based, kalıcı — state.json'da tutulur) ----
// Kullanıcı isteği: bir kez login ol → session cookie olarak kaydedilir,
// restart dahil uzun süre geçerli kalsın. 30 gün TTL.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

function sessions() {
  if (!data.state.sessions) data.state.sessions = {};
  return data.state.sessions;
}

function newSessionToken() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions()[token] = Date.now() + SESSION_TTL_MS;
  markDirty(); // session'ı state.json'a yaz (restart'ta da kalsın)
  return token;
}

function isSessionValid(token) {
  const s = sessions();
  const expiry = s[token];
  if (!expiry) return false;
  if (Date.now() > expiry) { // süresi dolmuşsa temizle
    delete s[token];
    return false;
  }
  // sliding expiry: her istekte süreyi uzat
  s[token] = Date.now() + SESSION_TTL_MS;
  return true;
}

export function requireAdmin(req, res, next) {
  const token = req.cookies?.cc_admin;
  if (!token || !isSessionValid(token)) {
    res.status(401).json({ error: 'oturum gerekli' });
    return;
  }
  next();
}

export function loginAdmin(password) {
  if (!password || password !== data.config.adminPassword) return null;
  return newSessionToken();
}

export function logoutAdmin(token) {
  delete sessions()[token];
  markDirty();
}

// ---- tiny cookie parser (avoid extra dep) ----
export function cookieParser(req, _res, next) {
  const raw = req.headers.cookie || '';
  req.cookies = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    req.cookies[k] = decodeURIComponent(v);
  }
  next();
}
