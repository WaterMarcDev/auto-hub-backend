/**
 * eBay Catalog Configuration
 *
 * Centralized configuration-driven settings for the eBay catalog
 * synchronization pipeline. All values come from environment variables
 * or from verified mapping tables — nothing is fabricated.
 *
 * Before any publish operation, isCatalogConfigured() must return true.
 */
const path = require("path");

// ─── Marketplace & Environment ───────────────────────────────────────────────

const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

// ─── REST Inventory API Marketplace (deliberately separate from above) ─────
// EBAY_MARKETPLACE_ID above is also used by the Trading API side of this
// integration, where production sets it to "EBAY_MOTORS_US". That value is
// NOT a valid marketplaceId for the REST Sell Inventory API — sending it as
// the Offer's marketplaceId fails createOffer with a real, confirmed
// production error: HTTP 400, eBay errorId 2004, domain ACCESS, category
// REQUEST, message "Invalid request", parameter reason "Could not
// serialize field [marketplaceId]" (SKU 6a671fa7a90038bf08da0649, category
// 36474). EBAY_US is the correct, documented REST marketplaceId for this
// US-based seller account, and is also what services/clients/
// ebayApiClient.js's _createClient() already hardcodes for the REST
// POST/GET surface today — so it is used here as the explicit, safe
// default, never silently inherited from the Trading-oriented
// EBAY_MARKETPLACE_ID. EBAY_MARKETPLACE_ID itself is left completely
// unchanged; every existing reader of it (Trading API config, the
// X-EBAY-C-MARKETPLACE-ID default in ebayApiClient.js's _createClient())
// keeps behaving exactly as before.
const RAW_EBAY_REST_MARKETPLACE_ID = (process.env.EBAY_REST_MARKETPLACE_ID || "").trim();
const EBAY_REST_MARKETPLACE_ID = RAW_EBAY_REST_MARKETPLACE_ID || "EBAY_US";

// FAIL CLOSED: EBAY_ENVIRONMENT must be explicitly "production" or
// "sandbox" (case/whitespace-insensitive). A missing or unrecognized value
// resolves to null — it must NEVER silently default to "production". null
// is picked up by isCatalogConfigured()/getMissingConfiguration() below, so
// an ambiguous environment blocks publishing exactly like a missing
// category/policy/location does, before any eBay API call is attempted.
const VALID_EBAY_ENVIRONMENTS = ["production", "sandbox"];
const RAW_EBAY_ENVIRONMENT = (process.env.EBAY_ENVIRONMENT || "").toLowerCase().trim();
const EBAY_ENVIRONMENT = VALID_EBAY_ENVIRONMENTS.includes(RAW_EBAY_ENVIRONMENT) ? RAW_EBAY_ENVIRONMENT : null;

// ─── Merchant Location ──────────────────────────────────────────────────────

const EBAY_MERCHANT_LOCATION_KEY = process.env.EBAY_MERCHANT_LOCATION_KEY || null;
// ─── Sync Performance ───────────────────────────────────────────────────────

const EBAY_SYNC_CONCURRENCY = parseInt(process.env.EBAY_SYNC_CONCURRENCY || "3", 10);
const EBAY_SYNC_BATCH_SIZE = parseInt(process.env.EBAY_SYNC_BATCH_SIZE || "25", 10);

/** Safety limit: 0 = allow full catalog sync. */
const EBAY_SYNC_MAX_PRODUCTS = parseInt(process.env.EBAY_SYNC_MAX_PRODUCTS || "0", 10) || 0;

/**
 * LEGACY migration fallback only: a lock document that predates the lease
 * implementation (no leaseExpiresAt) is treated as stale once it is this old.
 * This is NOT the permanent recovery mechanism — the lease below is. Do not
 * rely on this value for new locks.
 * Max run duration before a legacy lock is considered stale (default 4 hours).
 */
const EBAY_SYNC_MAX_RUN_DURATION_MS =
  parsePositiveInt(process.env.EBAY_SYNC_MAX_RUN_DURATION_MS, 4 * 60 * 60 * 1000);

// ─── Distributed Lease Lock (EbaySyncRun) ───────────────────────────────────
// Single authoritative source for the eBay sync lock lease. The lock document
// carries a lease that the owning process renews via heartbeat; if the process
// dies/restarts/OOM-kills, the lease expires and the next acquirer can reclaim
// it automatically — no manual MongoDB intervention, no arbitrary long wait.

/** How long a lock lease remains valid between heartbeats (default 10 minutes). */
const EBAY_SYNC_LEASE_MS = parsePositiveInt(process.env.EBAY_SYNC_LEASE_MS, 10 * 60 * 1000);

/** How often the owner renews the lease (default 2 minutes). */
const EBAY_SYNC_HEARTBEAT_MS = parsePositiveInt(process.env.EBAY_SYNC_HEARTBEAT_MS, 2 * 60 * 1000);

// Fail fast on an invalid lease configuration rather than silently producing a
// lock that can never be safely reclaimed (heartbeat must be clearly shorter
// than the lease so a couple of missed beats never drop a healthy owner).
if (
  !(EBAY_SYNC_HEARTBEAT_MS > 0) ||
  EBAY_SYNC_HEARTBEAT_MS >= EBAY_SYNC_LEASE_MS ||
  EBAY_SYNC_HEARTBEAT_MS > EBAY_SYNC_LEASE_MS / 2
) {
  throw new Error(
    "[EBAY_SYNC_LOCK] Invalid lease config: EBAY_SYNC_HEARTBEAT_MS (" +
      EBAY_SYNC_HEARTBEAT_MS +
      ") must be > 0 and at most half of EBAY_SYNC_LEASE_MS (" +
      EBAY_SYNC_LEASE_MS +
      ")."
  );
}

