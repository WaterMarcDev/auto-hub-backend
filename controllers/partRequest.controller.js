const mongoose = require("mongoose");
const PartRequest = require("../models/PartRequest.model");
const auditLogService = require("../services/auditLog.service");
const { ACTIVE_SOURCES, normalizeRequestSource } = require("../utils/requestSources");
const {
    PART_REQUEST_STATUSES,
    PART_REQUEST_VISIBLE_FILTER,
    toPartRequestStatus,
} = require("../utils/partRequestLeads");

// Sources a request can be given: "Online" (website form) and "Offline"
// (entered in the CRM) are set automatically at creation; staff can choose
// between the sources in use. Old values stay valid on existing records only.
const PART_REQUEST_SOURCES = ["Online", "Offline", ...ACTIVE_SOURCES];
const {
    LEAD_CAPTURE_UPDATE_WINDOW_MS,
    EMAIL_PATTERN,
    PHONE_10_DIGITS,
    formatUsPhone,
    LeadValidationError,
    normalizers,
    pickLeadFields,
    resolveLeadId,
    hasValue,
    hasAnyField,
    sendLeadError,
} = require("../utils/leadCapture");

// Field rules shared by the lead-capture route (POST /) and the staff PATCH
// route, so both validate a value the same way.
const MAX_REMARK_LENGTH = 500;

// Text limits and the Condition choices (same as the CRM form).
// Every source (website / bot / CRM); the CRM Name box is shorter (CRM_NAME_LENGTH).
const PART_REQUEST_LIMITS = { name: 100, email: 100, make: 30, model: 30, partName: 200, message: 500, condition: 50 };
const PART_REQUEST_CONDITIONS = ["New", "Used", "Damaged"];
const MIN_PART_REQUEST_YEAR = 1900;
// The CRM form's Name box is shorter than what website / bot leads may send
// (so no website lead is lost over a long name).
const CRM_NAME_LENGTH = 15;
// CRM form Email box (website / bot leads keep PART_REQUEST_LIMITS.email).
const CRM_EMAIL_LENGTH = 30;

// Trimmed text (inner spaces collapsed) of at most `max` characters.
const limitedText = (max, label) => (field, value) => {
    const text = normalizers.text()(field, value);
    const clean = typeof text === "string" ? text.replace(/\s+/g, " ") : text;
    if (clean && clean.length > max) {
        throw new LeadValidationError(`${label} can be at most ${max} characters`);
    }
    return clean;
};

// A 4-digit year from 1900 to the current year (no future years).
const partRequestYear = (field, value) => {
    const year = normalizers.year()(field, value);
    if (year === null || year === undefined) return year;
    const maxYear = new Date().getFullYear();
    if (year < MIN_PART_REQUEST_YEAR || year > maxYear) {
        throw new LeadValidationError(`Year must be from ${MIN_PART_REQUEST_YEAR} to ${maxYear}`);
    }
    return year;
};

// Condition: one of the choices is stored in its standard spelling ("used"
// -> "Used"); other text (website leads) is kept, within the length limit.
const partRequestCondition = (field, value) => {
    const text = limitedText(PART_REQUEST_LIMITS.condition, "Condition")(field, value);
    if (!text) return text;
    return PART_REQUEST_CONDITIONS.find((c) => c.toLowerCase() === text.toLowerCase()) || text;
};

// Email: valid format, at most PART_REQUEST_LIMITS.email characters.
const partRequestEmail = (field, value) => {
    const text = normalizers.contact(EMAIL_PATTERN, "Invalid email format")(field, value);
    if (text !== "none" && text.length > PART_REQUEST_LIMITS.email) {
        throw new LeadValidationError(`Email can be at most ${PART_REQUEST_LIMITS.email} characters`);
    }
    return text;
};

