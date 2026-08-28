const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const fetch = require("node-fetch");

// === Abuse protection ===
// Only these origins may call the public endpoint from a browser. Add any
// domain that hosts pharmonym.html here.
const ALLOWED_ORIGINS = [
  "https://pharmatools.ai",
  "https://www.pharmatools.ai",
  "http://localhost:5000",
  "http://127.0.0.1:5000",
];
const cors = require("cors")({
  origin: (origin, cb) => {
    // Same-origin / non-browser requests have no Origin header; they are
    // still subject to the input validation + rate limit below.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed"), false);
  },
  methods: ["POST", "OPTIONS"],
});

// Drug names are short and use a small character set. Anything else is
// rejected before it can reach OpenAI.
const MAX_NAME_LENGTH = 60;
const NAME_PATTERN = /^[a-z0-9][a-z0-9 .,'()/+-]*$/i;
function isPlausibleDrugName(name) {
  return (
    typeof name === "string" &&
    name.trim().length >= 2 &&
    name.trim().length <= MAX_NAME_LENGTH &&
    NAME_PATTERN.test(name.trim())
  );
}

// Per-IP rate limit, tracked in Firestore so it works across instances.
// Only counts requests that get past the cache (i.e. could cost money).
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 30; // uncached requests per IP per window
const MAX_INSTANCES = 3; // caps how far a flood can fan out
// Name resolution + official labels now come from the shared engine.
const { getLabels, resolveName } = require("@pharmatools/drug-data");
const { summariseLabels } = require("./summarise");

// Secrets (Cloud Secret Manager) — replaces the deprecated functions.config().
// Set values with:  firebase functions:secrets:set OPENAI_KEY
//                    firebase functions:secrets:set ADMIN_KEY
const OPENAI_KEY = defineSecret("OPENAI_KEY");
const ADMIN_KEY = defineSecret("ADMIN_KEY");

const admin = require("firebase-admin");
admin.initializeApp();

// Initialize Firestore
const db = admin.firestore();
const drugsCollection = db.collection("drugs");
const rateLimitCollection = db.collection("rateLimits");

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.ip || "unknown";
  return ip.replace(/[^a-zA-Z0-9.:]/g, "_");
}

/**
 * Returns true if this IP is still within its hourly budget of uncached
 * requests, and records the hit. Fails open on Firestore errors so a
 * Firestore blip never takes the service down.
 */
async function checkRateLimit(ip) {
  try {
    const ref = rateLimitCollection.doc(ip);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      let { count = 0, windowStart = now } = snap.exists ? snap.data() : {};
      if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
        count = 0;
        windowStart = now;
      }
      if (count >= RATE_LIMIT_MAX) return false;
      tx.set(ref, { count: count + 1, windowStart, updatedAt: new Date() });
      return true;
    });
  } catch (err) {
    console.error("Rate limit check error:", err);
    return true;
  }
}

// Cache settings
const CACHE_EXPIRY_DAYS = 30; // Successful, label-bearing results
const EMPTY_CACHE_EXPIRY_DAYS = 1; // Results with no label data: re-validate
// soon so a transient upstream (openFDA/eMC) failure doesn't stick for 30 days.
const shouldUseCache = true; // Enable/disable cache (for testing)

/**
 * Whether a cached/produced response actually carries official label data.
 * Label-less results get a short TTL so transient label-fetch failures self-heal.
 */
function responseHasLabels(data) {
  try {
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== "string") return false;
    const parsed = JSON.parse(content);
    return Boolean(parsed && parsed.labels && (parsed.labels.us || parsed.labels.uk));
  } catch {
    return false;
  }
}

/**
 * Mutates the OpenAI response object in place: parses the JSON the model
 * returned, looks up the official US (FDA) and UK/EU (SmPC) labels for the
 * drug, and attaches a `labels` block plus sourced dosage/warnings.
 *
 * The frontend reads data.choices[0].message.content and JSON.parses it,
 * so we merge into that same string to preserve the existing contract.
 */
