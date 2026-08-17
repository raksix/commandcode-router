// ---- helpers ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
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
  await refresh();
  setInterval(refresh, 10000); // auto-refresh stats every 10s
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
      <td class="mono">${esc(v)}</td>
      <td style="text-align:right"><button class="btn btn-small btn-danger del-map">Sil</button></td>
    `;
    tr.querySelector('.del-map').addEventListener('click', async () => {
      await api(`/api/model-map/${encodeURIComponent(k)}`, { method: 'DELETE' });
      refresh();
    });
    tbody.appendChild(tr);
  }
}

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

// ---- escape helper ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
