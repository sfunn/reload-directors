const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolvedRevenueGBP, getOverrides, isExcludedProjectRecord } = require("./_dealRevenueUplift");
const { ROSTER, EMPLOYMENT_KEY } = require("./roster");
const { computeCommissionForYear } = require("./commission");
const { computeConsultantStatsForYear } = require("./consultant-stats");
const { averageTenureOfCurrent, averageTenureOfDeparted } = require("./retention");
const { computeEBITDA } = require("./company-overview");

const RECORDS_KEY = "atlas-fee-records";
const PLACEMENTS_KEY = "atlas-placements";
const FX_KEY = "atlas-fx-rates";
const MANUAL_METRICS_KEY = "company-manual-metrics";
const COMMISSION_SETTINGS_KEY = "commission-settings";
const CACHED_SPEND_KEY = "profitability-cached-spend"; // same cache Profitability's own Cost per Person reads from — never a fresh Xero call from here
const EARLIEST_YEAR = 2019;
// Multiple separate, resumable conversation threads per director, not
// just one running conversation that starting fresh would quietly
// overwrite. Each thread carries its own id, an automatic title from
// whatever the first question was, and its own timestamps, so a past
// conversation can be listed, reopened, and continued at any point,
// while starting a genuinely new one never loses the others.
// { [directorEmail]: [{ id, title, createdAt, updatedAt, messages: [{role, content}] }] }
const CONVERSATIONS_KEY = "ask-conversations";

