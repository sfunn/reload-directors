const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { isExcludedProjectRecord, resolvedRevenueGBP, getOverrides } = require("./_dealRevenueUplift");

// ============================================================================
// Everything below is a direct, deliberate port of the incentive site's own
// api/commission.js compute engine — same bands, same currency fallback,
// same Natasha/Citadel uplift, kept byte-for-byte equivalent on purpose.
// This file is read-only: no set-bands, set-target, or set-flat-rate here,
// those stay Super-Admin actions on the incentive site. Access control is
// the one deliberate difference — any director may view any consultant's
// commission here, since this site exists precisely so Scott and Lee don't
// need to log into the incentive site to see the full financial picture.
// ============================================================================

const STANDARD_BANDS = [
  { min: 0, max: 150000, rate: 0.10 },
  { min: 150000, max: 300000, rate: 0.125 },
  { min: 300000, max: 450000, rate: 0.15 },
  { min: 450000, max: 600000, rate: 0.175 },
  { min: 600000, max: 750000, rate: 0.20 },
  { min: 750000, max: 900000, rate: 0.225 },
  { min: 900000, max: 1000000, rate: 0.25 },
  { min: 1000000, max: null, rate: 0.30 },
];

function computeCommissionLines(deals, bands) {
  const sortedBands = [...bands].sort((a, b) => a.min - b.min);
  let cumulative = 0;
  const lines = [];

  for (const deal of deals) {
    let remaining = deal.gbpAmount;
    if (remaining === null || remaining === undefined || isNaN(remaining)) continue;

    while (remaining > 0.005) {
      const band = sortedBands.find((b) => cumulative >= b.min && (b.max === null || cumulative < b.max));
      if (!band) break;

      const spaceInBand = band.max === null ? Infinity : band.max - cumulative;
      const portion = Math.min(remaining, spaceInBand);
      const commission = portion * band.rate;
      const usdPortion = (deal.usdAmount !== null && deal.usdAmount !== undefined && deal.gbpAmount > 0)
        ? deal.usdAmount * (portion / deal.gbpAmount)
        : null;

      lines.push({
        feeId: deal.feeId, splitId: deal.splitId, feeDate: deal.feeDate, startDate: deal.startDate || null,
        gbpPortion: portion, rate: band.rate, bandMin: band.min, bandMax: band.max, commission,
        paid: deal.paid, paidMarkedAt: deal.paidMarkedAt, source: deal.source || null,
        candidateName: deal.candidateName || null, clientCompanyName: deal.clientCompanyName || null,
        originalCurrency: deal.originalCurrency || null,
        originalAmount: deal.originalAmount !== undefined ? deal.originalAmount : null,
        usdAmount: usdPortion, monthOverrides: deal.monthOverrides || {},
        hasPlacementName: !!deal.hasPlacementName,
      });

      cumulative += portion;
      remaining -= portion;
    }
  }

  const totalCommission = lines.reduce((sum, l) => sum + l.commission, 0);
  return { lines, totalGBP: cumulative, totalCommission };
}

function payoutSchedule(line) {
  const perMonth = line.commission / 4;
  const overrides = line.monthOverrides || {};

  if (!line.paid || !line.paidMarkedAt) {
    return [1, 2, 3, 4].map((n) => ({ label: `Month ${n}`, monthNumber: n, amount: perMonth, paidDate: null, status: overrides[n] || "future" }));
  }

  const base = new Date(line.paidMarkedAt);
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const months = [];
  for (let i = 1; i <= 4; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    const label = d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
    let status;
    if (overrides[i] && overrides[i] !== "due") status = overrides[i];
    else if (d.getTime() < currentMonthStart) status = "paid";
    else if (d.getTime() === currentMonthStart) status = "due";
    else status = "future";
    months.push({ label, monthNumber: i, amount: perMonth, paidDate: d.toISOString(), status });
  }
  return months;
}

function singleMonthPayout(line) {
  const overrides = line.monthOverrides || {};
  if (!line.paid || !line.paidMarkedAt) {
    return [{ label: "Month 1", monthNumber: 1, amount: line.commission, paidDate: null, status: overrides[1] && overrides[1] !== "due" ? overrides[1] : "future" }];
  }
  const base = new Date(line.paidMarkedAt);
  const now = new Date();
  const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
  const label = d.toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  let status;
  if (overrides[1] && overrides[1] !== "due") status = overrides[1];
  else if (d.getTime() < currentMonthStart) status = "paid";
  else if (d.getTime() === currentMonthStart) status = "due";
  else status = "future";
  return [{ label, monthNumber: 1, amount: line.commission, paidDate: d.toISOString(), status }];
}

