const scrapElementService = require("../services/scrapElement.service");

// Create Scrap Element
const createScrapElement = async (req, res) => {
  try {
    const savedElement = await scrapElementService.createScrapElement(
      req.body,
      req.user ? req.user._id : undefined
    );
    res.status(201).json(savedElement);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error("Error creating scrap element:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get all Scrap Elements
const getScrapElementsByVIN = async (req, res) => {
  try {
    const scrapElements = await scrapElementService.getScrapElementsByVIN(req.params.vin);
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
