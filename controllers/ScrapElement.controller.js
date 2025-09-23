const ScrapElement = require("../models/ScrapElements");

// Create Scrap Element
const createScrapElement = async (req, res) => {
  try {
    const { elementName, unit, quality, weight, dimensions, vin } = req.body;

    // Validate required fields
    if (!elementName || vin == null || vin === "") {
      return res
        .status(400)
        .json({ message: "Element name and VIN are required." });
    }

    // Normalize VIN: treat VIN as a string (trim and uppercase)
    let vinString = String(vin).trim().toUpperCase();

    // unit is optional; if provided it must be a number >=1

    // Create new Scrap Element (store VIN string)
    const newScrapElement = new ScrapElement({
      elementName: String(elementName).trim(),
      unit: unit,
      quality: quality ? String(quality).trim() : undefined,
      weight: weight,
      dimensions: dimensions ? String(dimensions).trim() : undefined,
      vin: vinString,
    });

    // Save to database
    const savedElement = await newScrapElement.save();
    res.status(201).json(savedElement);
  } catch (error) {
    console.error("Error creating scrap element:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get all Scrap Elements
const getScrapElementsByVIN = async (req, res) => {
  try {
    const { vin } = req.params;

    // Normalize VIN query to uppercase trimmed string
    const vinQuery = String(vin).trim().toUpperCase();

    const scrapElements = await ScrapElement.find({ vin: vinQuery });
    res.status(200).json(scrapElements);
  } catch (error) {
    console.error("Error fetching scrap elements:", error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createScrapElement,
  getScrapElementsByVIN,
};
