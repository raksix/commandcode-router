// src/proxy-pool.js — HTTP proxy pool manager for CommandCode Router
//
// Features:
//   - bulk import: user:pass@host:port, host:port:user:pass, user:pass:host:port,
//     host:port, http:// and socks5:// variants; invalid lines rejected with reason
//   - smart weighted rotation: credit += weight × EWMA × streak-penalty; pick the
//     one with the highest credit, deduct Σw. Guarantees fairness per unit weight
//     while degraded proxies cool down naturally.
//   - breaker: 3 failures within 10 min OR a single 407 → 12 h disable
//   - exponential cooldown for isolated failures (1m → 30m cap)
//   - periodic health check via gstatic generate_204 (5 min cadence)
//
// State lives in data.state.proxies so we don't need a separate file.

import http from 'node:http';
import crypto from 'node:crypto';
import { data, markDirty } from './store.js';

const DISABLE_HOURS = 12;
const COLLAPSE_THRESHOLD = 3;
const COLLAPSE_WINDOW_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10000;
const CHECK_URL = process.env.CHECK_URL || 'http://www.gstatic.com/generate_204';
const BASE_COOLDOWN_MS = 60 * 1000;

/** State shape we expect on data.state.proxies */
const EMPTY_PROXY_STATE = {
  proxies: {},     // id -> record
  order: [],       // insertion order of ids
  roundRobinIndex: 0,
};

function ensureState() {
  if (!data.state.proxies) {
    data.state.proxies = structuredClone(EMPTY_PROXY_STATE);
  }
  return data.state.proxies;
}

/* --------------------------------- parsing --------------------------------- */

function parseProxyLine(rawLine) {
  let line = String(rawLine).trim();
  if (!line || line.startsWith('#')) return null;

  let protocol = 'http';
  const protoMatch = line.match(/^(https?|socks[45]?):\/\//i);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase();
    line = line.slice(protoMatch[0].length);
  }

  let username = '', password = '';
  const atIdx = line.indexOf('@');
  if (atIdx !== -1) {
    const creds = line.slice(0, atIdx);
    line = line.slice(atIdx + 1);
    const sep = creds.indexOf(':');
    if (sep === -1) username = decodeURIComponent(creds);
    else {
      username = decodeURIComponent(creds.slice(0, sep));
      password = decodeURIComponent(creds.slice(sep + 1));
    }
  }

  const parts = line.split(':').map(s => s.trim());
  let host, port;

  if (parts.length === 2) {
    [host, port] = parts;
  } else if (parts.length === 4) {
    if (/^\d{1,5}$/.test(parts[1])) {
      [host, port] = parts;
      if (!username) { username = parts[2]; password = parts[3]; }
    } else if (/^\d{1,5}$/.test(parts[3])) {
      if (!username) { username = parts[0]; password = parts[1]; }
      [host, port] = [parts[2], parts[3]];
    } else {
      return { error: '4 parça var ama port bulunamadı' };
    }
  } else {
    return { error: 'tanınmayan format' };
  }

  if (!host) return { error: 'host eksik' };
  if (!/^\d{1,5}$/.test(port || '')) return { error: 'geçersiz port' };
  const portNum = parseInt(port, 10);
  if (portNum < 1 || portNum > 65535) return { error: 'port aralık dışı' };

  return { descriptor: { protocol, host, port: portNum, username, password } };
}

function proxyId(d) {
  return crypto.createHash('sha1')
    .update(`${d.protocol}|${d.host}|${d.port}|${d.username}`)
    .digest('hex').slice(0, 16);
}

function newRecord(d, sourceLabel) {
  const now = Date.now();
  return {
    id: proxyId(d),
    protocol: d.protocol,
    host: d.host,
    port: d.port,
    username: d.username,
    label: '',
    tags: [],
    weight: 1,
    addedAt: now,
    updatedAt: now,
    source: sourceLabel || 'manual',
    credit: 0,
    assignedCount: 0,
    reportedOk: 0,
    reportedFail: 0,
    checkedTotal: 0,
    checkedOk: 0,
    ewma: 0.9,
    streak: 0,
    failTimes: [],
    cooldownUntil: 0,
    disabledUntil: 0,
    disabledReason: '',
    lastError: '',
    lastCheckAt: 0,
    lastCheckStatus: '',
    latencyMs: null,
    lastUsedAt: 0,
  };
}

