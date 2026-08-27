const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolvedRevenueGBP, getOverrides } = require("./_dealRevenueUplift");

const WEEKS_KEY = "reload-league-weeks"; // shared with the incentive site — read only, never written here
const TEAMS_KEY = "consultant-teams";
const RECORDS_KEY = "atlas-fee-records";
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";
// Entirely new, shared with the incentive site, sourced from Ringover's
// own webhooks — read only, never written here. Already clean at the
// source: internal staff-to-staff calls are excluded, and answering-
// machine calls count the same as real conversations, so no further
// filtering happens on this end.
const RINGOVER_KEY = "ringover-tally"; // { [isoWeek]: { [consultantId]: { calls, seconds, ... } } }
// Entirely separate from the raw tracked data — a manual correction never
// touches reload-league-weeks or ringover-tally, it lives in its own key
// and is checked afterward, computed value never mutated.
const OVERRIDES_KEY = "kpi-overrides"; // { [personId]: { [monthKey]: { [field]: value } } }

// Exact logic the incentive site itself uses to decide which number is
// real — a stored override wins if one exists for that person/month/field,
// otherwise fall back to whatever was actually computed from the raw
// source data. Kept word for word, not reinterpreted, so this can never
// silently diverge from what the incentive site's own edit screen shows.
function kpiOverrideValue(kpiOverrides, personId, monthKey, field, computedValue) {
  const stored = kpiOverrides && kpiOverrides[personId] && kpiOverrides[personId][monthKey] && kpiOverrides[personId][monthKey][field];
  return (stored !== undefined && stored !== null)
    ? { value: stored, isOverridden: true }
    : { value: computedValue, isOverridden: false };
}

// Same roster the incentive site's own Team Lead Bonus uses — coordinators
// don't do CV/interview work, so they're deliberately excluded here too.
const DEFAULT_TEAM_BY_CONSULTANT = {
  "alex-silverman": "james", "ash-thiara": "james", "jack-thompson": "james",
  "max-hart": "james", "oleg-sokyrka": "james",
  "alex-aparo": "josh", "jack-routledge": "josh", "joe-purton": "josh",
  "josh-davis": "josh", "natasha-barnard": "josh",
};
const CONSULTANT_NAMES = {
  "alex-silverman": "Alex Silverman", "ash-thiara": "Ash Thiara", "jack-thompson": "Jack Thompson",
  "max-hart": "Max Hart", "oleg-sokyrka": "Oleg Sokyrka",
  "alex-aparo": "Alex Aparo", "jack-routledge": "Jack Routledge", "joe-purton": "Joe Purton",
  "josh-davis": "Josh Davis", "natasha-barnard": "Natasha Barnard",
};

// Team leads read from a completely separate field on each finalized
// week — `leadRows`, not `rows` — matching the incentive site's own
// enforced separation in league.js. This isn't a display choice, it's
// reading from the one place their numbers are guaranteed to be genuinely
// isolated from the League Table / Team Lead Bonus figures.
const TEAM_LEAD_NAMES = {
  "james-lancer": "James Lancer",
  "josh-stark": "Josh Stark",
};

function emptyMonthEntry(monthKey) {
  return { month: monthKey, calls: 0, callSeconds: 0, cvs: 0, interviews: 0, onsite: 0, offers: 0, placements: 0, placementRevenueGBP: 0, totalRevenueGBP: 0 };
}
function emptyYearTotal() {
  return { calls: 0, callSeconds: 0, cvs: 0, interviews: 0, onsite: 0, offers: 0, placements: 0, placementRevenueGBP: 0, totalRevenueGBP: 0 };
}

