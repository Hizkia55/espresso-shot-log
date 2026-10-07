import { get, set } from './lib/idb-keyval.js';
import { COUNTRIES, matchCountry } from './lib/countries.js';
import {
  SCHEMA_VERSION, EUR_DKK, migrateV1, suggestOpenBags, normalizeBackup, mergeImport,
  exportPayload, snapSpelling, pricePer100, per100InDKK, sortShots,
} from './data.js';

const KEYS = { meta: 'meta', coffees: 'coffees', bags: 'bags', shots: 'shots' };

const BALANCE = [
  { v: -2, label: 'Very bitter' },
  { v: -1, label: 'Bitter' },
  { v: 0, label: 'Balanced' },
  { v: 1, label: 'Sour' },
  { v: 2, label: 'Very sour' },
];
const FLAVOUR_TAGS = ['Fruity', 'Citrus', 'Berry', 'Floral', 'Chocolate', 'Caramel', 'Nutty', 'Sweet'];

function genId() {
  return window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ---------- storage & migration ---------- */

async function loadState() {
  const meta = (await get(KEYS.meta)) || {};
  if (meta.schemaVersion >= SCHEMA_VERSION) {
    return {
      meta,
      coffees: (await get(KEYS.coffees)) || [],
      bags: (await get(KEYS.bags)) || [],
      shots: (await get(KEYS.shots)) || [],
    };
  }

  // First launch on v2: migrate whatever v1 left behind.
  const v1Beans = (await get('beans')) || [];
  const v1Shots = (await get(KEYS.shots)) || [];
  const hadData = v1Beans.length > 0 || v1Shots.length > 0;
  if (hadData) await set('v1-backup', { beans: v1Beans, shots: v1Shots, savedAt: new Date().toISOString() });

  const migrated = migrateV1({ beans: v1Beans, shots: v1Shots });
  const newMeta = {
    schemaVersion: SCHEMA_VERSION,
    needsBagReview: migrated.bags.length > 0,
    migrationChanges: migrated.changes,
    migratedAt: new Date().toISOString(),
  };
  await set(KEYS.coffees, migrated.coffees);
  await set(KEYS.bags, migrated.bags);
  await set(KEYS.shots, migrated.shots);
  await set(KEYS.meta, newMeta);
  return { meta: newMeta, coffees: migrated.coffees, bags: migrated.bags, shots: migrated.shots };
}

let { meta, coffees, bags, shots } = await loadState();

const saveCoffees = () => set(KEYS.coffees, coffees);
const saveBags = () => set(KEYS.bags, bags);
const saveShots = () => set(KEYS.shots, shots);
const saveMeta = () => set(KEYS.meta, meta);

/* ---------- lookups ---------- */

const coffeeById = (id) => coffees.find((c) => c.id === id);
const bagById = (id) => bags.find((b) => b.id === id);
const bagsOf = (coffeeId) => bags
  .filter((b) => b.coffeeId === coffeeId)
  .sort((a, b) => (b.roastDate || b.createdAt).localeCompare(a.roastDate || a.createdAt));
const shotsOfCoffee = (coffeeId) => shots.filter((s) => s.coffeeId === coffeeId);
const shotsOfBag = (bagId) => shots.filter((s) => s.bagId === bagId);

function coffeeOfShot(shot) {
  return coffeeById(shot.coffeeId) || coffeeById(bagById(shot.bagId)?.coffeeId);
}

function shotLabel(shot) {
  return coffeeOfShot(shot)?.name || shot.beanName || shot.bean || 'Unknown bean';
}

function daysSinceRoast(shot) {
  const roastDate = shot.roastDateAtLog || bagById(shot.bagId)?.roastDate;
  if (!roastDate) return null;
  const roast = new Date(`${roastDate}T00:00:00`);
  const d = new Date(shot.timestamp);
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - roast) / 86400000);
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const then = new Date(`${isoDate}T00:00:00`);
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
}

function bestShot(list) {
  return list
    .filter((s) => s.rating != null)
    .sort((a, b) => b.rating - a.rating || new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
}

function stats(list) {
  const rated = list.filter((s) => s.rating != null);
  return {
    count: list.length,
    avg: rated.length ? rated.reduce((n, s) => n + s.rating, 0) / rated.length : null,
    best: rated.length ? Math.max(...rated.map((s) => s.rating)) : null,
  };
}

/* ---------- formatting ---------- */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDay(isoOrDate) {
  if (!isoOrDate) return '';
  const d = isoOrDate.length === 10 ? new Date(`${isoOrDate}T00:00:00`) : new Date(isoOrDate);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function money(a, cur) {
  return cur === 'DKK' ? a.toFixed(2) + ' kr' : '€' + a.toFixed(2);
}

function priceText(bag) {
  if (bag?.priceAmount == null) return '';
  return money(Number(bag.priceAmount), bag.currency) + (bag.bagGrams ? ` / ${bag.bagGrams}g` : '');
}

function per100Text(bag, withConversion) {
  const per = pricePer100(bag);
  if (per == null) return '';
  const c = bag.currency === 'DKK' ? 'DKK' : 'EUR';
  let out = money(per, c) + ' / 100g';
  if (withConversion) {
    out += ' · ≈ ' + money(c === 'EUR' ? per * EUR_DKK : per / EUR_DKK, c === 'EUR' ? 'DKK' : 'EUR');
  }
  return out;
}

function ratingPill(n) {
  if (n == null) return '';
  const tier = n >= 8 ? 'hi' : n >= 5 ? 'mid' : 'lo';
  return `<span class="rating-pill ${tier}">${n}<small>/10</small></span>`;
}

const balanceLabel = (v) => BALANCE.find((b) => b.v === v)?.label || '';

function ratioOf(shot) {
  const isEsp = shot.brewMethod !== 'Filter';
  const out = isEsp ? shot.yieldGrams : shot.volumeMl;
  const d = parseFloat(shot.doseGrams), o = parseFloat(out);
  return d && o ? o / d : null;
}

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/* Case-insensitive unique values, keeping the first spelling seen. */
function uniqueValues(values) {
  const map = new Map();
  for (const v of values) if (v && !map.has(v.toLowerCase())) map.set(v.toLowerCase(), v);
  return [...map.values()].sort((a, b) => a.localeCompare(b));
}

const eq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

/* ---------- overlays ---------- */

let zTop = 100;
function openOverlay(el) {
  el.style.zIndex = String(++zTop);
  el.hidden = false;
}
function closeOverlay(el) {
  el.hidden = true;
  el.dispatchEvent(new Event('overlay-closed'));
}
document.querySelectorAll('.overlay').forEach((ov) => {
  if (ov.id === 'review-overlay') return; // must be answered
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('[data-close]')) closeOverlay(ov);
  });
});

/* ---------- widgets ---------- */

/** 0–10 tap row. Tapping the selected score again clears it (→ null). */
function initScoreRow(container, readout) {
  container.innerHTML = Array.from({ length: 11 }, (_, i) =>
    `<button type="button" role="radio" aria-checked="false" data-score="${i}">${i}</button>`).join('');
  const buttons = [...container.querySelectorAll('button')];
  let value = null;
  function setValue(v) {
    value = v == null || v === '' ? null : Number(v);
    buttons.forEach((b) => {
      const n = Number(b.dataset.score);
      b.classList.toggle('on', value != null && n <= value);
      b.classList.toggle('picked', n === value);
      b.setAttribute('aria-checked', String(n === value));
    });
    if (readout) readout.textContent = value == null ? 'Not rated' : `${value} / 10`;
  }
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const n = Number(b.dataset.score);
    setValue(n === value ? null : n);
  });
  setValue(null);
  return { setValue, get value() { return value; } };
}

