// ---- helpers ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    cache: 'no-store', // tarayıcı cache'ini kapat — hep taze veri
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '***';
  return k.slice(0, 4) + '…' + k.slice(-4);
}

// ---- auth flow ----
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#login-password').value;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#login-error').classList.add('hidden');
    showDashboard();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
});

async function showDashboard() {
  $('#login-screen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  await loadModels();
  await refresh();
  setInterval(refresh, 10000); // auto-refresh stats every 10s
}

// ---- CommandCode model list (for dropdowns + full list) ----
let ccModels = [];
let ccModelDetails = [];
async function loadModels() {
  try {
    const r = await api('/api/models');
    ccModelDetails = r.models || [];
    ccModels = ccModelDetails.map((m) => m.id);
    renderModelList();
  } catch {
    ccModels = [];
    ccModelDetails = [];
  }
}

// full model listesi kartı
function renderModelList() {
  const el = $('#model-list');
  if (!ccModelDetails.length) {
    el.innerHTML = '<span class="hint">Model listesi yüklenemedi. Hesap planı Provider değilse API erişimi engellenir.</span>';
    return;
  }
  el.innerHTML = ccModelDetails.map((m) => {
    const ctx = m.context_length ? `<span class="ctx">${(m.context_length / 1000).toLocaleString('tr-TR')}k ctx</span>` : '';
    return `<span class="model-chip" title="${esc(m.name || '')}">${esc(m.id)}${ctx}</span>`;
  }).join('');
}

// ---- API'de sunulan modeller (exposedModels) ----
let exposedSelection = new Set();
function renderExposedList() {
  const el = $('#exposed-list');
  if (!ccModelDetails.length) {
    el.innerHTML = '<span class="hint">Önce model listesi yüklensin (yukarıdaki Yenile).</span>';
    return;
  }
  el.innerHTML = ccModelDetails.map((m) => {
    const on = exposedSelection.has(m.id);
    return `<span class="model-chip ${on ? 'chip-on' : ''}" data-id="${esc(m.id)}" title="Tıkla: ${on ? 'kaldır' : 'seç'}">${esc(m.id)}${on ? ' ✓' : ''}</span>`;
  }).join('');
  el.querySelectorAll('.model-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.id;
      if (exposedSelection.has(id)) exposedSelection.delete(id);
      else exposedSelection.add(id);
      renderExposedList();
    });
  });
}
function modelOptions(selected) {
  if (!ccModels.length) {
    return `<input id="map-val" class="mono" value="${esc(selected || '')}" />`;
  }
  const opts = ccModels.map((id) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(id)}</option>`).join('');
  return `<select class="map-val-select mono">${opts}</select>`;
}

// ---- render ----
async function refresh() {
  let status;
  try {
    status = await api('/api/status');
  } catch {
    // session expired
    $('#dashboard').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    return;
  }

  // stats strip
  $('#stat-total').textContent = status.stats.totalRequests;
  $('#stat-success').textContent = status.stats.success;
  $('#stat-errors').textContent = status.stats.errors;
  $('#stat-active').textContent = status.accounts.filter(a => a.isActive && !a.banned).length;
  $('#stat-banned').textContent = status.accounts.filter(a => a.banned).length;
  $('#rr-index').textContent = `Sıra: ${status.roundRobinIndex}`;

  // master key
  const mk = $('#master-key');
  if (!mk.dataset.full) {
    mk.value = status.masterKeyMasked;
    mk.dataset.full = status.masterKeyMasked;
  }

  // accounts
  renderAccounts(status.accounts);
  renderModelMap(status.modelMap, status.defaultModel);

  // istatistik + loglar
  renderDaily(status.daily);
  renderLogs(status.logs);

  // exposed models (only reset selection if status.exposedModels changed)
  if (status.exposedModels) {
    const next = new Set(status.exposedModels);
    const same = next.size === exposedSelection.size && [...next].every((x) => exposedSelection.has(x));
    if (!same) {
      exposedSelection = next;
      renderExposedList();
    }
  }
}

function renderAccounts(accounts) {
  const tbody = $('#accounts-body');
  tbody.innerHTML = '';
  for (const a of accounts) {
    const tr = document.createElement('tr');

    const statusBadge = a.banned
      ? '<span class="badge badge-ban">🚫 Banlı</span>'
      : a.isActive
        ? '<span class="badge badge-ok">Aktif</span>'
        : '<span class="badge badge-off">Pasif</span>';

    tr.innerHTML = `
      <td><span class="acc-name">${esc(a.name)}</span></td>
      <td class="key-cell">
        <span class="key-val">${maskKey(a.apiKeyMasked)}</span>
        <button class="eye-btn" title="Tam keyi gör">👁</button>
      </td>
      <td>${statusBadge}${a.banned ? `<div class="hint">${esc(a.lastError || '')}</div>` : ''}</td>
      <td>${a.totalRequests}</td>
      <td class="${a.consecutiveErrors > 0 ? 'stat-val red' : ''}" style="font-size:14px">${a.consecutiveErrors}</td>
      <td>${fmtTime(a.lastUsedAt)}</td>
      <td>
        <div class="action-row">
          <button class="btn btn-small test-btn">Test</button>
          ${a.banned ? '<button class="btn btn-small unban-btn">Ban kaldır</button>' : `<button class="btn btn-small toggle-btn">${a.isActive ? 'Pasifleştir' : 'Aktifleştir'}</button>`}
          <button class="btn btn-small btn-danger del-btn">Sil</button>
        </div>
      </td>
    `;

    // eye button -> reveal full key
    const eye = tr.querySelector('.eye-btn');
    eye.addEventListener('click', async () => {
      const full = await api(`/api/accounts/${a.id}/reveal`).catch(() => null);
      if (full?.apiKey) {
        const v = tr.querySelector('.key-val');
        v.textContent = full.apiKey;
        eye.textContent = '🙈';
        setTimeout(() => { v.textContent = maskKey(a.apiKeyMasked); eye.textContent = '👁'; }, 8000);
      }
    });

    tr.querySelector('.test-btn').addEventListener('click', async () => {
      toast(`"${a.name}" test ediliyor...`);
      const r = await api(`/api/accounts/${a.id}/test`, { method: 'POST' });
      toast(r.ok
        ? `✅ "${a.name}" çalışıyor (${r.ms}ms, ${r.modelsCount ?? '?'} model)`
        : `❌ ${a.name}: HTTP ${r.status} — ${r.detail || ''}`.slice(0, 90),
        r.ok ? 'ok' : 'err');
    });

    const unban = tr.querySelector('.unban-btn');
    if (unban) unban.addEventListener('click', async () => {
      await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: JSON.stringify({ resetBan: true }) });
      toast('Ban kaldırıldı');
      refresh();
    });

    const toggle = tr.querySelector('.toggle-btn');
    if (toggle) toggle.addEventListener('click', async () => {
      await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !a.isActive }) });
      refresh();
    });

    tr.querySelector('.del-btn').addEventListener('click', async () => {
      if (!confirm(`"${a.name}" silinsin mi?`)) return;
      await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
      toast('Hesap silindi');
      refresh();
    });

    tbody.appendChild(tr);
  }
}

function renderModelMap(modelMap, defaultModel) {
  $('#default-model').value = defaultModel || '';
  const tbody = $('#modelmap-body');
  tbody.innerHTML = '';
  for (const [k, v] of Object.entries(modelMap)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${esc(k)}</td>
      <td>${modelOptions(v)}</td>
      <td style="text-align:right"><button class="btn btn-small btn-danger del-map">Sil</button></td>
    `;
    // dropdown change -> save immediately
    const sel = tr.querySelector('.map-val-select');
    if (sel) {
      sel.addEventListener('change', async () => {
        try {
          await api('/api/model-map', { method: 'POST', body: JSON.stringify({ key: k, value: sel.value }) });
          toast(`Eşleme güncellendi: ${k} → ${sel.value}`);
        } catch (err) { toast(err.message, 'err'); }
      });
    }
    tr.querySelector('.del-map').addEventListener('click', async () => {
      await api(`/api/model-map/${encodeURIComponent(k)}`, { method: 'DELETE' });
      refresh();
    });
    tbody.appendChild(tr);
  }
}

