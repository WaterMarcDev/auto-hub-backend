const Customer = require("../models/customer");

const createCustomer = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      mobileNo,
      email,
      type,
      idProofType,
      idProofNumber,
      idProofImage,
      signatureImage,
    } = req.body;

    // Optional Seller/Buyer discriminator. When supplied it must be valid;
    // when omitted/blank (legacy callers / generic customers) the record is
    // still created with no type, for backward compatibility.
    let normalizedType;
    if (type !== undefined && type !== null && type !== "") {
      if (!["seller", "buyer"].includes(type)) {
        return res.status(400).json({
          error: "Invalid type",
          details: "type must be either 'seller' or 'buyer'",
        });
      }
      normalizedType = type;
    }

    const newCustomer = new Customer({
      firstName,
      lastName,
      mobileNo,
      email,
      type: normalizedType,
      idProofType,
      idProofNumber,
      idProofImage,
      signatureImage,
      createdBy: req.user._id,
    });

    await newCustomer.save();
    res.status(201).json(newCustomer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAllCustomers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter = {};
    filter.isDeleted = { $ne: true };

    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, "i");
      filter.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
        { mobileNo: searchRegex },
      ];
    }
    const customers = await Customer.find(filter)
      .populate({
        path: "carIntakes",
        options: { sort: { createdAt: -1 } },
      })
      .skip(skip)
      .limit(limit);
    const total = await Customer.countDocuments(filter);
    res.status(200).json({ customers, pagination: { page, limit, total } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      req.body,
      { new: true }
    );
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomerById,
  deleteCustomerById,
};
