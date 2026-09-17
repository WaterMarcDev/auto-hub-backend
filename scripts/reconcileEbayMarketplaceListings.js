/**
 * EBAY ↔ CRM MARKETPLACE LISTING — RECONCILE + VERIFY (OPERATOR SCRIPT)
 *
 * Run:
 *   node scripts/reconcileEbayMarketplaceListings.js                # reconcile for real
 *   node scripts/reconcileEbayMarketplaceListings.js --dry-run      # compute plan, write nothing
 *   node scripts/reconcileEbayMarketplaceListings.js --verify-only  # counts only, no eBay call
 *   node scripts/reconcileEbayMarketplaceListings.js --add-unique-index   # reconcile, then add unique index
 *   node scripts/reconcileEbayMarketplaceListings.js --page-size=100
 *
 * WHAT IT DOES
 *   1. Asks eBay for the seller's CURRENTLY ACTIVE listings (Trading API
 *      GetMyeBaySelling → ActiveList, fully paginated) via the same engine the
 *      app uses — services/ebay/ebayListingReconcile.service.js. No second
 *      sync implementation exists anywhere.
 *   2. Upserts them into the CRM Marketplace Listing collection keyed on the
 *      real eBay ItemID, scoped to the connected eBay account.
 *   3. Removes CRM eBay listing records that are no longer active — but ONLY
 *      when the eBay fetch provably completed (see the engine's safety model).
 *   4. Prints the exact verification counts and exits non-zero if the dataset
 *      is not clean, so it is usable in a deploy gate.
 *
 * SAFETY
 *   - Never connects to eBay in --verify-only mode.
 *   - Never deletes anything when the fetch is incomplete or empty.
 *   - The unique index is only added when explicitly requested, and a failure
 *     to add it is reported without touching any data or the running server.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing.model");
const {
  reconcileEbayListings,
  summarizeEbayMarketplaceListings,
} = require("../services/ebay/ebayListingReconcile.service");

const LOG_PREFIX = "[EBAY SYNC]";

const UNIQUE_INDEX_NAME = "uniq_ebay_account_listing";
const UNIQUE_INDEX_KEYS = {
  marketplace: 1,
  marketplaceAccountId: 1,
  marketplaceListingId: 1,
};
/**
 * Partial filter (NOT plain sparse): only eBay LISTING rows are constrained —
 * marketplace === "ebay" AND a real string listing id. Amazon rows, order-
 * shaped rows with no listing id, and unrelated records are entirely exempt,
 * so this index can never affect another marketplace.
 */
const UNIQUE_INDEX_OPTIONS = {
  unique: true,
  partialFilterExpression: {
    marketplace: "ebay",
    marketplaceListingId: { $type: "string" },
  },
};

function parseArgs(argv) {
  const args = { dryRun: false, verifyOnly: false, addUniqueIndex: false, pageSize: undefined };

  for (const raw of argv.slice(2)) {
    const arg = String(raw);
    if (arg === "--dry-run" || arg === "-n") args.dryRun = true;
    else if (arg === "--verify-only") args.verifyOnly = true;
    else if (arg === "--add-unique-index") args.addUniqueIndex = true;
    else if (arg.startsWith("--page-size=")) {
      const value = Number(arg.split("=")[1]);
      if (Number.isFinite(value) && value > 0) args.pageSize = Math.min(value, 200);
    } else if (arg === "--help" || arg === "-h") args.help = true;
  }

  return args;
}

function printHelp() {
  console.log(`
eBay ↔ CRM Marketplace Listing reconciliation

  --dry-run              Compute what would change; write nothing to the DB.
  --verify-only          Print CRM dataset counts only (no eBay API call).
  --add-unique-index     After reconciling, add the ebay+account+listingId
                         unique index. Safe to re-run; a duplicate-data error
                         is reported, never forced.
  --page-size=N          GetMyeBaySelling entries per page (1..200, default 200).
  --help                 Show this message.
`);
}

async function connect() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI (or MONGO_URI) is not set — check auto-hub-backend/.env");
  }

  await mongoose.connect(mongoUri);
  console.log(`${LOG_PREFIX} Connected to MongoDB database: ${mongoose.connection.db.databaseName}`);
}

/** Amazon (and every non-eBay) count is captured to prove non-regression. */
async function countOtherMarketplaces() {
  const [amazon, other] = await Promise.all([
    MarketplaceListing.countDocuments({ marketplace: "amazon" }),
    MarketplaceListing.countDocuments({ marketplace: { $nin: ["ebay", "amazon"] } }),
  ]);
  return { amazon, other };
}

/**
 * Print the verification report in the exact required format.
 *
 * @param {Object} params
 * @param {number|null} params.activeOnEbay
 * @param {Object} params.integrity
 * @param {Object} params.regression
 */