/** Wire one copy of the bag fields (roast date, price, size, currency). */
function initBagFields(container) {
  container.replaceChildren(document.getElementById('bag-fields-tpl').content.cloneNode(true));
  const q = (sel) => container.querySelector(sel);
  const price = q('[name="priceAmount"]');
  const grams = q('[name="bagGrams"]');
  const roast = q('[name="roastDate"]');
  const curInput = q('[name="currency"]');
  const seg = q('.currency-seg');
  const per100 = q('[data-per100]');
  let currency = 'DKK';

  function setCurrency(c) {
    currency = c === 'EUR' ? 'EUR' : 'DKK';
    curInput.value = currency;
    seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.currency === currency));
    update();
  }
  function update() {
    const s = per100Text({ priceAmount: price.value, bagGrams: grams.value, currency }, true);
    per100.hidden = !s;
    per100.textContent = s;
  }
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) setCurrency(b.dataset.currency);
  });
  price.addEventListener('input', update);
  grams.addEventListener('input', update);

  return {
    fill(bag) {
      roast.value = bag?.roastDate ?? todayISO();
      price.value = bag?.priceAmount ?? '';
      grams.value = bag?.bagGrams ?? 250;
      setCurrency(bag?.currency || lastCurrency());
    },
    read() {
      return {
        roastDate: roast.value || '',
        priceAmount: price.value ? parseFloat(price.value) : null,
        bagGrams: grams.value ? parseFloat(grams.value) : null,
        currency,
      };
    },
  };
}

function lastCurrency() {
  const latest = [...bags].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  return latest?.currency || 'DKK';
}

/* ---------- tabs ---------- */

const tabButtons = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view');
tabButtons.forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

function switchView(name) {
  tabButtons.forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  views.forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') renderHistory();
  else if (name === 'beans') renderBeans();
}

/* ---------- filter panels (shared) ---------- */

function setupFilterPanel({ btn, panel, clearBtn, chipsEl, countEl, state, defaults, labels, onChange }) {
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', String(!panel.hidden));
  });
  panel.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      state[el.dataset.key] = el.value;
      onChange();
    });
  });
  clearBtn.addEventListener('click', () => {
    Object.assign(state, defaults);
    syncInputs();
    onChange();
  });
  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-clear]');
    if (!chip) return;
    state[chip.dataset.clear] = defaults[chip.dataset.clear];
    syncInputs();
    onChange();
  });
  function syncInputs() {
    panel.querySelectorAll('[data-key]').forEach((el) => { el.value = state[el.dataset.key] ?? ''; });
  }
  function renderChips() {
    const active = Object.keys(labels).filter((k) => state[k] && state[k] !== defaults[k]);
    chipsEl.innerHTML = active.map((k) =>
      `<button type="button" class="chip on" data-clear="${k}">${escapeHtml(labels[k](state[k]))} <span aria-hidden="true">×</span></button>`).join('');
    countEl.hidden = active.length === 0;
    countEl.textContent = active.length;
  }
  return { syncInputs, renderChips };
}

function fillSelect(select, options, anyLabel = 'All') {
  const current = select.value;
  select.innerHTML = `<option value="">${anyLabel}</option>` +
    options.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  select.value = options.some(([v]) => String(v) === current) ? current : '';
}

/* ---------- beans view ---------- */

const beanListView = document.getElementById('bean-list-view');
const beansEmpty = document.getElementById('beans-empty');
const beanSearch = document.getElementById('bean-search');
const beanStatusSeg = document.getElementById('bean-status-seg');

const bfDefaults = { roaster: '', country: '', process: '', sort: 'recent' };
const bf = { ...bfDefaults };
let beanStatus = 'open';

const beanFilters = setupFilterPanel({
  btn: document.getElementById('bean-filter-btn'),
  panel: document.getElementById('bean-filter-panel'),
  clearBtn: document.getElementById('bean-filter-clear'),
  chipsEl: document.getElementById('bean-active-filters'),
  countEl: document.getElementById('bean-filter-count'),
  state: bf,
  defaults: bfDefaults,
  labels: {
    roaster: (v) => v,
    country: (v) => v,
    process: (v) => v,
    sort: (v) => 'Sort: ' + document.querySelector(`#bf-sort option[value="${v}"]`).textContent,
  },
  onChange: renderBeans,
});

beanStatusSeg.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  beanStatus = b.dataset.status;
  beanStatusSeg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  renderBeans();
});
beanSearch.addEventListener('input', renderBeans);

function refreshBeanFilterOptions() {
  fillSelect(document.getElementById('bf-roaster'), uniqueValues(coffees.map((c) => c.roaster)).map((v) => [v, v]));
  fillSelect(document.getElementById('bf-country'), uniqueValues(coffees.flatMap((c) => c.countries || [])).map((v) => [v, v]));
  fillSelect(document.getElementById('bf-process'), uniqueValues(coffees.map((c) => c.process)).map((v) => [v, v]));
}

function coffeeStatus(coffee) {
  const cb = bagsOf(coffee.id);
  return cb.some((b) => b.status !== 'finished') ? 'open' : 'finished';
}