// ---- istatistik (günlük) ----
function renderDaily(daily) {
  const today = new Date().toISOString().slice(0, 10);
  const d = daily?.[today] || { total: 0, success: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  $('#daily-total').textContent = d.total;
  $('#daily-success').textContent = d.success;
  $('#daily-errors').textContent = d.errors;
  $('#daily-rate').textContent = d.total ? `%${Math.round((d.success / d.total) * 100)}` : '%0';
  $('#daily-input').textContent = fmtNum(d.inputTokens || 0);
  $('#daily-output').textContent = fmtNum(d.outputTokens || 0);
  $('#daily-tokens').textContent = fmtNum((d.inputTokens || 0) + (d.outputTokens || 0));

  // mini bar chart: son 14 gün
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: dt, ...(daily?.[dt] || { total: 0, success: 0, errors: 0, inputTokens: 0, outputTokens: 0 }) });
  }
  const max = Math.max(...days.map((d2) => d2.total), 1);
  const chart = $('#daily-chart');
  chart.innerHTML = days.map((d2) => `
    <div class="bar-col" title="${d2.day}: ${d2.total} istek (${d2.success} başarılı, ${d2.errors} hata)">
      <div class="bar-wrap">
        <div class="bar bar-ok" style="height:${Math.round((d2.success / max) * 100)}%"></div>
        <div class="bar bar-err" style="height:${Math.round((d2.errors / max) * 100)}%"></div>
      </div>
      <div class="bar-lbl">${d2.day.slice(5)}</div>
    </div>`).join('');
  $('#daily-chart-hint').textContent = `Son 14 gün — yeşil başarılı, kırmızı hata.`;

  // token grafiği: mavi = girdi, turuncu = çıktı (son 14 gün)
  const maxTok = Math.max(...days.map((d2) => Math.max(d2.inputTokens || 0, d2.outputTokens || 0)), 1);
  const tchart = $('#token-chart');
  tchart.innerHTML = days.map((d2) => `
    <div class="bar-col" title="${d2.day}: ⬇ ${fmtNum(d2.inputTokens || 0)} / ⬆ ${fmtNum(d2.outputTokens || 0)} token">
      <div class="bar-wrap">
        <div class="bar bar-in" style="height:${Math.round(((d2.inputTokens || 0) / maxTok) * 100)}%"></div>
        <div class="bar bar-out" style="height:${Math.round(((d2.outputTokens || 0) / maxTok) * 100)}%"></div>
      </div>
      <div class="bar-lbl">${d2.day.slice(5)}</div>
    </div>`).join('');
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('tr-TR');
}

