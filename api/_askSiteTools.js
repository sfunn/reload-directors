// Read-only access to the site's own pages, for the Ask a Question page.
//
// Claude gets ONE tool, get_site_data, that names a source and a few
// parameters. Each source maps to a read action of one of the site's own
// endpoints, called in-process with the SAME Authorization header the
// director's own request carried, so every endpoint applies exactly the
// checks it always does and nothing here can see more than the director
// can. The list below is an explicit allowlist: an action that writes
// (renaming a client, saving an override, editing a staff date, saving a
// figure) is simply not in it, and the model cannot name anything that
// isn't. Parameters it supplies are validated and rebuilt into a fresh
// query, never passed through as given, so an extra "action" parameter
// cannot smuggle a write in.

const companyOverview = require("./company-overview");
const deals = require("./deals");
const commission = require("./commission");
const consultantStats = require("./consultant-stats");
const headcount = require("./headcount");
const retention = require("./retention");
const roster = require("./roster");
const timeToProductivity = require("./time-to-productivity");
const xeroReports = require("./xero-reports");

// How much one question may fetch. Xero lookups are slow and the site is
// limited to a few calls at once, so they have their own, smaller cap.
const LIMITS = {
  MAX_TOOL_ROUNDS: 6,
  MAX_LOOKUPS: 12,
  MAX_XERO_LOOKUPS: 4,
  MAX_RESULT_CHARS: 60000,
  MAX_TOTAL_CHARS: 200000,
  TIME_BUDGET_MS: 35000,
};

const MONTH_RE = /^(0?[1-9]|1[0-2])$/;
const clean = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = String(v).trim();
  }
  return out;
};

