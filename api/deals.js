const { getDirectorFromRequest, kv } = require("./_directorAuth");

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only. Edit deal records on the incentive site." });
  }

  const director = await getDirectorFromRequest(req);
  if (!director) {
    return res.status(401).json({ error: "Director access required." });
  }

  const records = (await kv.get(RECORDS_KEY)) || [];
  const allRates = (await kv.get(FX_KEY)) || {};
  const placements = (await kv.get(PLACEMENTS_KEY)) || {};
  const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();

  const yearRecords = records
    .filter((r) => effectiveYear(r, placements) === year)
    .sort((a, b) => orderDateOf(a, placements).localeCompare(orderDateOf(b, placements)));

  const withUSD = await Promise.all(
    yearRecords.map(async (r) => {
      const placement = r.placementId ? placements[r.placementId] : null;
      return {
        ...r,
        usdAmount: await convertToUSD(r, allRates),
        candidateName: (placement && placement.candidateName) || r.notes || null,
        hasPlacementName: !!(placement && placement.candidateName),
        clientCompanyName: (placement && placement.clientCompanyName) || r.projectClientName || null,
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
  // ranked competition.
  const totals = {};
  const bySource = {};
  for (const r of withUSD) {
    if (r.usdAmount === null || !r.consultantId) continue;
    if (!totals[r.consultantId]) totals[r.consultantId] = { consultantId: r.consultantId, consultantName: r.consultantName, totalUSD: 0 };
    totals[r.consultantId].totalUSD += r.usdAmount;
    if (r.source) {
      if (!bySource[r.source]) bySource[r.source] = { source: r.source, deals: 0, valueUSD: 0 };
      bySource[r.source].deals += 1;
      bySource[r.source].valueUSD += r.usdAmount;
    }
  }
  const leaderboard = Object.values(totals).sort((a, b) => b.totalUSD - a.totalUSD);
  const sourceBreakdown = Object.values(bySource).sort((a, b) => b.valueUSD - a.valueUSD);

  // Full client breakdown — every consultant's deals count here, including
  // Scott and Lee's own, since this is the directors' complete financial
  // picture, not the consultants' ranked leaderboard.
  const byClient = {};
  let clientGrandTotal = 0;
  for (const r of withUSD) {
    if (r.usdAmount === null || !r.consultantId) continue;
    const firm = r.clientCompanyName || "Unknown";
    if (!byClient[firm]) byClient[firm] = { firm, totalUSD: 0 };
    byClient[firm].totalUSD += r.usdAmount;
    clientGrandTotal += r.usdAmount;
  }
  const clientBreakdown = Object.values(byClient)
    .map((c) => ({ ...c, percentage: clientGrandTotal > 0 ? (c.totalUSD / clientGrandTotal) * 100 : 0 }))
    .sort((a, b) => b.totalUSD - a.totalUSD);

  return res.status(200).json({ year, records: withUSD, leaderboard, sourceBreakdown, clientBreakdown, clientGrandTotal });
};
