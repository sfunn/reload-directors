const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { ROSTER, EMPLOYMENT_KEY } = require("./roster");

// Headcount used to be tracked as its own separate manual counter, with its
// own "record a change" button. Once the roster started holding real
// per-person start/termination dates, that became genuinely redundant —
// worse, the two could quietly disagree if one got updated and the other
// didn't. This file no longer stores anything of its own at all — it reads
// the exact same employment data the roster owns, and derives everything
// from it. There is now exactly one place team dates live.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Builds a real chronological timeline for one category (feeEarning or
// coordinator) from actual start/termination dates — every join and every
// departure is a dated event; the count at any point is just the running
// total of everyone who'd started and not yet left by that date. Multiple
// events on the same real date are combined into one timeline point, so a
// day with two joins doesn't produce two conflicting entries for itself.
function buildTimeline(employment, category) {
  const deltaByDate = {};
  for (const [id, info] of Object.entries(ROSTER)) {
    if (info.category !== category) continue;
    const emp = employment[id];
    if (!emp || !emp.startDate) continue; // no date recorded yet — not counted until it is
    deltaByDate[emp.startDate] = (deltaByDate[emp.startDate] || 0) + 1;
    if (emp.terminationDate) {
      deltaByDate[emp.terminationDate] = (deltaByDate[emp.terminationDate] || 0) - 1;
    }
  }
  const dates = Object.keys(deltaByDate).sort();
  let running = 0;
  const timeline = [];
  for (const d of dates) {
    running += deltaByDate[d];
    timeline.push({ date: d, count: running });
  }
  return timeline;
}

function countAsOf(timeline, dateStr) {
  const applicable = timeline.filter((t) => t.date <= dateStr);
  return applicable.length ? applicable[applicable.length - 1].count : 0;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only — headcount is derived from the roster. Edit dates there instead." });
  }

  const employment = (await kv.get(EMPLOYMENT_KEY)) || {};
  const feeEarningTimeline = buildTimeline(employment, "feeEarning");
  const coordinatorTimeline = buildTimeline(employment, "coordinator");
  const today = todayStr();

  return res.status(200).json({
    currentFeeEarning: countAsOf(feeEarningTimeline, today),
    currentCoordinators: countAsOf(coordinatorTimeline, today),
    feeEarningHistory: feeEarningTimeline,
    coordinatorHistory: coordinatorTimeline,
  });
};

module.exports.buildTimeline = buildTimeline;
module.exports.countAsOf = countAsOf;