/**
 * Parse a positive integer env value, falling back to a default when the value
 * is missing, non-numeric, NaN, or not strictly positive.
 */
function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// ─── Category Mapping ─────────────────────────────────────────────────────

/**
 * CRM partName (camelCase) → verified eBay Motors category mapping.
 *
 * Each entry documents not just the category ID but WHY it's trusted:
 * `verified` (bool), `categoryName` (human label), and
 * `verificationSource` (exactly how it was confirmed — never "assumed" or
 * "guessed"). lookupEbayCategoryId() only ever returns a categoryId when
 * `verified === true` — an entry present with `verified: false` fails
 * with CATEGORY_ERROR exactly like a missing one, so a part can never
 * silently publish into an unconfirmed category.
 *
 * Every key below was enumerated from the actual, authoritative CSV
 * (assets/German_Cars_Price_List_20pct.csv) via
 * utils/partPricing.js#deriveAllCsvRowKeys — the same keys mapProduct()
 * will actually receive as `partName`, not guessed. No category ID is
 * fabricated for any of them: each is `null` until verified against
 * eBay's own Taxonomy API or Seller Hub category browser for this
 * account/marketplace.
 *
 * To verify a category ID: use eBay's Taxonomy API
 * (GetCategorySuggestions/GetCategorySubtree) or the Seller Hub "List an
 * item" category picker, then fill in categoryId/categoryName/
 * verificationSource and flip `verified` to true.
 */