async function enrichWithLabels(data) {
  const msg =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message;
  if (!msg || typeof msg.content !== "string") return;

  let parsed;
  try {
    parsed = JSON.parse(msg.content.trim());
  } catch {
    return; // model didn't return clean JSON; leave as-is
  }

  // Best query term for label lookup: the generic (international
  // non-proprietary) name is how labels are indexed.
  //
  // NOTE: resolveName() can return a multi-ingredient COMBINATION (e.g.
  // "Atorvastatin / Ezetimibe") for a single-ingredient generic, because the
  // RxNorm resolver prefers MIN (multiple-ingredient) concepts. A combination
  // string has no single-drug FDA/UK label and 404s, yielding empty labels.
  // So: prefer a clean single-ingredient term, and if the first lookup finds
  // nothing, retry with the raw input name.
  const looksCombo = (s) => typeof s === "string" && s.includes("/");
  const primaryTerm =
    (parsed.genericName && !looksCombo(parsed.genericName) ? parsed.genericName : null) ||
    parsed.inputName ||
    parsed.genericName;
  if (!primaryTerm) return;

  let labels = await getLabels(primaryTerm);
  if (!labels.us && !labels.uk) {
    const altTerm = [parsed.inputName, parsed.genericName].find(
      (t) => t && t !== primaryTerm && !looksCombo(t),
    );
    if (altTerm) labels = await getLabels(altTerm);
  }
  parsed.labels = labels;
  // Both regional labels present -> US-vs-UK side-by-side comparison is possible.
  parsed.canCompare = Boolean(labels.us && labels.uk);

  // Preserve the model's text as a clearly-labelled fallback, then prefer
  // the sourced label text for the primary dosage/warnings fields.
  const us = labels.us;
  const uk = labels.uk;

  if (us || uk) {
    parsed.dosageAI = parsed.dosage || null;
    parsed.warningsAI = parsed.warnings || null;
    parsed.dosageSourced = Boolean((us && us.dosage) || (uk && uk.dosage));
    parsed.warningsSourced = Boolean((us && us.warnings) || (uk && uk.warnings));
    parsed.sideEffectsSourced = Boolean((us && us.adverse) || (uk && uk.adverse));
  } else {
    parsed.dosageSourced = false;
    parsed.warningsSourced = false;
    parsed.sideEffectsSourced = false;
  }

  msg.content = JSON.stringify(parsed);
}

/**
 * Add grounded AI summaries (at-a-glance fields + US/UK differences) to a
 * result that already carries label data. Best-effort: never breaks output.
 */
async function addSummaries(data, apiKey) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg || typeof msg.content !== "string") return;

  let parsed;
  try {
    parsed = JSON.parse(msg.content.trim());
  } catch {
    return;
  }
  if (!parsed.labels || (!parsed.labels.us && !parsed.labels.uk)) return;

  const summary = await summariseLabels(parsed, apiKey);
  if (!summary) return;

  parsed.summary = summary;
  msg.content = JSON.stringify(parsed);
}

/**
 * Build the response envelope the frontend expects
 * ({ choices: [{ message: { content: "<json string>" } }] }).
 *
 * Primary path: deterministic brand<->generic resolution via RxNorm/openFDA
 * (accurate, free, no hallucination). Fallback: the OpenAI model, only when
 * neither authoritative source recognises the drug name.
 */
