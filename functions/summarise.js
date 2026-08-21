/**
 * summarise.js — Grounded AI summarisation of official label text.
 *
 * Takes the already-fetched US/UK label data and produces:
 *   - glance: short plain-English summaries of uses / dosage / side effects /
 *             warnings (restores the simplicity of the original tool)
 *   - differences: the key clinically-relevant US-vs-UK label differences
 *   - verdicts: per-topic same/differs flag (US vs UK)
 *   - indicationGap: indications approved US-only / UK-only / in both
 *
 * The model is instructed to summarise ONLY from the supplied label text and
 * add nothing — this is grounded summarisation, not fact generation. The full
 * verbatim label text and its citation remain available in the UI. Best-effort:
 * any failure returns null and the UI falls back to showing the full text.
 */

const fetch = require("node-fetch");

// Cheap, strong at instruction-following + JSON. Change here if desired.
const MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 15000;

function regionBlockText(label, lbl) {
  if (!lbl) return "";
  const parts = [];
  if (lbl.indications) parts.push(`INDICATIONS: ${lbl.indications}`);
  if (lbl.dosage) parts.push(`DOSAGE: ${lbl.dosage}`);
  if (lbl.contraindications) parts.push(`CONTRAINDICATIONS: ${lbl.contraindications}`);
  if (lbl.warnings) parts.push(`WARNINGS: ${lbl.warnings}`);
  if (lbl.adverse) parts.push(`ADVERSE REACTIONS: ${lbl.adverse}`);
  if (parts.length === 0) return "";
  return `=== ${label} ===\n${parts.join("\n\n")}`;
}

function buildPrompt(parsed) {
  const us = parsed.labels && parsed.labels.us;
  const uk = parsed.labels && parsed.labels.uk;
  const both = Boolean(us && uk);

  const sources = [regionBlockText("US FDA LABEL", us), regionBlockText("UK/EU SmPC", uk)]
    .filter(Boolean)
    .join("\n\n");

  const drug = parsed.genericName
    ? `${parsed.inputName} (${parsed.genericName})`
    : parsed.inputName;

  return `You are summarising OFFICIAL drug-label text for a quick-reference tool used by clinicians and patients.

STRICT RULES:
- Summarise ONLY from the label text provided below. Do NOT add any drug, dose, indication, side effect or risk that is not in the text.
- Plain English, very concise. No preamble.
- If the text for a field is absent, omit that key.

Drug: ${drug}

${sources}

Return a JSON object with this shape:
{
  "glance": {
    "uses": "<=20 words: what the drug is for",
    "dosage": "<=25 words: the typical adult dose, plain English",
    "sideEffects": "<=25 words: the most common side effects",
    "warnings": "<=30 words: the most important safety warnings"
  }${both ? `,
  "differences": ["up to 4 short bullets naming the most clinically relevant US-vs-UK label differences"],
  "indicationGap": { "usOnly": ["indications in the US label but not the UK SmPC"], "ukOnly": ["indications in the UK SmPC but not the US label"], "shared": ["indications approved in both"] },
  "verdicts": { "indications": "same|differs", "dosage": "same|differs", "contraindications": "same|differs", "warnings": "same|differs", "adverse": "same|differs" }` : ""}
}
Prefer the US label for the 'glance' fields when both are present.${both ? " 'differences' must contrast the two labels. For 'verdicts', mark a topic \"same\" when the two labels are materially equivalent (even if worded differently) and \"differs\" otherwise — only include topics where BOTH labels have text. Derive 'indicationGap' from the indications text of each label." : ""}`;
}

/**
 * Produce grounded summaries for a parsed result that already has labels.
 * Returns { glance, differences? } or null.
 */
async function summariseLabels(parsed, apiKey) {
  if (!apiKey) return null;
  const us = parsed.labels && parsed.labels.us;
  const uk = parsed.labels && parsed.labels.uk;
  if (!us && !uk) return null; // nothing authoritative to summarise

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(parsed) }],
      }),
    });
    if (!res.ok) {
      console.warn(`Summary model error ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message.content;
    if (!content) return null;
    const parsedOut = JSON.parse(content);
    // Basic shape guard
    const summary = {};
    if (parsedOut.glance && typeof parsedOut.glance === "object") summary.glance = parsedOut.glance;
    if (Array.isArray(parsedOut.differences) && parsedOut.differences.length) {
      summary.differences = parsedOut.differences.slice(0, 5).map(String);
    }
    if (parsedOut.indicationGap && typeof parsedOut.indicationGap === "object") {
      const g = parsedOut.indicationGap;
      summary.indicationGap = {
        usOnly: Array.isArray(g.usOnly) ? g.usOnly.map(String) : [],
        ukOnly: Array.isArray(g.ukOnly) ? g.ukOnly.map(String) : [],
        shared: Array.isArray(g.shared) ? g.shared.map(String) : [],
      };
    }
    if (parsedOut.verdicts && typeof parsedOut.verdicts === "object") summary.verdicts = parsedOut.verdicts;
    return summary.glance || summary.differences ? summary : null;
  } catch (e) {
    console.warn(`Summary generation failed: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { summariseLabels };
