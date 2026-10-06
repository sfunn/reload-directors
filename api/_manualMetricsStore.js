const { kv } = require("./_directorAuth");

// This key's ownership belongs fully to this site now — the incentive
// site's own Company Overview page (and this key) were deleted from that
// codebase entirely when the two sites split. Nothing else touches it.
const MANUAL_METRICS_KEY = "company-manual-metrics"; // { [year]: { [periodKey]: { grossProfitAmount, notes, ... } } } — periodKey is "year", "Q1".."Q4", or "01".."12"

// Before period-level tracking existed, each year held one flat object
// of fields directly — { grossProfitAmount, cashAmount, ... }. The new
// shape nests those same fields under a period key instead — "year",
// "Q1".."Q4", or "01".."12" — so a year can hold a whole-year figure, a
// quarter's, a month's, or any mix, as more gets entered at finer
// granularity over time. This treats the old flat shape as exactly
// equivalent to a "year" period entry, so every year of real data
// already entered keeps working untouched, nothing to migrate.
// The full, fixed set of valid period keys — checking against this
// exhaustive set, rather than trying to list every possible old-shape
// field name, is what makes this detection reliable. A field-name list
// risks missing one (interestAmount and taxAmount were both missing
// from an earlier version of this check, a real bug caught by testing
// a year that had only one of those fields set), where the period-key
// set can't be incomplete, since it's the same known list used
// everywhere else in this file.
const VALID_PERIOD_KEYS = new Set(["year", "Q1", "Q2", "Q3", "Q4", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
function normalizeYearMetrics(raw) {
  if (!raw || typeof raw !== "object") return {};
  const keys = Object.keys(raw);
  const looksNew = keys.length > 0 && keys.every((k) => VALID_PERIOD_KEYS.has(k));
  if (looksNew) return raw;
  return { year: raw };
}

// Combines several period entries (whichever months or quarters were
// actually saved) into one figure. Gross Profit, Total Expenses, D&A,
// Interest, and Tax are all genuine flows over time, so summing them
// across a span is correct. Cash is a point-in-time balance, not a
// flow — summing twelve months of "cash in the bank" would be nonsense,
// so this always takes the latest period's own cash figure instead,
// never a sum of several.
function aggregatePeriodEntries(entries) {
  if (entries.length === 0) return null;
  const sumField = (field) => {
    const values = entries.map((e) => e[field]).filter((v) => v !== null && v !== undefined);
    return values.length > 0 ? values.reduce((s, v) => s + v, 0) : null;
  };
  const latestCashEntry = [...entries].reverse().find((e) => e.cashAmount !== null && e.cashAmount !== undefined);
  return {
    grossProfitAmount: sumField("grossProfitAmount"),
    grossProfitCurrency: "GBP",
    notes: entries.map((e) => e.notes).filter(Boolean).join("; ") || null,
    cashAmount: latestCashEntry ? latestCashEntry.cashAmount : null,
    cashCurrency: "GBP",
    cashNotes: latestCashEntry ? latestCashEntry.cashNotes : null,
    totalExpensesAmount: sumField("totalExpensesAmount"),
    totalExpensesCurrency: "GBP",
    totalExpensesNotes: entries.map((e) => e.totalExpensesNotes).filter(Boolean).join("; ") || null,
    depreciationAmortisationAmount: sumField("depreciationAmortisationAmount"),
    depreciationAmortisationCurrency: "GBP",
    depreciationAmortisationNotes: entries.map((e) => e.depreciationAmortisationNotes).filter(Boolean).join("; ") || null,
    interestAmount: sumField("interestAmount"),
    interestCurrency: "GBP",
    interestNotes: entries.map((e) => e.interestNotes).filter(Boolean).join("; ") || null,
    taxAmount: sumField("taxAmount"),
    taxCurrency: "GBP",
    taxNotes: entries.map((e) => e.taxNotes).filter(Boolean).join("; ") || null,
  };
}

const QUARTER_MONTHS = { Q1: ["01", "02", "03"], Q2: ["04", "05", "06"], Q3: ["07", "08", "09"], Q4: ["10", "11", "12"] };

// Resolves whichever period was asked for down to an actual set of
// figures, preferring the most direct, exact entry over an aggregated
// one: an exact quarter entry beats summing its three months; an exact
// year entry (how every year's figure has always been entered so far)
// beats summing quarters or months. Returns null only when genuinely
// nothing was ever entered for that period at any granularity.
function resolveManualMetricsForPeriod(yearMetrics, period, month, quarter) {
  if (period === "month") {
    return yearMetrics[month] || null;
  }
  if (period === "quarter") {
    if (yearMetrics[quarter]) return yearMetrics[quarter];
    const monthsInQuarter = QUARTER_MONTHS[quarter] || [];
    const monthEntries = monthsInQuarter.map((m) => yearMetrics[m]).filter(Boolean);
    if (monthEntries.length === monthsInQuarter.length && monthEntries.length > 0) return aggregatePeriodEntries(monthEntries);
    return null;
  }
  // Year (the default) — an exact year entry first, since that's how
  // every year of real data has always been entered up to now.
  if (yearMetrics.year) return yearMetrics.year;
  const allQuarters = ["Q1", "Q2", "Q3", "Q4"].map((q) => yearMetrics[q]).filter(Boolean);
  if (allQuarters.length === 4) return aggregatePeriodEntries(allQuarters);
  const allMonths = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"].map((m) => yearMetrics[m]).filter(Boolean);
  if (allMonths.length === 12) return aggregatePeriodEntries(allMonths);
  // Partial data entered so far this year (some months but not all
  // twelve) still genuinely exists — showing nothing at all would be
  // less honest than showing what's actually been entered to date.
  if (allMonths.length > 0) return aggregatePeriodEntries(allMonths);
  if (allQuarters.length > 0) return aggregatePeriodEntries(allQuarters);
  return null;
}

// Saves a set of fields into one specific period's entry, merging with
// whatever already exists there rather than overwriting the whole
// entry — a field left undefined (or an empty string) keeps its
// existing value rather than getting wiped to blank. This is the exact
// same merge logic both the director's own manual save and the
// automated daily Xero pull use, so the two can never silently handle
// "field Xero didn't find" differently from each other.
async function saveManualMetricForPeriod(year, period, month, quarter, fields) {
  const y = parseInt(year, 10);
  if (!y) throw new Error("A valid year is required.");
  const periodKey = period === "month" ? month : period === "quarter" ? quarter : "year";
  if (period === "month" && !/^(0[1-9]|1[0-2])$/.test(month || "")) throw new Error("A valid month is required.");
  if (period === "quarter" && !/^Q[1-4]$/.test(quarter || "")) throw new Error("A valid quarter is required.");

  const all = (await kv.get(MANUAL_METRICS_KEY)) || {};
  const yearMetrics = normalizeYearMetrics(all[y]);
  const existing = yearMetrics[periodKey] || {};
  const {
    grossProfitAmount, grossProfitCurrency, notes, cashAmount, cashCurrency, cashNotes,
    totalExpensesAmount, totalExpensesCurrency, totalExpensesNotes,
    depreciationAmortisationAmount, depreciationAmortisationCurrency, depreciationAmortisationNotes,
    interestAmount, interestCurrency, interestNotes,
    taxAmount, taxCurrency, taxNotes,
  } = fields || {};

  yearMetrics[periodKey] = {
    // Gross Profit is now deliberately kept in whatever currency it was
    // entered in, same reasoning as Cash below — never force-converted
    // or silently assumed to be USD.
    grossProfitAmount: grossProfitAmount === "" || grossProfitAmount === undefined ? (existing.grossProfitAmount ?? existing.grossProfitUSD) || null : Number(grossProfitAmount),
    grossProfitCurrency: grossProfitCurrency !== undefined ? grossProfitCurrency : existing.grossProfitCurrency || null,
    notes: notes !== undefined ? notes : existing.notes || null,
    // Cash is deliberately kept in whatever currency it was entered in —
    // Reload's own reporting currency from Xero, most likely — rather
    // than force-converted to USD like the deal-based figures above.
    cashAmount: cashAmount === "" || cashAmount === undefined ? existing.cashAmount || null : Number(cashAmount),
    cashCurrency: cashCurrency !== undefined ? cashCurrency : existing.cashCurrency || null,
    cashNotes: cashNotes !== undefined ? cashNotes : existing.cashNotes || null,
    // Total Expenses — same reasoning again, kept in whatever currency
    // it was entered in.
    totalExpensesAmount: totalExpensesAmount === "" || totalExpensesAmount === undefined ? existing.totalExpensesAmount || null : Number(totalExpensesAmount),
    totalExpensesCurrency: totalExpensesCurrency !== undefined ? totalExpensesCurrency : existing.totalExpensesCurrency || null,
    totalExpensesNotes: totalExpensesNotes !== undefined ? totalExpensesNotes : existing.totalExpensesNotes || null,
    // The three pieces needed to reconstruct EBITDA from Gross Profit
    // and Total Expenses above — same currency-preserving reasoning
    // throughout.
    depreciationAmortisationAmount: depreciationAmortisationAmount === "" || depreciationAmortisationAmount === undefined ? existing.depreciationAmortisationAmount || null : Number(depreciationAmortisationAmount),
    depreciationAmortisationCurrency: depreciationAmortisationCurrency !== undefined ? depreciationAmortisationCurrency : existing.depreciationAmortisationCurrency || null,
    depreciationAmortisationNotes: depreciationAmortisationNotes !== undefined ? depreciationAmortisationNotes : existing.depreciationAmortisationNotes || null,
    interestAmount: interestAmount === "" || interestAmount === undefined ? existing.interestAmount || null : Number(interestAmount),
    interestCurrency: interestCurrency !== undefined ? interestCurrency : existing.interestCurrency || null,
    interestNotes: interestNotes !== undefined ? interestNotes : existing.interestNotes || null,
    taxAmount: taxAmount === "" || taxAmount === undefined ? existing.taxAmount || null : Number(taxAmount),
    taxCurrency: taxCurrency !== undefined ? taxCurrency : existing.taxCurrency || null,
    taxNotes: taxNotes !== undefined ? taxNotes : existing.taxNotes || null,
  };
  all[y] = yearMetrics;
  await kv.set(MANUAL_METRICS_KEY, all);
  return yearMetrics[periodKey];
}

module.exports = {
  MANUAL_METRICS_KEY,
  normalizeYearMetrics,
  aggregatePeriodEntries,
  resolveManualMetricsForPeriod,
  saveManualMetricForPeriod,
};
