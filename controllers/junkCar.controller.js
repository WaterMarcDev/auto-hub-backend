const JunkCar = require("../models/junkCar.model");

exports.createJunkCarRequest = async (req, res) => {
    try {
        const{
            name,
            email,
            phone,
            year,
            make,
            model,
            engineOrVin,
        } = req.body;

        const newRequest = await JunkCar.create({
            name: name || "none",
            email: email || "none",
            phone: phone || "none",
            year: year || null,
            make: make || "none",
            model: model || "none",
            engineOrVin: engineOrVin || "none",
        });

        // res.status(201).json({
        //     success: true,
        //     // message: "Junk car request submitted successfully",
        //     data: newRequest,
        // });
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
        const data = (await JunkCar.find());  // get data first

        // Safe sort
        data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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

exports.updateJunkCarStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const junkCar = await JunkCar.findById(id);

        if (!junkCar) {
            return res.status(404).json({
                success: false,
                message: "Request not found"
            });
        }

        junkCar.status = status;
        await junkCar.save();

        res.json({
            success: true,
            data: junkCar,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
};