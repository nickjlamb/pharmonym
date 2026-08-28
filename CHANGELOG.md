# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-08-28

### Added
- MIT license — Pharmonym is now open source.
- Shared drug-data engine: name resolution and label fetching moved to
  [`@pharmatools/drug-data`](https://www.npmjs.com/package/@pharmatools/drug-data),
  the same open-source engine that powers PubCrawl.
- Per-IP rate limiting on uncached requests (30/hour, fail-open).
- CORS origin allowlist for browser calls.
- Differentiated cache TTLs: label-bearing results cache for 30 days; label-less
  results expire after 1 day so transient upstream failures self-heal.
- CI (ESLint) via GitHub Actions; project documentation (README, contributing
  guide, changelog).

### Changed
- `convertDrugName` hardened: input validation, method checks, bounded
  `maxInstances`.
- ESLint configuration aligned with the project's actual style (double quotes,
  spaced braces, 120-char lines); codebase auto-fixed to match.

## [1.0.0] — 2026-06-14

### Added
- Initial release: brand ⇄ generic conversion via RxNorm/RxNav with openFDA
  fallback — deterministic first, AI only as a clearly-flagged last resort.
- Official label data: dosage, warnings, contraindications and adverse
  reactions from the US FDA label (openFDA, cited to DailyMed) and the UK/EU
  SmPC (eMC).
- Grounded AI summaries: "at a glance" lines and key US-vs-UK differences,
  condensed strictly from supplied label text.
- Firestore response cache; scheduled daily cache cleanup; admin cache-clear
  endpoint.
- Embeddable front-end widget (`pharmonym.html`), live at
  [pharmatools.ai/pharmonym](https://www.pharmatools.ai/pharmonym).

[Unreleased]: https://github.com/nickjlamb/pharmonym/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/nickjlamb/pharmonym/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/nickjlamb/pharmonym/releases/tag/v1.0.0
