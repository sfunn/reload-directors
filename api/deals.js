const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolveUplift, getOverrides, setOverride } = require("./_dealRevenueUplift");

const RECORDS_KEY = "atlas-fee-records"; // shared with the incentive site — read only, never written here
const FX_KEY = "atlas-fx-rates";
const PLACEMENTS_KEY = "atlas-placements";

// --- Everything below this line is a direct port of the incentive site's
// api/deals.js "detail" logic (Super-Admin-only view). Kept byte-for-byte
// equivalent on purpose, so this page can never silently drift from the
// numbers Scott and Lee already trust on the incentive site. If that logic
// ever changes there, port the change here too rather than re-deriving it. ---

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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

// GBP is Reload's own real reporting currency, same as Company Overview —
// ported directly from that file rather than re-derived, so the two pages
// can never quietly disagree on what a pound is worth.
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

function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
}

function orderDateOf(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  return (placement && placement.startDate) || record.feeDate || "";
}

// --- End direct port ---

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) {
    return res.status(401).json({ error: "Director access required." });
  }

  // The ONE deliberate write path on this otherwise read-only page — a
  // manual revenue override for a specific deal, when the true figure is
  // known to be higher than even the standard client uplift below would
  // produce. Stored entirely separately from atlas-fee-records, never
  // touches the shared, incentive-site-owned deal data itself.
  if (req.method === "POST" && req.query.action === "set-deal-override") {
    const { feeId, splitId, amount, currency, customRate, notes } = req.body || {};
    if (!feeId || !splitId) return res.status(400).json({ error: "feeId and splitId are both required." });
    const result = await setOverride(feeId, splitId, amount, currency, customRate, notes);
    return res.status(200).json({ ok: true, override: result });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only. Edit deal records on the incentive site." });
  }

  const records = (await kv.get(RECORDS_KEY)) || [];
  const allRates = (await kv.get(FX_KEY)) || {};
  const placements = (await kv.get(PLACEMENTS_KEY)) || {};
  const overrides = await getOverrides();
  const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();

  const yearRecords = records
    .filter((r) => effectiveYear(r, placements) === year)
    .sort((a, b) => orderDateOf(a, placements).localeCompare(orderDateOf(b, placements)));

  const withUSD = await Promise.all(
    yearRecords.map(async (r) => {
      const placement = r.placementId ? placements[r.placementId] : null;
      const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
      const hasPlacementName = !!(placement && placement.candidateName);
      const rawUsdAmount = await convertToUSD(r, allRates);
      const rawGbpAmount = convertToGBP(r, allRates);

      // Revenue-only uplift — never touches commission, never touches the
      // underlying record, only what gets shown as this deal's revenue
      // figure here and on Company Overview. GBP is the primary, editable
      // figure on this page now, matching Company Overview's own
      // convention; USD is derived alongside purely as a reference.
      const decision = resolveUplift(r, clientCompanyName, year, overrides, hasPlacementName);
      let usdAmount = rawUsdAmount;
      let gbpAmount = rawGbpAmount;
      if (decision.type === "override") {
        if (decision.customRate) {
          // A specific real rate was recorded for this deal, overriding the
          // standard monthly rate table entirely — expressed as 1 GBP = X
          // USD, same convention as everywhere else, regardless of which
          // currency the override amount itself was entered in.
          if (decision.currency === "GBP") {
            gbpAmount = decision.amount;
            usdAmount = decision.amount * decision.customRate;
          } else {
            usdAmount = decision.amount;
            gbpAmount = decision.amount / decision.customRate;
          }
        } else {
          // The override might genuinely be in GBP, not USD — e.g. a deal
          // recorded in Atlas as USD but actually paid in pounds. Build one
          // pseudo-record and run it through BOTH conversion functions —
          // each already handles GBP and USD correctly on its own.
          const pseudoRecord = { currency: decision.currency, shareAmount: decision.amount, paid: r.paid, paidMarkedAt: r.paidMarkedAt };
          gbpAmount = convertToGBP(pseudoRecord, allRates);
          usdAmount = await convertToUSD(pseudoRecord, allRates);
        }
      } else if (decision.type === "multiplier") {
        if (rawUsdAmount !== null) usdAmount = rawUsdAmount * decision.value;
        if (rawGbpAmount !== null) gbpAmount = rawGbpAmount * decision.value;
      }

      return {
        ...r,
        rawUsdAmount,
        rawGbpAmount,
        usdAmount,
        gbpAmount,
        upliftType: decision.type, // "override" | "multiplier" | "none" — lets the frontend show exactly what applied
        upliftMultiplier: decision.type === "multiplier" ? decision.value : null,
        upliftOverrideAmount: decision.type === "override" ? decision.amount : null,
        upliftOverrideCurrency: decision.type === "override" ? decision.currency : null,
        upliftOverrideCustomRate: decision.type === "override" ? decision.customRate : null,
        upliftNotes: decision.type === "override" ? decision.notes : null,
        candidateName: (placement && placement.candidateName) || r.notes || null,
        hasPlacementName,
        clientCompanyName,
        placementStartDate: (placement && placement.startDate) || r.feeDate || null,
        monthOverrides: r.monthOverrides || {},
        coordinatorId: r.coordinatorId || null,
        source: r.source || null,
      };
    })
  );

  // Ranked totals per consultant, everyone included — unlike the incentive
  // site's own leaderboard, this doesn't exclude Scott and Lee, since this
  // is the directors' complete financial picture, not the consultants'
  // ranked competition. GBP is the primary figure everywhere on this page
  // now, matching Company Overview — a deal counts once it can convert to
  // GBP, same rule as there.
  const totals = {};
  const bySource = {};
  let grandTotalGBP = 0;
  for (const r of withUSD) {
    if (r.gbpAmount === null || !r.consultantId) continue;
    grandTotalGBP += r.gbpAmount;
    if (!totals[r.consultantId]) totals[r.consultantId] = { consultantId: r.consultantId, consultantName: r.consultantName, totalGBP: 0, totalUSD: 0, deals: 0, onsites: 0 };
    totals[r.consultantId].totalGBP += r.gbpAmount;
    if (r.usdAmount !== null) totals[r.consultantId].totalUSD += r.usdAmount;
    if (r.hasPlacementName) totals[r.consultantId].deals += 1; else totals[r.consultantId].onsites += 1;
    if (r.source) {
      if (!bySource[r.source]) bySource[r.source] = { source: r.source, deals: 0, valueGBP: 0, valueUSD: 0 };
      bySource[r.source].deals += 1;
      bySource[r.source].valueGBP += r.gbpAmount;
      if (r.usdAmount !== null) bySource[r.source].valueUSD += r.usdAmount;
    }
  }
  const leaderboard = Object.values(totals)
    .map((t) => ({ ...t, percentage: grandTotalGBP > 0 ? (t.totalGBP / grandTotalGBP) * 100 : 0 }))
    .sort((a, b) => b.totalGBP - a.totalGBP);
  const sourceBreakdown = Object.values(bySource)
    .map((s) => ({ ...s, percentage: grandTotalGBP > 0 ? (s.valueGBP / grandTotalGBP) * 100 : 0 }))
    .sort((a, b) => b.valueGBP - a.valueGBP);

  // Full client breakdown — every consultant's deals count here, including
  // Scott and Lee's own, since this is the directors' complete financial
  // picture, not the consultants' ranked leaderboard.
  const byClient = {};
  let clientGrandTotalGBP = 0;
  let clientGrandTotal = 0;
  for (const r of withUSD) {
    if (r.gbpAmount === null || !r.consultantId) continue;
    const firm = r.clientCompanyName || "Unknown";
    if (!byClient[firm]) byClient[firm] = { firm, totalGBP: 0, totalUSD: 0, deals: 0, onsites: 0 };
    byClient[firm].totalGBP += r.gbpAmount;
    if (r.usdAmount !== null) byClient[firm].totalUSD += r.usdAmount;
    if (r.hasPlacementName) byClient[firm].deals += 1; else byClient[firm].onsites += 1;
    clientGrandTotalGBP += r.gbpAmount;
    if (r.usdAmount !== null) clientGrandTotal += r.usdAmount;
  }
  const clientBreakdown = Object.values(byClient)
    .map((c) => ({ ...c, percentage: clientGrandTotalGBP > 0 ? (c.totalGBP / clientGrandTotalGBP) * 100 : 0 }))
    .sort((a, b) => b.totalGBP - a.totalGBP);

  return res.status(200).json({ year, records: withUSD, leaderboard, sourceBreakdown, clientBreakdown, clientGrandTotal, clientGrandTotalGBP });
};
