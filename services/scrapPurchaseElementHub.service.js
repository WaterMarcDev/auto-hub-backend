/**
 * Scrap Purchase → Element Hub stock.
 *
 * Scrap material bought from a supplier (Scrap Purchase module) is added to
 * the same Element Hub stock that car extractions feed, so the hub shows
 * everything the yard holds and can sell.
 *
 *   create purchase  → add each material's weight to its hub element
 *   edit purchase    → apply only the DIFFERENCE (e.g. Copper 50 → 60 lb adds 10)
 *   delete purchase  → take the purchase's weight back out of the hub
 *
 * What a purchase has added is stored on the purchase itself
 * (ScrapPurchase.elementHubPosted), so an edit or delete can never
 * double-count. Purchases created before this integration have no
 * elementHubPosted value; they never added stock, so they are left alone.
 *
 * Element names: material names match hub elements case-insensitively, and
 * the American spelling "Aluminum" is stored under the yard's element name
 * "Aluminium" — so "aluminum", "ALUMINIUM" and "Aluminium" all land on one
 * "Aluminium" row.
 *
 * Safety: stock can't go negative. If a reduction is bigger than what's left
 * in the hub (because it was already sold), the edit/delete is refused with
 * ElementHubStockError (HTTP 409) and nothing changes. There are no Mongo
 * transactions in this app, so every hub change made in one call is undone
 * if a later step fails (see rollback()).
 *
 * This file does not change addToHubInternal or any car-scrap / sell code.
 */
const ElementHub = require("../models/ElementHub.model");
const ElementHubHistory = require("../models/ElementHubHistory.model");
const Element = require("../models/Element.model");
const ScrapPurchase = require("../models/ScrapPurchase.model");

const SOURCE = "scrap-purchase";
const UNIT = "lb";
const LOG_PREFIX = "[SCRAP PURCHASE → ELEMENT HUB]";

class ElementHubStockError extends Error {
  constructor(message) {
    super(message);
    this.name = "ElementHubStockError";
    this.statusCode = 409;
  }
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const roundWeight = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 1000) / 1000;
const exactNameRegex = (name) => new RegExp(`^\\s*${escapeRegex(name)}\\s*$`, "i");

/** "aluminum" / "ALUMINIUM" / " Aluminum  Rims " → "Aluminium" / "Aluminium Rims". */
function canonicalElementName(raw) {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) return "";
  return name.replace(/\balumin(?:i)?um\b/gi, "Aluminium");
}

/** Bill label used in hub history notes, e.g. "SP-0000012". */
function billLabel(purchase) {
  const prefix = purchase?.billPrefix || "SP";
  return purchase?.billNumber ? `${prefix}-${String(purchase.billNumber).padStart(7, "0")}` : prefix;
}

/**
 * Stock a purchase should contribute: one row per element (case-insensitive),
 * weight in lb. Uses items[] when present, otherwise the single top-level
 * material (legacy single-material purchases). Lines without weight add nothing.
 * @returns {Array<{elementName: string, amount: number}>}
 */
function desiredStock(purchase) {
  const items = Array.isArray(purchase?.items) ? purchase.items : [];
  const lines = items.length
    ? items.map((it) => ({ name: it.materialName, weight: it.weightLbs }))
    : [{ name: purchase?.materialName, weight: purchase?.weightLbs }];

  const byKey = new Map();
  for (const line of lines) {
    const elementName = canonicalElementName(line.name);
    const weight = Number(line.weight);
    if (!elementName || !Number.isFinite(weight) || weight <= 0) continue;
    const key = elementName.toLowerCase();
    const prev = byKey.get(key);
    byKey.set(key, {
      elementName: prev ? prev.elementName : elementName,
      amount: roundWeight((prev ? prev.amount : 0) + weight),
    });
  }
  return [...byKey.values()];
}

async function findHubByName(name) {
  return ElementHub.findOne({ elementName: exactNameRegex(name), isDeleted: { $ne: true } })
    .sort({ createdAt: 1 })
    .lean();
}

/** The hub row a stored posting refers to now (by id, falling back to name). */
async function resolvePostedHub(posting) {
  if (posting.elementHubId) {
    const byId = await ElementHub.findOne({ _id: posting.elementHubId, isDeleted: { $ne: true } }).lean();
    if (byId) return byId;
  }
  return posting.elementName ? findHubByName(posting.elementName) : null;
}

/**
 * Work out per-element changes between what the purchase has posted and what
 * it should post now.
 * @returns {Promise<Array<{hubId: string|null, elementName: string, delta: number, finalAmount: number}>>}
 */
