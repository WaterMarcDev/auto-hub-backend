const mongoose = require("mongoose");
const JunkCar = require("../models/JunkCar.model");
const CarIntake = require("../models/CarIntake.model");  // by shiva
const User = require("../models/User.model");
const {
    LEAD_CAPTURE_UPDATE_WINDOW_MS,
    LeadValidationError,
    EMAIL_PATTERN,
    formatUsPhone,
    normalizers,
    pickLeadFields,
    resolveLeadId,
    hasValue,
    hasAnyField,
    sendLeadError,
} = require("../utils/leadCapture");
// const { normalizeRequestSource } = require("../utils/requestSources");

// Sources in use (see utils/requestSources.js): website form, Instagram,
// Facebook. Staff edits reject anything else; the Automation Bot falls back
// to "other". Old values stay valid on existing records only.
const JUNK_CAR_SOURCE_MAP = {
    website: "website",
    online: "website",
    instagram: "instagram",
    facebook: "facebook",
};

const {
    JUNK_CAR_STATUSES,
    JUNK_CAR_STATUS_ORDER,
    JUNK_CAR_VISIBLE_FILTER,
    normalizeJunkCarStatus,
} = require("../utils/junkCarLeads");

// Field rules shared by the lead-capture route (POST /) and the staff PATCH
// route, so both validate a value the same way.
const US_PHONE_ERROR = "Enter a 10-digit US phone number: (XXX) XXX-XXXX";
const MAX_JUNK_NAME_LENGTH = 100;
// Limits for every source (website / bot / CRM). The CRM "Add Junk Car" form
// is stricter (JUNK_CAR_CRM_LIMITS) — website leads are not rejected over a
// long name.
const JUNK_CAR_TEXT_LIMITS = { email: 100, make: 50, model: 50, engineOrVin: 50, condition: 100, message: 1000 };
const JUNK_CAR_CRM_LIMITS = { name: 15, engineOrVin: 17, condition: 50 };
const MIN_JUNK_YEAR = 1900;
// Trimmed text (inner spaces collapsed) of at most `max` characters.
const junkText = (max, label, base = normalizers.text()) => (field, value) => {
    const raw = base(field, value);
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ") : raw;
    if (typeof text === "string" && text !== "none" && text.length > max) {
        throw new LeadValidationError(`${label} can be at most ${max} characters`);
    }
    return text;
};
// A 4-digit year from 1900 to the current year (no future years).
const junkYear = (field, value) => {
    const year = normalizers.year()(field, value);
    if (year === null || year === undefined) return year;
    const maxYear = new Date().getFullYear();
    if (year < MIN_JUNK_YEAR || year > maxYear) {
        throw new LeadValidationError(`Year must be from ${MIN_JUNK_YEAR} to ${maxYear}`);
    }
    return year;
};
const MAX_JUNK_REMARK_LENGTH = 500;
// Location sent by the website or the Automation Bot: plain text, trimmed,
// at most this many characters.
const MAX_LOCATION_LENGTH = 200;
const cleanLocation = (value) => {
    if (value === undefined || value === null) return { value: "" };
    if (typeof value !== "string" && typeof value !== "number") {
        return { error: "location must be text" };
    }
    const text = String(value).trim().replace(/\s+/g, " ");
    if (text.length > MAX_LOCATION_LENGTH) {
        return { error: `location can be at most ${MAX_LOCATION_LENGTH} characters` };
    }
    return { value: text };
};

