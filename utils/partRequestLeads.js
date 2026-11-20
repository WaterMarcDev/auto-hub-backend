// Shared rules for Part Requests (leads).
const { statusRegex } = require("./junkCarLeads");

// Statuses a part request can be set to.
const PART_REQUEST_STATUSES = ["Pending", "Lead Converted", "Lead Lost", "Lead Closed"];

// Retired statuses still valid on existing records (shown until changed).
const PART_REQUEST_LEGACY_STATUSES = ["In Progress"];

// Part requests with these statuses are not wanted and are left out of Part
// Requests (and its badge count). scripts/removeCompletedRejectedLeads.js
// deletes them from the database.
const PART_REQUEST_REMOVED_STATUSES = ["Completed", "Rejected"];

// Every value the schema accepts, so existing records keep validating.
const PART_REQUEST_ALL_STATUSES = [
    ...PART_REQUEST_STATUSES,
    ...PART_REQUEST_LEGACY_STATUSES,
    ...PART_REQUEST_REMOVED_STATUSES,
];

// Query condition: requests that are NOT removed (missing status included).
const PART_REQUEST_VISIBLE_FILTER = { status: { $not: statusRegex(PART_REQUEST_REMOVED_STATUSES) } };

// Canonical spelling of a settable status ("lead lost" -> "Lead Lost"), or
// null when it is not one.
const toPartRequestStatus = (value) => {
    const text = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
    return PART_REQUEST_STATUSES.find((s) => s.toLowerCase() === text) || null;
};

module.exports = {
    PART_REQUEST_STATUSES,
    PART_REQUEST_LEGACY_STATUSES,
    PART_REQUEST_REMOVED_STATUSES,
    PART_REQUEST_ALL_STATUSES,
    PART_REQUEST_VISIBLE_FILTER,
    toPartRequestStatus,
};