async function buildPlan(oldPostings, desired) {
  const oldByHubId = new Map();
  const orphanedOld = [];
  for (const p of oldPostings) {
    const amount = roundWeight(p.amount);
    if (amount <= 0) continue;
    const hub = await resolvePostedHub(p);
    if (!hub) {
      orphanedOld.push({ ...p, amount });
      continue;
    }
    const id = String(hub._id);
    const prev = oldByHubId.get(id);
    oldByHubId.set(id, { elementName: hub.elementName, amount: roundWeight((prev ? prev.amount : 0) + amount) });
  }

  const ops = [];
  for (const d of desired) {
    const hub = await findHubByName(d.elementName);
    const id = hub ? String(hub._id) : null;
    const elementName = hub ? hub.elementName : d.elementName;
    if (id && oldByHubId.has(id)) {
      const old = oldByHubId.get(id);
      oldByHubId.delete(id);
      ops.push({ hubId: id, elementName, delta: roundWeight(d.amount - old.amount), finalAmount: d.amount });
    } else {
      ops.push({ hubId: id, elementName, delta: d.amount, finalAmount: d.amount });
    }
  }
  for (const [id, old] of oldByHubId) {
    ops.push({ hubId: id, elementName: old.elementName, delta: -old.amount, finalAmount: 0 });
  }
  for (const p of orphanedOld) {
    // The hub row this purchase added to no longer exists (deleted/merged
    // away), so there is nothing left to take back from.
    console.warn(`${LOG_PREFIX} Hub row for "${p.elementName}" no longer exists — skipping reversal of ${p.amount} ${UNIT}`);
  }
  return ops;
}

async function findElementId(elementName) {
  const el = await Element.findOne({ name: exactNameRegex(elementName), isDeleted: { $ne: true } })
    .select("_id")
    .lean();
  return el ? el._id : undefined;
}

/**
 * Move the purchase's hub stock from `oldPostings` to `desired`.
 *
 * Hub totals are updated immediately. The caller then saves the purchase and:
 *   - on success calls commitHistory() to write the Element Hub history rows;
 *   - on failure calls rollback() to undo the hub totals.
 *
 * @throws {ElementHubStockError} if a reduction exceeds the hub's stock
 *   (nothing is left changed when this is thrown).
 */
async function applyPostingChange({ purchase, oldPostings = [], desired, userId, reason }) {
  const ops = await buildPlan(oldPostings, desired);
  const applied = []; // { hubId, elementId, elementName, delta }

  const rollback = async () => {
    for (const a of [...applied].reverse()) {
      try {
        await ElementHub.updateOne({ _id: a.hubId }, { $inc: { totalWeight: -a.delta } });
      } catch (err) {
        console.error(`${LOG_PREFIX} ROLLBACK FAILED for ${a.elementName} (${a.delta} ${UNIT}) — fix the hub total manually:`, err.message);
      }
    }
    applied.length = 0;
  };

  try {
    // Reductions first: if one can't be done, fail before anything is added.
    for (const op of ops.filter((o) => o.delta < 0)) {
      const amount = -op.delta;
      const hub = await ElementHub.findOneAndUpdate(
        { _id: op.hubId, totalWeight: { $gte: amount } },
        { $inc: { totalWeight: -amount } },
        { new: true }
      );
      if (!hub) {
        const current = await ElementHub.findById(op.hubId).select("totalWeight").lean();
        const left = roundWeight(current ? current.totalWeight : 0);
        throw new ElementHubStockError(
          `Cannot take ${amount} ${UNIT} of ${op.elementName} back out of Element Hub — only ${left} ${UNIT} is left (the rest has already been sold).`
        );
      }
      applied.push({ hubId: hub._id, elementId: hub.elementId, elementName: hub.elementName, delta: op.delta });
    }

    for (const op of ops.filter((o) => o.delta > 0)) {
      let hub = null;
      if (op.hubId) {
        hub = await ElementHub.findOneAndUpdate({ _id: op.hubId }, { $inc: { totalWeight: op.delta } }, { new: true });
      }
      if (!hub) {
        // New element (or its row vanished): create/upsert by name, the same
        // way car extractions do in addToHubInternal.
        const elementId = await findElementId(op.elementName);
        hub = await ElementHub.findOneAndUpdate(
          { elementName: op.elementName },
          { $setOnInsert: { elementId, unit: UNIT }, $inc: { totalWeight: op.delta } },
          { new: true, upsert: true }
        );
      }
      op.hubId = String(hub._id);
      applied.push({ hubId: hub._id, elementId: hub.elementId, elementName: hub.elementName, delta: op.delta });
    }
  } catch (err) {
    await rollback();
    throw err;
  }

  const postings = ops
    .filter((op) => op.finalAmount > 0 && op.hubId)
    .map((op) => ({ elementHubId: op.hubId, elementName: op.elementName, amount: op.finalAmount }));

  const commitHistory = async () => {
    if (!applied.length) return;
    const label = billLabel(purchase);
    const supplier = purchase?.supplierSnapshot?.name ? ` — ${purchase.supplierSnapshot.name}` : "";
    const suffix = reason === "edited" ? " (edited)" : reason === "deleted" ? " (deleted)" : "";
    try {
      await ElementHubHistory.insertMany(
        applied.map((a) => ({
          elementHubId: a.hubId,
          elementId: a.elementId,
          elementName: a.elementName,
          type: a.delta > 0 ? "add" : "adjust",
          amount: a.delta,
          unit: UNIT,
          source: SOURCE,
          scrapPurchaseId: purchase._id,
          note: `Scrap Purchase ${label}${supplier}${suffix}`,
          createdBy: userId || undefined,
        }))
      );
    } catch (err) {
      // Same policy as car extractions: history is logged, never blocks stock.
      console.error(`${LOG_PREFIX} History write failed for ${label}:`, err.message);
    }
  };

  return { postings, changed: applied.length > 0, commitHistory, rollback };
}

