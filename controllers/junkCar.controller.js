const junkCarService = require("../services/junkCar.service");

exports.createJunkCarRequest = async (req, res) => {
    try {
        const newRequest = await junkCarService.createJunkCarRequest(req.body);

        res.status(201).json({
            success: true,
            // message: "Junk car request submitted successfully",
            data: newRequest,
        });
    } catch (error) {
        console.error(error);
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

exports.createAutomationBotJunkCarRequest = async (req, res) => {
    try {
        console.log("JUNK CAR AUTOMATION BODY:", JSON.stringify(req.body, null, 2));
        const newRequest = await junkCarService.createAutomationBotJunkCarRequest(req.body, req.user._id);

        res.status(201).json({
            success: true,
            data: newRequest,
        });
    } catch (error) {
        console.error(error);
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Integrate Junk Car into your existing Requests page
exports.getAllJunkCars = async (req, res) => {
    try {
        const data = await junkCarService.getAllJunkCars(req.user?.role);

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
        const junkCar = await junkCarService.updateJunkCarRemark(req.params.id, remark);

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

exports.updateJunkCarStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const updated = await junkCarService.updateJunkCarStatus(id, status, req.user._id);

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

        const updated = await junkCarService.updateJunkCarSource(id, source);

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

// added by shiva
exports.updateJunkCarPaymentStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { paymentStatus } = req.body;

        const updated = await junkCarService.updateJunkCarPaymentStatus(id, paymentStatus, req.user._id);

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

        const updated = await junkCarService.assignJunkCarStaff(id, assignedTo);

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
