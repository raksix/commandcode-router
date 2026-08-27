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
  const password = $('#login-password').value.trim();
  if (!password) { $('#login-error').textContent = 'Şifre boş olamaz'; $('#login-error').classList.remove('hidden'); return; }
  showLoading('Giriş yapılıyor...');
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#login-error').classList.add('hidden');
    await showDashboard();
  } catch (err) {
    hideLoading();
    $('#login-error').textContent = err.message || 'Giriş hatası';
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
  setupNav();
  await loadModels();
  await refresh();
  setInterval(refresh, 10000); // auto-refresh stats every 10s
  hideLoading();
}

// ---- loading screen ----
function showLoading(msg) {
  const el = $('#loading-screen');
  if (el) {
    el.classList.remove('hidden');
    const sub = $('#loading-sub');
    if (sub && msg) sub.textContent = msg;
  }
}
function hideLoading() {
  const el = $('#loading-screen');
  if (el) el.classList.add('hidden');
}

// ---- sidebar section navigation ----
function setupNav() {
  const links = Array.from($$('.side-link'));  // NodeList -> Array (`.some` için)
  const show = (name) => {
    links.forEach((l) => l.classList.toggle('active', l.dataset.section === name));
    $$('.section').forEach((s) => s.classList.toggle('active', s.dataset.sectionPanel === name));
  };
  links.forEach((l) => {
    l.addEventListener('click', (e) => {
      e.preventDefault();
      show(l.dataset.section);
      // hash'i güncelle ama scroll tetikleme
      history.replaceState(null, '', '#' + l.dataset.section);
    });
  });
  // tarayıcı geri/ileri ya da elle hash değişince de section'ı aç
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (h && links.some((l) => l.dataset.section === h)) show(h);
  });
  // hash'e göre aç (örn. #docs)
  const initial = location.hash.replace('#', '');
  if (initial && links.some((l) => l.dataset.section === initial)) show(initial);
  else show('overview');
}

// ---- CommandCode model list (for dropdowns + full list) ----
let ccModels = [];           // unique key listesi: "provider::id"
let ccModelDetails = [];     // [{ id, name, context_length, provider, accountName }]
let ccModelByKey = new Map();// "provider::id" -> details

function modelKey(m) { return `${m.provider}::${m.id}`; }

async function loadModels() {
  try {
    const r = await api('/api/models');
    ccModelDetails = r.models || [];
    ccModelByKey = new Map(ccModelDetails.map((m) => [modelKey(m), m]));
    ccModels = ccModelDetails.map(modelKey);
    renderModelList();
    renderExposedList();
  } catch {
    ccModels = [];
    ccModelDetails = [];
    ccModelByKey = new Map();
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
    return `<span class="model-chip" title="${esc(m.name || m.id)} — ${esc(m.accountName || '')}">${esc(m.id)}${ctx}${providerBadge(m.provider)}</span>`;
  }).join('');
}

