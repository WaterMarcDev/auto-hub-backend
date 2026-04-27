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

        const newRequest = await JunkCar.create({
            name: name || "none",
            email: email || "none",
            phone: phone || "none",
            year: parsedYear,
            make: make || "none",
            model: model || "none",
            engineOrVin: engineOrVin || "none",
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

        const updated = await JunkCar.findByIdAndUpdate(
            { _id: id },
            {$set: { status } },
            { new: true }
        );

        res.json({
            success: true,
            data: updated,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};