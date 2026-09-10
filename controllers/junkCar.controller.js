const JunkCar = require("../models/junkCar.model");
const CarIntake = require("../models/carInTake.model");  // by shiva
const { normalizeRequestSource } = require("../utils/requestSources");

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

        const rawSource = req.body.source?.toString().trim().toLowerCase();

        let normalizedSource = "website";

        if (rawSource === "instagram") {
            normalizedSource = "instagram";
        } else if (rawSource === "facebook") {
            normalizedSource = "facebook";
        } else if (rawSource === "website" || rawSource === "online") {
            normalizedSource = "website";
        }

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

        let resolvedSource = "website";

        if (rawSource === "instagram") {
            resolvedSource = "instagram";
        } else if (rawSource === "facebook") {
            resolvedSource = "facebook";
        } else if (rawSource === "website" || rawSource === "online") {
            resolvedSource = "website";
        }

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

        let normalizedSource = "website";

        if (rawSource === "instagram") {
            normalizedSource = "instagram";
        } else if (rawSource === "facebook") {
            normalizedSource = "facebook";
        } else if (rawSource === "website" || rawSource === "online") {
            normalizedSource = "website";
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