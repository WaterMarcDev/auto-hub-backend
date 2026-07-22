const PartRequest = require("../models/PartRequest.model");
const auditLogService = require("../services/auditLog.service");

// Automation Bot (chatbot) — recognized platform sources
const BOT_SOURCES = [
    "Website",
    "Instagram",
    "Facebook",
    "WhatsApp",
    "TikTok",
    "eBay",
    "Google Business",
    "SMS",
    "Other",
];

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

        const resolvedSource = BOT_SOURCES.includes(source) ? source : "Other";

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

        const request = await PartRequest.findByIdAndUpdate(
            id,
            { status },
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