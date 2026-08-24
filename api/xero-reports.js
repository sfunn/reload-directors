const { getDirectorFromRequest, kv } = require("./_directorAuth");

const TOKENS_KEY = "xero-oauth-tokens"; // { refreshToken, tenantId, tenantName, connectedAt }

// Xero rotates the refresh token on EVERY use — the one you just used
// becomes invalid the instant a new one is issued. If we don't store the
// new one every single time, the connection breaks after exactly one pull
// and has to be reconnected from scratch. This is the single most
// important thing to get right in this file.
async function getFreshAccessToken() {
  const tokens = await kv.get(TOKENS_KEY);
  if (!tokens || !tokens.refreshToken) {
    return { error: "Xero isn't connected yet. Connect it from Company Overview first." };
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  const tokenRes = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error("[xero-reports] refresh failed:", tokenData);
    return { error: "Xero's connection has expired or been revoked. Reconnect it from Company Overview." };
  }

  // Store the new refresh token immediately, before doing anything else —
  // if the report calls below fail for some unrelated reason, the
  // connection must still survive for next time.
  await kv.set(TOKENS_KEY, {
    ...tokens,
    refreshToken: tokenData.refresh_token || tokens.refreshToken,
  });

  return { accessToken: tokenData.access_token, tenantId: tokens.tenantId, tenantName: tokens.tenantName };
}

// Xero's report JSON nests rows inside sections inside more rows, and
// exactly where a named line sits (top-level Section vs buried inside a
// SummaryRow) genuinely varies by how an organisation's chart of accounts
// and report layout are set up — recovered from documented Xero Reports
// API structure, not verified against this specific organisation's real
// report yet. Walking the whole tree looking for the label, rather than
// assuming a fixed position, is the only way to be robust to that.
function findRowByLabel(rows, candidateLabels) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row.Cells && row.Cells[0] && typeof row.Cells[0].Value === "string") {
      const label = row.Cells[0].Value.trim().toLowerCase();
      if (candidateLabels.some((c) => c.toLowerCase() === label)) {
        const valueCell = row.Cells[1];
        const raw = valueCell ? valueCell.Value : null;
        const num = raw !== null && raw !== undefined && raw !== "" ? Number(raw) : null;
        if (num !== null && !isNaN(num)) {
          return { label: row.Cells[0].Value, value: num };
        }
      }
    }
    if (Array.isArray(row.Rows)) {
      const found = findRowByLabel(row.Rows, candidateLabels);
      if (found) return found;
    }
  }
  return null;
}

// Reload's real financial year, hardcoded, not derived from any general
// rule — because it genuinely isn't a general rule, it's a one-time
// transition. Confirmed directly with Scott, not guessed:
//   - Any year before 2026: the old financial year, 1 August (year-1) to
//     31 July (year) — e.g. "2025" means 1 Aug 2024 to 31 Jul 2025.
//   - 2026 specifically: a one-off EXTENDED 17-month period, 1 August 2025
//     to 31 December 2026, bridging the old year-end to the new one. This
//     is Reload's live change of accounting reference date, not a bug to
//     "fix" into a normal 12-month span.
//   - 2027 onward: a clean calendar year, 1 January to 31 December — which
//     from this point on finally matches the calendar-year convention
//     Revenue and Average Fee already use everywhere else on this page.
// If Reload's financial year end ever changes again, this needs updating
// here on purpose, not by trying to generalize it into a formula.
const TRANSITION_YEAR = 2026;
const TRANSITION_START = "2025-08-01";
const TRANSITION_END = "2026-12-31";

function fiscalYearRange(year) {
  if (year === TRANSITION_YEAR) {
    return { fromDate: TRANSITION_START, periodEndDate: TRANSITION_END };
  }
  if (year > TRANSITION_YEAR) {
    return { fromDate: `${year}-01-01`, periodEndDate: `${year}-12-31` };
  }
  return { fromDate: `${year - 1}-08-01`, periodEndDate: `${year}-07-31` };
}

