const customerService = require("../services/customer.service");

function handleError(res, error) {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json(error.payload || { message: error.message });
  }
  return res.status(500).json({ message: error.message });
}

const createCustomer = async (req, res) => {
  try {
    const newCustomer = await customerService.createCustomer(req.body, req.user._id);
    res.status(201).json(newCustomer);
  } catch (error) {
    handleError(res, error);
  }
};

const getAllCustomers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await customerService.getAllCustomers({
      page,
      limit,
      type: req.query.type,
      search: req.query.search,
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(res, error);
  }
};

const getCustomerById = async (req, res) => {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    res.status(200).json(customer);
  } catch (error) {
    handleError(res, error);
  }
};

const updateCustomerById = async (req, res) => {
  try {
    const customer = await customerService.updateCustomerById(req.params.id, req.body);
    res.status(200).json(customer);
  } catch (error) {
    handleError(res, error);
  }
};

const deleteCustomerById = async (req, res) => {
  try {
    await customerService.deleteCustomerById(req.params.id);
    res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomerById,
  deleteCustomerById,
};
