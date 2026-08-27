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
//   - PDT / PDT Partners: 30% true rate (1.2x), from 2026 onward
// Applies to genuine placements only, same restriction the original
// Natasha/Citadel commission uplift always used — a notes-derived Onsite
// fee never gets the automatic uplift, since it isn't a real placement fee
// at the true rate, it's a different kind of payment entirely. A manual
// override can still be set on an Onsite fee if the real figure is known,
// that's a deliberate correction, not an automatic assumption.
const CLIENT_UPLIFT_RULES = [
  { substring: "citadel", minYear: 2021, multiplier: 1.2 },
  { substring: "jane street", minYear: 2024, multiplier: 1.2 },
  { substring: "virtu", minYear: 2025, multiplier: 1.2 },
  { substring: "pdt", minYear: 2026, multiplier: 1.2 },
];

function defaultMultiplierFor(clientName, year) {
  if (!clientName) return 1;
  const lower = clientName.toLowerCase();
  for (const rule of CLIENT_UPLIFT_RULES) {
    if (lower.includes(rule.substring) && year >= rule.minYear) return rule.multiplier;
  }
  return 1;
}

const OVERRIDES_KEY = "deal-revenue-overrides"; // { "feeId:splitId": { amount, currency, customRate, notes, setAt } } — owned entirely by this site

function overrideKeyFor(record) {
  return `${record.feeId}:${record.splitId}`;
}

// Given a raw record, its resolved client name, effective year, and whether
// it's a genuine placement (as opposed to a notes-derived Onsite fee),
// decide what should actually happen to its revenue figure:
//   - a manual per-deal override always wins if one's been set, since that's
//     Scott telling us the real number directly, more reliable than any rule
//     — this applies regardless of placement type, since it's a deliberate
//     correction, not an automatic guess.
//     Kept in whatever currency it was actually entered in — sometimes a
//     deal is recorded in Atlas in USD but genuinely paid in GBP, so forcing
//     everything through USD would be wrong. Optionally carries its own
//     exchange rate too, for the rare case where the real rate that applied
//     to this specific deal genuinely differed from whatever the standard
//     monthly rate table says — expressed the same way every rate in this
//     system already is, "1 GBP = X USD", regardless of which currency the
//     override amount itself is in.
//   - otherwise the default client-based multiplier applies ONLY to genuine
//     placements, matching one of the rules above
//   - otherwise the deal's recorded figure is used completely unchanged
// Returns a decision object; callers apply it to their OWN already-tested
// currency conversion functions, so conversion math itself is never
// duplicated here, only the "which adjustment applies" decision is shared.
function resolveUplift(record, clientName, year, overrides, hasPlacementName) {
  const key = overrideKeyFor(record);
  const override = overrides[key];
  if (override && override.amount !== null && override.amount !== undefined) {
    return {
      type: "override",
      amount: override.amount,
      currency: override.currency || "USD",
      customRate: override.customRate ?? null,
      notes: override.notes || null,
    };
  }
  if (!hasPlacementName) {
    return { type: "none" };
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

// --- Currency conversion, moved here from being duplicated identically
// across deals.js, company-overview.js, and consultant-stats.js. That
// duplication is exactly how the last real bug happened — one copy
// missed a step the other two had, and nothing caught it until Scott
// noticed the numbers didn't match. Three copies of the same logic will
// drift apart again given enough time; one shared copy can't. ---
function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function latestSetMonthKeyForCurrency(allRates, currency) {
  const keys = Object.keys(allRates)
    .filter((k) => allRates[k] && allRates[k][currency] !== undefined && allRates[k][currency] !== null && allRates[k][currency] !== 0)
    .sort();
  return keys.length ? keys[keys.length - 1] : null;
}
function getRateForCurrency(record, allRates, currency) {
  if (record.paid && record.paidMarkedAt) {
    const paidMonthKey = monthKeyFromDateStr(record.paidMarkedAt);
    const paidRate = allRates[paidMonthKey] && allRates[paidMonthKey][currency];
    if (paidRate) return paidRate;
  }
  const latestKey = latestSetMonthKeyForCurrency(allRates, currency);
  return latestKey ? allRates[latestKey][currency] : null;
}
function convertToGBP(record, allRates) {
  if (record.currency === "GBP") return record.shareAmount;
  const gbpRate = getRateForCurrency(record, allRates, "GBP");
  if (!gbpRate) return null;
  if (record.currency === "USD") return record.shareAmount / gbpRate;
  if (record.currency === "EUR") {
    const eurRate = getRateForCurrency(record, allRates, "EUR");
    if (!eurRate) return null;
    const usdEquivalent = record.shareAmount * eurRate;
    return usdEquivalent / gbpRate;
  }
  return null;
}

// The single source of truth for "what is this record's revenue in GBP" —
// conversion, then whichever uplift decision applies, applied correctly.
// Every page that shows a revenue figure should call this instead of
// keeping its own copy of the branching logic, so they can never quietly
// disagree with each other the way they briefly did before this existed.
function resolvedRevenueGBP(record, clientName, year, overrides, hasPlacementName, allRates) {
  const rawGbp = convertToGBP(record, allRates);
  const decision = resolveUplift(record, clientName, year, overrides, hasPlacementName);
  if (decision.type === "override") {
    if (decision.customRate) {
      return decision.currency === "GBP" ? decision.amount : decision.amount / decision.customRate;
    }
    return convertToGBP({ currency: decision.currency, shareAmount: decision.amount, paid: record.paid, paidMarkedAt: record.paidMarkedAt }, allRates);
  }
  if (decision.type === "multiplier" && rawGbp !== null) {
    return rawGbp * decision.value;
  }
  return rawGbp;
}
// --- End currency conversion ---

async function setOverride(feeId, splitId, amount, currency, customRate, notes) {
  const all = await getOverrides();
  const key = `${feeId}:${splitId}`;
  if (amount === null || amount === undefined || amount === "") {
    delete all[key];
  } else {
    const normalizedCurrency = currency === "GBP" ? "GBP" : "USD"; // anything unrecognized defaults to USD, never silently guessed as something else
    const normalizedRate = customRate !== null && customRate !== undefined && customRate !== "" ? Number(customRate) : null;
    all[key] = { amount: Number(amount), currency: normalizedCurrency, customRate: normalizedRate, notes: notes || null, setAt: new Date().toISOString() };
  }
  await kv.set(OVERRIDES_KEY, all);
  return all[key] || null;
}

module.exports = { CLIENT_UPLIFT_RULES, defaultMultiplierFor, resolveUplift, getOverrides, setOverride, OVERRIDES_KEY, convertToGBP, resolvedRevenueGBP };