/** True when the purchase takes part in Element Hub stock (created after the integration). */
function isTracked(purchase) {
  return Array.isArray(purchase?.elementHubPosted);
}

/** Plain copies of the stored postings (safe to diff against). */
function currentPostings(purchase) {
  return (purchase.elementHubPosted || []).map((p) => ({
    elementHubId: p.elementHubId,
    elementName: p.elementName,
    amount: Number(p.amount) || 0,
  }));
}

/**
 * After a purchase is created: add its materials to the hub and record what
 * was added on the purchase. Never fails the create — a hub error is stored
 * on the purchase (elementHubError) and logged, and the purchase is left with
 * an empty posting list so a later edit adds the full stock.
 * @returns {Promise<{elementHubPosted: Array, elementHubError: string|null}>}
 */
async function postCreatedPurchase(purchase, userId) {
  const now = new Date();
  let change = null;
  try {
    change = await applyPostingChange({ purchase, oldPostings: [], desired: desiredStock(purchase), userId, reason: "created" });
    await ScrapPurchase.updateOne(
      { _id: purchase._id },
      { $set: { elementHubPosted: change.postings, elementHubPostedAt: now, elementHubError: null } }
    );
    await change.commitHistory();
    return { elementHubPosted: change.postings, elementHubError: null };
  } catch (err) {
    if (change) await change.rollback();
    const message = `Stock was not added to Element Hub: ${err.message}`;
    console.error(`${LOG_PREFIX} ${billLabel(purchase)}: ${message}`);
    try {
      await ScrapPurchase.updateOne(
        { _id: purchase._id },
        { $set: { elementHubPosted: [], elementHubPostedAt: now, elementHubError: message } }
      );
    } catch (persistErr) {
      console.error(`${LOG_PREFIX} Could not record the hub error on ${billLabel(purchase)}:`, persistErr.message);
    }
    return { elementHubPosted: [], elementHubError: message };
  }
}

/**
 * Before saving an edited purchase: move hub stock to match its new lines.
 * Returns null for purchases that predate the integration. The caller must
 * save, then commitHistory() — or rollback() if the save fails.
 * The purchase document is updated in memory (postings + version bump, so a
 * concurrent edit fails with a VersionError instead of double-posting).
 * @throws {ElementHubStockError}
 */
async function prepareEdit(purchase, userId) {
  if (!isTracked(purchase)) return null;
  const change = await applyPostingChange({
    purchase,
    oldPostings: currentPostings(purchase),
    desired: desiredStock(purchase),
    userId,
    reason: "edited",
  });
  purchase.elementHubPosted = change.postings;
  purchase.elementHubPostedAt = new Date();
  purchase.elementHubError = null;
  purchase.increment();
  return change;
}

/**
 * Before soft-deleting a purchase: take its stock back out of the hub.
 * Returns null when there's nothing to reverse.
 * @throws {ElementHubStockError}
 */
async function prepareDelete(purchase, userId) {
  if (!isTracked(purchase) || purchase.isDeleted) return null;
  const old = currentPostings(purchase);
  if (!old.some((p) => p.amount > 0)) return null;
  return applyPostingChange({ purchase, oldPostings: old, desired: [], userId, reason: "deleted" });
}

module.exports = {
  ElementHubStockError,
  canonicalElementName,
  desiredStock,
  isTracked,
  postCreatedPurchase,
  prepareEdit,
  prepareDelete,
};
