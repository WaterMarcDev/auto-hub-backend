/**
 * Order Status Normalization
 *
 * Marketplace order data must never be manually maintained inside the CRM —
 * Order Status, Payment Status, Refund Status, and Shipping Status are
 * always derived from the marketplace's own data at sync time. This module
 * maps eBay's raw Fulfillment API status strings into a single canonical
 * vocabulary shared by both storage (services/adapters/ebayAdapter.js) and
 * the Marketplace Orders page's filters (src/pages/Orders.jsx), so a stored
 * value and a filter option can never mismatch.
 *
 * IMPORTANT: no raw eBay order response has ever been captured/logged on
 * this system (logs/access.log and logs/error.log are both empty), so the
 * raw eBay key names below are this codebase's best-known reference —
 * carried over from the previously-unused _mapOrderStatus/_mapShippingStatus
 * tables in ebayAdapter.js — NOT verified against a live payload. Anything
 * unrecognized falls back to "Unknown" rather than being guessed further.
 */

const ORDER_STATUS = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  AWAITING_SHIPMENT: "Awaiting Shipment",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out For Delivery",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
  REFUND_PENDING: "Refund Pending",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partially Refunded",
  UNKNOWN: "Unknown",
};

const PAYMENT_STATUS = {
  PAID: "Paid",
  PENDING: "Pending",
  FAILED: "Failed",
  PARTIALLY_PAID: "Partially Paid",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partially Refunded",
  UNKNOWN: "Unknown",
};

const REFUND_STATUS = {
  NOT_REFUNDED: "Not Refunded",
  REFUND_PENDING: "Refund Pending",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partially Refunded",
};

// "Lost" is part of the requested Shipping Status vocabulary, but eBay's
// Fulfillment API has no "lost package" signal this integration can ever
// observe — it is intentionally never emitted (honest gap, not a bug).
const SHIPPING_STATUS = {
  AWAITING_SHIPMENT: "Awaiting Shipment",
  PROCESSING: "Processing",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
  UNKNOWN: "Unknown",
};

// eBay raw orderPaymentStatus -> canonical Payment Status
const RAW_PAYMENT_STATUS_MAP = {
  PAID: PAYMENT_STATUS.PAID,
  PENDING: PAYMENT_STATUS.PENDING,
  FAILED: PAYMENT_STATUS.FAILED,
  PARTIALLY_REFUNDED: PAYMENT_STATUS.PARTIALLY_REFUNDED,
  REFUNDED: PAYMENT_STATUS.REFUNDED,
  ESCROW_CHECK: PAYMENT_STATUS.PENDING,
  CANCELLED: PAYMENT_STATUS.FAILED,
};

// eBay raw orderFulfillmentStatus -> canonical Shipping Status
const RAW_SHIPPING_STATUS_MAP = {
  NOT_STARTED: SHIPPING_STATUS.AWAITING_SHIPMENT,
  IN_PROGRESS: SHIPPING_STATUS.PROCESSING,
  FULFILLED: SHIPPING_STATUS.SHIPPED,
  SHIPPED: SHIPPING_STATUS.SHIPPED,
  DELIVERED: SHIPPING_STATUS.DELIVERED,
  CANCELLED: SHIPPING_STATUS.CANCELLED,
};

// eBay raw orderFulfillmentStatus -> canonical Order Status (overall lifecycle)
const RAW_ORDER_STATUS_MAP = {
  NOT_STARTED: ORDER_STATUS.AWAITING_SHIPMENT,
  IN_PROGRESS: ORDER_STATUS.PROCESSING,
  FULFILLED: ORDER_STATUS.COMPLETED,
  SHIPPED: ORDER_STATUS.SHIPPED,
  DELIVERED: ORDER_STATUS.COMPLETED,
  CANCELLED: ORDER_STATUS.CANCELLED,
};

/**
 * Normalize a raw eBay Fulfillment API order object into the CRM's
 * canonical status vocabulary.
 *
 * @param {Object} rawOrder - raw order object from eBay's Fulfillment API
 * @returns {{orderStatus: string, paymentStatus: string, refundStatus: string, shippingStatus: string}}
 */
function normalizeOrderStatuses(rawOrder = {}) {
  const rawPayment = String(rawOrder.orderPaymentStatus || "").toUpperCase();
  const rawFulfillment = String(rawOrder.orderFulfillmentStatus || "").toUpperCase();
  const cancelState = String(rawOrder.cancelStatus?.cancelState || "").toUpperCase();

  const paymentStatus = RAW_PAYMENT_STATUS_MAP[rawPayment] || PAYMENT_STATUS.UNKNOWN;
  const shippingStatus = RAW_SHIPPING_STATUS_MAP[rawFulfillment] || SHIPPING_STATUS.UNKNOWN;

  let orderStatus = RAW_ORDER_STATUS_MAP[rawFulfillment] || ORDER_STATUS.UNKNOWN;
  // Cancellation/refund signals take precedence over the fulfillment-derived status.
  if (cancelState === "CANCELED" || cancelState === "CANCELLED") {
    orderStatus = ORDER_STATUS.CANCELLED;
  } else if (rawPayment === "REFUNDED") {
    orderStatus = ORDER_STATUS.REFUNDED;
  } else if (rawPayment === "PARTIALLY_REFUNDED") {
    orderStatus = ORDER_STATUS.PARTIALLY_REFUNDED;
  }

  // Refund Status is best-effort only, derived from signals already present
  // on the same Fulfillment API order object. No dedicated refund/return API
  // integration exists in this codebase — eBay's Post-Order API would be
  // required for full refund/return detail (returns filed by the buyer
  // without a payment-status change would not be reflected here).
  let refundStatus = REFUND_STATUS.NOT_REFUNDED;
  if (rawPayment === "REFUNDED") {
    refundStatus = REFUND_STATUS.REFUNDED;
  } else if (rawPayment === "PARTIALLY_REFUNDED") {
    refundStatus = REFUND_STATUS.PARTIALLY_REFUNDED;
  } else if (cancelState === "IN_PROGRESS") {
    refundStatus = REFUND_STATUS.REFUND_PENDING;
  }

  return { orderStatus, paymentStatus, refundStatus, shippingStatus };
}

module.exports = {
  normalizeOrderStatuses,
  ORDER_STATUS,
  PAYMENT_STATUS,
  REFUND_STATUS,
  SHIPPING_STATUS,
};
