const axios     = require("axios");
const Inventory = require("../models/Inventory.model");
const CarIntake = require("../models/CarIntake.model");
const PART_PRICES = require("../assets/part_prices.json");

const WIX_BASE   = "https://www.wixapis.com";
const WIX_HEADERS = () => ({
  "Content-Type": "application/json",
  Authorization: process.env.WIX_API_KEY,
  "wix-site-id": process.env.WIX_SITE_ID,
});

const toTitle = (s) => (s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase()).trim();
const genSku   = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").substring(0, 40);
const val      = (...args) => { for (const a of args) { if (a && a !== "N/A" && a !== "") return a; } return "N/A"; };

const buildSourceVehicleHtml = (cd, vd) => `<ul>
  <li><p>Year:${val(vd?.ModelYear)}</p></li>
  <li><p>Make:${val(cd?.make, vd?.Make)}</p></li>
  <li><p>Model:${val(cd?.model, vd?.Model)}</p></li>
  <li><p>Trim:${val(cd?.trim, vd?.Trim)}</p></li>
  <li><p>Body:${val(cd?.bodyClass, vd?.BodyClass)}</p></li>
  <li><p>Engine:${val(cd?.engine, vd?.DisplacementL)}</p></li>
  <li><p>Drive:${val(cd?.drive, vd?.DriveType)}</p></li>
  <li><p>Transmission:${val(cd?.transmission, vd?.TransmissionStyle)}</p></li>
</ul>`;

// GET /api/wix/sync  — get unsynced inventory list
const syncWithWix = async (req, res) => {
  try {
    const items = await Inventory.find({ wixSynced: false })
      .populate("make", "name shortName")
      .populate("model", "name shortName")
      .populate("trim", "name shortName");

    const wixData = items.map(item => ({
      name: toTitle(item.partName),
      sku: item.sku && !item.sku.includes("${") && item.sku.length <= 40
        ? item.sku.substring(0, 40) : item._id.toString(),
      productType: "physical",
      price: 1, visible: false,
      brand: item.make?.name || "",
      category: item.category,
      currency: "USD",
    }));

    res.status(200).json(wixData);
  } catch (error) {
    console.error("syncWithWix error:", error);
    res.status(500).json({ error: "An error occurred while syncing with Wix." });
  }
};

