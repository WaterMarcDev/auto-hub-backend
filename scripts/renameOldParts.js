const mongoose = require("mongoose");

const MONGO_URI = "mongodb://localhost:27018";
// const DB_NAME = "NeonCloud_autohub";
// const COLLECTION = "carintakes";

async function renameFields() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("MongoDB connected");

        const db = mongoose.connection.useDb("autohub");

        const result = await db.collection("carintakes").updateMany(
            {},
        {
            $rename: {
                "partDetails.parts.catalyticConverter": "partDetails.parts.A2",
                "partDetails.parts.converter": "partDetails.parts.A1"
            }
        }
        );

        console.log("Matched:", result.matchedCount);
        console.log("Modified:", result.modifiedCount);

        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}

renameFields();