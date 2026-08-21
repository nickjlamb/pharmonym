/**
 * Moved to the shared engine: @pharmatools/drug-data
 *
 * The label-fetching logic (openFDA USPI + eMC SmPC) now lives in that package
 * so Pharmonym and PubCrawl share one implementation. This file is kept only as
 * a thin re-export shim; import from "@pharmatools/drug-data" directly in new code.
 */
const { getLabels, getUspi, getSmpc, cleanSection } = require("@pharmatools/drug-data");

module.exports = { getLabels, getUspi, getSmpc, cleanSection };
