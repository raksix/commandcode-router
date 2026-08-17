import crypto from 'node:crypto';
import { data } from './store.js';

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

// ---- Admin session (cookie-based, in-memory) ----
const sessions = new Map(); // token -> expiry ts
const SESSION_TTL_MS = 5 * 60 * 1000;

function newSessionToken() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function requireAdmin(req, res, next) {
  const token = req.cookies?.cc_admin;
  if (!token || !sessions.has(token)) {
    res.status(401).json({ error: 'oturum gerekli' });
    return;
  }
  // sliding expiry
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  next();
}

export function loginAdmin(password) {
  if (!password || password !== data.config.adminPassword) return null;
  return newSessionToken();
}

export function logoutAdmin(token) {
  sessions.delete(token);
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
