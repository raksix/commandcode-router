import { data, getAccountState, markDirty } from './store.js';

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
  return active[idx];
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
  markDirty();
}

/**
 * Havuzdan hesap seçip upstream'e isteği atar.
 * 401/429/5xx'te sıradaki hesaba geçerek maxRetries kez yeniden dener.
 * returns: { status, headers, bodyStream | bodyBuffer, account }
 */
export async function routeRequest({ url, method, headers, body, signal, route }) {
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

    // build headers with this account's key
    const upHeaders = { ...headers };
    upHeaders.authorization = `Bearer ${account.apiKey}`;

    let res;
    try {
      res = await fetch(url, { method, headers: upHeaders, body, signal });
    } catch (err) {
      if (signal?.aborted) throw err; // client left — don't count against account
      record(account, { ok: false, error: err.message, route });
      lastResponse = { status: 502, headers: {}, bodyBuffer: null, errorBody: { type: 'error', error: { type: 'api_error', message: `upstream hatası: ${err.message}` } } };
      continue; // network error -> try next account
    }

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