// Each source: the page it belongs to, whether it calls Xero live, the
// handler and fixed action it maps to, which parameters it reads, and a
// plain description the model reads to choose between them.
const SITE_SOURCES = {
  company_overview: {
    page: "Company Overview", xero: false, handler: companyOverview,
    params: ["year", "period", "month", "quarter"],
    describe: "Headline figures for a year, quarter or month: fee revenue (Atlas), distinct placements and onsite fees, average fee, revenue per head, client and consultant concentration, the saved Xero figures for that period (gross profit, cash, expenses, EBITDA) and changes against the previous period and the same period last year. Use year plus period (month, quarter or year), with month (01-12) or quarter (Q1-Q4).",
    build: (p) => clean({ year: p.year, period: p.period, month: p.month, quarter: p.quarter }),
  },
  repeat_clients: {
    page: "Company Overview", xero: false, handler: companyOverview, params: [],
    describe: "Repeat client rate across all time: how many clients have placed with Reload more than once.",
    build: () => ({ action: "repeat-clients" }),
  },
  monthly_fee_revenue: {
    page: "Board Pack", xero: false, handler: companyOverview, params: ["year"],
    describe: "Fee revenue for each calendar month of a year and of the year before, with the split by client, the distinct placements and the onsite fees in each month. Fee revenue is dated by candidate start date.",
    build: (p) => clean({ action: "revenue-series", year: p.year }),
  },
  xero_period_figures: {
    page: "Company Overview (Pull from Xero)", xero: true, handler: xeroReports, params: ["year", "period", "month", "quarter"],
    describe: "LIVE from Xero: gross profit, cash, total expenses, depreciation, interest and tax for a year, quarter or month. With no period, year 2026 follows Reload's own financial year logic, which is a 17 month bridge from 1 August 2025 to 31 December 2026.",
    build: (p) => clean({ year: p.year, period: p.period, month: p.month, quarter: p.quarter }),
  },
  xero_monthly_pl: {
    page: "Board Pack (Profit and Loss)", xero: true, handler: xeroReports, params: ["year"],
    describe: "LIVE from Xero: the profit and loss for every complete calendar month of a year: income, cost of sales, gross profit, operating expenses, net profit, and the depreciation, interest and tax lines used for EBITDA. Slow (one Xero call per month).",
    build: (p) => clean({ action: "pl-monthly", year: p.year }),
  },
  xero_cash_movement: {
    page: "Board Pack (Cash Movement)", xero: true, handler: xeroReports, params: ["year", "month", "from_month"],
    describe: "LIVE from Xero: bank balances and movement per account for a finished period. month is the LAST month of the period (01-12) and from_month the first, so a quarter is from_month 07 and month 09. Cash received and spent are only present when Xero's bank summary permission is available; otherwise net movement comes from the balance sheet.",
    build: (p) => clean({ action: "cash-movement", year: p.year, month: p.month, fromMonth: p.from_month }),
  },
  xero_debtors_creditors: {
    page: "Board Pack (Debtors and Creditors)", xero: true, handler: xeroReports, params: [],
    describe: "LIVE from Xero: unpaid sales invoices (debtors) and unpaid bills (creditors) aged as at today, by customer or supplier, with foreign currency converted to GBP and a check against Xero's own balances.",
    build: () => ({ action: "aged-balances" }),
  },
  xero_expense_breakdown: {
    page: "Profitability", xero: true, handler: xeroReports, params: ["year"],
    describe: "LIVE from Xero: the individual expense account lines behind a year's total expenses.",
    build: (p) => clean({ action: "expense-breakdown", year: p.year }),
  },
  xero_cached_supplier_spend: {
    page: "Profitability (Cost per Person)", xero: false, handler: xeroReports, params: ["year"],
    describe: "Overhead spend by supplier for a year, from the last time a director pressed Check spend on Profitability (not a live Xero call). A year that was never checked is simply missing, which is not the same as zero cost.",
    build: (p) => clean({ action: "cached-spend", year: p.year }),
  },
  xero_tracked_suppliers: {
    page: "Profitability (Cost per Person)", xero: false, handler: xeroReports, params: [],
    describe: "The suppliers a director has chosen to track for cost per person, with how often each is billed.",
    build: () => ({ action: "tracked-suppliers" }),
  },
  consultant_stats: {
    page: "Consultant Stats", xero: false, handler: consultantStats, params: ["year"],
    describe: "Month by month activity per consultant for a year: CVs sent, interviews, onsite visits, offers, placements, calls and phone hours, with the team each consultant belongs to.",
    build: (p) => clean({ year: p.year }),
  },
  headcount_now: {
    page: "Staff Info", xero: false, handler: headcount, params: [],
    describe: "Current fee-earning and coordinator headcount, and the full history of joiners and leavers that headcount is built from.",
    build: () => ({}),
  },
  headcount_monthly: {
    page: "Staff Info / Profitability", xero: false, handler: headcount, params: ["year"],
    describe: "The average fee-earning headcount and coordinator headcount for each month of a year, time-weighted for people who joined or left part-way through.",
    build: (p) => clean({ action: "monthly", year: p.year }),
  },
  staff_roster: {
    page: "Staff Info", xero: false, handler: roster, params: [],
    describe: "Every member of staff with their category, start date, leaving date and salary history.",
    build: () => ({}),
  },
  monthly_salary: {
    page: "Profitability", xero: false, handler: roster, params: ["year"],
    describe: "Each person's salary for each month of a year, worked from their dated salary history.",
    build: (p) => clean({ action: "monthly-salary", year: p.year }),
  },
  retention: {
    page: "Staff Info (Retention)", xero: false, handler: retention, params: [],
    describe: "Retention and tenure: average tenure of current and departed staff, and retention rates.",
    build: () => ({}),
  },
  time_to_productivity: {
    page: "Staff Details and Productivity", xero: false, handler: timeToProductivity, params: [],
    describe: "How long each consultant took to reach productivity, from their start date to their first placement and onward.",
    build: () => ({}),
  },
  commission: {
    page: "Commission", xero: false, handler: commission, params: ["consultant_id", "year"],
    describe: "One consultant's commission for one year: each deal, the band it fell in, and the total. consultant_id is required (the ids are in the STAFF list).",
    build: (p) => clean({ consultantId: p.consultant_id, year: p.year }),
  },
  commission_all_time: {
    page: "Commission / Profitability", xero: false, handler: commission, params: ["consultant_id"],
    describe: "One consultant's commission summed over every year they have been paid, each year under its own bands.",
    build: (p) => clean({ action: "all-time", consultantId: p.consultant_id }),
  },
  deal_table: {
    page: "Yearly Deal Table", xero: false, handler: deals, params: ["year"],
    describe: "The Yearly Deal Table for a year (or year all for all time): every deal with the figures that page shows.",
    allowsAllYears: true,
    build: (p) => clean({ year: p.year }),
  },
  where_candidates_came_from: {
    page: "Where Candidates Came From", xero: false, handler: deals, params: ["group_by", "client", "year"],
    describe: "Placements grouped by the candidate's previous employer, by the area they were placed into, or listed by candidate, for one client or all, for a year or all time. group_by is employer, area or candidate (area needs a client).",
    allowsAllYears: true,
    build: (p) => clean({ action: "origin-explorer", groupBy: p.group_by, client: p.client, year: p.year }),
  },
  area_concentration: {
    page: "Area Concentration", xero: false, handler: deals, params: ["client", "year"],
    describe: "How a client's placements concentrate across the areas (desks) they were placed into, for a year or all time.",
    allowsAllYears: true,
    build: (p) => clean({ action: "area-concentration", client: p.client, year: p.year }),
  },
  client_areas: {
    page: "Area Concentration", xero: false, handler: deals, params: ["client"],
    describe: "The areas mapped for a client.",
    build: (p) => clean({ action: "client-areas", client: p.client }),
  },
  previous_employers: {
    page: "Where Candidates Came From", xero: false, handler: deals, params: [],
    describe: "The mapped list of candidates' previous employers.",
    build: () => ({ action: "previous-employers" }),
  },
  unmapped_notes: {
    page: "Area Concentration", xero: false, handler: deals, params: [],
    describe: "Deal notes that have not yet been mapped to an area.",
    build: () => ({ action: "unmapped-notes" }),
  },
  unmapped_previous_employers: {
    page: "Where Candidates Came From", xero: false, handler: deals, params: [],
    describe: "Previous employers that have not yet been mapped.",
    build: () => ({ action: "unmapped-previous-employers" }),
  },
};

