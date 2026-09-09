const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolvedRevenueGBP, getOverrides } = require("./_dealRevenueUplift");
const { ROSTER, EMPLOYMENT_KEY } = require("./roster");
const { computeCommissionForYear } = require("./commission");
const { computeConsultantStatsForYear } = require("./consultant-stats");
const { averageTenureOfCurrent, averageTenureOfDeparted } = require("./retention");

const RECORDS_KEY = "atlas-fee-records";
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";
const MANUAL_METRICS_KEY = "company-manual-metrics";
const COMMISSION_SETTINGS_KEY = "commission-settings";
const CACHED_SPEND_KEY = "profitability-cached-spend"; // same cache Profitability's own Cost per Person reads from — never a fresh Xero call from here
const EARLIEST_YEAR = 2019;
// The conversation itself only ever lived in the browser's own memory
// for that one page visit before this — leaving the tab and coming back
// genuinely lost it, the same way "Check spend" used to before that got
// fixed the same way this does: saved here, per director, so it
// survives navigating away and back. { [directorEmail]: [{role, content}] }
const CONVERSATIONS_KEY = "ask-conversations";

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  // The saved conversation, loaded once when the page opens — cheap,
  // no Xero or Claude call involved, just reading back whatever this
  // director last had going.
  if (req.method === "GET") {
    const allConversations = (await kv.get(CONVERSATIONS_KEY)) || {};
    return res.status(200).json({ messages: allConversations[director.email] || [] });
  }

  // Starting fresh clears the real saved copy too, not just whatever's
  // showing in the browser right now — otherwise it would quietly come
  // back the next time this director opened the page.
  if (req.method === "DELETE") {
    const allConversations = (await kv.get(CONVERSATIONS_KEY)) || {};
    delete allConversations[director.email];
    await kv.set(CONVERSATIONS_KEY, allConversations);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Send your question as a POST request." });
  }

  const question = req.body && req.body.question;
  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "A question is required." });
  }

  // A follow-up question continues the same real conversation, not a
  // fresh one each time — the frontend sends back everything said so
  // far, and this just adds the new question onto the end of it.
  // Genuinely different from the data above though: every request still
  // gathers a fresh copy of that, so a follow-up asked minutes later
  // still reasons from current figures, never a stale snapshot from
  // when the conversation started.
  const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];
  const validHistory = history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: "No Anthropic API key is configured yet. Add ANTHROPIC_API_KEY to this project's environment variables in Vercel, then redeploy." });
  }

  const [records, placements, fxRates, overrides, employment, manualMetrics, commissionSettings, cachedSpend] = await Promise.all([
    kv.get(RECORDS_KEY).then((v) => v || []),
    kv.get(PLACEMENTS_KEY).then((v) => v || {}),
    kv.get(FX_KEY).then((v) => v || {}),
    getOverrides(),
    kv.get(EMPLOYMENT_KEY).then((v) => v || {}),
    kv.get(MANUAL_METRICS_KEY).then((v) => v || {}),
    kv.get(COMMISSION_SETTINGS_KEY).then((v) => v || {}),
    kv.get(CACHED_SPEND_KEY).then((v) => v || {}),
  ]);

  const currentYear = new Date().getUTCFullYear();
  const allYears = [];
  for (let y = EARLIEST_YEAR; y <= currentYear; y++) allYears.push(y);

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

  // Gross Profit, Cash, and Total Expenses — the same figures shown at
  // the top of Company Overview, entered there by a director, usually
  // sourced from Xero's own Profit & Loss and Balance Sheet reports.
  // Genuinely different from the deal/staff data above — this is
  // company-wide financial reporting, not derived from individual deals.
  const financials = Object.entries(manualMetrics).map(([year, m]) => ({
    year: parseInt(year, 10),
    grossProfitAmount: m.grossProfitAmount ?? m.grossProfitUSD ?? null,
    grossProfitCurrency: m.grossProfitCurrency || (m.grossProfitUSD != null ? "USD" : null),
    cashAmount: m.cashAmount ?? null,
    cashCurrency: m.cashCurrency || null,
    totalExpensesAmount: m.totalExpensesAmount ?? null,
    totalExpensesCurrency: m.totalExpensesCurrency || null,
  }));

  // Commission — every fee-earning consultant and coordinator, every
  // year since bands/targets have existed. Computed one real year at a
  // time using the exact same function Commission's own page calls,
  // since bands and targets reset annually and pooling every deal
  // together under one year's rules would silently misstate this.
  const commissionByConsultant = {};
  for (const [id, info] of Object.entries(ROSTER)) {
    commissionByConsultant[id] = allYears.map((y) => {
      const result = computeCommissionForYear(id, y, records, fxRates, placements, commissionSettings);
      return { year: y, totalCommission: result.totalCommission };
    }).filter((r) => r.totalCommission !== 0);
  }

  // Activity — CVs sent, interviews, onsite visits, offers, calls, phone
  // hours, month by month, every real year. Uses the exact same
  // computation Consultant Stats itself calls, manual KPI corrections
  // and the Deals Agreed methodology already correctly applied.
  const activityByYear = {};
  for (const y of allYears) {
    const result = await computeConsultantStatsForYear(y);
    if (result.consultants.some((c) => c.monthly.length > 0)) activityByYear[y] = result.consultants;
  }

  // Supplier-level costs — whichever years have actually been checked
  // on Profitability's own "Check spend" button, read from that same
  // cache, never a fresh Xero call triggered from here. A year that's
  // never been checked simply isn't included, not silently treated as
  // having no costs at all.
  const supplierCostsByYear = Object.entries(cachedSpend).map(([year, c]) => ({
    year: parseInt(year, 10),
    checkedAt: c.checkedAt,
    suppliers: c.suppliers,
  }));

  // Tenure — reusing Retention's own real calculations directly, not a
  // re-derived approximation.
  const tenure = {
    averageTenureYearsCurrentFeeEarning: averageTenureOfCurrent(employment, "feeEarning"),
    averageTenureYearsCurrentCoordinators: averageTenureOfCurrent(employment, "coordinator"),
    averageTenureYearsDepartedFeeEarning: averageTenureOfDeparted(employment, "feeEarning"),
    averageTenureYearsDepartedCoordinators: averageTenureOfDeparted(employment, "coordinator"),
  };

  const systemPrompt = `You are answering a director's question about Reload Search's own real recruitment placement, staff, and company financial data, provided below as JSON. Answer using ONLY this data — never estimate, assume, or invent a figure that isn't directly computable from what's here.

Critically: this data does NOT include role type, seniority level, candidate location, technology or skill tags, client firm type/category (hedge fund vs market maker vs prop shop, etc.), or whether a placed candidate stayed at the client afterward. If the question asks for anything along those lines, say plainly that it isn't tracked in this data rather than guessing, approximating, or inferring it from a client or candidate name.

"Revenue" figures on deals are already correctly computed in GBP, uplifts and manual corrections already applied — use them directly, don't try to recompute or re-derive them from anything else. A deal with isGenuinePlacement false is an onsite fee, not a placement — be clear about that distinction if it matters to the question asked.

FINANCIALS below is company-wide, not derived from individual deals — Gross Profit and Total Expenses come straight from Xero's own Profit & Loss report as single summary lines, entered here by a director. Total Expenses is one lump figure, not broken out into interest, tax, depreciation, or amortisation separately. This means Revenue minus Total Expenses is a genuine, real approximation of pre-tax operating profit, but it is NOT the same thing as EBITDA — a true EBITDA figure would need interest, tax, depreciation, and amortisation broken out as their own separate amounts, which this data does not contain. If asked for EBITDA specifically, say plainly that only an approximate operating profit figure can be computed from what's here, show that figure, and be explicit about what's missing to make it a true EBITDA.

COMMISSION is what was actually paid out to a consultant or coordinator on their own deals, computed separately for each real year since bands and targets reset annually — never sum figures from different years together as if they were computed under one shared bracket, they weren't.

ACTIVITY is month-by-month CVs sent, interviews, onsite visits, offers, calls, and phone hours per consultant — a different question from revenue or placements above, this is funnel activity, not money.

SUPPLIER_COSTS is Reload's own overhead spend by supplier (Atlas, LinkedIn, and so on), only for years a director has actually pulled fresh figures from Xero — a year missing from this list was simply never checked, it is NOT the same as that year having zero costs, say so plainly if asked about a year that isn't here.

TENURE is average real tenure in years, computed the same way Retention's own page shows it, separately for current staff (still employed) and departed staff, and separately for fee-earning consultants versus coordinators.

DEALS (every real fee record):
${JSON.stringify(deals)}

STAFF (Reload's own roster, not candidates placed):
${JSON.stringify(staff)}

FINANCIALS (company-wide, from Xero, by year):
${JSON.stringify(financials)}

COMMISSION (by consultant, by year):
${JSON.stringify(commissionByConsultant)}

ACTIVITY (by year, by consultant, by month):
${JSON.stringify(activityByYear)}

SUPPLIER_COSTS (by year, only years actually checked):
${JSON.stringify(supplierCostsByYear)}

TENURE:
${JSON.stringify(tenure)}

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
        messages: [...validHistory, { role: "user", content: question }],
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

    // Saved here, per director, so this exact exchange is still there
    // the next time this page opens, not just for the rest of this one
    // visit.
    const allConversations = (await kv.get(CONVERSATIONS_KEY)) || {};
    allConversations[director.email] = [...validHistory, { role: "user", content: question }, { role: "assistant", content: answer }];
    await kv.set(CONVERSATIONS_KEY, allConversations);

    return res.status(200).json({ answer, dealCount: deals.length, staffCount: staff.length });
  } catch (e) {
    console.error("[ask] request failed:", e);
    return res.status(500).json({ error: "Something went wrong reaching Claude. Check the Vercel logs for details." });
  }
};