/** Bulk add. Returns { added, merged, invalid, errors } */
export function bulkAdd(text, sourceLabel) {
  const state = ensureState();
  const lines = String(text || '').split(/\r?\n|\s{2,}/);
  let added = 0, merged = 0;
  const invalid = [];
  const errors = [];
  for (const line of lines) {
    if (!line.trim() || /^#/.test(line.trim())) continue;
    const res = parseProxyLine(line);
    if (!res || res.error) {
      invalid.push(line.trim().slice(0, 120));
      if (res && res.error) errors.push(res.error);
      continue;
    }
    const d = res.descriptor;
    const id = proxyId(d);
    if (state.proxies[id]) {
      const rec = state.proxies[id];
      if (rec.password !== d.password || rec.protocol !== d.protocol) {
        rec.password = d.password;
        rec.protocol = d.protocol;
        rec.updatedAt = Date.now();
      }
      rec.disabledUntil = 0;
      rec.disabledReason = '';
      rec.cooldownUntil = 0;
      rec.streak = 0;
      rec.failTimes = [];
      merged++;
    } else {
      state.proxies[id] = newRecord(d, sourceLabel);
      state.order.push(id);
      added++;
    }
  }
  if (added || merged) markDirty();
  return { added, merged, invalid, errors: [...new Set(errors)] };
}

/* ------------------------------ rotation engine ----------------------------- */

function isDisabled(rec) { return rec.disabledUntil > Date.now(); }
function isActive(rec)  { return !isDisabled(rec) && rec.weight > 0 && rec.cooldownUntil <= Date.now(); }

function effWeight(rec) {
  const health = Math.max(rec.ewma, 0.15);
  const penalty = Math.pow(0.5, Math.min(rec.streak, 4));
  return rec.weight * health * penalty;
}

function classifyCode(detail) {
  if (detail === 407 || /407/.test(String(detail))) return 'auth';
  return 'net';
}

export function reportOutcome(id, ok, detail) {
  const state = ensureState();
  const rec = state.proxies[id];
  if (!rec) return null;
  const now = Date.now();

  if (ok) {
    rec.reportedOk++;
    rec.streak = 0;
    rec.failTimes = [];
    rec.cooldownUntil = 0;
    rec.ewma = rec.ewma * 0.85 + 0.15;
    rec.latencyMs = typeof detail === 'number' ? detail : rec.latencyMs;
    if (rec.disabledReason && !rec.disabledUntil) rec.disabledReason = '';
  } else {
    rec.reportedFail++;
    rec.lastError = String(detail || 'unknown').slice(0, 200);
    const kind = classifyCode(detail);
    if (kind === 'auth') {
      disableInternal(rec, 'auth_failed_12h', String(now));
    }
    rec.failTimes.push(now);
    rec.failTimes = rec.failTimes.filter(t => now - t <= COLLAPSE_WINDOW_MS);
    rec.streak++;
    rec.ewma = rec.ewma * 0.85;
    const cd = BASE_COOLDOWN_MS * Math.pow(2, Math.min(rec.streak - 1, 6));
    rec.cooldownUntil = now + Math.min(cd, 30 * 60e3);

    if (kind !== 'auth' && rec.failTimes.length >= COLLAPSE_THRESHOLD && rec.streak >= COLLAPSE_THRESHOLD) {
      disableInternal(rec, 'collapsed_12h',
        `${rec.failTimes.length} hata/${Math.round(COLLAPSE_WINDOW_MS / 60000)}dk`);
    }
  }
  markDirty();
  return snapshot(rec);
}

function disableInternal(rec, reason, meta) {
  rec.disabledUntil = Date.now() + DISABLE_HOURS * 3600e3;
  rec.disabledReason = meta ? `${reason}: ${meta}` : reason;
  rec.cooldownUntil = 0;
  console.log(`[proxy-pool] ${rec.host}:${rec.port} disabled ${DISABLE_HOURS}h (${rec.disabledReason})`);
}

export function enableProxy(id) {
  const state = ensureState();
  const rec = state.proxies[id];
  if (!rec) return null;
  rec.disabledUntil = 0;
  rec.disabledReason = '';
  rec.streak = 0;
  rec.failTimes = [];
  rec.cooldownUntil = 0;
  rec.ewma = Math.max(rec.ewma, 0.5);
  markDirty();
  return snapshot(rec);
}

/** Smooth-weighted pick among active proxies (equal share per unit weight). */
export function pickNext() {
  const state = ensureState();
  const ids = state.order.filter(id => {
    const r = state.proxies[id];
    return r && isActive(r);
  });
  if (!ids.length) return null;

  // First ever call: pure round-robin to guarantee every active proxy is seen.
  const anyActive = ids.some(id => state.proxies[id].credit !== 0);
  if (!anyActive) {
    const id = ids[Math.min(state.roundRobinIndex % ids.length, ids.length - 1)];
    state.roundRobinIndex = (state.roundRobinIndex + 1) % Math.max(ids.length, 1);
    return assign(state.proxies[id]);
  }

  let totalW = 0;
  for (const id of ids) totalW += effWeight(state.proxies[id]);
  for (const id of ids) state.proxies[id].credit += effWeight(state.proxies[id]);

  let best = null;
  for (const id of ids) {
    const r = state.proxies[id];
    if (!best || r.credit > best.credit) best = r;
  }
  best.credit -= totalW;

  for (const id of ids) {
    const r = state.proxies[id];
    const cap = totalW * 3;
    if (r.credit > cap) r.credit = cap;
    if (r.credit < -cap) r.credit = -cap;
  }
  return assign(best);
}

function assign(rec) {
  rec.assignedCount++;
  rec.lastUsedAt = Date.now();
  markDirty();
  return rec;
}

/* ------------------------------ health checking ------------------------------ */

function checkViaHttpProxy(rec, targetUrl, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const headers = { 'User-Agent': 'commandcode-router/proxy-healthcheck' };
    if (rec.username) {
      headers['Proxy-Authorization'] = 'Basic ' +
        Buffer.from(`${decodeURIComponent(rec.username)}:${decodeURIComponent(rec.password)}`).toString('base64');
    }
    const req = http.request({
      host: rec.host, port: rec.port, method: 'GET',
      path: targetUrl, headers, timeout: timeoutMs,
    }, res => {
      res.resume();
      const ok = res.statusCode >= 200 && res.statusCode < 400 && res.statusCode !== 407;
      resolve({ ok, status: res.statusCode, ms: Date.now() - started });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve({ ok: false, status: err.message, ms: Date.now() - started }));
    req.end();
  });
}

