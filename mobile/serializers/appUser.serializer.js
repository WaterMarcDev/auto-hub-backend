/**
 * Formats a Date object to "MMM YYYY" (e.g., "Mar 2024")
 */
function formatMemberSince(date) {
  if (!date) return "";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      year: "numeric",
    }).format(d);
  } catch (err) {
    return "";
  }
}

/**
 * Strict Serializer for Mobile App User JSON contract
 * Strips all internal fields (passwordHash, fcmTokens, __v)
 */
function serializeAppUser(doc) {
  if (!doc) return null;

  // Handle Mongoose Document vs raw POJO
  const obj = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };

  const rawId = obj._id ? obj._id.toString() : obj.id || "";
  const cleanId = rawId.startsWith("usr_") ? rawId : `usr_${rawId}`;

  const defaultSettings = {
    pushNotifications: true,
    emailNotifications: true,
    priceDropAlerts: false,
    orderUpdates: true,
    chatMessages: true,
    notificationSounds: true,
    vibration: true,
    darkMode: true,
    autoDistanceUnit: true,
    selectedLanguage: "English",
    selectedLanguageFlag: "🇺🇸",
  };

  const defaultAddress = {
    id: null,
    streetAddress: "",
    city: "",
    state: "",
    zip: "",
  };

  const defaultPaymentMethod = {
    id: null,
    brand: "",
    last4: "",
    expiry: "",
  };

  const defaultStats = {
    activeOrders: 0,
    savedPartsCount: 0,
    junkRequestsCount: 0,
  };

  return {
    id: cleanId,
    fullName: obj.fullName || "",
    email: obj.email || "",
    phone: obj.phone || "",
    location: obj.location || "",
    avatarUrl: obj.avatarUrl || null,
    memberSince: formatMemberSince(obj.createdAt),
    accountType: obj.accountType || "buyer",
    isVerified: Boolean(obj.isVerified),
    status: obj.status || "active",
    settings: {
      ...defaultSettings,
      ...(obj.settings || {}),
    },
    defaultAddress: {
      ...defaultAddress,
      ...(obj.defaultAddress || {}),
    },
    defaultPaymentMethod: {
      ...defaultPaymentMethod,
      ...(obj.defaultPaymentMethod || {}),
    },
    stats: {
      ...defaultStats,
      ...(obj.stats || {}),
    },
    createdAt: obj.createdAt ? new Date(obj.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: obj.updatedAt ? new Date(obj.updatedAt).toISOString() : new Date().toISOString(),
  };
}

module.exports = {
  serializeAppUser,
  formatMemberSince,
};
