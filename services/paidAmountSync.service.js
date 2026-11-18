/**
 * Paid amount -> Final price sync
 * --------------------------------
 * Business rule: for a car intake, `payment.paidAmount` and `price.finalPrice`
 * must always be the same amount, and `payment.paidAmount` is the source of
 * truth. The car intake's Transaction amount must match it as well.
 *
 * The app keeps them equal on its own writes (see updateCarIntake). This
 * service handles changes made OUTSIDE the app (e.g. editing paidAmount
 * directly in the database), which no app code sees at write time:
 *   - syncPaidAmounts(ids): called by the car intake read endpoints so the
 *     corrected amount is shown immediately when a car is viewed.
 *   - startPaidAmountSync(): a periodic sweep (and one at startup) so other
 *     screens that read finalPrice (seller list, dashboard, transactions)
 *     are corrected even if the car is never opened.
 *
 * Note: MongoDB change streams would make this instant, but they need a
 * replica set; the databases used here are standalone.
 */
const cron = require("node-cron");
const mongoose = require("mongoose");
const CarIntake = require("../models/CarIntake.model");
const Transaction = require("../models/Transaction.model");

const toFiniteAmount = (val) => {
  if (val === undefined || val === null || val === "") return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Make price.finalPrice and the Transaction amount equal to payment.paidAmount.
 * @param {Array<string|ObjectId>} [ids] limit to these car intakes; omit for all.
 * @returns {Promise<Map<string, number>>} car intake id -> synced paid amount
 *   for every intake whose finalPrice was changed.
 */
const syncPaidAmounts = async (ids) => {
  const changed = new Map();
  try {
    const filter = { "payment.paidAmount": { $type: "number" } };
    if (ids) {
      const validIds = ids
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));
      if (validIds.length === 0) return changed;
      filter._id = { $in: validIds };
    }

    const intakes = await CarIntake.find(filter)
      .select("_id price.finalPrice payment.paidAmount")
      .lean();
    if (intakes.length === 0) return changed;

    const paidById = new Map();
    const priceUpdates = [];
    for (const ci of intakes) {
      const paid = toFiniteAmount(ci.payment?.paidAmount);
      if (paid === undefined) continue;
      paidById.set(String(ci._id), paid);
      if (toFiniteAmount(ci.price?.finalPrice) !== paid) {
        changed.set(String(ci._id), paid);
        priceUpdates.push({
          updateOne: {
            filter: { _id: ci._id },
            update: { $set: { "price.finalPrice": paid } },
            // keep updatedAt untouched: this is a consistency fix, not a user edit
            timestamps: false,
          },
        });
      }
    }

    if (priceUpdates.length) {
      await CarIntake.bulkWrite(priceUpdates, { ordered: false, timestamps: false });
    }

    // Transactions: align amount with the paid amount (no tax for car intake
    // purchases, same values updateCarIntake writes). findOneAndUpdate runs
    // the Transaction tax hook so netAmount/taxAmount stay consistent.
    const txs = await Transaction.find({
      carIntake: { $in: intakes.map((ci) => ci._id) },
    })
      .select("_id carIntake amount")
      .lean();
    for (const tx of txs) {
      const paid = paidById.get(String(tx.carIntake));
      if (paid === undefined || toFiniteAmount(tx.amount) === paid) continue;
      await Transaction.findOneAndUpdate(
        { _id: tx._id },
        { $set: { amount: paid, amountIsNet: false, taxRate: 0 } }
      );
    }

    if (changed.size && !ids) {
      console.log(
        `[paidAmountSync] synced finalPrice from paidAmount for ${changed.size} car intake(s)`
      );
    }
  } catch (err) {
    // Never break the request / job because of the sync.
    console.error("[paidAmountSync] sync failed:", err.message || err);
  }
  return changed;
};

/**
 * Apply synced amounts to documents already loaded for a response, so the
 * response shows the corrected finalPrice without re-querying.
 */
const applyPaidAmountsToDocs = (docs, changed) => {
  if (!changed || changed.size === 0) return;
  for (const doc of docs || []) {
    if (!doc) continue;
    const paid = changed.get(String(doc._id));
    if (paid === undefined) continue;
    if (!doc.price) doc.price = {};
    doc.price.finalPrice = paid;
  }
};

let started = false;

/** Periodic full sweep (every 5 minutes) plus one shortly after startup. */
const startPaidAmountSync = () => {
  if (started) return;
  started = true;
  setTimeout(() => syncPaidAmounts(), 10 * 1000);
  cron.schedule("*/5 * * * *", () => syncPaidAmounts());
};

module.exports = {
  syncPaidAmounts,
  applyPaidAmountsToDocs,
  startPaidAmountSync,
  toFiniteAmount,
};