// Xero's Profit and Loss report rejects any single request spanning more
// than 365 days ("The fromDate and toDate parameters must be within 365
// days of each other" — confirmed directly from a real failed request,
// not assumed). Reload's 17-month bridge financial year is always going
// to exceed that on its own, and even an ordinary 12-month calendar year
// hits exactly this wall in any leap year (366 days) — so this chunker
// isn't a one-off special case for the bridge year, it's applied to every
// period, and normally just produces a single chunk that covers the whole
// range untouched.
function splitIntoChunks(fromDate, toDate, maxSpanDays = 364) {
  const chunks = [];
  let chunkStart = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (chunkStart <= end) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxSpanDays);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({ from: chunkStart.toISOString().slice(0, 10), to: actualEnd.toISOString().slice(0, 10) });
    chunkStart = new Date(actualEnd);
    chunkStart.setUTCDate(chunkStart.getUTCDate() + 1);
  }
  return chunks;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only." });
  }

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
  const currentDateStr = new Date().toISOString().slice(0, 10);

  const auth = await getFreshAccessToken();
  if (auth.error) return res.status(400).json({ error: auth.error });
  const { accessToken, tenantId, tenantName } = auth;

  const xeroHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Xero-tenant-id": tenantId,
    Accept: "application/json",
  };

  try {
    const { fromDate, periodEndDate } = fiscalYearRange(year);

    // Three genuinely different cases, not just "cap at today":
    // the period could be fully in the past, still in progress, or hasn't
    // started yet at all. Capping toDate at today only makes sense for the
    // middle case — for a future period, fromDate would end up AFTER
    // toDate, an inverted range Xero would either reject or misreport.
    if (currentDateStr < fromDate) {
      return res.status(400).json({ error: `That financial year hasn't started yet — it begins ${fromDate}.` });
    }
    const toDate = currentDateStr < periodEndDate ? currentDateStr : periodEndDate;
    const asAtDate = toDate; // Balance Sheet is a snapshot as at the end of whatever window we just computed

    const plChunks = splitIntoChunks(fromDate, toDate);

    const [plResults, bsRes] = await Promise.all([
      Promise.all(plChunks.map((c) =>
        fetch(`https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${c.from}&toDate=${c.to}`, { headers: xeroHeaders })
      )),
      fetch(`https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${asAtDate}`, { headers: xeroHeaders }),
    ]);

    const failedChunk = plResults.find((r) => !r.ok);
    if (failedChunk || !bsRes.ok) {
      const plBodies = await Promise.all(plResults.map((r) => r.text()));
      const bsBody = await bsRes.text();
      console.error("[xero-reports] report fetch failed:", {
        plChunks, plStatuses: plResults.map((r) => r.status), plBodies,
        bsStatus: bsRes.status, bsBody,
      });
      return res.status(502).json({ error: "Xero rejected the report request. Check the Vercel logs for the exact response." });
    }

    const plDataChunks = await Promise.all(plResults.map((r) => r.json()));
    const bsData = await bsRes.json();

    // Gross Profit is a flow over time, not a snapshot — summing it across
    // consecutive, non-overlapping date chunks gives the exact same answer
    // a single (disallowed) request for the whole period would have, so
    // splitting the range doesn't compromise the figure's accuracy.
    let grossProfitTotal = null;
    let matchedLabel = null;
    for (const plData of plDataChunks) {
      const plReport = plData.Reports && plData.Reports[0];
      const row = plReport ? findRowByLabel(plReport.Rows, ["Gross Profit"]) : null;
      if (row) {
        grossProfitTotal = (grossProfitTotal || 0) + row.value;
        matchedLabel = row.label;
      }
    }

    const bsReport = bsData.Reports && bsData.Reports[0];
    // Different Xero report templates label this differently depending on
    // region/setup — checking several plausible real labels rather than
    // assuming one.
    const cashRow = bsReport ? findRowByLabel(bsReport.Rows, ["Total Bank", "Bank", "Cash and Cash Equivalents", "Total Cash and Cash Equivalents"]) : null;

    return res.status(200).json({
      year,
      tenantName,
      periodStart: fromDate,
      periodEnd: toDate,
      asAtDate,
      periodsCombined: plChunks.length,
      grossProfit: grossProfitTotal,
      grossProfitMatchedLabel: matchedLabel,
      cash: cashRow ? cashRow.value : null,
      cashMatchedLabel: cashRow ? cashRow.label : null,
      note: "Figures are in your Xero organisation's own reporting currency — not converted to USD.",
    });
  } catch (e) {
    console.error("[xero-reports] error:", e);
    return res.status(500).json({ error: "Something went wrong pulling the reports. Check the Vercel logs for details." });
  }
};