async function buildConversion(name) {
  const resolved = await resolveName(name).catch((e) => {
    console.warn(`Deterministic resolver error for "${name}": ${e.message}`);
    return null;
  });

  const hasResult =
    resolved &&
    (resolved.genericName || (resolved.brandNames && resolved.brandNames.length));

  if (hasResult) {
    console.log(`Resolved "${name}" deterministically via ${resolved.source}`);
    const parsed = {
      inputType: resolved.inputType,
      inputName: resolved.inputName,
      genericName: resolved.genericName || null,
      brandNames:
        resolved.brandNames && resolved.brandNames.length ? resolved.brandNames : null,
      drugClass: resolved.drugClass || null,
      uses: resolved.uses && resolved.uses.length ? resolved.uses : null,
      source: resolved.source,
      regionNote: resolved.regionNote,
    };
    return {
      choices: [{ message: { content: JSON.stringify(parsed) } }],
      _source: "deterministic",
    };
  }

  console.log(`No authoritative match for "${name}" — falling back to OpenAI`);
  return await callOpenAi(name);
}

function buildOpenAiPrompt(name) {
  return `Convert the following drug name: ${name}.
If it's a brand name, give the generic name. If it's a generic name, give common brand names in different countries.
Also provide the following information:
- Drug class and category
- Common uses and indications
- Typical dosage ranges
- Common side effects (mild and serious)
- Important warnings or precautions

Present results as JSON with the following structure:
{
  "inputType": "brand" or "generic",
  "inputName": "the exact input name",
  "genericName": "generic name",
  "brandNames": ["list", "of", "brand", "names", "by", "country"],
  "drugClass": "drug classification",
  "category": "pharmacological category",
  "uses": ["list", "of", "common", "uses"],
  "dosage": "typical dosage information",
  "sideEffects": {
    "mild": ["list", "of", "mild", "side", "effects"],
    "serious": ["list", "of", "serious", "side", "effects"]
  },
  "warnings": ["list", "of", "important", "warnings"]
}`;
}

async function callOpenAi(name) {
  const apiKey = OPENAI_KEY.value();
  const url = "https://api.openai.com/v1/chat/completions";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: buildOpenAiPrompt(name) }],
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  data._source = "openai";
  return data;
}

