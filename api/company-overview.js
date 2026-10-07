const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolveUplift, resolvedRevenueGBP, getOverrides, isExcludedProjectRecord } = require("./_dealRevenueUplift");
const { EMPLOYMENT_KEY } = require("./roster");
const { buildTimeline, countAsOf } = require("./headcount");
const { MANUAL_METRICS_KEY, normalizeYearMetrics, resolveManualMetricsForPeriod, saveManualMetricForPeriod } = require("./_manualMetricsStore");

const RECORDS_KEY = "atlas-fee-records"; // shared with the incentive site — read only, never written here
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";

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
    // countedDeals counts fee RECORDS, and a record is one consultant's share,
    // so a placement split between two consultants is two records. These two
    // give the plain-English counts: distinct placements, and onsite fees
    // (records that are not tied to a named placement).
    const countedPlacementIds = new Set();
    let onsiteFeeCount = 0;
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
      if (hasPlacementName && r.placementId) countedPlacementIds.add(r.placementId); else onsiteFeeCount += 1;
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
      distinctPlacements: countedPlacementIds.size,
      onsiteFeeCount,
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

// The data every period calculation needs, fetched once per request.
async function loadSharedData() {
  const [records, placements, allRates, manualMetrics, overrides, employment] = await Promise.all([
    kv.get(RECORDS_KEY).then((v) => v || []),
    kv.get(PLACEMENTS_KEY).then((v) => v || {}),
    kv.get(FX_KEY).then((v) => v || {}),
    kv.get(MANUAL_METRICS_KEY).then((v) => v || {}),
    getOverrides(),
    kv.get(EMPLOYMENT_KEY).then((v) => v || {}),
  ]);
  return { records, placements, allRates, manualMetrics, overrides, employment };
}

// Revenue for each calendar month of one year, built with exactly the
// same filters and the same revenue function as the Overview, so the
// twelve months can never quietly disagree with the year total shown
// there. A record with no resolvable date can't be placed in a month,
// but it does count toward the Overview's year total, so it's reported
// separately here rather than silently dropped: months + undated always
// equals the Overview's figure.
function computeMonthlyRevenueSeries(year, shared) {
  const { records, placements, allRates, overrides } = shared;
  const months = Array.from({ length: 12 }, (_, i) => ({ month: String(i + 1).padStart(2, "0"), revenueGBP: 0, deals: 0, byClient: {} }));
  let undatedGBP = 0;
  let undatedDeals = 0;
  for (const r of records) {
    if (effectiveYear(r, placements) !== year || isExcludedProjectRecord(r)) continue;
    const placement = r.placementId ? placements[r.placementId] : null;
    const client = (placement && placement.clientCompanyName) || r.projectClientName || "Unknown";
    const hasPlacementName = !!(placement && placement.candidateName);
    const gbp = resolvedRevenueGBP(r, client, year, overrides, hasPlacementName, allRates);
    if (gbp === null) continue;
    const m = effectiveMonth(r, placements);
    if (!m) { undatedGBP += gbp; undatedDeals += 1; continue; }
    const bucket = months[parseInt(m, 10) - 1];
    bucket.revenueGBP += gbp;
    bucket.deals += 1;
    bucket.byClient[client] = (bucket.byClient[client] || 0) + gbp;
  }
  const totalGBP = months.reduce((s, b) => s + b.revenueGBP, 0) + undatedGBP;
  return { year, months, undatedGBP, undatedDeals, totalGBP };
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

// Attaches each row's own revenue change to a concentration table —
// matched by the entity itself (client name, or consultantId), never by
// position in the list, since who's in 3rd place can genuinely differ
// between two periods even when nothing about any one client's own
// revenue changed. A client or consultant with no row at all in the
// comparison period (a brand new client this period, say) correctly
// gets null rather than a misleading 0% or an invented "infinite"
// increase from a zero base.
function addEntityChanges(currentList, prevList, sameLastYearList, keyField) {
  const findIn = (list, key) => (list || []).find((e) => e[keyField] === key);
  return currentList.map((entity) => {
    const prevMatch = findIn(prevList, entity[keyField]);
    const sameLastYearMatch = findIn(sameLastYearList, entity[keyField]);
    return {
      ...entity,
      changes: {
        previousPeriod: prevMatch ? percentChange(entity.totalGBP, prevMatch.totalGBP) : null,
        sameLastYear: sameLastYearMatch ? percentChange(entity.totalGBP, sameLastYearMatch.totalGBP) : null,
      },
    };
  });
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

    const shared = await loadSharedData();

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

    const clientConcentrationWithChanges = addEntityChanges(
      current.clientConcentration,
      prevMetrics.clientConcentration,
      sameLastYearMetrics ? sameLastYearMetrics.clientConcentration : null,
      "client"
    );
    const consultantConcentrationWithChanges = addEntityChanges(
      current.consultantConcentration,
      prevMetrics.consultantConcentration,
      sameLastYearMetrics ? sameLastYearMetrics.consultantConcentration : null,
      "consultantId"
    );

    return res.status(200).json({
      ...current,
      clientConcentration: clientConcentrationWithChanges,
      consultantConcentration: consultantConcentrationWithChanges,
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

  if (req.method === "GET" && action === "revenue-series") {
    const seriesYear = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
    const shared = await loadSharedData();
    return res.status(200).json({
      year: seriesYear,
      current: computeMonthlyRevenueSeries(seriesYear, shared),
      previous: computeMonthlyRevenueSeries(seriesYear - 1, shared),
    });
  }

  if (req.method === "POST" && action === "set-manual-metric") {
    const { year, period, month, quarter, ...fields } = req.body || {};
    try {
      const saved = await saveManualMetricForPeriod(year, period, month, quarter, fields);
      return res.status(200).json({ ok: true, year: parseInt(year, 10), period: period || "year", month: period === "month" ? month : null, quarter: period === "quarter" ? quarter : null, metrics: saved });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
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
