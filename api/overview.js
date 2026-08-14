const { getDirectorFromRequest, kv } = require("./_directorAuth");

const RECORDS_KEY = "atlas-fee-records"; // shared with the incentive site — read only, never written here

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) {
    return res.status(401).json({ error: "Director access required." });
  }

  const records = (await kv.get(RECORDS_KEY)) || [];
  const totalDeals = records.length;
  const totalRawAmount = records.reduce((sum, r) => sum + (Number(r.totalAmount) || 0), 0);

  return res.status(200).json({
    proof: "This number came from the same shared database the incentive site writes to.",
    totalDeals,
    totalRawAmount,
  });
};