exports.convertDrugName = functions
  .runWith({ secrets: [OPENAI_KEY], maxInstances: MAX_INSTANCES })
  .https.onRequest((req, res) => {
  cors(req, res, async (corsErr) => {
    if (corsErr) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const name = req.body && req.body.name;

    if (!name) {
      return res.status(400).json({ error: "Drug name is required" });
    }
    if (!isPlausibleDrugName(name)) {
      return res.status(400).json({ error: "Invalid drug name" });
    }

    // Normalize drug name for consistent caching (lowercase, trim whitespace)
    const normalizedName = name.trim().toLowerCase();

    // Check cache first if enabled
    if (shouldUseCache) {
      try {
        // Get current time for cache expiration check
        const now = new Date();

        // Create a unique document ID based on the normalized drug name
        const drugDocId = normalizedName.replace(/[^a-z0-9]/g, "");
        const drugDoc = drugsCollection.doc(drugDocId);

        // Try to get the document from Firestore
        const snapshot = await drugDoc.get();

        // If document exists and is not expired, return cached result
        if (snapshot.exists) {
          const cachedData = snapshot.data();
          const createdAt = cachedData.createdAt.toDate();

          // Label-bearing results are stable (30 days); label-less results expire
          // quickly so transient upstream failures don't poison popular drugs.
          const ttlDays = responseHasLabels(cachedData.response)
            ? CACHE_EXPIRY_DAYS
            : EMPTY_CACHE_EXPIRY_DAYS;
          const expiryDate = new Date(createdAt);
          expiryDate.setDate(expiryDate.getDate() + ttlDays);

          if (expiryDate > now) {
            console.log(`Cache hit for: ${normalizedName}`);
            return res.json(cachedData.response);
          } else {
            console.log(`Cache expired for: ${normalizedName}`);
          }
        } else {
          console.log(`Cache miss for: ${normalizedName}`);
        }
      } catch (cacheError) {
        // Log cache errors but continue to API request
        console.error("Cache retrieval error:", cacheError);
      }
    }

    // Cache miss: this request can cost money, so enforce the per-IP limit.
    const ip = clientIp(req);
    if (!(await checkRateLimit(ip))) {
      console.warn(`Rate limit exceeded for ${ip}`);
      res.set("Retry-After", "3600");
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    // Produce the conversion (deterministic first, OpenAI fallback).
    let data;
    try {
      data = await buildConversion(name);
    } catch (error) {
      console.error("Error in conversion:", error);
      return res.status(500).json({ error: "Conversion failed", details: error.message });
    }

    // === Enrich with authoritative label data (USPI / SmPC) ===
    // Sourced dosage/warnings + citations. Best-effort: never breaks output.
    try {
      await enrichWithLabels(data);
    } catch (labelError) {
      console.error("Label enrichment error:", labelError);
    }

    // === Grounded AI summaries (at-a-glance + US/UK differences) ===
    try {
      await addSummaries(data, OPENAI_KEY.value());
    } catch (summaryError) {
      console.error("Summary step error:", summaryError);
    }

    // Store the result in cache if caching is enabled
    if (shouldUseCache) {
      try {
        const drugDocId = normalizedName.replace(/[^a-z0-9]/g, "");
        await drugsCollection.doc(drugDocId).set({
          query: normalizedName,
          response: data,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Cached result for: ${normalizedName}`);
      } catch (cacheError) {
        console.error("Cache storage error:", cacheError);
      }
    }

    res.json(data);
  });
});

// Function to clean up expired cache entries (runs daily)
exports.cleanupExpiredCache = functions.pubsub.schedule("every 24 hours").onRun(async (context) => {
  try {
    console.log("Running cache cleanup job");

    // Calculate the cutoff date for expired cache entries
    const now = new Date();
    const cutoffDate = new Date(now);
    cutoffDate.setDate(cutoffDate.getDate() - CACHE_EXPIRY_DAYS);

    // Query for documents older than the cutoff date
    const expiredDocs = await drugsCollection
      .where("createdAt", "<", cutoffDate)
      .get();

    // If no expired documents, we're done
    if (expiredDocs.empty) {
      console.log("No expired cache entries found");
      return null;
    }

    // Delete expired documents in batch
    const batch = db.batch();
    expiredDocs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`Deleted ${expiredDocs.size} expired cache entries`);
    return null;
  } catch (error) {
    console.error("Error cleaning up cache:", error);
    return null;
  }
});

// Admin function to manually clear the cache for a specific drug or all drugs
exports.clearCache = functions
  .runWith({ secrets: [ADMIN_KEY] })
  .https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Basic auth check - Using a simple API key check
    // In production, use a more robust authentication mechanism
    const apiKey = req.headers.authorization;
    if (apiKey !== `Bearer ${ADMIN_KEY.value()}`) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      const { drugName } = req.body;

      // If drugName provided, clear only that entry
      if (drugName) {
        const normalizedName = drugName.trim().toLowerCase();
        const drugDocId = normalizedName.replace(/[^a-z0-9]/g, "");
        const drugDoc = drugsCollection.doc(drugDocId);

        const doc = await drugDoc.get();
        if (doc.exists) {
          await drugDoc.delete();
          return res.json({
            success: true,
            message: `Cache cleared for ${drugName}`,
          });
        } else {
          return res.json({
            success: false,
            message: `No cache entry found for ${drugName}`,
          });
        }
      }

      // If no drugName provided, clear entire cache (with limit for safety)
      const batchSize = 100; // Maximum batch size for Firestore
      const snapshot = await drugsCollection.limit(batchSize).get();

      if (snapshot.empty) {
        return res.json({ success: true, message: "Cache is already empty" });
      }

      // Delete in batch for better performance
      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();

      return res.json({
        success: true,
        message: `Cleared ${snapshot.size} cache entries`,
      });
    } catch (error) {
      console.error("Error clearing cache:", error);
      return res.status(500).json({
        error: "Failed to clear cache",
        details: error.message,
      });
    }
  });
});