const PART_REQUEST_FIELD_RULES = {
    name: limitedText(PART_REQUEST_LIMITS.name, "Name"),
    // Any common US format; stored as "(XXX) XXX-XXXX".
    phone: normalizers.usPhone("Enter a 10-digit US phone number: (XXX) XXX-XXXX"),
    email: partRequestEmail,
    make: limitedText(PART_REQUEST_LIMITS.make, "Make"),
    model: limitedText(PART_REQUEST_LIMITS.model, "Model"),
    year: partRequestYear,
    partName: limitedText(PART_REQUEST_LIMITS.partName, "Part name"),
    condition: partRequestCondition,
    message: limitedText(PART_REQUEST_LIMITS.message, "Message"),
    remark: normalizers.text(),
    source: normalizers.oneOf(PART_REQUEST_SOURCES),
    // Only the settable statuses (utils/partRequestLeads.js).
    status: normalizers.oneOf(PART_REQUEST_STATUSES),
    fulfilledBy: normalizers.nullableText(),
};

// What the public form (website / CRM "Add Part Request") may send. Same set
// the old create handler accepted from its form; staff-only fields (remark,
// fulfilledBy) and system fields (createdBy, completedAt) are never taken
// from this route.
const PART_REQUEST_CAPTURE_FIELDS = [
    "name",
    "phone",
    "email",
    "make",
    "model",
    "year",
    "partName",
    "condition",
    "message",
    "source",
    "status",
];

const PART_REQUEST_POPULATE = { path: "createdBy", select: "first_name last_name email role" };

// Updates an already-captured lead with whitelisted `values`. Shared by the
// public capture route and the Automation Bot route.
//  - ownerId:        only a lead created by this user can be updated
//  - windowStart:    only a lead created after this date can be updated
//  - requireContact: the lead must keep a phone or email (public route)
// A lead staff have started working (status no longer Pending) is never
// changed here. Returns { request } or { error: { status, message } }.
const updateCapturedPartRequest = async (leadId, values, { ownerId, windowStart, requireContact = true } = {}) => {
    if (Object.keys(values).length === 0) {
        return { error: { status: 400, message: "No fields to update were provided" } };
    }

    const existing = await PartRequest.findById(leadId);

    if (!existing || (ownerId && String(existing.createdBy) !== String(ownerId))) {
        return { error: { status: 404, message: "Lead not found" } };
    }

    if (existing.status !== "Pending" || (windowStart && existing.createdAt < windowStart)) {
        return { error: { status: 409, message: "This lead can no longer be updated" } };
    }

    const nextPhone = "phone" in values ? values.phone : existing.phone;
    const nextEmail = "email" in values ? values.email : existing.email;

    if (requireContact && !hasValue(nextPhone) && !hasValue(nextEmail)) {
        return { error: { status: 400, message: "Either phone or email is required" } };
    }

    const filter = {
        _id: leadId,
        status: "Pending",
        ...(windowStart && { createdAt: { $gte: windowStart } }),
        ...(ownerId && { createdBy: ownerId }),
    };
    const updates = { ...values };

    // Stamp completedAt exactly once, matching updateStatus.
    if (values.status === "Completed" && !existing.completedAt) {
        updates.completedAt = new Date();
        filter.completedAt = null;
    }

    // The lock conditions are repeated in the filter so a status change
    // made by staff between the read above and this write still wins.
    const request = await PartRequest.findOneAndUpdate(
        filter,
        { $set: updates },
        { new: true, runValidators: true }
    ).populate(PART_REQUEST_POPULATE);

    if (!request) {
        return { error: { status: 409, message: "This lead can no longer be updated" } };
    }

    return { request };
};

const sendUpdateResult = (res, { request, error }) => {
    if (error) {
        return res.status(error.status).json({ success: false, message: error.message });
    }

    return res.json({
        success: true,
        operation: "updated",
        leadId: request._id,
        message: "Lead updated successfully",
        data: request,
    });
};

