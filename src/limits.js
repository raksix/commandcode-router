// Upstream quota/limit fetching per account (Eyl'26).
//
// CommandCode hesapları CLI'nın kullandığı alpha endpoint'lerinden canlı
// limit okur (aynı API key, ekstra auth gerekmez):
//   GET https://api.commandcode.ai/alpha/billing/credits       -> kalan kredi + 5h/weekly pencereler
//   GET https://api.commandcode.ai/alpha/billing/subscriptions -> planId + fatura dönemi
//   GET https://api.commandcode.ai/alpha/usage/summary         -> dönemlik harcama/istek/token
// OpenCode Go hesapları:
//   GET https://api.opencode.ai/zen/go/v1/usage -> rolling/monthly yüzdeler
//
// Cloudflare 1010 (python-urllib UA ban) tuzağı: Node fetch default UA ile
// geçiyor; yine de tarayıcı UA gönderiyoruz (güvenli taraf).
// Sonuçlar hesap başına 5dk cache'lenir (state.json'a yazılmaz, memory-only).

const CC_BASE = 'https://api.commandcode.ai';
const GO_USAGE_URL = 'https://api.opencode.ai/zen/go/v1/usage';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CACHE_TTL_MS = 5 * 60 * 1000;

// Plan kataloğu: planId -> aylık kredi havuzu ($). Cap'ler telden doğrulanır
// (5h/weekly cap upstream'den gelir; monthly total katalogdan).
const PLAN_MONTHLY = {
  'individual-go': 10,
  go: 10,
  'individual-goat': 70,
  goat: 70,
  'individual-pro': 80,
  pro: 80,
  'max-10x': 150,
  'max10x': 150,
  'max-20x': 300,
  'max20x': 300,
  'team-pro': 40,
};

const cache = new Map(); // accountId -> { at, data }

async function getJson(url, apiKey, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': BROWSER_UA,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { __httpError: true, status: res.status, body: body.slice(0, 200) };
    }
    return await res.json();
  } catch (err) {
    return { __netError: true, message: err.message };
  } finally {
    clearTimeout(t);
  }
}

function isErr(v) {
  return !v || v.__httpError || v.__netError;
}

async function fetchCommandCodeLimits(account) {
  const [credits, sub, summary] = await Promise.all([
    getJson(`${CC_BASE}/alpha/billing/credits`, account.apiKey),
    getJson(`${CC_BASE}/alpha/billing/subscriptions`, account.apiKey),
    getJson(`${CC_BASE}/alpha/usage/summary`, account.apiKey),
  ]);

  if (isErr(credits)) {
    return {
      ok: false,
      provider: 'commandcode',
      error: credits?.__httpError ? `upstream HTTP ${credits.status}` : (credits?.message || 'bağlantı hatası'),
      at: Date.now(),
    };
  }

  const c = credits.credits || {};
  const w = credits.windowLimits || {};
  const five = w.fiveHour || {};
  const weekly = w.weekly || {};
  const s = (!isErr(sub) && sub.data) || {};
  const planId = s.planId || null;
  const monthlyTotal = (planId && PLAN_MONTHLY[planId]) || null;
  const monthlyRemaining = typeof c.monthlyCredits === 'number' ? c.monthlyCredits : null;
  const u = isErr(summary) ? null : summary;

  return {
    ok: true,
    provider: 'commandcode',
    at: Date.now(),
    planId,
    planStatus: s.status || null,
    periodStart: s.currentPeriodStart || null,
    periodEnd: s.currentPeriodEnd || null,
    monthly: monthlyTotal != null && monthlyRemaining != null
      ? { used: round2(monthlyTotal - monthlyRemaining), total: monthlyTotal, remaining: round2(monthlyRemaining) }
      : { used: null, total: monthlyTotal, remaining: monthlyRemaining != null ? round2(monthlyRemaining) : null },
    purchased: typeof c.purchasedCredits === 'number' ? c.purchasedCredits : null,
    free: typeof c.freeCredits === 'number' ? c.freeCredits : null,
    fiveHour: {
      used: numOrNull(five.used),
      cap: numOrNull(five.cap),
      exceeded: !!five.exceeded,
      resetAt: five.resetAt || null,
    },
    weekly: {
      used: numOrNull(weekly.used),
      cap: numOrNull(weekly.cap),
      exceeded: !!weekly.exceeded,
      resetAt: weekly.resetAt || null,
    },
    periodUsage: u ? {
      cost: numOrNull(u.totalCost),
      requests: numOrNull(u.totalCount),
      tokensIn: numOrNull(u.totalTokensIn),
      tokensOut: numOrNull(u.totalTokensOut),
      successRate: numOrNull(u.successRate),
    } : null,
  };
}

async function fetchGoLimits(account) {
  const j = await getJson(GO_USAGE_URL, account.apiKey);
  if (isErr(j)) {
    return {
      ok: false,
      provider: 'opencode-go',
      error: j?.__httpError ? `upstream HTTP ${j.status}` : (j?.message || 'bağlantı hatası'),
      at: Date.now(),
    };
  }
  // Şema: { rolling: {percent, resetAt...}, monthly: {...} } — toleranslı parse
  const pick = (o) => {
    if (!o || typeof o !== 'object') return { used: null, cap: null, resetAt: null };
    const pct = typeof o.percent === 'number' ? o.percent
      : (typeof o.used === 'number' && typeof o.cap === 'number' && o.cap ? (o.used / o.cap) * 100 : null);
    return {
      used: numOrNull(o.used),
      cap: numOrNull(o.limit ?? o.cap),
      percent: pct != null ? Math.round(pct * 10) / 10 : null,
      exceeded: !!o.exceeded,
      resetAt: o.resetAt || o.resetsAt || null,
    };
  };
  return {
    ok: true,
    provider: 'opencode-go',
    at: Date.now(),
    fiveHour: pick(j.rolling ?? j.fiveHour),
    weekly: pick(j.weekly),
    monthly: { used: numOrNull(j.monthly?.used), total: numOrNull(j.monthly?.limit ?? j.monthly?.cap), remaining: null },
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Tüm hesapların limitlerini döndür (cache'li). force=true cache'i atlar. */
export async function getAllLimits(accounts, { force = false } = {}) {
  const out = {};
  await Promise.all((accounts || []).map(async (acc) => {
    const cached = cache.get(acc.id);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      out[acc.id] = cached.data;
      return;
    }
    const provider = acc.provider || 'commandcode';
    let data;
    try {
      data = provider === 'opencode-go' || provider === 'opencode-zen'
        ? await fetchGoLimits(acc)
        : await fetchCommandCodeLimits(acc);
    } catch (err) {
      data = { ok: false, provider, error: err.message, at: Date.now() };
    }
    cache.set(acc.id, { at: Date.now(), data });
    out[acc.id] = data;
  }));
  return out;
}

/** Tek hesabın cache'ini düşür (hesap silinince). */
export function dropLimitCache(accountId) {
  cache.delete(accountId);
}
