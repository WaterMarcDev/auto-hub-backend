const PartRequest = require("../models/PartRequest.model");

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

        const request = new PartRequest({
            ...req.body,
            email: req.body.email || "none",   // if email not provided then value will be none
            phone: req.body.phone || "none",   // if phone not provided then value will be none
        });

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
    console.log("GET all part requests hit");

    try {
        console.log("Before find");

        const requests = await PartRequest.find().sort({ createdAt: -1 });
        
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