// POST /api/part-request — progressive lead capture for Search Part.
//  - no lead id            -> create the lead, respond 201 with its leadId
//  - lead id (body.leadId or X-Lead-ID header) -> update only the supplied
//    fields of that lead, respond 200
// Existing callers that never send a lead id keep getting a create, with the
// same validation and the same response fields (plus operation/leadId).
exports.savePartRequestLead = async (req, res) => {
    try {
        const { leadId } = resolveLeadId(req);

        const values = pickLeadFields(req.body ?? {}, {
            rules: PART_REQUEST_FIELD_RULES,
            fields: PART_REQUEST_CAPTURE_FIELDS,
            ignore: ["leadId"],
        });

        if (!leadId) {
            // Staff using the CRM "Add Part Request" form (logged in, source
            // "Offline"): Part Name is required; Name, phone and email are each
            // optional but at least one is needed to reach the customer; Name
            // at most 15 characters; Condition is one of the form's choices.
            const fromCrm = Boolean(req.user) && values.source === "Offline";
            if (fromCrm) {
                const bad = (text) => res.status(400).json({ success: false, message: text });
                if (!hasValue(values.partName)) return bad("Part name is required");
                if (hasValue(values.name) && values.name.length > CRM_NAME_LENGTH) {
                    return bad(`Name can be at most ${CRM_NAME_LENGTH} characters`);
                }
                if (hasValue(values.email) && values.email.length > CRM_EMAIL_LENGTH) {
                    return bad(`Email can be at most ${CRM_EMAIL_LENGTH} characters`);
                }
                if (!hasValue(values.name) && !hasValue(values.phone) && !hasValue(values.email)) {
                    return bad("Enter a name, phone or email");
                }
                if (hasValue(values.condition) && !PART_REQUEST_CONDITIONS.includes(values.condition)) {
                    return bad(`Condition must be one of: ${PART_REQUEST_CONDITIONS.join(", ")}`);
                }
            } else if (!hasValue(values.phone) && !hasValue(values.email)) {
                // Website leads: a lead needs a way to reach the customer.
                return res.status(400).json({
                    success: false,
                    message: "Either phone or email is required",
                });
            }

            const request = new PartRequest({
                ...values,
                email: values.email ?? "none",
                phone: values.phone ?? "none",
                source: values.source || "Online",
                ...(values.status === "Completed" && { completedAt: new Date() }),
            });

            await request.save();
            req.app.get("io")?.emit("badge:update");

            return res.status(201).json({
                success: true,
                operation: "created",
                leadId: request._id,
                message: "Request submitted successfully",
                data: request,
            });
        }

        // Only a freshly captured lead that staff haven't picked up yet can
        // be changed through this public route; everything else goes through
        // the authenticated PATCH /:id.
        const result = await updateCapturedPartRequest(leadId, values, {
            windowStart: new Date(Date.now() - LEAD_CAPTURE_UPDATE_WINDOW_MS),
        });

        return sendUpdateResult(res, result);
    } catch (error) {
        return sendLeadError(res, error, "SAVE PART REQUEST LEAD ERROR");
    }
};

// What the Automation Bot may send — the same fields its create has always
// read. Values are normalized the way the bot create does it: empty name /
// phone / email become "none" and an unknown source becomes "Other".
const PART_REQUEST_BOT_FIELDS = ["name", "phone", "email", "make", "model", "year", "partName", "source"];

// A bot create needs at least one of these. Phone/email are not compulsory
// for the bot; source alone doesn't count since the bot always sends it.
const PART_REQUEST_BOT_CREATE_FIELDS = PART_REQUEST_BOT_FIELDS.filter((field) => field !== "source");

const PART_REQUEST_BOT_RULES = {
    ...PART_REQUEST_FIELD_RULES,
    name: (field, value) => {
        const text = normalizers.requiredText()(field, value);
        return text === "none" ? text : limitedText(PART_REQUEST_LIMITS.name, "Name")(field, text);
    },
    source: (field, value) => normalizeRequestSource(value, "Other"),
};

