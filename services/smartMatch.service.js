/**
 * Smart Customer Matching Service
 *
 * Before creating a new customer or lead, search existing CRM records
 * using phone number, email address, platform user ID, or marketplace
 * customer ID.
 *
 * If a match exists:
 *   - Update the existing customer record
 *   - Attach the new conversation to the existing customer
 *   - Do NOT create duplicates
 *
 * This prevents the CRM from having multiple records for the same person
 * across different platforms.
 *
 * Compatible with the existing Customer model (firstName + lastName),
 * while adding new fields for platform-specific IDs.
 */
const Customer = require("../models/customer.model");
const User = require("../models/user.model");
const { logAction } = require("./auditLog.service");

// Cached after first successful lookup so background sync jobs (which have no
// logged-in req.user) don't hit the DB on every customer-create call. Mirrors
// the existing caching pattern in middleware/automationBotAuth.js.
let cachedSystemUserId = null;

/**
 * Resolve a valid `createdBy` ObjectId for customers created by a background
 * sync (e.g. eBay order/message sync) rather than a logged-in CRM user.
 * Reuses the Automation Bot user already seeded/configured for this
 * environment (see middleware/automationBotAuth.js) instead of relaxing the
 * Customer model's existing `createdBy: required` constraint.
 *
 * @returns {Promise<import("mongoose").Types.ObjectId|null>}
 */
async function _resolveSystemCreatedBy() {
  if (cachedSystemUserId) return cachedSystemUserId;

  try {
    const botEmail = process.env.AUTOMATION_BOT_EMAIL;
    if (!botEmail) return null;

    const botUser = await User.findOne({ email: botEmail }).select("_id").lean();
    if (botUser) {
      cachedSystemUserId = botUser._id;
    }
    return cachedSystemUserId;
  } catch (error) {
    console.error("[SMART MATCH] Failed to resolve system createdBy user:", error.message || error);
    return null;
  }
}

/**
 * Search for an existing customer by multiple criteria.
 *
 * Priority order:
 *   1. Platform user ID (if provided)
 *   2. Email address
 *   3. Phone number
 *   4. Platform-specific ID (e.g., Amazon customer ID)
 *
 * @param {Object} criteria
 * @param {string} [criteria.platform] - Platform name
 * @param {string} [criteria.platformUserId] - Platform user ID
 * @param {string} [criteria.email] - Email address
 * @param {string} [criteria.phone] - Phone number
 * @param {string} [criteria.marketplaceCustomerId] - Marketplace customer ID
 * @returns {Promise<Object|null>} Existing customer or null
 */
async function findExistingCustomer(criteria) {
  const { platform, platformUserId, email, phone, marketplaceCustomerId } = criteria;

  // Priority 1: Platform user ID match
  if (platformUserId) {
    const byPlatformId = await Customer.findOne({
      $or: [
        { platformUserId },
        { [`platformIds.${platform}`]: platformUserId },
      ],
    }).lean();

    if (byPlatformId) {
      console.log(`[SMART MATCH] Found customer by platform user ID: ${platformUserId}`);
      return byPlatformId;
    }
  }

  // Priority 2: Marketplace customer ID
  if (marketplaceCustomerId) {
    const byMarketplaceId = await Customer.findOne({
      [`platformIds.${platform}`]: marketplaceCustomerId,
    }).lean();

    if (byMarketplaceId) {
      console.log(`[SMART MATCH] Found customer by marketplace ID: ${marketplaceCustomerId}`);
      return byMarketplaceId;
    }
  }

  // Priority 3: Email match
  if (email) {
    const normalizedEmail = email.toLowerCase().trim();
    const byEmail = await Customer.findOne({
      email: normalizedEmail,
    }).lean();

    if (byEmail) {
      console.log(`[SMART MATCH] Found customer by email: ${normalizedEmail}`);
      return byEmail;
    }
  }

  // Priority 4: Phone match (strip non-digits)
  if (phone) {
    const normalizedPhone = phone.replace(/\D/g, "");
    if (normalizedPhone.length >= 10) {
      const byPhone = await Customer.findOne({
        mobileNo: { $regex: normalizedPhone.slice(-10) },
      }).lean();

      if (byPhone) {
        console.log(`[SMART MATCH] Found customer by phone: ${normalizedPhone}`);
        return byPhone;
      }
    }
  }

  return null;
}

