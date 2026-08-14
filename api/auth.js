const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { kv, DIRECTOR_EMAILS, DIRECTOR_USERS_KEY } = require("./_directorAuth");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;

  // --- Set or reset a director's password. Requires the shared setup
  // code (DIRECTOR_SETUP_CODE), known only to Scott and Lee. This doubles
  // as the password-reset path too — running it again with the right code
  // just overwrites the existing hash, no separate "forgot password" flow
  // needed. ---
  if (req.method === "POST" && action === "setup") {
    const { email, password, setupCode } = req.body || {};
    if (!email || !password || !setupCode) {
      return res.status(400).json({ error: "Email, password, and setup code are all required." });
    }
    if (!process.env.DIRECTOR_SETUP_CODE || setupCode !== process.env.DIRECTOR_SETUP_CODE) {
      return res.status(401).json({ error: "Incorrect setup code." });
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (!DIRECTOR_EMAILS.has(normalizedEmail)) {
      return res.status(401).json({ error: "This email is not authorized for director access." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const users = (await kv.get(DIRECTOR_USERS_KEY)) || {};
    users[normalizedEmail] = { passwordHash, updatedAt: new Date().toISOString() };
    await kv.set(DIRECTOR_USERS_KEY, users);

    return res.status(200).json({ ok: true });
  }

  // --- Normal login. Checks ONLY the director-users table, never
  // auth-users. Deliberately vague error messages either way (doesn't say
  // "no such user" vs "wrong password") so this endpoint can't be used to
  // fish for which emails have an account set up. ---
  if (req.method === "POST" && action === "login") {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (!DIRECTOR_EMAILS.has(normalizedEmail)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const users = (await kv.get(DIRECTOR_USERS_KEY)) || {};
    const record = users[normalizedEmail];
    if (!record) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const matches = await bcrypt.compare(password, record.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    if (!process.env.AUTH_JWT_SECRET) {
      return res.status(500).json({ error: "Server misconfigured — AUTH_JWT_SECRET not set." });
    }
    const token = jwt.sign({ email: normalizedEmail }, process.env.AUTH_JWT_SECRET, { expiresIn: "30d" });

    return res.status(200).json({ token, email: normalizedEmail });
  }

  return res.status(400).json({ error: "Unknown action." });
};
