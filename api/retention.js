const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { ROSTER, EMPLOYMENT_KEY } = require("./roster");
const { buildTimeline, countAsOf, averageHeadcountOverPeriod } = require("./headcount");

// This only exists because the roster now holds real start and termination
// dates — genuinely computable now, in a way it simply wasn't when this
// was first written off as a dead end for lack of any leaver data at all.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DAYS_PER_YEAR = 365.25;

// Average tenure of everyone currently active in a category — start date
// set, and either no termination date or one that hasn't happened yet as
// of the reference date. Someone whose start date is in the future (a
// planned but not-yet-real join) is excluded, not counted as negative
// tenure.
function averageTenureOfCurrent(employment, category, asOfDateStr) {
  const asOf = new Date(`${asOfDateStr}T00:00:00Z`);
  let totalDays = 0, count = 0;
  for (const [id, info] of Object.entries(ROSTER)) {
    if (info.category !== category) continue;
    const emp = employment[id];
    if (!emp || !emp.startDate) continue;
    if (emp.terminationDate && emp.terminationDate <= asOfDateStr) continue;
    const start = new Date(`${emp.startDate}T00:00:00Z`);
    const days = (asOf - start) / MS_PER_DAY;
    if (days < 0) continue;
    totalDays += days;
    count += 1;
  }
  return { years: count > 0 ? totalDays / count / DAYS_PER_YEAR : null, count };
}

// Average tenure of everyone who has actually left — how long people
// typically stayed before departing, a genuinely different question from
// how long current staff have been here.
function averageTenureOfDeparted(employment, category) {
  let totalDays = 0, count = 0;
  for (const [id, info] of Object.entries(ROSTER)) {
    if (info.category !== category) continue;
    const emp = employment[id];
    if (!emp || !emp.startDate || !emp.terminationDate) continue;
    const start = new Date(`${emp.startDate}T00:00:00Z`);
    const end = new Date(`${emp.terminationDate}T00:00:00Z`);
    const days = (end - start) / MS_PER_DAY;
    if (days < 0) continue;
    totalDays += days;
    count += 1;
  }
  return { years: count > 0 ? totalDays / count / DAYS_PER_YEAR : null, count };
}

function departuresInWindow(employment, category, fromDateStr, toDateStr) {
  let count = 0;
  for (const [id, info] of Object.entries(ROSTER)) {
    if (info.category !== category) continue;
    const emp = employment[id];
    if (!emp || !emp.terminationDate) continue;
    if (emp.terminationDate >= fromDateStr && emp.terminationDate <= toDateStr) count += 1;
  }
  return count;
}

function retentionForCategory(employment, category) {
  const today = todayStr();
  const oneYearAgo = new Date(`${today}T00:00:00Z`);
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  const timeline = buildTimeline(employment, category);
  const currentTenure = averageTenureOfCurrent(employment, category, today);
  const departedTenure = averageTenureOfDeparted(employment, category);
  const departures12mo = departuresInWindow(employment, category, oneYearAgoStr, today);
  const avgHeadcount12mo = averageHeadcountOverPeriod(timeline, oneYearAgoStr, today);
  const turnoverRate12mo = avgHeadcount12mo > 0 ? (departures12mo / avgHeadcount12mo) * 100 : null;

  return {
    currentStaffCount: countAsOf(timeline, today),
    averageTenureYearsCurrent: currentTenure.years,
    departedCount: departedTenure.count,
    averageTenureYearsDeparted: departedTenure.years,
    departuresLast12Months: departures12mo,
    averageHeadcountLast12Months: avgHeadcount12mo,
    turnoverRateLast12MonthsPercent: turnoverRate12mo,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only — retention is derived from the roster." });
  }

  const employment = (await kv.get(EMPLOYMENT_KEY)) || {};

  return res.status(200).json({
    feeEarning: retentionForCategory(employment, "feeEarning"),
    coordinators: retentionForCategory(employment, "coordinator"),
  });
};

module.exports.averageTenureOfCurrent = averageTenureOfCurrent;
module.exports.averageTenureOfDeparted = averageTenureOfDeparted;
module.exports.averageHeadcountOverPeriod = averageHeadcountOverPeriod;
