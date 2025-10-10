const Customer = require("../models/Customer");

const createCustomer = async (req, res) => {
  try {
    const {
      type,
      firstName,
      lastName,
      mobileNo,
      email,
      idProofType,
      idProofNumber,
      idProofImage,
      signatureImage,
    } = req.body;

    const newCustomer = new Customer({
      type,
      firstName,
      lastName,
      mobileNo,
      email,
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

    if (req.query.type) {
      filter.type = req.query.type;
    }

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
