import { Router } from 'express';
import crypto from 'node:crypto';
import { data, getAccountState, markDirty } from '../store.js';
import { loginAdmin, logoutAdmin, requireAdmin } from '../auth.js';
import { pickAccount } from '../pool.js';
import {
  generateState, createAuthSession, hashState, getSession, consumeApiKey,
  cleanupExpired, CALLBACK_URL, CALLBACK_PATH, STUDIO_AUTH_URL
} from '../ccauth.js';

export const adminRouter = Router();

const UPSTREAM_BASE = 'https://api.commandcode.ai/provider';

/** Fetch CommandCode model list (reuses the 5-min proxy cache; fetches fresh if stale). */
async function fetchModels() {
  const cache = data.state.modelsCache;
  const now = Date.now();
  const ttl = (data.config.modelsCacheTtlSec ?? 300) * 1000;
  if (cache.data && cache.at && now - cache.at < ttl) {
    try { return JSON.parse(cache.data).data ?? []; } catch {}
  }
  const account = pickAccount();
  if (!account) return [];
  try {
    const up = await fetch(UPSTREAM_BASE + '/v1/models', {
      headers: { authorization: `Bearer ${account.apiKey}` }
    });
    if (!up.ok) return [];
    const text = await up.text();
    cache.data = text;
    cache.at = now;
    markDirty();
    return JSON.parse(text).data ?? [];
  } catch {
    return [];
  }
}

/** Pick the newest model id for a family prefix (claude-opus-, claude-sonnet-, ...). */
function pickLatest(ids, prefix, fallback) {
  const candidates = ids.filter((id) => id.startsWith(prefix));
  if (!candidates.length) return fallback;
  candidates.sort().reverse(); // claude-sonnet-5 > claude-sonnet-4-6
  return candidates[0];
}

// ---- auth endpoints ----
adminRouter.post('/login', (req, res) => {
  const { password } = req.body ?? {};
  const token = loginAdmin(password);
  if (!token) {
    res.status(401).json({ error: 'yanlış şifre' });
    return;
  }
  res.setHeader('Set-Cookie', `cc_admin=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`);
  res.json({ ok: true });
});

adminRouter.post('/logout', (req, res) => {
  logoutAdmin(req.cookies?.cc_admin);
  res.setHeader('Set-Cookie', 'cc_admin=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

// ---- everything below requires a valid admin session ----
adminRouter.use(requireAdmin);

// ---- status: combined view ----
adminRouter.get('/status', (req, res) => {
  const accounts = (data.config.accounts || []).map((a) => {
    const st = getAccountState(a.id);
    return {
      id: a.id,
      name: a.name,
      apiKeyMasked: maskKey(a.apiKey),
      isActive: a.isActive,
      totalRequests: st.totalRequests,
      consecutiveErrors: st.consecutiveErrors,
      lastUsedAt: st.lastUsedAt,
      lastError: st.lastError,
      banned: st.banned
    };
  });

  res.json({
    masterKeyMasked: maskKey(data.config.masterKey),
    masterKeySet: !!data.config.masterKey,
    roundRobinIndex: data.state.roundRobinIndex,
    stats: data.state.stats,
    accounts,
    modelMap: data.config.modelMap,
    defaultModel: data.config.defaultModel,
    exposedModels: data.config.exposedModels || [],
    retry: data.config.retry,
    logs: data.state.logs || [],
    daily: data.state.daily || {}
  });
});

// ---- logs: son istekler ----
adminRouter.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 300);
  res.json({ logs: (data.state.logs || []).slice(-limit) });
});

// ---- logs: temizle ----
adminRouter.delete('/logs', (req, res) => {
  data.state.logs = [];
  markDirty();
  res.json({ ok: true });
});

// ---- accounts CRUD ----
adminRouter.post('/accounts', (req, res) => {
  const { name, apiKey } = req.body ?? {};
  if (!name || !apiKey) {
    res.status(400).json({ error: 'name ve apiKey gerekli' });
    return;
  }
  const account = {
    id: crypto.randomUUID(),
    name: String(name),
    apiKey: String(apiKey).trim(),
    isActive: true
  };
  data.config.accounts.push(account);
  markDirty();
  res.status(201).json({ id: account.id, name: account.name, apiKeyMasked: maskKey(account.apiKey) });
});