function renderBeans() {
  refreshBeanFilterOptions();
  beanFilters.syncInputs();
  beanFilters.renderChips();
  const q = beanSearch.value.trim().toLowerCase();

  let list = coffees.filter((c) => {
    if (beanStatus !== 'all' && coffeeStatus(c) !== beanStatus) return false;
    if (bf.roaster && !eq(c.roaster, bf.roaster)) return false;
    if (bf.country && !(c.countries || []).some((x) => eq(x, bf.country))) return false;
    if (bf.process && !eq(c.process, bf.process)) return false;
    if (q) {
      const hay = [c.name, c.roaster, c.region, c.process, c.variety, ...(c.countries || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const latestBag = (c) => bagsOf(c.id)[0];
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    recent: (a, b) => ((latestBag(b)?.roastDate || latestBag(b)?.createdAt || '')
      .localeCompare(latestBag(a)?.roastDate || latestBag(a)?.createdAt || '')),
    rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
    avg: (a, b) => (stats(shotsOfCoffee(b.id)).avg ?? -1) - (stats(shotsOfCoffee(a.id)).avg ?? -1),
    price: (a, b) => (per100InDKK(latestBag(a)) ?? Infinity) - (per100InDKK(latestBag(b)) ?? Infinity),
  };
  list = list.sort(sorters[bf.sort] || sorters.recent);

  beansEmpty.hidden = list.length > 0;
  beansEmpty.textContent = coffees.length === 0
    ? 'No beans in your catalog yet. Add one to start logging shots against it.'
    : beanStatus === 'open' && !q && !bf.roaster && !bf.country && !bf.process
      ? 'No open bags. Buy again from a finished coffee, or add a new bean.'
      : 'No beans match these filters.';

  beanListView.innerHTML = list.map((c) => {
    const cb = bagsOf(c.id);
    const open = cb.filter((b) => b.status !== 'finished');
    const st = stats(shotsOfCoffee(c.id));
    const sub = [c.roaster, (c.countries || []).join(' & '), c.process].filter(Boolean).join(' · ');
    const bagLine = open.length
      ? open.map((b) => `<span class="bag-tag open">Open · roasted ${formatDay(b.roastDate)}${b.roastDate ? ` · ${daysSince(b.roastDate)}d` : ''}</span>`).join('')
      : `<span class="bag-tag">${cb.length} bag${cb.length === 1 ? '' : 's'} · finished</span>`;
    const per = per100Text(cb[0], false);
    return `
      <li class="shot-card" data-id="${c.id}">
        <div class="shot-card-top">
          <span class="shot-card-bean">${escapeHtml(c.name)}</span>
          ${ratingPill(c.rating)}
        </div>
        ${sub ? `<div class="bean-card-sub">${escapeHtml(sub)}</div>` : ''}
        <div class="bean-card-bags">${bagLine}</div>
        <div class="bean-card-meta">
          <span>${st.count} shot${st.count === 1 ? '' : 's'}${st.avg != null ? ` · avg ${st.avg.toFixed(1)} · best ${st.best}` : ''}</span>
          ${per ? `<span class="bean-card-count">${escapeHtml(per)}</span>` : ''}
        </div>
      </li>`;
  }).join('');
}

beanListView.addEventListener('click', (e) => {
  const card = e.target.closest('.shot-card');
  if (card) openCoffeeDetail(card.dataset.id);
});

/* ---------- coffee detail ---------- */

const coffeeOverlay = document.getElementById('coffee-overlay');
const coffeeBody = document.getElementById('coffee-body');
let activeCoffeeId = null;

function openCoffeeDetail(coffeeId) {
  activeCoffeeId = coffeeId;
  renderCoffeeDetail();
  openOverlay(coffeeOverlay);
}

function renderCoffeeDetail() {
  const c = coffeeById(activeCoffeeId);
  if (!c) { closeOverlay(coffeeOverlay); return; }
  const cb = bagsOf(c.id);
  const cs = shotsOfCoffee(c.id);
  const st = stats(cs);
  const info = [
    ['Roaster', c.roaster],
    ['Country', (c.countries || []).join(' & ')],
    ['Region', c.region],
    ['Process', c.process],
    ['Variety', c.variety],
    ['Elevation', c.elevation],
  ].filter(([, v]) => v);

  coffeeBody.innerHTML = `
    <h2>${escapeHtml(c.name)}</h2>
    <div class="bean-info-block">
      ${info.map(([k, v]) => `<div><strong>${k}:</strong> ${escapeHtml(v)}</div>`).join('')}
      <div><strong>Your rating:</strong> ${c.rating != null ? ratingPill(c.rating) : 'not rated'}</div>
    </div>
    <div class="stat-tiles">
      <div><span>${st.count}</span>shots</div>
      <div><span>${st.avg != null ? st.avg.toFixed(1) : '—'}</span>avg rating</div>
      <div><span>${st.best ?? '—'}</span>best</div>
    </div>

    <h3>Bags</h3>
    <ul class="bag-list">
      ${cb.map((b) => {
        const n = shotsOfBag(b.id).length;
        const open = b.status !== 'finished';
        return `
          <li class="bag-item ${open ? 'open' : ''}" data-bag="${b.id}">
            <div>
              <strong>Roasted ${b.roastDate ? formatDay(b.roastDate) : '—'}</strong>
              <span class="bag-status">${open ? 'Open' : `Finished${b.finishedAt ? ' ' + formatDay(b.finishedAt) : ''}`}</span>
              <div class="bag-sub">${[priceText(b), per100Text(b, false), `${n} shot${n === 1 ? '' : 's'}`].filter(Boolean).map(escapeHtml).join(' · ')}</div>
            </div>
            <div class="bag-actions">
              <button type="button" class="ghost-btn small" data-bag-action="toggle">${open ? 'Finished' : 'Reopen'}</button>
              <button type="button" class="text-link" data-bag-action="edit">Edit</button>
            </div>
          </li>`;
      }).join('')}
    </ul>

    <h3>Dial-in</h3>
    ${dialInHtml(c, cs, cb)}
  `;
  wireDialIn(coffeeBody, cs);
}

coffeeBody.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-bag-action]');
  if (act) {
    const bag = bagById(act.closest('[data-bag]').dataset.bag);
    if (!bag) return;
    if (act.dataset.bagAction === 'toggle') {
      const finishing = bag.status !== 'finished';
      bag.status = finishing ? 'finished' : 'open';
      bag.finishedAt = finishing ? todayISO() : null;
      await saveBags();
      refreshAll();
    } else {
      openBagForm(bag.coffeeId, bag);
    }
    return;
  }
  const row = e.target.closest('[data-shot]');
  if (row) openShotDetail(row.dataset.shot);
});

document.getElementById('coffee-new-bag').addEventListener('click', () => openBagForm(activeCoffeeId, null));
document.getElementById('coffee-edit').addEventListener('click', () => openCoffeeForm(coffeeById(activeCoffeeId)));

/* ---------- dial-in chart ---------- */

function dialInHtml(coffee, cs, cb) {
  const pts = cs.filter((s) => s.rating != null && s.grindSetting != null && s.brewMethod !== 'Filter');
  if (pts.length < 2) {
    return `<p class="muted-note">Log at least two rated espresso shots on this coffee to see how grind relates to taste.</p>`;
  }
  const W = 320, H = 190, m = { t: 12, r: 12, b: 34, l: 30 };
  const gs = pts.map((s) => s.grindSetting);
  let gMin = Math.floor((Math.min(...gs) - 0.2) * 2) / 2;
  let gMax = Math.ceil((Math.max(...gs) + 0.2) * 2) / 2;
  if (gMax - gMin < 1) { gMin -= 0.5; gMax += 0.5; }
  const x = (g) => m.l + (g - gMin) / (gMax - gMin) * (W - m.l - m.r);
  const y = (r) => m.t + (1 - r / 10) * (H - m.t - m.b);
  const step = gMax - gMin > 4 ? 1 : 0.5;
  const xTicks = [];
  for (let g = Math.ceil(gMin / step) * step; g <= gMax + 1e-9; g += step) xTicks.push(Math.round(g * 10) / 10);

  const latestBagId = cb[0]?.id;
  const multiBag = new Set(pts.map((s) => s.bagId)).size > 1;
  const best = bestShot(pts);

  const grid = [0, 2, 4, 6, 8, 10].map((r) =>
    `<line x1="${m.l}" x2="${W - m.r}" y1="${y(r)}" y2="${y(r)}" class="grid"/>
     <text x="${m.l - 8}" y="${y(r) + 4}" class="tick" text-anchor="end">${r}</text>`).join('');
  const xAxis = xTicks.map((g) =>
    `<text x="${x(g)}" y="${H - m.b + 16}" class="tick" text-anchor="middle">${g.toFixed(1)}</text>`).join('');
  const dots = pts.map((s) => {
    const older = multiBag && s.bagId !== latestBagId;
    return `<circle cx="${x(s.grindSetting)}" cy="${y(s.rating)}" r="${s === best ? 7 : 5.5}"
      class="dot ${older ? 'older' : ''} ${s === best ? 'best' : ''}" data-shot="${s.id}" tabindex="0"/>`;
  }).join('');
  // Invisible bigger hit targets so a fingertip finds the dot.
  const hits = pts.map((s) =>
    `<circle cx="${x(s.grindSetting)}" cy="${y(s.rating)}" r="16" class="hit" data-hit="${s.id}"/>`).join('');

  const legend = multiBag
    ? `<div class="chart-legend"><span><i class="sw now"></i>Latest bag</span><span><i class="sw older"></i>Earlier bags</span><span><i class="sw ring"></i>Best shot</span></div>`
    : `<div class="chart-legend"><span><i class="sw ring"></i>Best shot</span></div>`;

  const rows = [...pts].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).map((s) => {
    const r = ratioOf(s);
    return `<tr data-shot="${s.id}" class="${s === best ? 'best' : ''}">
      <td>${formatDay(s.timestamp)}</td>
      <td>${s.grindSetting.toFixed(1)}</td>
      <td>${s.doseGrams ?? '—'}→${s.yieldGrams ?? '—'}${r ? ` <small>1:${r.toFixed(1)}</small>` : ''}</td>
      <td>${s.shotTimeSec ?? '—'}s</td>
      <td>${s.rating}</td>
    </tr>`;
  }).join('');

  return `
    <figure class="dialin">
      <figcaption>Rating by grind setting <small>(finer ← → coarser)</small></figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of shot rating against grind setting">
        ${grid}${xAxis}
        <text x="${(m.l + W - m.r) / 2}" y="${H - 4}" class="axis-label" text-anchor="middle">Grind</text>
        ${dots}${hits}
      </svg>
      ${legend}
      <div class="dialin-tip" id="dialin-tip">Tap a dot for details. Best: ${best.rating}/10 at grind ${best.grindSetting.toFixed(1)}.</div>
    </figure>
    <table class="dialin-table">
      <thead><tr><th>Date</th><th>Grind</th><th>In→Out</th><th>Time</th><th>/10</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function wireDialIn(root, cs) {
  const tip = root.querySelector('#dialin-tip');
  if (!tip) return;
  const show = (id) => {
    const s = cs.find((x) => x.id === id);
    if (!s) return;
    root.querySelectorAll('.dot').forEach((d) => d.classList.toggle('active', d.dataset.shot === id));
    const r = ratioOf(s);
    tip.innerHTML = `<strong>${formatDay(s.timestamp)} · ${s.rating}/10</strong> — grind ${s.grindSetting.toFixed(1)}, ` +
      `${s.doseGrams ?? '—'}g → ${s.yieldGrams ?? '—'}g${r ? ` (1:${r.toFixed(2)})` : ''}, ${s.shotTimeSec ?? '—'}s` +
      `${s.balance != null ? ` · ${balanceLabel(s.balance).toLowerCase()}` : ''}` +
      `${s.notes ? `<br><span>${escapeHtml(s.notes)}</span>` : ''}`;
  };
  root.querySelectorAll('[data-hit]').forEach((h) => {
    h.addEventListener('pointerenter', () => show(h.dataset.hit));
    h.addEventListener('click', (e) => { e.stopPropagation(); show(h.dataset.hit); });
  });
}

/* ---------- coffee form ---------- */

const coffeeFormOverlay = document.getElementById('coffee-form-overlay');
const coffeeForm = document.getElementById('coffee-form');
const coffeeFormTitle = document.getElementById('coffee-form-title');
const coffeeDupe = document.getElementById('coffee-dupe');
const coffeeDeleteBtn = document.getElementById('coffee-delete');
const firstBagFieldset = document.getElementById('coffee-first-bag');
const firstBagFields = initBagFields(firstBagFieldset.querySelector('[data-bag-fields]'));
const coffeeRating = initScoreRow(document.getElementById('coffee-rating'), document.getElementById('coffee-rating-readout'));
let editingCoffeeId = null;
let returnToLogAfterCoffee = false;

/* country picker: chips + a type-ahead input limited to real countries */
const countryInput = document.getElementById('country-input');
const countryChips = document.getElementById('country-chips');
const countryHint = document.getElementById('country-hint');
document.getElementById('country-list').innerHTML = COUNTRIES.map((c) => `<option value="${c}"></option>`).join('');
let pickedCountries = [];

function renderCountryChips() {
  countryChips.innerHTML = pickedCountries.map((c) =>
    `<button type="button" class="chip on" data-country="${escapeHtml(c)}">${escapeHtml(c)} <span aria-hidden="true">×</span></button>`).join('');
  countryChips.hidden = pickedCountries.length === 0;
}
function tryAddCountry(force) {
  const c = matchCountry(countryInput.value);
  if (c) {
    if (!pickedCountries.includes(c)) pickedCountries.push(c);
    countryInput.value = '';
    countryHint.classList.remove('warn');
    countryHint.textContent = 'Pick from the list. Add more than one for a blend.';
    renderCountryChips();
    return true;
  }
  if (force && countryInput.value.trim()) {
    countryHint.classList.add('warn');
    countryHint.textContent = `“${countryInput.value.trim()}” isn't a country in the list. Put a region in Region / farm.`;
  }
  return false;
}
countryInput.addEventListener('input', (e) => {
  // Picking from the suggestion list fills the full name; take it right away.
  // Plain typing doesn't, or "Dominica" would grab you before "Dominican Republic".
  if (e.inputType === 'insertText' || (e.inputType || '').startsWith('delete')) return;
  if (COUNTRIES.includes(countryInput.value)) tryAddCountry(false);
});
countryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); tryAddCountry(true); }
  if (e.key === 'Backspace' && !countryInput.value && pickedCountries.length) {
    pickedCountries.pop();
    renderCountryChips();
  }
});
countryInput.addEventListener('blur', () => tryAddCountry(true));
countryChips.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-country]');
  if (!chip) return;
  pickedCountries = pickedCountries.filter((c) => c !== chip.dataset.country);
  renderCountryChips();
});

