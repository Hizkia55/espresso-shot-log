import { get, set } from './lib/idb-keyval.js';

const SHOTS_KEY = 'shots';
const BEANS_KEY = 'beans';

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost) — falls
// back to a non-cryptographic id so logging still works over plain-HTTP LAN testing.
function genId() {
  return window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ---------- storage ---------- */

async function loadShots() {
  const shots = await get(SHOTS_KEY);
  return Array.isArray(shots) ? shots : [];
}

async function saveShots(shots) {
  await set(SHOTS_KEY, shots);
}

async function loadBeans() {
  const beans = await get(BEANS_KEY);
  return Array.isArray(beans) ? beans : [];
}

async function saveBeans(beans) {
  await set(BEANS_KEY, beans);
}

/* ---------- state ---------- */

let shots = await loadShots();
let beans = await loadBeans();

function sortedBeans() {
  return [...beans].sort((a, b) => a.name.localeCompare(b.name));
}

function getBeanLabel(shot) {
  const bean = beans.find((b) => b.id === shot.beanId);
  if (bean) return bean.name;
  if (shot.beanName) return shot.beanName;
  if (shot.bean) return shot.bean;
  return 'Unknown bean';
}

/* ---------- shared helpers ---------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function starsHtml(n) {
  n = Number(n) || 0;
  let out = '<span class="stars-static">';
  for (let i = 1; i <= 5; i++) out += `<span class="${i <= n ? 'filled' : ''}">★</span>`;
  out += '</span>';
  return out;
}

function initStarRating(containerEl, hiddenInputEl) {
  const buttons = [...containerEl.querySelectorAll('button')];
  function setValue(v) {
    containerEl.dataset.value = v;
    hiddenInputEl.value = v;
    buttons.forEach((b) => b.classList.toggle('filled', Number(b.dataset.star) <= v));
  }
  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      const v = Number(b.dataset.star);
      setValue(Number(containerEl.dataset.value) === v ? 0 : v);
    });
  });
  setValue(0);
  return { setValue };
}

/* ---------- tabs ---------- */

const tabButtons = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view');

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(name) {
  tabButtons.forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  views.forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') {
    renderHistory();
  } else if (name === 'beans') {
    renderBeans();
  }
}

/* ---------- bean catalog ---------- */

const beanOverlay = document.getElementById('bean-overlay');
const beanForm = document.getElementById('bean-form');
const beanFormTitle = document.getElementById('bean-form-title');
const beanNameInput = document.getElementById('bean-name');
const beanDeleteBtn = document.getElementById('bean-delete');
const beanListView = document.getElementById('bean-list-view');
const beansEmpty = document.getElementById('beans-empty');
const beanRatingWidget = initStarRating(
  document.getElementById('bean-rating'),
  document.getElementById('bean-recommendRating')
);
let editingBeanId = null;

function refreshBeanFieldLists() {
  const fields = [
    ['roaster-list', 'roaster'],
    ['origin-list', 'origin'],
    ['process-list', 'process'],
    ['variety-list', 'variety'],
  ];
  fields.forEach(([listId, key]) => {
    const values = [...new Set(beans.map((b) => b[key]).filter(Boolean))];
    document.getElementById(listId).innerHTML =
      values.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  });
}

function refreshBeanSelect() {
  const select = document.getElementById('bean-select');
  const current = select.value;
  const options = sortedBeans().map((b) =>
    `<option value="${b.id}">${escapeHtml(b.name)}${b.roaster ? ' — ' + escapeHtml(b.roaster) : ''}</option>`
  ).join('');
  select.innerHTML = `<option value="" disabled ${beans.some((b) => b.id === current) ? '' : 'selected'}>Select a bean...</option>${options}`;
  if (beans.some((b) => b.id === current)) select.value = current;
}

function openBeanForm(bean) {
  editingBeanId = bean ? bean.id : null;
  beanFormTitle.textContent = bean ? 'Edit Bean' : 'Add Bean';
  beanForm.reset();
  beanForm.name.value = bean?.name || '';
  beanForm.roaster.value = bean?.roaster || '';
  beanForm.origin.value = bean?.origin || '';
  beanForm.process.value = bean?.process || '';
  beanForm.variety.value = bean?.variety || '';
  beanForm.elevation.value = bean?.elevation || '';
  beanForm.price.value = bean?.price || '';
  beanRatingWidget.setValue(bean?.recommendRating || 0);
  beanDeleteBtn.hidden = !bean;
  beanOverlay.hidden = false;
  beanNameInput.focus({ preventScroll: true });
}