const JUNK_CAR_FIELD_RULES = {
    // Schema-required — clearing one falls back to the same "none"
    // placeholder the create path stores.
    // At most 100 characters; spaces only counts as no name.
    name: (field, value) => {
        const raw = normalizers.requiredText()(field, value);
        const text = typeof raw === "string" ? raw.replace(/\s+/g, " ") : raw;
        if (typeof text === "string" && text.length > MAX_JUNK_NAME_LENGTH) {
            throw new LeadValidationError(`Name can be at most ${MAX_JUNK_NAME_LENGTH} characters`);
        }
        return text;
    },
    email: (field, value) => {
        const text = normalizers.contact(EMAIL_PATTERN, "Invalid email format")(field, value);
        if (text !== "none" && text.length > JUNK_CAR_TEXT_LIMITS.email) {
            throw new LeadValidationError(`Email can be at most ${JUNK_CAR_TEXT_LIMITS.email} characters`);
        }
        return text;
    },
    // US numbers are stored as "(XXX) XXX-XXXX". Lenient: a website / bot
    // lead with another number is kept as sent (not lost). The CRM form is
    // checked strictly in saveJunkCarLead.
    phone: normalizers.usPhone(US_PHONE_ERROR, { lenient: true }),
    make: junkText(JUNK_CAR_TEXT_LIMITS.make, "Make", normalizers.requiredText()),
    model: junkText(JUNK_CAR_TEXT_LIMITS.model, "Model", normalizers.requiredText()),
    year: junkYear,
    engineOrVin: junkText(JUNK_CAR_TEXT_LIMITS.engineOrVin, "Engine / VIN number"),
    condition: junkText(JUNK_CAR_TEXT_LIMITS.condition, "Condition"),
    message: junkText(JUNK_CAR_TEXT_LIMITS.message, "Message"),
    // Plain text, trimmed, at most MAX_LOCATION_LENGTH characters.
    location: (field, value) => {
        const r = cleanLocation(value);
        if (r.error) throw new LeadValidationError(r.error);
        return r.value;
    },
    remark: normalizers.text(),
    status: normalizers.oneOf(JUNK_CAR_STATUSES),
    source: normalizers.oneOf(Object.keys(JUNK_CAR_SOURCE_MAP), { map: JUNK_CAR_SOURCE_MAP }),
    paymentStatus: normalizers.oneOf(JunkCar.schema.path("paymentStatus").enumValues),
    // Existence of the user is checked separately (needs the DB).
    assignedTo: (field, value) => {
        if (value === null || value === "") return null;

        if (typeof value !== "string" || !/^[0-9a-f]{24}$/i.test(value.trim())) {
            throw new LeadValidationError("assignedTo must be a valid user id");
        }

        return value.trim();
    },
};

// What the public form (website / CRM "Add Junk Car") may send. Same set the
// old create handler read from its body; source is always "website" on this
// route and staff/system fields (status, paymentStatus, remark, assignedTo,
// createdBy, movedToIntake) are never taken from it.
const JUNK_CAR_CAPTURE_FIELDS = [
    "name",
    "email",
    "phone",
    "year",
    "make",
    "model",
    "engineOrVin",
    "condition",
    "message",
    "location",
];

const JUNK_CAR_CONTACT_FIELDS = ["name", "phone", "email"];

const JUNK_CAR_POPULATE = [
    { path: "assignedTo", select: "first_name last_name email role" },
    { path: "assignedBy", select: "first_name last_name email role" },
    { path: "createdBy", select: "first_name last_name email role" },
];

// "Lead Assigned By" (assignedBy / assignedAt): the logged-in user who last
// worked the lead — changed its status or payment, or picked / cleared its
// assignee — and when. Updated every time, so it always shows the latest
// user. Nothing is recorded when there is no logged-in user.
const actorFields = (user) =>
    user?._id ? { assignedBy: user._id, assignedAt: new Date() } : {};

// "Assigned To" (assignedTo) only changes when someone picks or clears the
// assignee; status / payment changes never touch it.
const assignmentFields = (assignedTo, user) => ({
    assignedTo: assignedTo || null,
    ...actorFields(user),
});

// Lead forms may call the VIN field "vin"; it is stored in engineOrVin.
const applyVinAlias = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body) || !("vin" in body)) {
        return body;
    }

    const { vin, ...rest } = body;

    if ("engineOrVin" in rest && rest.engineOrVin !== vin) {
        throw new LeadValidationError("Send either vin or engineOrVin, not both");
    }

    return { ...rest, engineOrVin: vin };
};

// A captured lead stays editable through the capture routes only until staff
// start working it (status / payment / intake) and, when a window is given,
// only for a limited time after creation.
const isOpenJunkCarLead = (junkCar, windowStart) =>
    (junkCar.status || "pending").toLowerCase() === "pending" &&
    (junkCar.paymentStatus || "Not Paid") === "Not Paid" &&
    !junkCar.movedToIntake &&
    (!windowStart || junkCar.createdAt >= windowStart);