function refreshCoffeeFieldLists() {
  const lists = [['roaster-list', 'roaster'], ['process-list', 'process'], ['variety-list', 'variety']];
  for (const [id, key] of lists) {
    document.getElementById(id).innerHTML = uniqueValues(coffees.map((c) => c[key]))
      .map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  }
}

function openCoffeeForm(coffee, { returnToLog = false } = {}) {
  editingCoffeeId = coffee ? coffee.id : null;
  returnToLogAfterCoffee = returnToLog;
  coffeeFormTitle.textContent = coffee ? 'Edit coffee' : 'Add Bean';
  coffeeForm.reset();
  coffeeForm.name.value = coffee?.name || '';
  coffeeForm.roaster.value = coffee?.roaster || '';
  coffeeForm.region.value = coffee?.region || '';
  coffeeForm.process.value = coffee?.process || '';
  coffeeForm.variety.value = coffee?.variety || '';
  coffeeForm.elevation.value = coffee?.elevation || '';
  pickedCountries = [...(coffee?.countries || [])];
  countryInput.value = '';
  countryHint.classList.remove('warn');
  renderCountryChips();
  coffeeRating.setValue(coffee?.rating ?? null);
  firstBagFieldset.hidden = !!coffee;
  if (!coffee) firstBagFields.fill(null);
  coffeeDupe.hidden = true;
  coffeeDeleteBtn.hidden = !coffee;
  openOverlay(coffeeFormOverlay);
}

coffeeForm.name.addEventListener('input', () => {
  const name = coffeeForm.name.value.trim();
  const dupe = name && coffees.find((c) => c.id !== editingCoffeeId && eq(c.name, name));
  coffeeDupe.hidden = !dupe;
  if (dupe) {
    coffeeDupe.innerHTML = `You already have <strong>${escapeHtml(dupe.name)}</strong>${dupe.roaster ? ` from ${escapeHtml(dupe.roaster)}` : ''}. ` +
      (editingCoffeeId ? '' : `<button type="button" class="text-link" data-new-bag-for="${dupe.id}">Add a new bag to it instead</button>`);
  }
});
coffeeDupe.addEventListener('click', (e) => {
  const b = e.target.closest('[data-new-bag-for]');
  if (!b) return;
  closeOverlay(coffeeFormOverlay);
  openBagForm(b.dataset.newBagFor, null, { returnToLog: returnToLogAfterCoffee });
});

coffeeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  tryAddCountry(false);
  const fd = new FormData(coffeeForm);
  const name = (fd.get('name') || '').trim();
  if (!name) return;
  const existing = editingCoffeeId ? coffeeById(editingCoffeeId) : null;
  const others = coffees.filter((c) => c.id !== editingCoffeeId);
  const coffee = {
    id: existing?.id || genId(),
    name,
    // Snap to an existing spelling so "Sp" and "SP" never split again.
    roaster: snapSpelling(fd.get('roaster'), others.map((c) => c.roaster)),
    countries: [...pickedCountries],
    region: (fd.get('region') || '').trim(),
    process: snapSpelling(fd.get('process'), others.map((c) => c.process)),
    variety: (fd.get('variety') || '').trim(),
    elevation: (fd.get('elevation') || '').trim(),
    rating: coffeeRating.value,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  let newBag = null;
  if (existing) {
    coffees = coffees.map((c) => (c.id === coffee.id ? coffee : c));
    // Keep shot snapshots in sync with a rename.
    shots.forEach((s) => { if (s.coffeeId === coffee.id) s.beanName = coffee.name; });
    await saveShots();
  } else {
    coffees.unshift(coffee);
    newBag = { id: genId(), coffeeId: coffee.id, ...firstBagFields.read(), status: 'open', finishedAt: null, createdAt: new Date().toISOString() };
    bags.unshift(newBag);
    await saveBags();
  }
  await saveCoffees();
  closeOverlay(coffeeFormOverlay);
  afterCatalogChange(newBag, returnToLogAfterCoffee);
});