function closeBeanForm() {
  beanOverlay.hidden = true;
  editingBeanId = null;
}

document.getElementById('new-bean-btn').addEventListener('click', () => openBeanForm(null));
document.getElementById('add-bean-link').addEventListener('click', () => {
  switchView('beans');
  openBeanForm(null);
});
document.getElementById('bean-overlay-close').addEventListener('click', closeBeanForm);
beanOverlay.addEventListener('click', (e) => {
  if (e.target === beanOverlay) closeBeanForm();
});

beanForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(beanForm);
  const name = (fd.get('name') || '').trim();
  if (!name) return;

  const existing = editingBeanId ? beans.find((b) => b.id === editingBeanId) : null;
  const bean = {
    id: editingBeanId || genId(),
    name,
    roaster: (fd.get('roaster') || '').trim(),
    origin: (fd.get('origin') || '').trim(),
    process: (fd.get('process') || '').trim(),
    variety: (fd.get('variety') || '').trim(),
    elevation: (fd.get('elevation') || '').trim(),
    price: (fd.get('price') || '').trim(),
    recommendRating: parseInt(fd.get('recommendRating'), 10) || 0,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  if (existing) {
    beans = beans.map((b) => (b.id === bean.id ? bean : b));
  } else {
    beans.unshift(bean);
  }
  await saveBeans(beans);
  refreshBeanFieldLists();
  refreshBeanSelect();
  renderBeans();
  closeBeanForm();
});

beanDeleteBtn.addEventListener('click', async () => {
  if (!editingBeanId) return;
  const linkedCount = shots.filter((s) => s.beanId === editingBeanId).length;
  const msg = linkedCount > 0
    ? `${linkedCount} logged shot${linkedCount === 1 ? '' : 's'} reference${linkedCount === 1 ? 's' : ''} this bean. They'll keep showing its name, but delete it from your catalog anyway?`
    : 'Delete this bean from your catalog?';
  if (!confirm(msg)) return;

  beans = beans.filter((b) => b.id !== editingBeanId);
  await saveBeans(beans);
  refreshBeanFieldLists();
  refreshBeanSelect();
  renderBeans();
  closeBeanForm();
});

function renderBeans() {
  beansEmpty.hidden = beans.length > 0;
  beanListView.innerHTML = sortedBeans().map((bean) => {
    const count = shots.filter((s) => s.beanId === bean.id).length;
    const sub = [bean.roaster, bean.origin].filter(Boolean).join(' · ');
    return `
      <li class="shot-card" data-id="${bean.id}">
        <div class="shot-card-top">
          <span class="shot-card-bean">${escapeHtml(bean.name)}</span>
        </div>
        ${sub ? `<div class="bean-card-sub">${escapeHtml(sub)}</div>` : ''}
        <div class="bean-card-meta">
          ${starsHtml(bean.recommendRating)}
          ${bean.price ? `<span>${escapeHtml(bean.price)}</span>` : ''}
          <span class="bean-card-count">${count} shot${count === 1 ? '' : 's'} logged</span>
        </div>
      </li>
    `;
  }).join('');
}

beanListView.addEventListener('click', (e) => {
  const card = e.target.closest('.shot-card');
  if (!card) return;
  const bean = beans.find((b) => b.id === card.dataset.id);
  if (bean) openBeanForm(bean);
});

/* ---------- log shot form ---------- */

const form = document.getElementById('shot-form');
const roastDateInput = document.getElementById('roastDate');
const doseInput = document.getElementById('doseGrams');
const doseValue = document.getElementById('doseGrams-value');
const yieldInput = document.getElementById('yieldGrams');
const grindInput = document.getElementById('grindSetting');
const grindValue = document.getElementById('grindSetting-value');
const preinfusionInput = document.getElementById('preinfusionSec');
const preinfusionValue = document.getElementById('preinfusionSec-value');
const ratioDisplay = document.getElementById('ratio-display');
const ratioValue = document.getElementById('ratio-value');
const shotRatingWidget = initStarRating(
  document.getElementById('shot-rating'),
  document.getElementById('rating')
);

function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function computeRatio(dose, yieldOut) {
  const d = parseFloat(dose);
  const y = parseFloat(yieldOut);
  if (!d || !y) return null;
  return y / d;
}

function updateRatioDisplay() {
  const ratio = computeRatio(doseInput.value, yieldInput.value);
  if (ratio) {
    ratioDisplay.hidden = false;
    ratioValue.textContent = `1 : ${ratio.toFixed(2)}`;
  } else {
    ratioDisplay.hidden = true;
  }
}

