/**
 * labels.js — Authoritative drug-label lookups for Pharmonym.
 *
 * Replaces AI-generated dosage / warnings with text taken directly from
 * official prescribing information, plus a citation the user can click:
 *   - US:    FDA label via the openFDA API  -> DailyMed citation
 *   - UK/EU: SmPC via the eMC (medicines.org.uk) -> eMC citation
 *
 * Ported / adapted from the PubCrawl MCP server (get_uspi / get_smpc).
 * Every network call is best-effort: any failure returns null so the
 * core name-conversion never breaks.
 */

const fetch = require("node-fetch");
const cheerio = require("cheerio");

const OPENFDA_URL = "https://api.fda.gov/drug/label.json";
const EMC_BASE = "https://www.medicines.org.uk";
const TIMEOUT_MS = 12000;
const MAX_FIELD_CHARS = 1400; // keep cards readable; full text is one click away
const USER_AGENT = "Pharmonym/1.0 (pharmatools.ai; nick@pharmatools.ai)";

/* ----------------------------- helpers ----------------------------- */

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tidy a raw label section: join arrays, strip the leading numbered
 * heading (e.g. "2 DOSAGE AND ADMINISTRATION"), collapse whitespace,
 * and truncate on a sentence boundary.
 */
function cleanSection(value) {
  if (!value) return "";
  let text = Array.isArray(value) ? value.join("\n\n") : String(value);

  text = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Drop a leading section header line like "5 WARNINGS AND PRECAUTIONS"
  text = text.replace(/^\s*\d+(\.\d+)*\s+[A-Z][A-Z \-/,&]+\n+/, "").trim();

  if (text.length > MAX_FIELD_CHARS) {
    const slice = text.slice(0, MAX_FIELD_CHARS);
    const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
    text = (lastStop > MAX_FIELD_CHARS * 0.6 ? slice.slice(0, lastStop + 1) : slice).trim() + " …";
  }
  return text;
}

