const { getDirectorFromRequest, kv } = require("./_directorAuth");

const WEEKS_KEY = "reload-league-weeks"; // shared with the incentive site — read only, never written here
const TEAMS_KEY = "consultant-teams";

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

  const [weeks, teamOverrides] = await Promise.all([
    kv.get(WEEKS_KEY).then((v) => v || []),
    kv.get(TEAMS_KEY).then((v) => v || {}),
  ]);

  // Current roster: default list plus anyone who's had their team
  // explicitly overridden, same union logic team-lead-bonus.js uses, so
  // this never silently drops someone who was reassigned.
  const roster = Object.keys(DEFAULT_TEAM_BY_CONSULTANT)
    .concat(Object.keys(teamOverrides))
    .filter((v, i, a) => a.indexOf(v) === i)
    .filter((cid) => DEFAULT_TEAM_BY_CONSULTANT[cid] || teamOverrides[cid]);

  // Per consultant, per month — using the week's own recorded date, exactly
  // like team-lead-bonus.js does, not re-deriving month from an ISO week
  // number. Deliberately does NOT check the week's "excluded" flag — that
  // flag only affects league ranking for that week, it doesn't mean the
  // consultant's real CV/interview activity didn't happen.
  const perConsultant = {};
  for (const cid of roster) {
    perConsultant[cid] = { consultantId: cid, consultantName: CONSULTANT_NAMES[cid] || cid, monthly: {}, yearTotal: { cvs: 0, interviews: 0 } };
  }

  for (const week of weeks) {
    if (!week.date || !week.date.startsWith(String(year))) continue;
    const monthKey = week.date.slice(0, 7); // YYYY-MM
    for (const [consultantId, row] of Object.entries(week.rows || {})) {
      if (!perConsultant[consultantId]) continue; // not a currently tracked consultant
      const cvs = Number(row.cvs) || 0;
      const interviews = Number(row.interviews) || 0;
      if (!perConsultant[consultantId].monthly[monthKey]) {
        perConsultant[consultantId].monthly[monthKey] = { month: monthKey, cvs: 0, interviews: 0 };
      }
      perConsultant[consultantId].monthly[monthKey].cvs += cvs;
      perConsultant[consultantId].monthly[monthKey].interviews += interviews;
      perConsultant[consultantId].yearTotal.cvs += cvs;
      perConsultant[consultantId].yearTotal.interviews += interviews;
    }
  }

  const consultants = Object.values(perConsultant).map((c) => ({
    consultantId: c.consultantId,
    consultantName: c.consultantName,
    monthly: Object.values(c.monthly).sort((a, b) => a.month.localeCompare(b.month)),
    yearTotal: c.yearTotal,
  }));

  return res.status(200).json({ year, consultants });
};