async function checkProxy(rec) {
  const res = await checkViaHttpProxy(rec, CHECK_URL, CHECK_TIMEOUT_MS);
  rec.checkedTotal++;
  rec.lastCheckAt = Date.now();
  rec.lastCheckStatus = res.ok ? `HTTP ${res.status}` : String(res.status).slice(0, 80);
  rec.latencyMs = res.ms;
  if (res.ok) {
    rec.checkedOk++;
    reportOutcome(rec.id, true, res.ms);
  } else {
    reportOutcome(rec.id, false, res.status);
  }
  return res;
}

export async function checkDue(limit = 15) {
  const state = ensureState();
  const now = Date.now();
  const due = Object.values(state.proxies)
    .filter(r => r.weight > 0 && now - r.lastCheckAt >= CHECK_INTERVAL_MS &&
                 !(isDisabled(r) && r.checkedTotal > 0))
    .sort((a, b) => a.lastCheckAt - b.lastCheckAt)
    .slice(0, limit);
  await Promise.allSettled(due.map(checkProxy));
  return due.length;
}

export function startCheckerLoop() {
  // warm-up shortly after boot, then every 60s pick the next batch to check.
  setTimeout(() => checkDue().catch(err => console.error('[proxy-pool]', err.message)), 8000);
  setInterval(() => {
    checkDue().catch(err => console.error('[proxy-pool]', err.message));
  }, 60 * 1000);
}