const SOURCE_NAMES = Object.keys(SITE_SOURCES);

// The tool as Claude sees it. The descriptions of every source are built
// from the table above, so the two can never drift apart.
const SITE_TOOL = {
  name: "get_site_data",
  description:
    "Reads live data from one of this site's own pages. The site is Reload's internal director dashboard; every page's data is available here, read only. " +
    "Use it for anything the data in the system prompt does not already answer. Pick the source that matches the page or figure in question. " +
    "Sources, grouped by page:\n" +
    SOURCE_NAMES.map((name) => `- ${name} [${SITE_SOURCES[name].page}${SITE_SOURCES[name].xero ? ", live Xero call" : ""}]: ${SITE_SOURCES[name].describe}`).join("\n") +
    "\nXero sources are slow and limited, so use only the ones the question needs. Results over a size limit are cut off, so ask for a narrower year, period or client when you only need part of it.",
  input_schema: {
    type: "object",
    properties: {
      source: { type: "string", enum: SOURCE_NAMES, description: "Which page's data to read." },
      year: { type: "string", description: "A four digit year such as 2026. Some sources also accept all for all time." },
      period: { type: "string", enum: ["month", "quarter", "year"], description: "For company_overview and xero_period_figures." },
      month: { type: "string", description: "Month 01-12. For period month, or the last month of a cash movement period." },
      quarter: { type: "string", enum: ["Q1", "Q2", "Q3", "Q4"], description: "For period quarter." },
      from_month: { type: "string", description: "First month 01-12 of a cash movement period." },
      client: { type: "string", description: "A client company name, for the client based sources." },
      group_by: { type: "string", enum: ["employer", "area", "candidate"], description: "For where_candidates_came_from." },
      consultant_id: { type: "string", description: "A consultant id from the STAFF list, for commission sources." },
    },
    required: ["source"],
  },
};

