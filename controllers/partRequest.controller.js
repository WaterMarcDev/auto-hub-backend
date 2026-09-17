const partRequestService = require("../services/partRequest.service");

exports.createRequest = async (req, res) => {
    console.log("Create part request hit");

    try {
        const request = await partRequestService.createRequest(req.body);

        res.status(201).json({
            success: true,
            message: "Request submitted successfully",
            data: request
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json(error.payload);
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
        const request = await partRequestService.createAutomationBotRequest(req.body, req.user);

        res.status(201).json({
            success: true,
            message: "Request submitted successfully",
            data: request,
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json(error.payload);
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
        const requests = await partRequestService.getAllRequests();

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

        const updated = await partRequestService.updatePartRequestSource(id, source);

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

        const updated = await partRequestService.updatePartRequestRemark(req.params.id, remark);

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
        const { status } = req.body;

        const request = await partRequestService.updateStatus(id, status);

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
        await partRequestService.deleteRequest(req.params.id);

        res.json({ message: "Deleted successfully" });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json(error.payload);
        console.log(error);
        res.status(500).json({ error: error.message });
    }
};