function updateDoseValue() {
  doseValue.textContent = `${parseFloat(doseInput.value).toFixed(1)} g`;
}

function updateGrindValue() {
  grindValue.textContent = parseFloat(grindInput.value).toFixed(1);
}

function updatePreinfusionValue() {
  preinfusionValue.textContent = `${preinfusionInput.value}s`;
}

doseInput.addEventListener('input', () => { updateDoseValue(); updateRatioDisplay(); });
yieldInput.addEventListener('input', updateRatioDisplay);
grindInput.addEventListener('input', updateGrindValue);
preinfusionInput.addEventListener('input', updatePreinfusionValue);

function resetFormDefaults() {
  roastDateInput.value = todayISO();
  updateDoseValue();
  updateGrindValue();
  updatePreinfusionValue();
  shotRatingWidget.setValue(0);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const beanId = fd.get('beanId') || null;
  const bean = beans.find((b) => b.id === beanId);

  const shot = {
    id: genId(),
    timestamp: new Date().toISOString(),
    beanId,
    beanName: bean ? bean.name : '',
    roastDate: fd.get('roastDate') || '',
    doseGrams: fd.get('doseGrams') ? parseFloat(fd.get('doseGrams')) : null,
    yieldGrams: fd.get('yieldGrams') ? parseFloat(fd.get('yieldGrams')) : null,
    grindSetting: fd.get('grindSetting') ? parseFloat(fd.get('grindSetting')) : null,
    preinfusionSec: fd.get('preinfusionSec') ? parseFloat(fd.get('preinfusionSec')) : null,
    shotTimeSec: fd.get('shotTimeSec') ? parseFloat(fd.get('shotTimeSec')) : null,
    brewMethod: fd.get('brewMethod') || 'Espresso',
    rating: fd.get('rating') ? parseInt(fd.get('rating'), 10) : 0,
    notes: (fd.get('notes') || '').trim(),
  };

  shots.unshift(shot);
  await saveShots(shots);
  renderBeans();

  form.reset();
  resetFormDefaults();
  ratioDisplay.hidden = true;
  switchView('history');
});

/* ---------- history list ---------- */

const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const searchInput = document.getElementById('history-search');

function matchesSearch(shot, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const bean = beans.find((b) => b.id === shot.beanId);
  const haystack = [
    getBeanLabel(shot),
    shot.notes,
    shot.brewMethod,
    shot.roastDate,
    bean?.roaster,
    bean?.origin,
    bean?.process,
    bean?.variety,
  ];
  return haystack.some((field) => (field || '').toLowerCase().includes(q));
}

function renderHistory() {
  const query = searchInput.value.trim();
  const filtered = shots.filter((s) => matchesSearch(s, query));

  historyEmpty.hidden = shots.length > 0;
  historyEmpty.textContent = shots.length === 0
    ? 'No shots logged yet. Pull an espresso and log it above.'
    : '';

  if (shots.length > 0 && filtered.length === 0) {
    historyList.innerHTML = '';
    historyEmpty.hidden = false;
    historyEmpty.textContent = 'No shots match your search.';
    return;
  }

  historyList.innerHTML = filtered.map((shot) => {
    const ratio = computeRatio(shot.doseGrams, shot.yieldGrams);
    const ratioStr = ratio ? `1:${ratio.toFixed(2)}` : '—';
    return `
      <li class="shot-card" data-id="${shot.id}">
        <div class="shot-card-top">
          <span class="shot-card-bean">${escapeHtml(getBeanLabel(shot))}</span>
          <span class="shot-card-date">${formatDate(shot.timestamp)}</span>
        </div>
        <div class="shot-card-meta">
          <span>${shot.doseGrams ?? '—'}g → ${shot.yieldGrams ?? '—'}g (${ratioStr})</span>
          <span>${shot.shotTimeSec ?? '—'}s</span>
          <span>${escapeHtml(shot.brewMethod || 'Espresso')}</span>
          ${shot.rating ? starsHtml(shot.rating) : ''}
        </div>
        ${shot.notes ? `<div class="shot-card-notes">${escapeHtml(shot.notes)}</div>` : ''}
      </li>
    `;
  }).join('');
}

searchInput.addEventListener('input', renderHistory);

/* ---------- detail overlay ---------- */

const overlay = document.getElementById('detail-overlay');
const detailBody = document.getElementById('detail-body');
const detailClose = document.getElementById('detail-close');
const detailDelete = document.getElementById('detail-delete');
let activeShotId = null;