const SETTINGS_KEY = "commission-settings";
const RECORDS_KEY = "atlas-fee-records";
const FX_KEY = "atlas-fx-rates";
const PLACEMENTS_KEY = "atlas-placements";
const DEFAULT_FLAT_RATE = 500;
const COORDINATOR_IDS = new Set(["izzy-coordinator", "zoe-coordinator"]);

function monthKeyFromDateStr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function latestSetMonthKeyForCurrency(allRates, currency) {
  const keys = Object.keys(allRates)
    .filter((k) => allRates[k] && allRates[k][currency] !== undefined && allRates[k][currency] !== null && allRates[k][currency] !== 0)
    .sort();
  return keys.length ? keys[keys.length - 1] : null;
}

function getRateForCurrency(record, allRates, currency) {
  if (record.paid && record.paidMarkedAt) {
    const paidMonthKey = monthKeyFromDateStr(record.paidMarkedAt);
    const paidRate = allRates[paidMonthKey] && allRates[paidMonthKey][currency];
    if (paidRate) return paidRate;
  }
  const latestKey = latestSetMonthKeyForCurrency(allRates, currency);
  return latestKey ? allRates[latestKey][currency] : null;
}

function convertToGBP(record, allRates) {
  if (record.currency === "GBP") return record.shareAmount;
  const gbpRate = getRateForCurrency(record, allRates, "GBP");
  if (!gbpRate) return null;
  if (record.currency === "USD") return record.shareAmount / gbpRate;
  if (record.currency === "EUR") {
    const eurRate = getRateForCurrency(record, allRates, "EUR");
    if (!eurRate) return null;
    const usdEquivalent = record.shareAmount * eurRate;
    return usdEquivalent / gbpRate;
  }
  return null;
}

function convertToUSDEquivalent(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  if (record.currency === "EUR") {
    const eurRate = getRateForCurrency(record, allRates, "EUR");
    if (!eurRate) return null;
    return record.shareAmount * eurRate;
  }
  if (record.currency === "GBP") {
    const gbpRate = getRateForCurrency(record, allRates, "GBP");
    if (!gbpRate) return null;
    return record.shareAmount * gbpRate;
  }
  return null;
}

// SPECIAL CASE — Natasha Barnard / Citadel, effective 2026 onward. Kept
// exactly as-is from the incentive site. See that file's comments for the
// full rationale; this is a deliberate, tightly-scoped, auditable copy —
// not a reference to shared code, since these two projects don't share a
// runtime — so if this rule ever changes, it must be changed in BOTH places.
const SPECIAL_RATE_CONSULTANT_ID = "natasha-barnard";
const SPECIAL_RATE_CLIENT_SUBSTRING = "citadel";
const SPECIAL_RATE_MIN_YEAR = 2026;
const SPECIAL_RATE_MULTIPLIER = 1.2;

function appliesNatashaCitadelUplift(record, year) {
  if (record.consultantId !== SPECIAL_RATE_CONSULTANT_ID) return false;
  const client = (record.clientCompanyName || "").toLowerCase();
  if (!client.includes(SPECIAL_RATE_CLIENT_SUBSTRING)) return false;
  if (!year || year < SPECIAL_RATE_MIN_YEAR) return false;
  if (!record.hasPlacementName) return false;
  return true;
}

function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
}

function carryForwardValue(byYear, year) {
  if (!byYear) return null;
  if (byYear[year] !== undefined && byYear[year] !== null) {
    const v = byYear[year];
    if (Array.isArray(v) ? v.length > 0 : true) return v;
  }
  const priorYears = Object.keys(byYear)
    .map(Number)
    .filter((y) => y <= year && byYear[y] !== undefined && byYear[y] !== null && (!Array.isArray(byYear[y]) || byYear[y].length > 0))
    .sort((a, b) => b - a);
  return priorYears.length ? byYear[priorYears[0]] : null;
}