/* --------------------------------- snapshots -------------------------------- */

function snapshot(rec) {
  const now = Date.now();
  return {
    id: rec.id,
    endpoint: `${rec.protocol}://${rec.host}:${rec.port}`,
    withAuth: !!rec.username,
    urlMasked: `${rec.protocol}://${rec.host}:${rec.port}` + (rec.username ? '/***:***' : ''),
    protocol: rec.protocol,
    host: rec.host,
    port: rec.port,
    label: rec.label,
    tags: rec.tags,
    weight: rec.weight,
    source: rec.source,
    addedAt: rec.addedAt,
    assignedCount: rec.assignedCount,
    reportedOk: rec.reportedOk,
    reportedFail: rec.reportedFail,
    checkedOk: rec.checkedOk,
    checkedTotal: rec.checkedTotal,
    ewma: +rec.ewma.toFixed(3),
    streak: rec.streak,
    effectiveWeight: +effWeight(rec).toFixed(3),
    active: isActive(rec),
    cooldownRemainingMs: Math.max(0, rec.cooldownUntil - now),
    disabled: isDisabled(rec),
    disabledUntilMs: rec.disabledUntil,
    disabledRemainingS: isDisabled(rec) ? Math.ceil((rec.disabledUntil - now) / 1000) : 0,
    disabledReason: rec.disabledReason,
    lastError: rec.lastError,
    lastCheckAt: rec.lastCheckAt,
    lastCheckStatus: rec.lastCheckStatus,
    latencyMs: rec.latencyMs,
    lastUsedAt: rec.lastUsedAt,
  };
}

export function listProxies() {
  const state = ensureState();
  return Object.values(state.proxies).map(snapshot);
}

export function statsSummary() {
  const list = listProxies();
  return {
    total: list.length,
    active: list.filter(p => p.active && !p.disabled).length,
    coolingDown: list.filter(p => !p.disabled && p.active && p.cooldownRemainingMs > 0).length,
    disabled: list.filter(p => p.disabled).length,
    deadAllTime: list.filter(p => p.checkedTotal > 3 && p.checkedOk === 0 && p.reportedFail > 2).length,
    avgEwma: list.length ? +(list.reduce((s, p) => s + p.ewma, 0) / list.length).toFixed(3) : 0,
    assignedTotal: list.reduce((s, p) => s + p.assignedCount, 0),
    lowestLatency: (() => {
      const ok = list.filter(p => p.latencyMs != null);
      return ok.length ? Math.min(...ok.map(p => p.latencyMs)) : null;
    })(),
  };
}

export function configInfo() {
  return {
    disableHours: DISABLE_HOURS,
    collapseThreshold: COLLAPSE_THRESHOLD,
    collapseWindowMin: COLLAPSE_WINDOW_MS / 60000,
    checkIntervalMin: CHECK_INTERVAL_MS / 60000,
  };
}

export function updateProxy(id, patch) {
  const state = ensureState();
  const rec = state.proxies[id];
  if (!rec) return null;
  if (typeof patch.enabled === 'boolean') {
    if (patch.enabled) return enableProxy(id);
    disableInternal(rec, 'manuel_kapatildi', '');
    markDirty();
  }
  if (typeof patch.label === 'string') rec.label = patch.label.slice(0, 60);
  if (Array.isArray(patch.tags)) rec.tags = patch.tags.map(t => String(t).slice(0, 24)).slice(0, 8);
  if (Number.isFinite(patch.weight)) rec.weight = Math.max(0, Math.min(20, patch.weight));
  return snapshot(rec);
}

export function removeProxy(id) {
  const state = ensureState();
  if (!state.proxies[id]) return false;
  delete state.proxies[id];
  state.order = state.order.filter(x => x !== id);
  markDirty();
  return true;
}
