const mongoose = require("mongoose");
const PartRequest = require("../models/PartRequest.model");
const auditLogService = require("../services/auditLog.service");
const { normalizeRequestSource } = require("../utils/requestSources");
const {
    LEAD_CAPTURE_UPDATE_WINDOW_MS,
    EMAIL_PATTERN,
    PHONE_10_DIGITS,
    normalizers,
    pickLeadFields,
    resolveLeadId,
    hasValue,
    sendLeadError,
} = require("../utils/leadCapture");

// Field rules shared by the lead-capture route (POST /) and the staff PATCH
// route, so both validate a value the same way.
const PART_REQUEST_FIELD_RULES = {
    name: normalizers.text(),
    phone: normalizers.contact(PHONE_10_DIGITS, "Phone number must be 10 digits"),
    email: normalizers.contact(EMAIL_PATTERN, "Invalid email format"),
    make: normalizers.text(),
    model: normalizers.text(),
    year: normalizers.year(),
    partName: normalizers.text(),
    condition: normalizers.text(),
    message: normalizers.text(),
    remark: normalizers.text(),
    source: normalizers.oneOf(PartRequest.schema.path("source").enumValues),
    status: normalizers.oneOf(PartRequest.schema.path("status").enumValues),
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
//  - ownerId:     only a lead created by this user can be updated
//  - windowStart: only a lead created after this date can be updated
// A lead staff have started working (status no longer Pending) is never
// changed here. Returns { request } or { error: { status, message } }.
const updateCapturedPartRequest = async (leadId, values, { ownerId, windowStart } = {}) => {
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

    if (!hasValue(nextPhone) && !hasValue(nextEmail)) {
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
            // Same minimum as before: a lead needs a way to reach the customer.
            if (!hasValue(values.phone) && !hasValue(values.email)) {
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

const PART_REQUEST_BOT_RULES = {
    ...PART_REQUEST_FIELD_RULES,
    name: normalizers.requiredText(),
    source: (field, value) => normalizeRequestSource(value, "Other"),
};

// POST /api/part-request/automation-bot — part request from the AI Chatbot
// (Automation Bot); req.user is attached by middleware/automationBotAuth.js.
//  - no lead id -> create (unchanged behavior), respond 201 with its leadId
//  - lead id (body.leadId or X-Lead-ID header) -> update only the supplied
//    fields of a lead the bot itself created, while staff haven't started
//    working it; respond 200
exports.saveAutomationBotRequest = async (req, res) => {
    try {
        const { leadId } = resolveLeadId(req);

        if (leadId) {
            const values = pickLeadFields(req.body ?? {}, {
                rules: PART_REQUEST_BOT_RULES,
                fields: PART_REQUEST_BOT_FIELDS,
                ignore: ["leadId"],
            });

            const result = await updateCapturedPartRequest(leadId, values, { ownerId: req.user._id });

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

        // Phn, Email Validation — mirrors createRequest
        if (!phone && !email) {
            return res.status(400).json({
                success: false,
                message: "Either phone or email is required",
            });
        }

        if (phone && !/^[0-9]{10}$/.test(phone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must be 10 digits",
            });
        }

        if (email && !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format",
            });
        }

        let parsedYear = null;

        if (year) {
            const yearStr = year.toString().trim();

            if (!/^\d{4}$/.test(yearStr)) {
                return res.status(400).json({
                    success: false,
                    message: "Year must be exactly 4 digits",
                });
            }

            parsedYear = parseInt(yearStr, 10);
        }

        const resolvedSource = normalizeRequestSource(source, "Other");

        const request = await PartRequest.create({
            name: name || "none",
            phone: phone || "none",
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
    console.log("GET all part requests hit");

    try {
        console.log("Before find");

        const requests = await PartRequest.find()
            .sort({ createdAt: -1 })
            .populate("createdBy", "first_name last_name email role");

        console.log("After fing");

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
        const { source } = req.body;

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

        console.log("REMARK BODY:", req.body);
        console.log("PARAM ID:", req.params.id);

        const { remark } = req.body;

        const updated =
            await PartRequest.findByIdAndUpdate(
                req.params.id,
                { remark },
                { new: true }
            );

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
        const { status  } = req.body;

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