coffeeDeleteBtn.addEventListener('click', async () => {
  const c = coffeeById(editingCoffeeId);
  if (!c) return;
  const n = shotsOfCoffee(c.id).length;
  const msg = n
    ? `${n} logged shot${n === 1 ? '' : 's'} use this coffee. They'll keep its name, but delete the coffee and all its bags?`
    : 'Delete this coffee and its bags?';
  if (!confirm(msg)) return;
  coffees = coffees.filter((x) => x.id !== c.id);
  bags = bags.filter((b) => b.coffeeId !== c.id);
  await saveCoffees();
  await saveBags();
  closeOverlay(coffeeFormOverlay);
  closeOverlay(coffeeOverlay);
  refreshAll();
});

/* ---------- bag form ---------- */

const bagFormOverlay = document.getElementById('bag-form-overlay');
const bagForm = document.getElementById('bag-form');
const bagFields = initBagFields(bagForm.querySelector('[data-bag-fields]'));
const bagDeleteBtn = document.getElementById('bag-delete');
let bagFormCtx = { coffeeId: null, bagId: null, returnToLog: false };

function openBagForm(coffeeId, bag, { returnToLog = false } = {}) {
  const coffee = coffeeById(coffeeId);
  if (!coffee) return;
  bagFormCtx = { coffeeId, bagId: bag?.id || null, returnToLog };
  document.getElementById('bag-form-title').textContent = bag ? `Edit bag · ${coffee.name}` : `New bag · ${coffee.name}`;
  if (bag) {
    bagFields.fill(bag);
  } else {
    // Buying the same coffee again: same price and size as last time, new roast date.
    const last = bagsOf(coffeeId)[0];
    bagFields.fill(last ? { ...last, roastDate: todayISO() } : null);
  }
  bagDeleteBtn.hidden = !bag;
  openOverlay(bagFormOverlay);
}

bagForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = bagFields.read();
  let saved;
  if (bagFormCtx.bagId) {
    saved = bagById(bagFormCtx.bagId);
    Object.assign(saved, values);
  } else {
    saved = { id: genId(), coffeeId: bagFormCtx.coffeeId, ...values, status: 'open', finishedAt: null, createdAt: new Date().toISOString() };
    bags.unshift(saved);
  }
  await saveBags();
  closeOverlay(bagFormOverlay);
  afterCatalogChange(bagFormCtx.bagId ? null : saved, bagFormCtx.returnToLog);
});

bagDeleteBtn.addEventListener('click', async () => {
  const bag = bagById(bagFormCtx.bagId);
  if (!bag) return;
  const n = shotsOfBag(bag.id).length;
  if (!confirm(n ? `${n} shot${n === 1 ? '' : 's'} were pulled from this bag. Delete the bag anyway? The shots stay.` : 'Delete this bag?')) return;
  bags = bags.filter((b) => b.id !== bag.id);
  await saveBags();
  closeOverlay(bagFormOverlay);
  refreshAll();
});

function afterCatalogChange(newBag, returnToLog) {
  refreshAll();
  if (newBag && returnToLog) {
    closeOverlay(coffeeOverlay);
    switchView('log');
    bagSelect.value = newBag.id;
    onBagChosen();
  }
}

document.getElementById('new-bean-btn').addEventListener('click', () => openCoffeeForm(null));
document.getElementById('add-bean-link').addEventListener('click', () => openCoffeeForm(null, { returnToLog: true }));

/* ---------- first launch: which bags are still open? ---------- */

const reviewOverlay = document.getElementById('review-overlay');
const reviewList = document.getElementById('review-list');

function openBagReview() {
  const suggested = suggestOpenBags({ bags, shots });
  const rows = [...bags].sort((a, b) => {
    const la = shotsOfBag(a.id)[0]?.timestamp || a.createdAt;
    const lb = shotsOfBag(b.id)[0]?.timestamp || b.createdAt;
    return (lb || '').localeCompare(la || '');
  });
  reviewList.innerHTML = rows.map((b) => {
    const c = coffeeById(b.coffeeId);
    const last = shotsOfBag(b.id)[0];
    return `<li><label class="review-row">
      <input type="checkbox" value="${b.id}" ${suggested.has(b.id) ? 'checked' : ''} />
      <span><strong>${escapeHtml(c?.name || '')}</strong>
      <small>${escapeHtml(c?.roaster || '')}${b.roastDate ? ` · roasted ${formatDay(b.roastDate)}` : ''}${last ? ` · last shot ${formatDay(last.timestamp)}` : ''}</small></span>
    </label></li>`;
  }).join('');
  const changes = meta.migrationChanges || [];
  document.getElementById('review-changes').hidden = changes.length === 0;
  document.getElementById('review-changes-list').innerHTML = changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('');
  openOverlay(reviewOverlay);
}

document.getElementById('review-save').addEventListener('click', async () => {
  const keep = new Set([...reviewList.querySelectorAll('input:checked')].map((i) => i.value));
  const today = todayISO();
  bags.forEach((b) => {
    if (keep.has(b.id)) { b.status = 'open'; b.finishedAt = null; }
    else { b.status = 'finished'; b.finishedAt = b.finishedAt || today; }
  });
  meta.needsBagReview = false;
  await saveBags();
  await saveMeta();
  closeOverlay(reviewOverlay);
  refreshAll();
  selectDefaultBag();
});

/* ---------- log shot form ---------- */

const form = document.getElementById('shot-form');
const bagSelect = document.getElementById('bag-select');
const lastShotEl = document.getElementById('last-shot');
const doseInput = document.getElementById('doseGrams');
const doseValue = document.getElementById('doseGrams-value');
const doseLabel = document.getElementById('dose-label');
const yieldInput = document.getElementById('yieldGrams');
const grindInput = document.getElementById('grindSetting');
const grindValue = document.getElementById('grindSetting-value');
const preinfusionInput = document.getElementById('preinfusionSec');
const preinfusionValue = document.getElementById('preinfusionSec-value');
const shotTimeInput = document.getElementById('shotTimeSec');
const volumeInput = document.getElementById('totalVolume');
const methodSeg = document.getElementById('method-seg');
const methodInput = document.getElementById('brewMethod');
const espressoFields = document.getElementById('espresso-fields');
const filterFields = document.getElementById('filter-fields');
const ratioDisplay = document.getElementById('ratio-display');
const ratioValue = document.getElementById('ratio-value');
const editBanner = document.getElementById('edit-banner');
const editBannerText = document.getElementById('edit-banner-text');
const saveBtn = document.getElementById('save-btn');
const balanceRow = document.getElementById('balance-row');
const tagRow = document.getElementById('tag-row');
const milkChip = document.getElementById('milk-chip');
const shotRating = initScoreRow(document.getElementById('shot-rating'), document.getElementById('shot-rating-readout'));

let currentMethod = 'Espresso';
let editingShotId = null;
let balance = null;
let pickedTags = new Set();
let withMilk = false;

const DOSE_RANGE = { Espresso: { min: 16, max: 20 }, Filter: { min: 12, max: 30 } };

/* taste input */
balanceRow.innerHTML = BALANCE.map((b) =>
  `<button type="button" class="chip" role="radio" aria-checked="false" data-balance="${b.v}">${b.label}</button>`).join('');
tagRow.innerHTML = FLAVOUR_TAGS.map((t) =>
  `<button type="button" class="chip" aria-pressed="false" data-tag="${t}">${t}</button>`).join('');

