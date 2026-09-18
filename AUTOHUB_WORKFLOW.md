# Autohub Project Workflow

This document explains, based on the actual code in this repository, how the
Autohub CRM backend fits together end to end: the overall business workflow,
how the CRM is connected to the public **autohubexpress.us** website (a Wix
site), how CRM inventory is synced out to that website (and other
marketplaces), and how customer-submitted Part Requests and Junk Car
Requests reach the CRM.

---

## 1. High-Level Workflow

Autohub is a used-auto-parts business. The CRM backend (`auto-hub-backend`,
this repository — a single Node.js/Express + MongoDB application) is the
system of record for everything: vehicle intake, parts inventory, customer
requests, and outbound sync to sales channels.

```
                         ┌─────────────────────────────┐
                         │   autohubexpress.us (Wix)    │
                         │   public-facing website      │
                         └──────────────┬───────────────┘
                                        │
                 Part Request / Junk Car Request forms
                  (POST directly to the CRM API)
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        Autohub CRM Backend (Express)                  │
│                                                                        │
│  PartRequest / JunkCar  ──►  staff triage in CRM  ──►  Car Intake     │
│                                                            │           │
│                                                            ▼           │
│                                                    Inventory (parts)   │
│                                                            │           │
│                              ┌─────────────────────────────┼─────┐    │
│                              ▼                             ▼     ▼    │
│                     Wix Part Sync                    eBay Sync  ...   │
│                (push to autohubexpress.us)      (REST/Trading API)    │
└───────────────────────────────────────────────────────────────────────┘
```

The lifecycle in words:

1. A customer either **requests a part** or **requests to sell/junk a car**
   through the public website (or through the AI/WhatsApp automation bot).
   This creates a `PartRequest` or `JunkCar` document in MongoDB.
2. Staff triage these requests inside the CRM (status, remarks, source,
   assignment).
3. When a junk car request is accepted, staff move it into **Car Intake**
   (`movedToIntake` on the `JunkCar` document) — this is where the vehicle
   is actually dismantled and its individual parts are catalogued as
   **Inventory** records.
4. Once parts exist in `Inventory`, they become eligible for **outbound
   sync** to the sales channels the business lists on:
   - **Wix** (the `autohubexpress.us` website itself — parts become
     purchasable Wix Store products), and
   - **eBay** (via a separate REST/Trading API sync engine — see
     `services/ebay/`), and comparable integrations for other platforms
     (Amazon, social/marketplace leads, etc. under `services/adapters/`).
5. Sales/leads coming back from those channels (orders, conversations,
   marketplace leads) flow back into the CRM for staff to manage.

---

## 2. How the CRM Is Connected to autohubexpress.us

`autohubexpress.us` is a **Wix-hosted website**, not a separate application
this repo controls directly. The CRM backend and the Wix site talk to each
other over HTTP, in **both directions**, using shared secrets rather than
user logins:

### 2.1 CORS / network trust

`server.js` explicitly allow-lists the production website origins for CORS:

```js
const allowlist = [
  ...
  "https://autohubexpress.us",
  "https://www.autohubexpress.us",
];
```

This lets browser-side code running on the Wix site call the CRM API
directly (e.g. the Part Request / Junk Car Request forms — see section 4).

### 2.2 Website → CRM (public form submissions)

The simplest connection: the website's own request forms `POST` straight to
the CRM's public API endpoints (no API key needed for these two):

- `POST /api/part-request`
- `POST /api/junk-car`

### 2.3 CRM → Wix, via Wix's own backend code ("Velo")

The **canonical, currently-used mechanism for pushing inventory to the
website** is a custom backend HTTP function that lives *inside* the Wix
site itself (Wix calls this "Velo" — their in-site backend/serverless
layer). The CRM calls out to it:

```
POST {WIX_VELO_BASE_URL}/_functions/partSync
Body: { secret: PART_SYNC_SECRET, sku, price, brand, category, quantity,
        title, description, productImage, productImages, ... }
```

- `WIX_VELO_BASE_URL` and `PART_SYNC_SECRET` are environment variables.
- The Velo function runs *inside* the Wix site, so it has the Wix site
  context needed to actually create/update a real product in the site's
  Stores catalog — the CRM cannot do that directly over a generic REST
  call.
- This call/response contract is implemented in
  `services/wixPartSync.service.js` (`syncProductFieldsThroughVelo`), with
  retry-on-transient-failure handling (502/503/504/timeouts).

### 2.4 Wix → CRM, via a shared API key (`wixAuth`)

Separately, the CRM exposes a small set of endpoints under `/api/wix/*`
that are protected by `middleware/wixAuth.js`, which checks a
`x-wix-api-key` header against the `WIX_API_KEY` environment variable:

```js
router.get("/parts/sync", wixAuth, syncWithWix);
router.get("/parts/sync/v3", wixAuth, syncInventoriesV3);
router.post("/export/parts/deduplicated", wixAuth, exportAndSyncDeduplicated);
router.get("/collections/list", listWixCollections);
```

