const mongoose = require("mongoose");

// Shared building blocks for the progressive lead-capture APIs (Part Request
// / "Search Part" and Junk Car). Each controller declares its own field rules;
// this module only knows how to resolve the lead id, normalize individual
// values and turn a request body into a whitelisted update object.

// Lead id may arrive in the body (preferred) or in this header.
const LEAD_ID_HEADER = "x-lead-id";

// A lead created through the public capture route can only be updated through
// that same route for this long, and only while staff haven't started working
// it — so a leaked/guessed id can't be used to rewrite older leads.
const LEAD_CAPTURE_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;

class LeadValidationError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = "LeadValidationError";
        this.status = status;
    }
}

const isBlank = (value) => value === undefined || value === null || value === "";

const normalizeLeadId = (raw) => {
    const leadId = typeof raw === "string" ? raw.trim().toLowerCase() : raw;

    if (typeof leadId !== "string" || !leadId || !mongoose.Types.ObjectId.isValid(leadId) || !/^[0-9a-f]{24}$/.test(leadId)) {
        throw new LeadValidationError("Invalid lead ID");
    }

    return leadId;
};

// Lead id sources, in order: URL (/:id), body.leadId, X-Lead-ID header.
// Returns { leadId: null } when none was sent, { leadId } when a valid one was
// sent, or throws when one was sent but isn't a valid ObjectId (or the URL
// and body disagree).
const resolveLeadId = (req) => {
    const fromUrl = req.params ? req.params.id : undefined;
    const fromBody = req.body && typeof req.body === "object" ? req.body.leadId : undefined;

    if (!isBlank(fromUrl)) {
        const leadId = normalizeLeadId(fromUrl);

        if (!isBlank(fromBody) && normalizeLeadId(fromBody) !== leadId) {
            throw new LeadValidationError("Lead ID in the URL and body do not match");
        }

        return { leadId };
    }

    const raw = !isBlank(fromBody) ? fromBody : req.get(LEAD_ID_HEADER);

    if (isBlank(raw)) return { leadId: null };

    return { leadId: normalizeLeadId(raw) };
};

// Plain text. Numbers are accepted and stringified (Mongoose used to cast them
// on create); objects/arrays are rejected so operators like {"$gt": ""} can
// never reach a query or update.
const toText = (field, value) => {
    if (value === null) return "";
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value !== "string") {
        throw new LeadValidationError(`${field} must be a string`);
    }
    return value.trim();
};

const normalizers = {
    text: () => (field, value) => toText(field, value),

    // Optional text where empty means "not set" (stored as null).
    nullableText: () => (field, value) => toText(field, value) || null,

    // Schema-required text: empty falls back to the "none" placeholder the
    // create handlers have always stored.
    requiredText: () => (field, value) => toText(field, value) || "none",

    year: () => (field, value) => {
        if (value === null || value === "") return null;

        const yearStr = toText(field, value);

        if (!/^\d{4}$/.test(yearStr)) {
            throw new LeadValidationError("Year must be exactly 4 digits");
        }

        return parseInt(yearStr, 10);
    },

    // Contact fields: empty / "none" -> "none"; otherwise must match pattern.
    contact: (pattern, message) => (field, value) => {
        const text = toText(field, value);

        if (!text || text.toLowerCase() === "none") return "none";

        if (pattern && !pattern.test(text)) {
            throw new LeadValidationError(message);
        }

        return text;
    },

    // Case/whitespace-tolerant enum match. `map` lets a caller supply aliases
    // (lower-cased input -> stored value); otherwise `allowed` is matched
    // case-insensitively and the canonical casing is stored.
    oneOf: (allowed, { map, label } = {}) => (field, value) => {
        const text = toText(field, value).toLowerCase();
        const matched = map
            ? map[text]
            : allowed.find((option) => option.toLowerCase() === text);

        if (!matched) {
            throw new LeadValidationError(
                `Invalid ${field}. Allowed values: ${(label || allowed).join(", ")}`
            );
        }

        return matched;
    },
};

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const PHONE_10_DIGITS = /^[0-9]{10}$/;

// Builds a whitelisted update object from `body`.
//  - rules:  { field: normalizer } — only these fields can ever be written
//  - fields: subset of rule keys allowed for this call
//  - rejectUnknown: true -> any other key is a 400 (staff PATCH API);
//                   false -> other keys are ignored (public capture route,
//                   which has always tolerated extra form fields)
//  - ignore: keys that are never "unknown" (e.g. leadId)
// Missing keys are left out of the result, so they never overwrite stored
// values.
const pickLeadFields = (body, { rules, fields, rejectUnknown = false, ignore = [] }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new LeadValidationError("Request body must be a JSON object");
    }

    if (rejectUnknown) {
        const unknown = Object.keys(body).filter(
            (key) => !fields.includes(key) && !ignore.includes(key)
        );

        if (unknown.length > 0) {
            const error = new LeadValidationError(
                `These fields cannot be updated: ${unknown.join(", ")}`
            );
            error.allowedFields = fields;
            throw error;
        }
    }

    const values = {};

    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === undefined) continue;
        values[field] = rules[field](field, body[field]);
    }

    return values;
};

const hasValue = (value) => !isBlank(value) && value !== "none";

// True when at least one of `fields` in a raw request body carries a real
// value (not missing, empty, whitespace-only or the "none" placeholder).
const hasAnyField = (body, fields) =>
    !!body &&
    typeof body === "object" &&
    fields.some((field) => {
        const value = body[field];
        return hasValue(typeof value === "string" ? value.trim() : value);
    });

const sendLeadError = (res, error, logLabel) => {
    if (error instanceof LeadValidationError) {
        return res.status(error.status).json({
            success: false,
            message: error.message,
            ...(error.allowedFields && { allowedFields: error.allowedFields }),
        });
    }

    // Mongoose validation/cast problems are client errors, but their messages
    // expose schema internals — answer with a generic message and log details.
    if (error && (error.name === "ValidationError" || error.name === "CastError")) {
        console.error(`${logLabel}:`, error.message);
        return res.status(400).json({
            success: false,
            message: "One or more fields have an invalid value",
        });
    }

    console.error(`${logLabel}:`, error);
    return res.status(500).json({
        success: false,
        message: "Something went wrong. Please try again.",
    });
};

module.exports = {
    LEAD_ID_HEADER,
    LEAD_CAPTURE_UPDATE_WINDOW_MS,
    LeadValidationError,
    EMAIL_PATTERN,
    PHONE_10_DIGITS,
    normalizers,
    pickLeadFields,
    resolveLeadId,
    hasValue,
    hasAnyField,
    sendLeadError,
};
