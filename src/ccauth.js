import { randomBytes, createHash } from 'node:crypto';
import { data, markDirty } from './store.js';

/**
 * CommandCode CLI auth callback (OmniRoute tarzı).
 *
 * Akış:
 *  1. POST /api/commandcode-auth/start  -> { state, authUrl }
 *     authUrl = https://commandcode.ai/studio/auth/cli?callback=http://localhost:5959/callback&state=...
 *  2. Kullanıcı authUrl'yi tarayıcıda açar -> CommandCode key'i POST eder:
 *     POST http://localhost:5959/callback  { apiKey, state, userId, userName, keyName }
 *  3. Panel GET /api/commandcode-auth/status?state=... poll eder
 *  4. status 'received' olunca POST /api/commandcode-auth/apply -> key hesaba eklenir
 */

export const CALLBACK_PORT = 5959;
export const AUTH_TTL_MS = 15 * 60 * 1000; // 15 dk
export const CALLBACK_PATH = '/callback';
export const STUDIO_AUTH_URL = 'https://commandcode.ai/studio/auth/cli';
/** Remote kullanım için CALLBACK_URL env ile override edilebilir (örn. https://commandcode-router.fermag.com.tr/callback) */
export const CALLBACK_URL = process.env.CALLBACK_URL || `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

/** 32 byte random state (base64url). Bu state kullanıcıya gider, hash'i saklanır. */
export function generateState() {
  return randomBytes(32).toString('base64url');
}

/** state -> sha256 hex (veritabanında düz state tutmuyoruz) */
export function hashState(state) {
  return createHash('sha256').update(state).digest('hex');
}

/** Yeni auth session aç. Aynı state zaten varsa üzerine yazar. */
export function createAuthSession(state) {
  const now = Date.now();
  const hash = hashState(state);
  data.state.ccauth[hash] = {
    status: 'pending',     // pending -> received -> applied
    apiKey: null,
    metadata: null,
    createdAt: now,
    expiresAt: now + AUTH_TTL_MS,
    appliedAt: null
  };
  markDirty();
  return hash;
}

/** Callback'ten key geldi. Hash geçerli ve TTL içindeyse key'i yaz. */
export function receiveApiKey(hash, { apiKey, metadata }) {
  const s = data.state.ccauth[hash];
  if (!s) return { ok: false, error: 'geçersiz state' };
  if (Date.now() > s.expiresAt) return { ok: false, error: 'state zaman aşımına uğradı' };
  if (!apiKey || typeof apiKey !== 'string') return { ok: false, error: 'apiKey eksik' };
  s.status = 'received';
  s.apiKey = apiKey;
  s.metadata = metadata || null;
  markDirty();
  return { ok: true };
}

/** Panel poll'u için: apiKey HARİÇ durum bilgisi. */
export function getSession(hash) {
  const s = data.state.ccauth[hash];
  if (!s) return null;
  return {
    status: s.status,
    metadata: s.metadata,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    appliedAt: s.appliedAt
  };
}

/** Apply: key'i döndür, session'ı 'applied' işaretle (tek kullanımlık). */
export function consumeApiKey(hash) {
  const s = data.state.ccauth[hash];
  if (!s) return null;
  if (s.status !== 'received') return null; // pending/applied -> key verilmez
  const key = s.apiKey;
  s.status = 'applied';
  s.appliedAt = Date.now();
  markDirty();
  return key;
}

/** TTL geçmiş ve henüz uygulanmamış session'ları temizle. */
export function cleanupExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [hash, s] of Object.entries(data.state.ccauth)) {
    if (s.status !== 'applied' && now > s.expiresAt) {
      delete data.state.ccauth[hash];
      removed++;
    }
  }
  if (removed) markDirty();
  return removed;
}

/**
 * 5959 callback sunucusu için handler (node:http).
 * OPTIONS /callback -> 204 + CORS (CommandCode'un tarayıcı isteğine izin)
 * POST   /callback -> gövdeyi oku (10KB limit), key'i kaydet, { success: true }
 */
export function createCallbackHandler() {
  return function callbackHandler(req, res) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://commandcode.ai',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method !== 'POST' || req.url !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // gövdeyi oku (10KB limit)
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10240) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      const { apiKey, state, userId, userName, keyName } = payload;
      if (!state) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'state eksik' }));
        return;
      }
      const r = receiveApiKey(hashState(state), {
        apiKey,
        metadata: { userId, userName, keyName }
      });
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(r.ok ? { success: true } : { error: r.error }));
    });
  };
}
