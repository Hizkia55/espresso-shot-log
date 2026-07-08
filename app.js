import { get, set } from './lib/idb-keyval.js';

const SHOTS_KEY = 'shots';

/* ---------- storage ---------- */

async function loadShots() {
  const shots = await get(SHOTS_KEY);
  return Array.isArray(shots) ? shots : [];
}

async function saveShots(shots) {
  await set(SHOTS_KEY, shots);
}

/* ---------- state ---------- */

let shots = await loadShots();

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
  if (name === 'log') {
    document.getElementById('bean').focus({ preventScroll: true });
  } else {
    renderHistory();
  }
}

/* ---------- log shot form ---------- */

const form = document.getElementById('shot-form');
const doseInput = document.getElementById('doseGrams');
const yieldInput = document.getElementById('yieldGrams');
const ratioDisplay = document.getElementById('ratio-display');
const ratioValue = document.getElementById('ratio-value');
const beanList = document.getElementById('bean-list');

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

doseInput.addEventListener('input', updateRatioDisplay);
yieldInput.addEventListener('input', updateRatioDisplay);

function refreshBeanList() {
  const names = [...new Set(shots.map((s) => s.bean).filter(Boolean))];
  beanList.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);

  const shot = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    bean: (fd.get('bean') || '').trim(),
    roastDate: fd.get('roastDate') || '',
    doseGrams: fd.get('doseGrams') ? parseFloat(fd.get('doseGrams')) : null,
    yieldGrams: fd.get('yieldGrams') ? parseFloat(fd.get('yieldGrams')) : null,
    grindSetting: (fd.get('grindSetting') || '').trim(),
    preinfusionSec: fd.get('preinfusionSec') ? parseFloat(fd.get('preinfusionSec')) : null,
    shotTimeSec: fd.get('shotTimeSec') ? parseFloat(fd.get('shotTimeSec')) : null,
    notes: (fd.get('notes') || '').trim(),
  };

  shots.unshift(shot);
  await saveShots(shots);
  refreshBeanList();

  form.reset();
  ratioDisplay.hidden = true;
  switchView('history');
});

/* ---------- history list ---------- */

const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const searchInput = document.getElementById('history-search');

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

function matchesSearch(shot, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (shot.bean || '').toLowerCase().includes(q) ||
    (shot.notes || '').toLowerCase().includes(q);
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
          <span class="shot-card-bean">${escapeHtml(shot.bean || 'Unnamed bean')}</span>
          <span class="shot-card-date">${formatDate(shot.timestamp)}</span>
        </div>
        <div class="shot-card-meta">
          <span>${shot.doseGrams ?? '—'}g → ${shot.yieldGrams ?? '—'}g (${ratioStr})</span>
          <span>${shot.shotTimeSec ?? '—'}s</span>
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

function detailRow(label, value) {
  return `<div class="detail-row"><span>${label}</span><span>${escapeHtml(value)}</span></div>`;
}

historyList.addEventListener('click', (e) => {
  const card = e.target.closest('.shot-card');
  if (!card) return;
  const shot = shots.find((s) => s.id === card.dataset.id);
  if (!shot) return;
  activeShotId = shot.id;

  const ratio = computeRatio(shot.doseGrams, shot.yieldGrams);
  detailBody.innerHTML = `
    <h2>${escapeHtml(shot.bean || 'Unnamed bean')}</h2>
    ${detailRow('Logged', formatDate(shot.timestamp))}
    ${detailRow('Roast date', shot.roastDate || '—')}
    ${detailRow('Dose in', shot.doseGrams != null ? `${shot.doseGrams} g` : '—')}
    ${detailRow('Yield out', shot.yieldGrams != null ? `${shot.yieldGrams} g` : '—')}
    ${detailRow('Ratio', ratio ? `1 : ${ratio.toFixed(2)}` : '—')}
    ${detailRow('Grind setting', shot.grindSetting || '—')}
    ${detailRow('Preinfusion', shot.preinfusionSec != null ? `${shot.preinfusionSec} s` : '—')}
    ${detailRow('Shot time', shot.shotTimeSec != null ? `${shot.shotTimeSec} s` : '—')}
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
  refreshBeanList();
  overlay.hidden = true;
  activeShotId = null;
  renderHistory();
});

/* ---------- export / import ---------- */

document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(shots, null, 2)], { type: 'application/json' });
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
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error('Invalid backup file');

    const byId = new Map(shots.map((s) => [s.id, s]));
    for (const shot of imported) {
      if (shot && shot.id) byId.set(shot.id, shot);
    }
    shots = [...byId.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    await saveShots(shots);
    refreshBeanList();
    renderHistory();
    alert(`Imported ${imported.length} shots.`);
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

/* ---------- init ---------- */

refreshBeanList();
renderHistory();
document.getElementById('bean').focus({ preventScroll: true });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
