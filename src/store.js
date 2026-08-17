import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const STATE_PATH = path.join(ROOT_DIR, 'state.json');

const DEFAULT_CONFIG = {
  port: 3000,
  masterKey: null,          // legacy: tek key (migrasyon için korunur)
  masterKeys: [],           // çoklu key: [{ id, name, key, createdAt, lastUsedAt }]
  adminPassword: null,
  accounts: [],
  // /v1/models API'sinde sunulacak modeller. Boşsa = CommandCode'daki TÜM modeller döner.
  // Doluysa sadece bu listedekiler (Claude Code'a gösterilen model adları).
  exposedModels: [],
  retry: { maxRetries: 2, banAfter: 5 },
  modelsCacheTtlSec: 300
};

const DEFAULT_STATE = {
  roundRobinIndex: 0,
  accounts: {},
  stats: { totalRequests: 0, success: 0, errors: 0, byRoute: {} },
  modelsCache: { data: null, at: null },
  sessions: {}, // admin session token -> expiry ts (kalıcı login)
  logs: [],     // son istek logları (max 300)
  daily: {},    // günlük istatistik: 'YYYY-MM-DD' -> { total, success, errors, inputTokens, outputTokens }
  ccauth: {},   // CommandCode CLI auth: sha256(state) -> { status, apiKey, metadata, createdAt, expiresAt, appliedAt }
};

/** @type {{ config: object, state: object }} */
export const data = { config: null, state: null };

function genSecret(prefix) {
  return prefix + crypto.randomBytes(16).toString('hex');
}

export async function load() {
  // config.json
  try {
    data.config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    // First run: generate fresh secrets, log them once
    data.config = structuredClone(DEFAULT_CONFIG);
    data.config.masterKey = genSecret('mk_');
    data.config.adminPassword = genSecret('ap_');
    await saveConfig();
    console.log('\n=== İLK KURULUM ===');
    console.log(`Master API Key: ${data.config.masterKey}`);
    console.log(`Admin şifresi:  ${data.config.adminPassword}`);
    console.log('Bu değerleri bir yere kaydet! (config.json içinde de duruyor)\n');
  }
  // merge defaults so new fields don't break old configs
  data.config = { ...structuredClone(DEFAULT_CONFIG), ...data.config };

  // --- migration: legacy tek masterKey -> masterKeys array ---
  if (!Array.isArray(data.config.masterKeys) || data.config.masterKeys.length === 0) {
    if (data.config.masterKey) {
      data.config.masterKeys = [{
        id: crypto.randomUUID(),
        name: 'Anahtar 1',
        key: data.config.masterKey,
        createdAt: Date.now(),
        lastUsedAt: null
      }];
      await saveConfig();
      console.log('[store] Legacy masterKey → masterKeys dizisine taşındı.');
    } else {
      data.config.masterKeys = [];
    }
  }

  // state.json (optional — regenerated silently)
  try {
    data.state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    data.state = structuredClone(DEFAULT_STATE);
  }
  data.state = { ...structuredClone(DEFAULT_STATE), ...data.state };
}

// ---- debounced persistence ----
let dirty = false;
let saveTimer = null;

function saveConfig() {
  return fs.writeFile(CONFIG_PATH, JSON.stringify(data.config, null, 2), 'utf8');
}

export function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await saveConfig();
      await fs.writeFile(STATE_PATH, JSON.stringify(data.state, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] kayıt hatası:', err.message);
    }
  }, 2000);
}

export async function flushNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (dirty) { dirty = false; }
  await saveConfig();
  await fs.writeFile(STATE_PATH, JSON.stringify(data.state, null, 2), 'utf8');
}

export function getAccountState(id) {
  if (!data.state.accounts[id]) {
    data.state.accounts[id] = {
      totalRequests: 0, consecutiveErrors: 0, lastUsedAt: null, lastError: null, banned: false
    };
  }
  return data.state.accounts[id];
}