function printReport({ activeOnEbay, integrity, regression }) {
  const crmEbayListings = integrity.listingRecords;
  const missing = activeOnEbay == null ? "n/a (verify-only)" : Math.max(activeOnEbay - crmEbayListings, 0);
  const stale = activeOnEbay == null ? "n/a (verify-only)" : Math.max(crmEbayListings - activeOnEbay, 0);

  console.log("");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(" EBAY ↔ CRM MARKETPLACE LISTING VERIFICATION");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(` eBay Active Listings:             ${activeOnEbay == null ? "n/a (verify-only)" : activeOnEbay}`);
  console.log(` CRM eBay Marketplace Listings:    ${crmEbayListings}`);
  console.log(` Missing (active but not in CRM):  ${missing}`);
  console.log(` Stale (in CRM but not active):    ${stale}`);
  console.log(` Duplicate eBay Listing IDs:       ${integrity.duplicateGroups}`);
  console.log(` Missing/Invalid IDs:              ${integrity.missingListingId}`);
  console.log(` Unknown Status:                   ${integrity.unknownStatus}`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log(` Amazon records (must be unchanged): ${regression.amazon}`);
  console.log(` Other marketplace records:          ${regression.other}`);
  console.log(` Total eBay records in collection:   ${integrity.totalEbayRecords}`);
  console.log("──────────────────────────────────────────────────────────────");

  return { crmEbayListings, missing, stale };
}

/**
 * Add the scoped unique index. Never drops data; if index creation fails
 * because duplicates still exist, that is reported and the process exits
 * non-zero so the operator reconciles and retries.
 */
async function addUniqueIndex() {
  console.log(`${LOG_PREFIX} Ensuring unique index ${UNIQUE_INDEX_NAME} (eBay + account + listing id)...`);

  try {
    await MarketplaceListing.collection.createIndex(UNIQUE_INDEX_KEYS, {
      ...UNIQUE_INDEX_OPTIONS,
      name: UNIQUE_INDEX_NAME,
    });
    console.log(`${LOG_PREFIX} Unique index ${UNIQUE_INDEX_NAME} is in place.`);
    return true;
  } catch (err) {
    const code = err && (err.code || err.codeName);
    console.error(
      `${LOG_PREFIX} Could NOT create the unique index (${code || "unknown error"}): ${err.message || err}`
    );
    if (err && (err.code === 11000 || err.codeName === "DuplicateKey")) {
      console.error(
        `${LOG_PREFIX} Duplicate eBay listing rows still exist. Re-run without --add-unique-index (or with --dry-run) to inspect, resolve the duplicates, then retry. No data was modified.`
      );
    } else if (err && (err.code === 85 || err.codeName === "IndexOptionsConflict")) {
      console.error(
        `${LOG_PREFIX} An index with this name/keys already exists with different options. Inspect it with db.marketplaceleads.getIndexes() before changing anything. No data was modified.`
      );
    }
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  await connect();

  let activeOnEbay = null;
  let summary = null;

  if (!args.verifyOnly) {
    console.log(
      `${LOG_PREFIX} Reconciling${args.dryRun ? " (DRY RUN — no writes)" : ""} pageSize=${args.pageSize || 200}...`
    );

    summary = await reconcileEbayListings({
      dryRun: args.dryRun,
      pageSize: args.pageSize,
    });

    activeOnEbay = summary.activeOnEbay;

    console.log("");
    console.log(`${LOG_PREFIX} Reconciliation summary`);
    console.log(`${LOG_PREFIX}   Active on eBay:      ${summary.activeOnEbay}`);
    console.log(`${LOG_PREFIX}   eBay reported total: ${summary.ebayReportedTotal}`);
    console.log(`${LOG_PREFIX}   Pages fetched:       ${summary.pagesFetched}`);
    console.log(`${LOG_PREFIX}   Fetch complete:      ${summary.fetchComplete}`);
    if (!summary.fetchComplete) {
      console.log(`${LOG_PREFIX}   Fetch error:         ${summary.fetchError}`);
    }
    console.log(`${LOG_PREFIX}   Created:             ${summary.created}`);
    console.log(`${LOG_PREFIX}   Updated:             ${summary.updated}`);
    console.log(`${LOG_PREFIX}   Unchanged:           ${summary.unchanged}`);
    console.log(`${LOG_PREFIX}   Duplicates collapsed:${summary.duplicatesCollapsed}`);
    console.log(
      `${LOG_PREFIX}   Removed (stale):     ${summary.removed}${summary.staleRemovalSkipped ? " (SKIPPED — stale removal gate not satisfied)" : ""}`
    );
    console.log(`${LOG_PREFIX}   Duration:            ${summary.durationMs}ms`);
  } else {
    console.log(`${LOG_PREFIX} --verify-only: skipping the eBay fetch, reporting CRM counts.`);
  }

  const [integrity, regression] = await Promise.all([
    summarizeEbayMarketplaceListings(),
    countOtherMarketplaces(),
  ]);

  const { crmEbayListings, missing, stale } = printReport({
    activeOnEbay,
    integrity,
    regression,
  });

  let indexOk = true;
  if (args.addUniqueIndex && !args.dryRun) {
    indexOk = await addUniqueIndex();
  }

  await mongoose.disconnect();
  console.log(`${LOG_PREFIX} Disconnected.`);

  // ── Exit-code gate ────────────────────────────────────────────────────
  // verify-only can never assert a count match (it does not talk to eBay), so
  // it only fails on CRM-internal corruption (duplicate / missing ids).
  const clean =
    integrity.duplicateGroups === 0 &&
    integrity.missingListingId === 0 &&
    (args.verifyOnly ||
      (missing === 0 && stale === 0 && summary && summary.fetchComplete && summary.staleRemovalSkipped === false));

  if (!clean) {
    console.error(
      `${LOG_PREFIX} RESULT: NOT CLEAN — review the counts above before considering the sync fixed.`
    );
    return 1;
  }

  if (!indexOk) {
    console.error(`${LOG_PREFIX} RESULT: counts are clean but the unique index is not in place.`);
    return 1;
  }

  console.log(`${LOG_PREFIX} RESULT: OK — eBay active listings and CRM eBay marketplace listings match.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err) => {
    console.error(`${LOG_PREFIX} FATAL:`, err.code ? `[${err.code}] ` : "", err.message || err);
    try {
      await mongoose.disconnect();
    } catch (_) {
      /* nothing further to do */
    }
    process.exitCode = 1;
  });