`controllers/wix.js` also contains an older, direct call to the real Wix
REST API (`https://www.wixapis.com`, using `WIX_API_KEY` as a bearer token
and `WIX_SITE_ID` as the site header) for reading the Stores "Products"
collection. This coexists with the Velo-based push mechanism described
above; the Velo path (`services/wixPartSync.service.js`) is the one
actually used by the current deduplicated sync flow.

### 2.5 Summary of the two shared secrets

| Secret | Direction | Purpose |
|---|---|---|
| `WIX_API_KEY` (+`WIX_SITE_ID`) | Incoming (Wix→CRM) auth for `/api/wix/*`, and outgoing CRM→wixapis.com REST calls | Confirms a request actually came from the Wix side / authenticates direct Wix REST API calls |
| `PART_SYNC_SECRET` | Outgoing (CRM→Wix Velo function) | Lets the CRM prove to the Velo function that a part-sync push is legitimate |

---

## 3. How Part Syncing Works (CRM → autohubexpress.us)

The canonical, current implementation lives in
`services/wixPartSync.service.js` (a refactor/extraction of what used to be
inline in `controllers/wix.js`'s `exportAndSyncDeduplicated`). It is
triggered on demand via the API routes in section 2.4 (there is **no
scheduled cron job for Wix** — unlike eBay, which does run on a 6-hour
cron; see `jobs/`).

### 3.1 Step by step

1. **Select eligible Inventory** (`fetchEligibleInventory`):
   - Not soft-deleted (`isDeleted != true`)
   - Not yet marked synced, OR marked synced but missing a valid
     `wixProductId` (so a partially-failed prior sync is retried).

2. **Exclude protected part types** — `windShield`, `a1`, and `a2` are
   filtered out via `utils/wixExportExclusions.js` (`isWixExcludedPart`).
   These parts stay in the CRM's Inventory but are never pushed to Wix (or
   eBay, which delegates to this same exclusion rule).

3. **Group into product identities** (`buildProductIdentity`, from
   `utils/productIdentity.js`) — multiple physical Inventory records for
   the *same* Year + Make + Model + Trim + Part Name are grouped into
   **one** Wix product, with `quantity` equal to how many matching
   Inventory records exist. (Earlier versions grouped without Trim, which
   incorrectly merged two different trims of the same part into one
   listing — this was corrected.)

4. **Resolve price and metadata**:
   - `resolvePartPrice` — price comes from a CSV price list
     (`assets/German_Cars_Price_List_20pct.csv`), differentiated by
     German vs. Standard vehicle classification
     (`isGermanVehicle`/`utils/vehicleClassification.js`), keyed by part
     name — not a manually-entered price per Inventory row.
   - `resolvePartMetadata` / `resolveTemplate` / `splitImageUrls`
     (`utils/partSyncMetadata.js`) — supplies description templates and
     product image URL(s) per part type.
   - `resolveWixPartCategory` — maps the CRM part name to a Wix
     merchant category/product type.

5. **Generate a deterministic SKU** (`generateSku`) — a SHA-256 hash of the
   canonical identity string, truncated to fit Wix's 40-character SKU
   limit. The same identity always produces the same SKU; it does **not**
   use the MongoDB `_id` or any randomness, so re-running the sync never
   changes a product's SKU.

6. **Decide create vs. update** — `resolveCurrentWixProductId` does a fresh
   database read at the moment each group is processed, matched by the
   group's *identity fields* (not by which specific Inventory `_id`s are in
   the group). This closes two races:
   - Two overlapping sync runs picking up the same not-yet-synced records.
   - A "restock" case: a Wix product already exists for this identity
     because an earlier run created it from a *different*, already-synced
     Inventory record.

7. **Push to Wix** via `syncProductFieldsThroughVelo` (section 2.3),
   retrying transient failures.

8. **Persist sync state only after Wix confirms success** — the underlying
   Inventory record(s) are marked `wixSynced: true` with the resulting
   `wixProductId` **only if** the Velo call succeeded. If the Wix call
   succeeds but the subsequent MongoDB write fails, this is recorded as a
   distinct `failed_after_wix_success` state (carrying the real, live
   `wixProductId`) rather than being silently lost — so it can be
   reconciled manually instead of creating an orphaned/duplicate Wix
   product on the next run.

9. **In-process per-identity locking** (`withIdentityLock`) serializes
   concurrent sync attempts for the same product identity within one Node
   process. This is documented as a single-process safeguard only — it
   does not protect against two separate server processes running at once
   (this app currently runs as a single `node server.js` process, with no
   clustering/PM2 config in the repo).

### 3.2 Other outbound syncs (for context)

