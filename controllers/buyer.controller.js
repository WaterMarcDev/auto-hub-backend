const Buyer = require("../models/Buyer.model");

// @desc    Create new buyer
// @route   POST /api/buyers
// @access  Private
const createBuyer = async (req, res) => {
  try {
    const { firstName, lastName, mobileNo, email, description } = req.body;

    // Basic validation
    if (!firstName || !lastName) {
      return res
        .status(400)
        .json({ message: "First and last name are required" });
    }

    const buyer = new Buyer({
      firstName,
      lastName,
      mobileNo,
      email,
      description,
      createdBy: req.user._id,
    });

    await buyer.save();

    res.status(201).json(buyer);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

const getBuyers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = { isActive: true };
    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, "i");
      filter.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { mobileNo: searchRegex },
      ];
    }

    const buyers = await Buyer.find(filter)
      .populate("createdBy", "first_name last_name email")
      .populate("updatedBy", "first_name last_name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Buyer.countDocuments(filter);

    res.status(200).json({ buyers, pagination: { page, limit, total } });
  } catch (error) {
    console.error("Get buyers error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const getBuyerById = async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.params.id)
      .populate("createdBy", "first_name last_name email")
      .populate("updatedBy", "first_name last_name email");

    if (!buyer) {
      return res.status(404).json({ message: "Buyer not found" });
    }

    res.status(200).json(buyer);
  } catch (error) {
    console.error("Get buyer by ID error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const updateBuyer = async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.params.id);

    if (!buyer || !buyer.isActive || buyer.isDeleted) {
      return res.status(404).json({ message: "Buyer not found" });
    }

    const { firstName, lastName, mobileNo, email, description } = req.body;

    if (firstName !== undefined) buyer.firstName = firstName;
    if (lastName !== undefined) buyer.lastName = lastName;
    if (mobileNo !== undefined) buyer.mobileNo = mobileNo;
    if (email !== undefined) buyer.email = email;
    if (description !== undefined) buyer.description = description;
    buyer.updatedBy = req.user._id;

    await buyer.save();

    res.status(200).json(buyer);
  } catch (error) {
    console.log("Update buyer error", error);
    res.status(500).json({ message: "Server error", details: error.message });
  }
};

const deleteBuyer = async (req, res) => {
  try {
    const buyer = await Buyer.findById(req.params.id);

    if (!buyer || !buyer.isActive || buyer.isDeleted) {
      return res.status(404).json({ message: "Buyer not found" });
    }

    buyer.isActive = false;
    buyer.isDeleted = true;
    buyer.updatedBy = req.user._id;

    await buyer.save();

    res.status(200).json({ message: "Buyer deleted successfully" });
  } catch (error) {
    console.log("Delete buyer error", error);
    res.status(500).json({ message: "Server error", details: error.message });
  }
};

module.exports = {
  createBuyer,
  getBuyers,
  getBuyerById,
  updateBuyer,
  deleteBuyer,
};