// Computes one consultant's commission for exactly one year — extracted
// so the exact same logic serves both the existing single-year view
// (unchanged) and an all-time total, built below by calling this once
// per year and summing. Never recomputes anything by pooling multiple
// years together — bands and targets genuinely reset every year, that's
// the whole point of bracket commission, so an all-time figure has to
// be the sum of each year's own correctly-computed total, never one
// calculation run across every deal under whichever year's bands
// happen to apply.
//
// The last argument is optional and OFF by default, so every existing caller
// behaves exactly as before. With includeExcludedProjects true, fees on an
// excluded project (CitSec Options) are NOT filtered out. Only the payroll
// "Commission Due" export passes it, because the incentive site's own
// commission engine has never filtered those fees, and the two lists must
// agree to the penny. Note it changes more than the amount on those fees:
// commission is cumulative through the year's bands, so including them can
// move later deals into a higher band too.
function computeCommissionForYear(consultantId, year, allRecords, allRates, placements, allSettings, options = {}) {
  const includeExcluded = !!(options && options.includeExcludedProjects);
  const personSettings = allSettings[consultantId] || {};

  if (COORDINATOR_IDS.has(consultantId)) {
    const flatRate = carryForwardValue(personSettings.flatRateByYear, year) || DEFAULT_FLAT_RATE;
    const yearRecords = allRecords.filter((r) => effectiveYear(r, placements) === year && r.coordinatorId === consultantId && (includeExcluded || !isExcludedProjectRecord(r)));
    const withOrderDate = yearRecords.map((r) => {
      const placement = r.placementId ? placements[r.placementId] : null;
      const orderDate = (placement && placement.startDate) || r.feeDate;
      const candidateName = (placement && placement.candidateName) || r.notes || null;
      const startDate = (placement && placement.startDate) || r.feeDate || null;
      const hasPlacementName = !!(placement && placement.candidateName);
      const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
      return { ...r, orderDate, candidateName, startDate, hasPlacementName, clientCompanyName };
    });
    withOrderDate.sort((a, b) => (a.orderDate || "").localeCompare(b.orderDate || ""));

    const lines = withOrderDate.map((r) => ({
      feeId: r.feeId, splitId: r.splitId, feeDate: r.feeDate, startDate: r.startDate, commission: flatRate,
      paid: r.paid, paidMarkedAt: r.paidMarkedAt, source: r.source || null, candidateName: r.candidateName,
      clientCompanyName: r.clientCompanyName, originalCurrency: r.currency, originalAmount: r.totalAmount,
      usdAmount: convertToUSDEquivalent(r, allRates), monthOverrides: r.monthOverrides || {}, hasPlacementName: r.hasPlacementName,
    }));
    const linesWithSchedule = lines.map((l) => ({ ...l, payout: singleMonthPayout(l) }));
    const totalCommission = lines.reduce((sum, l) => sum + l.commission, 0);
    const placementBreakdown = {
      placements: { count: lines.filter((l) => l.hasPlacementName).length, totalCommission: lines.filter((l) => l.hasPlacementName).reduce((s, l) => s + l.commission, 0) },
      onsiteFees: { count: lines.filter((l) => !l.hasPlacementName).length, totalCommission: lines.filter((l) => !l.hasPlacementName).reduce((s, l) => s + l.commission, 0) },
    };

    return {
      consultantId, year, isCoordinator: true, flatRate, dealCount: lines.length, totalCommission,
      target: (personSettings.targets && personSettings.targets[year]) || null,
      lines: linesWithSchedule, heldBackCount: 0, placementBreakdown,
    };
  }

  const bands = carryForwardValue(personSettings.bandsByYear, year) || STANDARD_BANDS;
  const target = (personSettings.targets && personSettings.targets[year]) || null;

  const yearRecords = allRecords.filter((r) => effectiveYear(r, placements) === year && r.consultantId === consultantId && (includeExcluded || !isExcludedProjectRecord(r)));
  const withOrderDate = yearRecords.map((r) => {
    const placement = r.placementId ? placements[r.placementId] : null;
    const orderDate = (placement && placement.startDate) || r.feeDate;
    const candidateName = (placement && placement.candidateName) || r.notes || null;
    const startDate = (placement && placement.startDate) || r.feeDate || null;
    const hasPlacementName = !!(placement && placement.candidateName);
    const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
    return { ...r, orderDate, candidateName, startDate, hasPlacementName, clientCompanyName };
  });
  withOrderDate.sort((a, b) => (a.orderDate || "").localeCompare(b.orderDate || ""));

  const dealsForEngine = withOrderDate.map((r) => {
    const uplift = appliesNatashaCitadelUplift(r, year);
    const rawGbp = convertToGBP(r, allRates);
    const rawUsd = convertToUSDEquivalent(r, allRates);
    return {
      feeId: r.feeId, splitId: r.splitId,
      gbpAmount: (uplift && rawGbp !== null) ? rawGbp * SPECIAL_RATE_MULTIPLIER : rawGbp,
      feeDate: r.feeDate, startDate: r.startDate, paid: r.paid, paidMarkedAt: r.paidMarkedAt, source: r.source,
      candidateName: r.candidateName, clientCompanyName: r.clientCompanyName, originalCurrency: r.currency, originalAmount: r.totalAmount,
      usdAmount: (uplift && rawUsd !== null) ? rawUsd * SPECIAL_RATE_MULTIPLIER : rawUsd,
      monthOverrides: r.monthOverrides || {}, hasPlacementName: r.hasPlacementName,
    };
  });

  const heldBack = dealsForEngine.filter((d) => d.gbpAmount === null).length;
  const usableDeals = dealsForEngine.filter((d) => d.gbpAmount !== null);

  const { lines, totalGBP, totalCommission } = computeCommissionLines(usableDeals, bands);
  const linesWithSchedule = lines.map((l) => ({ ...l, payout: payoutSchedule(l) }));

  const dealKey = (l) => `${l.feeId}|${l.splitId}`;
  const placementLines = lines.filter((l) => l.hasPlacementName);
  const onsiteLines = lines.filter((l) => !l.hasPlacementName);
  const placementBreakdown = {
    placements: { count: new Set(placementLines.map(dealKey)).size, totalCommission: placementLines.reduce((s, l) => s + l.commission, 0) },
    onsiteFees: { count: new Set(onsiteLines.map(dealKey)).size, totalCommission: onsiteLines.reduce((s, l) => s + l.commission, 0) },
  };

  return {
    consultantId, year, isCoordinator: false, bands, target, totalGBP, totalCommission,
    lines: linesWithSchedule, heldBackCount: heldBack, placementBreakdown,
  };
}

