const { kv } = require("@vercel/kv");
const jwt = require("jsonwebtoken");

// The only two people who will EVER be accepted by this entire site.
// Hardcoded, not read from any database — this is deliberately not the
// same isSuperAdmin flag from the incentive site's auth-users, and never
// should be. Changing who counts as a director means editing this file
// and redeploying, on purpose, not flipping a flag on a shared table.
const DIRECTOR_EMAILS = new Set([
  "scott@reloadsearch.com",
  "lee@reloadsearch.com",
]);

const DIRECTOR_USERS_KEY = "director-users"; // { [email]: { passwordHash, updatedAt } }

// Verifies the Authorization: Bearer <token> header against THIS site's
// own JWT secret (AUTH_JWT_SECRET on the reload-directors Vercel project —
// a different value to the one on the incentive project, on purpose).
// Also re-checks DIRECTOR_EMAILS on every call, not just at login time, so
// if this file is ever edited to remove someone, their existing token
// stops working immediately rather than staying valid until it expires.
async function getDirectorFromRequest(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !process.env.AUTH_JWT_SECRET) return null;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.AUTH_JWT_SECRET);
  } catch (e) {
    return null;
  }

  const email = (decoded.email || "").toLowerCase();
  if (!DIRECTOR_EMAILS.has(email)) return null;

  return { email };
}

module.exports = { getDirectorFromRequest, DIRECTOR_EMAILS, DIRECTOR_USERS_KEY, kv };
