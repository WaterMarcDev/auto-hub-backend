/**
 * Seed the "Automation Bot" system user.
 *
 * Run: node scripts/seedAutomationBot.js
 *
 * Idempotent — safe to run multiple times. Creates a User with role
 * "automation" and a random password (never distributed; this account
 * is never intended to log in via the normal auth flow). Chatbot
 * requests authenticate via the AUTOMATION_BOT_API_KEY header instead
 * (see middleware/automationBotAuth.js).
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/user.model");

async function seedAutomationBot() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const email = process.env.AUTOMATION_BOT_EMAIL;

    if (!email) {
      console.error("AUTOMATION_BOT_EMAIL is not set in .env — aborting.");
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    const existing = await User.findOne({ email });

    if (existing) {
      console.log(`Automation Bot user already exists: ${existing._id}`);
      process.exit(0);
    }

    const bot = await User.create({
      first_name: "Automation",
      last_name: "Bot",
      email,
      password: crypto.randomBytes(32).toString("hex"),
      role: "automation",
    });

    console.log(`Automation Bot user created: ${bot._id}`);
    process.exit(0);
  } catch (error) {
    console.error("Error seeding Automation Bot user:", error);
    process.exit(1);
  }
}

seedAutomationBot();
