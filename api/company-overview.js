const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolveUplift, resolvedRevenueGBP, getOverrides, isExcludedProjectRecord } = require("./_dealRevenueUplift");
const { EMPLOYMENT_KEY } = require("./roster");
const { buildTimeline, countAsOf } = require("./headcount");

const RECORDS_KEY = "atlas-fee-records"; // shared with the incentive site — read only, never written here
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";
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
const FIELD_NAMES_INDICATING_OLD_SHAPE = ["grossProfitAmount", "grossProfitUSD", "cashAmount", "totalExpensesAmount", "notes"];
function normalizeYearMetrics(raw) {
  if (!raw || typeof raw !== "object") return {};
  const looksOld = FIELD_NAMES_INDICATING_OLD_SHAPE.some((f) => f in raw);
  if (looksOld) return { year: raw };
  return raw;
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

// Resolves whichever period was asked for down to an actual set of
// figures, preferring the most direct, exact entry over an aggregated
// one: an exact quarter entry beats summing its three months; an exact
// year entry (how every year's figure has always been entered so far)
// beats summing quarters or months. Returns null only when genuinely
// nothing was ever entered for that period at any granularity.
function resolveManualMetricsForPeriod(yearMetrics, period, month, quarter) {
  const QUARTER_MONTHS = { Q1: ["01", "02", "03"], Q2: ["04", "05", "06"], Q3: ["07", "08", "09"], Q4: ["10", "11", "12"] };
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

// EBITDA = operating profit (Gross Profit minus Total Expenses) with
// Depreciation & Amortisation, Interest, and Tax all added back — only
// Gross Profit and Total Expenses are genuinely required for this to
// compute at all, the other three default to zero if never entered,
// since plenty of real businesses genuinely carry none of them. Exported
// so anywhere else that needs an EBITDA figure — Ask a Question, for
// one — uses this exact same calculation, not a second copy of it.
function computeEBITDA(grossProfitAmount, totalExpensesAmount, depreciationAmortisationAmount, interestAmount, taxAmount) {
  if (grossProfitAmount === null || grossProfitAmount === undefined || totalExpensesAmount === null || totalExpensesAmount === undefined) return null;
  return (grossProfitAmount - totalExpensesAmount) + (depreciationAmortisationAmount || 0) + (interestAmount || 0) + (taxAmount || 0);
}

// --- Direct port of the incentive site's original company-overview.js
// logic, recovered from its git history before it was deleted there. Kept
// equivalent on purpose, not re-derived. ---

function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
}

// Same date resolution as effectiveYear above, but returns "MM" rather
// than just the year — used to narrow revenue down to a specific month
// or quarter, which effectiveYear alone can't do. Returns null for a
// record with no real resolvable date, since there's nothing honest to
// attribute it to at this finer grain (effectiveYear would silently
// fall back to record.year for these, which isn't precise enough to
// place within a specific month).
function effectiveMonth(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? String(d.getUTCMonth() + 1).padStart(2, "0") : null;
}

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

async function convertToUSD(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  const rate = getRateForCurrency(record, allRates, record.currency);
  if (!rate) return null;
  return record.shareAmount * rate;
}

// GBP is Reload's own real reporting currency — the one Xero and the
// actual accounts use — so this is now the PRIMARY figure on this page,
// with USD kept only as a secondary reference number. Same conversion
// logic already proven in commission.js, ported here rather than
// re-derived, including the via-USD bridge for EUR.
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

// --- End direct port ---

// Computes the full set of overview figures for one specific period —
// a single month, a quarter, or the whole year — given data already
// fetched once and shared across however many periods need computing
// (the period itself, plus whatever it's being compared against), so
// records/placements/rates/manual metrics are never re-fetched per
// comparison period.
async function computeOverviewForPeriod(year, period, month, quarter, shared) {
    const QUARTER_MONTHS_LOOKUP = { Q1: ["01", "02", "03"], Q2: ["04", "05", "06"], Q3: ["07", "08", "09"], Q4: ["10", "11", "12"] };
    const { records, placements, allRates, manualMetrics, overrides, employment } = shared;

    const monthsToInclude = period === "month" ? [month] : period === "quarter" ? (QUARTER_MONTHS_LOOKUP[quarter] || []) : null;
    const yearRecords = records.filter((r) => {
      if (effectiveYear(r, placements) !== year || isExcludedProjectRecord(r)) return false;
      if (monthsToInclude) return monthsToInclude.includes(effectiveMonth(r, placements));
      return true;
    });
    let totalRevenueGBP = 0;
    let totalRevenueUSD = 0;
    let countedDeals = 0;
    let placementRevenueGBP = 0;
    let placementRevenueUSD = 0;
    let placementCount = 0;
    const byClient = {};
    const byConsultant = {};
    for (const r of yearRecords) {
      const rawGbp = convertToGBP(r, allRates);
      const rawUsd = await convertToUSD(r, allRates);
      const placement = r.placementId ? placements[r.placementId] : null;
      const client = (placement && placement.clientCompanyName) || r.projectClientName || "Unknown";
      const hasPlacementName = !!(placement && placement.candidateName);

      // GBP now comes from the single shared function every revenue page
      // calls, so this can never quietly drift from the Deal Table or
      // Consultant Stats the way it briefly did before that existed. USD
      // stays computed locally — a genuinely separate concern the shared
      // function doesn't cover.
      const decision = resolveUplift(r, client, year, overrides, hasPlacementName);
      const gbp = resolvedRevenueGBP(r, client, year, overrides, hasPlacementName, allRates);
      let usd = rawUsd;
      if (decision.type === "override") {
        if (decision.customRate) {
          // A specific real rate was recorded for this deal, overriding the
          // standard monthly rate table entirely — expressed as 1 GBP = X
          // USD, same convention as everywhere else in this system.
          usd = decision.currency === "GBP" ? decision.amount * decision.customRate : decision.amount;
        } else {
          // The override might genuinely be in GBP, not USD — e.g. a deal
          // recorded in Atlas as USD but actually paid in pounds.
          usd = await convertToUSD({ currency: decision.currency, shareAmount: decision.amount, paid: r.paid, paidMarkedAt: r.paidMarkedAt }, allRates);
        }
      } else if (decision.type === "multiplier") {
        if (rawUsd !== null) usd = rawUsd * decision.value;
      }

      // GBP is now the primary, deal-counting figure — a deal only counts
      // toward the headline totals once it can actually convert to GBP.
      // The USD figure is tracked alongside from the exact same set of
      // deals wherever it's available, purely as a secondary reference,
      // never driving its own separate deal count.
      if (gbp === null) continue;
      totalRevenueGBP += gbp;
      if (usd !== null) totalRevenueUSD += usd;
      countedDeals += 1;
      // A genuinely separate running total, only for real placements — an
      // onsite fee is real revenue (it stays in totalRevenueGBP above,
      // unchanged), but it isn't a placement, and Average Fee is meant to
      // answer "what's a typical placement worth," not get quietly dragged
      // down by small onsite fees counted as if each one were a deal too.
      if (hasPlacementName) {
        placementRevenueGBP += gbp;
        if (usd !== null) placementRevenueUSD += usd;
        placementCount += 1;
      }
      if (!byClient[client]) byClient[client] = { gbp: 0, usd: 0, deals: 0, onsites: 0 };
      byClient[client].gbp += gbp;
      if (usd !== null) byClient[client].usd += usd;
      if (hasPlacementName) byClient[client].deals += 1; else byClient[client].onsites += 1;
      const consultantKey = r.consultantId || "unmapped";
      const consultantName = r.consultantName || r.consultantId || "Unmapped";
      if (!byConsultant[consultantKey]) byConsultant[consultantKey] = { consultantName, gbp: 0, usd: 0, deals: 0, onsites: 0 };
      byConsultant[consultantKey].gbp += gbp;
      if (usd !== null) byConsultant[consultantKey].usd += usd;
      if (hasPlacementName) byConsultant[consultantKey].deals += 1; else byConsultant[consultantKey].onsites += 1;
    }

    // A real placement's average value, not diluted by onsite fees counted
    // as if each one were its own deal — Total Revenue above still
    // correctly includes onsite money, this is deliberately a separate
    // calculation, not a filtered view of the same one.
    const averageFeeGBP = placementCount > 0 ? placementRevenueGBP / placementCount : 0;
    const averageFeeUSD = placementCount > 0 ? placementRevenueUSD / placementCount : 0;

    const clientConcentration = Object.entries(byClient)
      .map(([client, v]) => ({
        client,
        totalGBP: v.gbp,
        totalUSD: v.usd,
        deals: v.deals,
        onsites: v.onsites,
        percentage: totalRevenueGBP > 0 ? (v.gbp / totalRevenueGBP) * 100 : 0,
      }))
      .sort((a, b) => b.totalGBP - a.totalGBP);
    const top3Percentage = clientConcentration.slice(0, 3).reduce((s, c) => s + c.percentage, 0);
    const top5Percentage = clientConcentration.slice(0, 5).reduce((s, c) => s + c.percentage, 0);

    // Key-person risk — the exact same computation as client concentration,
    // just grouped by whoever closed the deal instead of who bought it.
    // Includes everyone with a real deal attributed to them, Scott and Lee
    // included, matching how Revenue itself already includes their deals.
    const consultantConcentration = Object.entries(byConsultant)
      .map(([consultantId, v]) => ({
        consultantId,
        consultantName: v.consultantName,
        totalGBP: v.gbp,
        totalUSD: v.usd,
        deals: v.deals,
        onsites: v.onsites,
        percentage: totalRevenueGBP > 0 ? (v.gbp / totalRevenueGBP) * 100 : 0,
      }))
      .sort((a, b) => b.totalGBP - a.totalGBP);
    const consultantTop3Percentage = consultantConcentration.slice(0, 3).reduce((s, c) => s + c.percentage, 0);
    const consultantTop5Percentage = consultantConcentration.slice(0, 5).reduce((s, c) => s + c.percentage, 0);

    const yearMetrics = normalizeYearMetrics(manualMetrics[year]);
    const manual = resolveManualMetricsForPeriod(yearMetrics, period, month, quarter) || {};

    // A small USD reference figure alongside Gross Profit/Cash, reusing
    // the exact same rate-lookup logic above rather than a new one — only
    // computed when the entered currency is one we can actually convert
    // (GBP, EUR, or already USD); left out entirely rather than guessed
    // for anything else.
    async function usdEquivalentFor(amount, currency) {
      if (amount === null || amount === undefined || !currency) return null;
      if (currency === "USD") return amount;
      const pseudoRecord = { currency, shareAmount: amount, paid: false, paidMarkedAt: null };
      return convertToUSD(pseudoRecord, allRates);
    }
    const grossProfitAmount = manual.grossProfitAmount ?? manual.grossProfitUSD ?? null;
    const grossProfitCurrency = manual.grossProfitCurrency || (manual.grossProfitUSD != null ? "USD" : null);
    const cashAmount = manual.cashAmount ?? null;
    const cashCurrency = manual.cashCurrency || null;
    const totalExpensesAmount = manual.totalExpensesAmount ?? null;
    const totalExpensesCurrency = manual.totalExpensesCurrency || null;
    const depreciationAmortisationAmount = manual.depreciationAmortisationAmount ?? null;
    const depreciationAmortisationCurrency = manual.depreciationAmortisationCurrency || null;
    const interestAmount = manual.interestAmount ?? null;
    const interestCurrency = manual.interestCurrency || null;
    const taxAmount = manual.taxAmount ?? null;
    const taxCurrency = manual.taxCurrency || null;

    // EBITDA = operating profit (Gross Profit minus Total Expenses) with
    // Depreciation & Amortisation, Interest, and Tax all added back —
    // but only Gross Profit and Total Expenses are genuinely required
    const ebitdaAmount = computeEBITDA(grossProfitAmount, totalExpensesAmount, depreciationAmortisationAmount, interestAmount, taxAmount);

    // Revenue per head — genuinely derived from the roster's real dates,
    // never faked. For any year that ends before the very first tracked
    // start date, there's honestly nothing to divide by, so this returns
    // null rather than silently using today's headcount for a period it
    // never applied to.
    const feeEarningTimeline = buildTimeline(employment, "feeEarning");
    const periodEndMonth = period === "month" ? month : period === "quarter" ? (QUARTER_MONTHS_LOOKUP[quarter] || [])[2] : "12";
    const periodEndLastDay = periodEndMonth ? new Date(Date.UTC(year, parseInt(periodEndMonth, 10), 0)).getUTCDate() : 31;
    const yearEndDate = periodEndMonth ? `${year}-${periodEndMonth}-${String(periodEndLastDay).padStart(2, "0")}` : `${year}-12-31`;
    const headcountForYear = countAsOf(feeEarningTimeline, yearEndDate);
    const revenuePerHeadGBP = headcountForYear > 0 ? totalRevenueGBP / headcountForYear : null;
    const revenuePerHeadUSD = headcountForYear > 0 ? totalRevenueUSD / headcountForYear : null;

    return {
      year,
      period: period || "year",
      month: period === "month" ? month : null,
      quarter: period === "quarter" ? quarter : null,
      totalRevenueGBP, totalRevenueUSD, countedDeals,
      averageFeePlacementCount: placementCount,
      averageFeeGBP, averageFeeUSD,
      clientConcentration, top3Percentage, top5Percentage,
      consultantConcentration, consultantTop3Percentage, consultantTop5Percentage,
      revenuePerHeadGBP,
      revenuePerHeadUSD,
      headcountUsedForPerHead: headcountForYear > 0 ? headcountForYear : null,
      // grossProfitAmount/grossProfitCurrency replace the old grossProfitUSD
      // field, which wrongly assumed this figure was always in USD — it
      // isn't, since it now often comes straight from Xero in Reload's own
      // GBP reporting currency. Falls back to reading a legacy grossProfitUSD
      // value as USD, in case anything was saved before this fix existed.
      grossProfitAmount,
      grossProfitCurrency,
      grossProfitUSDEquivalent: await usdEquivalentFor(grossProfitAmount, grossProfitCurrency),
      grossProfitNotes: manual.notes || null,
      cashAmount,
      cashCurrency,
      cashUSDEquivalent: await usdEquivalentFor(cashAmount, cashCurrency),
      cashNotes: manual.cashNotes || null,
      // Total Expenses — same currency-preserving reasoning as Gross
      // Profit and Cash, since it's pulled straight from the same P&L
      // report Gross Profit already comes from.
      totalExpensesAmount,
      totalExpensesCurrency,
      totalExpensesUSDEquivalent: await usdEquivalentFor(totalExpensesAmount, totalExpensesCurrency),
      totalExpensesNotes: manual.totalExpensesNotes || null,
      depreciationAmortisationAmount,
      depreciationAmortisationCurrency,
      depreciationAmortisationNotes: manual.depreciationAmortisationNotes || null,
      interestAmount,
      interestCurrency,
      interestNotes: manual.interestNotes || null,
      taxAmount,
      taxCurrency,
      taxNotes: manual.taxNotes || null,
      ebitdaAmount,
      ebitdaUSDEquivalent: await usdEquivalentFor(ebitdaAmount, "GBP"),
    };
}

// Resolves the identifiers for whichever period comes immediately
// before the one requested — the previous month, the previous quarter,
// or the previous year — correctly rolling over a year boundary where
// needed (January's previous month is December of last year; Q1's
// previous quarter is Q4 of last year).
function previousPeriodOf(year, period, month, quarter) {
  if (period === "month") {
    const m = parseInt(month, 10);
    return m === 1 ? { year: year - 1, period: "month", month: "12" } : { year, period: "month", month: String(m - 1).padStart(2, "0") };
  }
  if (period === "quarter") {
    const qNum = parseInt(quarter.slice(1), 10);
    return qNum === 1 ? { year: year - 1, period: "quarter", quarter: "Q4" } : { year, period: "quarter", quarter: `Q${qNum - 1}` };
  }
  return { year: year - 1, period: "year" };
}

// The same calendar period one year earlier — month-for-month or
// quarter-for-quarter, not just "the previous period," since a
// recruitment business can have real seasonal patterns a plain
// previous-period comparison would miss entirely (December vs November
// says much less than December vs December last year).
function samePeriodLastYear(year, period, month, quarter) {
  return { year: year - 1, period, month, quarter };
}

// null when there's genuinely nothing to compare against (no prior
// figure at all, or a prior figure of exactly zero, which would make
// any "% change" either meaningless or a division by zero), never a
// fake 0% standing in for "no comparison available."
function percentChange(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

// The handful of headline figures worth a % change at all — the ones
// shown as a single, standalone number on the page. The concentration
// tables get their own, separate per-entity change, not this.
const COMPARABLE_FIELDS = ["totalRevenueGBP", "averageFeeGBP", "revenuePerHeadGBP", "grossProfitAmount", "cashAmount", "totalExpensesAmount", "ebitdaAmount"];

function buildChanges(current, comparison) {
  if (!comparison) return null;
  const changes = {};
  for (const field of COMPARABLE_FIELDS) changes[field] = percentChange(current[field], comparison[field]);
  return changes;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  const action = req.query.action;

  if (req.method === "GET" && (!action || action === "overview")) {
    const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
    const { period, month, quarter } = req.query;

    const [records, placements, allRates, manualMetrics, overrides, employment] = await Promise.all([
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
      kv.get(FX_KEY).then((v) => v || {}),
      kv.get(MANUAL_METRICS_KEY).then((v) => v || {}),
      getOverrides(),
      kv.get(EMPLOYMENT_KEY).then((v) => v || {}),
    ]);
    const shared = { records, placements, allRates, manualMetrics, overrides, employment };

    const current = await computeOverviewForPeriod(year, period, month, quarter, shared);

    // Two comparisons, computed the same way as the period itself, not
    // approximated — the previous period immediately before this one,
    // and the same period a year ago. For the year view these are
    // actually identical (both are simply last year), so the same-
    // last-year comparison is left out entirely there rather than
    // showing the same number twice under two different labels.
    const prev = previousPeriodOf(year, period || "year", month, quarter);
    const sameLastYear = (period === "month" || period === "quarter") ? samePeriodLastYear(year, period, month, quarter) : null;

    const [prevMetrics, sameLastYearMetrics] = await Promise.all([
      computeOverviewForPeriod(prev.year, prev.period, prev.month, prev.quarter, shared),
      sameLastYear ? computeOverviewForPeriod(sameLastYear.year, sameLastYear.period, sameLastYear.month, sameLastYear.quarter, shared) : Promise.resolve(null),
    ]);

    return res.status(200).json({
      ...current,
      changes: {
        previousPeriod: buildChanges(current, prevMetrics),
        sameLastYear: buildChanges(current, sameLastYearMetrics),
      },
      comparisonPeriods: {
        previousPeriod: { year: prev.year, period: prev.period, month: prev.month || null, quarter: prev.quarter || null },
        sameLastYear: sameLastYear ? { year: sameLastYear.year, period: sameLastYear.period, month: sameLastYear.month || null, quarter: sameLastYear.quarter || null } : null,
      },
    });
  }

  if (req.method === "POST" && action === "set-manual-metric") {
    const {
      year, period, month, quarter,
      grossProfitAmount, grossProfitCurrency, notes, cashAmount, cashCurrency, cashNotes,
      totalExpensesAmount, totalExpensesCurrency, totalExpensesNotes,
      depreciationAmortisationAmount, depreciationAmortisationCurrency, depreciationAmortisationNotes,
      interestAmount, interestCurrency, interestNotes,
      taxAmount, taxCurrency, taxNotes,
    } = req.body || {};
    const y = parseInt(year, 10);
    if (!y) return res.status(400).json({ error: "A valid year is required." });
    // Which period key this save actually belongs to — "year" (the
    // default, how every figure has been entered up to now), "Q1".."Q4",
    // or "01".."12".
    const periodKey = period === "month" ? month : period === "quarter" ? quarter : "year";
    if (period === "month" && !/^(0[1-9]|1[0-2])$/.test(month || "")) return res.status(400).json({ error: "A valid month is required." });
    if (period === "quarter" && !/^Q[1-4]$/.test(quarter || "")) return res.status(400).json({ error: "A valid quarter is required." });

    const all = (await kv.get(MANUAL_METRICS_KEY)) || {};
    const yearMetrics = normalizeYearMetrics(all[y]);
    const existing = yearMetrics[periodKey] || {};
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
    return res.status(200).json({ ok: true, year: y, period: period || "year", month: period === "month" ? month : null, quarter: period === "quarter" ? quarter : null, metrics: yearMetrics[periodKey] });
  }

  // Repeat Client Rate — deliberately NOT scoped to a single year, unlike
  // everything else in this file. "Repeat" is a question across the whole
  // relationship, not within one calendar year — a client who placed once
  // in 2023 and once in 2025 is a genuine repeat client even though those
  // two deals never appear together in any single year's view. Counts
  // genuine placements only, matching the same distinction used everywhere
  // else in this system — an onsite fee isn't the thing "did they come
  // back for another hire" is actually asking about.
  if (req.method === "GET" && action === "repeat-clients") {
    const [records, placements] = await Promise.all([
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
    ]);
    const byClient = {};
    for (const r of records) {
      if (isExcludedProjectRecord(r)) continue;
      const placement = r.placementId ? placements[r.placementId] : null;
      const hasPlacementName = !!(placement && placement.candidateName);
      if (!hasPlacementName) continue; // onsite fees don't count toward "repeat"
      const client = (placement && placement.clientCompanyName) || r.projectClientName || "Unknown";
      if (!byClient[client]) byClient[client] = { client, placementCount: 0, firstPlacementDate: null, lastPlacementDate: null };
      byClient[client].placementCount += 1;
      const d = r.feeDate;
      if (d) {
        if (!byClient[client].firstPlacementDate || d < byClient[client].firstPlacementDate) byClient[client].firstPlacementDate = d;
        if (!byClient[client].lastPlacementDate || d > byClient[client].lastPlacementDate) byClient[client].lastPlacementDate = d;
      }
    }
    const clients = Object.values(byClient).sort((a, b) => b.placementCount - a.placementCount);
    const totalClients = clients.length;
    const repeatClients = clients.filter((c) => c.placementCount >= 2).length;
    const repeatClientRate = totalClients > 0 ? (repeatClients / totalClients) * 100 : null;
    return res.status(200).json({ clients, totalClients, repeatClients, repeatClientRate });
  }

  return res.status(400).json({ error: "Unknown action." });
};

module.exports.computeEBITDA = computeEBITDA;