// Everyone who can be owed commission, in the order the incentive site lists
// them: its ten consultants, then the two team leads, then the two
// coordinators. This is a COPY of the roster, so it has to be updated here
// if someone joins or leaves.
const COMMISSION_DUE_PEOPLE = [
  "alex-silverman", "ash-thiara", "jack-thompson", "max-hart", "oleg-sokyrka",
  "alex-aparo", "jack-routledge", "joe-purton", "josh-davis", "natasha-barnard",
  "james-lancer", "josh-stark",
  "izzy-coordinator", "zoe-coordinator",
];

// Each person's commission actually payable in one calendar month (UTC), for
// payroll. No new commission maths: it calls computeCommissionForYear and adds
// up the instalments that land in the month. A deal belongs to the commission
// year of its placement start date, but its instalments run from the month
// AFTER the invoice was settled, so a deal counted in one year can pay out in
// the next. Looking at the year before, the year itself and the year after
// covers that. An instalment with no paid date, or one marked "withheld", is
// not payable and is left out.
function computeCommissionDue(year, month, allRecords, allRates, placements, allSettings) {
  const people = [];
  for (const consultantId of COMMISSION_DUE_PEOPLE) {
    let dueAmount = 0;
    for (const y of [year - 1, year, year + 1]) {
      const result = computeCommissionForYear(consultantId, y, allRecords, allRates, placements, allSettings, { includeExcludedProjects: true });
      for (const line of result.lines) {
        for (const installment of line.payout) {
          if (!installment.paidDate || installment.status === "withheld") continue;
          const d = new Date(installment.paidDate);
          if (d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month) dueAmount += installment.amount;
        }
      }
    }
    if (dueAmount > 0.005) people.push({ consultantId, amountDueGBP: Math.round(dueAmount * 100) / 100 });
  }
  people.sort((a, b) => b.amountDueGBP - a.amountDueGBP);
  return people;
}

