const Element = require("../models/Element.model");

const createElement = async (req, res) => {
  try {
    const existing = await Element.findOne({ name: req.body.name });
    if (existing) return res.status(400).json({ message: "Element with this name already exists" });
    const element = await Element.create(req.body);
    res.status(201).json({ message: "Element created successfully", data: element });
  } catch (error) {
    res.status(500).json({ message: "Server error while creating element" });
  }
};

const getAllElements = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const filter = { isDeleted: { $ne: true } };
    if (req.query.search) filter.name = { $regex: req.query.search, $options: "i" };
    const [elements, total] = await Promise.all([
      Element.find(filter).skip(skip).limit(limit).sort({ name: 1 }),
      Element.countDocuments(filter),
    ]);
    res.status(200).json({ elements, pagination: { page, limit, total } });
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching elements" });
  }
};

const getElementById = async (req, res) => {
  try {
    const element = await Element.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!element) return res.status(404).json({ message: "Element not found" });
    res.status(200).json(element);
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching element" });
  }
};

const updateElement = async (req, res) => {
  try {
    const element = await Element.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!element) return res.status(404).json({ message: "Element not found" });
    res.status(200).json({ message: "Element updated successfully", data: element });
  } catch (error) {
    res.status(500).json({ message: "Server error while updating element" });
  }
};

const deleteElement = async (req, res) => {
  try {
    const element = await Element.findById(req.params.id);
    if (!element || element.isDeleted) return res.status(404).json({ message: "Element not found" });
    element.isDeleted = true;
    element.deletedAt = new Date();
    await element.save();
    res.status(200).json({ message: "Element deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error while deleting element" });
  }
};

module.exports = { createElement, getAllElements, getElementById, updateElement, deleteElement };
