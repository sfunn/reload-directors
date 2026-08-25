const { getDirectorFromRequest, kv } = require("./_directorAuth");

const HEADCOUNT_KEY = "headcount-history"; // { feeEarning: [{date, count, note}], coordinators: [{date, count, note}] } — owned entirely by this site, no Atlas dependency

// The actual current roster, same source of truth as Consultant Stats —
// used only to seed a genuine starting point the very first time this is
// read, never re-derived after that. Deliberately NOT re-computed from
// these lists on every load, since headcount should only change when a
// real, dated entry is explicitly added, not silently whenever the code
// happens to be edited for an unrelated reason.
const CURRENT_FEE_EARNING_COUNT = 12; // 10 consultants + James Lancer + Josh Stark
const CURRENT_COORDINATOR_COUNT = 2; // Izzy + Alexandra

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function getHistory() {
  const stored = await kv.get(HEADCOUNT_KEY);
  if (stored) return stored;
  // First-ever read — seed with today's real count, honestly labelled as
  // a starting point, not backfilled or guessed for any earlier date.
  const seeded = {
    feeEarning: [{ date: todayStr(), count: CURRENT_FEE_EARNING_COUNT, note: "Starting count" }],
    coordinators: [{ date: todayStr(), count: CURRENT_COORDINATOR_COUNT, note: "Starting count" }],
  };
  await kv.set(HEADCOUNT_KEY, seeded);
  return seeded;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  if (req.method === "GET") {
    const history = await getHistory();
    const latestFeeEarning = history.feeEarning[history.feeEarning.length - 1];
    const latestCoordinators = history.coordinators[history.coordinators.length - 1];
    return res.status(200).json({
      currentFeeEarning: latestFeeEarning ? latestFeeEarning.count : null,
      currentCoordinators: latestCoordinators ? latestCoordinators.count : null,
      feeEarningHistory: history.feeEarning,
      coordinatorHistory: history.coordinators,
    });
  }

  if (req.method === "POST" && req.query.action === "add-entry") {
    const { category, date, count, note } = req.body || {};
    if (category !== "feeEarning" && category !== "coordinators") {
      return res.status(400).json({ error: "category must be 'feeEarning' or 'coordinators'." });
    }
    const c = parseInt(count, 10);
    if (isNaN(c) || c < 0) return res.status(400).json({ error: "A valid non-negative count is required." });
    const history = await getHistory();
    const entry = { date: date || todayStr(), count: c, note: note || null };
    history[category] = [...history[category], entry].sort((a, b) => a.date.localeCompare(b.date));
    await kv.set(HEADCOUNT_KEY, history);
    return res.status(200).json({ ok: true, entry, history: history[category] });
  }

  return res.status(400).json({ error: "Unknown action." });
};
