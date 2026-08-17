import { Router } from 'express';
import crypto from 'node:crypto';
import { data, getAccountState, markDirty } from '../store.js';
import { loginAdmin, logoutAdmin, requireAdmin } from '../auth.js';

export const adminRouter = Router();

const UPSTREAM_BASE = 'https://api.commandcode.ai/provider';

// ---- auth endpoints ----
adminRouter.post('/login', (req, res) => {
  const { password } = req.body ?? {};
  const token = loginAdmin(password);
  if (!token) {
    res.status(401).json({ error: 'yanlış şifre' });
    return;
  }
  res.setHeader('Set-Cookie', `cc_admin=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${5 * 60}`);
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
    retry: data.config.retry
  });
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
