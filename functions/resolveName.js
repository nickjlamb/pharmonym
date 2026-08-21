/**
 * Moved to the shared engine: @pharmatools/drug-data
 *
 * The deterministic RxNorm/openFDA name resolution now lives in that package so
 * Pharmonym and PubCrawl share one implementation. This file is kept only as a
 * thin re-export shim; import from "@pharmatools/drug-data" directly in new code.
 */
const { resolveName } = require("@pharmatools/drug-data");

module.exports = { resolveName };