// ---- istek logları ----
function renderLogs(logs) {
  const tbody = $('#logs-body');
  tbody.innerHTML = '';
  if (!logs || !logs.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="hint" style="text-align:center">Henüz istek yok</td></tr>';
    return;
  }
  for (const l of logs.slice().reverse()) {
    const tr = document.createElement('tr');
    const bad = l.status >= 400;
    const hasTokens = l.inputTokens != null || l.outputTokens != null;
    tr.innerHTML = `
      <td class="mono small">${fmtTime(l.ts)}</td>
      <td class="small">${esc(l.method || '')}</td>
      <td class="mono small">${esc(l.route || '')}</td>
      <td class="mono small">${esc(l.model || '—')}${l.mappedTo ? `<div class="hint">← ${esc(l.mappedTo)}</div>` : ''}</td>
      <td class="small">${esc(l.account || '—')}</td>
      <td class="small"><span class="status-chip ${bad ? 'st-err' : 'st-ok'}">${l.status}</span></td>
      <td class="small">${l.ms}ms</td>
      <td class="mono small token-chip">${hasTokens ? `${fmtNum(l.inputTokens || 0)}/⬆${fmtNum(l.outputTokens || 0)}` : '—'}</td>
      <td class="mono small hint">${esc(l.detail || '')}</td>
    `;
    tbody.appendChild(tr);
  }
}