function setBalance(v) {
  balance = v;
  balanceRow.querySelectorAll('.chip').forEach((c) => {
    const on = v != null && Number(c.dataset.balance) === v;
    c.classList.toggle('on', on);
    c.setAttribute('aria-checked', String(on));
  });
}
function setTags(tags) {
  pickedTags = new Set(tags || []);
  tagRow.querySelectorAll('.chip').forEach((c) => {
    const on = pickedTags.has(c.dataset.tag);
    c.classList.toggle('on', on);
    c.setAttribute('aria-pressed', String(on));
  });
}
function setMilk(v) {
  withMilk = !!v;
  milkChip.classList.toggle('on', withMilk);
  milkChip.setAttribute('aria-pressed', String(withMilk));
}
balanceRow.addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  const v = Number(c.dataset.balance);
  setBalance(balance === v ? null : v);
});
tagRow.addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  const t = c.dataset.tag;
  pickedTags.has(t) ? pickedTags.delete(t) : pickedTags.add(t);
  setTags([...pickedTags]);
});
milkChip.addEventListener('click', () => setMilk(!withMilk));

/* bag picker */
function bagOptionLabel(b) {
  const c = coffeeById(b.coffeeId);
  const bits = [c?.roaster, b.roastDate ? `roasted ${formatDay(b.roastDate)}` : ''].filter(Boolean).join(' · ');
  return `${c?.name || 'Unknown'}${bits ? ' — ' + bits : ''}`;
}

function refreshBagSelect(includeBagId) {
  const current = bagSelect.value;
  const open = bags.filter((b) => b.status !== 'finished' && coffeeById(b.coffeeId))
    .sort((a, b) => bagOptionLabel(a).localeCompare(bagOptionLabel(b)));
  const extra = includeBagId && !open.some((b) => b.id === includeBagId) ? bagById(includeBagId) : null;
  let html = `<option value="" disabled>${open.length ? 'Select a bag...' : 'No open bags — add or reopen one'}</option>`;
  html += open.map((b) => `<option value="${b.id}">${escapeHtml(bagOptionLabel(b))}</option>`).join('');
  if (extra) html += `<optgroup label="Finished"><option value="${extra.id}">${escapeHtml(bagOptionLabel(extra))}</option></optgroup>`;
  bagSelect.innerHTML = html;
  const keep = [...bagSelect.options].some((o) => o.value === current && current);
  bagSelect.value = keep ? current : '';
}

/** Default to the open bag you used most recently. */
function selectDefaultBag() {
  if (editingShotId) return;
  if (bagSelect.value) return;
  const recent = shots.find((s) => bagById(s.bagId)?.status === 'open');
  const fallback = bags.find((b) => b.status === 'open');
  const id = recent?.bagId || fallback?.id;
  if (id) {
    bagSelect.value = id;
    onBagChosen();
  }
}

bagSelect.addEventListener('change', onBagChosen);

function onBagChosen() {
  if (editingShotId) { lastShotEl.hidden = true; return; }
  const bag = bagById(bagSelect.value);
  if (!bag) { lastShotEl.hidden = true; return; }
  const onBag = shotsOfBag(bag.id);
  const onCoffee = shotsOfCoffee(bag.coffeeId);
  const last = onBag[0] || onCoffee[0];
  if (!last) {
    lastShotEl.hidden = false;
    lastShotEl.innerHTML = `<span class="muted-note">First shot on this coffee — starting from defaults.</span>`;
    return;
  }
  applyShotSettings(last);
  const best = bestShot(onCoffee);
  const where = onBag[0] ? 'Last shot on this bag' : 'Last shot on the previous bag';
  lastShotEl.hidden = false;
  lastShotEl.innerHTML = `
    <div><strong>${where}</strong> · ${formatDay(last.timestamp)}</div>
    <div>${shotSummary(last)}</div>
    <div class="muted-note">Dose, grind and preinfusion copied from it.</div>
    ${best && best.id !== last.id ? `
      <div class="best-line"><span><strong>Best</strong> · ${shotSummary(best)}</span>
      <button type="button" class="text-link" data-use-shot="${best.id}">Use best</button></div>` : ''}
  `;
}

lastShotEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-use-shot]');
  if (!b) return;
  const s = shots.find((x) => x.id === b.dataset.useShot);
  if (s) {
    applyShotSettings(s);
    b.textContent = 'Applied ✓';
  }
});

function shotSummary(s) {
  const isEsp = s.brewMethod !== 'Filter';
  const r = ratioOf(s);
  const parts = [
    `${s.doseGrams ?? '—'}g`,
    `grind ${s.grindSetting != null ? Number(s.grindSetting).toFixed(1) : '—'}`,
  ];
  if (isEsp) {
    if (s.preinfusionSec != null) parts.push(`${s.preinfusionSec}s PI`);
    parts.push(`${s.shotTimeSec ?? '—'}s → ${s.yieldGrams ?? '—'}g${r ? ` (1:${r.toFixed(1)})` : ''}`);
  } else {
    parts.push(`${s.volumeMl ?? '—'}ml`);
  }
  if (s.rating != null) parts.push(`${s.rating}/10`);
  if (s.balance != null) parts.push(balanceLabel(s.balance).toLowerCase());
  return escapeHtml(parts.join(' · '));
}

function applyShotSettings(s) {
  setMethod(s.brewMethod === 'Filter' ? 'Filter' : 'Espresso');
  if (s.doseGrams != null) doseInput.value = s.doseGrams;
  if (s.grindSetting != null) grindInput.value = s.grindSetting;
  if (s.preinfusionSec != null) preinfusionInput.value = s.preinfusionSec;
  updateDoseValue();
  updateGrindValue();
  updatePreinfusionValue();
  updateRatioDisplay();
}

/* method & sliders */
function setMethod(m) {
  currentMethod = m === 'Filter' ? 'Filter' : 'Espresso';
  methodInput.value = currentMethod;
  methodSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.method === currentMethod));
  const esp = currentMethod === 'Espresso';
  espressoFields.hidden = !esp;
  filterFields.hidden = esp;
  doseLabel.textContent = esp ? 'Dose in' : 'Coffee dose in';
  const r = DOSE_RANGE[currentMethod];
  doseInput.min = r.min;
  doseInput.max = r.max;
  const v = Math.min(Math.max(parseFloat(doseInput.value) || 18, r.min), r.max);
  doseInput.value = v.toFixed(1);
  updateDoseValue();
  updateRatioDisplay();
}

methodSeg.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b) setMethod(b.dataset.method);
});

// − / + steppers: exact step increments so 4.3 is always 4.3.
document.querySelectorAll('.stepper-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const step = parseFloat(input.step) || 1;
    let v = (parseFloat(input.value) || 0) + Number(btn.dataset.dir) * step;
    v = Math.round(v / step) * step;
    v = Math.min(Math.max(v, parseFloat(input.min)), parseFloat(input.max));
    input.value = String(Math.round(v * 100) / 100);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
});

function updateRatioDisplay() {
  const esp = currentMethod === 'Espresso';
  const d = parseFloat(doseInput.value), o = parseFloat(esp ? yieldInput.value : volumeInput.value);
  if (d && o) {
    ratioDisplay.hidden = false;
    ratioValue.textContent = `1 : ${(o / d).toFixed(esp ? 2 : 1)}`;
  } else {
    ratioDisplay.hidden = true;
  }
}
const updateDoseValue = () => { doseValue.textContent = `${parseFloat(doseInput.value).toFixed(1)} g`; };
const updateGrindValue = () => { grindValue.textContent = parseFloat(grindInput.value).toFixed(1); };
const updatePreinfusionValue = () => { preinfusionValue.textContent = `${preinfusionInput.value}s`; };

doseInput.addEventListener('input', () => { updateDoseValue(); updateRatioDisplay(); });
yieldInput.addEventListener('input', updateRatioDisplay);
volumeInput.addEventListener('input', updateRatioDisplay);
grindInput.addEventListener('input', updateGrindValue);
preinfusionInput.addEventListener('input', updatePreinfusionValue);

