/**
 * Deduplicate Inventory Records
 * 
 * Run: node scripts/deduplicateInventory.js
 * 
 * Finds and removes duplicate Inventory documents that share the same
 * partName + make + model + trim + year + vin combination.
 * Keeps only the earliest created record per group.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const Inventory = require("../models/inventory.model");

async function deduplicate() {
  try {

    const DRY_RUN = process.env.DRY_RUN === "true";

    const mongoUri =
        process.env.MONGODB_URI ||
        process.env.MONGO_URI;
    // const mongoUri = "mongodb://127.0.0.1:27017/test";

        await mongoose.connect(mongoUri);

        console.log("Connected to MongoDB");
        console.log("Mongo URI:", mongoUri);
        console.log("Database:", mongoose.connection.db.databaseName);

        const collections = await mongoose.connection.db
            .listCollections()
            .toArray();

        console.log(
                "Collections:",
                collections.map(c => c.name)
        );

        const totalInventory = await Inventory.countDocuments();

        console.log("Model Collection:", Inventory.collection.name);

        console.log("Inventory Count:", totalInventory);

        if (totalInventory === 0) {
            console.warn(
                "WARNING: Inventory collection is empty. Verify you are connected to the correct databse."
            );
        }
    // await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/autohub");
    // console.log("Connected to MongoDB");

    // Find duplicate groups
    const duplicates = await Inventory.aggregate([
      {
        $match: {
            vin: {
                $exists: true,
                $ne: ""
            }
        }
      },
      {
        $group: {
          _id: {
            vin: "$vin",
            partName: { $toLower: "$partName" },
            // make: "$make",
            // model: "$model",
            // trim: "$trim",
            // year: "$year",
          },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
          createdAt: { $push: "$createdAt" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    console.log(`Found ${duplicates.length} duplicate groups`);

    console.log(
        `Total duplicate records found: ${
            duplicates.reduce((sum, group) => sum + (group.count - 1), 0)
        }`
    );

    let totalRemoved = 0;

    for (const group of duplicates) {

        // Get actual records sorted by oldest first
        const records = await Inventory.find({
            _id: { $in: group.ids }
        }).sort({ createdAt: 1 });

        const keepId = records[0]._id;

        const removeIds = records
            .slice(1)
            .map(record => record._id);

      // Keep first (oldest) record, remove the rest
    //   const [keepId, ...removeIds] = group.ids;

    let removedCount = 0;

    if (DRY_RUN) {
        removedCount = removeIds.length;

        console.log({
            vin: group._id.vin,
            part: group._id.partName,
            keepId,
            removeIds,
            duplicateCount: group.count
        });
    } else {
        const result = await Inventory.deleteMany({ _id: { $in: removeIds } });
        }
        // removedCount = result.deletedCount;
        // totalRemoved += result.deletedCount;


      console.log(
        // `Group "${group._id.partName}" — kept: ${keepId}, removed ${result.deletedCount} duplicates`
        `VIN: ${group._id.vin} | Part: ${group._id.partName} | Kept: ${keepId} | Removed: ${removedCount}`
      );
    }

    // Count remaining
    const remaining = await Inventory.countDocuments();
    console.log(`\nDone. Total removed: ${totalRemoved}`);
    console.log(`Total remaining inventory: ${remaining}`);

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

deduplicate();