function formatFdaDate(yyyymmdd) {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return "";
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/* --------------------------- US: openFDA --------------------------- */

/**
 * Fetch the most recent FDA label for a drug and return sourced
 * dosage + warnings with a DailyMed citation. Returns null if none found.
 */
async function getUspi(drug) {
  if (!drug) return null;
  const q = drug.trim().replace(/"/g, "");
  // Match generic OR brand; prefer the most recently updated label.
  const search = `(openfda.generic_name:"${q}"+OR+openfda.brand_name:"${q}")`;
  const url = `${OPENFDA_URL}?search=${encodeURIComponent(search).replace(/%2B/g, "+")}&sort=effective_time:desc&limit=5`;

  let res;
  try {
    res = await timedFetch(url);
  } catch (e) {
    console.warn(`openFDA fetch failed for "${drug}": ${e.message}`);
    return null;
  }
  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const results = (data && data.results) || [];
  if (results.length === 0) return null;

  // Prefer a single-ingredient product over combination labels.
  const ranked = results.slice().sort((a, b) => {
    const score = (r) => {
      const g = ((r.openfda || {}).generic_name || []).join(", ").toLowerCase();
      let s = 0;
      if (g && g.split(/,| and /).length === 1) s += 2; // single ingredient
      if (g.includes(q.toLowerCase())) s += 1;
      return s;
    };
    return score(b) - score(a);
  });
  const r = ranked[0];

  const dosage = cleanSection(r.dosage_and_administration);
  const boxed = cleanSection(r.boxed_warning);
  const warn = cleanSection(r.warnings_and_cautions || r.warnings);
  const warnings = [
    boxed ? `BOXED WARNING — ${boxed}` : "",
    warn,
  ].filter(Boolean).join("\n\n");
  const adverse = cleanSection(r.adverse_reactions);
  const indications = cleanSection(r.indications_and_usage);
  const contraindications = cleanSection(r.contraindications);

  if (!dosage && !warnings && !adverse && !indications && !contraindications) return null;

  const setId = (r.openfda && r.openfda.spl_set_id && r.openfda.spl_set_id[0]) || "";
  const brand = (r.openfda && r.openfda.brand_name && r.openfda.brand_name[0]) || "";
  const generic = (r.openfda && r.openfda.generic_name && r.openfda.generic_name[0]) || q;

  return {
    region: "US",
    authority: "FDA Prescribing Information",
    productName: brand ? `${brand} (${generic})` : generic,
    indications: indications || null,
    dosage: dosage || null,
    contraindications: contraindications || null,
    warnings: warnings || null,
    adverse: adverse || null,
    updated: formatFdaDate(r.effective_time),
    sourceUrl: setId
      ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`
      : "https://dailymed.nlm.nih.gov/dailymed/",
    sourceLabel: "DailyMed (U.S. National Library of Medicine)",
  };
}

/* --------------------------- UK/EU: eMC ---------------------------- */

async function searchEmc(drug) {
  const url = `${EMC_BASE}/emc/search?${new URLSearchParams({ q: drug })}`;
  const res = await timedFetch(url);
  if (!res.ok) return [];
  const html = await res.text();
  const $ = cheerio.load(html);
  const out = [];
  $("a[href*='/emc/product/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/emc\/product\/(\d+)\/smpc/);
    if (!m) return;
    const name = $(el).text().trim();
    if (!name || name.toLowerCase().includes("health professional")) return;
    if (out.some((r) => r.product_id === m[1])) return;
    out.push({ product_id: m[1], name });
  });
  return out;
}

// SmPC section number -> the field we store it under
const SMPC_WANT = {
  "4.1": "indications",
  "4.2": "dosage",
  "4.3": "contraindications",
  "4.4": "warnings",
  "4.8": "adverse",
};

// Canonical SmPC section titles — used as a fallback heading detector
const SMPC_SECTION_NAMES = {
  "4.1": "Therapeutic indications",
  "4.2": "Posology and method of administration",
  "4.3": "Contraindications",
  "4.4": "Special warnings and precautions for use",
  "4.5": "Interaction with other medicinal products",
  "4.6": "Fertility, pregnancy and lactation",
  "4.7": "Effects on ability to drive and use machines",
  "4.8": "Undesirable effects",
  "4.9": "Overdose",
  "5.1": "Pharmacodynamic properties",
  "5.2": "Pharmacokinetic properties",
  "5.3": "Preclinical safety data",
};

function htmlToText(html) {
  const $ = cheerio.load(html);
  $("br").replaceWith("\n");
  $("li").each((_, el) => {
    $(el).prepend("- ");
    $(el).append("\n");
  });
  $("p, div, tr, h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).append("\n");
  });
  return $.text().replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parse the wanted SmPC sections from eMC HTML. Ported verbatim from the
 * PubCrawl get_smpc parser (proven against current medicines.org.uk markup):
 * detect numbered headings, then collect sibling content up to the next
 * heading, with a parent-text fallback. Returns a { field: content } map.
 */
function parseSmpcSections(html) {
  const $ = cheerio.load(html);
  const sectionElements = [];

  // Strategy 1: headings whose text starts with a section number
  $("[id*='SECTION'], [id*='section'], .sectionHeading, h2, h3, h4").each((_, el) => {
    const text = $(el).text().trim();
    const match = text.match(/^(\d+\.?\d*)\s+(.+)/);
    if (match) {
      sectionElements.push({ code: match[1], title: match[2].trim(), element: $(el) });
    }
  });

  // Strategy 2: fall back to scanning leaf nodes for known section headers
  if (sectionElements.length === 0) {
    $("*").each((_, el) => {
      const $el = $(el);
      if ($el.children().length > 0 && !$el.is("a, span, strong, em, b, i")) return;
      const text = $el.text().trim();
      const match = text.match(/^(\d+\.?\d*)\s+(.+)/);
      if (match && SMPC_SECTION_NAMES[match[1]]) {
        sectionElements.push({ code: match[1], title: match[2].trim(), element: $el });
      }
    });
  }

  const fields = {};
  for (let i = 0; i < sectionElements.length; i++) {
    const current = sectionElements[i];
    const field = SMPC_WANT[current.code];
    if (!field) continue; // not a section we display
    const next = sectionElements[i + 1];

    // Collect sibling content between this heading and the next heading
    let content = "";
    let node = current.element.next();
    while (node.length > 0) {
      if (next && node.is(next.element)) break;
      const nodeHtml = $.html(node);
      if (nodeHtml) content += htmlToText(nodeHtml) + "\n";
      node = node.next();
    }

    // Fallback: pull from the parent and strip the heading text
    if (!content.trim()) {
      const parentHtml = $.html(current.element.parent());
      if (parentHtml) {
        content = htmlToText(parentHtml).replace(current.element.text().trim(), "").trim();
      }
    }

    fields[field] = cleanSection(content);
  }
  return fields;
}

async function getSmpc(drug) {
  if (!drug) return null;
  try {
    const matches = await searchEmc(drug);
    if (matches.length === 0) return null;

    const q = drug.toLowerCase();
    matches.sort(
      (a, b) =>
        (b.name.toLowerCase().includes(q) ? 1 : 0) -
        (a.name.toLowerCase().includes(q) ? 1 : 0)
    );
    const best = matches[0];

    const res = await timedFetch(`${EMC_BASE}/emc/product/${best.product_id}/smpc`);
    if (!res.ok) return null;
    const html = await res.text();
    const sec = parseSmpcSections(html);

    const found = Object.keys(sec).filter((k) => sec[k]);
    console.log(`SmPC "${drug}" -> product ${best.product_id}, sections parsed: [${found.join(", ")}]`);

    if (!sec.dosage && !sec.warnings && !sec.adverse && !sec.indications && !sec.contraindications)
      return null;
    return {
      region: "UK/EU",
      authority: "Summary of Product Characteristics (SmPC)",
      productName: best.name,
      indications: sec.indications || null,
      dosage: sec.dosage || null,
      contraindications: sec.contraindications || null,
      warnings: sec.warnings || null,
      adverse: sec.adverse || null,
      updated: "",
      sourceUrl: `${EMC_BASE}/emc/product/${best.product_id}/smpc`,
      sourceLabel: "electronic medicines compendium (emc), UK",
    };
  } catch (e) {
    console.warn(`eMC fetch failed for "${drug}": ${e.message}`);
    return null;
  }
}

/* --------------------------- public API ---------------------------- */

/**
 * Look up both labels for a drug. Returns { us, uk } where each is a
 * sourced-label object or null. Never throws.
 */
async function getLabels(drug) {
  const [us, uk] = await Promise.all([
    getUspi(drug).catch(() => null),
    getSmpc(drug).catch(() => null),
  ]);
  return { us, uk };
}

module.exports = { getLabels, getUspi, getSmpc, cleanSection, formatFdaDate };
