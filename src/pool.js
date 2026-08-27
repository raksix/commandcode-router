import { data, getAccountState, markDirty } from './store.js';
import { UPSTREAM_BASES, accountBaseUrl } from './models.js';
import { outboundDispatcher, getOutboundProxy, reportOutcome } from './proxy-pool.js';

/**
 * Round-robin: aktif ve banlanmamış hesaplar arasında sırayla seç.
 * state.roundRobinIndex state.json'da kalır -> restart'ta sıra devam eder.
 */
export function pickAccount() {
  const active = (data.config.accounts || []).filter(
    (a) => a.isActive && !getAccountState(a.id).banned
  );
  if (!active.length) return null;
  const idx = data.state.roundRobinIndex % active.length;
  data.state.roundRobinIndex = (idx + 1) % active.length;
  markDirty();
  const acc = active[idx];
  // Config'deki upstreamBase korunur; hesapta yoksa provider default'una düş.
  if (!acc.upstreamBase) acc.upstreamBase = accountBaseUrl(acc);
  return acc;
}

function record(account, { ok, error, status, route }) {
  const st = getAccountState(account.id);
  data.state.stats.totalRequests++;
  data.state.stats.byRoute[route] = (data.state.stats.byRoute[route] || 0) + 1;
  if (ok) {
    data.state.stats.success++;
    st.totalRequests++;
    st.consecutiveErrors = 0;
    st.lastUsedAt = Date.now();
    st.banned = false;
    st.lastError = null;
  } else {
    data.state.stats.errors++;
    st.consecutiveErrors++;
    st.lastError = error || `HTTP ${status}`;
    if (st.consecutiveErrors >= data.config.retry.banAfter) {
      st.banned = true;
    }
  }
  // günlük istatistik
  const day = new Date().toISOString().slice(0, 10);
  if (!data.state.daily[day]) data.state.daily[day] = { total: 0, success: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  data.state.daily[day].total++;
  if (ok) data.state.daily[day].success++; else data.state.daily[day].errors++;
  markDirty();
}

/** Son istek loglarını tut (max 300). Log objesini döndürür — sonradan token eklenebilir. */
export function addLog(entry) {
  const log = {
    ts: Date.now(),
    method: entry.method,
    route: entry.route,
    model: entry.model || null,
    mappedTo: entry.mappedTo || null,
    account: entry.account,
    status: entry.status,
    ok: entry.ok,
    ms: entry.ms,
    detail: entry.detail || null,
    inputTokens: entry.inputTokens ?? null,
    outputTokens: entry.outputTokens ?? null,
    clientStream: entry.clientStream ?? null,
    clientAccept: entry.clientAccept ?? null,
    streamFlag: entry.streamFlag ?? null
  };
  data.state.logs.push(log);
  if (data.state.logs.length > 300) {
    data.state.logs.splice(0, data.state.logs.length - 300);
  }
  markDirty();
  return log;
}

/** Günlük token istatistiklerine ekle (grafikte gösterilir) */
export function recordTokens({ inputTokens = 0, outputTokens = 0 } = {}) {
  if (!inputTokens && !outputTokens) return;
  const day = new Date().toISOString().slice(0, 10);
  if (!data.state.daily[day]) {
    data.state.daily[day] = { total: 0, success: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  }
  data.state.daily[day].inputTokens = (data.state.daily[day].inputTokens || 0) + inputTokens;
  data.state.daily[day].outputTokens = (data.state.daily[day].outputTokens || 0) + outputTokens;
  markDirty();
}

/**
 * Havuzdan hesap seçip upstream'e isteği atar.
 * 401/429/5xx'te sıradaki hesaba geçerek maxRetries kez yeniden dener.
 * returns: { status, headers, bodyStream | bodyBuffer, account }
 */
export async function routeRequest({ url, method, headers, body, signal, route, baseUrl }) {
  const cfg = data.config;
  const maxRetries = cfg.retry?.maxRetries ?? 2;

  let lastResponse = null;
  let attempts = 0;

  while (attempts <= maxRetries) {
    attempts++;
    const account = pickAccount();
    if (!account) {
      return {
        status: 503,
        body: {
          type: 'error',
          error: { type: 'overloaded_error', message: 'aktif hesap yok (hepsi banlı/pasif)' }
        },
        account: null
      };
    }

    // Hesabın provider'ına göre base URL seç.
    // url'deki host tamamen atılır; sadece path + query alınıp hesap base'ine eklenir.
    // (url: https://api.commandcode.ai/provider/v1/chat/completions?x=1 -> path: /v1/chat/completions?x=1)
    const accBase = (baseUrl || account.upstreamBase || 'https://api.commandcode.ai/provider').replace(/\/+$/, '');
    let finalUrl;
    try {
      // url path-only olabilir (/v1/chat/completions) — o zaman base ile parse et
      let pathPart;
      if (/^https?:\/\//i.test(url)) {
        const u = new URL(url);
        pathPart = u.pathname + u.search;
      } else {
        pathPart = url;
      }
      // url path'i, accBase'in path'iyle başlıyorsa kırp (commandcode: /provider)
      const basePath = new URL(accBase).pathname.replace(/\/+$/, '');
      if (basePath && pathPart.startsWith(basePath)) {
        pathPart = pathPart.slice(basePath.length) || '/';
      }
      // opencode-go base'i /v1 ile bitiyor, path de /v1/... ile başlıyorsa çiftlenir
      if (/\/v1\/?$/.test(accBase) && pathPart.startsWith('/v1/')) {
        pathPart = pathPart.slice(3) || '/';
      }
      finalUrl = accBase + pathPart;
    } catch {
      finalUrl = accBase + (url.startsWith('/') ? url : '/' + url);
    }

    // build headers with this account's key
    const upHeaders = { ...headers };
    upHeaders.authorization = `Bearer ${account.apiKey}`;

    // opencode-go ve opencode-zen, model adlarında provider prefix'i kabul etmez:
    // 'deepseek/deepseek-v4-flash' -> 'deepseek-v4-flash' (slash sonrası).
    // CommandCode /provider ise slash'lı adları kabul eder (test: 200 veriyor).
    // Alpha yolu pool.js'i atladığı için bu sadece provider yolunu etkiler.
    let bodyForUpstream = body;
    const slashProviders = new Set(['opencode-go', 'opencode-zen']);
    if (slashProviders.has(account.provider) && typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        if (parsed?.model && typeof parsed.model === 'string') {
          const slashIdx = parsed.model.lastIndexOf('/');
          if (slashIdx > 0) parsed.model = parsed.model.slice(slashIdx + 1);
          bodyForUpstream = JSON.stringify(parsed);
        }
      } catch { /* body JSON değilse dokunma */ }
    }
    // AĞU'26: hesabın upstreamBase'i OmniRoute'a yönlendirilmişse model adına provider
    // prefix'i (örn. "command-code/") ekle. OmniRoute'un command-code sağlayıcısı
    // prefix'siz model adını kabul etmiyor ("No active credentials for provider: deepseek").
    // Ayrıca kısa model adlarını OmniRoute'un beklediği tam adlara map et.
    // Alias değerinde "/" varsa zaten provider prefix'i içeriyor — olduğu gibi kullan,
    // yoksa command-code/ ön eki ekle. Bazı modeller (claude-haiku-4-5) CommandCode
    // Go plan'ında yok (MODEL_NOT_IN_PLAN) -> başka provider'a düşür (claude-web).
    const CC_MODEL_ALIASES = {
      'claude-opus-5': 'command-code/claude-opus-4-7',
      'claude-sonnet-5': 'command-code/claude-sonnet-4-6',
      'gpt-5.6-luna': 'command-code/gpt-5.6-luna',
      'deepseek-v4-flash': 'command-code/deepseek/deepseek-v4-flash',
      'mimo-v2.5': 'command-code/xiaomi/mimo-v2.5',
      // claude-haiku CommandCode'da Pro+ plan gerektiriyor — claude-web'e düşür (ücretsiz).
      'claude-haiku-4-5-20251001': 'claude-web/claude-haiku-4-5-20251001',
      'claude-haiku-4-5': 'claude-web/claude-haiku-4-5-20251001'
    };
    if (typeof bodyForUpstream === 'string' && account.upstreamBase && /omniroute/i.test(account.upstreamBase)) {
      try {
        const parsed = JSON.parse(bodyForUpstream);
        const m = parsed?.model;
        if (typeof m === 'string' && m) {
          // (1) Eğer alias map'te varsa direkt onu kullan
          if (CC_MODEL_ALIASES[m]) {
            parsed.model = CC_MODEL_ALIASES[m];
          } else if (!/^[a-z0-9-]+\//.test(m)) {
            // (2) zaten bir provider prefix'i (örn "command-code/") varsa dokunma
            // (3) aksi halde command-code/ ön eki ekle
            parsed.model = 'command-code/' + m;
          }
          bodyForUpstream = JSON.stringify(parsed);
        }
      } catch { /* body JSON değilse dokunma */ }
    }

    // Outbound trafik proxy havuzundan geçer (havuz boşsa düz fetch).
    // Her hesap denemesinde YENİ proxy seçilir (proxy + hesap bağımsız döner).
    const proxyInfo = getOutboundProxy();
    const dispatcher = proxyInfo ? proxyInfo.agent : undefined;
    let res;
    try {
      res = await fetch(finalUrl, { method, headers: upHeaders, body: bodyForUpstream, signal, dispatcher });
    } catch (err) {
      if (signal?.aborted) throw err; // client left — don't count against account
      if (proxyInfo) reportOutcome(proxyInfo.rec.id, false, err.message);
      record(account, { ok: false, error: err.message, route });
      lastResponse = { status: 502, headers: {}, bodyBuffer: null, errorBody: { type: 'error', error: { type: 'api_error', message: `upstream hatası: ${err.message}` } } };
      continue; // network error -> try next account
    }
    if (proxyInfo) reportOutcome(proxyInfo.rec.id, res.status >= 200 && res.status < 300, `HTTP ${res.status}`);

    const is2xx = res.status >= 200 && res.status < 300;
    const retryable = res.status === 401 || res.status === 429 || res.status >= 500;
    // 403 (permission/plan) = hesap kaynaklı kalıcı hata: retry edilmez ama hata sayılır (ban mantığı devreye girer)
    const accountFailure = res.status === 403;

    if (is2xx) {
      record(account, { ok: true, status: res.status, route });
      return { status: res.status, headers: res.headers, bodyStream: res.body, account };
    }

    // read error body (small) so we can clean up
    let errorBodyText = '';
    try { errorBodyText = await res.text(); } catch {}
    const errSummary = `HTTP ${res.status}: ${errorBodyText.slice(0, 200)}`;

    if (accountFailure) {
      record(account, { ok: false, status: res.status, error: errSummary, route });
      return {
        status: res.status,
        headers: res.headers,
        bodyBuffer: errorBodyText,
        account
      };
    }

    if (!retryable) {
      // client error (400/404/422...) — not the account's fault, pass through as-is
      record(account, { ok: true, status: res.status, route });
      return { status: res.status, headers: res.headers, bodyStream: res.body, account };
    }

    record(account, { ok: false, status: res.status, error: errSummary, route });
    lastResponse = { status: res.status, headers: res.headers, bodyBuffer: errorBodyText, account };
    // loop -> next account
  }

  // out of retries — return last error response
  return {
    status: lastResponse.status,
    headers: lastResponse.headers,
    bodyBuffer: lastResponse.bodyBuffer,
    account: lastResponse.account
  };
}