function formatGrind(grindSetting) {
  if (grindSetting == null || grindSetting === '') return '—';
  return typeof grindSetting === 'number' ? grindSetting.toFixed(1) : String(grindSetting);
}

function detailRow(label, value) {
  return `<div class="detail-row"><span>${label}</span><span>${escapeHtml(value)}</span></div>`;
}

function beanInfoBlock(shot) {
  const bean = beans.find((b) => b.id === shot.beanId);
  if (!bean) return '';
  const rows = [
    ['Roaster', bean.roaster],
    ['Origin', bean.origin],
    ['Process', bean.process],
    ['Variety', bean.variety],
    ['Elevation', bean.elevation],
    ['Price', bean.price],
  ].filter(([, v]) => v);
  const ratingLine = bean.recommendRating
    ? `<div>Recommend: ${starsHtml(bean.recommendRating)}</div>` : '';
  if (rows.length === 0 && !ratingLine) return '';
  return `
    <div class="bean-info-block">
      ${rows.map(([k, v]) => `<div><strong>${k}:</strong> ${escapeHtml(v)}</div>`).join('')}
      ${ratingLine}
    </div>
  `;
}

historyList.addEventListener('click', (e) => {
  const card = e.target.closest('.shot-card');
  if (!card) return;
  const shot = shots.find((s) => s.id === card.dataset.id);
  if (!shot) return;
  activeShotId = shot.id;

  const ratio = computeRatio(shot.doseGrams, shot.yieldGrams);
  detailBody.innerHTML = `
    <h2>${escapeHtml(getBeanLabel(shot))}</h2>
    ${beanInfoBlock(shot)}
    ${detailRow('Logged', formatDate(shot.timestamp))}
    ${detailRow('Roast date', shot.roastDate || '—')}
    ${detailRow('Brew method', shot.brewMethod || 'Espresso')}
    ${detailRow('Dose in', shot.doseGrams != null ? `${shot.doseGrams} g` : '—')}
    ${detailRow('Yield out', shot.yieldGrams != null ? `${shot.yieldGrams} g` : '—')}
    ${detailRow('Ratio', ratio ? `1 : ${ratio.toFixed(2)}` : '—')}
    ${detailRow('Grind setting', formatGrind(shot.grindSetting))}
    ${detailRow('Preinfusion', shot.preinfusionSec != null ? `${shot.preinfusionSec} s` : '—')}
    ${detailRow('Shot time', shot.shotTimeSec != null ? `${shot.shotTimeSec} s` : '—')}
    <div class="detail-row"><span>Rating</span><span>${shot.rating ? starsHtml(shot.rating) : 'Not rated'}</span></div>
    ${shot.notes ? `<div class="detail-notes">${escapeHtml(shot.notes)}</div>` : ''}
  `;
  overlay.hidden = false;
});

detailClose.addEventListener('click', () => { overlay.hidden = true; activeShotId = null; });
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) { overlay.hidden = true; activeShotId = null; }
});

detailDelete.addEventListener('click', async () => {
  if (!activeShotId) return;
  shots = shots.filter((s) => s.id !== activeShotId);
  await saveShots(shots);
  overlay.hidden = true;
  activeShotId = null;
  renderHistory();
  renderBeans();
});

/* ---------- export / import ---------- */

document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ beans, shots }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `shot-log-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const importedShots = Array.isArray(parsed) ? parsed : (parsed.shots || []);
    const importedBeans = Array.isArray(parsed) ? [] : (parsed.beans || []);
    if (!Array.isArray(importedShots) || !Array.isArray(importedBeans)) {
      throw new Error('Invalid backup file');
    }

    const beanById = new Map(beans.map((b) => [b.id, b]));
    for (const bean of importedBeans) {
      if (bean && bean.id) beanById.set(bean.id, bean);
    }
    beans = [...beanById.values()];

    const shotById = new Map(shots.map((s) => [s.id, s]));
    for (const shot of importedShots) {
      if (shot && shot.id) shotById.set(shot.id, shot);
    }
    shots = [...shotById.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    await saveBeans(beans);
    await saveShots(shots);
    refreshBeanFieldLists();
    refreshBeanSelect();
    renderHistory();
    renderBeans();
    alert(`Imported ${importedShots.length} shots and ${importedBeans.length} beans.`);
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

/* ---------- init ---------- */

refreshBeanFieldLists();
refreshBeanSelect();
renderHistory();
renderBeans();
resetFormDefaults();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