adminRouter.patch('/accounts/:id', (req, res) => {
  const acc = findAccount(req.params.id);
  if (!acc) { res.status(404).json({ error: 'hesap yok' }); return; }

  const { name, isActive, resetBan } = req.body ?? {};
  if (typeof name === 'string') acc.name = name;
  if (typeof isActive === 'boolean') acc.isActive = isActive;
  if (resetBan) {
    const st = getAccountState(acc.id);
    st.banned = false;
    st.consecutiveErrors = 0;
    st.lastError = null;
  }
  markDirty();
  res.json({ ok: true });
});

adminRouter.delete('/accounts/:id', (req, res) => {
  const idx = (data.config.accounts || []).findIndex((a) => a.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: 'hesap yok' }); return; }
  data.config.accounts.splice(idx, 1);
  delete data.state.accounts[req.params.id];
  markDirty();
  res.json({ ok: true });
});

// reveal full key (admin session only)
adminRouter.get('/accounts/:id/reveal', (req, res) => {
  const acc = findAccount(req.params.id);
  if (!acc) { res.status(404).json({ error: 'hesap yok' }); return; }
  res.json({ apiKey: acc.apiKey });
});

// ---- test account: try GET /v1/models with this key ----
adminRouter.post('/accounts/:id/test', async (req, res) => {
  const acc = findAccount(req.params.id);
  if (!acc) { res.status(404).json({ error: 'hesap yok' }); return; }

  const started = Date.now();
  try {
    const up = await fetch(UPSTREAM_BASE + '/v1/models', {
      headers: { authorization: `Bearer ${acc.apiKey}` }
    });
    const text = await up.text();
    let modelsCount = null;
    try {
      const j = JSON.parse(text);
      modelsCount = Array.isArray(j.data) ? j.data.length : null;
    } catch {}
    res.json({
      ok: up.ok,
      status: up.status,
      ms: Date.now() - started,
      modelsCount,
      detail: text.slice(0, 300)
    });
  } catch (err) {
    res.json({ ok: false, ms: Date.now() - started, detail: err.message });
  }
});

// ---- master key management ----
adminRouter.post('/master-key', (req, res) => {
  const { value } = req.body ?? {};
  if (value) {
    data.config.masterKey = String(value).trim();
  } else {
    data.config.masterKey = 'mk_' + crypto.randomBytes(16).toString('hex');
  }
  markDirty();
  res.json({ ok: true, masterKey: data.config.masterKey });
});

// ---- model list (from CommandCode) ----
adminRouter.get('/models', async (req, res) => {
  const models = await fetchModels();
  res.json({ models });
});

// ---- auto-map: fill modelMap from latest CommandCode Claude models ----
adminRouter.post('/model-map/auto', async (req, res) => {
  const models = await fetchModels();
  const ids = models.map((m) => m.id);

  const opus = pickLatest(ids, 'claude-opus-', null);
  const sonnet = pickLatest(ids, 'claude-sonnet-', null);
  const haiku = pickLatest(ids, 'claude-haiku-', null);
  const fable = pickLatest(ids, 'claude-fable-', null);

  const map = {
    'claude-opus-4-*': opus ?? 'claude-opus-5',
    'claude-opus-3-*': opus ?? 'claude-opus-5',
    'claude-sonnet-4-*': sonnet ?? 'claude-sonnet-5',
    'claude-sonnet-3-*': sonnet ?? 'claude-sonnet-5',
    'claude-haiku-4-*': haiku ?? 'claude-haiku-4-5-20251001',
    'claude-haiku-3-*': haiku ?? 'claude-haiku-4-5-20251001',
    'claude-fable-*': fable ?? 'claude-fable-5'
  };
  data.config.modelMap = map;
  data.config.defaultModel = sonnet ?? 'claude-sonnet-5';
  markDirty();
  res.json({ ok: true, modelMap: data.config.modelMap, defaultModel: data.config.defaultModel, found: { opus, sonnet, haiku, fable } });
});

// ---- model map ----
adminRouter.post('/model-map', (req, res) => {
  const { key, value } = req.body ?? {};
  if (!key || !value) { res.status(400).json({ error: 'key ve value gerekli' }); return; }
  data.config.modelMap[key] = value;
  markDirty();
  res.json({ ok: true, modelMap: data.config.modelMap });
});

adminRouter.delete('/model-map/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  delete data.config.modelMap[key];
  markDirty();
  res.json({ ok: true, modelMap: data.config.modelMap });
});

