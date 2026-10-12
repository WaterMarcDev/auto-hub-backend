const mongoose = require("mongoose");
const Element = require("../models/Element.model");
const ElementHub = require("../models/ElementHub.model");
const ElementHubHistory = require("../models/ElementHubHistory.model");
const ScrapElement = require("../models/ScrapElement.model");

// Element Hub stock, its history and saved scrap elements reference elements
// by NAME, so a rename must move them too — merging into an existing hub of
// the new name — or stock would be split between the two names.
const renameElementEverywhere = async (oldName, newName) => {
  const oldHub = await ElementHub.findOne({ elementName: oldName });
  if (oldHub) {
    const newHub = await ElementHub.findOne({ elementName: newName });
    if (newHub) {
      await ElementHub.updateOne({ _id: newHub._id }, { $inc: { totalWeight: oldHub.totalWeight || 0 } });
      await ElementHubHistory.updateMany({ elementHubId: oldHub._id }, { $set: { elementHubId: newHub._id } });
      await ElementHub.deleteOne({ _id: oldHub._id });
    } else {
      await ElementHub.updateOne({ _id: oldHub._id }, { $set: { elementName: newName } });
    }
  }
  await ElementHubHistory.updateMany({ elementName: oldName }, { $set: { elementName: newName } });
  await ScrapElement.updateMany({ elementName: oldName }, { $set: { elementName: newName } });
};

// @desc    Create a new element
// @route   POST /api/elements
const createElement = async (req, res) => {
  try {
    const { name, shortName, weight, dimensions, description } = req.body;

    // Check if element with the same name already exists
    const existingElement = await Element.findOne({ name });
    if (existingElement) {
      return res.status(400).json({
        message: "Element with this name already exists",
      });
    }

    const element = await Element.create({
      name,
      shortName,
      weight,
      dimensions,
      description,
    });

    res.status(201).json({
      message: "Element created successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error creating element:", error);
    res.status(500).json({
      message: "Server error while creating element",
    });
  }
};

// @desc    Get all elements
// @route   GET /api/elements
const getAllElements = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter object
    const filter = {};

    // Exclude soft-deleted elements
    filter.isDeleted = { $ne: true };
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: "i" };
    }
    const elements = await Element.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ name: 1 });
    const total = await Element.countDocuments(filter);

    res.status(200).json({
      elements,
      pagination: {
        page,
        limit,
        total,
      },
    });
  } catch (error) {
    console.error("Error fetching elements:", error);
    res.status(500).json({
      message: "Server error while fetching elements",
    });
  }
};

// @desc    Get element by ID
// @route   GET /api/elements/:id
const getElementById = async (req, res) => {
  try {
    const element = await Element.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
    });
    if (!element) {
      return res.status(404).json({ message: "Element not found" });
    }
    res.status(200).json(element);
  } catch (error) {
    console.error("Error fetching element:", error);
    res.status(500).json({
      message: "Server error while fetching element",
    });
  }
};

// @desc    Update element by ID
// @route   PUT /api/elements/:id
const updateElement = async (req, res) => {
  try {
    const { name, shortName, weight, dimensions, description } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Element not found" });
    }
    const existing = await Element.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!existing) {
      return res.status(404).json({ message: "Element not found" });
    }

    const newName = typeof name === "string" ? name.trim() : existing.name;
    if (!newName) {
      return res.status(400).json({ message: "Element name is required" });
    }

    // Renaming: refuse a name another active element already uses, then move
    // stock/history/saved elements to the new name so stock is never split.
    if (newName !== existing.name) {
      const duplicate = await Element.findOne({
        _id: { $ne: existing._id },
        isDeleted: { $ne: true },
        name: { $regex: `^${newName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
      });
      if (duplicate) {
        return res.status(409).json({ message: `An element named "${duplicate.name}" already exists` });
      }
      await renameElementEverywhere(existing.name, newName);
    }

    const element = await Element.findByIdAndUpdate(
      existing._id,
      {
        name: newName,
        shortName,
        weight,
        dimensions,
        description,
      },
      { new: true }
    );

    res.status(200).json({
      message: "Element updated successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error updating element:", error);
    res.status(500).json({
      message: "Server error while updating element",
    });
  }
};

const deleteElement = async (req, res) => {
  try {
    const element = await Element.findById(req.params.id);
    if (!element || element.isDeleted) {
      return res.status(404).json({ message: "Element not found" });
    }

    element.isDeleted = true;
    element.deletedAt = new Date();
    await element.save();
    res.status(200).json({ message: "Element deleted successfully" });
  } catch (error) {
    console.error("Error deleting element:", error);
    res.status(500).json({
      message: "Server error while deleting element",
    });
  }
};

module.exports = {
  createElement,
  getAllElements,
  getElementById,
  updateElement,
  deleteElement,
};
