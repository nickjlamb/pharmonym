/**
 * resolveName.js — Deterministic brand <-> generic resolution.
 *
 * Replaces the LLM for the core name conversion using authoritative,
 * free sources (no API key required):
 *   - RxNorm / RxNav (NLM)  — name -> RxCUI, term type, related brand/generic,
 *                             drug class (EPC/MOA) and may_treat indications.
 *   - openFDA (FDA)         — fallback brand/generic mapping when RxNorm misses.
 *
 * Returns the same field names the frontend already consumes so it can be a
 * drop-in for the OpenAI conversion call:
 *   { inputType, inputName, genericName, brandNames, drugClass, uses,
 *     rxcui, source, regionNote }
 *
 * Note: RxNorm/openFDA brand names are US (and the international non-proprietary
 * generic name). International brand names are intentionally NOT invented — the
 * old LLM did, and that was the least reliable part of the output.
 */

const fetch = require("node-fetch");

const RXNAV = "https://rxnav.nlm.nih.gov/REST";
const OPENFDA = "https://api.fda.gov/drug/label.json";
const TIMEOUT_MS = 10000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const titleCase = (s) =>
  String(s || "").replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/* ----------------------- RxNorm resolution ----------------------- */

async function findRxcui(name) {
  // 1) exact name match
  const exact = await getJson(`${RXNAV}/rxcui.json?name=${encodeURIComponent(name)}`);
  const id = exact && exact.idGroup && exact.idGroup.rxnormId && exact.idGroup.rxnormId[0];
  if (id) return id;

  // 2) approximate match (handles misspellings / salt forms)
  const approx = await getJson(
    `${RXNAV}/approximateTerm.json?term=${encodeURIComponent(name)}&maxEntries=1`
  );
  const cand =
    approx &&
    approx.approximateGroup &&
    approx.approximateGroup.candidate &&
    approx.approximateGroup.candidate[0];
  return cand ? cand.rxcui : null;
}

function collectNames(allRelated, tty) {
  const groups =
    (allRelated &&
      allRelated.allRelatedGroup &&
      allRelated.allRelatedGroup.conceptGroup) ||
    [];
  const g = groups.find((x) => x.tty === tty);
  if (!g || !g.conceptProperties) return [];
  return g.conceptProperties.map((c) => c.name);
}

/**
 * Single-ingredient brand names for a generic ingredient.
 * Uses SBDF concepts whose name is "<ingredient> <dose form> [Brand]";
 * combination products read "<ing A> / <ing B> ... [Brand]", so any name
 * with a "/" before the bracket is excluded. One API call.
 */
async function getSingleIngredientBrands(ingredientRxcui) {
  const data = await getJson(`${RXNAV}/rxcui/${ingredientRxcui}/related.json?tty=SBDF`);
  const groups = (data && data.relatedGroup && data.relatedGroup.conceptGroup) || [];
  const g = groups.find((x) => x.tty === "SBDF");
  if (!g || !g.conceptProperties) return [];
  const brands = [];
  for (const c of g.conceptProperties) {
    const m = c.name.match(/\[([^\]]+)\]\s*$/);
    if (!m) continue;
    const prefix = c.name.slice(0, c.name.lastIndexOf("["));
    if (prefix.includes("/")) continue; // combination product — skip
    brands.push(m[1].trim());
  }
  return uniq(brands).sort();
}

async function getDrugClassAndUses(rxcui) {
  const data = await getJson(
    `${RXNAV}/rxclass/class/byRxcui.json?rxcui=${rxcui}&relaSource=MEDRT`
  );
  const items =
    (data &&
      data.rxclassDrugInfoList &&
      data.rxclassDrugInfoList.rxclassDrugInfo) ||
    [];

  let cls = null;
  const byType = (t) => {
    const hit = items.find((i) => i.rxclassMinConceptItem.classType === t);
    return hit ? hit.rxclassMinConceptItem.className : null;
  };
  // Prefer FDA Established Pharmacologic Class, then mechanism of action.
  cls = byType("EPC") || byType("MOA") || byType("CHEM");

  const uses = uniq(
    items
      .filter((i) => i.rela === "may_treat")
      .map((i) => i.rxclassMinConceptItem.className)
  ).slice(0, 6);

  return { drugClass: cls, uses };
}