/**
 * Ensure a customer exists, creating one if no match is found.
 * If match found, update platform-specific IDs.
 *
 * @param {Object} customerData
 * @param {string} customerData.platform - Platform name
 * @param {string} [customerData.platformUserId] - Platform user ID
 * @param {string} [customerData.name] - Customer full name
 * @param {string} [customerData.email] - Email
 * @param {string} [customerData.phone] - Phone
 * @param {string} [customerData.profilePicture] - Profile picture URL
 * @param {string} [customerData.language] - Language code
 * @param {string} [customerData.country] - Country code
 * @param {string} [customerData.marketplaceCustomerId] - Marketplace customer ID
 * @param {ObjectId} [customerData.createdBy] - User who created this record
 * @returns {Promise<{customer: Object, isNew: boolean}>}
 */
async function findOrCreateCustomer(customerData) {
  const existing = await findExistingCustomer(customerData);

  if (existing) {
    // Update platform-specific IDs if needed
    const updates = {};
    let needsUpdate = false;

    if (customerData.platformUserId && !existing.platformUserId) {
      updates.platformUserId = customerData.platformUserId;
      needsUpdate = true;
    }

    if (customerData.platform) {
      const platformIdField = `platformIds.${customerData.platform}`;
      if (!existing.platformIds?.[customerData.platform]) {
        updates[platformIdField] = customerData.platformUserId || customerData.marketplaceCustomerId;
        needsUpdate = true;
      }
    }

    if (customerData.profilePicture && !existing.profilePicture) {
      updates.profilePicture = customerData.profilePicture;
      needsUpdate = true;
    }

    if (needsUpdate) {
      await Customer.findByIdAndUpdate(existing._id, updates);
      console.log(`[SMART MATCH] Updated existing customer: ${existing._id}`);
    }

    await logAction({
      action: "customer_matched",
      status: "success",
      platform: customerData.platform,
      entityType: "customer",
      entityId: existing._id,
      message: `Customer matched by existing record: ${existing.firstName || ''} ${existing.lastName || ''} - ${existing.email || existing._id}`,
    });

    return { customer: existing, isNew: false };
  }

  // Split full name into first/last for the existing Customer model
  const nameParts = (customerData.name || "Unknown").trim().split(/\s+/);
  const firstName = nameParts[0] || "Unknown";
  const lastName = nameParts.slice(1).join(" ") || "";

  // customerData.createdBy is preferred when provided (e.g. a CRM-user-driven
  // flow); background/sync flows fall back to the system automation user
  // rather than leaving this required field null.
  const createdBy = customerData.createdBy || (await _resolveSystemCreatedBy());

  // Create new customer using existing model fields
  const newCustomer = await Customer.create({
    firstName,
    lastName,
    email: customerData.email || null,
    mobileNo: customerData.phone || null,
    profilePicture: customerData.profilePicture || null,
    platformUserId: customerData.platformUserId || null,
    platformIds: customerData.platform
      ? { [customerData.platform]: customerData.platformUserId || customerData.marketplaceCustomerId }
      : {},
    language: customerData.language || "en",
    country: customerData.country || null,
    source: customerData.platform || "social",
    createdBy: createdBy || null,
  });

  await logAction({
    action: "customer_created",
    status: "success",
    platform: customerData.platform,
    entityType: "customer",
    entityId: newCustomer._id,
    message: `New customer created from ${customerData.platform || "unknown"}: ${firstName} ${lastName}`,
  });

  console.log(`[SMART MATCH] Created new customer for ${customerData.platform}: ${newCustomer._id}`);
  return { customer: newCustomer.toObject(), isNew: true };
}

/**
 * Find a customer by phone number (convenience wrapper).
 *
 * @param {string} phone - Phone number (with or without formatting)
 * @returns {Promise<Object|null>}
 */
async function findByPhone(phone) {
  if (!phone) return null;
  const normalized = phone.replace(/\D/g, "");
  if (normalized.length < 10) return null;

  const customer = await Customer.findOne({
    mobileNo: { $regex: normalized.slice(-10) },
  });

  return customer || null;
}

module.exports = {
  findExistingCustomer,
  findOrCreateCustomer,
  findByPhone,
};
