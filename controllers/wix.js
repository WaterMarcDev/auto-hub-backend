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
      inStock: false,
      name: item.partName
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (str) => str.toUpperCase())
        .trim(),
      sku: item.sku,
      productOptions: [
        { name: "Make", value: item.make.name },
        { name: "Model", value: item.model.name },
        { name: "Trim", value: item.trim.name },
        { name: "Year", value: item.year.toString() }, // Convert to string if number
      ],
      slug: `${item.partName
        .replace(/([A-Z])/g, "-$1")
        .toLowerCase()
        .replace(/^-/, "")}`,
      brand: item.make.name,
      customTextFields: [
        {
          externalId: item._id.toString(),
        },
      ],
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
