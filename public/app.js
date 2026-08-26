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
