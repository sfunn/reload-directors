const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolvedRevenueGBP, getOverrides } = require("./_dealRevenueUplift");
const { ROSTER, EMPLOYMENT_KEY } = require("./roster");

const RECORDS_KEY = "atlas-fee-records";
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";

// A genuinely different kind of feature from everything else on this
// site — every other page answers one specific, pre-built question.
// This one takes whatever question a director actually types, gathers
// the real underlying data, and asks Claude directly, rather than
// requiring a new page to be built every time a new question comes up.
//
// The data sent here is deliberately pre-processed, not raw. Revenue in
// particular goes through the exact same resolvedRevenueGBP function
// every other page already trusts, uplifts and manual overrides
// correctly applied, before Claude ever sees a figure — asking an LLM to
// re-derive that logic itself from raw currency amounts would risk
// getting the business rules subtly wrong in a way nobody would notice
// until the numbers didn't match everywhere else.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Send your question as a POST request." });
  }

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  const question = req.body && req.body.question;
  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "A question is required." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: "No Anthropic API key is configured yet. Add ANTHROPIC_API_KEY to this project's environment variables in Vercel, then redeploy." });
  }

  const [records, placements, fxRates, overrides, employment] = await Promise.all([
    kv.get(RECORDS_KEY).then((v) => v || []),
    kv.get(PLACEMENTS_KEY).then((v) => v || {}),
    kv.get(FX_KEY).then((v) => v || {}),
    getOverrides(),
    kv.get(EMPLOYMENT_KEY).then((v) => v || {}),
  ]);

  const currentYear = new Date().getUTCFullYear();

  // Every real deal, enriched with the correctly-resolved figures other
  // pages already show — never raw currency amounts Claude would have
  // to convert or uplift itself.
  const deals = records.map((r) => {
    const placement = r.placementId ? placements[r.placementId] : null;
    const hasPlacementName = !!(placement && placement.candidateName);
    const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
    const rosterEntry = ROSTER[r.consultantId];
    return {
      consultantId: r.consultantId || null,
      consultantName: rosterEntry ? rosterEntry.name : (r.consultantId || null),
      coordinatorId: r.coordinatorId || null,
      coordinatorName: r.coordinatorId && ROSTER[r.coordinatorId] ? ROSTER[r.coordinatorId].name : null,
      feeDateSigned: r.feeDate || null,
      candidateStartDate: placement ? placement.startDate : null,
      clientCompanyName,
      candidateName: hasPlacementName ? placement.candidateName : null,
      isGenuinePlacement: hasPlacementName,
      source: r.source || null,
      revenueGBP: resolvedRevenueGBP(r, clientCompanyName, currentYear, overrides, hasPlacementName, fxRates),
    };
  });

  // Every real member of staff, with their own dated employment and
  // salary history — the same source of truth Staff Info and
  // Profitability already read from.
  const staff = Object.entries(ROSTER).map(([id, info]) => {
    const emp = employment[id] || {};
    return {
      consultantId: id,
      name: info.name,
      category: info.category,
      startDate: emp.startDate || null,
      terminationDate: emp.terminationDate || null,
      currentlyEmployed: !emp.terminationDate,
      salaryHistory: (emp.salaryHistory || []).map((s) => ({ effectiveDate: s.effectiveDate, salaryGBP: s.salaryGBP })),
    };
  });

  const systemPrompt = `You are answering a director's question about Reload Search's own real recruitment placement and staff data, provided below as JSON. Answer using ONLY this data — never estimate, assume, or invent a figure that isn't directly computable from what's here.

Critically: this data does NOT include role type, seniority level, candidate location, technology or skill tags, client firm type/category (hedge fund vs market maker vs prop shop, etc.), or whether a placed candidate stayed at the client afterward. If the question asks for anything along those lines, say plainly that it isn't tracked in this data rather than guessing, approximating, or inferring it from a client or candidate name.

"Revenue" figures are already correctly computed in GBP, uplifts and manual corrections already applied — use them directly, don't try to recompute or re-derive them from anything else. A deal with isGenuinePlacement false is an onsite fee, not a placement — be clear about that distinction if it matters to the question asked.

DEALS (every real fee record):
${JSON.stringify(deals)}

STAFF (Reload's own roster, not candidates placed):
${JSON.stringify(staff)}

Today's date is ${new Date().toISOString().slice(0, 10)}.`;

  try {
    // Some API keys are scoped to one specific workspace already and
    // never need this at all. Others are created at the organisation
    // level and require being told explicitly which workspace to bill
    // against — added here only if that's actually been configured, so
    // this stays correct regardless of which kind of key ends up in use.
    const anthropicHeaders = {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    };
    if (process.env.ANTHROPIC_WORKSPACE_ID) {
      anthropicHeaders["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8192,
        // Explicitly off — this needs a direct, visible answer to a
        // director's question, not an open-ended reasoning budget that
        // could consume the whole response before producing any actual
        // text, which is exactly what happened with a smaller budget.
        thinking: { type: "disabled" },
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("[ask] Anthropic API error:", response.status, body);
      return res.status(502).json({ error: "Claude couldn't answer that just now. Check the Vercel logs for the exact response." });
    }

    const data = await response.json();
    const answer = data.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");

    if (!answer) {
      // A successful call with nothing usable in it — most likely the
      // token budget ran out on internal reasoning before any visible
      // answer was produced, but logged in full either way so this is
      // genuinely diagnosable rather than a silent, empty response with
      // no way to tell what actually happened.
      console.error("[ask] Empty answer despite a successful call. stop_reason:", data.stop_reason, "full response:", JSON.stringify(data));
      return res.status(502).json({ error: `Claude didn't return a visible answer that time (stop reason: ${data.stop_reason || "unknown"}). Try a shorter or more specific question, or try again.` });
    }

    return res.status(200).json({ answer, dealCount: deals.length, staffCount: staff.length });
  } catch (e) {
    console.error("[ask] request failed:", e);
    return res.status(500).json({ error: "Something went wrong reaching Claude. Check the Vercel logs for details." });
  }
};
