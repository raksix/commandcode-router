// Shared model fetching + provider base URLs used by both admin.js (/api/models)
// and proxy.js (/v1/models). Keeping fetchModels() here lets the public /v1/models
// endpoint serve the SAME merged multi-account list the admin panel shows — otherwise
// /v1/models only sampled one account's upstream and opencode-go/zen models never
// appeared (and toggling them in the panel had no effect on the exposed API).
import { data, markDirty, getAccountState } from './store.js';

export const UPSTREAM_BASES = {
  commandcode: 'https://api.commandcode.ai/provider',
  'opencode-go': 'https://api.opencode.ai/zen/go/v1',
  // OpenCode Zen — aynı API key hem /zen/go/v1 hem /zen/v1'e erişir.
  // OpenAI-uyumlu endpoint.
  'opencode-zen': 'https://api.opencode.ai/zen/v1'
};

/** Hesabın upstream base URL'i (provider alanına göre; eski hesaplarda default commandcode). */
export function accountBaseUrl(account) {
  return UPSTREAM_BASES[account?.provider] || UPSTREAM_BASES.commandcode;
}

/**
 * Tüm aktif/banlanmamış hesapların upstream'inden model listesi çek, provider ile birlikte döndür.
 * Aynı model iki provider'da varsa ikisi de ayrı satır olarak döner (id+provider unique anahtar).
 * Sonuç: [{ id, name, context_length, provider, accountName }]
 * Cache tek hesap üzerinden değil, TÜM hesapların birleşik sonucu üzerinden tutulur.
 */
export async function fetchModels() {
  const cache = data.state.modelsCache;
  const now = Date.now();
  const ttl = (data.config.modelsCacheTtlSec ?? 300) * 1000;
  if (cache.data && cache.at && now - cache.at < ttl) {
    try {
      return JSON.parse(cache.data);
    } catch {
      // bozuk cache — aşağıda yeniden çek
    }
  }

  const accounts = (data.config.accounts || []).filter(
    (a) => a.isActive && !getAccountState(a.id).banned
  );

  // Her hesap için çekilecek endpoint listesi. opencode-go hesapları Zen'e de erişebiliyor
  // (aynı API key) — bu yüzden hem Go hem Zen modellerini çekiyoruz, provider etiketiyle ayırıyoruz.
  // opencode-zen hesabı varsa ek Zen çekmiyoruz (duplicate olur).
  const tasks = [];
  for (const acc of accounts) {
    const base = accountBaseUrl(acc).replace(/\/+$/, '');
    const provider = acc.provider || 'commandcode';
    if (provider === 'commandcode') {
      tasks.push({ acc, base, modelsPath: '/v1/models', provider: 'commandcode' });
    } else if (provider === 'opencode-go') {
      tasks.push({ acc, base, modelsPath: '/models', provider: 'opencode-go' });
      // aynı key Zen'e de bağlanır — ek olarak Zen model listesini çek.
      // Zen OpenAI-uyumlu ama base zaten /v1 ile bittiği için models path'i /models olarak yazılmalı
      // (base + /v1/models = /v1/v1/models → 404; base + /models = /v1/models → 200)
      tasks.push({ acc, base: UPSTREAM_BASES['opencode-zen'], modelsPath: '/models', provider: 'opencode-zen' });
    } else if (provider === 'opencode-zen') {
      tasks.push({ acc, base, modelsPath: '/models', provider: 'opencode-zen' });
    }
  }

  const results = await Promise.all(tasks.map(async ({ acc, base, modelsPath, provider }) => {
    try {
      const up = await fetch(base + modelsPath, {
        headers: { authorization: `Bearer ${acc.apiKey}` }
      });
      if (!up.ok) return [];
      const text = await up.text();
      const j = JSON.parse(text);
      const list = j.data ?? j.models ?? [];
      return list.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length ?? null,
        provider,
        accountName: acc.name
      }));
    } catch {
      return [];
    }
  }));
  // aynı (id, provider) tekrarını at (birden fazla hesap aynı provider'dan çekmiş olabilir)
  const seen = new Set();
  const merged = [];
  for (const m of results.flat()) {
    const key = `${m.provider}::${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(m);
  }
  // id alfabetik sırayla (UI kararlı)
  merged.sort((a, b) => a.id.localeCompare(b.id));
  cache.data = JSON.stringify(merged);
  cache.at = now;
  markDirty();
  return merged;
}