// ---- API'de sunulan modeller (exposedModels) ----
// Selection Set artık "provider::id" key'leri tutar (aynı id iki provider'da olabilir)
let exposedSelection = new Set();
let exposedSearch = '';       // aktif arama filtresi (küçük harf)
function setExposedSearch(v) {
  exposedSearch = (v || '').trim().toLowerCase();
  renderExposedList();
}
function providerBadge(provider) {
  if (provider === 'opencode-zen') {
    return ' <span class="prov-badge prov-zn" title="OpenCode Zen"><svg class="ic ic-xs"><use href="/assets/sprite.svg#i-sun"/></svg> zen</span>';
  }
  if (provider === 'opencode-go') {
    return ' <span class="prov-badge prov-og" title="OpenCode Go"><svg class="ic ic-xs"><use href="/assets/sprite.svg#i-rocket"/></svg> opencode</span>';
  }
  return ' <span class="prov-badge prov-cc" title="CommandCode"><svg class="ic ic-xs"><use href="/assets/sprite.svg#i-shuffle"/></svg> cmdcode</span>';
}
function renderExposedList() {
  const el = $('#exposed-list');
  if (!ccModelDetails.length) {
    el.innerHTML = '<span class="hint">Önce model listesi yüklensin (yukarıdaki Yenile).</span>';
    $('#exposed-count').textContent = '';
    return;
  }
  // Arama: id + provider + accountName içinde
  const filtered = exposedSearch
    ? ccModelDetails.filter((m) => {
        const hay = `${m.id} ${m.provider || ''} ${m.accountName || ''}`.toLowerCase();
        return hay.includes(exposedSearch);
      })
    : ccModelDetails;

  // Sayaç: "seçili / toplam (filtre)"
  const totalShown = filtered.length;
  const selShown = filtered.reduce((n, m) => n + (exposedSelection.has(modelKey(m)) ? 1 : 0), 0);
  const totalAll = ccModelDetails.length;
  const selAll = exposedSelection.size;
  const countEl = $('#exposed-count');
  if (countEl) {
    if (exposedSearch) {
      countEl.textContent = `${selShown}/${totalShown} gösterilen · ${selAll}/${totalAll} toplam`;
    } else {
      countEl.textContent = `${selAll}/${totalAll} model açık`;
    }
  }

  if (!totalShown) {
    el.innerHTML = `<span class="hint">"${esc(exposedSearch)}" ile eşleşen model yok.</span>`;
    return;
  }

  el.innerHTML = filtered.map((m) => {
    const key = modelKey(m);
    const on = exposedSelection.has(key);
    const ctx = m.context_length ? `<span class="ctx">${(m.context_length / 1000).toLocaleString('tr-TR')}k ctx</span>` : '';
    return `<div class="model-row ${on ? 'row-on' : ''}" data-key="${esc(key)}" title="${esc(m.name || m.id)} — ${esc(m.accountName || '')}">
      <span class="model-id">${esc(m.id)}${ctx}${providerBadge(m.provider)}</span>
      <button type="button" class="toggle ${on ? 'toggle-on' : ''}" role="switch" aria-checked="${on}" data-key="${esc(key)}" title="${on ? 'Disable (API\'den gizle)' : 'Allow (API\'de göster)'}">
        <span class="toggle-thumb"></span>
      </button>
    </div>`;
  }).join('');
  // Switch toggle: buton veya satıra tıklayınca aç/kapat
  el.querySelectorAll('.model-row').forEach((row) => {
    const key = row.dataset.key;
    const toggle = () => {
      if (exposedSelection.has(key)) exposedSelection.delete(key);
      else exposedSelection.add(key);
      renderExposedList();
    };
    row.querySelector('.toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    // Satırın geri kalanına tıklayınca da toggle (kolay kullanım)
    row.addEventListener('click', (e) => {
      if (e.target.closest('.toggle')) return;
      toggle();
    });
  });
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

  // master keys
  renderMasterKeys(status.masterKeys || []);

  // accounts
  renderAccounts(status.accounts);

  // istatistik + loglar
  renderDaily(status.daily);
  renderLogs(status.logs);

  // exposed models (only reset selection if status.exposedModels changed)
  // Server artık model id'leri (provider prefix olmadan) döndürür — biz client'ta
  // model detaylarından provider'ı bulup key'i "provider::id" yapıyoruz.
  if (status.exposedModels) {
    const next = new Set(status.exposedModels.map((id) => {
      const m = ccModelDetails.find((x) => x.id === id);
      return m ? modelKey(m) : id;
    }));
    const same = next.size === exposedSelection.size && [...next].every((x) => exposedSelection.has(x));
    if (!same) {
      exposedSelection = next;
      renderExposedList();
    }
  }
}

function renderMasterKeys(keys) {
  const tbody = $('#masterkeys-body');
  tbody.innerHTML = '';
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="hint">Henüz anahtar yok.</td></tr>';
    return;
  }
  for (const k of keys) {
    const tr = document.createElement('tr');
    const lastUsed = k.lastUsedAt
      ? new Date(k.lastUsedAt).toLocaleString('tr-TR')
      : '—';
    tr.innerHTML = `
      <td class="mono">${esc(k.name)}</td>
      <td class="mono">${esc(k.keyMasked)}</td>
      <td class="small">${esc(lastUsed)}</td>
      <td style="text-align:right">
        <button class="btn btn-small copy-key" data-id="${esc(k.id)}" title="Bu key'i kopyala">Kopyala</button>
        <button class="btn btn-small regen-key" data-id="${esc(k.id)}" title="Yeni key üret, eskisini iptal et">Yenile</button>
        <button class="btn btn-small btn-danger del-key" data-id="${esc(k.id)}" title="Bu key'i sil">Sil</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function renderAccounts(accounts) {
  const tbody = $('#accounts-body');
  tbody.innerHTML = '';
  // hesap sayısı: ilk hesap "Birincil" rozeti alır (round-robin'in başlangıç noktası)
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const tr = document.createElement('tr');
    tr.dataset.id = a.id;
    tr.draggable = true;

    const statusBadge = a.banned
      ? '<span class="badge badge-ban"><svg class="ic ic-xs"><use href="/assets/sprite.svg#i-ban"/></svg> Banlı</span>'
      : a.isActive
        ? '<span class="badge badge-ok">Aktif</span>'
        : '<span class="badge badge-off">Pasif</span>';

    const primaryBadge = (i === 0 && accounts.length > 1)
      ? '<span class="badge badge-primary" title="Round-robin bu hesaptan başlar"><svg class="ic ic-xs"><use href="/assets/sprite.svg#i-rocket"/></svg> Birincil</span>'
      : '';

    const orderBadge = `<span class="order-badge">#${i + 1}</span>`;

    tr.innerHTML = `
      <td>
        <div class="acc-name-row">
          <span class="drag-handle" title="Sürükle-bırak ile taşı"><svg class="ic ic-sm"><use href="/assets/sprite.svg#i-shuffle"/></svg></span>
          <span class="acc-name">${esc(a.name)}</span>
          ${primaryBadge}
          ${orderBadge}
        </div>
      </td>
      <td class="key-cell">
        <span class="key-val">${maskKey(a.apiKeyMasked)}</span>
        <button class="eye-btn" title="Tam keyi gör"><svg class="ic ic-sm"><use href="/assets/sprite.svg#i-eye"/></svg></button>
      </td>
      <td><span class="badge ${a.provider === 'opencode-go' ? 'badge-og' : 'badge-cc'}">${a.provider === 'opencode-go' ? 'OpenCode Go' : 'CommandCode'}</span></td>
      <td>${statusBadge}${a.banned ? `<div class="hint">${esc(a.lastError || '')}</div>` : ''}</td>
      <td>${a.totalRequests}</td>
      <td class="${a.consecutiveErrors > 0 ? 'stat-val red' : ''}" style="font-size:14px">${a.consecutiveErrors}</td>
      <td>${fmtTime(a.lastUsedAt)}</td>
      <td>
        <div class="action-row">
          <div class="reorder-group" role="group" aria-label="Sıra">
            <button class="btn btn-icon move-up" title="Yukarı taşı" ${i === 0 ? 'disabled' : ''}><svg class="ic ic-sm"><use href="/assets/sprite.svg#i-arrow-up"/></svg></button>
            <button class="btn btn-icon move-down" title="Aşağı taşı" ${i === accounts.length - 1 ? 'disabled' : ''}><svg class="ic ic-sm"><use href="/assets/sprite.svg#i-arrow-down"/></svg></button>
          </div>
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
        eye.innerHTML = '<svg class="ic ic-sm"><use href="/assets/sprite.svg#i-eye-off"/></svg>';
        setTimeout(() => {
          v.textContent = maskKey(a.apiKeyMasked);
          eye.innerHTML = '<svg class="ic ic-sm"><use href="/assets/sprite.svg#i-eye"/></svg>';
        }, 8000);
      }
    });

    tr.querySelector('.test-btn').addEventListener('click', async () => {
      toast(`"${a.name}" test ediliyor...`);
      const r = await api(`/api/accounts/${a.id}/test`, { method: 'POST' });
      toast(r.ok
        ? `"${a.name}" çalışıyor (${r.ms}ms, ${r.modelsCount ?? '?'} model)`
        : `${a.name}: HTTP ${r.status} — ${r.detail || ''}`.slice(0, 90),
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

    // ▲/▼ sıra butonları
    const upBtn = tr.querySelector('.move-up');
    const downBtn = tr.querySelector('.move-down');
    if (upBtn && !upBtn.disabled) {
      upBtn.addEventListener('click', async () => {
        await moveAccount(a.id, i - 1);
      });
    }
    if (downBtn && !downBtn.disabled) {
      downBtn.addEventListener('click', async () => {
        await moveAccount(a.id, i + 1);
      });
    }

    // HTML5 drag-drop
    attachRowDragHandlers(tr, a.id, i);

    tbody.appendChild(tr);
  }
}

// Tek hesabı listede yeni index'e taşı ve backend'e yeni sırayı gönder.
async function moveAccount(id, toIndex) {
  const tbody = $('#accounts-body');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const currentIds = rows.map((r) => r.dataset.id);
  const fromIndex = currentIds.indexOf(id);
  if (fromIndex === -1 || toIndex < 0 || toIndex >= currentIds.length) return;
  // anında optimistic UI: DOM'dan taşı
  currentIds.splice(fromIndex, 1);
  currentIds.splice(toIndex, 0, id);
  reorderDom(currentIds);
  // backend'e bildir
  try {
    await api('/api/accounts/reorder', { method: 'POST', body: JSON.stringify({ order: currentIds }) });
    toast('Sıra güncellendi');
    refresh(); // round-robin index + Birincil rozet hesabı yeniden çizilsin
  } catch (err) {
    toast('Sıra kaydedilemedi: ' + err.message, 'err');
    refresh(); // hatayı geri al
  }
}

// DOM'u verilen id sırasına göre yeniden kur (animasyonsuz; tarayıcı native geçiş yapar)
function reorderDom(idOrder) {
  const tbody = $('#accounts-body');
  const rows = new Map(Array.from(tbody.querySelectorAll('tr')).map((r) => [r.dataset.id, r]));
  tbody.innerHTML = '';
  for (const id of idOrder) {
    if (rows.has(id)) tbody.appendChild(rows.get(id));
  }
}

// HTML5 drag-drop — satırı tutup başka satırın üstüne bırakınca sıra değişir.
let dragSourceId = null;
function attachRowDragHandlers(tr, id, index) {
  tr.addEventListener('dragstart', (e) => {
    dragSourceId = id;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  });
  tr.addEventListener('dragend', () => {
    dragSourceId = null;
    tr.classList.remove('dragging');
    $$('#accounts-body tr').forEach((r) => r.classList.remove('drag-over'));
  });
  tr.addEventListener('dragover', (e) => {
    if (!dragSourceId || dragSourceId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('#accounts-body tr').forEach((r) => r.classList.remove('drag-over'));
    tr.classList.add('drag-over');
  });
  tr.addEventListener('dragleave', () => {
    tr.classList.remove('drag-over');
  });
  tr.addEventListener('drop', async (e) => {
    e.preventDefault();
    tr.classList.remove('drag-over');
    if (!dragSourceId || dragSourceId === id) return;
    // hedefin index'ini bul
    const tbody = $('#accounts-body');
    const ids = Array.from(tbody.querySelectorAll('tr')).map((r) => r.dataset.id);
    const targetIdx = ids.indexOf(id);
    await moveAccount(dragSourceId, targetIdx);
  });
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

  // mini bar chart: son 14 gün (hem Genel Bakış hem İstatistikler sayfasında göster)
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: dt, ...(daily?.[dt] || { total: 0, success: 0, errors: 0, inputTokens: 0, outputTokens: 0 }) });
  }
  const max = Math.max(...days.map((d2) => d2.total), 1);
  const chartHtml = days.map((d2) => `
    <div class="bar-col" title="${d2.day}: ${d2.total} istek (${d2.success} başarılı, ${d2.errors} hata)">
      <div class="bar-wrap">
        <div class="bar bar-ok" style="height:${Math.round((d2.success / max) * 100)}%"></div>
        <div class="bar bar-err" style="height:${Math.round((d2.errors / max) * 100)}%"></div>
      </div>
      <div class="bar-lbl">${d2.day.slice(5)}</div>
    </div>`).join('');
  $('#daily-chart').innerHTML = chartHtml;
  $('#daily-chart-hint').textContent = `Son 14 gün — yeşil başarılı, kırmızı hata.`;
  const c2 = $('#daily-chart2');
  if (c2) { c2.innerHTML = chartHtml; $('#daily-chart-hint2').textContent = `Son 14 gün — yeşil başarılı, kırmızı hata.`; }

  // token grafiği: mavi = girdi, turuncu = çıktı (son 14 gün)
  const maxTok = Math.max(...days.map((d2) => Math.max(d2.inputTokens || 0, d2.outputTokens || 0)), 1);
  const tchartHtml = days.map((d2) => `
    <div class="bar-col" title="${d2.day}: in ${fmtNum(d2.inputTokens || 0)} / out ${fmtNum(d2.outputTokens || 0)} token">
      <div class="bar-wrap">
        <div class="bar bar-in" style="height:${Math.round(((d2.inputTokens || 0) / maxTok) * 100)}%"></div>
        <div class="bar bar-out" style="height:${Math.round(((d2.outputTokens || 0) / maxTok) * 100)}%"></div>
      </div>
      <div class="bar-lbl">${d2.day.slice(5)}</div>
    </div>`).join('');
  $('#token-chart').innerHTML = tchartHtml;
  const tc2 = $('#token-chart2');
  if (tc2) { tc2.innerHTML = tchartHtml; }
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
      <td class="mono small token-chip">${hasTokens ? `${fmtNum(l.inputTokens || 0)}/${fmtNum(l.outputTokens || 0)}` : '—'}</td>
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
  const provider = $('#acc-provider').value;
  if (!name || !apiKey) return;
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name, apiKey, provider }) });
    $('#acc-name').value = '';
    $('#acc-key').value = '';
    $('#add-account-form').classList.add('hidden');
    toast('Hesap eklendi');
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

// ---- model listesi ----
$('#refresh-models-btn').addEventListener('click', async () => {
  await loadModels();
  renderExposedList();
  toast(`Model listesi güncellendi (${ccModels.length} model)`);
  $('#refresh-models-btn').disabled = false;
});

// ---- exposed-models POST yardımcısı: "provider::id" key'lerini düz id'ye çevir ----
function exposedKeysToIds(keys) {
  const out = [];
  for (const key of keys) {
    const m = ccModelByKey.get(key);
    if (m) out.push(m.id);
    else {
      // eski formatta kaydedilmişse ya da model artık listede yoksa ham key'i gönder
      const idx = key.indexOf('::');
      out.push(idx >= 0 ? key.slice(idx + 1) : key);
    }
  }
  return out;
}

// exposed models: kaydet
$('#expose-save-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/exposed-models', { method: 'POST', body: JSON.stringify({ models: exposedKeysToIds(exposedSelection) }) });
    toast(r.exposedModels.length ? `API'de ${r.exposedModels.length} model sunuluyor` : 'Tüm modeller sunuluyor (filtre yok)');
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

$('#expose-allow-all-btn').addEventListener('click', async () => {
  // Tüm (filtrede görünen) modelleri aç, server'a kaydet, listeyi tazele
  const targets = exposedSearch
    ? ccModelDetails.filter((m) => {
        const hay = `${m.id} ${m.provider || ''} ${m.accountName || ''}`.toLowerCase();
        return hay.includes(exposedSearch);
      })
    : ccModelDetails;
  for (const m of targets) exposedSelection.add(modelKey(m));
  renderExposedList();
  try {
    const r = await api('/api/exposed-models', { method: 'POST', body: JSON.stringify({ models: exposedKeysToIds(exposedSelection) }) });
    toast(`${targets.length} model açıldı, API'de ${r.exposedModels.length} model sunuluyor`);
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

$('#expose-disable-all-btn').addEventListener('click', async () => {
  // Tüm (filtrede görünen) modelleri kapat, server'a kaydet, listeyi tazele
  const targets = exposedSearch
    ? ccModelDetails.filter((m) => {
        const hay = `${m.id} ${m.provider || ''} ${m.accountName || ''}`.toLowerCase();
        return hay.includes(exposedSearch);
      })
    : ccModelDetails;
  for (const m of targets) exposedSelection.delete(modelKey(m));
  renderExposedList();
  try {
    const r = await api('/api/exposed-models', { method: 'POST', body: JSON.stringify({ models: exposedKeysToIds(exposedSelection) }) });
    if (r.exposedModels.length === 0) {
      toast('Tüm modeller devre dışı (API\'de hiç model sunulmuyor)');
    } else {
      toast(`${targets.length} model kapatıldı, API'de ${r.exposedModels.length} model kaldı`);
    }
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

// Search input -> canlı filtre
$('#exposed-search').addEventListener('input', (e) => {
  setExposedSearch(e.target.value);
});

// ---- CommandCode auth (tarayıcıda giriş -> hesap otomatik eklenir) ----
let ccauthPoll = null;
let ccauthState = null;

async function startCcAuth(btn, statusEl) {
  // varsa eski poll'u durdur
  if (ccauthPoll) { clearInterval(ccauthPoll); ccauthPoll = null; }
  try {
    const r = await api('/api/commandcode-auth/start', { method: 'POST' });
    ccauthState = r.state;
    window.open(r.authUrl, '_blank');
    btn.disabled = true;
    btn.textContent = 'Giriş bekleniyor...';
    setCcAuthStatus(statusEl, 'CommandCode açıldı — tarayıcıda giriş yapın. Bekleniyor...');
    const deadline = Date.now() + r.expiresInSec * 1000;
    ccauthPoll = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(ccauthPoll); ccauthPoll = null;
        btn.disabled = false; btn.textContent = "CommandCode'a Git";
        setCcAuthStatus(statusEl, '⏰ Zaman aşımı, tekrar deneyin.');
        return;      }
      try {
        const st = await api(`/api/commandcode-auth/status?state=${encodeURIComponent(ccauthState)}`);
        if (st.status === 'received') {
          clearInterval(ccauthPoll); ccauthPoll = null;
          setCcAuthStatus(statusEl, 'Key alındı — hesaba ekleniyor...');
          await api('/api/commandcode-auth/apply', { method: 'POST', body: JSON.stringify({ state: ccauthState }) });
          btn.disabled = false; btn.textContent = "CommandCode'a Git";
          toast('Hesap eklendi');
          ccauthState = null;
          // dashboard görünürse listeyi tazele
          if (!$('#dashboard').classList.contains('hidden')) refresh();
        }
      } catch {}
    }, 2000);
  } catch (err) {
    setCcAuthStatus(statusEl, `Hata: ${err.message}`);
  }
}

function setCcAuthStatus(el, msg) {
  if (el) el.textContent = msg;
}

$('#ccauth-add-btn').addEventListener('click', () => startCcAuth($('#ccauth-add-btn'), $('#ccauth-status')));
$('#ccauth-inline-btn').addEventListener('click', () => startCcAuth($('#ccauth-inline-btn'), $('#ccauth-add-status')));

// ---- master key actions (çoklu key) ----
// delegation: tablo içindeki butonlar dinamik olduğu için tbody'ye tek listener
$('#masterkeys-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  const row = btn.closest('tr');
  const keyText = row?.querySelector('td:nth-child(2)')?.textContent || '';

  if (btn.classList.contains('copy-key')) {
    // masked key kopyalanamaz — tam key'i API'den iste
    try {
      const r = await api(`/api/master-key/${id}/reveal`, { method: 'GET' });
      if (r.key) {
        await navigator.clipboard.writeText(r.key);
        toast('Anahtar kopyalandı');
      } else {
        toast('Anahtar alınamadı', 'err');
      }
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (btn.classList.contains('regen-key')) {
    if (!confirm('Bu anahtar yenilensin mi? Eski key ile bağlı istemciler bağlantısını kaybeder.')) return;
    try {
      const r = await api(`/api/master-key/${id}/regenerate`, { method: 'POST' });
      toast(`Yeni anahtar: ${r.key.key}`);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  if (btn.classList.contains('del-key')) {
    if (!confirm('Bu anahtar silinsin mi? Bu key ile bağlı istemciler bağlantısını kaybeder.')) return;
    try {
      await api(`/api/master-key/${id}`, { method: 'DELETE' });
      toast('Anahtar silindi');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
});

// + Yeni Anahtar toggle
$('#add-key-toggle').addEventListener('click', () => {
  $('#add-key-form').classList.toggle('hidden');
  $('#new-key-name').focus();
});

// Yeni anahtar oluştur
$('#add-key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#new-key-name').value.trim();
  try {
    const r = await api('/api/master-key', { method: 'POST', body: JSON.stringify({ name }) });
    const hint = $('#new-key-hint');
    hint.textContent = `Yeni anahtar oluşturuldu: ${r.key.key} — şimdi kopyala, bir daha gösterilmez!`;
    $('#new-key-name').value = '';
    $('#add-key-form').classList.add('hidden');
    refresh();
  } catch (err) { toast(err.message, 'err'); }
});

// ---- init: session varsa login ekranına takılma, direkt dashboard ----
(async function init() {
  try {
    const status = await api('/api/status');
    if (status && status.stats) {
      await showDashboard(); // oturum geçerli → direkt içeri
    } else {
      hideLoading(); // status var ama stats yok → login göster
    }
  } catch {
    hideLoading(); // oturum yok/expired → login ekranı zaten görünüyor, kal
  }
})();

// ---- escape helper ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================================================
// PROXY HAVUZU
// ============================================================================
const proxyState = { proxies: [], stats: {}, config: {}, filter: 'all', q: '' };
const proxyHistory = { total: [], active: [], cool: [], disabled: [], ewma: [] };

function proxyPill(rec) {
  if (rec.disabled) return `<span class="pill err">Disabled · ${proxyRemain(rec.disabledRemainingS)}</span>`;
  if (rec.cooldownRemainingMs > 0) return `<span class="pill cool">Cooldown · ${proxyRemain(Math.ceil(rec.cooldownRemainingMs/1000))}</span>`;
  if (!rec.active) return `<span class="pill warn">Inactive (w=${rec.weight})</span>`;
  return `<span class="pill ok">Aktif</span>`;
}
function proxyRemain(s) {
  if (!s || s <= 0) return '–';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if (h) return `${h}s ${m}dk`;
  if (m) return `${m}dk ${sec}sn`;
  return `${sec}sn`;
}
function ewmaColor(v) {
  if (v >= 0.7) return 'var(--green)';
  if (v >= 0.4) return 'var(--yellow)';
  return 'var(--red)';
}
function proxyLatency(rec) {
  if (rec.latencyMs == null) return '<span style="color:var(--muted)">–</span><div class="latency-bar"><i style="width:0%"></i></div>';
  const ms = rec.latencyMs;
  const pct = Math.min(100, Math.max(2, (ms / 5000) * 100));
  const color = ms > 2500 ? 'var(--yellow)' : (ms > 1000 ? 'var(--blue)' : 'var(--green)');
  return `<span style="font-family:var(--mono);font-size:13px;color:${color}">${ms}ms</span><div class="latency-bar"><i style="width:${pct.toFixed(0)}%;background:${color}"></i></div>`;
}
function proxyEwmaDonut(v) {
  const C = 2 * Math.PI * 15.5; // circumference
  const pct = Math.max(0, Math.min(1, v));
  const off = C * (1 - pct);
  const col = ewmaColor(v);
  return `<svg class="ewma-donut" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--border)" stroke-width="3"/>
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="${col}" stroke-width="3"
      stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 18 18)"/>
  </svg><span class="ewma-text" style="color:${col}">${v.toFixed(2)}</span>`;
}
function proxyAgo(ts) {
  if (!ts) return '—';
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return `${d}sn`;
  if (d < 3600) return `${Math.floor(d/60)}dk`;
  return `${Math.floor(d/3600)}sa`;
}
function proxyRow(rec) {
  const tr = document.createElement('tr');
  tr.dataset.id = rec.id;
  if (rec.disabled) tr.classList.add('disabled-row');
  const authBadge = rec.withAuth ? `<span class="pill" style="background:var(--accent-soft);color:var(--accent-hover);font-size:10px;padding:1px 6px">auth</span>` : '';
  tr.innerHTML = `
    <td>
      <div class="endpoint-cell">${esc(rec.endpoint)} ${authBadge}</div>
      <div class="endpoint-sub">${esc(rec.label || '')} ${rec.tags?.length ? '· ' + rec.tags.map(t=>'#'+esc(t)).join(' ') : ''}</div>
    </td>
    <td class="col-status">${proxyPill(rec)}<div style="font-size:11px;color:var(--muted);margin-top:4px">${esc(rec.disabledReason || '')}</div></td>
    <td>${proxyEwmaDonut(rec.ewma)}<div style="font-size:11px;color:var(--muted);margin-top:3px">streak ${rec.streak} · ${rec.reportedOk}/${rec.reportedFail}</div></td>
    <td class="col-latency">${proxyLatency(rec)}<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(rec.lastCheckStatus || '–')}</div></td>
    <td><input type="number" min="0" max="20" value="${rec.weight}" data-proxy-act="weight" class="weight-input"></td>
    <td style="font-family:var(--mono);font-size:13px">${rec.assignedCount}<div style="font-size:11px;color:var(--muted)">${proxyAgo(rec.lastUsedAt)} önce</div></td>
    <td>
      <div class="row-actions">
        <button class="icon-btn" data-proxy-act="toggle" title="${rec.disabled ? 'Etkinleştir' : 'Devre dışı bırak'}">${rec.disabled ? '↻' : '⏸'}</button>
        <button class="icon-btn" data-proxy-act="reportOk" title="OK raporla">✓</button>
        <button class="icon-btn" data-proxy-act="reportFail" title="Hata raporla">✗</button>
        <button class="icon-btn danger" data-proxy-act="delete" title="Sil">×</button>
      </div>
    </td>`;
  return tr;
}
function proxyVisible(rec) {
  if (proxyState.q) {
    const hay = [rec.endpoint, rec.label, ...(rec.tags||[])].join(' ').toLowerCase();
    if (!hay.includes(proxyState.q.toLowerCase())) return false;
  }
  switch (proxyState.filter) {
    case 'active':    return !rec.disabled && rec.active;
    case 'cooldown':  return !rec.disabled && rec.cooldownRemainingMs > 0;
    case 'disabled':  return rec.disabled;
    default: return true;
  }
}

function pushHistory(key, val) {
  const arr = proxyHistory[key];
  arr.push(val);
  if (arr.length > 24) arr.shift();
  // görsel zenginlik için: tek veri noktası varsa küçük bir varyasyon ekle
  if (arr.length === 1 && val > 0) {
    arr.unshift(Math.max(0, val - 1));
  }
}
function sparkPoints(arr, max) {
  if (!arr.length) return '0,12 60,12';
  const m = max || Math.max(...arr, 1);
  const step = 60 / (arr.length - 1 || 1);
  return arr.map((v, i) => `${(i * step).toFixed(1)},${(24 - (v / m) * 22 - 1).toFixed(1)}`).join(' ');
}

function updateProxyCharts() {
  const s = proxyState.stats;
  // sparklines
  pushHistory('total', s.total || 0);
  pushHistory('active', s.active || 0);
  pushHistory('cool', s.coolingDown || 0);
  pushHistory('disabled', s.disabled || 0);
  pushHistory('ewma', Math.round((s.avgEwma || 0) * 100));
  const setSpark = (id, pts, max) => { const el = document.getElementById(id); if (el) el.setAttribute('points', sparkPoints(pts, max)); };
  setSpark('spark-total', proxyHistory.total, Math.max(1, ...proxyHistory.total));
  setSpark('spark-active', proxyHistory.active, Math.max(1, ...proxyHistory.active));
  setSpark('spark-cool', proxyHistory.cool, Math.max(1, ...proxyHistory.cool));
  setSpark('spark-disabled', proxyHistory.disabled, Math.max(1, ...proxyHistory.disabled));

  // gauge
  const ewma = s.avgEwma || 0;
  const C = 2 * Math.PI * 15.5;
  const gauge = document.getElementById('gauge-ewma');
  if (gauge) {
    gauge.style.strokeDashoffset = (C * (1 - ewma)).toFixed(1);
    gauge.style.stroke = ewmaColor(ewma);
  }

  // composition bar
  const t = s.total || 1;
  const aPct = ((s.active || 0) / t * 100).toFixed(1);
  const cPct = ((s.coolingDown || 0) / t * 100).toFixed(1);
  const dPct = ((s.disabled || 0) / t * 100).toFixed(1);
  const compA = document.getElementById('comp-active');
  const compC = document.getElementById('comp-cool');
  const compD = document.getElementById('comp-disabled');
  if (compA) compA.style.width = aPct + '%';
  if (compC) compC.style.width = cPct + '%';
  if (compD) compD.style.width = dPct + '%';
  const legA = document.getElementById('leg-active');
  const legC = document.getElementById('leg-cool');
  const legD = document.getElementById('leg-disabled');
  if (legA) legA.textContent = s.active || 0;
  if (legC) legC.textContent = s.coolingDown || 0;
  if (legD) legD.textContent = s.disabled || 0;
}

async function refreshProxies() {
  const j = await api('/api/proxies');
  if (!j || !j.ok) return;
  proxyState.proxies = j.proxies || [];
  proxyState.stats = j.stats || {};
  proxyState.config = j.config || {};
  $('#proxy-stat-total').textContent = proxyState.stats.total;
  $('#proxy-stat-active').textContent = proxyState.stats.active;
  $('#proxy-stat-cool').textContent = proxyState.stats.coolingDown;
  $('#proxy-stat-disabled').textContent = proxyState.stats.disabled;
  $('#proxy-stat-ewma').textContent = (proxyState.stats.avgEwma ?? '–');
  updateProxyCharts();
  renderProxies();
}

function renderProxies() {
  const body = $('#proxies-body');
  if (!body) return;
  const list = proxyState.proxies.filter(proxyVisible).sort((a,b) => b.ewma - a.ewma);
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">Filtreyle eşleşen proxy yok.</td></tr>`;
    return;
  }
  for (const r of list) body.appendChild(proxyRow(r));
}

async function bulkAddProxies() {
  const text = $('#proxy-bulk-text').value.trim();
  if (!text) { toast('Lütfen en az bir satır girin', 'err'); return; }
  const source = $('#proxy-bulk-source').value.trim() || undefined;
  const j = await api('/api/proxies/bulk', { method:'POST', body: JSON.stringify({ text, source }) });
  if (!j || !j.ok) { toast((j && j.error) || 'hata', 'err'); return; }
  toast(`+${j.added} yeni, ${j.merged} merge (${j.invalid.length} geçersiz)`, 'ok');
  $('#proxy-bulk-text').value = '';
  $('#proxy-bulk-hint').textContent = j.invalid.length ? `${j.invalid.length} satır reddedildi: ${j.invalid.slice(0,3).join(' | ')}` : '';
  refreshProxies();
}

async function pickProxyNext() {
  const j = await api('/api/proxies/next', { method:'POST', body:'{}' });
  if (!j || !j.ok) { toast((j && j.error) || 'aktif proxy yok', 'err'); return; }
  toast(`→ ${j.proxy.endpoint}`, 'ok');
  refreshProxies();
}

async function runProxyCheck() {
  $('#proxy-check-btn').disabled = true;
  const j = await api('/api/proxies/check?all=1', { method:'POST', body:'{}' });
  $('#proxy-check-btn').disabled = false;
  if (!j || !j.ok) { toast((j && j.error) || 'check başarısız', 'err'); return; }
  toast(`${j.checked} proxy kontrol edildi`, 'ok');
  refreshProxies();
}

// delegation: tek handler, click event bir noktadan yönetiliyor
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-proxy-act]');
  if (!btn) return;
  const tr = btn.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  const act = btn.dataset.proxyAct;
  if (act === 'toggle') {
    const rec = proxyState.proxies.find(p => p.id === id);
    await api(`/api/proxies/${id}`, { method:'PATCH', body: JSON.stringify({ enabled: !rec.disabled }) });
  } else if (act === 'reportOk' || act === 'reportFail') {
    await api('/api/proxies/report', { method:'POST', body: JSON.stringify({ id, ok: act === 'reportOk', detail: act === 'reportOk' ? 'manual' : 'timeout' }) });
  } else if (act === 'delete') {
    if (!confirm('Bu proxy silinsin mi?')) return;
    await api(`/api/proxies/${id}`, { method:'DELETE' });
  }
  refreshProxies();
});
document.addEventListener('change', async (e) => {
  if (e.target.matches('[data-proxy-act="weight"]')) {
    const id = e.target.closest('tr').dataset.id;
    await api(`/api/proxies/${id}`, { method:'PATCH', body: JSON.stringify({ weight: parseFloat(e.target.value) }) });
    refreshProxies();
  }
});
$('#proxy-bulk-btn')?.addEventListener('click', bulkAddProxies);
$('#proxy-check-btn')?.addEventListener('click', runProxyCheck);
$('#proxy-next-btn')?.addEventListener('click', pickProxyNext);
$('#proxy-search')?.addEventListener('input', e => { proxyState.q = e.target.value; renderProxies(); });
document.querySelectorAll('#section-proxies .filter-tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#section-proxies .filter-tab').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  proxyState.filter = b.dataset.f;
  renderProxies();
}));

// Sekmeye her girişte yenile (sadece bu seksiyon aktifse polling yavaşlatır)
let proxyRefreshTimer = null;
function startProxyAutoRefresh() {
  if (proxyRefreshTimer) return;
  refreshProxies();
  proxyRefreshTimer = setInterval(() => {
    if (document.querySelector('.side-link[data-section="proxies"]').classList.contains('active')) {
      refreshProxies();
    }
  }, 8000);
}
const _origShowDashboard = showDashboard;
showDashboard = async function() { await _origShowDashboard(); startProxyAutoRefresh(); initPlayground(); };

// ---- Playground ----
// Panel içinden API'leri test eder. İstek /api/playground/v1/* üzerinden gerçek
// havuzdan (round-robin + alpha yolu) geçer; master key tarayıcıya sızmaz.
let pgHistory = []; // [{ role, content }]
let pgBusy = false;

function initPlayground() {
  // model listesini datalist'e doldur (loadModels ccModelDetails'i doldurur)
  const dl = $('#pg-model-list');
  if (dl && ccModelDetails.length) {
    dl.innerHTML = ccModelDetails.map((m) => `<option value="${esc(m.id)}">`).join('');
  }
  // event'leri bir kez bağla
  if (window.__pgBound) return;
  window.__pgBound = true;

  $('#pg-send').addEventListener('click', () => pgSubmit());
  $('#pg-clear').addEventListener('click', () => {
    pgHistory = [];
    $('#pg-chat').innerHTML = '';
    setPgStatus('Temizlendi.');
  });
  $('#pg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      pgSubmit();
    }
  });
}