// Updates an already-captured lead with whitelisted `values`. Shared by the
// public capture route and the Automation Bot route.
//  - ownerId:        only a lead created by this user can be updated
//  - windowStart:    only a lead created after this date can be updated
//  - requireContact: the lead must keep a name, phone or email (public route)
// Returns { junkCar } or { error: { status, message } }.
const updateCapturedJunkCar = async (leadId, values, { ownerId, windowStart, requireContact = true } = {}) => {
    if (Object.keys(values).length === 0) {
        return { error: { status: 400, message: "No fields to update were provided" } };
    }

    const existing = await JunkCar.findById(leadId);

    if (!existing || (ownerId && String(existing.createdBy) !== String(ownerId))) {
        return { error: { status: 404, message: "Lead not found" } };
    }

    if (!isOpenJunkCarLead(existing, windowStart)) {
        return { error: { status: 409, message: "This lead can no longer be updated" } };
    }

    if (
        requireContact &&
        JUNK_CAR_CONTACT_FIELDS.some((field) => field in values) &&
        !JUNK_CAR_CONTACT_FIELDS.some((field) =>
            hasValue(field in values ? values[field] : existing[field])
        )
    ) {
        return { error: { status: 400, message: "Name, phone or email is required" } };
    }

    // The lock conditions are repeated in the filter so a status / payment
    // change made by staff between the read above and this write still wins.
    const junkCar = await JunkCar.findOneAndUpdate(
        {
            _id: leadId,
            status: { $in: [existing.status, null] },
            paymentStatus: { $in: ["Not Paid", null] },
            movedToIntake: { $ne: true },
            ...(windowStart && { createdAt: { $gte: windowStart } }),
            ...(ownerId && { createdBy: ownerId }),
        },
        { $set: values },
        { new: true, runValidators: true }
    ).populate(JUNK_CAR_POPULATE);

    if (!junkCar) {
        return { error: { status: 409, message: "This lead can no longer be updated" } };
    }

    return { junkCar };
};

const sendJunkCarUpdateResult = (res, { junkCar, error }) => {
    if (error) {
        return res.status(error.status).json({ success: false, message: error.message });
    }

    return res.json({
        success: true,
        operation: "updated",
        leadId: junkCar._id,
        message: "Lead updated successfully",
        data: junkCar,
    });
};

// POST /api/junk-car — progressive lead capture for Junk Car.
//  - no lead id            -> create the lead, respond 201 with its leadId
//  - lead id (body.leadId or X-Lead-ID header) -> update only the supplied
//    fields of that lead, respond 200
// Existing callers that never send a lead id keep getting a create with the
// same defaults and response fields (plus operation/leadId).
exports.saveJunkCarLead = async (req, res) => {
    try {
        const { leadId } = resolveLeadId(req);

        const values = pickLeadFields(applyVinAlias(req.body ?? {}), {
            rules: JUNK_CAR_FIELD_RULES,
            fields: JUNK_CAR_CAPTURE_FIELDS,
            ignore: ["leadId"],
        });

        if (!leadId) {
            const fromCrm = req.body?.source?.toString().trim().toLowerCase() === "offline";
            // The CRM "Add Junk Car" form: Name optional (at most 15
            // characters); Engine / VIN letters and digits only (at most 17);
            // a name, phone or email is still needed (checked below).
            if (fromCrm) {
                const bad = (text) => res.status(400).json({ success: false, message: text });
                if (hasValue(values.name) && values.name.length > JUNK_CAR_CRM_LIMITS.name) {
                    return bad(`Name can be at most ${JUNK_CAR_CRM_LIMITS.name} characters`);
                }
                if (hasValue(values.engineOrVin)) {
                    if (!/^[A-Za-z0-9]+$/.test(values.engineOrVin)) {
                        return bad("Engine / VIN number can have letters and digits only");
                    }
                    if (values.engineOrVin.length > JUNK_CAR_CRM_LIMITS.engineOrVin) {
                        return bad(`Engine / VIN number can be at most ${JUNK_CAR_CRM_LIMITS.engineOrVin} characters`);
                    }
                }
                if (hasValue(values.condition) && values.condition.length > JUNK_CAR_CRM_LIMITS.condition) {
                    return bad(`Condition can be at most ${JUNK_CAR_CRM_LIMITS.condition} characters`);
                }
            }
            if (fromCrm && hasValue(values.phone) && values.phone !== "none" && !formatUsPhone(values.phone)) {
                return res.status(400).json({ success: false, message: US_PHONE_ERROR });
            }
            if (!JUNK_CAR_CONTACT_FIELDS.some((field) => hasValue(values[field]))) {
                return res.status(400).json({
                    success: false,
                    message: fromCrm ? "Enter a name, phone or email" : "Name, phone or email is required",
                });
            }

            const newRequest = await JunkCar.create({
                name: values.name || "none",
                email: values.email || "none",
                phone: values.phone || "none",
                year: values.year ?? null,
                make: values.make || "none",
                model: values.model || "none",
                engineOrVin: values.engineOrVin || "none",
                condition: values.condition || "none",
                message: values.message || "",
                location: values.location || "",
                // The CRM's own "Add Request" form sends source "offline"
                // (same as Part Request's "Offline"); every other caller —
                // the website form — stays "website".
                source:
                    req.body?.source?.toString().trim().toLowerCase() === "offline"
                        ? "offline"
                        : "website",
            });

            req.app.get("io")?.emit("cache:invalidate", { scope: "junkCars" });
            req.app.get("io")?.emit("badge:update");

            return res.status(201).json({
                success: true,
                operation: "created",
                leadId: newRequest._id,
                data: newRequest,
            });
        }

        const result = await updateCapturedJunkCar(leadId, values, {
            windowStart: new Date(Date.now() - LEAD_CAPTURE_UPDATE_WINDOW_MS),
        });

        if (!result.error) {
            req.app.get("io")?.emit("cache:invalidate", { scope: "junkCars" });
            req.app.get("io")?.emit("badge:update");
        }

        return sendJunkCarUpdateResult(res, result);
    } catch (error) {
        return sendLeadError(res, error, "SAVE JUNK CAR LEAD ERROR");
    }
};

