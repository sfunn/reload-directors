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
  const currentYear = new Date().getUTCFullYear();
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
    // Balance Sheet is a point-in-time snapshot, not a range — for the
    // current year, "as at today" is the only real answer; for a past
    // year, "as at 31 December" of that year.
    const asAtDate = year < currentYear ? `${year}-12-31` : currentDateStr;
    const fromDate = `${year}-01-01`;
    const toDate = year < currentYear ? `${year}-12-31` : currentDateStr;

    const [plRes, bsRes] = await Promise.all([
      fetch(`https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${fromDate}&toDate=${toDate}`, { headers: xeroHeaders }),
      fetch(`https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${asAtDate}`, { headers: xeroHeaders }),
    ]);

    if (!plRes.ok || !bsRes.ok) {
      const plBody = await plRes.text();
      const bsBody = await bsRes.text();
      console.error("[xero-reports] report fetch failed:", { plStatus: plRes.status, plBody, bsStatus: bsRes.status, bsBody });
      return res.status(502).json({ error: "Xero rejected the report request. Check the Vercel logs for the exact response." });
    }

    const plData = await plRes.json();
    const bsData = await bsRes.json();

    const plReport = plData.Reports && plData.Reports[0];
    const bsReport = bsData.Reports && bsData.Reports[0];

    const grossProfitRow = plReport ? findRowByLabel(plReport.Rows, ["Gross Profit"]) : null;
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
      grossProfit: grossProfitRow ? grossProfitRow.value : null,
      grossProfitMatchedLabel: grossProfitRow ? grossProfitRow.label : null,
      cash: cashRow ? cashRow.value : null,
      cashMatchedLabel: cashRow ? cashRow.label : null,
      note: "Figures are in your Xero organisation's own reporting currency — not converted to USD.",
    });
  } catch (e) {
    console.error("[xero-reports] error:", e);
    return res.status(500).json({ error: "Something went wrong pulling the reports. Check the Vercel logs for details." });
  }
};