// Fee revenue for one year, counted EXACTLY as the Company Overview counts its "Fee revenue,
// starters" figure: the same shared revenue function (so the revenue-only uplift on Citadel,
// Jane Street, Virtu and PDT, and any manual corrections, are in it), records dated by
// placement start, CitSec Options left out, anything that cannot convert to GBP skipped. That
// is the figure to divide commission by, so the rate ties to the number shown on the Company
// page. The people who are not paid commission (Lee, say) are taken out of it and listed, so
// the difference to the Company page figure is always visible and never silent.
function computeFeeRevenueForYear(year, allRecords, placements, allRates, overrides, commissionedIds) {
  let allGBP = 0, countedGBP = 0;
  const left = {};
  for (const r of allRecords) {
    if (effectiveYear(r, placements) !== year || isExcludedProjectRecord(r)) continue;
    const placement = r.placementId ? placements[r.placementId] : null;
    const client = (placement && placement.clientCompanyName) || r.projectClientName || "Unknown";
    const hasPlacementName = !!(placement && placement.candidateName);
    const gbp = resolvedRevenueGBP(r, client, year, overrides, hasPlacementName, allRates);
    if (gbp === null) continue;
    allGBP += gbp;
    if (commissionedIds.has(r.consultantId)) { countedGBP += gbp; continue; }
    const key = r.consultantId || "unknown";
    if (!left[key]) left[key] = { consultantId: key, name: r.consultantName || key, revenueGBP: 0 };
    left[key].revenueGBP += gbp;
  }
  const excluded = Object.values(left).map((e) => ({ ...e, revenueGBP: Math.round(e.revenueGBP * 100) / 100 })).sort((x, y) => y.revenueGBP - x.revenueGBP);
  return { allGBP, countedGBP, excluded };
}