The same `Inventory` collection also feeds a separate, independent sync
engine for **eBay** (`services/ebay/ebayCatalogSync.service.js` and
related files), which maps parts to eBay categories and publishes them via
either the eBay REST Inventory API or the eBay Trading API (for one
specific Motors category), on a 6-hour cron job
(`jobs/ebayCatalogSyncJob.js`) plus on-demand single-product sync. It uses
its own hash-based "unchanged" detection and the same `a1`/`a2`/`windShield`
exclusion rule, but is otherwise fully independent of the Wix pipeline —
neither can affect the other's sync state.

---

## 4. How Part Requests and Junk Car Requests Are Received by the CRM

Both request types are simple, publicly-reachable POST endpoints — the
website's own request forms call these directly (no login/API key
required for a normal customer submission). There is also a second intake
channel for the AI/WhatsApp automation bot, protected by a separate shared
API key.

### 4.1 Part Requests

- **Endpoint:** `POST /api/part-request` → `controllers/PartRequestController.js#createRequest`
- **Model:** `models/PartRequest.model.js`
- Validates that at least one of phone/email is present (phone must be 10
  digits if given; email must look like an email if given), and that a
  4-digit year is given if provided.
- Defaults `source` to `"Online"` if not specified by the caller.
- Saves a `PartRequest` document with fields: name, phone, email, make,
  model, year, partName, condition, message, source, status
  (`Pending` → `In Progress` → `Completed`/`Rejected`).
- **Automation bot channel:** `POST /api/part-request/automation-bot`,
  guarded by `middleware/automationBotAuth.js` (checks an
  `x-automation-bot-key` header against `AUTOMATION_BOT_API_KEY`, then
  attaches a seeded "Automation Bot" system user as `createdBy`). This is
  how the AI chatbot / WhatsApp integration
  (`services/adapters/whatsappAdapter.js`) creates part requests on a
  customer's behalf.
- Staff then manage these in the CRM: update `status`, `source`, and
  `remark` via `PATCH /api/part-request/:id`, `/source`, `/remark`.

### 4.2 Junk Car Requests

- **Endpoint:** `POST /api/junk-car` → `controllers/junkCar.controller.js#createJunkCarRequest`
- **Model:** `models/junkCar.model.js`
- Accepts name, email, phone, year (validated as 4 digits if given), make,
  model, engine/VIN, condition, and a free-text message.
- `source` is currently always normalized to `"website"` for this public
  endpoint.
- **Automation bot channel:** `POST /api/junk-car/automation-bot`, same
  `automationBotAuth` pattern as Part Requests, used by the chatbot/
  WhatsApp flow, and able to set a real `source` (Instagram/Facebook/
  TikTok/eBay/etc.) since it comes from an authenticated integration
  rather than a raw public form.
- Staff manage these from the CRM: `PATCH /:id/status`, `/:id/source`,
  `/:id/assign` (assign to a staff member), `/:id/remark`,
  `/:id/payment-status`.
- **Closing the loop into Inventory:** a `JunkCar` document has a
  `movedToIntake` flag. Once staff accept and schedule a junk car, it is
  converted into a **Car Intake** record (`controllers/carIntakeController.js`,
  `models/carInTake.model.js`) — this is the step where the vehicle is
  actually processed and its individual parts are catalogued as new
  `Inventory` records, which then become eligible for the Wix and eBay
  sync pipelines described in section 3.

### 4.3 Shared intake pattern

Both request types intentionally follow the same shape: public
unauthenticated form endpoint + parallel automation-bot endpoint + staff
CRM actions (status/source/remark/assignment) on top of a plain MongoDB
document with a `source` enum for attribution reporting (website,
Instagram, Facebook, TikTok, eBay, WhatsApp, SMS, other).

---

## 5. Key Files Reference

| Area | File |
|---|---|
| App entry / route mounting | `server.js` |
| Wix incoming-auth check | `middleware/wixAuth.js` |
| Automation bot auth | `middleware/automationBotAuth.js` |
| Wix legacy controller (direct Wix REST API + Velo push) | `controllers/wix.js` |
| Canonical Wix part sync engine | `services/wixPartSync.service.js` |
| Wix exclusion rule (a1/a2/windShield) | `utils/wixExportExclusions.js` |
| Part Request routes/controller/model | `routes/PartRequestRoutes.js`, `controllers/PartRequestController.js`, `models/PartRequest.model.js` |
| Junk Car routes/controller/model | `routes/junkCar.routes.js`, `controllers/junkCar.controller.js`, `models/junkCar.model.js` |
| Car Intake (vehicle → parts) | `controllers/carIntakeController.js`, `models/carInTake.model.js` |
| Inventory (parts catalog) | `models/Inventory.model.js`, `controllers/Inventory.controller.js` |
| eBay sync engine (comparison/context) | `services/ebay/ebayCatalogSync.service.js`, `services/ebay/ebayProductMapper.js`, `config/ebayCatalogConfig.js` |