async function resolveViaRxNorm(name) {
  const rxcui = await findRxcui(name);
  if (!rxcui) return null;

  const [props, allRelated] = await Promise.all([
    getJson(`${RXNAV}/rxcui/${rxcui}/properties.json`),
    getJson(`${RXNAV}/rxcui/${rxcui}/allrelated.json`),
  ]);

  const tty = props && props.properties && props.properties.tty;
  const canonicalName = (props && props.properties && props.properties.name) || name;
  if (!tty) return null;

  const inNames = collectNames(allRelated, "IN");
  const minNames = collectNames(allRelated, "MIN"); // canonical combo string

  // Term type tells us definitively what the user typed.
  const isBrand = tty === "BN" || tty === "SBD" || tty === "BPCK";
  const inputType = isBrand ? "brand" : "generic";

  // For a generic, list only brands where it is the sole active ingredient;
  // fall back to the full (combo-inclusive) brand list if the filter is empty.
  let brandNames = null;
  if (!isBrand) {
    const single = await getSingleIngredientBrands(rxcui);
    const fallback = uniq([
      ...collectNames(allRelated, "BN"),
      ...collectNames(allRelated, "BPCK"),
    ]).sort();
    brandNames = single.length ? single : fallback;
  }

  // Generic display name: prefer the canonical multi-ingredient string for
  // combinations (e.g. "amoxicillin / clavulanate"); else the single
  // ingredient; else a joined list as a last resort.
  let genericName = null;
  if (minNames.length) genericName = titleCase(minNames[0]);
  else if (inNames.length === 1) genericName = titleCase(inNames[0]);
  else if (inNames.length > 1) genericName = titleCase(uniq(inNames).join(" / "));

  // Drug class + indications from the ingredient rxcui where possible.
  const classRxcui =
    !isBrand
      ? rxcui
      : (() => {
          const inGroup =
            (allRelated.allRelatedGroup.conceptGroup || []).find((x) => x.tty === "IN");
          return inGroup && inGroup.conceptProperties && inGroup.conceptProperties[0]
            ? inGroup.conceptProperties[0].rxcui
            : rxcui;
        })();
  const { drugClass, uses } = await getDrugClassAndUses(classRxcui);

  return {
    inputType,
    inputName: titleCase(canonicalName),
    genericName,
    brandNames,
    drugClass,
    uses,
    rxcui,
    source: "RxNorm (NLM)",
    regionNote: "Brand names shown are those registered in the United States.",
  };
}

/* ----------------------- openFDA fallback ------------------------ */

async function resolveViaOpenFda(name) {
  const q = name.replace(/"/g, "");
  const search = `(openfda.brand_name:"${q}"+OR+openfda.generic_name:"${q}")`;
  const url = `${OPENFDA}?search=${encodeURIComponent(search).replace(/%2B/g, "+")}&limit=1`;
  const data = await getJson(url);
  const r = data && data.results && data.results[0];
  const fda = r && r.openfda;
  if (!fda) return null;

  const brand = (fda.brand_name || [])[0] || "";
  const generic = (fda.generic_name || [])[0] || "";
  if (!brand && !generic) return null;

  const isBrand = brand.toLowerCase() === name.toLowerCase();
  return {
    inputType: isBrand ? "brand" : "generic",
    inputName: titleCase(name),
    genericName: generic ? titleCase(generic) : null,
    brandNames: isBrand ? null : uniq(fda.brand_name || []).sort(),
    drugClass: (fda.pharm_class_epc || [])[0] || (fda.pharm_class_moa || [])[0] || null,
    uses: [],
    rxcui: null,
    source: "openFDA",
    regionNote: "Brand names shown are those registered in the United States.",
  };
}

/* --------------------------- public ----------------------------- */

/**
 * Resolve a drug name deterministically. Tries RxNorm, then openFDA.
 * Returns null if neither source recognises the name (caller can then
 * fall back to the LLM).
 */
async function resolveName(name) {
  if (!name || !name.trim()) return null;
  const clean = name.trim();
  const viaRx = await resolveViaRxNorm(clean).catch(() => null);
  if (viaRx && (viaRx.genericName || (viaRx.brandNames && viaRx.brandNames.length))) {
    return viaRx;
  }
  return await resolveViaOpenFda(clean).catch(() => null);
}

module.exports = { resolveName, resolveViaRxNorm, resolveViaOpenFda };
