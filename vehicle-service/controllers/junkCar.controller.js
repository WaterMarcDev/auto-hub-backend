const JunkCar = require("../models/JunkCar.model");
const CarIntake = require("../models/CarIntake.model");

// POST /api/junk-car
const createJunkCar = async (req, res) => {
  try {
    const junkCar = await JunkCar.create(req.body);
    res.status(201).json({ message: "Junk car request created", data: junkCar });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

// GET /api/junk-car
const getJunkCars = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      filter.$or = [{ name: re }, { email: re }, { phone: re }, { make: re }, { model: re }];
    }
    const total = await JunkCar.countDocuments(filter);
    const junkCars = await JunkCar.find(filter)
      .populate("assignedTo", "first_name last_name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    res.json({ junkCars, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/junk-car/:id
const getJunkCarById = async (req, res) => {
  try {
    const junkCar = await JunkCar.findById(req.params.id).populate("assignedTo", "first_name last_name email");
    if (!junkCar) return res.status(404).json({ error: "Junk car not found" });
    res.json({ data: junkCar });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/junk-car/:id
const updateJunkCar = async (req, res) => {
  try {
    const junkCar = await JunkCar.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!junkCar) return res.status(404).json({ error: "Junk car not found" });
    res.json({ message: "Junk car updated", data: junkCar });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// DELETE /api/junk-car/:id
const deleteJunkCar = async (req, res) => {
  try {
    await JunkCar.findByIdAndDelete(req.params.id);
    res.json({ message: "Junk car deleted" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PATCH /api/junk-car/:id/move-to-intake
const moveToIntake = async (req, res) => {
  try {
    const junkCar = await JunkCar.findById(req.params.id);
    if (!junkCar) return res.status(404).json({ error: "Junk car not found" });

    const vinValue =
      junkCar.engineOrVin && junkCar.engineOrVin !== "none" && junkCar.engineOrVin.trim().length > 5
        ? junkCar.engineOrVin.toUpperCase()
        : `JUNK${Date.now()}`;

    const existing = await CarIntake.findOne({ vin: vinValue });
    if (!existing) {
      await CarIntake.create({
        vin: vinValue,
        carDetails: {
          year: junkCar.year || null,
          make: junkCar.make || "",
          model: junkCar.model || "",
          trim: "Junk Car",
          description: "Moved from junk car request",
        },
        status: "intake",
        createdBy: req.user?._id,
      });
    }

    junkCar.movedToIntake = true;
    junkCar.status = "moved";
    await junkCar.save();

    res.json({ message: "Moved to car intake", data: junkCar });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

module.exports = { createJunkCar, getJunkCars, getJunkCarById, updateJunkCar, deleteJunkCar, moveToIntake };
