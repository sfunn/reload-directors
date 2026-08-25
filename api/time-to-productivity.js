const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { ROSTER, EMPLOYMENT_KEY } = require("./roster");

const RECORDS_KEY = "atlas-fee-records"; // shared with the incentive site — read only
const PLACEMENTS_KEY = "atlas-placements";

// A genuine placement only — matching the exact same distinction enforced
// everywhere else financially sensitive in this system, the client uplift,
// the original Natasha rule, Team Lead Bonus's Pillar 4. A notes-derived
// Onsite fee isn't the thing this metric is actually asking about: how
// long until someone closed their first real placement.
function firstGenuinePlacementDateFor(consultantId, records, placements) {
  let earliest = null;
  for (const r of records) {
    if (r.consultantId !== consultantId || !r.feeDate) continue;
    const placement = r.placementId ? placements[r.placementId] : null;
    const hasPlacementName = !!(placement && placement.candidateName);
    if (!hasPlacementName) continue;
    if (earliest === null || r.feeDate < earliest) earliest = r.feeDate;
  }
  return earliest;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only." });
  }

  const [employment, records, placements] = await Promise.all([
    kv.get(EMPLOYMENT_KEY).then((v) => v || {}),
    kv.get(RECORDS_KEY).then((v) => v || []),
    kv.get(PLACEMENTS_KEY).then((v) => v || {}),
  ]);

  const people = Object.entries(ROSTER)
    .filter(([, info]) => info.category === "feeEarning")
    .map(([id, info]) => {
      const emp = employment[id] || {};
      const startDate = emp.startDate || null;
      const firstPlacementDate = firstGenuinePlacementDateFor(id, records, placements);

      let daysToFirstPlacement = null;
      let status = "no-start-date"; // no-start-date | no-placement-yet | inconsistent | measured
      if (startDate) {
        if (!firstPlacementDate) {
          status = "no-placement-yet";
        } else {
          const days = (new Date(`${firstPlacementDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / (1000 * 60 * 60 * 24);
          if (days < 0) {
            // The recorded start date is AFTER their first genuine placement —
            // not a real answer, almost certainly a wrong date somewhere,
            // flagged plainly rather than shown as a misleading negative number.
            status = "inconsistent";
          } else {
            status = "measured";
            daysToFirstPlacement = days;
          }
        }
      }

      return {
        consultantId: id,
        consultantName: info.name,
        startDate,
        firstPlacementDate,
        daysToFirstPlacement,
        status,
      };
    })
    .sort((a, b) => a.consultantName.localeCompare(b.consultantName));

  const measured = people.filter((p) => p.status === "measured");
  const averageDays = measured.length > 0 ? measured.reduce((s, p) => s + p.daysToFirstPlacement, 0) / measured.length : null;

  return res.status(200).json({
    people,
    measuredCount: measured.length,
    averageDaysToFirstPlacement: averageDays,
  });
};
