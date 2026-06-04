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
      priceData: { price: 0 },
      // price: 0,
      visible: false,
      slug: `${item.make.name}-${item.model.name}-${
        item.trim.name
      }-${item.partName.replace(/([A-Z])/g, "-$1").replace(/^-/, "")}-${
        item.year
      }`,
      brand: item.make.name,

      customTextFields: [
        { title: "externalId", value: item._id.toString() },
        { title: "make", value: item.make.name },
        { title: "model", value: item.model.name },
        { title: "trim", value: item.trim.name },
        { title: "year", value: item.year.toString() },
      ],
      // customTextFields: [
      //   { externalId: item._id.toString() },
      //   { make: item.make.name },
      //   { model: item.model.name },
      //   { trim: item.trim.name },
      //   { year: item.year.toString() },
      // ],
      currency: "USD",
    }));

    // send wixData in response and mark items as synced
    for (const item of inventoriesToSync) {
      item.wixSynced = true;     //uncommented by shiva
      item.wixSyncedAt = new Date();
      await item.save();
    }

    // Temp. Debug by shiva
    console.log("WIX PRODUCTS COUNT:", wixData.length);

    if (wixData.length) {
      console.log(
        "FIRST PRODUCT:",
        JSON.stringify(wixData[0], null, 2)
      );
    }
    // end here

    res.status(200).json(wixData);   // added by shiva
    // res.status(200).json({ syncedItems: wixData });
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
