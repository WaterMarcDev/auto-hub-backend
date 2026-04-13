const JunkPartRequest = require("../models/JunkPartRequest");

exports.createRequest = async (req, res) => {
    console.log("Create junk request hit");

    try {
        const request = new JunkPartRequest(req.body);
        await request.save();

        res.status(201).json({
            success: true,
            message: "Request submitted successfully",
            data: request
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Server Error"
        });
    }
};

exports.getAllRequests = async (req, res) => {
    console.log("GET all junk requests hit");

    try {
        console.log("Before find");

        const requests = await JunkPartRequest.find().sort({ createdAt: -1 });
        
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

exports.updateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const request = await JunkPartRequest.findByIdAndUpdate(
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