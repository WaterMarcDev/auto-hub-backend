/**
 * Order Controller
 *
 * Thin HTTP layer over services/order.service.js — see that file for the
 * business logic documentation this controller previously held directly.
 */
const orderService = require("../services/order.service");

/**
 * GET /api/orders
 */
exports.getAll = async (req, res) => {
  try {
    const result = await orderService.getAllOrders(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[ORDER] Get all error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/orders/:id
 */
exports.getById = async (req, res) => {
  try {
    const data = await orderService.getOrderById(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error("[ORDER] Get by ID error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/orders/:id/status
 */
exports.updateStatus = async (req, res) => {
  try {
    const order = await orderService.updateOrderStatus(req.params.id, req.body, req.user?._id);
    res.json({ success: true, data: order });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error("[ORDER] Update status error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
