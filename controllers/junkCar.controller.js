const mongoose = require("mongoose");
const JunkCar = require("../models/JunkCar.model");
const CarIntake = require("../models/CarIntake.model");  // by shiva
const User = require("../models/User.model");
// const { normalizeRequestSource } = require("../utils/requestSources");

exports.createJunkCarRequest = async (req, res) => {
    try {
        const {
            name,
            email,
            phone,
            year,
            make,
            model,
            engineOrVin,
            condition,
            message,
        } = req.body;

        // added by shiva
        let parsedYear = null;

        if (year) {
            const yearStr = year.toString().trim();

            if (!/^\d{4}$/.test(yearStr)) {
                return res.status(400).json({
                    success: false,
                    message: "Year must be exactly 4 digits"
                });
            }

            parsedYear = parseInt(yearStr, 10);
        }
        //end here

        // const rawSource = req.body.source?.toString().trim().toLowerCase();

        const normalizedSource = "website";

        // if (rawSource === "instagram") {
        //     normalizedSource = "instagram";
        // } else if (rawSource === "facebook") {
        //     normalizedSource = "facebook";
        // } else if (rawSource === "website" || rawSource === "online") {
        //     normalizedSource = "website";
        // }

        const newRequest = await JunkCar.create({
            name: name || "none",
            email: email || "none",
            phone: phone || "none",
            year: parsedYear,
            make: make || "none",
            model: model || "none",
            engineOrVin: engineOrVin || "none",
            condition: condition || "none",
            message: message || "",
            source: normalizedSource,  // was previously dropped — see PartRequestController.createRequest for the equivalent pattern (kept byte-for-byte symmetric with it: raw passthrough, no normalization, so Junk Car can never diverge from Part Request's own casing/behavior)
        });

        res.status(201).json({
            success: true,
            // message: "Junk car request submitted successfully",
            data: newRequest,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

exports.createAutomationBotJunkCarRequest = async (req, res) => {
    try {
        console.log("JUNK CAR AUTOMATION BODY:", JSON.stringify(req.body, null, 2));
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
        } = req.body;

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

        const rawSource = source?.toString().trim().toLowerCase();

        const sourceMap = {
            // manual: "manual",
            website: "website",
            online: "website",
            instagram: "instagram",
            facebook: "facebook",
            tiktok: "tiktok",
            ebay: "ebay",
            "google business": "google business",
            whatsapp: "whatsApp",
            // "whatsapp": "whatsApp",
            sms: "sms",
            other: "other",
        };

        const resolvedSource = sourceMap[rawSource] || "other";

        // if (rawSource === "instagram") {
        //     resolvedSource = "instagram";
        // } else if (rawSource === "facebook") {
        //     resolvedSource = "facebook";
        // } else if (rawSource === "website" || rawSource === "online") {
        //     resolvedSource = "website";
        // }

        const newRequest = await JunkCar.create({
            name: name || "none",
            email: email || "none",
            phone: phone || "none",
            year: parsedYear,
            make: make || "none",
            model: model || "none",
            engineOrVin: engineOrVin || "none",
            condition: condition || "none",
            message: message || "",

            //  Added for Automation Bot
            source: resolvedSource,
            createdBy: req.user._id,
            // assignedTo: req.user._id,
        });

        res.status(201).json({
            success: true,
            data: newRequest,
        });
    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Integrate Junk Car into your existing Requests page
exports.getAllJunkCars = async (req, res) => {
    try {
        let filter = {};

        if (req.user?.role === "staff") {

            filter.movedToIntake = { $ne: true };
        }

        const data = await JunkCar.find(filter)
            .populate("assignedTo","first_name last_name email role")  // get data first
            .populate("createdBy", "first_name last_name email role");

        console.log(JSON.stringify(data, null, 2));   // added by shiva  The temp debug

        // added by shiva for status order
        const statusOrder = {
            pending: 1,
            "in progress": 2,
            completed: 3,
        };
        // end here

        // Safe sort
        data.sort((a, b) => {
            
            // added by shiva
            const statusDiff =
                (statusOrder[a.status?.toLowerCase()] || 99) -
                (statusOrder[b.status?.toLowerCase()] || 99);

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

        const { remark } = req.body;

        const junkCar =
            await JunkCar.findByIdAndUpdate(
                req.params.id,
                { remark },
                { new: true }
            );

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
        const { status } = req.body;

        const updated = await JunkCar.findByIdAndUpdate(
            { _id: id },
            { 
                $set: {
                    status,
                    assignedTo: req.user._id,
                },
            },
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
        // end here
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

        const sourceMap = {
            // manual: "manual",
            website: "website",
            online: "website",
            instagram: "instagram",
            facebook: "facebook",
            tiktok: "tiktok",
            ebay: "ebay",
            "google business": "google business",
            whatsapp: "whatsApp",
            // "whatsapp": "whatsApp",
            sms: "sms",
            other: "other",
        };

        const normalizedSource = sourceMap[rawSource] || "other";

        // if (rawSource === "instagram") {
        //     normalizedSource = "instagram";
        // } else if (rawSource === "facebook") {
        //     normalizedSource = "facebook";
        // } else if (rawSource === "website" || rawSource === "online") {
        //     normalizedSource = "website";
        // }

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

        const updated = await JunkCar.findByIdAndUpdate(
            { _id: id },
            { 
                $set: { 
                    paymentStatus,
                assignedTo: req.user._id,
                },
            },
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
        const { assignedTo } = req.body;

        const updated = await JunkCar.findByIdAndUpdate(
            id,
            { assignedTo },
            { new: true }
        ).populate("assignedTo", "first_name last_name email role");

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

// PATCH /api/junk-car/:id — partial update of a Junk Car request. Only the
// fields sent in the body are changed. Unknown or system-managed fields
// (createdBy, movedToIntake, timestamps, _id) are rejected instead of
// silently ignored.
const JUNK_CAR_PATCHABLE_FIELDS = [
    "name",
    "email",
    "phone",
    "year",
    "make",
    "model",
    "engineOrVin",
    "condition",
    "message",
    "remark",
    "status",
    "source",
    "paymentStatus",
    "assignedTo",
];

// Required in the schema — clearing one falls back to the same "none"
// placeholder createJunkCarRequest stores.
const JUNK_CAR_REQUIRED_TEXT_FIELDS = ["name", "email", "phone", "make", "model"];

const JUNK_CAR_STATUSES = ["pending", "in progress", "completed"];

// Same mapping as updateJunkCarSource, but an unknown value is rejected
// rather than downgraded to "other".
const JUNK_CAR_SOURCE_MAP = {
    website: "website",
    online: "website",
    instagram: "instagram",
    facebook: "facebook",
    tiktok: "tiktok",
    ebay: "ebay",
    "google business": "google business",
    whatsapp: "whatsApp",
    sms: "sms",
    other: "other",
};

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

        const unknownFields = Object.keys(body).filter(
            (key) => !JUNK_CAR_PATCHABLE_FIELDS.includes(key)
        );

        if (unknownFields.length > 0) {
            return res.status(400).json({
                success: false,
                message: `These fields cannot be updated: ${unknownFields.join(", ")}`,
                allowedFields: JUNK_CAR_PATCHABLE_FIELDS,
            });
        }

        const updates = {};

        for (const field of JUNK_CAR_PATCHABLE_FIELDS) {
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

            if (field === "assignedTo") {
                if (value === null || value === "") {
                    updates.assignedTo = null;
                    continue;
                }

                if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
                    return res.status(400).json({
                        success: false,
                        message: "assignedTo must be a valid user id",
                    });
                }

                const userExists = await User.exists({ _id: value });

                if (!userExists) {
                    return res.status(400).json({
                        success: false,
                        message: "Assigned user not found",
                    });
                }

                updates.assignedTo = value;
                continue;
            }

            if (value !== null && typeof value !== "string") {
                return res.status(400).json({
                    success: false,
                    message: `${field} must be a string`,
                });
            }

            const trimmed = typeof value === "string" ? value.trim() : "";

            if (JUNK_CAR_REQUIRED_TEXT_FIELDS.includes(field)) {
                if (!trimmed) {
                    updates[field] = "none";
                    continue;
                }

                if (
                    field === "email" &&
                    trimmed.toLowerCase() !== "none" &&
                    !/^\S+@\S+\.\S+$/.test(trimmed)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid email format",
                    });
                }

                updates[field] = trimmed;
                continue;
            }

            if (field === "status") {
                const status = trimmed.toLowerCase();

                if (!JUNK_CAR_STATUSES.includes(status)) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid status. Allowed values: ${JUNK_CAR_STATUSES.join(", ")}`,
                    });
                }

                updates.status = status;
                continue;
            }

            if (field === "source") {
                const source = JUNK_CAR_SOURCE_MAP[trimmed.toLowerCase()];

                if (!source) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid source. Allowed values: ${Object.keys(JUNK_CAR_SOURCE_MAP).join(", ")}`,
                    });
                }

                updates.source = source;
                continue;
            }

            if (field === "paymentStatus") {
                const allowed = JunkCar.schema.path("paymentStatus").enumValues;
                const paymentStatus = allowed.find(
                    (option) => option.toLowerCase() === trimmed.toLowerCase()
                );

                if (!paymentStatus) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid paymentStatus. Allowed values: ${allowed.join(", ")}`,
                    });
                }

                updates.paymentStatus = paymentStatus;
                continue;
            }

            updates[field] = trimmed;
        }

        // Status / payment changes record who handled the request, same as
        // updateJunkCarStatus and updateJunkCarPaymentStatus — unless the
        // caller is explicitly setting assignedTo in the same request.
        if (("status" in updates || "paymentStatus" in updates) && !("assignedTo" in updates)) {
            updates.assignedTo = req.user._id;
        }

        const junkCar = await JunkCar.findById(id);

        if (!junkCar) {
            return res.status(404).json({
                success: false,
                message: "Junk car request not found",
            });
        }

        junkCar.set(updates);
        await junkCar.save();

        const movedToIntake = await moveJunkCarToIntake(junkCar);

        await junkCar.populate([
            { path: "assignedTo", select: "first_name last_name email role" },
            { path: "createdBy", select: "first_name last_name email role" },
        ]);

        res.json({
            success: true,
            message: "Junk car request updated successfully",
            movedToIntake,
            data: junkCar,
        });
    } catch (error) {
        console.error("PATCH JUNK CAR ERROR:", error);

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
