/**
 * AutoHub Express - Car Intake Co-pilot (Node.js / Playwright)
 * ============================================================
 * Per car folder (named by VIN, photos 01..12, optional notes.txt):
 *   1. Decodes the VIN (NHTSA VPIC API) + reads notes.txt
 *   2. Enters VIN in the CRM dialog, waits for its auto-decode
 *   3. Fills color/trim/weight/engine variant, ticks drive & transmission
 *   4. You review -> Enter -> opens Car Images page
 *   5. Uploads every photo IN ORDER and WAITS for server confirmation
 *   6. Waits for transfers to finish, clicks Continue
 *   7. Automatically deselects A1 and A2 on the Car Diagnostic page (Units: 0)
 *   8. You do the remaining pages + submit -> Enter -> next car
 *
 * Requirements:
 *   npm install playwright axios
 * Run:
 *   node scripts/autohub_intake_bot.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const axios = require("axios");

// ----------------------------- SETTINGS ------------------------------------
const INTAKE_DIR = process.env.INTAKE_DIR
  ? path.resolve(process.env.INTAKE_DIR)
  : path.join("C:", "Users", "shubh", "Downloads", "intake_folder");
const CRM_URL = "https://autohubexpress.us/car-intake";
const PROFILE_DIR = path.join(os.homedir(), ".autohub_bot_profile");
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const UPLOAD_KEYWORDS = ["image", "upload", "file", "photo", "media"];

// Slow network timeouts
const PHOTO_SERVER_WAIT_S = 90;
const NETWORKIDLE_WAIT_MS = 300000;
const SLOTS_WAIT_MS = 120000;
const MODAL_WAIT_MS = 20000;
const FILE_INPUT_WAIT_MS = 15000;
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function decodeVin(vin) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
  const res = await axios.get(url, { timeout: 30000 });
  const d = res.data?.Results?.[0] || {};

  const driveRaw = (d.DriveType || "").toUpperCase();
  let drive = "";
  if (driveRaw.includes("FRONT") || driveRaw.includes("FWD")) drive = "FWD";
  else if (driveRaw.includes("ALL") || driveRaw.includes("AWD")) drive = "AWD";
  else if (driveRaw.includes("4WD") || driveRaw.includes("4X4")) drive = "4WD";
  else if (driveRaw.includes("REAR") || driveRaw.includes("RWD") || driveRaw.includes("4X2")) drive = "2WD";

  const transRaw = (d.TransmissionStyle || "").toUpperCase();
  let trans = "";
  if (transRaw.includes("AUTO") || transRaw.includes("CVT")) trans = "Automatic";
  else if (transRaw.includes("MANUAL")) trans = "Manual";

  return {
    year: d.ModelYear || "",
    make: (d.Make || "").toUpperCase(),
    model: d.Model || "",
    trim: d.Trim || d.Series || "",
    engine_variant: d.EngineModel || "",
    drive,
    transmission: trans,
    weight: d.CurbWeightLB || "",
  };
}

function readNotes(folder) {
  const notes = {};
  const noteFile = path.join(folder, "notes.txt");
  if (fs.existsSync(noteFile)) {
    const lines = fs.readFileSync(noteFile, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (line.includes("=")) {
        const [k, ...v] = line.split("=");
        notes[k.trim().toLowerCase()] = v.join("=").trim();
      }
    }
  }
  return notes;
}

function naturalKey(name) {
  return name.split(/(\d+)/).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t.toLowerCase()));
}

function carPhotos(folder) {
  if (!fs.existsSync(folder)) return [];
  const files = fs.readdirSync(folder);
  const pics = files.filter((f) => PHOTO_EXTS.has(path.extname(f).toLowerCase()));

  pics.sort((a, b) => {
    const ka = naturalKey(a);
    const kb = naturalKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      if (ka[i] === undefined) return -1;
      if (kb[i] === undefined) return 1;
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });

  return pics.map((f) => path.join(folder, f));
}

function waitForEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`\n>>> ${msg}\n>>> Press Enter here when ready... `, () => {
      rl.close();
      resolve();
    });
  });
}

async function fillIfEmpty(page, fieldId, value) {
  if (!value) return;
  try {
    const box = page.locator(`#${fieldId}`);
    if ((await box.count()) === 0) return;
    const current = (await box.first().inputValue()) || "";
    if (current.trim() === "") {
      await box.first().fill(String(value));
      console.log(`    filled: ${fieldId} -> ${value}`);
    }
  } catch (e) {
    console.log(`    (skip ${fieldId}: ${e.message})`);
  }
}

async function clickRadio(page, group, value) {
  if (!value) return;
  try {
    const sel = page.locator(`input[name='${group}'][value='${value}']`);
    if ((await sel.count()) > 0 && (await sel.first().isChecked())) {
      console.log(`    ${group}: ${value} (already selected)`);
      return;
    }
    await page
      .locator(`label.ant-radio-wrapper:has(input[name='${group}'][value='${value}'])`)
      .first()
      .click({ timeout: 4000 });
    console.log(`    selected ${group}: ${value}`);
  } catch {
    try {
      await page
        .locator(`input[name='${group}'][value='${value}']`)
        .first()
        .check({ force: true, timeout: 3000 });
      console.log(`    selected ${group}: ${value}`);
    } catch {
      console.log(`    (couldn't tick ${group}=${value} - do it by hand)`);
    }
  }
}

async function uploadPhotos(page, photos) {
  const stats = { ok: 0, fail: 0 };

  const onResponse = (resp) => {
    try {
      const url = resp.url().toLowerCase();
      if (resp.request().method() === "POST" && UPLOAD_KEYWORDS.some((k) => url.includes(k))) {
        if (resp.ok()) {
          stats.ok++;
          console.log(`      [server OK ${resp.status()}]`);
        } else {
          stats.fail++;
          console.log(`      [server FAIL ${resp.status()}] ${resp.url().slice(0, 90)}`);
        }
      }
    } catch {}
  };

  page.on("response", onResponse);

  let uploaded = 0;
  for (const photo of photos) {
    try {
      const addBtns = page.locator("div.camera-upload button:has-text('Add Image')");
      if ((await addBtns.count()) === 0) {
        console.log(`    no empty slots left - ${photos.length - uploaded} photo(s) unused`);
        break;
      }

      const responsesBefore = stats.ok + stats.fail;

      await addBtns.first().scrollIntoViewIfNeeded();
      await addBtns.first().click();

      const modal = page.locator(".ant-modal-content").last();
      await modal.waitFor({ state: "visible", timeout: MODAL_WAIT_MS });

      try {
        const tab = modal.getByRole("tab", { name: "Upload" });
        if ((await tab.count()) > 0 && (await tab.first().getAttribute("aria-selected")) !== "true") {
          await tab.first().click();
          await sleep(400);
        }
      } catch {}

      const fileInput = modal.locator("input[type='file']");
      await fileInput.waitFor({ state: "attached", timeout: FILE_INPUT_WAIT_MS });
      await fileInput.setInputFiles(photo);
      console.log(`    slot ${String(uploaded + 1).padStart(2, "0")} <- ${path.basename(photo)}`);

      await sleep(1000);
      for (const label of ["Upload", "Save", "OK", "Confirm", "Crop"]) {
        try {
          const btn = modal.getByRole("button", { name: label });
          if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
            await btn.first().click();
            console.log(`      clicked '${label}' in popup`);
            break;
          }
        } catch {}
      }

      const deadline = Date.now() + PHOTO_SERVER_WAIT_S * 1000;
      let transferred = false;
      while (Date.now() < deadline) {
        if (stats.ok + stats.fail > responsesBefore) {
          transferred = true;
          break;
        }
        await sleep(500);
      }
      if (!transferred) {
        console.log(
          `      (no server response in ${PHOTO_SERVER_WAIT_S}s - photo may not have transferred; watch this one)`
        );
      }

      try {
        if (await modal.isVisible()) {
          const closeX = modal.locator("button.ant-modal-close");
          if ((await closeX.count()) > 0) {
            await closeX.first().click();
          } else {
            await page.keyboard.press("Escape");
          }
          await sleep(500);
        }
      } catch {}

      uploaded++;
    } catch (e) {
      console.log(`    photo ${path.basename(photo)} FAILED (${e.message}) - do this one by hand`);
      try {
        await page.keyboard.press("Escape");
        await sleep(500);
      } catch {}
      uploaded++;
    }
  }

  console.log("    letting any remaining transfers finish...");
  try {
    await page.waitForLoadState("networkidle", { timeout: NETWORKIDLE_WAIT_MS });
  } catch {}
  await sleep(2000);

  console.log(`    done: ${uploaded}/${photos.length} photos | server OK: ${stats.ok}  FAIL: ${stats.fail}`);

  if (uploaded > 0) {
    try {
      await page.locator("button:has-text('Continue'):visible").last().click({ timeout: 5000 });
      console.log("    clicked Continue - images saved to the record");
      await sleep(3000);
    } catch {
      console.log("    !! couldn't click Continue - CLICK IT YOURSELF NOW or the images will NOT be saved");
    }
  }

  page.off("response", onResponse);
}

async function deselectExcludedParts(page, excludedNames = ["a1", "a2", "converter", "catalytic converter"]) {
  const js = `
    async (targets) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let table = null;
      for (let i = 0; i < 30; i++) {
        table = document.querySelector('.diagnosis-table') || document.querySelector('table');
        if (table && table.querySelectorAll('tbody tr').length > 0) break;
        await sleep(500);
      }
      if (!table) return { ok: false, error: "diagnosis_table_not_found", count: 0, items: [] };

      const rows = [...table.querySelectorAll('tbody tr')];
      const deselected = [];

      for (const row of rows) {
        const nameCell = row.querySelector('td:nth-child(2)') || row;
        const text = (nameCell.textContent || '').trim().toLowerCase();

        const matched = targets.find(t => {
          const pattern = new RegExp('(^|[^a-z0-9])' + t.toLowerCase() + '([^a-z0-9]|$)', 'i');
          return pattern.test(text);
        });

        if (matched) {
          const switchBtn = row.querySelector('.ant-switch, button[role="switch"]');
          if (switchBtn) {
            const isChecked = switchBtn.classList.contains('ant-switch-checked') ||
                              switchBtn.getAttribute('aria-checked') === 'true';
            if (isChecked) {
              switchBtn.click();
              deselected.push(matched.toUpperCase() + ' (switch toggled OFF -> Units: 0)');
              await sleep(300);
            } else {
              deselected.push(matched.toUpperCase() + ' (already OFF -> Units: 0)');
            }
          }
        }
      }
      return { ok: true, count: deselected.length, items: deselected };
    }
  `;

  try {
    const res = await page.evaluate(js, excludedNames);
    if (res?.ok) {
      for (const item of res.items || []) {
        console.log(`    [Deselect Part] ${item}`);
      }
      if (!res.items?.length) {
        console.log("    (no A1/A2 rows found to deselect)");
      }
      return res.count || 0;
    } else {
      console.log(`    (could not deselect parts: ${res?.error})`);
      return 0;
    }
  } catch (e) {
    console.log(`    (deselectExcludedParts error: ${e.message})`);
    return 0;
  }
}

async function setPartsQuality(page, value) {
  const target = String(value || "").trim().toLowerCase();
  const js = `
    async (target) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let done = 0, safety = 200;
      while (safety-- > 0) {
        const sel = [...document.querySelectorAll('.ant-select:not(.ant-select-disabled)')]
          .find(s => s.textContent.includes('Select Quality'));
        if (!sel) break;
        sel.scrollIntoView({block: 'center'});
        await sleep(200);
        sel.querySelector('.ant-select-selector')
           ?.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
        let opt = null;
        for (let i = 0; i < 20 && !opt; i++) {
          await sleep(100);
          const dd = [...document.querySelectorAll(
            '.ant-select-dropdown:not(.ant-select-dropdown-hidden)')].pop();
          if (dd) opt = [...dd.querySelectorAll('.ant-select-item-option')]
            .find(o => o.textContent.trim().toLowerCase() === target);
        }
        if (!opt) break;
        opt.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
        opt.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        opt.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await sleep(300);
        done++;
      }
      return done;
    }
  `;

  try {
    const count = await page.evaluate(js, target);
    console.log(`    set ${count} part dropdowns to '${value}'`);
    return count;
  } catch (e) {
    console.log(`    !! parts-quality step failed: ${e.message}`);
    return 0;
  }
}

async function processCar(page, folder, quality = "") {
  const vin = path.basename(folder).trim().toUpperCase();
  console.log(`\n${"=".repeat(60)}\nCAR: ${vin}\n${"=".repeat(60)}`);

  const photos = carPhotos(folder);
  console.log(`  ${photos.length} photos found`);
  if (!photos.length) {
    console.log("  !! no photos in folder - skipping this car");
    return;
  }

  console.log("  Decoding VIN via NHTSA...");
  const data = await decodeVin(vin);
  const notes = readNotes(folder);
  data.color = notes.color || "";
  data.trim = notes.trim || data.trim;
  data.drive = (notes.drive || data.drive || "").toUpperCase();
  data.transmission = (notes.transmission || data.transmission || "");
  data.weight = notes.weight || data.weight;

  console.log(
    `  -> ${data.year} ${data.make} ${data.model} ${data.trim}` +
      ` | ${data.drive} | ${data.transmission || "trans: ?"}` +
      ` | color: ${data.color || "?"}`
  );

  await page.goto(CRM_URL, { waitUntil: "domcontentloaded" });
  try {
    await page.reload({ waitUntil: "networkidle", timeout: NETWORKIDLE_WAIT_MS });
  } catch {}
  await sleep(3000);

  try {
    try {
      await page.getByText("Add New Car", { exact: true }).first().click({ timeout: 8000 });
      await sleep(2000);
    } catch {}

    const vinBox = page.getByPlaceholder("17-CHARACTER VIN", { exact: false }).locator("visible=true").first();
    await vinBox.waitFor({ state: "visible", timeout: 20000 });
    await vinBox.fill(vin);
    await page.locator("button:has-text('Continue'):visible").last().click({ timeout: 5000 });
    console.log("  VIN submitted, waiting for CRM auto-decode...");
    await page.locator("#color").waitFor({ state: "visible", timeout: 30000 });
    await sleep(2000);
  } catch {
    console.log("  !! Couldn't find the VIN dialog automatically.");
    await waitForEnter("Enter the VIN yourself and click Continue, then come back");
  }

  console.log("  Filling remaining fields...");
  await fillIfEmpty(page, "color", data.color);
  await fillIfEmpty(page, "trim", data.trim);
  await fillIfEmpty(page, "weight", data.weight);
  await fillIfEmpty(page, "engineVariant", data.engine_variant);
  await clickRadio(page, "drive", data.drive);
  await clickRadio(page, "transmission", data.transmission);

  await waitForEnter(
    "Check the fields, fix anything. When you press Enter I'll open the Car Images page myself"
  );

  try {
    await page.locator("button:has-text('Car Images'):visible").first().click({ timeout: 5000 });
    console.log("  opened the Car Images page");
  } catch {
    console.log("  (couldn't click 'Car Images' - open the photo page yourself)");
  }

  console.log("  Uploading photos...");
  const slots = page.locator("div.camera-upload button:has-text('Add Image')");
  console.log("    waiting for photo slots to appear...");
  try {
    await slots.first().waitFor({ state: "visible", timeout: SLOTS_WAIT_MS });
  } catch {
    console.log("    !! no 'Add Image' slots appeared within 60s - skipping photos");
    await waitForEnter("Handle photos manually, then Enter for the next car");
    return;
  }

  await uploadPhotos(page, photos);

  // Continue inside uploadPhotos transitions the wizard to the Car Diagnostic step.
  // Deselect A1 and A2 rows so they are recorded with selected=false and Unit: 0.
  console.log("  Checking Car Diagnostic step for excluded parts (A1, A2)...");
  await sleep(2000);
  await deselectExcludedParts(page);

  if (quality) {
    console.log(`  Setting all part qualities to '${quality}'...`);
    console.log("    (make sure the Car Diagnostic page with the 'Select Quality' dropdowns is showing)");
    await waitForEnter(`Navigate to the Car Diagnostic page, then Enter to set all parts to '${quality}'`);
    const n = await setPartsQuality(page, quality);
    if (n === 0) {
      console.log("    !! no dropdowns were set - if you're on the right page, set them manually");
    }
  }

  await waitForEnter("Verify everything looks right, finish remaining pages, submit. Then Enter for the NEXT car");
}

async function main() {
  if (!fs.existsSync(INTAKE_DIR)) {
    console.log(`Create ${INTAKE_DIR} first, one sub-folder per VIN.`);
    process.exit(1);
  }

  const entries = fs.readdirSync(INTAKE_DIR, { withFileTypes: true });
  const carFolders = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(INTAKE_DIR, e.name))
    .sort();

  if (!carFolders.length) {
    console.log(`No car folders inside ${INTAKE_DIR}.`);
    process.exit(0);
  }

  console.log(`Found ${carFolders.length} car(s): ${carFolders.map((f) => path.basename(f)).join(", ")}`);

  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    console.error("\n[Error] 'playwright' is not installed in Node.js.");
    console.error("Please run:\n    npm install playwright\n");
    process.exit(1);
  }

  const ctx = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1600, height: 900 },
  });

  const page = ctx.pages().length > 0 ? ctx.pages()[0] : await ctx.newPage();
  await page.goto(CRM_URL, { waitUntil: "domcontentloaded" });
  await waitForEnter("If the CRM asks you to LOG IN, do it now (only needed once)");

  for (let idx = 0; idx < carFolders.length; idx++) {
    const folder = carFolders[idx];
    console.log(`\n${"=".repeat(60)}\n  CAR ${idx + 1} of ${carFolders.length}: ${path.basename(folder)}\n${"=".repeat(60)}`);
    try {
      await processCar(page, folder);
    } catch (e) {
      if (e.name === "TargetClosedError") {
        console.log("\nBrowser closed by user.");
        break;
      }
      console.log(`\n!! Error on ${path.basename(folder)}: ${e.message}`);
      await waitForEnter("Fix/finish this car manually, then Enter for next car");
    }

    if (idx + 1 < carFolders.length) {
      try {
        await page.goto("about:blank");
        await sleep(1000);
      } catch {}
    }
  }

  console.log("\nAll cars done.");
  await ctx.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  decodeVin,
  readNotes,
  carPhotos,
  deselectExcludedParts,
  setPartsQuality,
};