$('#logs-clear-btn').addEventListener('click', async () => {
  await api('/api/logs', { method: 'DELETE' });
  toast('Loglar temizlendi');
  refresh();
});

// ---- add account ----
$('#add-account-toggle').addEventListener('click', () => {
  $('#add-account-form').classList.toggle('hidden');
});

$('#add-account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#acc-name').value.trim();
  const apiKey = $('#acc-key').value.trim();
  if (!name || !apiKey) return;
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name, apiKey }) });
    $('#acc-name').value = '';
    $('#acc-key').value = '';
    $('#add-account-form').classList.add('hidden');
    toast('Hesap eklendi ✅');
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

// ---- model map ----
$('#auto-map-btn').addEventListener('click', async () => {
  $('#auto-map-btn').disabled = true;
  $('#auto-map-btn').textContent = 'Eşleniyor...';
  try {
    const r = await api('/api/model-map/auto', { method: 'POST' });
    await loadModels();
    toast(`Otomatik eşleme tamam: Sonnet=${r.found.sonnet || '—'}, Opus=${r.found.opus || '—'}, Haiku=${r.found.haiku || '—'}, Fable=${r.found.fable || '—'}`);
    refresh();
  } catch (err) { toast(err.message, 'err'); }
  $('#auto-map-btn').disabled = false;
  $('#auto-map-btn').textContent = '⚡ Otomatik Eşle';
});

$('#refresh-models-btn').addEventListener('click', async () => {
  $('#refresh-models-btn').disabled = true;
  await loadModels();
  renderExposedList();
  toast(`Model listesi güncellendi (${ccModels.length} model)`);
  $('#refresh-models-btn').disabled = false;
});

// exposed models: kaydet / tümünü göster
$('#expose-save-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/exposed-models', { method: 'POST', body: JSON.stringify({ models: [...exposedSelection] }) });
    toast(r.exposedModels.length ? `API'de ${r.exposedModels.length} model sunuluyor` : 'Tüm modeller sunuluyor (filtre yok)');
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

$('#expose-all-btn').addEventListener('click', async () => {
  exposedSelection = new Set(ccModels);
  renderExposedList();
  try {
    await api('/api/exposed-models', { method: 'POST', body: JSON.stringify({ models: [...exposedSelection] }) });
    toast('Tüm modeller API\'de sunuluyor');
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

$('#add-map-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('#map-key').value.trim();
  const val = $('#map-val').value.trim();
  if (!key || !val) return;
  try {
    await api('/api/model-map', { method: 'POST', body: JSON.stringify({ key, value: val }) });
    $('#map-key').value = '';
    $('#map-val').value = '';
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

$('#default-model').addEventListener('change', async (e) => {
  const model = e.target.value.trim();
  if (!model) return;
  try {
    await api('/api/model-map/default', { method: 'POST', body: JSON.stringify({ model }) });
    toast('Varsayılan model güncellendi');
  } catch (err) { toast(err.message, 'err'); }
});

// ---- master key actions ----
$('#copy-key').addEventListener('click', () => {
  const mk = $('#master-key');
  if (mk.dataset.full) {
    navigator.clipboard.writeText(mk.dataset.full).then(() => toast('Kopyalandı 📋'));
  }
});

$('#regen-key').addEventListener('click', async () => {
  if (!confirm('Master key yenilensin mi? Eski key ile bağlı tüm istemciler bağlantısını kaybeder.')) return;
  const r = await api('/api/master-key', { method: 'POST' });
  $('#master-key').value = r.masterKey;
  $('#master-key').dataset.full = r.masterKey;
  const hint = $('#new-key-hint');
  hint.textContent = `Yeni key: ${r.masterKey} (kopyala: yukarıdaki kutuya tıkla)`;
  toast('Master key yenilendi 🔑');
});

// ---- init: session varsa login ekranına takılma, direkt dashboard ----
(async function init() {
  try {
    const status = await api('/api/status');
    if (status && status.stats) showDashboard(); // oturum geçerli → direkt içeri
  } catch {
    // oturum yok/expired → login ekranı zaten görünüyor, kal
  }
})();

// ---- escape helper ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
