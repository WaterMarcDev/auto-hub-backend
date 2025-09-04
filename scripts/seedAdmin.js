const mongoose = require("mongoose");
const User = require("../models/User");
require("dotenv").config();

const seedAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://localhost:27017/autohub"
    );
    console.log("Connected to MongoDB");

    // Check if admin already exists
    const adminExists = await User.findOne({ email: "admin@autohub.com" });

    if (adminExists) {
      console.log("Admin user already exists");
      process.exit(0);
    }

    // Create admin user
    const admin = new User({
      first_name: "Admin",
      last_name: "User",
      email: "admin@autohub.com",
      password: "Admin123!",
      role: "admin",
    });

    await admin.save();
    console.log("Admin user created successfully");
    console.log("Email: admin@autohub.com");
    console.log("Password: Admin123!");
  } catch (error) {
    console.error("Error seeding admin:", error);
  } finally {
    mongoose.disconnect();
  }
};

seedAdmin();
