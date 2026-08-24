const { kv } = require("./_directorAuth");

// Revenue-only uplift — Reload's true commission rate on certain clients is
// higher than the 25%-based figure every deal is actually recorded at in
// Atlas. This is DELIBERATELY separate from Natasha Barnard's existing
// commission-affecting Citadel uplift (still living in commission.js on both
// this site and the incentive site, untouched by this file) — that one
// changes what a specific person is actually paid; this one only ever
// changes what gets shown as REVENUE on the Yearly Deal Table and Company
// Overview. Commission calculations never read this file, on purpose.
//
// Confirmed directly with Scott, not guessed:
//   - Citadel / Citadel Securities: 30% true rate (1.2x), from 2021 onward
//   - Jane Street: 30% true rate (1.2x), from 2024 onward
//   - Virtu / Virtu Financial: 30% true rate (1.2x), from 2025 onward
// Applies to every deal for these clients, any consultant, not just genuine
// placements — Scott said "for all deals," not "for placements only."
const CLIENT_UPLIFT_RULES = [
  { substring: "citadel", minYear: 2021, multiplier: 1.2 },
  { substring: "jane street", minYear: 2024, multiplier: 1.2 },
  { substring: "virtu", minYear: 2025, multiplier: 1.2 },
];

function defaultMultiplierFor(clientName, year) {
  if (!clientName) return 1;
  const lower = clientName.toLowerCase();
  for (const rule of CLIENT_UPLIFT_RULES) {
    if (lower.includes(rule.substring) && year >= rule.minYear) return rule.multiplier;
  }
  return 1;
}

const OVERRIDES_KEY = "deal-revenue-overrides"; // { "feeId:splitId": { amountUSD, notes, setAt } } — owned entirely by this site

function overrideKeyFor(record) {
  return `${record.feeId}:${record.splitId}`;
}

// Given a raw record, its resolved client name, and its effective year,
// decide what should actually happen to its revenue figure:
//   - a manual per-deal override always wins if one's been set, since that's
//     Scott telling us the real number directly, more reliable than any rule
//   - otherwise the default client-based multiplier applies if this deal
//     matches one of the rules above
//   - otherwise the deal's recorded figure is used completely unchanged
// Returns a decision object; callers apply it to their OWN already-tested
// currency conversion functions, so conversion math itself is never
// duplicated here, only the "which adjustment applies" decision is shared.
function resolveUplift(record, clientName, year, overrides) {
  const key = overrideKeyFor(record);
  const override = overrides[key];
  if (override && override.amountUSD !== null && override.amountUSD !== undefined) {
    return { type: "override", amountUSD: override.amountUSD, notes: override.notes || null };
  }
  const multiplier = defaultMultiplierFor(clientName, year);
  if (multiplier !== 1) {
    return { type: "multiplier", value: multiplier };
  }
  return { type: "none" };
}

async function getOverrides() {
  return (await kv.get(OVERRIDES_KEY)) || {};
}

async function setOverride(feeId, splitId, amountUSD, notes) {
  const all = await getOverrides();
  const key = `${feeId}:${splitId}`;
  if (amountUSD === null || amountUSD === undefined || amountUSD === "") {
    delete all[key];
  } else {
    all[key] = { amountUSD: Number(amountUSD), notes: notes || null, setAt: new Date().toISOString() };
  }
  await kv.set(OVERRIDES_KEY, all);
  return all[key] || null;
}

module.exports = { CLIENT_UPLIFT_RULES, defaultMultiplierFor, resolveUplift, getOverrides, setOverride, OVERRIDES_KEY };