// POST /api/part-request/automation-bot — part request from the AI Chatbot
// (Automation Bot); req.user is attached by middleware/automationBotAuth.js.
//  - no lead id -> create with at least one field, respond 201 with its leadId
//  - lead id (URL /automation-bot/:id, body.leadId or X-Lead-ID header) ->
//    update only the supplied fields of a lead the bot itself created, while
//    staff haven't started working it; respond 200
// Phone and email are optional on this route (create and update).
exports.saveAutomationBotRequest = async (req, res) => {
    try {
        const { leadId } = resolveLeadId(req);

        if (leadId) {
            const values = pickLeadFields(req.body ?? {}, {
                rules: PART_REQUEST_BOT_RULES,
                fields: PART_REQUEST_BOT_FIELDS,
                ignore: ["leadId"],
            });

            const result = await updateCapturedPartRequest(leadId, values, {
                ownerId: req.user._id,
                requireContact: false,
            });

            if (result.request) {
                await auditLogService.logAction({
                    action: "lead_updated",
                    userId: req.user._id,
                    userEmail: req.user.email,
                    platform: result.request.source,
                    entityType: "part_request",
                    entityId: result.request._id,
                    message: `Part request updated via Automation Bot (${Object.keys(values).join(", ")})`,
                    metadata: { fields: Object.keys(values) },
                });
            }

            return sendUpdateResult(res, result);
        }

        const { name, phone, email, make, model, year, partName, source } = req.body ?? {};

        if (!hasAnyField(req.body, PART_REQUEST_BOT_CREATE_FIELDS)) {
            return res.status(400).json({
                success: false,
                message: "At least one field is required to create a lead",
            });
        }

        // Phone / email are optional, but must be valid when sent
        if (phone && !formatUsPhone(phone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must be a 10-digit US number",
            });
        }

        if (email && !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format",
            });
        }

        // Same length limits as every other source; year 1900..current year.
        // (A LeadValidationError answers 400 with its message.)
        for (const field of ["name", "email", "make", "model", "partName"]) {
            if (req.body[field] !== undefined && req.body[field] !== null) {
                PART_REQUEST_BOT_RULES[field](field, req.body[field]);
            }
        }

        let parsedYear = null;

        if (year) {
            parsedYear = partRequestYear("year", typeof year === "number" ? year : String(year));
        }

        const resolvedSource = normalizeRequestSource(source, "Other");

        const request = await PartRequest.create({
            name: name || "none",
            phone: phone ? formatUsPhone(phone) : "none",
            email: email || "none",
            make,
            model,
            year: parsedYear,
            partName,
            source: resolvedSource,
            createdBy: req.user._id,
        });

        await auditLogService.logAction({
            action: "lead_created",
            userId: req.user._id,
            userEmail: req.user.email,
            platform: resolvedSource,
            entityType: "part_request",
            entityId: request._id,
            message: `Part request created via Automation Bot from ${resolvedSource}`,
        });

        req.app.get("io")?.emit("badge:update");

        res.status(201).json({
            success: true,
            operation: "created",
            leadId: request._id,
            message: "Request submitted successfully",
            data: request,
        });
    } catch (error) {
        return sendLeadError(res, error, "SAVE AUTOMATION BOT REQUEST ERROR");
    }
};

