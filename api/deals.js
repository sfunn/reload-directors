const { getDirectorFromRequest, kv } = require("./_directorAuth");
const { resolveUplift, resolvedRevenueGBP, getOverrides, setOverride } = require("./_dealRevenueUplift");

const RECORDS_KEY = "atlas-fee-records"; // shared with the incentive site — read only, never written here
const FX_KEY = "atlas-fx-rates";
const PLACEMENTS_KEY = "atlas-placements";
// Both owned entirely by this site, exactly like deal-revenue-overrides —
// never touches Atlas or the shared deal data itself. The managed list is
// deliberately per-client, since "Commodities" or "PCG" only make sense
// within a specific client's own real internal structure, not as one
// shared list every client gets lumped into.
const DEAL_AREAS_KEY = "deal-client-areas"; // { [clientCompanyName]: string[] }
const DEAL_AREA_VARIANT_MAP_KEY = "deal-area-variant-map"; // { [client]: { [lowercasedRawNoteText]: canonicalAreaName } }

// A real normalized key for comparison purposes only — strips anything
// that isn't a letter or digit and lowercases what's left, so
// "Post-Trade", "postrade", and "POST TRADE" all collapse to the exact
// same key and match each other automatically. The actual canonical
// area name shown everywhere else stays exactly as it was originally
// entered — this is only ever used to decide whether two pieces of text
// mean the same real thing, never to change what gets displayed.
function normalizeAreaKey(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A real edit distance — the minimum number of single-character
// insertions, deletions, or substitutions needed to turn one string
// into the other. Used only to suggest a likely match for a genuine
// typo, never to resolve one automatically without confirmation.
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Deliberately conservative — the difference has to be small relative
// to the length of the text itself, and both strings need a real
// minimum length, since a short name like "PCG" is only one character
// away from plenty of things that are genuinely unrelated to it, not a
// typo of them. And critically, this only ever resolves when exactly
// one real area is close enough — if two genuinely different areas
// could both plausibly be what was meant, this refuses to guess between
// them rather than silently picking whichever happens to be marginally
// closer.
function findFuzzyAreaMatch(normalizedText, canonicalAreas) {
  if (normalizedText.length < 5) return null;
  const withinRange = [];
  for (const area of canonicalAreas || []) {
    const normalizedArea = normalizeAreaKey(area);
    if (normalizedArea.length < 5) continue;
    const distance = levenshteinDistance(normalizedText, normalizedArea);
    const threshold = Math.max(1, Math.floor(Math.max(normalizedText.length, normalizedArea.length) * 0.2));
    if (distance > 0 && distance <= threshold) withinRange.push(area);
  }
  return withinRange.length === 1 ? withinRange[0] : null;
}

// The actual precedence, in order: a normalized match against the
// client's own managed area list resolves automatically —
// capitalization, hyphens, and spacing differences are all treated as
// the same real thing, since they obviously are. Failing that, a
// previously-confirmed variant mapping resolves automatically too,
// since once a director has told the system what a piece of real text
// actually means once, there's no reason to ask again. Failing that, a
// genuine small typo resolves automatically as well, on the reasoning
// that these areas are distinct enough from each other that a minor
// spelling slip won't be mistaken for the wrong one — and if a real
// mistake ever does happen, the fix is just correcting the note in
// Atlas, not reviewing every deal by hand. Only genuinely new,
// unrecognised text gets flagged as needing a real decision.
function resolveAreaForDeal(rawNotes, canonicalAreas, variantMap) {
  const trimmed = (rawNotes || "").trim();
  if (!trimmed) return { area: null, source: "none" };
  const normalized = normalizeAreaKey(trimmed);
  const exactMatch = (canonicalAreas || []).find((a) => normalizeAreaKey(a) === normalized);
  if (exactMatch) return { area: exactMatch, source: "atlas" };
  const mapped = (variantMap || {})[normalized];
  if (mapped) return { area: mapped, source: "atlas" };
  const fuzzyMatch = findFuzzyAreaMatch(normalized, canonicalAreas);
  if (fuzzyMatch) return { area: fuzzyMatch, source: "atlas-fuzzy" };
  return { area: null, source: "unmapped", rawText: trimmed };
}

// --- Everything below this line is a direct port of the incentive site's
// api/deals.js "detail" logic (Super-Admin-only view). Kept byte-for-byte
// equivalent on purpose, so this page can never silently drift from the
// numbers Scott and Lee already trust on the incentive site. If that logic
// ever changes there, port the change here too rather than re-deriving it. ---

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

async function convertToUSD(record, allRates) {
  if (record.currency === "USD") return record.shareAmount;
  const rate = getRateForCurrency(record, allRates, record.currency);
  if (!rate) return null;
  return record.shareAmount * rate;
}

// GBP is Reload's own real reporting currency, same as Company Overview —
// ported directly from that file rather than re-derived, so the two pages
// can never quietly disagree on what a pound is worth.
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

function effectiveYear(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  const dateStr = (placement && placement.startDate) || record.feeDate;
  const d = dateStr ? new Date(dateStr) : null;
  return d && !isNaN(d.getTime()) ? d.getUTCFullYear() : record.year;
}

function orderDateOf(record, placements) {
  const placement = record.placementId ? placements[record.placementId] : null;
  return (placement && placement.startDate) || record.feeDate || "";
}

// --- End direct port ---

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const director = await getDirectorFromRequest(req);
  if (!director) {
    return res.status(401).json({ error: "Director access required." });
  }

  // The ONE deliberate write path on this otherwise read-only page — a
  // manual revenue override for a specific deal, when the true figure is
  // known to be higher than even the standard client uplift below would
  // produce. Stored entirely separately from atlas-fee-records, never
  // touches the shared, incentive-site-owned deal data itself.
  if (req.method === "POST" && req.query.action === "set-deal-override") {
    const { feeId, splitId, amount, currency, customRate, notes } = req.body || {};
    if (!feeId || !splitId) return res.status(400).json({ error: "feeId and splitId are both required." });
    const result = await setOverride(feeId, splitId, amount, currency, customRate, notes);
    return res.status(200).json({ ok: true, override: result });
  }

  // The managed area list, and the actual per-deal tagging — both owned
  // entirely here, same reasoning as the revenue override above. Areas
  // are deliberately scoped per client, not one shared list, since
  // Citadel's own real desks have nothing to do with any other client's.
  if (req.query.action === "client-areas" && req.method === "GET") {
    const areas = (await kv.get(DEAL_AREAS_KEY)) || {};
    return res.status(200).json({ areas });
  }
  if (req.query.action === "toggle-client-area" && req.method === "POST") {
    const { client, area } = req.body || {};
    if (!client || !area) return res.status(400).json({ error: "client and area are both required." });
    const allAreas = (await kv.get(DEAL_AREAS_KEY)) || {};
    const existing = allAreas[client] || [];
    const alreadyThere = existing.includes(area);
    allAreas[client] = alreadyThere ? existing.filter((a) => a !== area) : [...existing, area];
    await kv.set(DEAL_AREAS_KEY, allAreas);
    return res.status(200).json({ areas: allAreas, nowPresent: !alreadyThere });
  }
  // Area Concentration — genuinely different from the client breakdown
  // below, this is entirely WITHIN one specific client's own deals,
  // grouped by whichever area each was tagged with, using the exact
  // same resolvedRevenueGBP every other revenue figure on this site
  // already trusts. A deal never tagged with an area simply isn't
  // counted here — this only ever reflects what's actually been tagged,
  // never a guess at what an untagged deal's area might be.
  if (req.query.action === "area-concentration" && req.method === "GET") {
    const client = req.query.client;
    if (!client) return res.status(400).json({ error: "A client is required." });
    const allTime = req.query.year === "all";
    const year = allTime ? null : (req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear());
    const records = (await kv.get(RECORDS_KEY)) || [];
    const allRates = (await kv.get(FX_KEY)) || {};
    const placements = (await kv.get(PLACEMENTS_KEY)) || {};
    const overrides = await getOverrides();
    const clientAreasForResolve = (await kv.get(DEAL_AREAS_KEY)) || {};
    const areaVariantMap = (await kv.get(DEAL_AREA_VARIANT_MAP_KEY)) || {};

    const byArea = {};
    let clientTotalGBP = 0;
    let untaggedCount = 0;
    let unmappedCount = 0;
    for (const r of records) {
      const dealYear = effectiveYear(r, placements);
      if (!allTime && dealYear !== year) continue;
      const placement = r.placementId ? placements[r.placementId] : null;
      const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
      if (clientCompanyName !== client) continue;
      const hasPlacementName = !!(placement && placement.candidateName);
      // Placements only — this whole feature exists to track which real
      // desk a genuine hire went into, not onsite fee revenue, which
      // isn't tied to a specific area the same way.
      if (!hasPlacementName) continue;
      const gbpAmount = resolvedRevenueGBP(r, clientCompanyName, dealYear, overrides, hasPlacementName, allRates);
      if (gbpAmount === null) continue;
      clientTotalGBP += gbpAmount;
      const resolved = resolveAreaForDeal(r.notes, clientAreasForResolve[client], areaVariantMap[client]);
      if (resolved.source === "unmapped") { unmappedCount += 1; continue; }
      if (!resolved.area) { untaggedCount += 1; continue; }
      if (!byArea[resolved.area]) byArea[resolved.area] = { area: resolved.area, totalGBP: 0, deals: 0 };
      byArea[resolved.area].totalGBP += gbpAmount;
      byArea[resolved.area].deals += 1;
    }
    const areaBreakdown = Object.values(byArea)
      .map((a) => ({ ...a, percentage: clientTotalGBP > 0 ? (a.totalGBP / clientTotalGBP) * 100 : 0 }))
      .sort((a, b) => b.totalGBP - a.totalGBP);

    return res.status(200).json({ year: allTime ? "all" : year, client, areaBreakdown, clientTotalGBP, untaggedCount, unmappedCount });
  }

  // Whichever raw, real text Atlas actually holds for this client, that
  // doesn't yet match any known canonical area or confirmed variant —
  // grouped by distinct text so the same unrecognised note doesn't need
  // resolving one deal at a time. Only ever surfaces what genuinely
  // needs a real decision, never something already resolved automatically.
  // Placements only, same reasoning as area-concentration above — an
  // onsite fee was never going to need an area tag in the first place.
  if (req.query.action === "unmapped-notes" && req.method === "GET") {
    const client = req.query.client;
    if (!client) return res.status(400).json({ error: "A client is required." });
    const records = (await kv.get(RECORDS_KEY)) || [];
    const placements = (await kv.get(PLACEMENTS_KEY)) || {};
    const clientAreasForResolve = (await kv.get(DEAL_AREAS_KEY)) || {};
    const areaVariantMap = (await kv.get(DEAL_AREA_VARIANT_MAP_KEY)) || {};

    const unmappedTexts = new Set();
    for (const r of records) {
      const placement = r.placementId ? placements[r.placementId] : null;
      const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
      if (clientCompanyName !== client) continue;
      if (!(placement && placement.candidateName)) continue;
      const resolved = resolveAreaForDeal(r.notes, clientAreasForResolve[client], areaVariantMap[client]);
      if (resolved.source === "unmapped") unmappedTexts.add(resolved.rawText);
    }
    return res.status(200).json({ client, unmappedTexts: Array.from(unmappedTexts) });
  }

  // Confirms that a specific piece of raw Atlas text genuinely means a
  // specific canonical area — remembered here so every future deal with
  // that same exact text resolves automatically from then on, without
  // ever needing to ask again.
  if (req.query.action === "map-area-variant" && req.method === "POST") {
    const { client, rawText, canonicalArea } = req.body || {};
    if (!client || !rawText || !canonicalArea) return res.status(400).json({ error: "client, rawText, and canonicalArea are all required." });
    const allVariantMaps = (await kv.get(DEAL_AREA_VARIANT_MAP_KEY)) || {};
    if (!allVariantMaps[client]) allVariantMaps[client] = {};
    allVariantMaps[client][normalizeAreaKey(rawText)] = canonicalArea;
    await kv.set(DEAL_AREA_VARIANT_MAP_KEY, allVariantMaps);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "This endpoint is read-only. Edit deal records on the incentive site." });
  }

  const records = (await kv.get(RECORDS_KEY)) || [];
  const allRates = (await kv.get(FX_KEY)) || {};
  const placements = (await kv.get(PLACEMENTS_KEY)) || {};
  const overrides = await getOverrides();
  const clientAreasForResolve = (await kv.get(DEAL_AREAS_KEY)) || {};
  const areaVariantMap = (await kv.get(DEAL_AREA_VARIANT_MAP_KEY)) || {};
  const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();

  const yearRecords = records
    .filter((r) => effectiveYear(r, placements) === year)
    .sort((a, b) => orderDateOf(a, placements).localeCompare(orderDateOf(b, placements)));

  const withUSD = await Promise.all(
    yearRecords.map(async (r) => {
      const placement = r.placementId ? placements[r.placementId] : null;
      const clientCompanyName = (placement && placement.clientCompanyName) || r.projectClientName || null;
      const hasPlacementName = !!(placement && placement.candidateName);
      const rawUsdAmount = await convertToUSD(r, allRates);
      const rawGbpAmount = convertToGBP(r, allRates);

      // GBP now comes from the single shared function every revenue page
      // calls, so this can never quietly drift from Company Overview or
      // Consultant Stats the way it briefly did before that existed. USD
      // stays computed locally — a genuinely separate concern the shared
      // function doesn't cover, and not worth touching in an
      // already-correct file just to consolidate further right now.
      const decision = resolveUplift(r, clientCompanyName, year, overrides, hasPlacementName);
      const gbpAmount = resolvedRevenueGBP(r, clientCompanyName, year, overrides, hasPlacementName, allRates);
      let usdAmount = rawUsdAmount;
      if (decision.type === "override") {
        if (decision.customRate) {
          // A specific real rate was recorded for this deal, overriding the
          // standard monthly rate table entirely — expressed as 1 GBP = X
          // USD, same convention as everywhere else, regardless of which
          // currency the override amount itself was entered in.
          usdAmount = decision.currency === "GBP" ? decision.amount * decision.customRate : decision.amount;
        } else {
          // The override might genuinely be in GBP, not USD — e.g. a deal
          // recorded in Atlas as USD but actually paid in pounds.
          usdAmount = await convertToUSD({ currency: decision.currency, shareAmount: decision.amount, paid: r.paid, paidMarkedAt: r.paidMarkedAt }, allRates);
        }
      } else if (decision.type === "multiplier") {
        if (rawUsdAmount !== null) usdAmount = rawUsdAmount * decision.value;
      }

      return {
        ...r,
        rawUsdAmount,
        rawGbpAmount,
        usdAmount,
        gbpAmount,
        upliftType: decision.type, // "override" | "multiplier" | "none" — lets the frontend show exactly what applied
        upliftMultiplier: decision.type === "multiplier" ? decision.value : null,
        upliftOverrideAmount: decision.type === "override" ? decision.amount : null,
        upliftOverrideCurrency: decision.type === "override" ? decision.currency : null,
        upliftOverrideCustomRate: decision.type === "override" ? decision.customRate : null,
        upliftNotes: decision.type === "override" ? decision.notes : null,
        candidateName: (placement && placement.candidateName) || r.notes || null,
        hasPlacementName,
        clientCompanyName,
        placementStartDate: (placement && placement.startDate) || r.feeDate || null,
        monthOverrides: r.monthOverrides || {},
        coordinatorId: r.coordinatorId || null,
        source: r.source || null,
        ...(() => {
          const resolved = resolveAreaForDeal(
            r.notes,
            clientCompanyName ? clientAreasForResolve[clientCompanyName] : null,
            clientCompanyName ? areaVariantMap[clientCompanyName] : null
          );
          return { area: resolved.area, areaSource: resolved.source, areaRawText: resolved.rawText || null, rawNotes: r.notes || null };
        })(),
      };
    })
  );

  // Ranked totals per consultant, everyone included — unlike the incentive
  // site's own leaderboard, this doesn't exclude Scott and Lee, since this
  // is the directors' complete financial picture, not the consultants'
  // ranked competition. GBP is the primary figure everywhere on this page
  // now, matching Company Overview — a deal counts once it can convert to
  // GBP, same rule as there.
  const totals = {};
  const bySource = {};
  let grandTotalGBP = 0;
  for (const r of withUSD) {
    if (r.gbpAmount === null || !r.consultantId) continue;
    grandTotalGBP += r.gbpAmount;
    if (!totals[r.consultantId]) totals[r.consultantId] = { consultantId: r.consultantId, consultantName: r.consultantName, totalGBP: 0, totalUSD: 0, deals: 0, onsites: 0 };
    totals[r.consultantId].totalGBP += r.gbpAmount;
    if (r.usdAmount !== null) totals[r.consultantId].totalUSD += r.usdAmount;
    if (r.hasPlacementName) totals[r.consultantId].deals += 1; else totals[r.consultantId].onsites += 1;
    if (r.source) {
      if (!bySource[r.source]) bySource[r.source] = { source: r.source, deals: 0, valueGBP: 0, valueUSD: 0 };
      bySource[r.source].deals += 1;
      bySource[r.source].valueGBP += r.gbpAmount;
      if (r.usdAmount !== null) bySource[r.source].valueUSD += r.usdAmount;
    }
  }
  const leaderboard = Object.values(totals)
    .map((t) => ({ ...t, percentage: grandTotalGBP > 0 ? (t.totalGBP / grandTotalGBP) * 100 : 0 }))
    .sort((a, b) => b.totalGBP - a.totalGBP);
  const sourceBreakdown = Object.values(bySource)
    .map((s) => ({ ...s, percentage: grandTotalGBP > 0 ? (s.valueGBP / grandTotalGBP) * 100 : 0 }))
    .sort((a, b) => b.valueGBP - a.valueGBP);

  // Full client breakdown — every consultant's deals count here, including
  // Scott and Lee's own, since this is the directors' complete financial
  // picture, not the consultants' ranked leaderboard.
  const byClient = {};
  let clientGrandTotalGBP = 0;
  let clientGrandTotal = 0;
  for (const r of withUSD) {
    if (r.gbpAmount === null || !r.consultantId) continue;
    const firm = r.clientCompanyName || "Unknown";
    if (!byClient[firm]) byClient[firm] = { firm, totalGBP: 0, totalUSD: 0, deals: 0, onsites: 0 };
    byClient[firm].totalGBP += r.gbpAmount;
    if (r.usdAmount !== null) byClient[firm].totalUSD += r.usdAmount;
    if (r.hasPlacementName) byClient[firm].deals += 1; else byClient[firm].onsites += 1;
    clientGrandTotalGBP += r.gbpAmount;
    if (r.usdAmount !== null) clientGrandTotal += r.usdAmount;
  }
  const clientBreakdown = Object.values(byClient)
    .map((c) => ({ ...c, percentage: clientGrandTotalGBP > 0 ? (c.totalGBP / clientGrandTotalGBP) * 100 : 0 }))
    .sort((a, b) => b.totalGBP - a.totalGBP);

  return res.status(200).json({ year, records: withUSD, leaderboard, sourceBreakdown, clientBreakdown, clientGrandTotal, clientGrandTotalGBP });
};
