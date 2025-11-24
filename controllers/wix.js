const Inventory = require("../models/Inventory.model");

const syncWithWix = async (req, res) => {
  try {
    // all inventory where wixSync is true
    const inventoriesToSync = await Inventory.find({ wixSynced: false })
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name");
    // Prepare data for Wix
    const wixData = inventoriesToSync.map((item) => ({
      name: item.partName
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (str) => str.toUpperCase())
        .trim(),
      sku: item.sku,
      productType: "physical",
      visible: false,
      slug: `${item.partName
        .replace(/([A-Z])/g, "-$1")
        .toLowerCase()
        .replace(/^-/, "")}`,
      brand: item.make.name,
      customTextFields: [
        { externalId: item._id.toString() },
        { make: item.make.name },
        { model: item.model.name },
        { trim: item.trim.name },
        { year: item.year.toString() },
      ],
      price: 0,
      currency: "USD",
    }));

    // send wixData in response and mark items as synced
    for (const item of inventoriesToSync) {
      // item.wixSynced = true;
      item.wixSyncedAt = new Date();
      await item.save();
    }

    res.status(200).json({ syncedItems: wixData });
  } catch (error) {
    console.error("Error syncing with Wix:", error);
    res
      .status(500)
      .json({ error: "An error occurred while syncing with Wix." });
  }
};

module.exports = {
  syncWithWix,
};