exports.getAllRequests = async (req, res) => {
    try {
        // Completed / Rejected requests are not wanted and are never listed
        // (utils/partRequestLeads.js).
        const requests = await PartRequest.find(PART_REQUEST_VISIBLE_FILTER)
            .sort({ createdAt: -1 })
            .populate("createdBy", "first_name last_name email role")
            .lean();

        res.json({
            success: true,
            data: requests
        });

    } catch (error) {
        console.error("GET Requests Error:", error);

        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Added by shiva : Source
exports.updatePartRequestSource = async (req, res) => {
    try {

        const { id } = req.params;
        const raw = req.body?.source?.toString().trim().toLowerCase();

        // Staff can only pick a source that is in use.
        const source = ACTIVE_SOURCES.find((s) => s.toLowerCase() === raw);
        if (!source) {
            return res.status(400).json({
                success: false,
                message: `Invalid source. Allowed values: ${ACTIVE_SOURCES.join(", ")}`,
            });
        }

        const updated = await PartRequest.findByIdAndUpdate(
            id,
            { source },
            { new: true }
        );

        res.json({
            success: true,
            data: updated,
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: "Error updating source"
        });
    }
};
// end here

// Update Remark by shiva
exports.updatePartRequestRemark = async (req, res) => {

    try {


        const { remark } = req.body ?? {};

        // Remark: text of at most 500 characters (blank clears it).
        if (remark !== undefined && remark !== null && typeof remark !== "string") {
            return res.status(400).json({ success: false, message: "Remark must be text" });
        }
        const cleanRemark = typeof remark === "string" ? remark.trim() : "";
        if (cleanRemark.length > MAX_REMARK_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Remark can be at most ${MAX_REMARK_LENGTH} characters`,
            });
        }
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        const updated =
            await PartRequest.findByIdAndUpdate(
                req.params.id,
                { remark: cleanRemark },
                { new: true }
            );
        if (!updated) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        res.status(200).json({
            success: true,
            data: updated,
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};
// end here


exports.updateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const status = toPartRequestStatus(req.body?.status);

        if (!status) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Allowed values: ${PART_REQUEST_STATUSES.join(", ")}`,
            });
        }

        const update = { status };

        // Stamp completedAt exactly once, the first time status becomes
        // "Completed" — later edits (e.g. remark changes) never touch it.
        if (status === "Completed") {
            const existing = await PartRequest.findById(id).select("completedAt");
            if (existing && !existing.completedAt) {
                update.completedAt = new Date();
            }
        }

        const request = await PartRequest.findByIdAndUpdate(
            id,
            update,
            { new: true }
        );

        res.json({
            success: true,
            data: request
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error updating status"
        });
    }
};

// Delete Request
exports.deleteRequest = async (req, res) => {
    try {
        const deleted = await PartRequest.findByIdAndDelete(req.params.id);

        if (!deleted) {
            return res.status(404).json({ message: "Request not found" });
        }

        res.json({ message: "Deleted successfully" });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: error.message });
    }
};

// PATCH /api/part-request/:id — authenticated staff edit of a Search Part
// (Part Request). Only the fields sent in the body are changed; everything
// else is left as-is. Unknown or system-managed fields (createdBy,
// completedAt, timestamps, _id) are rejected instead of silently ignored.
// Uses the same field rules as the lead-capture route above.
const PART_REQUEST_PATCHABLE_FIELDS = Object.keys(PART_REQUEST_FIELD_RULES);

exports.patchPartRequest = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid part request id",
            });
        }

        const body = req.body;

        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
            return res.status(400).json({
                success: false,
                message: "Request body must contain at least one field to update",
            });
        }

        const updates = pickLeadFields(body, {
            rules: PART_REQUEST_FIELD_RULES,
            fields: PART_REQUEST_PATCHABLE_FIELDS,
            rejectUnknown: true,
        });

        const request = await PartRequest.findById(id);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Part request not found",
            });
        }

        // Same rule as lead capture: a request must keep at least one way
        // to contact the customer.
        const nextPhone = "phone" in updates ? updates.phone : request.phone;
        const nextEmail = "email" in updates ? updates.email : request.email;

        if (("phone" in updates || "email" in updates) && !hasValue(nextPhone) && !hasValue(nextEmail)) {
            return res.status(400).json({
                success: false,
                message: "Either phone or email is required",
            });
        }

        // Stamp completedAt exactly once, matching updateStatus.
        if (updates.status === "Completed" && !request.completedAt) {
            updates.completedAt = new Date();
        }

        request.set(updates);
        await request.save();
        await request.populate(PART_REQUEST_POPULATE);

        res.json({
            success: true,
            message: "Part request updated successfully",
            data: request,
        });
    } catch (error) {
        return sendLeadError(res, error, "PATCH PART REQUEST ERROR");
    }
};
