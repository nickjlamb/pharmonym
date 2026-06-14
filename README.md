# Pharmonym

Brand ⇄ generic drug-name converter, with uses, dosage, side effects and
warnings sourced from official prescribing information, plain-English AI
summaries, and a side-by-side US vs UK/EU label comparison.

Part of [PharmaTools.AI](https://www.pharmatools.ai). Live at
[pharmatools.ai/pharmonym](https://www.pharmatools.ai/pharmonym).

## How it works

The tool favours authoritative, deterministic data and uses AI only to
summarise that data — never to generate clinical facts.

1. **Name resolution** (`functions/resolveName.js`) — brand⇄generic conversion,
   drug class and indications via **RxNorm/RxNav**, with **openFDA** as a
   fallback. No AI; no hallucinated names.
2. **Label data** (`functions/labels.js`) — dosage, warnings, contraindications,
   indications and adverse reactions pulled from the **US FDA label** (openFDA,
   cited to DailyMed) and the **UK/EU SmPC** (eMC / medicines.org.uk).
3. **Grounded summaries** (`functions/summarise.js`) — one model call condenses
   the official label text into "at a glance" lines and a list of key US-vs-UK
   differences. Instructed to summarise only from the supplied text.
4. **Fallback** — only when neither RxNorm nor openFDA recognises a name does the
   original OpenAI conversion run (`callOpenAi` in `functions/index.js`), clearly
   flagged as AI-generated in the UI.

Results are cached in Firestore for 30 days.

## Project layout

```
functions/
  index.js         Cloud Functions entry (convertDrugName, clearCache, cache cleanup)
  resolveName.js   Deterministic RxNorm/openFDA name resolution
  labels.js        FDA (openFDA/DailyMed) + UK SmPC (eMC) label fetch & parse
  summarise.js     Grounded AI summaries (at-a-glance + US/UK differences)
pharmonym.html        Front-end widget (embedded in Webflow)
pharmonym-jsonld.html JSON-LD structured data for the page
firebase.json, .firebaserc
```

## Data sources

- [RxNorm / RxNav](https://rxnav.nlm.nih.gov/) — name mapping, drug class, indications
- [openFDA](https://open.fda.gov/) — US labels
- [DailyMed](https://dailymed.nlm.nih.gov/) — US label citations
- [eMC (medicines.org.uk)](https://www.medicines.org.uk/) — UK/EU SmPC

## Develop & deploy

```bash
cd functions
npm install

# Secrets (Cloud Secret Manager) — required for the OpenAI fallback/summaries
firebase functions:secrets:set OPENAI_KEY
firebase functions:secrets:set ADMIN_KEY

firebase deploy --only functions
```

The front end (`pharmonym.html`) is a self-contained embed; update it in Webflow.

## Disclaimer

"At a glance" summaries are AI-generated from official prescribing information
and are not a substitute for professional medical advice. Always verify against
the full prescribing information.
