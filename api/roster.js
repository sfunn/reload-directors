const { getDirectorFromRequest, kv } = require("./_directorAuth");

const EMPLOYMENT_KEY = "consultant-employment"; // { [id]: { startDate, terminationDate, salaryHistory: [{effectiveDate, salaryGBP, notes}], notes } } — owned entirely by this site, single source of truth for everyone's dates and pay

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

// Salary genuinely changes over time — promotions, pay rises — so it's
// tracked as a real dated history, same carry-forward principle already
// used for commission bands and exchange rates elsewhere in this system:
// the salary "as of" any date is whichever entry has the most recent
// effectiveDate on or before that date. A single flat number could never
// answer "what were they paid in 2022," only "what are they paid today."
function salaryAsOf(history, dateStr) {
  const applicable = (history || []).filter((e) => e.effectiveDate <= dateStr).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return applicable.length ? applicable[0].salaryGBP : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  if (req.method === "GET") {
    const employment = (await kv.get(EMPLOYMENT_KEY)) || {};
    const today = new Date().toISOString().slice(0, 10);
    const roster = Object.entries(ROSTER)
      .map(([id, info]) => {
        const emp = employment[id] || {};
        const salaryHistory = emp.salaryHistory || [];
        return {
          consultantId: id,
          consultantName: info.name,
          category: info.category,
          startDate: emp.startDate || null,
          terminationDate: emp.terminationDate || null,
          currentSalaryGBP: salaryAsOf(salaryHistory, today),
          salaryHistory: [...salaryHistory].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
          notes: emp.notes || null,
        };
      })
      .sort((a, b) => a.consultantName.localeCompare(b.consultantName));
    return res.status(200).json({ roster });
  }

  if (req.method === "POST" && req.query.action === "set-employment") {
    const { consultantId, startDate, terminationDate, notes } = req.body || {};
    if (!consultantId || !ROSTER[consultantId]) {
      return res.status(400).json({ error: "A valid consultantId is required." });
    }
    const employment = (await kv.get(EMPLOYMENT_KEY)) || {};
    const existing = employment[consultantId] || {};
    employment[consultantId] = {
      ...existing,
      startDate: startDate || null,
      terminationDate: terminationDate || null,
      notes: notes || null,
    };
    await kv.set(EMPLOYMENT_KEY, employment);
    return res.status(200).json({ ok: true, entry: employment[consultantId] });
  }

  // Salary is deliberately a SEPARATE action from the rest of employment
  // data — adding a new dated entry, never overwriting the history, so a
  // pay rise is recorded as a new fact, not a correction erasing what came
  // before it.
  if (req.method === "POST" && req.query.action === "add-salary-entry") {
    const { consultantId, effectiveDate, salaryGBP, notes } = req.body || {};
    if (!consultantId || !ROSTER[consultantId]) {
      return res.status(400).json({ error: "A valid consultantId is required." });
    }
    const salary = parseFloat(salaryGBP);
    if (!effectiveDate || isNaN(salary) || salary < 0) {
      return res.status(400).json({ error: "A valid effective date and a non-negative salary are both required." });
    }
    const employment = (await kv.get(EMPLOYMENT_KEY)) || {};
    const existing = employment[consultantId] || {};
    const history = existing.salaryHistory || [];
    const newEntry = { effectiveDate, salaryGBP: salary, notes: notes || null };
    employment[consultantId] = {
      ...existing,
      salaryHistory: [...history, newEntry].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    };
    await kv.set(EMPLOYMENT_KEY, employment);
    return res.status(200).json({ ok: true, entry: newEntry, history: employment[consultantId].salaryHistory });
  }

  // Genuine mistakes happen — a wrong figure or wrong date typed in by
  // accident isn't a fact worth preserving the way a real pay rise is, so
  // unlike adding an entry, this one actually removes it. Identified by
  // its position in the same chronologically-sorted order the GET response
  // already returns, so what the director sees on screen is exactly what
  // gets removed, no separate ID scheme to keep in sync.
  if (req.method === "POST" && req.query.action === "delete-salary-entry") {
    const { consultantId, index } = req.body || {};
    if (!consultantId || !ROSTER[consultantId]) {
      return res.status(400).json({ error: "A valid consultantId is required." });
    }
    const idx = parseInt(index, 10);
    const employment = (await kv.get(EMPLOYMENT_KEY)) || {};
    const existing = employment[consultantId] || {};
    const history = [...(existing.salaryHistory || [])].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    if (isNaN(idx) || idx < 0 || idx >= history.length) {
      return res.status(400).json({ error: "A valid entry index is required." });
    }
    history.splice(idx, 1);
    employment[consultantId] = { ...existing, salaryHistory: history };
    await kv.set(EMPLOYMENT_KEY, employment);
    return res.status(200).json({ ok: true, history: employment[consultantId].salaryHistory });
  }

  return res.status(400).json({ error: "Unknown action." });
};

module.exports.ROSTER = ROSTER;
module.exports.EMPLOYMENT_KEY = EMPLOYMENT_KEY;
module.exports.salaryAsOf = salaryAsOf;
