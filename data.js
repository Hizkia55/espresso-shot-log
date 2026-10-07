// Pure data helpers: schema, migration and import merging. No DOM in here, so
// it can be exercised from node against a real backup.
import { parseOrigin } from './lib/countries.js';

export const SCHEMA_VERSION = 2;
export const EUR_DKK = 7.46; // DKK is pegged to the euro, so a fixed rate is fine

/*
 * v2 shapes
 *   coffee { id, name, roaster, countries[], region, process, variety, elevation,
 *            rating (0–10 | null), createdAt }
 *   bag    { id, coffeeId, roastDate, priceAmount, currency, bagGrams,
 *            status: 'open' | 'finished', finishedAt, createdAt }
 *   shot   { id, timestamp, editedAt, bagId, coffeeId, beanName, roastDateAtLog,
 *            brewMethod, doseGrams, grindSetting, preinfusionSec, shotTimeSec,
 *            yieldGrams, volumeMl, rating (0–10 | null),
 *            balance (-2 very bitter … 2 very sour | null), tags[], withMilk, notes }
 */

const PLACEHOLDERS = new Set(['x', '-', '—', 'n/a', 'na', '?']);
const clean = (v) => {
  const s = String(v ?? '').trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? '' : s;
};

/** 1–5 stars → 2–10; 0 / missing meant "not rated" in v1 → null. */
export function starsToTen(stars) {
  const n = Number(stars);
  return n >= 1 && n <= 5 ? Math.round(n * 2) : null;
}

/**
 * Pick one spelling per case-insensitive group: a short all-caps variant wins
 * (it's an acronym like "SP"), otherwise the most used spelling.
 */
export function canonicalSpellings(values) {
  const groups = new Map();
  for (const v of values.filter(Boolean)) {
    const k = v.toLowerCase();
    if (!groups.has(k)) groups.set(k, new Map());
    const g = groups.get(k);
    g.set(v, (g.get(v) || 0) + 1);
  }
  const out = new Map();
  for (const [k, g] of groups) {
    const variants = [...g.entries()];
    const acronym = variants.find(([v]) => v.length <= 5 && v === v.toUpperCase() && /[A-Z]/.test(v));
    const best = acronym || variants.sort((a, b) => b[1] - a[1])[0];
    out.set(k, best[0]);
  }
  return out;
}

/** Snap a value onto an existing spelling (case-insensitive), else keep it. */
export function snapSpelling(value, existing) {
  const v = clean(value);
  if (!v) return '';
  return existing.find((e) => e && e.toLowerCase() === v.toLowerCase()) || v;
}

export function pricePer100(bag) {
  const a = parseFloat(bag?.priceAmount), g = parseFloat(bag?.bagGrams);
  if (!a || !g) return null;
  return a / g * 100;
}

export function per100InDKK(bag) {
  const p = pricePer100(bag);
  if (p == null) return null;
  return bag.currency === 'DKK' ? p : p * EUR_DKK;
}

/**
 * v1 → v2. Every v1 bean becomes one coffee with one bag. The bag keeps the
 * bean's id so old shots (beanId) map straight onto it; the coffee id is
 * derived from it, so importing the same v1 backup twice can't duplicate.
 */
export function migrateV1({ beans = [], shots = [] }, { now = new Date() } = {}) {
  const roasterSpelling = canonicalSpellings(beans.map((b) => clean(b.roaster)));
  const processSpelling = canonicalSpellings(beans.map((b) => clean(b.process)));
  const changes = [];

  const coffees = [];
  const bags = [];
  for (const b of beans) {
    if (!b || !b.id) continue;
    const coffeeId = `c-${b.id}`;
    const { countries, region } = parseOrigin(b.origin);
    const roaster = roasterSpelling.get(clean(b.roaster).toLowerCase()) || clean(b.roaster);
    if (clean(b.roaster) && roaster !== clean(b.roaster)) {
      changes.push(`${b.name}: roaster "${b.roaster}" → "${roaster}"`);
    }
    if (b.origin && (countries.join(' & ') !== b.origin.trim())) {
      changes.push(`${b.name}: origin "${b.origin}" → ${countries.join(' & ') || '—'}${region ? ` (region: ${region})` : ''}`);
    }

    let currency = b.currency === 'DKK' ? 'DKK' : 'EUR';
    const priceAmount = b.priceAmount ?? null;
    const bagGrams = b.bagGrams ?? null;
    // A specialty bag at more than €30 / 100g is almost certainly a DKK price
    // saved with the old EUR default.
    const per = pricePer100({ priceAmount, bagGrams });
    if (currency === 'EUR' && per != null && per > 30) {
      currency = 'DKK';
      changes.push(`${b.name}: price ${priceAmount} / ${bagGrams}g switched from EUR to DKK`);
    }

    coffees.push({
      id: coffeeId,
      name: clean(b.name) || 'Unnamed coffee',
      roaster,
      countries,
      region: clean(region),
      process: processSpelling.get(clean(b.process).toLowerCase()) || clean(b.process),
      variety: clean(b.variety),
      elevation: clean(b.elevation),
      rating: starsToTen(b.recommendRating),
      createdAt: b.createdAt || now.toISOString(),
    });
    bags.push({
      id: b.id,
      coffeeId,
      roastDate: b.roastDate || '',
      priceAmount,
      currency,
      bagGrams,
      status: 'open',
      finishedAt: null,
      createdAt: b.createdAt || now.toISOString(),
    });
  }

  const bagById = new Map(bags.map((b) => [b.id, b]));
  const migratedShots = shots.filter((s) => s && s.id).map((s) => migrateShotV1(s, bagById));

  return { coffees, bags, shots: sortShots(migratedShots), changes };
}

