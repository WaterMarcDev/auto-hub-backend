const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  updateCustomerById,
  deleteCustomerById,
} = require("../controllers/customer.controller");

router.post("/", auth, createCustomer);
router.get("/", auth, getAllCustomers);
router.get("/:id", auth, getCustomerById);
router.put("/:id", auth, updateCustomerById);
router.delete("/:id", auth, deleteCustomerById);

module.exports = router;
