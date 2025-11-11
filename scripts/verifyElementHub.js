/**
 * Verification script for Element Hub functionality
 * Tests accumulation and sell operations
 */

const mongoose = require("mongoose");
const ElementHub = require("../models/elementHub.model");
const ElementHubHistory = require("../models/elementHubHistory.model");
const Element = require("../models/elements.model");
const Transaction = require("../models/Transaction");
const Invoice = require("../models/Invoice");
const {
  addToHubInternal,
  sellElement,
} = require("../controllers/elementHub.controller");

// Load environment variables
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/autohub";

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✓ Connected to MongoDB");
  } catch (error) {
    console.error("✗ MongoDB connection error:", error.message);
    process.exit(1);
  }
}

async function cleanup() {
  console.log("\n--- Cleanup Test Data ---");
  try {
    // Remove test data (optional - comment out if you want to keep test data)
    await ElementHub.deleteMany({ elementName: /TEST_ELEMENT_/ });
    await ElementHubHistory.deleteMany({ elementName: /TEST_ELEMENT_/ });
    console.log("✓ Cleaned up test data");
  } catch (error) {
    console.warn("⚠ Cleanup warning:", error.message);
  }
}

async function testAccumulation() {
  console.log("\n--- Test 1: Element Accumulation ---");

  const testElementName = "TEST_ELEMENT_STEEL";
  const testVin = "TEST_VIN_12345";

  try {
    // First addition
    await addToHubInternal({
      elementName: testElementName,
      amount: 5,
      sourceVin: testVin + "_A",
      createdBy: new mongoose.Types.ObjectId(),
    });
    console.log("✓ Added 5 lb to hub");

    // Second addition
    await addToHubInternal({
      elementName: testElementName,
      amount: 8,
      sourceVin: testVin + "_B",
      createdBy: new mongoose.Types.ObjectId(),
    });
    console.log("✓ Added 8 lb to hub");

    // Third addition
    await addToHubInternal({
      elementName: testElementName,
      amount: 2,
      sourceVin: testVin + "_C",
      createdBy: new mongoose.Types.ObjectId(),
    });
    console.log("✓ Added 2 lb to hub");

    // Verify total
    const hubItem = await ElementHub.findOne({ elementName: testElementName });
    const expectedTotal = 15;

    if (hubItem && hubItem.totalWeight === expectedTotal) {
      console.log(
        `✓ Total weight correct: ${hubItem.totalWeight} lb (expected ${expectedTotal} lb)`
      );
    } else {
      console.error(
        `✗ Total weight mismatch: got ${
          hubItem?.totalWeight || 0
        } lb, expected ${expectedTotal} lb`
      );
      return false;
    }

    // Verify history records
    const historyCount = await ElementHubHistory.countDocuments({
      elementName: testElementName,
      type: "add",
    });

    if (historyCount === 3) {
      console.log(`✓ History records correct: ${historyCount} additions`);
    } else {
      console.error(
        `✗ History count mismatch: got ${historyCount}, expected 3`
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error("✗ Accumulation test failed:", error.message);
    return false;
  }
}

async function testSellOperation() {
  console.log("\n--- Test 2: Element Sell Operation ---");

  const testElementName = "TEST_ELEMENT_STEEL";
  const sellAmount = 10;

  try {
    // Get current total
    const beforeSell = await ElementHub.findOne({
      elementName: testElementName,
    });
    const beforeTotal = beforeSell?.totalWeight || 0;
    console.log(`Current total: ${beforeTotal} lb`);

    // Perform sell
    const testUserId = new mongoose.Types.ObjectId();
    const mockReq = {
      body: {
        elementName: testElementName,
        amount: sellAmount,
        buyerName: "TEST_BUYER",
        pricePerUnit: 0.5,
        notes: "Test sell operation",
        createdBy: testUserId,
        saleValue: sellAmount * 0.5, // price calculation
      },
      user: { _id: testUserId },
    };

    const mockRes = {
      status: (code) => ({
        json: (data) => {
          if (code === 200) {
            console.log("✓ Sell operation completed");
            return data;
          } else {
            console.error(`✗ Sell failed with status ${code}:`, data);
            throw new Error(data.message || "Sell failed");
          }
        },
      }),
    };

    const result = await new Promise((resolve, reject) => {
      mockRes.status = (code) => ({
        json: (data) => {
          if (code === 200) {
            resolve(data);
          } else {
            reject(new Error(data.message || `Status ${code}`));
          }
        },
      });
      sellElement(mockReq, mockRes);
    });

    // Verify total was reduced
    const afterSell = await ElementHub.findOne({
      elementName: testElementName,
    });
    const afterTotal = afterSell?.totalWeight || 0;
    const expectedAfter = beforeTotal - sellAmount;

    if (afterTotal === expectedAfter) {
      console.log(
        `✓ Total reduced correctly: ${afterTotal} lb (expected ${expectedAfter} lb)`
      );
    } else {
      console.error(
        `✗ Total mismatch after sell: got ${afterTotal} lb, expected ${expectedAfter} lb`
      );
      return false;
    }

    // Verify Transaction was created
    if (result.transaction && result.transaction._id) {
      console.log(`✓ Transaction created: ${result.transaction._id}`);
    } else {
      console.error("✗ Transaction not created");
      return false;
    }

    // Verify Invoice was created
    if (result.invoice && result.invoice._id) {
      console.log(`✓ Invoice created: ${result.invoice._id}`);

      // Verify invoice type
      const invoice = await Invoice.findById(result.invoice._id);
      if (invoice && invoice.invoiceType === "element-sell") {
        console.log(`✓ Invoice type correct: ${invoice.invoiceType}`);
      } else {
        console.error(`✗ Invoice type incorrect: ${invoice?.invoiceType}`);
        return false;
      }
    } else {
      console.error("✗ Invoice not created");
      return false;
    }

    // Verify history record
    if (result.history && result.history._id) {
      console.log(`✓ Sell history record created: ${result.history._id}`);
    } else {
      console.error("✗ Sell history record not found");
      return false;
    }

    return true;
  } catch (error) {
    console.error("✗ Sell operation test failed:", error.message);
    return false;
  }
}

async function testOversellPrevention() {
  console.log("\n--- Test 3: Oversell Prevention ---");

  const testElementName = "TEST_ELEMENT_STEEL";

  try {
    const hubItem = await ElementHub.findOne({ elementName: testElementName });
    const available = hubItem?.totalWeight || 0;
    const oversellAmount = available + 100; // Try to sell more than available

    console.log(
      `Available: ${available} lb, attempting to sell: ${oversellAmount} lb`
    );

    const testUserId = new mongoose.Types.ObjectId();
    const mockReq = {
      body: {
        elementName: testElementName,
        amount: oversellAmount,
        buyerName: "TEST_BUYER",
        pricePerUnit: 0.5,
        createdBy: testUserId,
      },
      user: { _id: testUserId },
    };

    let errorCaught = false;
    const mockRes = {
      status: (code) => ({
        json: (data) => {
          if (code !== 200) {
            errorCaught = true;
            console.log(
              `✓ Oversell prevented with status ${code}: ${data.message}`
            );
          }
        },
      }),
    };

    await sellElement(mockReq, mockRes);

    if (errorCaught) {
      // Verify total unchanged
      const afterAttempt = await ElementHub.findOne({
        elementName: testElementName,
      });
      if (afterAttempt.totalWeight === available) {
        console.log(`✓ Total unchanged: ${afterAttempt.totalWeight} lb`);
        return true;
      } else {
        console.error(
          `✗ Total changed unexpectedly: ${afterAttempt.totalWeight} lb`
        );
        return false;
      }
    } else {
      console.error("✗ Oversell was not prevented!");
      return false;
    }
  } catch (error) {
    console.error("✗ Oversell prevention test failed:", error.message);
    return false;
  }
}

async function runTests() {
  console.log("====================================");
  console.log("  Element Hub Verification Script");
  console.log("====================================");

  await connectDB();

  const results = {
    accumulation: false,
    sell: false,
    oversell: false,
  };

  try {
    results.accumulation = await testAccumulation();
    results.sell = await testSellOperation();
    results.oversell = await testOversellPrevention();
  } catch (error) {
    console.error("\n✗ Test execution error:", error.message);
  }

  await cleanup();

  console.log("\n====================================");
  console.log("  Test Results Summary");
  console.log("====================================");
  console.log(
    `Accumulation Test: ${results.accumulation ? "✓ PASS" : "✗ FAIL"}`
  );
  console.log(`Sell Operation Test: ${results.sell ? "✓ PASS" : "✗ FAIL"}`);
  console.log(
    `Oversell Prevention Test: ${results.oversell ? "✓ PASS" : "✗ FAIL"}`
  );

  const allPassed = results.accumulation && results.sell && results.oversell;
  console.log(
    `\nOverall: ${allPassed ? "✓ ALL TESTS PASSED" : "✗ SOME TESTS FAILED"}`
  );

  await mongoose.connection.close();
  console.log("\n✓ Disconnected from MongoDB");

  process.exit(allPassed ? 0 : 1);
}

// Run tests
runTests();