// An ISO week string like "2026-W35" identifies a week, not a specific
// date — bucketing it into a calendar month requires picking one real
// day from within it. This app's established convention, used for
// reload-league-weeks already, is that a week belongs to whichever month
// its SUNDAY falls in, not its Monday. ISO weeks run Monday to Sunday,
// so the Sunday is the week's last day, not its first.
//
// Standard ISO 8601 rule: January 4th always falls in week 1. Find that
// week's Monday, add (week-1) full weeks to reach the target week's
// Monday, then add 6 days to land on that week's Sunday.
function isoWeekToSunday(isoWeekStr) {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeekStr);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayOfWeek = jan4.getUTCDay() || 7; // Sunday=0 -> treat as 7, so Monday=1..Sunday=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4DayOfWeek - 1));
  const targetMonday = new Date(week1Monday);
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const targetSunday = new Date(targetMonday);
  targetSunday.setUTCDate(targetMonday.getUTCDate() + 6);
  return targetSunday;
}
function monthKeyFromDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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

  const [weeks, teamOverrides, records, placements, ringover, kpiOverrides, fxRates, revenueUpliftOverrides] = await Promise.all([
    kv.get(WEEKS_KEY).then((v) => v || []),
    kv.get(TEAMS_KEY).then((v) => v || {}),
    kv.get(RECORDS_KEY).then((v) => v || []),
    kv.get(PLACEMENTS_KEY).then((v) => v || {}),
    kv.get(RINGOVER_KEY).then((v) => v || {}),
    kv.get(OVERRIDES_KEY).then((v) => v || {}),
    kv.get(FX_KEY).then((v) => v || {}),
    getOverrides(),
  ]);

  // Current roster: default list plus anyone who's had their team
  // explicitly overridden, same union logic team-lead-bonus.js uses, so
  // this never silently drops someone who was reassigned.
  const roster = Object.keys(DEFAULT_TEAM_BY_CONSULTANT)
    .concat(Object.keys(teamOverrides))
    .filter((v, i, a) => a.indexOf(v) === i)
    .filter((cid) => DEFAULT_TEAM_BY_CONSULTANT[cid] || teamOverrides[cid]);

  const perConsultant = {};
  for (const cid of roster) {
    perConsultant[cid] = { consultantId: cid, consultantName: CONSULTANT_NAMES[cid] || cid, monthly: {}, yearTotal: emptyYearTotal() };
  }
  // Team leads get their own entries too, built and populated in an
  // entirely separate pass below — never sharing a loop with the regular
  // consultant roster, so there's no code path where a mix-up could occur.
  for (const cid of Object.keys(TEAM_LEAD_NAMES)) {
    perConsultant[cid] = { consultantId: cid, consultantName: TEAM_LEAD_NAMES[cid], isTeamLead: true, monthly: {}, yearTotal: emptyYearTotal() };
  }

  // CVs, interviews, onsite, offers — from the incentive site's weekly
  // tracking. Deliberately does NOT check the week's "excluded" flag —
  // that flag only affects league ranking for that week, it doesn't mean
  // the consultant's real activity didn't happen.
  for (const week of weeks) {
    if (!week.date || !week.date.startsWith(String(year))) continue;
    const monthKey = week.date.slice(0, 7); // YYYY-MM

    for (const [consultantId, row] of Object.entries(week.rows || {})) {
      if (!perConsultant[consultantId]) continue;
      if (!perConsultant[consultantId].monthly[monthKey]) perConsultant[consultantId].monthly[monthKey] = emptyMonthEntry(monthKey);
      const m = perConsultant[consultantId].monthly[monthKey];
      const cvs = Number(row.cvs) || 0;
      const interviews = Number(row.interviews) || 0;
      const onsite = Number(row.onsite) || 0;
      const offers = Number(row.offers) || 0;
      m.cvs += cvs; m.interviews += interviews; m.onsite += onsite; m.offers += offers;
      const yt = perConsultant[consultantId].yearTotal;
      yt.cvs += cvs; yt.interviews += interviews; yt.onsite += onsite; yt.offers += offers;
    }

    // Separate pass over leadRows — deliberately its own loop, reading a
    // field that only ever contains James's and Josh's own numbers.
    for (const [consultantId, row] of Object.entries(week.leadRows || {})) {
      if (!perConsultant[consultantId]) continue;
      if (!perConsultant[consultantId].monthly[monthKey]) perConsultant[consultantId].monthly[monthKey] = emptyMonthEntry(monthKey);
      const m = perConsultant[consultantId].monthly[monthKey];
      const cvs = Number(row.cvs) || 0;
      const interviews = Number(row.interviews) || 0;
      const onsite = Number(row.onsite) || 0;
      const offers = Number(row.offers) || 0;
      m.cvs += cvs; m.interviews += interviews; m.onsite += onsite; m.offers += offers;
      const yt = perConsultant[consultantId].yearTotal;
      yt.cvs += cvs; yt.interviews += interviews; yt.onsite += onsite; yt.offers += offers;
    }
  }

  // Ringover call tracking — each ISO week is bucketed by its Sunday,
  // same convention as everything else in this app for deciding which
  // calendar month a week belongs to.
  for (const [isoWeek, byConsultant] of Object.entries(ringover)) {
    const sunday = isoWeekToSunday(isoWeek);
    if (!sunday || sunday.getUTCFullYear() !== year) continue;
    const monthKey = monthKeyFromDate(sunday);
    for (const [consultantId, stats] of Object.entries(byConsultant || {})) {
      if (!perConsultant[consultantId]) continue;
      if (!perConsultant[consultantId].monthly[monthKey]) perConsultant[consultantId].monthly[monthKey] = emptyMonthEntry(monthKey);
      const m = perConsultant[consultantId].monthly[monthKey];
      const calls = Number(stats.calls) || 0;
      const callSeconds = Number(stats.seconds) || 0;
      m.calls += calls; m.callSeconds += callSeconds;
      const yt = perConsultant[consultantId].yearTotal;
      yt.calls += calls; yt.callSeconds += callSeconds;
    }
  }

  // Revenue — every genuine fee record with this person's consultantId,
  // bucketed by when the deal was actually agreed (the fee's own feeDate,
  // same "Date Signed" field Commission already shows), not the
  // candidate's job start date for placements. A candidate can start
  // months after the deal was signed, notice periods being what they
  // are, so start date would measure the wrong event entirely for
  // "activity in this month."
  //
  // Two genuinely different figures, not one filtered view of the other:
  // placementRevenueGBP counts genuine placements only, the same
  // distinction Average Fee relies on to answer "what's a typical
  // placement worth" — an onsite fee isn't a placement, mixing it in
  // would answer a different question. totalRevenueGBP is the real
  // question this profitability work is actually asking though: how
  // much money did this person genuinely bring in, and an onsite fee is
  // real money they brought in, excluding it would understate them.
  //
  // Placement COUNT is deliberately only ever incremented for genuine
  // placements, regardless of currency or exchange rate availability,
  // since it's a headcount of placements, not a revenue figure — a
  // missing FX rate should never hide a real placement from that count.
  // Revenue figures, in contrast, only add what can actually be
  // converted — a record without a usable rate contributes nothing
  // rather than a wrong number, so both totals always add up to a real,
  // checkable figure.
  for (const r of records) {
    if (!r.consultantId || !perConsultant[r.consultantId]) continue;
    const placement = r.placementId ? placements[r.placementId] : null;
    const client = (placement && placement.clientCompanyName) || r.projectClientName || null;
    const hasPlacementName = !!(placement && placement.candidateName);
    const agreedDate = r.feeDate;
    if (!agreedDate || !agreedDate.startsWith(String(year))) continue;
    const monthKey = agreedDate.slice(0, 7);
    if (!perConsultant[r.consultantId].monthly[monthKey]) perConsultant[r.consultantId].monthly[monthKey] = emptyMonthEntry(monthKey);
    const m = perConsultant[r.consultantId].monthly[monthKey];
    const yt = perConsultant[r.consultantId].yearTotal;

    if (hasPlacementName) {
      m.placements += 1;
      yt.placements += 1;
    }

    // The single shared function every revenue-showing page now calls,
    // rather than each keeping its own copy of this branching — that
    // duplication is exactly how the earlier bug happened, one copy
    // missed a step the others had.
    const gbp = resolvedRevenueGBP(r, client, year, revenueUpliftOverrides, hasPlacementName, fxRates);

    if (gbp !== null) {
      m.totalRevenueGBP += gbp;
      yt.totalRevenueGBP += gbp;
      if (hasPlacementName) {
        m.placementRevenueGBP += gbp;
        yt.placementRevenueGBP += gbp;
      }
    }
  }

  // Overrides apply per person, per month, per field — computed after
  // every raw source (weekly tracking, Ringover, Atlas placements) has
  // already been fully tallied above. Phone hours need converting from
  // seconds first, since that's the unit a manual override is actually
  // entered in, not raw seconds. yearTotal is deliberately rebuilt from
  // scratch here by summing the final, post-override monthly figures —
  // not the running total accumulated during the raw computation passes
  // above — so a corrected month genuinely changes the year total too,
  // exactly as it should.
  const OVERRIDE_FIELDS = ["cvs", "interviews", "onsite", "offers", "placements", "calls", "phoneHours"];
  for (const c of Object.values(perConsultant)) {
    const finalMonthly = {};
    for (const [monthKey, m] of Object.entries(c.monthly)) {
      const computedPhoneHours = Math.round((m.callSeconds / 3600) * 10) / 10;
      const resolved = {};
      const overrideFlags = {};
      for (const field of OVERRIDE_FIELDS) {
        const computedValue = field === "phoneHours" ? computedPhoneHours : m[field];
        const { value, isOverridden } = kpiOverrideValue(kpiOverrides, c.consultantId, monthKey, field, computedValue);
        resolved[field] = value;
        overrideFlags[field] = isOverridden;
      }
      // Not an override-able KPI field, carried through exactly as
      // computed — dropped entirely if left out of this object here,
      // since everything below is rebuilt fresh from OVERRIDE_FIELDS only.
      finalMonthly[monthKey] = { month: monthKey, ...resolved, placementRevenueGBP: m.placementRevenueGBP, totalRevenueGBP: m.totalRevenueGBP, overrides: overrideFlags };
    }
    c.monthly = finalMonthly;
    c.yearTotal = OVERRIDE_FIELDS.reduce((acc, field) => {
      acc[field] = Object.values(finalMonthly).reduce((s, m) => s + (Number(m[field]) || 0), 0);
      return acc;
    }, {});
    c.yearTotal.placementRevenueGBP = Object.values(finalMonthly).reduce((s, m) => s + (Number(m.placementRevenueGBP) || 0), 0);
    c.yearTotal.totalRevenueGBP = Object.values(finalMonthly).reduce((s, m) => s + (Number(m.totalRevenueGBP) || 0), 0);
  }

  const consultants = Object.values(perConsultant).map((c) => ({
    consultantId: c.consultantId,
    consultantName: c.consultantName,
    isTeamLead: !!c.isTeamLead,
    monthly: Object.values(c.monthly).sort((a, b) => a.month.localeCompare(b.month)),
    yearTotal: c.yearTotal,
  }));

  return res.status(200).json({ year, consultants });
};

module.exports.isoWeekToSunday = isoWeekToSunday;
module.exports.kpiOverrideValue = kpiOverrideValue;
