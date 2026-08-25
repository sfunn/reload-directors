const { getDirectorFromRequest, kv } = require("./_directorAuth");

const EMPLOYMENT_KEY = "consultant-employment"; // { [id]: { startDate, terminationDate, notes } } — owned entirely by this site, single source of truth for everyone's dates

// The full roster this site tracks dates for — the 12 fee-earning people
// (same list Consultant Stats already uses, reused directly rather than
// retyped) plus the two coordinators. Headcount is now DERIVED entirely
// from this data, not tracked separately — one source of truth, so it can
// never quietly disagree with what's actually entered here.
const ROSTER = {
  "alex-silverman": { name: "Alex Silverman", category: "feeEarning" },
  "ash-thiara": { name: "Ash Thiara", category: "feeEarning" },
  "jack-thompson": { name: "Jack Thompson", category: "feeEarning" },
  "max-hart": { name: "Max Hart", category: "feeEarning" },
  "oleg-sokyrka": { name: "Oleg Sokyrka", category: "feeEarning" },
  "alex-aparo": { name: "Alex Aparo", category: "feeEarning" },
  "jack-routledge": { name: "Jack Routledge", category: "feeEarning" },
  "joe-purton": { name: "Joe Purton", category: "feeEarning" },
  "josh-davis": { name: "Josh Davis", category: "feeEarning" },
  "natasha-barnard": { name: "Natasha Barnard", category: "feeEarning" },
  "james-lancer": { name: "James Lancer", category: "feeEarning" },
  "josh-stark": { name: "Josh Stark", category: "feeEarning" },
  "izzy-coordinator": { name: "Izzy", category: "coordinator" },
  "zoe-coordinator": { name: "Alexandra", category: "coordinator" },
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  if (req.method === "GET") {
    const employment = (await kv.get(EMPLOYMENT_KEY)) || {};
    const roster = Object.entries(ROSTER)
      .map(([id, info]) => ({
        consultantId: id,
        consultantName: info.name,
        category: info.category,
        startDate: (employment[id] && employment[id].startDate) || null,
        terminationDate: (employment[id] && employment[id].terminationDate) || null,
        notes: (employment[id] && employment[id].notes) || null,
      }))
      .sort((a, b) => a.consultantName.localeCompare(b.consultantName));
    return res.status(200).json({ roster });
  }

  if (req.method === "POST" && req.query.action === "set-employment") {
    const { consultantId, startDate, terminationDate, notes } = req.body || {};
    if (!consultantId || !ROSTER[consultantId]) {
      return res.status(400).json({ error: "A valid consultantId is required." });
    }
    const employment = (await kv.get(EMPLOYMENT_KEY)) || {};
    employment[consultantId] = {
      startDate: startDate || null,
      terminationDate: terminationDate || null,
      notes: notes || null,
    };
    await kv.set(EMPLOYMENT_KEY, employment);
    return res.status(200).json({ ok: true, entry: employment[consultantId] });
  }

  return res.status(400).json({ error: "Unknown action." });
};

module.exports.ROSTER = ROSTER;
module.exports.EMPLOYMENT_KEY = EMPLOYMENT_KEY;