// The year figures shown above the monthly list. They describe the deals that STARTED in the
// year, the same deals the average rate is worked on, and not what happens to fall on payroll
// in that calendar year (the monthly list is that view):
//   total      = all the commission on those deals, paid or not, instalments in later years too
//   paid so far = their instalments dated on or before "now" (a withheld instalment is not paid)
//   left to pay = total minus paid: deals not yet paid, instalments still to come, and anything withheld
// Coordinators' flat fees on those deals are in the total, and reported separately so the total
// can be tied to the consultants and team leads figure the rate uses.
//
// The average rate is commission on those deals divided by the fee revenue of those same deals,
// so payment timing cannot distort it. Consultants and team leads only: a coordinator's flat fee
// is not a share of any fee, and people who are not paid commission are taken out of the revenue.
// It is one pooled rate (total commission over total revenue), not an average of each person's
// rate. The commission side is worked on the recorded fees, as it always is, while the revenue
// side is the Company page's figure with its uplift, because that is what the business actually
// earns. CitSec Options is out of every side, as it is on the Company page, so they all describe
// the same deals.
function computeCommissionYearSummary(year, now, allRecords, allRates, placements, allSettings, overrides) {
  let total = 0, paid = 0, commissionBase = 0, coordinatorTotal = 0;
  for (const consultantId of COMMISSION_DUE_PEOPLE) {
    const result = computeCommissionForYear(consultantId, year, allRecords, allRates, placements, allSettings);
    total += result.totalCommission;
    if (result.isCoordinator) coordinatorTotal += result.totalCommission; else commissionBase += result.totalCommission;
    for (const line of result.lines) {
      for (const installment of line.payout) {
        if (!installment.paidDate || installment.status === "withheld") continue;
        if (new Date(installment.paidDate).getTime() <= now.getTime()) paid += installment.amount;
      }
    }
  }
  const feeEarners = new Set(COMMISSION_DUE_PEOPLE.filter((id) => !/-coordinator$/.test(id)));
  const revenue = computeFeeRevenueForYear(year, allRecords, placements, allRates, overrides || {}, feeEarners);
  const pence = (n) => Math.round(n * 100);
  const totalPence = pence(total), paidPence = pence(paid);
  return {
    totalDueForYear: totalPence / 100,
    paidYTD: paidPence / 100,
    // worked from the two rounded figures, so what is on screen always adds up
    leftToPay: (totalPence - paidPence) / 100,
    coordinatorCommissionGBP: pence(coordinatorTotal) / 100,
    avgCommissionPct: revenue.countedGBP > 0 ? Math.round((commissionBase / revenue.countedGBP) * 10000) / 100 : null,
    commissionBaseGBP: pence(commissionBase) / 100,
    feeRevenueGBP: pence(revenue.countedGBP) / 100,
    feeRevenueAllGBP: pence(revenue.allGBP) / 100,
    feeRevenueExcluded: revenue.excluded,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only. Bands, targets, and flat rates are set on the incentive site." });
  }

  const director = await getDirectorFromRequest(req);
  if (!director) return res.status(401).json({ error: "Director access required." });

  // Payroll export: everyone's commission due in one month. Any signed-in
  // director may use it. It sits before the consultantId check because it is
  // about everyone, not one person. Read-only.
  if (req.query.action === "compute-all-due") {
    const now = new Date();
    const rawYear = req.query.year;
    const rawMonth = req.query.month;
    const year = rawYear === undefined || rawYear === "" ? now.getUTCFullYear() : (/^\d{4}$/.test(String(rawYear)) ? parseInt(rawYear, 10) : NaN);
    const month = rawMonth === undefined || rawMonth === "" ? now.getUTCMonth() + 1 : (/^\d{1,2}$/.test(String(rawMonth)) ? parseInt(rawMonth, 10) : NaN);
    if (isNaN(year)) return res.status(400).json({ error: "year must be a four digit year such as 2026." });
    if (isNaN(month) || month < 1 || month > 12) return res.status(400).json({ error: "month must be a number from 1 to 12." });

    const dueRecords = (await kv.get(RECORDS_KEY)) || [];
    const dueRates = (await kv.get(FX_KEY)) || {};
    const duePlacements = (await kv.get(PLACEMENTS_KEY)) || {};
    const dueSettings = (await kv.get(SETTINGS_KEY)) || {};
    return res.status(200).json({ year, month, people: computeCommissionDue(year, month, dueRecords, dueRates, duePlacements, dueSettings) });
  }

  // Year figures for the Commission Due tab. Read-only, any signed-in director.
  if (req.query.action === "compute-year-summary") {
    const now = new Date();
    const rawYear = req.query.year;
    const year = rawYear === undefined || rawYear === "" ? now.getUTCFullYear() : (/^\d{4}$/.test(String(rawYear)) ? parseInt(rawYear, 10) : NaN);
    if (isNaN(year)) return res.status(400).json({ error: "year must be a four digit year such as 2026." });
    const sumRecords = (await kv.get(RECORDS_KEY)) || [];
    const sumRates = (await kv.get(FX_KEY)) || {};
    const sumPlacements = (await kv.get(PLACEMENTS_KEY)) || {};
    const sumSettings = (await kv.get(SETTINGS_KEY)) || {};
    const sumOverrides = await getOverrides();
    return res.status(200).json({ year, asOf: now.toISOString(), ...computeCommissionYearSummary(year, now, sumRecords, sumRates, sumPlacements, sumSettings, sumOverrides) });
  }

  const consultantId = req.query.consultantId;
  if (!consultantId) return res.status(400).json({ error: "consultantId is required." });

  const allRecords = (await kv.get(RECORDS_KEY)) || [];
  const allRates = (await kv.get(FX_KEY)) || {};
  const placements = (await kv.get(PLACEMENTS_KEY)) || {};
  const allSettings = (await kv.get(SETTINGS_KEY)) || {};

  // All-time total, for the Profitability page's "since they started"
  // view — genuinely different from just removing the year filter, this
  // calls the exact same per-year function once for every year on
  // record and sums the results, so each year's own bands and target
  // still apply correctly to that year's own deals.
  if (req.query.action === "all-time") {
    const currentYear = new Date().getUTCFullYear();
    let totalCommission = 0;
    let isCoordinator = false;
    for (let y = 2019; y <= currentYear; y++) {
      const result = computeCommissionForYear(consultantId, y, allRecords, allRates, placements, allSettings);
      totalCommission += result.totalCommission;
      isCoordinator = result.isCoordinator;
    }
    return res.status(200).json({ consultantId, isCoordinator, totalCommission });
  }

  const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
  const result = computeCommissionForYear(consultantId, year, allRecords, allRates, placements, allSettings);
  return res.status(200).json(result);
};

module.exports.computeCommissionForYear = computeCommissionForYear;
module.exports.computeCommissionDue = computeCommissionDue;
module.exports.COMMISSION_DUE_PEOPLE = COMMISSION_DUE_PEOPLE;
module.exports.computeCommissionYearSummary = computeCommissionYearSummary;
module.exports.computeFeeRevenueForYear = computeFeeRevenueForYear;