// Validates what the model supplied and returns the cleaned parameters, or
// an error message the model can act on.
function validateParams(source, input) {
  const def = SITE_SOURCES[source];
  const p = {};
  const allowed = new Set(def.params);
  for (const key of allowed) {
    const raw = input[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const v = String(raw).trim();
    if (key === "year") {
      if (v.toLowerCase() === "all") {
        if (!def.allowsAllYears) return { error: `${source} needs a four digit year; it does not accept all.` };
        p.year = "all";
      } else if (/^\d{4}$/.test(v)) p.year = v;
      else return { error: "year must be a four digit year such as 2026." };
    } else if (key === "period") {
      if (!["month", "quarter", "year"].includes(v)) return { error: "period must be month, quarter or year." };
      p.period = v;
    } else if (key === "month" || key === "from_month") {
      if (!MONTH_RE.test(v)) return { error: `${key} must be a month from 01 to 12.` };
      p[key] = v.padStart(2, "0");
    } else if (key === "quarter") {
      if (!/^Q[1-4]$/.test(v)) return { error: "quarter must be Q1, Q2, Q3 or Q4." };
      p.quarter = v;
    } else if (key === "group_by") {
      if (!["employer", "area", "candidate"].includes(v)) return { error: "group_by must be employer, area or candidate." };
      p.group_by = v;
    } else if (key === "consultant_id") {
      if (!roster.ROSTER[v]) return { error: `consultant_id must be one of: ${Object.keys(roster.ROSTER).join(", ")}.` };
      p.consultant_id = v;
    } else if (key === "client") {
      if (v.length > 120) return { error: "client is too long." };
      p.client = v;
    }
  }
  if ((source === "commission" || source === "commission_all_time") && !p.consultant_id) {
    return { error: `${source} needs consultant_id, one of: ${Object.keys(roster.ROSTER).join(", ")}.` };
  }
  return { params: p };
}

// Calls a handler in-process, as a GET, carrying the director's own
// Authorization header, and returns what it would have sent over HTTP.
async function callSite(handler, query, authorization) {
  let status = 200;
  let body = null;
  const res = {
    setHeader() {},
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
    end() { return this; },
  };
  const req = { method: "GET", query, headers: authorization ? { authorization } : {}, body: {} };
  await handler(req, res);
  return { status, body };
}

function newToolContext(authorization) {
  return { authorization, lookups: 0, xeroLookups: 0, chars: 0, log: [] };
}

function describeLookup(source, params) {
  const bits = Object.entries(params).map(([k, v]) => `${k.replace("_", " ")} ${v}`);
  return `${SITE_SOURCES[source].page}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

// Runs one tool_use block and returns the tool_result block to send back.
// Never throws: any problem becomes an error result the model can read and
// report, so one failed lookup cannot take the whole answer down.
async function runSiteTool(block, ctx) {
  const result = (content, isError, logEntry) => {
    if (logEntry) ctx.log.push(logEntry);
    return { type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) };
  };
  try {
    if (block.name !== "get_site_data") return result(`Unknown tool ${block.name}.`, true);
    const input = block.input && typeof block.input === "object" ? block.input : {};
    const source = input.source;
    if (typeof source !== "string" || !Object.prototype.hasOwnProperty.call(SITE_SOURCES, source)) {
      return result(`Unknown source. Valid sources: ${SOURCE_NAMES.join(", ")}.`, true);
    }
    const def = SITE_SOURCES[source];
    const validated = validateParams(source, input);
    if (validated.error) return result(validated.error, true, { source, label: describeLookup(source, {}), ok: false });
    const label = describeLookup(source, validated.params);

    if (ctx.lookups >= LIMITS.MAX_LOOKUPS) return result(`Lookup limit reached (${LIMITS.MAX_LOOKUPS} for one question). Answer with what you already have and say what you could not check.`, true, { source, label, ok: false });
    if (def.xero && ctx.xeroLookups >= LIMITS.MAX_XERO_LOOKUPS) return result(`Xero lookup limit reached (${LIMITS.MAX_XERO_LOOKUPS} for one question). Answer with what you already have and say what you could not check.`, true, { source, label, ok: false });
    ctx.lookups++;
    if (def.xero) ctx.xeroLookups++;

    const { status, body } = await callSite(def.handler, def.build(validated.params), ctx.authorization);
    let text = JSON.stringify(body);
    if (status < 200 || status >= 300) {
      return result(`The page returned an error (HTTP ${status}): ${text}`, true, { source, label, ok: false });
    }
    if (text.length > LIMITS.MAX_RESULT_CHARS) {
      const omitted = text.length - LIMITS.MAX_RESULT_CHARS;
      text = `${text.slice(0, LIMITS.MAX_RESULT_CHARS)}\n[Result cut off: ${omitted} more characters omitted. Ask again with a narrower year, period or client if the missing part matters.]`;
    }
    if (ctx.chars + text.length > LIMITS.MAX_TOTAL_CHARS) {
      return result("The total amount of data fetched for this question has reached its limit. Answer with what you already have and say what you could not check.", true, { source, label, ok: false });
    }
    ctx.chars += text.length;
    return result(text, false, { source, label, ok: true });
  } catch (e) {
    console.error("[ask] site lookup failed:", e);
    return result("That lookup failed unexpectedly. Say plainly that you could not check it.", true, { source: (block.input && block.input.source) || "unknown", label: "Lookup", ok: false });
  }
}

module.exports = { SITE_SOURCES, SITE_TOOL, SOURCE_NAMES, LIMITS, validateParams, callSite, newToolContext, runSiteTool };
