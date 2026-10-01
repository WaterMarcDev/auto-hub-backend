const mongoose = require("mongoose");
const PartRequest = require("../models/PartRequest.model");
const auditLogService = require("../services/auditLog.service");
const { normalizeRequestSource } = require("../utils/requestSources");

exports.createRequest = async (req, res) => {
    console.log("Create part request hit");

    try { 
        //Phn, Email Validation by shiva
        const { phone, email } = req.body;

        // Both empty -> Reject
        if (!phone && !email) {
            return res.status(400).json({
                success: false,
                message: "Either phone or email is required",
            });
        }

        // If phone is provided -> Validate it
        if (phone && !/^[0-9]{10}$/.test(phone)) {
            return res.status(400).json({
                success: false,
                message: "Phone number must be 10 digits",
            });
        }

        // If email is provided -> Validate it
        if (email && !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format",
            });
        } // end here

        // added by shiva
        let parsedYear = null;

        if (req.body.year) {
            const yearStr = req.body.year.toString().trim();

            if (!/^\d{4}$/.test(yearStr)) {
                return res.status(400).json({
                    success: false,
                    message: "Year must be exactly 4 digits",
                });
            }

            parsedYear = parseInt(yearStr, 10);
        }
        //end here

        const request = new PartRequest({
            ...req.body,
            email: req.body.email || "none",   // if email not provided then value will be none
            phone: req.body.phone || "none",   // if phone not provided then value will be none
            source: req.body.source || "Online"  // default value of source
        });

        await request.save();

        res.status(201).json({
            success: true,
            message: "Request submitted successfully",
            data: request
        });
    } catch (error) {
        console.error("CREATE PART REQUEST ERROR:", error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Create part request from the AI Chatbot (Automation Bot) — req.user is
// attached by middleware/automationBotAuth.js
exports.createAutomationBotRequest = async (req, res) => {
    try {
        const { name, phone, email, make, model, year, partName, source } = req.body;

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
            message: "Request submitted successfully",
            data: request,
        });
    } catch (error) {
        console.error("CREATE AUTOMATION BOT REQUEST ERROR:", error);
        res.status(500).json({
            success: false,
            message: error.message,
        });
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

// PATCH /api/part-request/:id — partial update of a Search Part (Part
// Request). Only the fields sent in the body are changed; everything else is
// left as-is. Unknown or system-managed fields (createdBy, completedAt,
// timestamps, _id) are rejected instead of silently ignored.
const PART_REQUEST_PATCHABLE_FIELDS = [
    "name",
    "phone",
    "email",
    "make",
    "model",
    "year",
    "partName",
    "condition",
    "message",
    "remark",
    "source",
    "status",
    "fulfilledBy",
];

// Case/whitespace-tolerant match against a schema enum, e.g. "in progress"
// -> "In Progress". Returns null when there is no match.
const matchEnumValue = (value, allowed) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().toLowerCase();
    return allowed.find((option) => option.toLowerCase() === trimmed) || null;
};

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

        const unknownFields = Object.keys(body).filter(
            (key) => !PART_REQUEST_PATCHABLE_FIELDS.includes(key)
        );

        if (unknownFields.length > 0) {
            return res.status(400).json({
                success: false,
                message: `These fields cannot be updated: ${unknownFields.join(", ")}`,
                allowedFields: PART_REQUEST_PATCHABLE_FIELDS,
            });
        }

        const updates = {};

        for (const field of PART_REQUEST_PATCHABLE_FIELDS) {
            if (!(field in body)) continue;

            const value = body[field];

            if (field === "year") {
                if (value === null || value === "") {
                    updates.year = null;
                    continue;
                }

                const yearStr = value.toString().trim();

                if (!/^\d{4}$/.test(yearStr)) {
                    return res.status(400).json({
                        success: false,
                        message: "Year must be exactly 4 digits",
                    });
                }

                updates.year = parseInt(yearStr, 10);
                continue;
            }

            if (value !== null && typeof value !== "string") {
                return res.status(400).json({
                    success: false,
                    message: `${field} must be a string`,
                });
            }

            const trimmed = typeof value === "string" ? value.trim() : value;

            if (field === "phone" || field === "email") {
                // Empty clears the field back to the same "none" placeholder
                // createRequest stores when it isn't provided.
                if (!trimmed || trimmed.toLowerCase() === "none") {
                    updates[field] = "none";
                    continue;
                }

                if (field === "phone" && !/^[0-9]{10}$/.test(trimmed)) {
                    return res.status(400).json({
                        success: false,
                        message: "Phone number must be 10 digits",
                    });
                }

                if (field === "email" && !/^\S+@\S+\.\S+$/.test(trimmed)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid email format",
                    });
                }

                updates[field] = trimmed;
                continue;
            }

            if (field === "source" || field === "status") {
                const allowed = PartRequest.schema.path(field).enumValues;
                const matched = matchEnumValue(trimmed, allowed);

                if (!matched) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid ${field}. Allowed values: ${allowed.join(", ")}`,
                    });
                }

                updates[field] = matched;
                continue;
            }

            if (field === "fulfilledBy") {
                updates.fulfilledBy = trimmed || null;
                continue;
            }

            updates[field] = trimmed ?? "";
        }

        const request = await PartRequest.findById(id);

        if (!request) {
            return res.status(404).json({
                success: false,
                message: "Part request not found",
            });
        }

        // Same rule as createRequest: a request must keep at least one way
        // to contact the customer.
        const nextPhone = "phone" in updates ? updates.phone : request.phone;
        const nextEmail = "email" in updates ? updates.email : request.email;
        const hasContact = (v) => v && v !== "none";

        if (("phone" in updates || "email" in updates) && !hasContact(nextPhone) && !hasContact(nextEmail)) {
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
        await request.populate("createdBy", "first_name last_name email role");

        res.json({
            success: true,
            message: "Part request updated successfully",
            data: request,
        });
    } catch (error) {
        console.error("PATCH PART REQUEST ERROR:", error);

        if (error.name === "ValidationError" || error.name === "CastError") {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }

        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};
