// Shared rules for Junk Car Requests (leads).

// Statuses a lead can be set to. Stored lowercase.
const JUNK_CAR_STATUSES = [
    "pending",
    "lead converted",
    "lead lost",
    "lead closed",
];

// Retired statuses. Leads still carrying one of these stay valid and are
// shown with it until someone picks a new status.
const JUNK_CAR_LEGACY_STATUSES = ["in progress"];

// Leads with these statuses are not wanted and are left out of Junk Car
// Requests (and its badge count). scripts/removeCompletedRejectedLeads.js
// deletes them from the database.
const JUNK_CAR_REMOVED_STATUSES = ["completed"];

// Default list order: open work first; Lead Converted / Lead Closed at the
// bottom. Leads are never hidden by status, only filtered.
const JUNK_CAR_STATUS_ORDER = {
    pending: 1,
    "in progress": 2,
    "lead lost": 3,
    "lead converted": 5,
    "lead closed": 6,
};

// Staff members always offered in the Junk Car Requests Staff filter and
// assignment dropdown, matched to user accounts by first + last name
// (whatever their role). Other users with the "staff" role are listed after
// them. Keep in sync with NAMED_STAFF in the frontend JunkCarRequests.jsx,
// which shows these names even before their accounts exist.
const JUNK_CAR_NAMED_STAFF = [
    { first_name: "Ankit", last_name: "Dewan" },
    { first_name: "Jaspreet", last_name: "Singh" },
    { first_name: "Vijay", last_name: "Kumar" },
];

const normalizeJunkCarStatus = (value) =>
    typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case/space-insensitive match for any of `statuses`, e.g. "Completed",
// " completed ".
const statusRegex = (statuses) =>
    new RegExp(`^\\s*(${statuses.map((s) => escapeRegex(s).replace(/ /g, "\\s+")).join("|")})\\s*$`, "i");

// Query condition: leads that are NOT removed (missing status included).
const JUNK_CAR_VISIBLE_FILTER = { status: { $not: statusRegex(JUNK_CAR_REMOVED_STATUSES) } };

module.exports = {
    JUNK_CAR_STATUSES,
    JUNK_CAR_LEGACY_STATUSES,
    JUNK_CAR_REMOVED_STATUSES,
    JUNK_CAR_STATUS_ORDER,
    JUNK_CAR_NAMED_STAFF,
    JUNK_CAR_VISIBLE_FILTER,
    normalizeJunkCarStatus,
    statusRegex,
};