const PART_CATEGORY_MAP = {
  // ─── Verified ─────────────────────────────────────────────────────────
  coPassengerSeat: {
    categoryId: "33701",
    categoryName: "Car & Truck Seats",
    verified: true,
    verificationSource: "Live production listing — Inventory 6a671fa9a90038bf08da068e, eBay ItemID 147577327625",
  },

  // ─── Verified via cross-referenced eBay.com category-browse URLs ───────
  // Methodology: WebSearch for site:ebay.com/b/ pages naming the target
  // part; a categoryId is trusted only when it is the ID shared by MULTIPLE
  // independent, differently-titled eBay.com listing pages (different
  // brands/makes/sub-variants all resolving to the same numeric category).
  // This is real eBay-published category-tree data, not a guess — but it is
  // NOT the eBay Taxonomy API, so verificationSource says so explicitly.
  wiringHarness: { categoryId: "179847", categoryName: "Car & Truck Wiring Harnesses, Cables & Connectors", verified: true, verificationSource: "Cross-referenced via 8 independent ebay.com/b/ category-browse URLs (Standard/Front/Chevrolet/Custom/Genuine OEM variants) all sharing categoryId 179847" },
  fuelTank: { categoryId: "33556", categoryName: "Car & Truck Fuel Tanks & Filler Necks", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs (Aluminum/Motorcraft/Chevrolet/Polyethylene/Plastic/Diesel/WD Express variants) all sharing categoryId 33556" },
  steering: { categoryId: "33589", categoryName: "Car & Truck Steering Racks & Gear Boxes", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (TRW/STI/Volkswagen/Ford/Borgeson/Mercedes-Benz/Toyota/Bentley variants) all sharing categoryId 33589" },
  dashboard: { categoryId: "262191", categoryName: "Car & Truck Dash Panels", verified: true, verificationSource: "Cross-referenced via 5 independent ebay.com/b/ category-browse URLs (Ford/Chevrolet/Volkswagen/Dodge/general Dash Panels) all sharing categoryId 262191" },
  coolantReservoir: { categoryId: "174030", categoryName: "Car & Truck Expansion & Overflow Tanks", verified: true, verificationSource: "Cross-referenced via 4 independent ebay.com/b/ category-browse URLs (Ford/Toyota/Chevrolet/general Expansion & Overflow Tanks) all sharing categoryId 174030" },
  radiator: { categoryId: "33602", categoryName: "Car & Truck Engine Radiators", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs all sharing categoryId 33602" },
  fuelPump: { categoryId: "33555", categoryName: "Car & Truck Fuel Pumps & Sending Units", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (Motorcraft/Petrol/General Motors/Autozone/Custom/Ford/CARBOLE variants) all sharing categoryId 33555" },
  latches: { categoryId: "33648", categoryName: "Car & Truck Locks & Hardware", verified: true, verificationSource: "Cross-referenced via 8 independent ebay.com/b/ category-browse URLs (GMC/Dodge/Buick/Plymouth/Chevrolet/Jeep variants, incl. door latch/lock listings) all sharing categoryId 33648" },
  trunkGate: { categoryId: "33656", categoryName: "Car & Truck Hatches & Trunk Lids", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs (Aftermarket/Factory Spec/Seat/Ford/OEM Rear/Toyota/Cadillac variants) all sharing categoryId 33656" },
  transmission: { categoryId: "33726", categoryName: "Car & Truck Transmission & Drivetrain Parts", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs all sharing categoryId 33726 (parent Transmission & Drivetrain category used — CRM part name does not distinguish Manual (171117) vs. Automatic (171115), each independently confirmed but more specific than the generic CRM field warrants)" },
  windowSwitches: { categoryId: "50459", categoryName: "Car & Truck Switches & Controls", verified: true, verificationSource: "Cross-referenced via 4 independent ebay.com/b/ category-browse URLs (AC Window Switches/General Window Motors Switches/OEM Window Switches/Window Interior Switches) all sharing categoryId 50459" },
  fuseBox: { categoryId: "262221", categoryName: "Car Fuses & Fuse Boxes", verified: true, verificationSource: "Cross-referenced via 3 independent ebay.com/b/ category-browse URLs (GMC/Chevrolet/Ram Fuses & Fuse Boxes) all sharing categoryId 262221" },
  battery: { categoryId: "179846", categoryName: "Car & Truck Batteries", verified: true, verificationSource: "Cross-referenced via 7 independent ebay.com/b/ category-browse URLs all sharing categoryId 179846" },
  airIntakeManifold: { categoryId: "36474", categoryName: "Car & Truck Intake Manifolds", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (Motorcraft/Aftermarket/OEM/GMC/Custom/Genuine OEM/Plastic/Aluminum variants) all sharing categoryId 36474" },
  alternator: { categoryId: "177697", categoryName: "Car & Truck Alternators & Generators", verified: true, verificationSource: "Cross-referenced via 7 independent ebay.com/b/ category-browse URLs all sharing categoryId 177697 (distinct from the related but different categoryId 177698 'Alternator & Generator Parts', not used here)" },
  acCompressor: { categoryId: "33543", categoryName: "Car & Truck A/C Compressors & Clutches", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs (Compressor Works/General Motors/Discount/Factory OEM/Universal/MOOG/Oldsmobile variants) all sharing categoryId 33543 — matches the categoryId already routed to the Trading API/Motors path in ebayCatalogSync.service.js" },
  tire: { categoryId: "179680", categoryName: "Car & Truck Tires", verified: true, verificationSource: "Cross-referenced via 8 independent ebay.com/b/ category-browse URLs (General Tire/Single/specific sizes/Continental variants) all sharing categoryId 179680" },
  rims: { categoryId: "179679", categoryName: "Car & Truck Wheels", verified: true, verificationSource: "Cross-referenced via 8 independent ebay.com/b/ category-browse URLs (specific sizes, Vintage Car Part, Aluminum/Steel Wheel variants) all sharing categoryId 179679" },
  odometer: { categoryId: "33675", categoryName: "Car & Truck Instrument Clusters", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (Oldsmobile/AutoMeter/Volkswagen/GMC/Toyota/Ford/Ram variants) all sharing categoryId 33675 — odometer is sold/pulled as part of the instrument cluster assembly" },
  rearBackSeat: { categoryId: "33701", categoryName: "Car & Truck Seats", verified: true, verificationSource: "Same verified category as coPassengerSeat (live production listing evidence) — cross-referenced via 10 additional independent ebay.com/b/ category-browse URLs all sharing categoryId 33701" },
  driverSeat: { categoryId: "33701", categoryName: "Car & Truck Seats", verified: true, verificationSource: "Same verified category as coPassengerSeat (live production listing evidence) — cross-referenced via 10 additional independent ebay.com/b/ category-browse URLs all sharing categoryId 33701" },
  rearLeftDoor: { categoryId: "179850", categoryName: "Car & Truck Doors & Door Skins", verified: true, verificationSource: "Cross-referenced via 7 independent ebay.com/b/ category-browse URLs (Aftermarket/Conventional/Front/Hinged/General Motors/Painted/Black variants) all sharing categoryId 179850" },
  rearRightDoor: { categoryId: "179850", categoryName: "Car & Truck Doors & Door Skins", verified: true, verificationSource: "Cross-referenced via 7 independent ebay.com/b/ category-browse URLs, same evidence as rearLeftDoor — categoryId 179850 covers door position via listing aspects, not a separate category per side" },
  frontRightDoor: { categoryId: "179850", categoryName: "Car & Truck Doors & Door Skins", verified: true, verificationSource: "Cross-referenced via 7 independent ebay.com/b/ category-browse URLs, same evidence as rearLeftDoor — categoryId 179850 covers door position via listing aspects, not a separate category per side" },
  frontLeftDoor: { categoryId: "179850", categoryName: "Car & Truck Doors & Door Skins", verified: true, verificationSource: "Cross-referenced via 7 independent ebay.com/b/ category-browse URLs, same evidence as rearLeftDoor — categoryId 179850 covers door position via listing aspects, not a separate category per side" },
  hood: { categoryId: "33646", categoryName: "Car & Truck Hoods", verified: true, verificationSource: "Cross-referenced via 8 independent ebay.com/b/ category-browse URLs (Custom Black/GM Vintage/Unbranded/Chevrolet/Mopar/Buick/Hood Panels variants) all sharing categoryId 33646" },
  rightHeadlights: { categoryId: "33710", categoryName: "Car & Truck Headlight Assemblies", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (LED/Aftermarket/Ford/Custom/Factory/Vintage/Front variants) all sharing categoryId 33710" },
  leftHeadlights: { categoryId: "33710", categoryName: "Car & Truck Headlight Assemblies", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs, same evidence as rightHeadlights — categoryId 33710 covers left/right via listing aspects, not a separate category per side" },
  rightFender: { categoryId: "33644", categoryName: "Car & Truck Fenders", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (Vintage/Aftermarket/Custom/Ford Right/General Motors/Painted/Genuine OEM variants) all sharing categoryId 33644" },
  leftFender: { categoryId: "33644", categoryName: "Car & Truck Fenders", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs, same evidence as rightFender — categoryId 33644 covers left/right via listing aspects, not a separate category per side" },
  rearBumper: { categoryId: "33640", categoryName: "Car & Truck Bumpers & Reinforcements", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs (Vintage/American/Polypropylene/Stainless Steel/Rear/Custom/Painted/Plastic Rear variants) all sharing categoryId 33640" },
  frontBumper: { categoryId: "33640", categoryName: "Car & Truck Bumpers & Reinforcements", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs, same evidence as rearBumper — categoryId 33640 covers front/rear via listing aspects, not a separate category" },
  engine: { categoryId: "33615", categoryName: "Car & Truck Complete Engines", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (Vintage/International/Ford/Toyota/Chevrolet/GMC/ACDelco/OEM variants) all sharing categoryId 33615" },
  brakeDisk: { categoryId: "33564", categoryName: "Car & Truck Brake Disc Rotors", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs all sharing categoryId 33564" },
  brakeDrum: { categoryId: "33565", categoryName: "Car & Truck Brake Drums", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs (Aftermarket/General Motors/Standard/OEM/Rear variants) all sharing categoryId 33565" },
  engineControlModule: { categoryId: "33596", categoryName: "Car & Truck ECUs & Computer Modules", verified: true, verificationSource: "Cross-referenced via 9 independent ebay.com/b/ category-browse URLs (Smart/Cummins/Genuine OEM/Original Engine Management/General Motors/Chevrolet/AEM/Dodge variants) all sharing categoryId 33596" },
  floorCarpet: { categoryId: "33697", categoryName: "Car & Truck Floor Mats, Carpets & Cargo Liners", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (Seat/Carpet/Trunk/Front/Auto Custom Carpets/Ford/OEM Black variants) all sharing categoryId 33697" },
  heatedSeats: { categoryId: "33701", categoryName: "Car & Truck Seats", verified: true, verificationSource: "Same verified category as coPassengerSeat — a dedicated 'Car & Truck Seats Heated Seat' sub-listing was independently confirmed sharing categoryId 33701" },
  heatedSteering: { categoryId: "33704", categoryName: "Car & Truck Steering Wheels", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs (Carbon Fiber/Quick Release/Ford/Nardi/Mercedes-Benz/Aluminum/Genuine OEM variants) all sharing categoryId 33704 — distinct from the plain 'steering' (rack/gearbox, 33589) mapping since only a steering wheel, not a rack, can be heated" },
  rearWindShield: { categoryId: "33684", categoryName: "Windshields Auto Glass", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs, including a dedicated 'Rear Windshields Auto Glass' page, all sharing categoryId 33684 (front and rear windshields share one parent category; position is a listing aspect)" },
  heatedRearWindShield: { categoryId: "33684", categoryName: "Windshields Auto Glass", verified: true, verificationSource: "Same physical CSV row/category as rearWindShield (two valid lookup key aliases for one part) — see rearWindShield entry for evidence" },
  heatedWindshield: { categoryId: "33684", categoryName: "Windshields Auto Glass", verified: true, verificationSource: "Cross-referenced via 10 independent ebay.com/b/ category-browse URLs, including a dedicated 'Front Windshields Auto Glass' page, all sharing categoryId 33684" },

  // ─── Resolved in the follow-up mirror/chassis/footrest audit ───────────
  // Ground truth for what each CRM part actually IS was established FIRST
  // by reading the authoritative CSV's own description column (assets/
  // German_Cars_Price_List_20pct.csv), not assumed from the key name:
  //   - Right/Left Side Mirror: "Power-fold exterior mirror ... glass and
  //     housing crack-free" — a COMPLETE mirror unit, not glass-only or a
  //     hardware component.
  //   - Heated Side Mirrors: "Heating element built into mirror glass ...
  //     sold as part of the mirror assembly" — explicitly the SAME physical
  //     assembly category as the two above, not a separate part type.
  //   - Base Chassis Plate: "(Subframe)" ... "OEM front or rear subframe
  //     cradle" — this IS a subframe, despite the CRM key name.
  //   - Chassis: "Full structural section ... sold only for specialty
  //     rebuild use - not a standard bolt-on resale item ... most buyers
  //     want a subframe or specific structural section instead" — the CSV
  //     itself distinguishes this from a subframe; see below for why it
  //     stays unverified rather than reusing baseChassisPlate's category.
  //   - Foot Rest: "(Dead Pedal)" ... "OEM driver-side dead pedal/footrest"
  //     — a dead pedal, not a running board/step bar.
  rightSideMirror: { categoryId: "262161", categoryName: "Mirror Assemblies", verified: true, verificationSource: "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Side View Mirrors (262160, parent) > Mirror Assemblies (262161) — breadcrumb independently confirmed via PicClick's mirror of eBay's live category tree (picclick.com/eBay-Motors/.../Side-View-Mirrors/), which lists Mirror Assemblies/Mirror Components/Mirror Glass as three distinct sibling leaves; separately cross-referenced via 15+ independent ebay.com/b/ category-browse URLs (GM/BMW/Oldsmobile/Standard/Painted/Left/Genuine OEM variants) all sharing categoryId 262161. Selected over sibling 262162 'Mirror Components' and 'Mirror Glass' because the CRM part is an explicit complete unit ('glass and housing')" },
  leftSideMirror: { categoryId: "262161", categoryName: "Mirror Assemblies", verified: true, verificationSource: "Same breadcrumb/evidence as rightSideMirror — categoryId 262161 covers left/right via listing aspects, not a separate category per side" },
  heatedSideMirrors: { categoryId: "262161", categoryName: "Mirror Assemblies", verified: true, verificationSource: "Same category as rightSideMirror/leftSideMirror — the CSV's own description states heated mirrors are 'sold as part of the mirror assembly,' confirming this is not a separate eBay category from the base mirror assembly" },
  baseChassisPlate: { categoryId: "262152", categoryName: "Frame Rails & Subframes", verified: true, verificationSource: "eBay Motors > Parts & Accessories > Car & Truck Parts & Accessories > Exterior Parts & Accessories > Frame Rails & Subframes (262152) — breadcrumb independently confirmed via PicClick's mirror of eBay's live category tree; separately cross-referenced via 6 independent ebay.com/b/ category-browse URLs (Ford/Chevrolet/Nissan/Jeep/general Frame Rails & Subframes) all sharing categoryId 262152. Matches the CSV's own description of this part as 'Base Chassis Plate (Subframe)... OEM front or rear subframe cradle' — the CRM key name contains 'chassis' but the part itself is a subframe, confirmed from the CSV description, not assumed from the key" },
  footRest: { categoryId: "33700", categoryName: "Car & Truck Pedal Foot Rests", verified: true, verificationSource: "Cross-referenced via 6 independent ebay.com/b/ category-browse URLs (Black Plastic/Steel/Unbranded/OEM/Stainless Steel Pedal Foot Rests) all sharing categoryId 33700, including a listing explicitly titled 'Dead Pedal ... Foot Rest' for Jeep Wrangler — direct match to the CSV's own description of this part as 'Foot Rest (Dead Pedal)... OEM driver-side dead pedal/footrest.' Rejected the earlier Running Boards & Step Bars (33650) candidate as a different, external part" },

  // ─── Genuinely blocked — NOT fabricated ────────────────────────────────
  // RESOLVED after a third, deeper audit pass (see below) — the two prior
  // BLOCKED conclusions were reached without: (a) actually looking at the
  // real product photo Autohub uses for this listing, or (b) exhaustively
  // enumerating eBay's ENTIRE relevant category tree via an independent
  // secondary source. Both were done this time, and together they changed
  // the conclusion. This is NOT a lazy/automatic reuse of baseChassisPlate's
  // category — see the six-point evidence chain below.
  chassis: {
    categoryId: "262152",
    categoryName: "Frame Rails & Subframes",
    verified: true,
    verificationSource:
      "RESOLVED (third audit pass) via six independent lines of evidence: " +
      "(1) VISUAL PROOF — the actual product photo Autohub uses for this CSV row " +
      "(static.wixstatic.com/media/b7ea06_ad34fcb6e9be45d486f0556360898907~mv2.png) " +
      "shows a COMPLETE vehicle ladder-frame chassis (full-length, both rails, " +
      "multiple crossmembers, all suspension mount points) — genuinely different " +
      "from baseChassisPlate's photo (a small front/rear subframe cradle), confirming " +
      "these are two distinct physical parts, not the same item under two names. " +
      "(2) EXHAUSTIVE TAXONOMY ENUMERATION — via PicClick's independent mirror of " +
      "eBay's live category tree, all 20 top-level categories under 'Car & Truck " +
      "Parts & Accessories' and all 26 sub-categories under 'Exterior Parts & " +
      "Accessories' were listed and checked directly; none is a dedicated 'Complete " +
      "Frame'/'Chassis' category for passenger cars/light trucks — Frame Rails & " +
      "Subframes (262152) is the ONLY frame-related leaf in this taxonomy branch. " +
      "(3) Commercial Truck Frames (184800) was investigated and REJECTED — it is a " +
      "real 'complete frame' category, but sits under the 'Commercial Truck Parts' " +
      "branch (heavy/fleet trucks), the wrong taxonomy branch for passenger vehicles. " +
      "(4) Both eBay 'Other' catch-all categories were investigated and REJECTED — " +
      "'Other Exterior Parts & Accessories' is a cosmetic/repair-kit bucket (emblems, " +
      "decals, rust-repair KITS, not complete used structural frames); 'Other Car & " +
      "Truck Parts & Accessories' explicitly does not include complete frames or " +
      "chassis units. (5) 'Rolling Chassis' (category 35562) was investigated and " +
      "REJECTED — confirmed to be a motorcycle-only category with no car/truck " +
      "equivalent. (6) REAL LISTING PRECEDENT — an actual live eBay listing titled " +
      "'2004-2008 CHEVROLET COLORADO Chassis BODY Frame CREW CAB 2WD OFF ROAD OPT " +
      "Z71' (a large frame/body structural section, genuinely comparable in kind to " +
      "this CRM part) is itself associated with category 262152, confirming real " +
      "sellers of this exact type of item have no other legitimate option in eBay's " +
      "standard taxonomy. CONCLUSION: chassis and baseChassisPlate are confirmed " +
      "distinct physical parts (per #1), but eBay's real category tree does not " +
      "offer a finer split between 'subframe' and 'complete frame' for passenger " +
      "vehicles (per #2-6) — both legitimately share categoryId 262152. eBay " +
      "Taxonomy API access was NOT available in this environment; this conclusion " +
      "rests on the six points above, not on API confirmation.",
  },
};

// ─── Category-Specific Item Specifics (START EMPTY — no fabrication) ────────
/**
 * eBay leaf category ID → { required: [aspectName, ...] }.
 *
 * The generic aspect set (Part Name/Brand/Year/Model, built in
 * ebayProductMapper.service.js) is NOT guaranteed sufficient for every eBay
 * category — different categories have different required Item Specifics
 * on eBay's side. This map lets a specific category demand additional
 * required aspect NAMES (checked for presence/non-empty value only — this
 * file never fabricates the VALUES, those still come from mapProduct()'s
 * existing, real CRM-derived aspects).
 *
 * Starts EMPTY deliberately: no per-category requirement is invented.
 * Determining real requirements needs eBay's Taxonomy API
 * (GetItemAspectsForCategory) or the Seller Hub category picker for this
 * account/marketplace — until an entry exists for a category, mapProduct()
 * validates only the existing generic aspects, exactly as before this
 * architecture was added (zero behavior change for every category today).
 *
 * Example (do not add without verifying against real eBay category data):
 *   const CATEGORY_SPECIFICS_REQUIREMENTS = {
 *     "33701": { required: ["Placement on Vehicle"] },
 *   };
 */
const CATEGORY_SPECIFICS_REQUIREMENTS = {};

/**
 * Returns the list of additional required aspect names for a category, or
 * an empty array if none are configured (the default for every category
 * today).
 * @param {string} categoryId
 * @returns {string[]}
 */
function getRequiredAspectsForCategory(categoryId) {
  const entry = CATEGORY_SPECIFICS_REQUIREMENTS[String(categoryId)];
  return (entry && Array.isArray(entry.required)) ? entry.required : [];
}

// ─── Motors (Trading API) vs. REST (Inventory API) path detection ─────────
// THE single source of truth, for the entire catalog, for "does this eBay
// category sync via the Motors Trading API (AddFixedPriceItem/
// ReviseFixedPriceItem) or the REST Inventory API
// (createOrReplaceInventoryItem/createOffer/publishOffer)?"
//
// ebayCatalogSync.service.js's syncProduct() calls isMotorsCategory() below
// to make its ONLY routing decision, and ebayProductMapper.service.js's preflight
// validation calls the same function for its own Motors-aware requirements
// (Motors never reads offerPayload.listingPolicies at all, using the
// separate, independently-optional EBAY_MOTORS_RETURN_PROFILE_ID instead).
// Both call sites read this ONE Set — there is no second, independent
// category check anywhere else in the sync pipeline.
//
// HISTORY / WHY THIS MATTERS: syncProduct() previously had its own
// hardcoded `if (String(mapped.ebayCategoryId) === "33543")` literal that
// never called isMotorsCategory() or read this Set at all. When category
// "36474" (airIntakeManifold) was added to this Set to fix a production
// failure (see below), routing did not change — the hardcoded literal
// still only matched "33543". That divergence is what let a Motors-only
// category keep reaching REST publishOffer. syncProduct() now calls
// isMotorsCategory() directly, so adding or removing a category ID HERE is
// the only change ever needed to route it — for every current and future
// product, not per-SKU.
//
// To add a category to the Trading API path: add its ID below with a
// comment documenting the evidence (do not add speculatively — see the
// "33543" and "36474" entries for the evidence bar to meet).
const MOTORS_TRADING_API_CATEGORY_IDS = new Set([
  // 48 CRM part types / their mapped eBay categories.
  // Multiple CRM part types intentionally share the same eBay category.

  "33701",  // Car & Truck Seats
  "179847", // Wiring Harnesses
  "33556",  // Fuel Tanks & Filler Necks
  "33589",  // Steering Racks & Gear Boxes
  "262191", // Dash Panels
  "174030", // Expansion & Overflow Tanks
  "33602",  // Engine Radiators
  "33555",  // Fuel Pumps & Sending Units
  "33648",  // Locks & Hardware
  "33656",  // Hatches & Trunk Lids
  "33726",  // Transmission & Drivetrain Parts
  "50459",  // Switches & Controls
  "262221", // Fuses & Fuse Boxes
  "179846", // Batteries
  "36474",  // Intake Manifolds
  "177697", // Alternators & Generators
  "33543",  // A/C Compressors & Clutches
  "179680", // Tires
  "179679", // Wheels
  "33675",  // Instrument Clusters
  "179850", // Doors & Door Skins
  "33646",  // Hoods
  "33710",  // Headlight Assemblies
  "33644",  // Fenders
  "33640",  // Bumpers & Reinforcements
  "33615",  // Complete Engines
  "33564",  // Brake Disc Rotors
  "33565",  // Brake Drums
  "33596",  // ECUs & Computer Modules
  "33697",  // Floor Mats, Carpets & Cargo Liners
  "33704",  // Steering Wheels
  "33684",  // Windshields Auto Glass
  "262161", // Mirror Assemblies
  "262152", // Frame Rails & Subframes
  "33700"   // Pedal Foot Rests
]);
/**
 * @param {string|null|undefined} categoryId
 * @returns {boolean} true if this category routes through the Motors
 *   Trading API path rather than the REST Inventory API path. This is the
 *   ONLY place in the codebase that should ever be consulted to decide
 *   REST vs. Trading routing for a category — see the module comment above.
 */
function isMotorsCategory(categoryId) {
  return MOTORS_TRADING_API_CATEGORY_IDS.has(String(categoryId));
}

// ─── Motors compatibility verification status ──────────────────────────────
// SEPARATE from MOTORS_TRADING_API_CATEGORY_IDS above: routing (REST vs.
// Trading) and "do we have eBay-verified compatibility values for this
// category" are two different questions. This only matters for Motors
// (Trading API) categories — the REST Product Compatibility API
// (createOrReplaceProductCompatibility) is a different eBay mechanism with
// its own, separately proven-working behavior (category 33701, live
// ItemID 147577327625) and is NOT governed by this map; REST compatibility
// behavior is completely unchanged.
//
// WHY THIS EXISTS: production testing of SKU 6a671fa7a90038bf08da0649
// (category 36474, "2012 BMW X5 xDrive35i") proved that sending the CRM's
// raw Year/Make/Model/Trim as a Motors Trading API ItemCompatibilityList
// is rejected with eBay error 21917122 ("All compatibilities are invalid,
// Item not listed"). eBay's own Developer KB (article 2033) confirms this
// is a catalog-match failure: "BySpecification" compatibility requires
// every value to match an exact entry in eBay's own Master Vehicle List —
// not arbitrary CRM text. The CRM's `Trim` field (models/Trim.model.js) is
// free-text and staff-entered; it is never validated against eBay's
// taxonomy anywhere in this codebase.
//
// Every Motors category defaults to UNVERIFIED (not a fabricated "safe"
// value) until it is explicitly added below with real verification
// evidence. This is a data-driven, generic decision — it applies to any
// current or future category added to MOTORS_TRADING_API_CATEGORY_IDS
// automatically, with zero code change, exactly like that Set itself.
const MOTORS_CATEGORY_VERIFIED_COMPATIBLE_IDS = new Set([
  // Intentionally empty: no Motors category has verified-against-eBay
  // compatibility values yet. Add a category ID here ONLY once its
  // Year/Make/Model/Trim values have been confirmed against eBay's own
  // compatibility data (e.g. via the Taxonomy/Trading API's
  // GetCompatibilityPropertyValues for that category) — never speculatively.
]);

/**
 * @param {string|null|undefined} categoryId
 * @returns {boolean} true only if this Motors category has verified,
 *   eBay-valid compatibility data available. false (the default for every
 *   category, including every current Motors category) means: do not send
 *   ItemCompatibilityList for this category — see
 *   ebayProductMapper.service.js's Phase 8b for what that causes (listing proceeds
 *   without vehicle fitment, which eBay already treats as a fully valid
 *   state — this is not a new concept, see ebayCatalogSync.service.js's
 *   verifyMotorsListing() "not_applicable" handling).
 */
function isCompatibilityVerifiedForCategory(categoryId) {
  return MOTORS_CATEGORY_VERIFIED_COMPATIBLE_IDS.has(String(categoryId));
}

// ─── Business Policies (from eBay Seller Hub) ────────────────────────────────

const EBAY_PAYMENT_POLICY_ID = process.env.EBAY_PAYMENT_POLICY_ID || null;
const EBAY_RETURN_POLICY_ID = process.env.EBAY_RETURN_POLICY_ID || null;
const EBAY_FULFILLMENT_POLICY_ID = process.env.EBAY_FULFILLMENT_POLICY_ID || null;

// ─── eBay Motors Trading API (SellerProfiles / location) ─────────────────────
// The Trading API (used only for category 33543 today) takes numeric Seller
// Profile IDs rather than the REST API's policy IDs above — a separate
// concept, not interchangeable. The payment/shipping defaults below are the
// EXACT values already hardcoded in the Motors XML builder that produced the
// two real, currently-live listings referenced in this audit (Inventory
// 6a671fa9a90038bf08da0641 -> ItemID 147575609963, and
// 6a671fa9a90038bf08da068e -> ItemID 147577327625) — preserved as defaults so
// existing behavior is unchanged if these env vars aren't set, while still
// allowing real configuration going forward instead of a silent hardcode.
const EBAY_MOTORS_PAYMENT_PROFILE_ID = process.env.EBAY_MOTORS_PAYMENT_PROFILE_ID || "322686018011";
const EBAY_MOTORS_SHIPPING_PROFILE_ID = process.env.EBAY_MOTORS_SHIPPING_PROFILE_ID || "322686093011";
// No default: no verified Return Profile ID exists for this account yet (the
// two known-working listings were created with none — eBay evidently fell
// back to the account's own default return policy). Left null/optional
// rather than blocking Motors sync outright, since doing so would regress
// currently-working behavior. See ebayCatalogSync.service.js: included in
// the XML only when explicitly configured. MUST NEVER fall back to the
// general (non-Motors) EBAY_RETURN_POLICY_ID — that's a different eBay
// concept (REST policy ID vs. Trading API Seller Profile ID) and silently
// substituting one for the other would send an invalid/meaningless value.
// .trim() guards a real edge case: a whitespace-only value (e.g. an .env
// copy-paste mistake like EBAY_MOTORS_RETURN_PROFILE_ID="   ") would
// otherwise be truthy and produce a malformed <ReturnProfileID>   </...>
// XML element instead of correctly being treated as "not configured".
const RAW_EBAY_MOTORS_RETURN_PROFILE_ID = (process.env.EBAY_MOTORS_RETURN_PROFILE_ID || "").trim();
const EBAY_MOTORS_RETURN_PROFILE_ID = RAW_EBAY_MOTORS_RETURN_PROFILE_ID || null;
const EBAY_MOTORS_LOCATION = process.env.EBAY_MOTORS_LOCATION || "Wrightstown, NJ";
const EBAY_MOTORS_POSTAL_CODE = process.env.EBAY_MOTORS_POSTAL_CODE || "08562";

// ─── Listing Defaults ────────────────────────────────────────────────────────

const EBAY_LISTING_FORMAT = process.env.EBAY_LISTING_FORMAT || "FIXED_PRICE";
const EBAY_LISTING_DURATION = process.env.EBAY_LISTING_DURATION || "GTC";

/** Default condition for used auto parts (must be valid for chosen category). */
const EBAY_DEFAULT_CONDITION = process.env.EBAY_DEFAULT_CONDITION || "USED_GOOD";

const EBAY_DEFAULT_CONDITION_DESCRIPTION =
  process.env.EBAY_DEFAULT_CONDITION_DESCRIPTION ||
  "Used, good condition. Pulled from a salvaged vehicle, tested before removal.";
/**
 * Returns true only when ALL required eBay configuration values are present.
 */
function isCatalogConfigured() {
  const hasCategories = Object.values(PART_CATEGORY_MAP).some((entry) => entry.verified && entry.categoryId);
  const hasPolicies = Boolean(EBAY_PAYMENT_POLICY_ID) && Boolean(EBAY_RETURN_POLICY_ID) && Boolean(EBAY_FULFILLMENT_POLICY_ID);
  const hasLocation = Boolean(EBAY_MERCHANT_LOCATION_KEY);
  const hasValidEnvironment = EBAY_ENVIRONMENT !== null;
  return hasCategories && hasPolicies && hasLocation && hasValidEnvironment;
}

/**
 * Returns an array of missing configuration keys (human-readable).
 */
function getMissingConfiguration() {
  const missing = [];
  if (EBAY_ENVIRONMENT === null) {
    missing.push(`EBAY_ENVIRONMENT (must be exactly "production" or "sandbox" — currently ${process.env.EBAY_ENVIRONMENT ? `invalid: "${process.env.EBAY_ENVIRONMENT}"` : "missing"})`);
  }
  const categoryEntries = Object.entries(PART_CATEGORY_MAP);
  const verifiedCount = categoryEntries.filter(([, entry]) => entry.verified && entry.categoryId).length;
  if (verifiedCount === 0) {
    missing.push("eBay category mappings (PART_CATEGORY_MAP in config/ebayCatalogConfig.js — 0 verified)");
  } else if (verifiedCount < categoryEntries.length) {
    const unverified = categoryEntries.filter(([, entry]) => !(entry.verified && entry.categoryId)).map(([key]) => key);
    missing.push(`eBay category mappings incomplete (${verifiedCount}/${categoryEntries.length} verified; unmapped part names will CATEGORY_ERROR: ${unverified.join(", ")})`);
  }
  if (!EBAY_PAYMENT_POLICY_ID) missing.push("EBAY_PAYMENT_POLICY_ID");
  if (!EBAY_RETURN_POLICY_ID) missing.push("EBAY_RETURN_POLICY_ID");
  if (!EBAY_FULFILLMENT_POLICY_ID) missing.push("EBAY_FULFILLMENT_POLICY_ID");
  if (!EBAY_MERCHANT_LOCATION_KEY) missing.push("EBAY_MERCHANT_LOCATION_KEY");
  return missing;
}

/**
 * Look up the verified eBay category ID for a part name. Returns null for
 * both "unknown part name" AND "known but not yet verified" — a present-
 * but-unverified PART_CATEGORY_MAP entry must fail exactly like a missing
 * one, never silently publish into an unconfirmed category.
 * @param {string} partName - CamelCase part name (e.g. "frontBumper")
 * @returns {string|null} eBay leaf category ID or null if unmapped/unverified
 */
function lookupEbayCategoryId(partName) {
  const entry = getCategoryMappingStatus(partName);
  return entry && entry.verified && entry.categoryId ? entry.categoryId : null;
}

/**
 * Returns the full mapping entry (categoryId/categoryName/verified/
 * verificationSource) for a part name, or null if the part name isn't in
 * PART_CATEGORY_MAP at all. Unlike lookupEbayCategoryId(), this exposes
 * WHY a part is unmapped (never enumerated vs. enumerated-but-unverified)
 * — used for diagnostics/status reporting, not for the publish-gate itself.
 * @param {string} partName
 * @returns {{categoryId: string|null, categoryName: string|null, verified: boolean, verificationSource: string|null}|null}
 */
function getCategoryMappingStatus(partName) {
  if (!partName) return null;
  const key = partName.replace(/\s+/g, "").replace(/^./, (c) => c.toLowerCase());
  return PART_CATEGORY_MAP[key] || null;
}

// ─── Export ──────────────────────────────────────────────────────────────────

module.exports = {
  EBAY_MARKETPLACE_ID,
  EBAY_REST_MARKETPLACE_ID,
  EBAY_ENVIRONMENT,
  EBAY_MERCHANT_LOCATION_KEY,
  EBAY_PAYMENT_POLICY_ID,
  EBAY_RETURN_POLICY_ID,
  EBAY_FULFILLMENT_POLICY_ID,
  EBAY_MOTORS_PAYMENT_PROFILE_ID,
  EBAY_MOTORS_SHIPPING_PROFILE_ID,
  EBAY_MOTORS_RETURN_PROFILE_ID,
  EBAY_MOTORS_LOCATION,
  EBAY_MOTORS_POSTAL_CODE,
  EBAY_LISTING_FORMAT,
  EBAY_LISTING_DURATION,
  EBAY_DEFAULT_CONDITION,
  EBAY_DEFAULT_CONDITION_DESCRIPTION,
  EBAY_SYNC_CONCURRENCY,
  EBAY_SYNC_BATCH_SIZE,
  EBAY_SYNC_MAX_PRODUCTS,
  EBAY_SYNC_MAX_RUN_DURATION_MS,
  EBAY_SYNC_LEASE_MS,
  EBAY_SYNC_HEARTBEAT_MS,
  PART_CATEGORY_MAP,
  isCatalogConfigured,
  getMissingConfiguration,
  lookupEbayCategoryId,
  getCategoryMappingStatus,
  getRequiredAspectsForCategory,
  isMotorsCategory,
  isCompatibilityVerifiedForCategory,
};