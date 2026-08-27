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

// A properly time-weighted average headcount over a window, not a crude
// average of the two endpoints — walks the actual timeline, weighting each
// distinct headcount level by how much of the window it was genuinely in
// effect for, so a brief spike or dip doesn't get over- or under-counted.
// Moved here from retention.js, its more natural home alongside the
// timeline functions it directly builds on, rather than importing across
// files in a direction that would have created a circular dependency.
function averageHeadcountOverPeriod(timeline, fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00Z`);
  const to = new Date(`${toDateStr}T00:00:00Z`);
  const totalMs = to - from;
  if (totalMs <= 0) return 0;

  let currentCount = countAsOf(timeline, fromDateStr);
  let cursor = from;
  let weightedSum = 0;

  const eventsInWindow = timeline.filter((t) => t.date > fromDateStr && t.date <= toDateStr);
  for (const ev of eventsInWindow) {
    const evDate = new Date(`${ev.date}T00:00:00Z`);
    weightedSum += currentCount * (evDate - cursor);
    cursor = evDate;
    currentCount = ev.count;
  }
  weightedSum += currentCount * (to - cursor);

  return weightedSum / totalMs;
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

  // Real calendar months, deliberately independent of fiscal year — a
  // month belongs to itself regardless of whether it happens to sit
  // inside a 17-month bridge year or an ordinary Jan-Dec one, same
  // reasoning already applied to Ringover call tracking and the deals-
  // agreed methodology elsewhere on this site. Each month's own
  // time-weighted average, not a single snapshot, so someone joining or
  // leaving partway through a month is fairly reflected in that month's
  // figure rather than over- or under-counted.
  if (req.query.action === "monthly") {
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
    const monthly = [];
    for (let m = 1; m <= 12; m++) {
      const monthKey = `${year}-${String(m).padStart(2, "0")}`;
      const fromDate = `${monthKey}-01`;
      // The FIRST day of the FOLLOWING month, not the last day of this
      // one — averageHeadcountOverPeriod treats its end date as
      // exclusive (it measures "as of" that instant), the correct
      // reading for its original use in Retention ("as of today"), but
      // passing this month's own last day would silently exclude that
      // entire final day from the average, cutting a real month short
      // by 24 hours every single time.
      const nextMonthDate = new Date(Date.UTC(year, m, 1));
      const toDate = nextMonthDate.toISOString().slice(0, 10);
      monthly.push({
        month: monthKey,
        feeEarning: averageHeadcountOverPeriod(feeEarningTimeline, fromDate, toDate),
        coordinators: averageHeadcountOverPeriod(coordinatorTimeline, fromDate, toDate),
      });
    }
    return res.status(200).json({ year, monthly });
  }

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
module.exports.averageHeadcountOverPeriod = averageHeadcountOverPeriod;
