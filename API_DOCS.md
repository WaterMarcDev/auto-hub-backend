# AutoHub API Documentation (Complete Reference)

This document describes the backend HTTP API for the AutoHub application. It includes every public route implemented under the `routes/` folder, required authentication, request shapes, query parameters, and example responses.

Notes:

- Authentication uses httpOnly JWT cookie (cookie name `token`) or Authorization header `Bearer <token>`.
- Most endpoints require authentication. Where an endpoint requires an admin user, the docs will indicate `Admin`.
- All endpoints return JSON unless otherwise specified.

---

## Table of Contents

- [Authentication](#authentication)
- [Users (Admin)](#users-admin)
- [Car Intake](#car-intake)
- [Transactions](#transactions)
- [Uploads](#uploads)
- [VIN Decoder](#vin-decoder)
- [Makes / Models / Trims](#makes--models--trims)
- [Parts](#parts)
- [Elements](#elements)
- [Scrap Elements](#scrap-elements)
- [Inventory](#inventory)
- [Buyers](#buyers)
- [Waivers](#waivers)
- [Automation Bot (Chatbot Lead Ingestion)](#automation-bot-chatbot-lead-ingestion)

---

## Conventions

- All endpoints are rooted at `/api` (unless explicitly served at `/uploads` which is static).
- Standard success response uses `200` or `201` with a JSON body. Errors use `4xx` or `5xx` with `{ error: "message" }`.
- Pagination uses `?page` and `?limit` query params. Defaults: page=1, limit varies (usually 10).

---

## Authentication

Base path: `/api/auth`

### Register

- POST /api/auth/register
- Public
- Body (JSON):
  {
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "password": "SecurePass123!",
  "role": "staff" // optional, defaults to "staff"
  }
- Success: 201, returns created user (without password)

### Login

- POST /api/auth/login
- Public
- Body:
  { "email": "john@example.com", "password": "SecurePass123!" }
- Success: 200, sets httpOnly cookie `token` and returns user object

### Profile

- GET /api/auth/profile
- Private (authenticated)
- Success: 200, returns { user: <user object> }

### Logout

- POST /api/auth/logout
- Private
- Clears the `token` cookie and returns { message: "Logged out successfully" }

---

## Users (Admin)

Base path: `/api/users` (requires authentication + admin role)

- GET /api/users

  - Get all users (paginated)
  - Success: 200 { success:true, count, users: [] }

- GET /api/users/:id

  - Get a single user by id
  - Success: 200 { success: true, user }

- PUT /api/users/:id

  - Update user fields (first_name, last_name, email, role)
  - Success: 200 { success: true, message: "User updated successfully", user }

- DELETE /api/users/:id
  - Delete user (admin only) - soft or hard depending on implementation
  - Success: 200 { success: true, message: "User deleted successfully" }

---

## Car Intake

Base path: `/api/car-intake` (authenticated)

Endpoints:

- POST /api/car-intake

  - Create a car intake. Accepts form data and file uploads (images) via `upload.any()`.
  - Body: multipart/form-data fields (vin, year, make, model, sellerData, etc.) or JSON.
  - If `sellerData` provided, the flow will create Seller, CarIntake and optionally Transaction if payment info included.
  - Success: 201 created (or 200 if draft exists) with carIntake object and related seller/transaction.

- GET /api/car-intake

  - Query params: page, limit, status (single or comma separated), make, year, search
  - Response includes carIntakes array and pagination

- GET /api/car-intake/:id

  - Get single car intake with populated seller and transaction

- PUT /api/car-intake/:id

  - Update car intake (complex mapping of incoming flat fields into nested model)
  - Handles seller updates, payment/transaction synchronization

- PATCH /api/car-intake/:id/status

  - Body: { status: "new-status" }
  - Validates status against model enum. If status is `scraped`, also sets scrapedBy and scrapDate

- DELETE /api/car-intake/:id

  - Soft-delete (sets isActive = false) and also soft-deletes related transactions

- GET /api/car-intake/stats

  - Query params: startDate, endDate
  - Returns aggregation stats grouped by status, totals

- POST /api/car-intake/bulk-upload

  - Body: { fileUrl: "/uploads/filename.xlsx" }
  - File must exist in `/uploads/` directory
  - Accepts many Excel header variants (VIN required). Returns summary: successful/failed/skipped

- POST /api/car-intake/bulk-upload-scraped
  - Like bulk-upload but expects a sheet named `GONE` and maps custom columns

Notes and validation details:

- VIN normalization, status computation, seller creation logic, and flexible incoming field handling are implemented in the controller. See code for exact field names and mapping.

---

## Transactions

Base path: `/api/transactions` (authenticated)

- POST /api/transactions

  - Body validation: type (debit|credit), amount (float>0), paymentMethod (Cash|Bank Transfer|Zelle)
  - Creates a transaction
  - Success: 201 { message, transaction }

- GET /api/transactions

  - Query params: page, limit, type, status, paymentMethod, startDate, endDate
  - Returns paginated transactions

- GET /api/transactions/:id

  - Get single transaction

- PUT /api/transactions/:id

  - Update transaction

- PATCH /api/transactions/:id/status

  - Body: { status: "pending|completed|failed|cancelled" }

- DELETE /api/transactions/:id

  - Soft delete (isActive=false)

- GET /api/transactions/car-intake/:carIntakeId

  - Get transactions related to a specific car intake

- GET /api/transactions/seller/:sellerId

  - Get transactions for a seller

- GET /api/transactions/stats
  - Query params: startDate, endDate, type
  - Returns aggregation by type/status/paymentMethod and daily stats

---

## Uploads

Base path: `/api/upload` (authenticated for most actions)

- POST /api/upload/image

  - Upload single file under field name `image` (images and Excel allowed)
  - Returns { message, imageUrl, filename, originalName, size, mimetype }

- POST /api/upload/multiple

  - Upload multiple images under field `images` (limit 10)
  - Returns array with file info

- DELETE /api/upload/:filename

  - Deletes file from `/uploads` directory

- GET /api/upload/:filename
  - Serves uploaded file (public)

Notes:

- Uploads are stored in `uploads/` and served statically at `/uploads` by the server.

---

## VIN Decoder

Base path: `/api/vin` (authenticated)

- GET /api/vin/:vinNumber
  - Validates VIN format (17 characters, no I,O,Q)
  - If VIN exists in DB, returns stored vinDetails and carIntake
  - Otherwise calls NHTSA VPIC API and maps fields into carDetails, stores vinDetails and returns them
  - Responses include `source` (database or MarketCheck/NHTSA) and `timestamp`

Error cases include invalid VIN format, service timeout/unavailable, or VIN not decoded.

---

## Makes / Models / Trims

These endpoints typically require authentication (admin-level in controllers).

### Makes

Base path: `/api/make` (controller uses paths like `/api/make`)

- POST /api/make

  - Create new make: { name, shortName, description }
  - Success: 201 returns make

- GET /api/make

  - Paginated list: supports `?page`, `?limit`, `?search`

- GET /api/make/:id

  - Get make by id

- PUT /api/make/:id

  - Update make

- DELETE /api/make/:id
  - Soft delete (isDeleted = true)

### Models

Base path: `/api/model`

- POST /api/model

  - Create model: { name, make, shortName, description }

- GET /api/model

  - Paginated

- GET /api/model/:id

  - Get model by id

- PUT /api/model/:id
  - Update model

### Trims

Base path: `/api/trim`

- POST /api/trim

  - Create trim

- GET /api/trim

  - List trims with `?make` and `?model` filters

- GET /api/trim/:id

  - Get trim by id

- PUT /api/trim/:id
  - Update trim

---

## Parts

Base path: `/api/part`

- POST /api/part

  - Create part: { name, shortName, unit, weight, dimensions, image, description }

- GET /api/part

  - List paginated

- GET /api/part/:id

  - Get single part

- PUT /api/part/:id

  - Update part

- DELETE /api/part/:id
  - Soft delete

---

## Elements

Base path: `/api/element`

- POST /api/element

  - Create element

- GET /api/element

  - List elements (paginated, search)

- GET /api/element/:id

  - Get element details

- PUT /api/element/:id
  - Update element

---

## Scrap Elements

Base path: `/api/scrap-element`

- POST /api/scrap-element

  - Create scrap element record: requires `elementName` and `vin` (unit optional)
  - Public (no auth in route)

- GET /api/scrap-element/vin/:vin
  - Get scrap elements by VIN

---

## Inventory

Base path: `/api/inventory` (authenticated)

- POST /api/inventory

  - Create inventory item. Accepts make/model/trim as id or name. Creates reference docs if not found.
  - Returns created inventory with `tag` computed server-side

- GET /api/inventory/parts

  - Master parts list: query params include make/model/trim/cleaned/quality/search
  - Returns reduced fields suitable for lookup/autocomplete

- GET /api/inventory/vin/:vin

  - Get inventory items by VIN

- GET /api/inventory
  - Get all inventories (paginated)

---

## Buyers

Base path: `/api/buyers` (authenticated)

- POST /api/buyers

  - Create a buyer: { firstName, lastName, mobileNo, email }

- GET /api/buyers

  - List buyers (paginated, search)

- GET /api/buyers/:id

  - Get buyer details

- PUT /api/buyers/:id

  - Update buyer

- DELETE /api/buyers/:id
  - Soft delete buyer

Note: Buyer documents include `isDeleted` (Boolean) and `deletedAt` (Date). List and GET endpoints exclude soft-deleted buyers by default.

---

## Waivers

Base path: `/api/waivers` (authenticated)

- POST /api/waivers

  - Create waiver. Request supports either seller or buyer flows depending on `customerType`.
  - Body contains either `sellerId` or `sellerData` (or buyerId/buyerData when `customerType` is `buyer`). Optionally `transactionData` to create a payment transaction.
  - Validates `customerType` in ["seller","buyer"]
  - Success: 201 { message: "Waiver created successfully", waiver, seller?, buyer?, transaction? }

- GET /api/waivers

  - List waivers with search, filtering by sellerId/buyerId, date range

- GET /api/waivers/:id

  - Get waiver details

- PUT /api/waivers/:id

  - Update waiver; supports updating or creating linked transaction

- DELETE /api/waivers/:id

  - Soft delete waiver (controller now sets `isDeleted=true` and `deletedAt`)

  Note: The `Waiver` model now includes `isDeleted` (Boolean) and `deletedAt` (Date). GET/list endpoints exclude soft-deleted waivers by default.

- GET /api/waivers/seller/:sellerId

  - Get waivers for a seller

- GET /api/waivers/buyer/:buyerId

  - Get waivers for a buyer

- GET /api/waivers/stats
  - Returns summary counts, by id proof type, recent waivers etc.

---

## Soft-delete behavior (current implementation)

The backend uses soft deletes for most user-visible resources. This section summarizes the current behavior, fields added to schemas, which endpoints perform soft deletes vs hard deletes, and recommendations for standardization.

Fields added / in-use across models:

- `isDeleted` (Boolean) — preferred canonical flag for soft-deleted documents. When true the document is considered deleted and should be excluded from normal list/get responses.
- `deletedAt` (Date) — timestamp set when a document is soft-deleted.
- `deleted` (Boolean) — legacy flag used by the `Part` model and some older code paths. New deletions on parts set both `deleted` and `isDeleted` for compatibility.
- `isActive` (Boolean) — used in many models to indicate active/inactive status; controllers sometimes set `isActive=false` when soft-deleting.

Endpoints using soft-delete (controller sets `isDeleted=true`, `deletedAt=Date.now()` and often `isActive=false`):

- Buyers: DELETE /api/buyers/:id — soft-delete (isActive=false, isDeleted=true, deletedAt)
- Makes: DELETE /api/make/:id — soft-delete (isDeleted=true, deletedAt)
- Parts: DELETE /api/part/:id — soft-delete (deleted=true, isDeleted=true, deletedAt)
- Sellers: DELETE /api/sellers/:id — soft-delete (isActive=false, isDeleted=true, deletedAt)
- Car Intakes: DELETE /api/car-intake/:id — soft-delete (isActive=false, isDeleted=true, deletedAt) and cascades to related transactions (they are soft-deleted via updateMany)
- Transactions: DELETE /api/transactions/:id — controller sets isActive=false; Transaction model also includes `isDeleted` for future alignment

Endpoints that currently perform hard deletes (consider converting to soft-delete if you want recoverability):

- Users: DELETE /api/users/:id — currently documented as delete; implementation may use hard delete in the controller.
- Waivers: DELETE /api/waivers/:id — currently implemented as a hard delete (findByIdAndDelete)

Querying and controller notes:

- List and get endpoints were updated to exclude soft-deleted documents (e.g. filtering with `isDeleted: { $ne: true }` or checking `isActive`). Some older endpoints/models still rely on `deleted` or `isActive` for compatibility.
- Part endpoints explicitly check both `deleted` and `isDeleted` to avoid breaking older clients.

Recommendations:

- Standardize on `isDeleted` + `deletedAt` as the single soft-delete contract across all models and update controllers to use them consistently.
- Replace hard-delete calls (`findByIdAndDelete`, `findOneAndDelete`, etc.) with a shared soft-delete helper or Mongoose plugin that sets `isDeleted`, `deletedAt`, and optionally `isActive=false` and `updatedBy`.
- Consider adding helper query methods (e.g., `Model.findActive()` or a global query filter) or a small plugin to reduce duplication and prevent accidental hard-deletes.

## Automation Bot (Chatbot Lead Ingestion)

Base path: `/api/part-request`

Lets the AI Chatbot (integrated across Website, Instagram, Facebook, WhatsApp, TikTok, eBay, Google Business, SMS, etc.) create part-request leads in the CRM automatically, attributed to the seeded "Automation Bot" system user. These records appear on the existing Part Requests page exactly like manually-submitted ones, with `createdBy` populated to the Automation Bot user and `source` reflecting the originating platform.

### Create request (bot)

- POST /api/part-request/automation-bot
- Requires header `x-automation-bot-key: <AUTOMATION_BOT_API_KEY>` (see `.env` and `middleware/automationBotAuth.js`)
- Body (JSON):
  {
  "name": "Jane Doe",
  "phone": "5551234567",
  "email": "jane@example.com",
  "make": "Toyota",
  "model": "Camry",
  "year": "2016",
  "partName": "Alternator",
  "source": "WhatsApp"
  }
- `source` must be one of: `Website`, `Instagram`, `Facebook`, `WhatsApp`, `TikTok`, `eBay`, `Google Business`, `SMS`, `Other` — unrecognized/missing values default to `Other`.
- Success: 201, returns the created `PartRequest` document with `createdBy` set to the Automation Bot's user ID.
- Errors: 401 (invalid/missing bot key), 400 (missing phone+email, invalid phone/email format, or malformed year).
- Setup: run `npm run seed:automation-bot` once per environment to create the Automation Bot user before using this endpoint.

### One-time setup

1. Set `AUTOMATION_BOT_API_KEY` and `AUTOMATION_BOT_EMAIL` in `.env`.
2. Run `npm run seed:automation-bot` to create the "Automation Bot" User (visible in the Users admin page, role `automation`).
3. Give the chatbot integration the `AUTOMATION_BOT_API_KEY` value to send as `x-automation-bot-key`.

---

## Static Uploads

- Files in `/uploads` are served statically at `/uploads/*`.

---

## Error Handling

- The server responds with JSON errors. Example:
  {
  "error": "Validation failed",
  "details": [ ... ]
  }
- 404 handler returns { error: "Route not found" }

---

## Quick Start (developer)

1. From the repo root start the backend:

```bash
cd backend
npm install
npm run dev
```

2. Open docs: http://localhost:5000/ (this renders this markdown as HTML)

---

If you want this rendered to OpenAPI/Swagger format, I can generate an OpenAPI v3 YAML/JSON from these endpoints and types — tell me which format you prefer (JSON/YAML) and whether you want it added as `/api-docs` with Swagger UI.
