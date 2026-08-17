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
  masterKey: null,
  adminPassword: null,
  accounts: [],
  modelMap: {
    'claude-sonnet-4-*': 'deepseek/deepseek-v4-flash',
    'claude-haiku-4-*': 'deepseek/deepseek-v4-flash',
    'claude-opus-4-*': 'deepseek/deepseek-v4-flash'
  },
  defaultModel: 'deepseek/deepseek-v4-flash',
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
  sessions: {} // admin session token -> expiry ts (kalıcı login)
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
