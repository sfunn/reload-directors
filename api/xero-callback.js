const { getDirectorFromRequest, kv, DIRECTOR_EMAILS } = require("./_directorAuth");
const jwt = require("jsonwebtoken");

const TOKENS_KEY = "xero-oauth-tokens"; // { refreshToken, tenantId, tenantName, connectedAt }

function htmlPage(title, message, ok) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
  <body style="font-family: sans-serif; padding: 40px; text-align: center;">
    <h2 style="color: ${ok ? "#2e405b" : "#c0392b"};">${title}</h2>
    <p>${message}</p>
    <p><a href="/">Return to Reload Directors</a></p>
  </body></html>`;
}

// This single file handles BOTH steps of the Xero OAuth flow, same
// consolidation reasoning as the incentive site's original version — but
// the actual redirect URI registered in Xero's own app settings must now
// point at THIS project's domain: https://reload-directors.vercel.app/api/xero-callback
// If Xero's app settings still list the old incentive-site URL, the
// connection will fail before it ever reaches this code at all.
module.exports = async (req, res) => {
  if (req.query.action === "connect") {
    return handleConnect(req, res);
  }
  if (req.query.action === "status") {
    return handleStatus(req, res);
  }
  return handleCallback(req, res);
};

// Read-only status check — lets the Company Overview page show whether
// Xero is already connected without redoing the OAuth dance every time.
async function handleStatus(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  const tokens = await kv.get(TOKENS_KEY);
  if (!tokens) return res.status(200).json({ connected: false });
  return res.status(200).json({
    connected: true,
    tenantName: tokens.tenantName || null,
    connectedAt: tokens.connectedAt || null,
  });
}

// Scott or Lee clicks "Connect to Xero", gets sent to Xero's own login/
// consent screen, and Xero redirects back to this SAME URL (without
// ?action=connect) with a temporary code we exchange for real tokens.
async function handleConnect(req, res) {
  // This step has to be a genuine browser navigation — it can't be called
  // via fetch() from inside the React app the normal way, so there's no
  // custom Authorization header to read. Instead, the token is passed as
  // a ?token= query parameter, built by the "Connect to Xero" button.
  const queryToken = req.query.token;
  let director = null;
  if (queryToken) {
    try {
      const decoded = jwt.verify(queryToken, process.env.AUTH_JWT_SECRET);
      const email = (decoded.email || "").toLowerCase();
      if (DIRECTOR_EMAILS.has(email)) director = { email };
    } catch (e) {
      director = null;
    }
  }
  if (!director) {
    res.setHeader("Content-Type", "text/html");
    return res.status(401).send(
      htmlPage("Director access required", `Use the "Connect to Xero" button on the Company Overview page instead of visiting this link directly.`, false)
    );
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI; // must be exactly https://reload-directors.vercel.app/api/xero-callback
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "Xero isn't configured yet — XERO_CLIENT_ID and XERO_REDIRECT_URI must be set in Vercel." });
  }

  // A random value Xero echoes back unchanged — lets the callback confirm
  // this specific request initiated the flow, rather than blindly trusting
  // whatever comes back. (Not yet verified against a stored value on
  // callback — see the note in handleCallback below.)
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Confirmed directly from Xero's own current scopes documentation, not
  // guessed a second time — accounting.transactions.read is the OLD broad
  // scope, deprecated as of Xero's move to granular scopes in March 2026.
  // Apps already granted a broad scope before that cutoff can keep using
  // it until September 2027, but a scope requested for the FIRST time
  // after the cutoff has to use its granular replacement instead, which
  // is exactly why the broad scope came back invalid_scope — this app had
  // never been granted transaction access before, so it only ever had the
  // option of the new name. accounting.invoices.read is that replacement:
  // Xero's own documentation lists Invoices as covering Bills too (a Bill
  // is just an Invoice with Type ACCPAY), which is exactly the resource
  // the supplier lookup reads.
  //
  // Adding this scope here only changes what a NEW connection is granted
  // going forward — it can't retroactively widen a refresh token that's
  // already been issued under the old, narrower scope. Reconnecting is
  // required once for this to take effect.
  const scopes = [
    "openid",
    "profile",
    "email",
    "accounting.reports.profitandloss.read",
    "accounting.reports.balancesheet.read",
    "accounting.invoices.read",
    "offline_access",
  ].join(" ");

  const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

// Xero redirects the browser back here after Scott/Lee approves the
// connection in Xero's own consent screen. This exchanges the one-time
// code for a refresh token (which lasts much longer, and is what lets us
// pull fresh reports later without asking anyone to log in again) and
// finds out which Xero organization ("tenant") was actually connected.
async function handleCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    res.setHeader("Content-Type", "text/html");
    return res.status(400).send(htmlPage("Connection cancelled", `Xero reported: ${error}`, false));
  }
  if (!code) {
    res.setHeader("Content-Type", "text/html");
    return res.status(400).send(htmlPage("Something went wrong", "No authorization code was returned by Xero.", false));
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  try {
    const tokenRes = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error("[xero-callback] token exchange failed:", tokenData);
      res.setHeader("Content-Type", "text/html");
      return res.status(400).send(htmlPage("Connection failed", "Xero didn't return a valid token. Check the Vercel logs for details.", false));
    }

    const connectionsRes = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const connections = await connectionsRes.json();
    const tenant = Array.isArray(connections) && connections.length ? connections[0] : null;

    await kv.set(TOKENS_KEY, {
      refreshToken: tokenData.refresh_token,
      tenantId: tenant ? tenant.tenantId : null,
      tenantName: tenant ? tenant.tenantName : null,
      connectedAt: new Date().toISOString(),
    });

    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(
      htmlPage(
        "Xero connected",
        `Successfully connected to ${tenant ? tenant.tenantName : "your Xero organization"}. Gross profit and cash figures will be able to pull from here automatically once that part is built.`,
        true
      )
    );
  } catch (e) {
    console.error("[xero-callback] error:", e);
    res.setHeader("Content-Type", "text/html");
    return res.status(500).send(htmlPage("Something went wrong", "An unexpected error occurred. Check the Vercel logs for details.", false));
  }
}