function pgRender() {
  const chat = $('#pg-chat');
  chat.innerHTML = pgHistory.map((m) => {
    const isUser = m.role === 'user';
    const cls = isUser ? 'user' : 'assistant';
    const meta = isUser ? 'sen' : (m.model ? esc(m.model) : 'assistant');
    const streaming = m.streaming ? ' streaming' : '';
    const content = esc(m.content || (m.streaming ? '…' : ''));
    return `<div class="pg-msg ${cls}"><div class="pg-bubble${streaming}">${content}</div><div class="pg-meta">${meta}</div></div>`;
  }).join('');
  chat.scrollTop = chat.scrollHeight;
}

function setPgStatus(html) { $('#pg-status').innerHTML = html; }

async function pgSubmit() {
  if (pgBusy) return;
  const text = $('#pg-input').value.trim();
  if (!text) { toast('Mesaj boş', 'err'); return; }
  const model = $('#pg-model').value.trim();
  if (!model) { toast('Model seç', 'err'); return; }

  const format = $('#pg-format').value;
  const maxTokens = parseInt($('#pg-maxtok').value, 10) || 512;
  const stream = $('#pg-stream').checked;

  pgHistory.push({ role: 'user', content: text });
  pgHistory.push({ role: 'assistant', content: '', model, streaming: true });
  pgRender();
  $('#pg-input').value = '';
  setPgStatus('İstek gönderiliyor…');
  pgBusy = true;

  const started = Date.now();
  try {
    // Anthropic: son kullanıcı mesajı + önceki tamamlanmış assistant mesajları
    const messages = pgHistory
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    const payload = format === 'anthropic'
      ? { model, max_tokens: maxTokens, stream, messages }
      : {
          model,
          stream,
          max_tokens: maxTokens,
          messages
        };

    const endpoint = format === 'anthropic' ? '/api/playground/v1/messages' : '/api/playground/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (format === 'anthropic') headers['anthropic-version'] = '2023-06-01';

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      cache: 'no-store'
    });

    const ms = Date.now() - started;
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      pgHistory[pgHistory.length - 1] = { role: 'assistant', content: `Hata ${resp.status}:\n${errText.slice(0, 600)}`, model };
      pgRender();
      setPgStatus(`<span class="err">HTTP ${resp.status}</span> · ${ms}ms · ${esc(model)}`);
      return;
    }

    const lastMsg = () => pgHistory[pgHistory.length - 1];

    if (stream && resp.body) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      let gotDelta = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t || !t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          const piece = format === 'anthropic'
            ? (j.delta?.text || (j.delta?.type === 'text_delta' ? j.delta.text : ''))
            : (j.choices?.[0]?.delta?.content || '');
          if (piece) {
            gotDelta = true;
            acc += piece;
            lastMsg().content = acc;
            lastMsg().streaming = true;
            pgRender();
          }
        }
      }
      lastMsg().streaming = false;
      lastMsg().content = acc || lastMsg().content;
      pgRender();
      const inT = lastMsg().inputTokens || lastMsg().usage?.input_tokens || '';
      setPgStatus(`<span class="ok">200 OK</span> · ${ms}ms · ${gotDelta ? 'stream' : 'boş stream'} · ${esc(model)}`);
    } else {
      const textBody = await resp.text();
      let out = textBody;
      try {
        const j = JSON.parse(textBody);
        if (format === 'anthropic') {
          out = (j.content || []).map((c) => c.text || (c.input ? JSON.stringify(c.input) : '')).join('') ||
                (j.text || JSON.stringify(j, null, 2));
        } else {
          out = j.choices?.[0]?.message?.content || JSON.stringify(j, null, 2);
        }
      } catch {}
      lastMsg().content = out;
      lastMsg().streaming = false;
      pgRender();
      setPgStatus(`<span class="ok">200 OK</span> · ${ms}ms · ${esc(model)}`);
    }
  } catch (err) {
    pgHistory[pgHistory.length - 1] = { role: 'assistant', content: `İstek hatası: ${err.message}`, model };
    pgRender();
    setPgStatus(`<span class="err">hata</span> · ${esc(err.message)}`);
  } finally {
    pgBusy = false;
  }
}
