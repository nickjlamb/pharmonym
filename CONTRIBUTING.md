# Contributing to Pharmonym

Thanks for your interest in improving Pharmonym! Contributions of all kinds are welcome — bug reports, parser fixes, new data sources, docs.

## Ground rules

Pharmonym is a medical-adjacent tool, so one principle overrides everything else:

> **AI never generates clinical facts.** Drug names, dosage, warnings and side effects come from authoritative sources (RxNorm, openFDA, DailyMed, eMC). The model is only ever asked to *summarise text we hand it*. Any PR that has the model inventing clinical content will be declined.

Practical consequences:

- Changes to label parsing (`@pharmatools/drug-data`, or the enrichment in `functions/index.js`) should include before/after sample output for at least two drugs, with source links.
- Prefer deterministic fixes over prompt fixes.
- New data sources must be official/regulatory (or clearly flagged otherwise).

## Development setup

```bash
git clone https://github.com/nickjlamb/pharmonym.git
cd pharmonym/functions
npm install
```

Run the function locally with the Firebase emulator:

```bash
npx firebase-tools emulators:start --only functions
```

Secrets are **never** committed. The OpenAI fallback and summaries read `OPENAI_KEY` from Cloud Secret Manager in production; locally, put it in `functions/.secret.local` (gitignored). Everything deterministic — name resolution and label fetch — works without any keys.

## Code style

ESLint (Google config, adapted to project style) is the source of truth:

```bash
cd functions
npm run lint
```

CI runs the same check on every push and PR — a green lint is required to merge. Conventions worth knowing: double quotes, spaced braces `{ like: this }`, 120-char lines (strings exempt).

## Submitting changes

1. Fork and create a topic branch (`fix/emc-parser-sections`, `feat/health-canada-labels`).
2. Keep commits focused; write messages in the imperative ("Fix SmPC section mapping").
3. Open a PR describing **what** and **why**, with sample output for behaviour changes.
4. One approval + green CI merges.

## Reporting issues

- **Bugs / incorrect drug data**: open a GitHub issue with the drug name, what Pharmonym showed, and what the official label says (with a link).
- **Security issues**: please use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") rather than a public issue.

## Related projects

- [`@pharmatools/drug-data`](https://www.npmjs.com/package/@pharmatools/drug-data) — the shared resolution/label engine (much of the interesting logic lives there)
- [PubCrawl](https://www.pharmatools.ai/pubcrawl) — MCP server for biomedical literature, labels and trials, built on the same engine
