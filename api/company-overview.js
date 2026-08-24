const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolveUplift, getOverrides } = require("./_dealRevenueUplift");

const RECORDS_KEY = "atlas-fee-records"; // shared with the incentive site — read only, never written here
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";
// This key's ownership belongs fully to this site now — the incentive
// site's own Company Overview page (and this key) were deleted from that
// codebase entirely when the two sites split. Nothing else touches it.
const MANUAL_METRICS_KEY = "company-manual-metrics"; // { [year]: { grossProfitUSD, notes } }

// --- Direct port of the incentive site's original company-overview.js
// logic, recovered from its git history before it was deleted there. Kept
// equivalent on purpose, not re-derived. ---

function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
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
    const [records, placements, allRates, manualMetrics, overrides] = await Promise.all([
      kv.get(RECORDS_KEY).then((v) => v || []),
      kv.get(PLACEMENTS_KEY).then((v) => v || {}),
      kv.get(FX_KEY).then((v) => v || {}),
      kv.get(MANUAL_METRICS_KEY).then((v) => v || {}),
      getOverrides(),
    ]);

    const yearRecords = records.filter((r) => effectiveYear(r, placements) === year);
    let totalRevenueGBP = 0;
    let totalRevenueUSD = 0;
    let countedDeals = 0;
    const byClient = {};
    for (const r of yearRecords) {
      const rawGbp = convertToGBP(r, allRates);
      const rawUsd = await convertToUSD(r, allRates);
      const placement = r.placementId ? placements[r.placementId] : null;
      const client = (placement && placement.clientCompanyName) || r.projectClientName || "Unknown";

      // Same revenue-only uplift as the Yearly Deal Table, applied here so
      // Company Overview never silently disagrees with it — deliberately
      // never touches commission anywhere in this codebase.
      const decision = resolveUplift(r, client, year, overrides);
      let gbp = rawGbp;
      let usd = rawUsd;
      if (decision.type === "override") {
        usd = decision.amountUSD;
        // Convert the override's USD figure to GBP using the exact same
        // rate-lookup rules as any other record — same paid/paidMarkedAt
        // driven month selection, just fed a USD pseudo-record instead of
        // re-deriving currency logic.
        const pseudoRecord = { currency: "USD", shareAmount: decision.amountUSD, paid: r.paid, paidMarkedAt: r.paidMarkedAt };
        gbp = convertToGBP(pseudoRecord, allRates);
      } else if (decision.type === "multiplier") {
        if (rawGbp !== null) gbp = rawGbp * decision.value;
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
      if (!byClient[client]) byClient[client] = { gbp: 0, usd: 0 };
      byClient[client].gbp += gbp;
      if (usd !== null) byClient[client].usd += usd;
    }

    const averageFeeGBP = countedDeals > 0 ? totalRevenueGBP / countedDeals : 0;
    const averageFeeUSD = countedDeals > 0 ? totalRevenueUSD / countedDeals : 0;

    const clientConcentration = Object.entries(byClient)
      .map(([client, v]) => ({
        client,
        totalGBP: v.gbp,
        totalUSD: v.usd,
        percentage: totalRevenueGBP > 0 ? (v.gbp / totalRevenueGBP) * 100 : 0,
      }))
      .sort((a, b) => b.totalGBP - a.totalGBP);
    const top3Percentage = clientConcentration.slice(0, 3).reduce((s, c) => s + c.percentage, 0);
    const top5Percentage = clientConcentration.slice(0, 5).reduce((s, c) => s + c.percentage, 0);

    const manual = manualMetrics[year] || {};

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

    return res.status(200).json({
      year,
      totalRevenueGBP, totalRevenueUSD, countedDeals,
      averageFeeGBP, averageFeeUSD,
      clientConcentration, top3Percentage, top5Percentage,
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
    });
  }

  if (req.method === "POST" && action === "set-manual-metric") {
    const { year, grossProfitAmount, grossProfitCurrency, notes, cashAmount, cashCurrency, cashNotes } = req.body || {};
    const y = parseInt(year, 10);
    if (!y) return res.status(400).json({ error: "A valid year is required." });
    const all = (await kv.get(MANUAL_METRICS_KEY)) || {};
    all[y] = {
      ...all[y],
      // Gross Profit is now deliberately kept in whatever currency it was
      // entered in, same reasoning as Cash below — never force-converted
      // or silently assumed to be USD.
      grossProfitAmount: grossProfitAmount === "" || grossProfitAmount === undefined ? (all[y] && (all[y].grossProfitAmount ?? all[y].grossProfitUSD)) || null : Number(grossProfitAmount),
      grossProfitCurrency: grossProfitCurrency !== undefined ? grossProfitCurrency : (all[y] && all[y].grossProfitCurrency) || null,
      notes: notes !== undefined ? notes : (all[y] && all[y].notes) || null,
      // Cash is deliberately kept in whatever currency it was entered in —
      // Reload's own reporting currency from Xero, most likely — rather
      // than force-converted to USD like the deal-based figures above.
      cashAmount: cashAmount === "" || cashAmount === undefined ? (all[y] && all[y].cashAmount) || null : Number(cashAmount),
      cashCurrency: cashCurrency !== undefined ? cashCurrency : (all[y] && all[y].cashCurrency) || null,
      cashNotes: cashNotes !== undefined ? cashNotes : (all[y] && all[y].cashNotes) || null,
    };
    await kv.set(MANUAL_METRICS_KEY, all);
    return res.status(200).json({ ok: true, year: y, metrics: all[y] });
  }

  return res.status(400).json({ error: "Unknown action." });
};
