const inventoryService = require("../services/inventory.service");

const createInventory = async (req, res) => {
  try {
    const inventory = await inventoryService.createInventory(req.body);
    res.status(201).json({ message: "Inventory created successfully", data: inventory });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error("Error creating inventory:", error);
    res.status(500).json({ message: "Server error while creating inventory" });
  }
};

const getInventoryByVIN = async (req, res) => {
  try {
    const { vin } = req.params;
    const inventoryItems = await inventoryService.getInventoryByVIN(vin);
    res.status(200).json({ inventoryItems });
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching inventory by VIN" });
  }
};

// @desc    Update the manual selling price of a single inventory item
// @route   PATCH /api/inventory/:id/price
// @access  Private
// Deliberately narrow (price only) rather than a generic update endpoint,
// so this cannot be used to change any other inventory field.
const updateInventoryPrice = async (req, res) => {
  try {
    const { id } = req.params;
    const { price } = req.body;
    const inventory = await inventoryService.updateInventoryPrice(id, price);
    res.status(200).json({ success: true, inventory });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: "Server error while updating price" });
  }
};

// @desc    Get all inventory items
// @route   GET /api/inventory
// @access  Private
const getAllInventories = async (req, res) => {
  try {
    const result = await inventoryService.getAllInventories(req.query);
    res.status(200).json(result);
  } catch (error) {
    console.error("Get inventories error:", error);
    res.status(500).json({ message: "Server error while fetching inventory" });
  }
};

// Master parts list endpoint (paginated, filtered, reduced fields)
// GET /api/inventory/parts
const getPartsMasterList = async (req, res) => {
  try {
    const result = await inventoryService.getPartsMasterList(req.query);
    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching parts master list:", error);
    res.status(500).json({ message: "Server error while fetching parts" });
  }
};

// Search inventory by Make + Model + Year simultaneously, accepting either
// ObjectIds or human-readable names for make/model (resolved server-side,
// same lookup style as createInventory) so a caller doesn't need separate
// round trips to look up IDs first. Read-only — never creates Make/Model
// records; an unresolvable name just yields zero results.
// GET /api/inventory/search
const searchByMakeModelYear = async (req, res) => {
  try {
    const result = await inventoryService.searchByMakeModelYear(req.query);
    res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error("Error searching inventory by make/model/year:", error);
    res.status(500).json({ message: "Server error while searching inventory" });
  }
};

// Export inventories with custom format
// GET /api/inventory/export
const exportInventories = async (req, res) => {
  try {
    const formattedInventories = await inventoryService.exportInventories();
    res.status(200).json(formattedInventories);
  } catch (error) {
    console.error("Error exporting inventories:", error);
    res.status(500).json({ message: "Server error while exporting inventories" });
  }
};

const syncInventoriesV3 = async (req, res) => {
  try {
    const { totalProducts, estimatedBatches } = await inventoryService.initiateSyncInventoriesV3();
    res.status(202).json({
      message: "Wix V3 Sync started in the background",
      totalProducts,
      estimatedBatches,
    });
  } catch (error) {
    console.error("Error in syncInventoriesV3 initiation:", error);
    res.status(500).json({ message: "Server error while initiating Wix V3 sync" });
  }
};

/**
 * Deduplicate Inventory — removes duplicate Inventory records
 * that share the same partName (case-insensitive) + make + model + trim + year + vin.
 * Keeps only the oldest record per group.
 * POST /api/inventory/deduplicate
 */
const deduplicateInventory = async (req, res) => {
  try {
    const result = await inventoryService.deduplicateInventory();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Error deduplicating inventory:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  createInventory,
  getInventoryByVIN,
  updateInventoryPrice,
  getPartsMasterList,
  getAllInventories,
  searchByMakeModelYear,
  exportInventories,
  syncInventoriesV3,
  deduplicateInventory,
};
