const JunkCar = require("../models/junkCar.model");

// Added by shiva
const CarIntake = require("../models/carInTake.model");
// end here

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

        // Added by shiva
        if (status && status.toLowerCase() === "completed" && updated) {
            try {
                console.log("STATUS:", status);
                console.log("UPDATED DATA:", updated);

                const vinValue =
                    updated.engineOrVin &&
                    updated.engineOrVin !== "none" &&
                    updated.engineOrVin.trim().length > 5
                        ? updated.engineOrVin.toUpperCase()
                        : `JUNK${Date.now()}`;

                console.log("VIN VALUE:", vinValue);

                const existing = await CarIntake.findOne({ vin: vinValue });

                if (!existing) {
                    await CarIntake.create({
                        vin: vinValue,
                        carDetails: {
                            year: updated.year || null,
                            make: updated.make || "",
                            model: updated.model || "",
                            trim: "Junk Car",
                            description: `Auto added from Junk Car Request`,
                    },

                    status: "intake",
                });
            
                console.log("Car Intake Created Successfully");
            } else {
                console.log("Duplicate VIN - Skipped");
            }
        } catch (error) {
            console.log("Car Intake Error:", error);
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