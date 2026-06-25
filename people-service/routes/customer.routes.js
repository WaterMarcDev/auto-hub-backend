const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { createCustomer, getCustomers, getCustomerById, updateCustomer, deleteCustomer } = require("../controllers/customer.controller");

router.post("/",      auth, createCustomer);
router.get("/",       auth, getCustomers);
router.get("/:id",    auth, getCustomerById);
router.put("/:id",    auth, updateCustomer);
router.delete("/:id", auth, deleteCustomer);

module.exports = router;
