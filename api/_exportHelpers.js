// Shared by the "Export Deck Data" actions. The file this feeds is meant to be
// shown to people outside the business, so everything here exists to make sure
// it carries no names, no salary and no commission. Underscore-prefixed, so it
// is a helper and not a Vercel function.

// The two directors. Their full names appear inside account names (the card
// accounts carry them), so they are scrubbed like any employee.
const DIRECTOR_NAMES = ["Scott Finn", "Lee Mamo"];

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// "Alexander Aparo" -> "AA". A bracketed note such as "(Coordinator)" is not part
// of a name. A person known by one name only ("Izzy") gets one letter.
function initialsOf(name) {
  const cleaned = String(name || "").replace(/\(.*?\)/g, " ").replace(/[^A-Za-z\u00C0-\u024F'\- ]/g, " ").trim();
  const parts = cleaned.split(/[\s\-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.map((p) => p[0].toUpperCase()).join("").slice(0, 3);
}

// people: [{ key, name }]. Two people can share initials, so a repeat gets a number
// (JS, JS2). Walked in a fixed order, so the same person always gets the same
// initials on every tab and on every run while the team is unchanged.
function buildInitialsMap(people) {
  const ordered = [...people].filter((p) => p && p.name).sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.key).localeCompare(String(b.key)));
  const used = {};
  const map = {};
  for (const p of ordered) {
    if (map[p.key]) continue;
    const base = initialsOf(p.name);
    used[base] = (used[base] || 0) + 1;
    map[p.key] = used[base] === 1 ? base : `${base}${used[base]}`;
  }
  return map;
}

// Replaces any known person's full name (in either order, any case, any spacing)
// with their initials, and the directors' first names on their own. people:
// [{ name, initials }].
function buildScrubber(people) {
  const rules = [];
  for (const p of people) {
    const name = String(p.name || "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
    if (!name) continue;
    const words = name.split(" ");
    rules.push({ re: new RegExp(`(?<![A-Za-z])${words.map(escapeRe).join("\\s+")}(?![A-Za-z])`, "gi"), to: p.initials });
    if (words.length === 2) rules.push({ re: new RegExp(`(?<![A-Za-z])${escapeRe(words[1])}\\s*,\\s*${escapeRe(words[0])}(?![A-Za-z])`, "gi"), to: p.initials });
  }
  for (const full of DIRECTOR_NAMES) {
    const hit = people.find((p) => String(p.name).toLowerCase() === full.toLowerCase());
    if (hit) rules.push({ re: new RegExp(`(?<![A-Za-z])${escapeRe(full.split(" ")[0])}(?![A-Za-z])`, "gi"), to: hit.initials });
  }
  rules.sort((a, b) => b.re.source.length - a.re.source.length);
  return (text) => {
    let out = String(text === null || text === undefined ? "" : text);
    for (const r of rules) out = out.replace(r.re, r.to);
    return out;
  };
}

// Final check on a finished export: it throws if any known person's full name, or a
// distinctive surname, is still anywhere in it. A scrub that missed something must
// stop the export, not ship it.
function assertNoNames(payload, people) {
  const text = JSON.stringify(payload).toLowerCase();
  const needles = new Set();
  for (const p of people) {
    const name = String(p.name || "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    // A client or candidate name is checked whole, even when it is a single word.
    if (p.always) { if (name.length >= 4) needles.add(name); continue; }
    if (name.includes(" ")) needles.add(name);
    const last = name.split(" ").pop();
    if (name.includes(" ") && last.length >= 6) needles.add(last);
  }
  for (const n of needles) {
    if (text.includes(n)) throw new Error(`Export blocked: the name "${n}" was still in the output.`);
  }
}

// Lines that are pay: salaries, wages, commission, and what goes with them. Matching a
// line that is not pay only hides one harmless line, and the Notes tab lists every
// excluded line so it can be seen. Missing one would show pay, so this errs wide.
const STAFF_COST_PATTERNS = [
  /wage/i, /salar/i, /commission/i, /payroll/i, /bonus/i, /pension/i, /national\s+insurance/i, /\bnic?\b/i,
  /\bpaye\b/i, /employer/i, /remuneration/i, /holiday\s+pay/i, /sick\s+pay/i, /statutory/i, /redundan/i,
  /incentive/i, /staff\s+cost/i, /director'?s?\s+(pay|fees?|remuneration|salary)/i, /p11d/i, /team\s+lead/i,
];
function isStaffCostLabel(label) {
  const s = String(label || "");
  return STAFF_COST_PATTERNS.some((re) => re.test(s));
}

// Borrowing, as it appears on a balance sheet.
const DEBT_PATTERNS = [/loan/i, /overdraft/i, /borrow/i, /\bdebt\b/i, /hire\s+purchase/i, /\bhp\b/i, /finance\s+lease/i, /credit\s+card/i, /\bamex\b/i, /mortgage/i, /bounce\s*back/i, /\bbbl\b/i, /cbils/i, /invoice\s+financ/i, /factoring/i, /\bfacility\b/i];
function isDebtLabel(label) {
  const s = String(label || "");
  return DEBT_PATTERNS.some((re) => re.test(s));
}

// 0 -> "A" ... 25 -> "Z", 26 -> "AA".
function letterFor(index) {
  let n = index, out = "";
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}
const clientLabel = (index) => `Client ${letterFor(index)}`;

// "Citadel Securities" and "citadel  securities " are one client.
function normaliseClientName(name) {
  return String(name || "Unknown").replace(/\s+/g, " ").trim().toLowerCase() || "unknown";
}

// One directory of everyone who could appear, built from the roster, the fee records
// and the directors. A person can be spelled differently in different places ("Alex
// Aparo" on the roster, "Alexander Aparo" on the fees), so they are keyed by their
// consultant id and every spelling is an alias of the same initials. Anyone with no
// name at all falls back to their id ("lee-mamo" -> LM).
function buildPeopleDirectory(records) {
  const { ROSTER } = require("./roster");
  const byKey = {};
  for (const [id, info] of Object.entries(ROSTER)) byKey[id] = { key: id, name: info.name, aliases: new Set([info.name]) };
  for (const r of records || []) {
    if (!r || !r.consultantId) continue;
    if (!byKey[r.consultantId]) byKey[r.consultantId] = { key: r.consultantId, name: r.consultantName || r.consultantId, aliases: new Set() };
    if (r.consultantName) byKey[r.consultantId].aliases.add(r.consultantName);
  }
  const known = new Set();
  for (const p of Object.values(byKey)) { known.add(String(p.name).toLowerCase()); for (const a of p.aliases) known.add(String(a).toLowerCase()); }
  for (const full of DIRECTOR_NAMES) {
    if (!known.has(full.toLowerCase())) byKey[`director:${full}`] = { key: `director:${full}`, name: full, aliases: new Set([full]) };
  }
  const list = Object.values(byKey);
  const initials = buildInitialsMap(list.map((p) => ({ key: p.key, name: p.name })));
  const people = [];
  for (const p of list) for (const n of new Set([p.name, ...p.aliases])) people.push({ name: n, initials: initials[p.key] });
  return { initialsFor: (id) => initials[id] || initialsOf(id), people, scrub: buildScrubber(people) };
}

module.exports = { buildPeopleDirectory, DIRECTOR_NAMES, initialsOf, buildInitialsMap, buildScrubber, assertNoNames, isStaffCostLabel, isDebtLabel, letterFor, clientLabel, normaliseClientName, STAFF_COST_PATTERNS };