adminRouter.post('/model-map/default', (req, res) => {
  const { model } = req.body ?? {};
  if (!model) { res.status(400).json({ error: 'model gerekli' }); return; }
  data.config.defaultModel = String(model).trim();
  markDirty();
  res.json({ ok: true, defaultModel: data.config.defaultModel });
});

// ---- exposedModels: /v1/models API'sinde sunulacak model listesi ----
adminRouter.post('/exposed-models', (req, res) => {
  const { models } = req.body ?? {};
  if (!Array.isArray(models)) {
    res.status(400).json({ error: 'models (array) gerekli' });
    return;
  }
  // boş array = tüm modelleri sun (filtre yok)
  data.config.exposedModels = models.map((m) => String(m).trim()).filter(Boolean);
  markDirty();
  res.json({ ok: true, exposedModels: data.config.exposedModels });
});

// ---- CommandCode CLI auth (tarayıcıda giriş yap, key otomatik eklenir) ----
// start: state üret, tarayıcıda açılacak authUrl döndür
adminRouter.post('/commandcode-auth/start', (req, res) => {
  cleanupExpired();
  const state = generateState();
  createAuthSession(state);
  const callbackUrl = CALLBACK_URL;
  const authUrl = `${STUDIO_AUTH_URL}?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
  res.json({ state, authUrl, callbackUrl, expiresInSec: 15 * 60 });
});

// status: panel poll eder — apiKey ASLA dönmez
adminRouter.get('/commandcode-auth/status', (req, res) => {
  const state = String(req.query.state || '');
  if (!state) { res.status(400).json({ error: 'state gerekli' }); return; }
  const s = getSession(hashState(state));
  if (!s) {
    res.status(404).json({ error: 'oturum bulunamadı veya zaman aşımı' });
    return;
  }
  res.json({ status: s.status, metadata: s.metadata, expiresAt: s.expiresAt, appliedAt: s.appliedAt });
});

// apply: key'i hesaba ekle (tek kullanımlık)
adminRouter.post('/commandcode-auth/apply', (req, res) => {
  const state = String(req.body?.state || '');
  if (!state) { res.status(400).json({ error: 'state gerekli' }); return; }
  const hash = hashState(state);
  const apiKey = consumeApiKey(hash);
  if (!apiKey) {
    res.status(400).json({ error: 'key yok (henüz alınmadı veya zaten uygulandı)' });
    return;
  }
  const s = getSession(hash);
  const meta = s?.metadata || {};
  const name = meta.userName || meta.keyName || 'CommandCode';
  // mevcut bir hesapta bu key zaten var mı? varsa uygulama ama yeni ekleme
  const existing = (data.config.accounts || []).find((a) => a.apiKey === apiKey);
  if (existing) {
    res.json({ ok: true, alreadyExists: true, id: existing.id, name: existing.name, apiKeyMasked: maskKey(apiKey) });
    return;
  }
  const account = {
    id: crypto.randomUUID(),
    name: String(name),
    apiKey,
    isActive: true
  };
  data.config.accounts.push(account);
  markDirty();
  res.status(201).json({ ok: true, alreadyExists: false, id: account.id, name: account.name, apiKeyMasked: maskKey(account.apiKey) });
});

// iptal: bekleyen session'ı sil (vazgeçme)
adminRouter.delete('/commandcode-auth/state', (req, res) => {
  const state = String(req.query.state || '');
  if (!state) { res.status(400).json({ error: 'state gerekli' }); return; }
  const hash = hashState(state);
  if (data.state.ccauth[hash]) {
    delete data.state.ccauth[hash];
    markDirty();
  }
  res.json({ ok: true });
});

// ---- admin password ----
adminRouter.post('/password', (req, res) => {
  const { current, next } = req.body ?? {};
  if (current !== data.config.adminPassword) {
    res.status(401).json({ error: 'mevcut şifre yanlış' });
    return;
  }
  if (!next || next.length < 4) {
    res.status(400).json({ error: 'yeni şifre en az 4 karakter olmalı' });
    return;
  }
  data.config.adminPassword = String(next).trim();
  markDirty();
  res.json({ ok: true });
});

function findAccount(id) {
  return (data.config.accounts || []).find((a) => a.id === id);
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '…' + key.slice(-4);
}