// What the Automation Bot may send — the same fields its create has always
// read, plus location. Values are normalized the way the bot create does it:
// empty text becomes "none" and an unknown source becomes "other".
const JUNK_CAR_BOT_FIELDS = [
    "name",
    "email",
    "phone",
    "year",
    "make",
    "model",
    "engineOrVin",
    "condition",
    "source",
    "message",
    "location",
];

// A bot create needs at least one of these. Name/phone/email are not
// compulsory; source alone doesn't count since the bot always sends it.
const JUNK_CAR_BOT_CREATE_FIELDS = JUNK_CAR_BOT_FIELDS.filter((field) => field !== "source");

const JUNK_CAR_BOT_RULES = {
    ...JUNK_CAR_FIELD_RULES,
    email: normalizers.requiredText(),
    engineOrVin: normalizers.requiredText(),
    condition: normalizers.requiredText(),
    source: (field, value) =>
        JUNK_CAR_SOURCE_MAP[value?.toString().trim().toLowerCase()] || "other",
};

// POST /api/junk-car/automation-bot — junk car request from the AI Chatbot
// (Automation Bot); req.user is attached by middleware/automationBotAuth.js.
//  - no lead id -> create with at least one field, respond 201 with its leadId
//  - lead id (URL /automation-bot/:id, body.leadId or X-Lead-ID header) ->
//    update only the supplied fields of a lead the bot itself created, while
//    staff haven't started working it; respond 200
// Name, phone and email are optional on this route (create and update).
exports.saveAutomationBotJunkCarRequest = async (req, res) => {
    try {
        console.log("JUNK CAR AUTOMATION BODY:", JSON.stringify(req.body, null, 2));

        const { leadId } = resolveLeadId(req);

        if (leadId) {
            const values = pickLeadFields(req.body ?? {}, {
                rules: JUNK_CAR_BOT_RULES,
                fields: JUNK_CAR_BOT_FIELDS,
                ignore: ["leadId"],
            });

            const result = await updateCapturedJunkCar(leadId, values, {
                ownerId: req.user._id,
                requireContact: false,
            });

            return sendJunkCarUpdateResult(res, result);
        }

        const {
            name,
            email,
            phone,
            year,
            make,
            model,
            engineOrVin,
            condition,
            source,
            message,
            location,
        } = req.body ?? {};

        if (!hasAnyField(req.body, JUNK_CAR_BOT_CREATE_FIELDS)) {
            return res.status(400).json({
                success: false,
                message: "At least one field is required to create a lead",
            });
        }

        const loc = cleanLocation(location);
        if (loc.error) {
            return res.status(400).json({ success: false, message: loc.error });
        }

        // 4 digits, from 1900 to the current year (no future years).
        let parsedYear = null;

        if (year) {
            try {
                parsedYear = junkYear("year", typeof year === "number" ? year : String(year));
            } catch (error) {
                return res.status(400).json({ success: false, message: error.message });
            }
        }

        const rawSource = source?.toString().trim().toLowerCase();

        const resolvedSource = JUNK_CAR_SOURCE_MAP[rawSource] || "other";

        const newRequest = await JunkCar.create({
            name: name || "none",
            email: email || "none",
            phone: phone ? formatUsPhone(phone) || String(phone).trim() : "none",
            year: parsedYear,
            make: make || "none",
            model: model || "none",
            engineOrVin: engineOrVin || "none",
            condition: condition || "none",
            message: message || "",
            location: loc.value,

            //  Added for Automation Bot
            source: resolvedSource,
            createdBy: req.user._id,
            // assignedTo: req.user._id,
        });

        req.app.get("io")?.emit("cache:invalidate", { scope: "junkCars" });
        req.app.get("io")?.emit("badge:update");

        res.status(201).json({
            success: true,
            operation: "created",
            leadId: newRequest._id,
            data: newRequest,
        });
    } catch (error) {
        return sendLeadError(res, error, "SAVE AUTOMATION BOT JUNK CAR ERROR");
    }
};