function resetShotForm() {
  const keepBag = bagSelect.value;
  form.reset();
  shotRating.setValue(null);
  setBalance(null);
  setTags([]);
  setMilk(false);
  setMethod(currentMethod);
  updateGrindValue();
  updatePreinfusionValue();
  ratioDisplay.hidden = true;
  editingShotId = null;
  editBanner.hidden = true;
  saveBtn.textContent = 'Save Shot';
  refreshBagSelect();
  const stillOpen = bagById(keepBag)?.status === 'open';
  bagSelect.value = stillOpen ? keepBag : '';
  if (bagSelect.value) onBagChosen(); else { lastShotEl.hidden = true; selectDefaultBag(); }
}

document.getElementById('cancel-edit').addEventListener('click', resetShotForm);

function startEditShot(shot) {
  editingShotId = shot.id;
  refreshBagSelect(shot.bagId);
  bagSelect.value = bagById(shot.bagId) ? shot.bagId : '';
  lastShotEl.hidden = true;
  setMethod(shot.brewMethod === 'Filter' ? 'Filter' : 'Espresso');
  doseInput.value = shot.doseGrams ?? 18;
  grindInput.value = shot.grindSetting ?? 4;
  preinfusionInput.value = shot.preinfusionSec ?? 0;
  shotTimeInput.value = shot.shotTimeSec ?? '';
  yieldInput.value = shot.yieldGrams ?? '';
  volumeInput.value = shot.volumeMl ?? 250;
  document.getElementById('notes').value = shot.notes || '';
  shotRating.setValue(shot.rating);
  setBalance(shot.balance ?? null);
  setTags(shot.tags);
  setMilk(shot.withMilk);
  updateDoseValue();
  updateGrindValue();
  updatePreinfusionValue();
  updateRatioDisplay();
  editBannerText.textContent = `Editing shot · ${formatDate(shot.timestamp)}`;
  editBanner.hidden = false;
  saveBtn.textContent = 'Update Shot';
  switchView('log');
  window.scrollTo(0, 0);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const bag = bagById(fd.get('bagId'));
  const coffee = bag ? coffeeById(bag.coffeeId) : null;
  const esp = currentMethod === 'Espresso';
  const existing = editingShotId ? shots.find((s) => s.id === editingShotId) : null;
  const num = (k) => (fd.get(k) ? parseFloat(fd.get(k)) : null);
  const bagChanged = existing && existing.bagId !== bag?.id;

  const shot = {
    id: existing?.id || genId(),
    timestamp: existing?.timestamp || new Date().toISOString(),
    editedAt: existing ? new Date().toISOString() : null,
    bagId: bag?.id || existing?.bagId || null,
    coffeeId: coffee?.id || existing?.coffeeId || null,
    beanName: coffee?.name || existing?.beanName || '',
    roastDateAtLog: (!bagChanged && existing?.roastDateAtLog) || bag?.roastDate || '',
    brewMethod: currentMethod,
    doseGrams: num('doseGrams'),
    grindSetting: num('grindSetting'),
    preinfusionSec: esp ? num('preinfusionSec') : null,
    shotTimeSec: esp ? num('shotTimeSec') : null,
    yieldGrams: esp ? num('yieldGrams') : null,
    volumeMl: esp ? null : num('volumeMl'),
    rating: shotRating.value,
    balance,
    tags: [...pickedTags],
    withMilk,
    notes: (fd.get('notes') || '').trim(),
  };

  shots = existing ? shots.map((s) => (s.id === shot.id ? shot : s)) : sortShots([shot, ...shots]);
  await saveShots();
  resetShotForm();
  switchView('history');
  window.scrollTo(0, 0);
});

/* ---------- history ---------- */

const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const historySummary = document.getElementById('history-summary');
const searchInput = document.getElementById('history-search');

const hfDefaults = { coffee: '', roaster: '', country: '', process: '', minRating: '', balance: '', milk: '', sort: 'new', from: '', to: '' };
const hf = { ...hfDefaults };

const historyFilters = setupFilterPanel({
  btn: document.getElementById('history-filter-btn'),
  panel: document.getElementById('history-filter-panel'),
  clearBtn: document.getElementById('history-filter-clear'),
  chipsEl: document.getElementById('history-active-filters'),
  countEl: document.getElementById('history-filter-count'),
  state: hf,
  defaults: hfDefaults,
  labels: {
    coffee: (v) => coffeeById(v)?.name || 'Coffee',
    roaster: (v) => v,
    country: (v) => v,
    process: (v) => v,
    minRating: (v) => (Number(v) === 10 ? 'Rated 10' : `Rated ${v}+`),
    balance: (v) => balanceLabel(Number(v)),
    milk: (v) => (v === 'with' ? 'With milk' : 'Without milk'),
    sort: (v) => (v === 'old' ? 'Oldest first' : 'Highest rated'),
    from: (v) => `From ${formatDay(v)}`,
    to: (v) => `Until ${formatDay(v)}`,
  },
  onChange: renderHistory,
});

function refreshHistoryFilterOptions() {
  const used = new Set(shots.map((s) => s.coffeeId));
  fillSelect(document.getElementById('hf-coffee'),
    coffees.filter((c) => used.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.id, c.name]));
  fillSelect(document.getElementById('hf-roaster'), uniqueValues(coffees.map((c) => c.roaster)).map((v) => [v, v]));
  fillSelect(document.getElementById('hf-country'), uniqueValues(coffees.flatMap((c) => c.countries || [])).map((v) => [v, v]));
  fillSelect(document.getElementById('hf-process'), uniqueValues(coffees.map((c) => c.process)).map((v) => [v, v]));
  fillSelect(document.getElementById('hf-minRating'), [5, 6, 7, 8, 9, 10].map((n) => [String(n), n === 10 ? '10 only' : `${n}+`]), 'Any');
  fillSelect(document.getElementById('hf-balance'), BALANCE.map((b) => [String(b.v), b.label]), 'Any');
}