// Before this feature existed, a director's conversations were stored as
// one flat array of {role, content} messages directly — no id, no
// title, nothing to distinguish separate threads. That data is still
// sitting in production for anyone who used Ask a Question before this
// shipped, and reading it with the current logic unchanged doesn't just
// show an empty list, it crashes outright the moment anything tries to
// read .messages off what's actually a message itself.
//
// This migrates that old shape into a single, properly-formed
// conversation — and critically, persists that migration immediately
// rather than just normalizing in memory on each read. Without that,
// the generated id would be different every single request (since it's
// derived from the current timestamp), meaning a conversation opened
// from the list could never actually be found again on the very next
// request. Migrating once and saving it is what keeps the id stable.
async function getDirectorConversations(directorEmail, allConversations) {
  const raw = allConversations[directorEmail];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw[0] && typeof raw[0] === "object" && "id" in raw[0] && Array.isArray(raw[0].messages)) {
    return raw; // already the current shape
  }
  const firstQuestion = raw.find((m) => m && m.role === "user" && m.content);
  const rawTitle = firstQuestion ? firstQuestion.content.trim() : "Previous conversation";
  const title = rawTitle.length > 60 ? `${rawTitle.slice(0, 60)}…` : rawTitle;
  const now = new Date().toISOString();
  const migrated = [{ id: `legacy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title, createdAt: now, updatedAt: now, messages: raw }];
  allConversations[directorEmail] = migrated;
  await kv.set(CONVERSATIONS_KEY, allConversations);
  return migrated;
}

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

  // With no conversationId, this is the list — summaries only (id,
  // title, timestamps, message count), never the full message content,
  // so this stays cheap to load even once there's real history built
  // up. With a conversationId, this returns that one thread's complete
  // messages, ready to continue exactly where it left off.
  if (req.method === "GET") {
    const allConversations = (await kv.get(CONVERSATIONS_KEY)) || {};
    const directorConversations = await getDirectorConversations(director.email, allConversations);
    const conversationId = req.query.conversationId;
    if (conversationId) {
      const found = directorConversations.find((c) => c.id === conversationId);
      if (!found) return res.status(404).json({ error: "That conversation doesn't exist, or was deleted." });
      return res.status(200).json({ conversation: found });
    }
    const summaries = directorConversations
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return res.status(200).json({ conversations: summaries });
  }

  // Deletes exactly one thread by id, never the whole history at once —
  // the other saved conversations stay untouched.
  if (req.method === "DELETE") {
    const conversationId = req.query.conversationId || (req.body && req.body.conversationId);
    if (!conversationId) return res.status(400).json({ error: "A conversationId is required to delete a specific conversation." });
    const allConversations = (await kv.get(CONVERSATIONS_KEY)) || {};
    const directorConversations = await getDirectorConversations(director.email, allConversations);
    allConversations[director.email] = directorConversations.filter((c) => c.id !== conversationId);
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
  // Present when continuing an existing thread; absent means this
  // question starts a genuinely new one.
  const requestedConversationId = req.body && req.body.conversationId;

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
  const deals = records.filter((r) => !isExcludedProjectRecord(r)).map((r) => {
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
  const financials = Object.entries(manualMetrics).map(([year, m]) => {
    const grossProfitAmount = m.grossProfitAmount ?? m.grossProfitUSD ?? null;
    const totalExpensesAmount = m.totalExpensesAmount ?? null;
    const depreciationAmortisationAmount = m.depreciationAmortisationAmount ?? null;
    const interestAmount = m.interestAmount ?? null;
    const taxAmount = m.taxAmount ?? null;
    return {
      year: parseInt(year, 10),
      grossProfitAmount,
      grossProfitCurrency: m.grossProfitCurrency || (m.grossProfitUSD != null ? "USD" : null),
      cashAmount: m.cashAmount ?? null,
      cashCurrency: m.cashCurrency || null,
      totalExpensesAmount,
      totalExpensesCurrency: m.totalExpensesCurrency || null,
      depreciationAmortisationAmount,
      interestAmount,
      taxAmount,
      // The exact same shared function Company Overview itself calls —
      // if it's shown there as real EBITDA, it's shown here as real
      // EBITDA too, never a separate approximation that quietly
      // disagrees with what the site itself already displays.
      ebitdaAmount: computeEBITDA(grossProfitAmount, totalExpensesAmount, depreciationAmortisationAmount, interestAmount, taxAmount),
    };
  });

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
  //
  // The four funnel ratios below are computed here using the EXACT same
  // formula Consultant Stats itself displays (numerator / denominator *
  // 100, null when the denominator is zero, never a made-up 0% or a
  // divide-by-zero) — added specifically so answering "who has the best
  // X rate" never requires the model to invent its own ratio definition
  // on the fly, which risks a different, inconsistent answer from what
  // the actual page would show for the same question.
  function funnelPercentage(numerator, denominator) {
    if (!denominator) return null;
    return Math.round((numerator / denominator) * 1000) / 10; // one decimal place, matching the page's own rounding
  }
  const activityByYear = {};
  for (const y of allYears) {
    const result = await computeConsultantStatsForYear(y);
    const withRatios = result.consultants.map((c) => ({
      ...c,
      monthly: c.monthly.map((m) => ({
        ...m,
        cvToInterviewPercent: funnelPercentage(m.interviews, m.cvs),
        interviewToOnsitePercent: funnelPercentage(m.onsite, m.interviews),
        onsiteToOfferPercent: funnelPercentage(m.offers, m.onsite),
        offerToPlacementPercent: funnelPercentage(m.placements, m.offers),
      })),
    }));
    if (withRatios.some((c) => c.monthly.length > 0)) activityByYear[y] = withRatios;
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

FINANCIALS below is company-wide, not derived from individual deals — Gross Profit and Total Expenses come straight from Xero's own Profit & Loss report as single summary lines, entered here by a director. ebitdaAmount is the real, actual EBITDA figure this site itself computes and displays on Company Overview — use it directly when asked about EBITDA, don't recompute or hedge on it. It equals Gross Profit minus Total Expenses, with depreciationAmortisationAmount, interestAmount, and taxAmount added back wherever they've actually been entered — a null value for any of those three genuinely means nothing was entered for that year, not that it doesn't exist as a concept, and for a business with no debt or significant depreciable assets, that's completely normal and the EBITDA figure is still real and correct as shown, not merely approximate.

COMMISSION is what was actually paid out to a consultant or coordinator on their own deals, computed separately for each real year since bands and targets reset annually — never sum figures from different years together as if they were computed under one shared bracket, they weren't.

ACTIVITY is month-by-month CVs sent, interviews, onsite visits, offers, calls, and phone hours per consultant — a different question from revenue or placements above, this is funnel activity, not money. Each month also carries cvToInterviewPercent, interviewToOnsitePercent, onsiteToOfferPercent, and offerToPlacementPercent — the SAME conversion-rate figures Consultant Stats itself displays, computed the identical way (a null value means the denominator was genuinely zero that month, not a 0% rate — say so plainly rather than treating it as zero). Use these fields directly whenever a question is about a rate, a ratio, or "who's best at converting X to Y" — never compute your own version of these from the raw counts, since a different rounding or edge-case choice would silently disagree with what the actual page shows for the same month. A rate over 100% (more interviews than CVs in the same month, say) is a real, valid figure under this same formula, not an error — it usually just means some of that activity carried over from a previous month's cohort, mention that if it comes up rather than treating the number itself as broken.

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

    // Saved into this thread specifically — an existing one continued,
    // or a brand new one started, never overwriting any other saved
    // conversation the way a single flat history used to.
    const allConversations = (await kv.get(CONVERSATIONS_KEY)) || {};
    const directorConversations = await getDirectorConversations(director.email, allConversations);
    const now = new Date().toISOString();
    const newMessages = [...validHistory, { role: "user", content: question }, { role: "assistant", content: answer }];

    let conversationId = requestedConversationId;
    const existing = conversationId ? directorConversations.find((c) => c.id === conversationId) : null;
    if (existing) {
      existing.messages = newMessages;
      existing.updatedAt = now;
    } else {
      // Either no id was given, or the id given no longer exists (say,
      // deleted in another tab) — either way, start a genuinely new
      // thread rather than silently failing.
      conversationId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const title = question.trim().length > 60 ? `${question.trim().slice(0, 60)}…` : question.trim();
      directorConversations.push({ id: conversationId, title, createdAt: now, updatedAt: now, messages: newMessages });
    }
    allConversations[director.email] = directorConversations;
    await kv.set(CONVERSATIONS_KEY, allConversations);

    return res.status(200).json({ answer, conversationId, dealCount: deals.length, staffCount: staff.length });
  } catch (e) {
    console.error("[ask] request failed:", e);
    return res.status(500).json({ error: "Something went wrong reaching Claude. Check the Vercel logs for details." });
  }
};
