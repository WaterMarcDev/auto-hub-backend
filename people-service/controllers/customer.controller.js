const Customer = require("../models/Customer.model");

const createCustomer = async (req, res) => {
  try {
    const customer = await new Customer({ ...req.body, createdBy: req.user._id }).save();
    res.status(201).json({ message: "Customer created successfully", customer });
  } catch (error) {
    res.status(500).json({ error: "Server error", details: error.message });
  }
};

const getCustomers = async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.search) {
      const re = new RegExp(req.query.search, "i");
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }, { mobileNo: re }];
    }
    const [customers, total] = await Promise.all([
      Customer.find(filter).populate("createdBy", "first_name last_name email").sort({ createdAt: -1 }).skip(skip).limit(limit),
      Customer.countDocuments(filter),
    ]);
    res.json({ customers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
      .populate("createdBy", "first_name last_name email");
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json({ customer });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      req.body, { new: true }
    );
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json({ message: "Customer updated successfully", customer });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      { isDeleted: true, deletedAt: new Date() }, { new: true }
    );
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json({ message: "Customer deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

module.exports = { createCustomer, getCustomers, getCustomerById, updateCustomer, deleteCustomer };