function migrateShotV1(s, bagById) {
  const bagId = s.bagId || s.beanId || null;
  const bag = bagById.get(bagId);
  return {
    id: s.id,
    timestamp: s.timestamp,
    editedAt: s.editedAt ?? null,
    bagId,
    coffeeId: bag ? bag.coffeeId : null,
    beanName: s.beanName || s.bean || '',
    roastDateAtLog: s.roastDateAtLog || bag?.roastDate || '',
    brewMethod: s.brewMethod === 'Filter' ? 'Filter' : 'Espresso',
    doseGrams: s.doseGrams ?? null,
    grindSetting: s.grindSetting ?? null,
    preinfusionSec: s.preinfusionSec ?? null,
    shotTimeSec: s.shotTimeSec ?? null,
    yieldGrams: s.yieldGrams ?? null,
    volumeMl: s.volumeMl ?? null,
    rating: starsToTen(s.rating),
    balance: null,
    tags: [],
    withMilk: false,
    notes: s.notes || '',
  };
}

export function sortShots(shots) {
  return [...shots].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Suggest which bags are still open after a migration: anything with a shot or
 * created in the last two weeks, unless a note says the bag is finished.
 */
export function suggestOpenBags({ bags, shots }, { now = new Date(), days = 14 } = {}) {
  const cutoff = now.getTime() - days * 86400000;
  const open = new Set();
  for (const bag of bags) {
    const bagShots = shots.filter((s) => s.bagId === bag.id);
    const saidFinished = bagShots.some((s) => /bag (has been|is) (finished|empty)|finished the bag/i.test(s.notes || ''));
    const recent = new Date(bag.createdAt).getTime() >= cutoff ||
      bagShots.some((s) => new Date(s.timestamp).getTime() >= cutoff);
    if (recent && !saidFinished) open.add(bag.id);
  }
  return open;
}

/** Detect a backup's format and bring it to v2. */
export function normalizeBackup(parsed) {
  if (Array.isArray(parsed)) return { version: 1, ...migrateV1({ beans: [], shots: parsed }) };
  if (parsed && (parsed.schemaVersion >= 2 || Array.isArray(parsed.coffees))) {
    return {
      version: 2,
      coffees: parsed.coffees || [],
      bags: parsed.bags || [],
      shots: parsed.shots || [],
      changes: [],
    };
  }
  if (parsed && (Array.isArray(parsed.beans) || Array.isArray(parsed.shots))) {
    return { version: 1, ...migrateV1(parsed) };
  }
  throw new Error('Not a Shot Log backup');
}

/**
 * Merge an imported backup into current state. v2 imports win on conflicts
 * (same behaviour as before); a v1 import only adds records you don't have yet,
 * so it can't undo ratings, bag status or cleanups made since.
 */
export function mergeImport(state, imported) {
  const preferImported = imported.version >= 2;
  const merge = (current, incoming) => {
    const map = new Map(current.map((x) => [x.id, x]));
    for (const x of incoming) {
      if (!x || !x.id) continue;
      if (preferImported || !map.has(x.id)) map.set(x.id, x);
    }
    return [...map.values()];
  };
  return {
    coffees: merge(state.coffees, imported.coffees),
    bags: merge(state.bags, imported.bags),
    shots: sortShots(merge(state.shots, imported.shots)),
  };
}

export function exportPayload({ coffees, bags, shots }) {
  return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), coffees, bags, shots };
}