// Integrate Junk Car into your existing Requests page
exports.getAllJunkCars = async (req, res) => {
    try {
        // Completed leads are not wanted and are never listed
        // (utils/junkCarLeads.js).
        let filter = { ...JUNK_CAR_VISIBLE_FILTER };

        if (req.user?.role === "staff") {

            filter.movedToIntake = { $ne: true };
        }

        const data = await JunkCar.find(filter)
            .populate(JUNK_CAR_POPULATE)  // get data first
            .lean();

        // Safe sort
        data.sort((a, b) => {

            // added by shiva — status order (utils/junkCarLeads.js): Lead
            // Converted / Lead Closed go to the bottom.
            const statusDiff =
                (JUNK_CAR_STATUS_ORDER[normalizeJunkCarStatus(a.status)] || 99) -
                (JUNK_CAR_STATUS_ORDER[normalizeJunkCarStatus(b.status)] || 99);

            // First sort by status order
            if (statusDiff !== 0) {
                return statusDiff;
            }

            // Then newest first inside same status
            return  new Date(b.createdAt) - new Date(a.createdAt)
        });

        res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("🔥 JUNK ERROR:", err)
        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
};

// Update Remark by shiva
exports.updateJunkCarRemark = async (req, res) => {

    try {

        const { remark } = req.body ?? {};

        // Remark: text of at most 500 characters (blank clears it).
        if (remark !== undefined && remark !== null && typeof remark !== "string") {
            return res.status(400).json({ success: false, message: "Remark must be text" });
        }
        const cleanRemark = typeof remark === "string" ? remark.trim() : "";
        if (cleanRemark.length > MAX_JUNK_REMARK_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `Remark can be at most ${MAX_JUNK_REMARK_LENGTH} characters`,
            });
        }
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Junk car request not found" });
        }

        const junkCar =
            await JunkCar.findByIdAndUpdate(
                req.params.id,
                { remark: cleanRemark },
                { new: true }
            );
        if (!junkCar) {
            return res.status(404).json({ success: false, message: "Junk car request not found" });
        }

        res.status(200).json({
            success: true,
            data: junkCar,
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};
// end here

exports.updateJunkCarStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const status = JUNK_CAR_STATUSES.find(
            (s) => s === normalizeJunkCarStatus(req.body?.status)
        );

        if (!status) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Allowed values: ${JUNK_CAR_STATUSES.join(", ")}`,
            });
        }

        // Lead Assigned By = whoever changed the status (Assigned To untouched).
        const updated = await JunkCar.findByIdAndUpdate(
            { _id: id },
            { $set: { status, ...actorFields(req.user) } },
            { new: true }
        );

        // added by shiva payment function
        if (
            updated && 
            updated.status &&
            updated.status.toLowerCase() === "completed" &&
            updated.paymentStatus !== "Not Paid"
        ) {

            const vinValue =
                updated.engineOrVin &&
                    updated.engineOrVin !== "none" &&
                    updated.engineOrVin.trim().length > 5
                    ? updated.engineOrVin.toUpperCase()
                    : `JUNK${updated._id}`;

            const existing = await CarIntake.findOne({ vin: vinValue });

            if (!existing) {

                await CarIntake.create({
                    vin: vinValue,

                    carDetails: {
                        year: updated.year || null,
                        make: updated.make || "",
                        model: updated.model || "",
                        trim: "Junk Car",
                        description: "Auto added from Junk Car Request",
                    },

                    status: "intake",
                });

                // added by shiva
                await JunkCar.findByIdAndUpdate(
                    updated._id,
                    { movedToIntake: true }
                );
                // end here

                console.log("Car Intake Created Successfully ✅");

            } else {

                console.log("Duplicate VIN - Skipped");
            }
        }
        req.app.get("io")?.emit("cache:invalidate", { scope: "junkCars" });
        req.app.get("io")?.emit("badge:update");

        res.json({
            success: true,
            data: updated,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};


// Source added by shiva
exports.updateJunkCarSource = async (req, res) => {
    try {

        const { id } = req.params;
        const { source } = req.body;

        const rawSource = source?.toString().trim().toLowerCase();

        // Staff can only pick a source that is in use (was: anything unknown
        // silently became "other").
        const normalizedSource = JUNK_CAR_SOURCE_MAP[rawSource];
        if (!normalizedSource) {
            return res.status(400).json({
                success: false,
                message: "Invalid source. Allowed values: website, instagram, facebook",
            });
        }

        const updated = await JunkCar.findByIdAndUpdate(
            { _id: id },
            { $set: { source: normalizedSource } },
            { new: true }
        );

        res.json({
            success: true,
            data: updated,
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
};
// end here

// added by shiva
exports.updateJunkCarPaymentStatus = async (req, res) => {
    try {

        const { id } = req.params;
        const { paymentStatus } = req.body;

        // Lead Assigned By = whoever changed the payment (Assigned To untouched).
        const updated = await JunkCar.findByIdAndUpdate(
            { _id: id },
            { $set: { paymentStatus, ...actorFields(req.user) } },
            { new: true }
        );

        // Create Car Intake only if:
        // status = completed
        // paymentStatus = Paid

        if (
            updated &&
            updated.status &&
            updated.status.toLowerCase() === "completed" &&
            updated.paymentStatus !== "Not Paid"
        ) {

            const vinValue =
                updated.engineOrVin &&
                updated.engineOrVin !== "none" &&
                updated.engineOrVin.trim().length > 5
                    ? updated.engineOrVin.toUpperCase()
                    : `JUNK${Date.now()}`;

            const existing = await CarIntake.findOne({ vin: vinValue });

            if (!existing) {

                await CarIntake.create({
                    vin: vinValue,

                    carDetails: {
                        year: updated.year || null,
                        make: updated.make || "",
                        model: updated.model || "",
                        trim: "Junk Car",
                        description: "Auto added from Junk Car Request",
                    },

                    status: "intake",
                });
                await JunkCar.findByIdAndUpdate(
                    updated._id,
                    { movedToIntake: true }
                );

                console.log("Car Intake Created Successfully ✅");

            } else {

                console.log("Duplicate VIN - Skipped");
            }
        }

        res.json({
            success: true,
            data: updated,
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
};

//  AssignJunkCarStaff by shiva
exports.assignJunkCarStaff = async (req, res) => {
    try {

        const { id } = req.params;
        const rawAssignedTo = req.body?.assignedTo;
        const assignedTo =
            rawAssignedTo === null || rawAssignedTo === undefined || rawAssignedTo === ""
                ? null
                : String(rawAssignedTo).trim();

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid junk car request id" });
        }

        if (assignedTo) {
            if (!mongoose.Types.ObjectId.isValid(assignedTo)) {
                return res.status(400).json({ success: false, message: "assignedTo must be a valid user id" });
            }
            if (!(await User.exists({ _id: assignedTo }))) {
                return res.status(400).json({ success: false, message: "Assigned user not found" });
            }
        }

        // Lead Assigned By = the logged-in user picking / clearing the
        // assignee, kept separately from the assignee.
        const updated = await JunkCar.findByIdAndUpdate(
            id,
            { $set: assignmentFields(assignedTo, req.user) },
            { new: true }
        ).populate(JUNK_CAR_POPULATE);

        if (!updated) {
            return res.status(404).json({ success: false, message: "Junk car request not found" });
        }

        req.app.get("io")?.emit("cache:invalidate", { scope: "junkCars" });

        res.json({
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

// Mirrors the intake hand-off in updateJunkCarStatus /
// updateJunkCarPaymentStatus: a completed and paid request becomes a Car
// Intake once. Returns true when an intake was created.
const moveJunkCarToIntake = async (junkCar) => {
    if (
        junkCar.movedToIntake ||
        !junkCar.status ||
        junkCar.status.toLowerCase() !== "completed" ||
        junkCar.paymentStatus === "Not Paid"
    ) {
        return false;
    }

    const vinValue =
        junkCar.engineOrVin &&
            junkCar.engineOrVin !== "none" &&
            junkCar.engineOrVin.trim().length > 5
            ? junkCar.engineOrVin.toUpperCase()
            : `JUNK${junkCar._id}`;

    const existing = await CarIntake.findOne({ vin: vinValue });

    if (existing) {
        console.log("Duplicate VIN - Skipped");
        return false;
    }

    await CarIntake.create({
        vin: vinValue,

        carDetails: {
            year: junkCar.year || null,
            make: junkCar.make || "",
            model: junkCar.model || "",
            trim: "Junk Car",
            description: "Auto added from Junk Car Request",
        },

        status: "intake",
    });

    junkCar.movedToIntake = true;
    await junkCar.save();

    console.log("Car Intake Created Successfully ✅");
    return true;
};

// PATCH /api/junk-car/:id — authenticated staff edit of a Junk Car request.
// Only the fields sent in the body are changed. Unknown or system-managed
// fields (createdBy, movedToIntake, timestamps, _id) are rejected instead of
// silently ignored. Uses the same field rules as the lead-capture route.
const JUNK_CAR_PATCHABLE_FIELDS = Object.keys(JUNK_CAR_FIELD_RULES);

exports.patchJunkCar = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid junk car request id",
            });
        }

        const body = req.body;

        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
            return res.status(400).json({
                success: false,
                message: "Request body must contain at least one field to update",
            });
        }

        let updates = pickLeadFields(applyVinAlias(body), {
            rules: JUNK_CAR_FIELD_RULES,
            fields: JUNK_CAR_PATCHABLE_FIELDS,
            rejectUnknown: true,
        });

        if (updates.assignedTo) {
            const userExists = await User.exists({ _id: updates.assignedTo });

            if (!userExists) {
                return res.status(400).json({
                    success: false,
                    message: "Assigned user not found",
                });
            }
        }

        const junkCar = await JunkCar.findById(id);

        if (!junkCar) {
            return res.status(404).json({
                success: false,
                message: "Junk car request not found",
            });
        }

        // Same rule as lead capture: keep at least one way to identify or
        // reach the customer.
        if (
            JUNK_CAR_CONTACT_FIELDS.some((field) => field in updates) &&
            !JUNK_CAR_CONTACT_FIELDS.some((field) =>
                hasValue(field in updates ? updates[field] : junkCar[field])
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Name, phone or email is required",
            });
        }

        // Same rules as the assign / status / payment routes:
        //  - Assigned To changes only when assignedTo is sent with a new value;
        //  - Lead Assigned By records the caller whenever the assignee,
        //    status or payment is changed.
        let assigneeChanged = false;
        if ("assignedTo" in updates) {
            assigneeChanged =
                String(updates.assignedTo || "") !== String(junkCar.assignedTo || "");
            if (!assigneeChanged) {
                const { assignedTo, ...rest } = updates;
                updates = rest;
            }
        }

        if (assigneeChanged || "status" in updates || "paymentStatus" in updates) {
            Object.assign(updates, actorFields(req.user));
        }

        junkCar.set(updates);
        await junkCar.save();

        const movedToIntake = await moveJunkCarToIntake(junkCar);

        await junkCar.populate(JUNK_CAR_POPULATE);

        res.json({
            success: true,
            message: "Junk car request updated successfully",
            movedToIntake,
            data: junkCar,
        });
    } catch (error) {
        return sendLeadError(res, error, "PATCH JUNK CAR ERROR");
    }
};