function shotMatches(shot, q) {
  const c = coffeeOfShot(shot);
  if (hf.coffee && shot.coffeeId !== hf.coffee) return false;
  if (hf.roaster && !eq(c?.roaster, hf.roaster)) return false;
  if (hf.country && !(c?.countries || []).some((x) => eq(x, hf.country))) return false;
  if (hf.process && !eq(c?.process, hf.process)) return false;
  if (hf.minRating && !(shot.rating != null && shot.rating >= Number(hf.minRating))) return false;
  if (hf.balance !== '' && shot.balance !== Number(hf.balance)) return false;
  if (hf.milk === 'with' && !shot.withMilk) return false;
  if (hf.milk === 'without' && shot.withMilk) return false;
  const day = shot.timestamp ? new Date(shot.timestamp) : null;
  const localDay = day ? new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '';
  if (hf.from && localDay < hf.from) return false;
  if (hf.to && localDay > hf.to) return false;
  if (q) {
    const hay = [shotLabel(shot), shot.notes, shot.brewMethod, c?.roaster, c?.region, c?.process, c?.variety,
      ...(c?.countries || []), ...(shot.tags || []), balanceLabel(shot.balance)].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderHistory() {
  refreshHistoryFilterOptions();
  historyFilters.syncInputs();
  historyFilters.renderChips();
  const q = searchInput.value.trim().toLowerCase();
  let list = shots.filter((s) => shotMatches(s, q));
  if (hf.sort === 'old') list = [...list].reverse();
  if (hf.sort === 'rating') list = [...list].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));

  const filtering = q || Object.keys(hfDefaults).some((k) => k !== 'sort' && hf[k] !== hfDefaults[k]);
  const st = stats(list);
  historySummary.hidden = list.length === 0;
  historySummary.textContent = `${st.count} shot${st.count === 1 ? '' : 's'}${filtering ? ' match' : ''}` +
    (st.avg != null ? ` · avg ${st.avg.toFixed(1)} · best ${st.best}` : '');

  historyEmpty.hidden = list.length > 0;
  historyEmpty.textContent = shots.length === 0
    ? 'No shots logged yet. Pull an espresso and log it above.'
    : 'No shots match your filters.';

  historyList.innerHTML = list.map((shot) => {
    const isEsp = shot.brewMethod !== 'Filter';
    const r = ratioOf(shot);
    const ratioStr = r ? `1:${r.toFixed(isEsp ? 2 : 1)}` : '—';
    const outStr = isEsp ? `${shot.yieldGrams ?? '—'}g` : `${shot.volumeMl ?? '—'}ml`;
    const days = daysSinceRoast(shot);
    const taste = [
      shot.balance != null ? balanceLabel(shot.balance) : '',
      ...(shot.tags || []),
      shot.withMilk ? 'with milk' : '',
    ].filter(Boolean);
    return `
      <li class="shot-card" data-id="${shot.id}">
        <div class="shot-card-top">
          <span class="shot-card-bean">${escapeHtml(shotLabel(shot))}</span>
          ${ratingPill(shot.rating)}
        </div>
        <div class="shot-card-date">${formatDate(shot.timestamp)}${days != null ? ` · ${days}d off roast` : ''}</div>
        <div class="shot-card-meta">
          ${isEsp ? '' : '<span class="method-tag filter">Filter</span>'}
          <span>${shot.doseGrams ?? '—'}g → ${outStr} (${ratioStr})</span>
          ${isEsp && shot.shotTimeSec != null ? `<span>${shot.shotTimeSec}s</span>` : ''}
          ${shot.grindSetting != null ? `<span>grind ${Number(shot.grindSetting).toFixed(1)}</span>` : ''}
        </div>
        ${taste.length ? `<div class="taste-tags">${taste.map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        ${shot.notes ? `<div class="shot-card-notes">${escapeHtml(shot.notes)}</div>` : ''}
      </li>`;
  }).join('');
}

searchInput.addEventListener('input', renderHistory);
historyList.addEventListener('click', (e) => {
  const card = e.target.closest('.shot-card');
  if (card) openShotDetail(card.dataset.id);
});

/* ---------- shot detail ---------- */

const detailOverlay = document.getElementById('detail-overlay');
const detailBody = document.getElementById('detail-body');
let activeShotId = null;

const detailRow = (label, value) =>
  `<div class="detail-row"><span>${label}</span><span>${value}</span></div>`;

function openShotDetail(id) {
  const shot = shots.find((s) => s.id === id);
  if (!shot) return;
  activeShotId = id;
  const isEsp = shot.brewMethod !== 'Filter';
  const r = ratioOf(shot);
  const days = daysSinceRoast(shot);
  const c = coffeeOfShot(shot);
  const bag = bagById(shot.bagId);
  const coffeeLine = c
    ? `<button type="button" class="text-link" data-open-coffee="${c.id}">${escapeHtml([c.roaster, (c.countries || []).join(' & ')].filter(Boolean).join(' · ') || 'View coffee')} ›</button>`
    : '';
  const e = escapeHtml;
  detailBody.innerHTML = `
    <h2>${e(shotLabel(shot))}</h2>
    ${coffeeLine}
    ${detailRow('Logged', e(formatDate(shot.timestamp)))}
    ${shot.editedAt ? detailRow('Edited', e(formatDate(shot.editedAt))) : ''}
    ${detailRow('Bag', bag ? `roasted ${e(formatDay(bag.roastDate)) || '—'}${bag.status === 'finished' ? ' (finished)' : ''}` : '—')}
    ${detailRow('Days off roast', days != null ? `${days} day${days === 1 ? '' : 's'}` : '—')}
    ${detailRow('Brew method', e(shot.brewMethod || 'Espresso'))}
    ${detailRow(isEsp ? 'Dose in' : 'Coffee dose in', shot.doseGrams != null ? `${shot.doseGrams} g` : '—')}
    ${detailRow('Grind setting', shot.grindSetting != null ? Number(shot.grindSetting).toFixed(1) : '—')}
    ${isEsp
      ? detailRow('Preinfusion', shot.preinfusionSec != null ? `${shot.preinfusionSec} s` : '—') +
        detailRow('Shot time', shot.shotTimeSec != null ? `${shot.shotTimeSec} s` : '—') +
        detailRow('Yield out', shot.yieldGrams != null ? `${shot.yieldGrams} g` : '—')
      : detailRow('Total volume', shot.volumeMl != null ? `${shot.volumeMl} ml` : '—')}
    ${detailRow('Ratio', r ? `1 : ${r.toFixed(isEsp ? 2 : 1)}` : '—')}
    ${detailRow('Rating', shot.rating != null ? ratingPill(shot.rating) : 'Not rated')}
    ${detailRow('Balance', shot.balance != null ? e(balanceLabel(shot.balance)) : '—')}
    ${(shot.tags || []).length ? detailRow('Flavours', e(shot.tags.join(', '))) : ''}
    ${detailRow('Milk', shot.withMilk ? 'With milk' : 'Straight')}
    ${shot.notes ? `<div class="detail-notes">${e(shot.notes)}</div>` : ''}
  `;
  openOverlay(detailOverlay);
}

detailBody.addEventListener('click', (e) => {
  const b = e.target.closest('[data-open-coffee]');
  if (!b) return;
  closeOverlay(detailOverlay);
  openCoffeeDetail(b.dataset.openCoffee);
});

document.getElementById('detail-edit').addEventListener('click', () => {
  const shot = shots.find((s) => s.id === activeShotId);
  if (!shot) return;
  closeOverlay(detailOverlay);
  closeOverlay(coffeeOverlay);
  startEditShot(shot);
});

document.getElementById('detail-delete').addEventListener('click', async () => {
  if (!activeShotId || !confirm('Delete this shot from your log?')) return;
  shots = shots.filter((s) => s.id !== activeShotId);
  await saveShots();
  closeOverlay(detailOverlay);
  activeShotId = null;
  refreshAll();
});

/* ---------- export / import ---------- */

document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(exportPayload({ coffees, bags, shots }), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shot-log-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = normalizeBackup(JSON.parse(await file.text()));
    const before = { c: coffees.length, b: bags.length, s: shots.length };
    ({ coffees, bags, shots } = mergeImport({ coffees, bags, shots }, imported));
    await saveCoffees();
    await saveBags();
    await saveShots();
    refreshAll();
    alert(`Imported ${imported.version === 1 ? 'an older-format backup' : 'a backup'}: ` +
      `${shots.length - before.s} new shots, ${coffees.length - before.c} new coffees, ${bags.length - before.b} new bags.`);
    // Old backups don't know which bags are finished, so ask once.
    if (imported.version === 1 && bags.length > before.b) {
      meta.needsBagReview = true;
      meta.migrationChanges = imported.changes;
      await saveMeta();
      openBagReview();
    }
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

/* ---------- init ---------- */

function refreshAll() {
  refreshCoffeeFieldLists();
  refreshBagSelect(editingShotId ? shots.find((s) => s.id === editingShotId)?.bagId : null);
  if (!editingShotId && bagSelect.value) onBagChosen();
  if (!coffeeOverlay.hidden) renderCoffeeDetail();
  if (document.getElementById('view-history').classList.contains('active')) renderHistory();
  if (document.getElementById('view-beans').classList.contains('active')) renderBeans();
}

refreshCoffeeFieldLists();
refreshBagSelect();
setMethod('Espresso');
updateGrindValue();
updatePreinfusionValue();
renderHistory();
renderBeans();
if (meta.needsBagReview) openBagReview();
else selectDefaultBag();

if ('serviceWorker' in navigator) {
  // Whether the page was already under a worker's control when it loaded. If
  // it wasn't, the first controllerchange is just this install finishing and
  // must not trigger a reload.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('service-worker.js')
      .then((reg) => {
        // Closing an installed PWA from the app switcher doesn't reliably
        // terminate its web view, so an update check may never run on its
        // own. Ask on launch and every time the app returns to the front.
        reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch(() => {});
  });
}