// PATCH /api/wix/inventory/:inventoryId/mark-synced
const markInventorySynced = async (req, res) => {
  try {
    const inventory = await Inventory.findByIdAndUpdate(
      req.params.inventoryId,
      { wixSynced: true, wixSyncedAt: new Date(), wixProductId: req.body.wixProductId },
      { new: true }
    );
    if (!inventory) return res.status(404).json({ success: false, error: "Inventory not found" });
    res.status(200).json({ success: true, inventoryId: inventory._id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/wix/export/parts  — export up to 10 unsynced parts
const exportAndSyncAllParts = async (req, res) => {
  try {
    const items = await Inventory.find({ wixSynced: false }).limit(10)
      .populate("make", "name").populate("model", "name").populate("trim", "name");

    if (!items.length) return res.status(200).json({ success: true, exported: 0, parts: [] });

    const parts = await Promise.all(items.map(item => buildPartPayload(item)));
    res.status(200).json({ success: true, exported: parts.length, parts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/wix/export/parts/deduplicated  — deduplicated sync with Wix background
const exportAndSyncDeduplicated = async (req, res) => {
  try {
    const limitNum = parseInt(req.query.limit, 10) || 0;
    let query = Inventory.find({ wixSynced: false })
      .populate("make", "name").populate("model", "name").populate("trim", "name");
    if (limitNum > 0) query = query.limit(limitNum);
    const items = await query;

    const validItems = items.filter(item => item?._id && item.partName && item.make?._id && item.model?._id && item.trim?._id);
    if (!validItems.length) return res.status(200).json({ success: true, exported: 0, parts: [] });

    // Group by Year+Make+Model+PartName
    const groupMap = {};
    for (const item of validItems) {
      const key = `${item.year}-${item.make?.name?.toUpperCase()}-${item.model?.name?.toUpperCase()}-${item.partName}`;
      if (!groupMap[key]) groupMap[key] = [];
      groupMap[key].push(item);
    }

    const responseParts = [];
    for (const groupItems of Object.values(groupMap)) {
      const item        = groupItems[0];
      const partName    = toTitle(item.partName);
      const vehicleName = [item.year, item.make?.name?.toUpperCase(), item.model?.name, item.trim?.name].filter(Boolean).join(" ");
      const productName = `${vehicleName} - ${partName}`;
      const sku         = genSku(productName);
      const intake      = await CarIntake.findOne({ vin: item.vin }).lean();
      const partKey     = item.partName.replace(/\s+/g, "").replace(/^./, c => c.toLowerCase());
      const price       = PART_PRICES[partKey] || 0;
      const quantity    = await Inventory.countDocuments({ make: item.make._id, model: item.model._id, year: item.year, partName: item.partName, isDeleted: false });
      const { cd = {}, vd = {} } = { cd: intake?.carDetails, vd: intake?.vinDetails };
      const sourceHtml  = buildSourceVehicleHtml(cd, vd);
      const description = `${partName}, Condition: Used, Year: ${item.year}, Make: ${item.make?.name}, Model: ${item.model?.name}, Trim: ${item.trim?.name}`;

      responseParts.push({
        externalId: item._id.toString(), name: productName, sku,
        make: item.make?.name, model: item.model?.name, trim: item.trim?.name, year: item.year,
        brand: (item.make?.name || "").toUpperCase(), category: item.category,
        price, quantity, productType: 1, visible: true, currency: "USD", description,
        productInfo: { additionalInfoSections: [
          { title: "Description", description },
          { title: "Fitment", description: " " },
          { title: "Source Vehicle", description: sourceHtml },
          { title: "Return and Refund Policy", description: " " },
        ]},
      });
    }

    res.status(200).json({ success: true, exported: responseParts.length, totalItems: validItems.length, parts: responseParts });

    // Background Wix sync
    setImmediate(async () => {
      for (const p of responseParts) {
        const groupItems = Object.values(groupMap).find(g => g[0]._id.toString() === p.externalId) || [];
        const existingPid = groupItems.find(g => g.wixProductId && g.wixProductId !== "null")?.wixProductId;
        try {
          if (existingPid) {
            await axios.post(`${process.env.WIX_VELO_BASE_URL?.replace(/\/$/, "")}/_functions/partSync`,
              { secret: process.env.PART_SYNC_SECRET, productId: existingPid, brand: p.brand, category: p.category, quantity: p.quantity },
              { headers: { "Content-Type": "application/json" }, timeout: 30000 }
            );
            console.log(`[WIX-BG] Updated existing product ${existingPid}`);
          } else {
            const payload = {
              product: {
                name: p.name, productType: "PHYSICAL", visible: true, brand: p.brand,
                variantsInfo: { variants: [{ sku: p.sku, price: { actualPrice: { amount: String(p.price.toFixed(2)) } }, physicalProperties: { weight: groupItems[0]?.weight || 0 } }] },
                infoSections: [
                  { title: "Description",            plainDescription: p.description,                          uniqueName: "description"    },
                  { title: "Fitment",                plainDescription: " ",                                    uniqueName: "fitment"         },
                  { title: "Source Vehicle",         plainDescription: p.productInfo.additionalInfoSections[2].description, uniqueName: "source-vehicle"  },
                  { title: "Return and Refund Policy", plainDescription: " ",                                  uniqueName: "return-policy"  },
                ],
              },
            };
            const resp = await axios.post(`${WIX_BASE}/stores/v3/products`, payload, { headers: WIX_HEADERS() });
            const pid  = resp.data?.product?.id;
            if (pid) {
              for (const gi of groupItems) {
                await Inventory.findByIdAndUpdate(gi._id, { wixSynced: true, wixSyncedAt: new Date(), wixProductId: pid });
              }
              console.log(`[WIX-BG] Created product ${pid} for "${p.name}"`);
            }
          }
        } catch (err) {
          console.error(`[WIX-BG] Error syncing "${p.name}":`, err.response?.data?.message || err.message);
        }
      }
      console.log("[WIX-BG] Background sync complete.");
    });
  } catch (error) {
    console.error("exportAndSyncDeduplicated error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Helper
async function buildPartPayload(item) {
  const partName    = toTitle(item.partName);
  const vehicleName = [item.year, item.make?.name?.toUpperCase(), item.model?.name, item.trim?.name].filter(Boolean).join(" ");
  const intake      = await CarIntake.findOne({ vin: item.vin }).lean();
  const partKey     = item.partName.replace(/\s+/g, "").replace(/^./, c => c.toLowerCase());
  const price       = PART_PRICES[partKey] || 0;
  const description = `${partName}, Condition: Used, Year: ${item.year}, Make: ${item.make?.name}, Model: ${item.model?.name}`;
  return {
    externalId: item._id.toString(), wixProductId: item.wixProductId || item._id.toString(),
    name: `${vehicleName} - ${partName}`,
    sku: item.sku && !item.sku.includes("${") && item.sku.length <= 40 ? item.sku.substring(0, 40) : item._id.toString(),
    make: item.make?.name, model: item.model?.name, trim: item.trim?.name, year: item.year,
    weight: item.weight, brand: item.make?.name, category: item.category,
    price, productType: 1, visible: false, currency: "USD", description,
  };
}

// GET /api/wix/inventory/export  — full export for Wix v3 bulk create
const exportInventoriesV3 = async (req, res) => {
  try {
    const inventories = await Inventory.aggregate([
      { $lookup: { from: "makes",     localField: "make",  foreignField: "_id", as: "make"  } }, { $unwind: { path: "$make",  preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "carmodels", localField: "model", foreignField: "_id", as: "model" } }, { $unwind: { path: "$model", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "trims",     localField: "trim",  foreignField: "_id", as: "trim"  } }, { $unwind: { path: "$trim",  preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "tags",      localField: "_id",   foreignField: "inventoryId", as: "tag" } }, { $unwind: { path: "$tag", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "carintakes", localField: "vin",  foreignField: "vin", as: "carIntake" } }, { $unwind: { path: "$carIntake", preserveNullAndEmptyArrays: true } },
      { $project: { year: { $ifNull: ["$year",""] }, makeName: { $ifNull: ["$make.name",""] }, modelName: { $ifNull: ["$model.name",""] }, trimName: { $ifNull: ["$trim.name",""] }, partName: { $ifNull: ["$partName",""] }, vin: { $ifNull: ["$vin","N/A"] }, weight: { $ifNull: ["$weight",0] }, sku: { $ifNull: ["$tag.barcodeString",null] }, cd: { $ifNull: ["$carIntake.carDetails",{}] }, vd: { $ifNull: ["$carIntake.vinDetails",{}] } } },
    ]);

    const products = inventories.map(item => {
      const partName    = toTitle(item.partName);
      const description = `${partName}, Condition: Used, Year: ${item.year}, Make: ${item.makeName}, Model: ${item.modelName}, Trim: ${item.trimName}`;
      const sourceHtml  = buildSourceVehicleHtml(item.cd, item.vd);
      return {
        product: {
          name: `${item.year} ${item.makeName} ${item.modelName} ${item.trimName} - ${partName}`.trim(),
          productType: "PHYSICAL", visible: false, brand: item.makeName,
          variantsInfo: { variants: [{ sku: item.sku || "", price: { actualPrice: { amount: "0.00" } }, physicalProperties: { weight: item.weight || 0 } }] },
          infoSections: [
            { title: "Description",              plainDescription: description, uniqueName: "description"    },
            { title: "Fitment",                  plainDescription: " ",         uniqueName: "fitment"        },
            { title: "Source Vehicle",           plainDescription: sourceHtml,  uniqueName: "source-vehicle" },
            { title: "Return and Refund Policy", plainDescription: " ",         uniqueName: "return-policy"  },
          ],
        },
      };
    });

    // Batch background send to Wix
    setImmediate(async () => {
      const BATCH = 25, CONCURRENCY = 2;
      const batches = [];
      for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));
      for (let i = 0; i < batches.length; i += CONCURRENCY) {
        await Promise.all(batches.slice(i, i + CONCURRENCY).map(async (batch, idx) => {
          try {
            await axios.post(`${WIX_BASE}/stores/v3/bulk/products/create`, { products: batch, returnEntity: false }, { headers: WIX_HEADERS() });
            console.log(`[WIX-BG] V3 batch ${i + idx + 1}/${batches.length} synced`);
          } catch (err) { console.error(`[WIX-BG] V3 batch error:`, err.response?.data || err.message); }
        }));
      }
      console.log("[WIX-BG] V3 sync complete.");
    });

    res.status(202).json({ message: "Wix V3 Sync started in background", totalProducts: products.length, estimatedBatches: Math.ceil(products.length / 25) });
  } catch (error) {
    console.error("exportInventoriesV3 error:", error);
    res.status(500).json({ message: "Server error while initiating Wix V3 sync" });
  }
};

module.exports = { syncWithWix, markInventorySynced, exportAndSyncAllParts, exportAndSyncDeduplicated, exportInventoriesV3 };
