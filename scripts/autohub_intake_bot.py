"""
AutoHub Express - Car Intake Co-pilot  (FINAL)
===============================================
Per car folder (named by VIN, photos 01..12, optional notes.txt):
  1. Decodes the VIN (NHTSA) + reads notes.txt
  2. Enters VIN in the CRM dialog, waits for its auto-decode
  3. Fills color/trim/weight/engine variant, ticks drive & transmission
  4. You review -> Enter -> it opens the Car Images page itself
  5. Uploads every photo IN ORDER and WAITS for the server to accept each
  6. Waits for all traffic to finish, clicks Continue (this saves the images)
  7. You do the remaining pages + submit -> Enter -> next car

Run:  python autohub_intake_bot.py
"""

import json
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

# ----------------------------- SETTINGS ------------------------------------
INTAKE_DIR  = Path(r"C:\Users\shubh\Downloads\intake_folder")
CRM_URL     = "https://autohubexpress.us/car-intake"
PROFILE_DIR = Path.home() / ".autohub_bot_profile"
PHOTO_EXTS  = {".jpg", ".jpeg", ".png", ".webp"}
UPLOAD_KEYWORDS = ("image", "upload", "file", "photo", "media")

# --- Slow-office-network timeouts (seconds / ms). Raise these if uploads
#     time out; lower them back when the connection is fast again. ---
PHOTO_SERVER_WAIT_S   = 90      # how long to wait for EACH photo's server response
NETWORKIDLE_WAIT_MS   = 300000  # final "let transfers finish" wait (5 min)
SLOTS_WAIT_MS         = 120000  # wait for the 12 upload slots to appear
MODAL_WAIT_MS         = 20000   # wait for the upload dialog to open
FILE_INPUT_WAIT_MS    = 15000   # wait for the file <input> inside the dialog
# ----------------------------------------------------------------------------


def decode_vin(vin: str) -> dict:
    url = f"https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json"
    d = requests.get(url, timeout=30).json()["Results"][0]

    drive_raw = (d.get("DriveType") or "").upper()
    if "FRONT" in drive_raw or "FWD" in drive_raw:
        drive = "FWD"
    elif "ALL" in drive_raw or "AWD" in drive_raw:
        drive = "AWD"
    elif "4WD" in drive_raw or "4X4" in drive_raw:
        drive = "4WD"
    elif "REAR" in drive_raw or "RWD" in drive_raw or "4X2" in drive_raw:
        drive = "2WD"
    else:
        drive = ""

    trans_raw = (d.get("TransmissionStyle") or "").upper()
    if "AUTO" in trans_raw or "CVT" in trans_raw:
        trans = "Automatic"
    elif "MANUAL" in trans_raw:
        trans = "Manual"
    else:
        trans = ""

    return {
        "year": d.get("ModelYear") or "",
        "make": (d.get("Make") or "").upper(),
        "model": d.get("Model") or "",
        "trim": d.get("Trim") or d.get("Series") or "",
        "engine_variant": d.get("EngineModel") or "",
        "drive": drive,
        "transmission": trans,
        "weight": d.get("CurbWeightLB") or "",
    }


def read_notes(folder: Path) -> dict:
    notes = {}
    f = folder / "notes.txt"
    if f.exists():
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                notes[k.strip().lower()] = v.strip()
    return notes


def car_photos(folder: Path):
    import re
    def natural_key(p: Path):
        return [int(t) if t.isdigit() else t.lower()
                for t in re.split(r"(\d+)", p.name)]
    pics = [p for p in folder.iterdir() if p.suffix.lower() in PHOTO_EXTS]
    return sorted(pics, key=natural_key)


def wait_for_enter(msg: str):
    try:
        import msvcrt
        while msvcrt.kbhit():
            msvcrt.getch()
    except ImportError:
        pass
    input(f"\n>>> {msg}\n>>> Press Enter here when ready... ")


def fill_if_empty(page, field_id: str, value: str):
    if not value:
        return
    try:
        box = page.locator(f"#{field_id}")
        if box.count() == 0:
            return
        if (box.first.input_value() or "").strip() == "":
            box.first.fill(str(value))
            print(f"    filled: {field_id} -> {value}")
    except Exception as e:
        print(f"    (skip {field_id}: {e})")


def click_radio(page, group: str, value: str):
    if not value:
        return
    try:
        sel = page.locator(f"input[name='{group}'][value='{value}']")
        if sel.count() > 0 and sel.first.is_checked():
            print(f"    {group}: {value} (already selected)")
            return
        page.locator(
            f"label.ant-radio-wrapper:has(input[name='{group}'][value='{value}'])"
        ).first.click(timeout=4000)
        print(f"    selected {group}: {value}")
    except Exception:
        try:
            page.locator(f"input[name='{group}'][value='{value}']").first.check(
                force=True, timeout=3000)
            print(f"    selected {group}: {value}")
        except Exception:
            print(f"    (couldn't tick {group}={value} - do it by hand)")


def upload_photos(page, photos):
    """Upload photos, waiting for the server to accept each one."""
    stats = {"ok": 0, "fail": 0}

    def on_response(resp):
        try:
            url = resp.url.lower()
            if resp.request.method == "POST" and any(k in url for k in UPLOAD_KEYWORDS):
                if resp.ok:
                    stats["ok"] += 1
                    print(f"      [server OK {resp.status}]")
                else:
                    stats["fail"] += 1
                    print(f"      [server FAIL {resp.status}] {resp.url[:90]}")
        except Exception:
            pass

    page.on("response", on_response)

    uploaded = 0
    for photo in photos:
        try:
            add_btns = page.locator("div.camera-upload button:has-text('Add Image')")
            if add_btns.count() == 0:
                print(f"    no empty slots left - {len(photos)-uploaded} photo(s) unused")
                break

            responses_before = stats["ok"] + stats["fail"]

            add_btns.first.scroll_into_view_if_needed()
            add_btns.first.click()
            modal = page.locator(".ant-modal-content").last
            modal.wait_for(state="visible", timeout=MODAL_WAIT_MS)

            try:
                tab = modal.get_by_role("tab", name="Upload")
                if tab.count() > 0 and tab.first.get_attribute("aria-selected") != "true":
                    tab.first.click(); time.sleep(0.4)
            except Exception:
                pass

            file_input = modal.locator("input[type='file']")
            file_input.wait_for(state="attached", timeout=FILE_INPUT_WAIT_MS)
            file_input.set_input_files(str(photo))
            print(f"    slot {uploaded+1:02d} <- {photo.name}")

            # click any confirm button that appears after picking the file
            time.sleep(1)
            for label in ("Upload", "Save", "OK", "Confirm", "Crop"):
                try:
                    btn = modal.get_by_role("button", name=label)
                    if btn.count() > 0 and btn.first.is_visible():
                        btn.first.click()
                        print(f"      clicked '{label}' in popup")
                        break
                except Exception:
                    pass

            # WAIT until the server actually receives this photo
            deadline = time.time() + PHOTO_SERVER_WAIT_S
            while time.time() < deadline:
                if stats["ok"] + stats["fail"] > responses_before:
                    break
                time.sleep(0.5)
            else:
                print(f"      (no server response in {PHOTO_SERVER_WAIT_S}s - photo "
                      "may not have transferred; watch this one)")

            try:
                if modal.is_visible():
                    close_x = modal.locator("button.ant-modal-close")
                    if close_x.count() > 0:
                        close_x.first.click()
                    else:
                        page.keyboard.press("Escape")
                    time.sleep(0.5)
            except Exception:
                pass

            uploaded += 1
        except Exception as e:
            print(f"    photo {photo.name} FAILED ({e}) - do this one by hand")
            try:
                page.keyboard.press("Escape"); time.sleep(0.5)
            except Exception:
                pass
            uploaded += 1

    print("    letting any remaining transfers finish...")
    try:
        page.wait_for_load_state("networkidle", timeout=NETWORKIDLE_WAIT_MS)
    except Exception:
        pass
    time.sleep(2)

    print(f"    done: {uploaded}/{len(photos)} photos | "
          f"server OK: {stats['ok']}  FAIL: {stats['fail']}")

    # CRITICAL: Continue saves the images to the record
    # (the page also contains a HIDDEN dialog Continue button - click the visible one)
    if uploaded > 0:
        try:
            page.locator("button:has-text('Continue'):visible").last.click(timeout=5000)
            print("    clicked Continue - images saved to the record")
            time.sleep(3)
        except Exception:
            print("    !! couldn't click Continue - CLICK IT YOURSELF NOW or the "
                  "images will NOT be saved")

    page.remove_listener("response", on_response)


def set_parts_quality(page, value: str):
    """Set every 'Select Quality' dropdown on the Car Diagnostic page to `value`
    ('good' or 'average'). Re-finds the next unset dropdown each pass so it
    survives the React re-render after each selection. Returns count set."""
    value = value.strip().lower()
    js = """
    async (target) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let done = 0, safety = 200;
      while (safety-- > 0) {
        const sel = [...document.querySelectorAll('.ant-select')]
          .find(s => s.textContent.includes('Select Quality'));
        if (!sel) break;
        sel.scrollIntoView({block: 'center'});
        await sleep(200);
        sel.querySelector('.ant-select-selector')
           .dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
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
    """
    try:
        count = page.evaluate(js, value)
        print(f"    set {count} part dropdowns to '{value}'")
        return count
    except Exception as e:
        print(f"    !! parts-quality step failed: {e}")
        return 0


def process_car(page, folder: Path, quality: str = ""):
    vin = folder.name.strip().upper()
    print(f"\n{'='*60}\nCAR: {vin}\n{'='*60}")

    photos = car_photos(folder)
    print(f"  {len(photos)} photos found")
    if not photos:
        print("  !! no photos in folder - skipping this car")
        return

    print("  Decoding VIN via NHTSA...")
    data = decode_vin(vin)
    notes = read_notes(folder)
    data["color"]        = notes.get("color", "")
    data["trim"]         = notes.get("trim", data["trim"])
    data["drive"]        = (notes.get("drive", data["drive"]) or "").upper()
    data["transmission"] = (notes.get("transmission", data["transmission"]) or "").title()
    data["weight"]       = notes.get("weight", data["weight"])

    print(f"  -> {data['year']} {data['make']} {data['model']} {data['trim']}"
          f" | {data['drive']} | {data['transmission'] or 'trans: ?'}"
          f" | color: {data['color'] or '?'}")

    # Hard-navigate then RELOAD: the CRM is a React single-page app, so a plain
    # goto() to the same URL after submitting a car often keeps the old state and
    # the "Add New Car" dialog never appears. reload() forces a fresh app load.
    page.goto(CRM_URL, wait_until="domcontentloaded")
    try:
        page.reload(wait_until="networkidle", timeout=NETWORKIDLE_WAIT_MS)
    except Exception:
        pass
    time.sleep(3)
    try:
        # Always click "Add New Car" first to guarantee the dialog is open,
        # rather than relying on an instant count that races the SPA render.
        try:
            page.get_by_text("Add New Car", exact=True).first.click(timeout=8000)
            time.sleep(2)
        except Exception:
            pass  # dialog may already be open
        vin_box = page.get_by_placeholder("17-CHARACTER VIN", exact=False).locator(
            "visible=true").first
        vin_box.wait_for(state="visible", timeout=20000)
        vin_box.fill(vin)
        page.locator("button:has-text('Continue'):visible").last.click(timeout=5000)
        print("  VIN submitted, waiting for CRM auto-decode...")
        page.locator("#color").wait_for(state="visible", timeout=30000)
        time.sleep(2)
    except Exception:
        print("  !! Couldn't find the VIN dialog automatically.")
        wait_for_enter("Enter the VIN yourself and click Continue, then come back")

    print("  Filling remaining fields...")
    fill_if_empty(page, "color",         data["color"])
    fill_if_empty(page, "trim",          data["trim"])
    fill_if_empty(page, "weight",        data["weight"])
    fill_if_empty(page, "engineVariant", data["engine_variant"])
    click_radio(page, "drive",        data["drive"])
    click_radio(page, "transmission", data["transmission"])

    wait_for_enter("Check the fields, fix anything. When you press Enter I'll "
                   "open the Car Images page myself")
    try:
        page.locator("button:has-text('Car Images'):visible").first.click(timeout=5000)
        print("  opened the Car Images page")
    except Exception:
        print("  (couldn't click 'Car Images' - open the photo page yourself)")

    print("  Uploading photos...")
    slots = page.locator("div.camera-upload button:has-text('Add Image')")
    print("    waiting for photo slots to appear...")
    try:
        slots.first.wait_for(state="visible", timeout=SLOTS_WAIT_MS)
    except Exception:
        print("    !! no 'Add Image' slots appeared within 60s - skipping photos")
        wait_for_enter("Handle photos manually, then Enter for the next car")
        return

    upload_photos(page, photos)

    if quality:
        print(f"  Setting all part qualities to '{quality}'...")
        print("    (make sure the Car Diagnostic page with the 'Select Quality' "
              "dropdowns is showing)")
        wait_for_enter(f"Navigate to the Car Diagnostic page, then Enter to set all parts to '{quality}'")
        n = set_parts_quality(page, quality)
        if n == 0:
            print("    !! no dropdowns were set - if you're on the right page, set them manually")

    wait_for_enter("Verify everything looks right, finish remaining pages, submit. "
                   "Then Enter for the NEXT car")


def main():
    if not INTAKE_DIR.exists():
        print(f"Create {INTAKE_DIR} first, one sub-folder per VIN."); sys.exit(1)
    car_folders = sorted([f for f in INTAKE_DIR.iterdir() if f.is_dir()])
    if not car_folders:
        print(f"No car folders inside {INTAKE_DIR}."); sys.exit(0)
    print(f"Found {len(car_folders)} car(s): {', '.join(f.name for f in car_folders)}")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR), headless=False,
            viewport={"width": 1600, "height": 900})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(CRM_URL, wait_until="domcontentloaded")
        wait_for_enter("If the CRM asks you to LOG IN, do it now (only needed once)")

        for idx, folder in enumerate(car_folders, 1):
            print(f"\n{'='*60}\n  CAR {idx} of {len(car_folders)}: {folder.name}\n{'='*60}")
            try:
                process_car(page, folder)
            except KeyboardInterrupt:
                print("\nStopped by user."); break
            except Exception as e:
                print(f"\n!! Error on {folder.name}: {e}")
                wait_for_enter("Fix/finish this car manually, then Enter for next car")
            # Reset to a neutral page so the NEXT car starts from a clean SPA load.
            if idx < len(car_folders):
                try:
                    page.goto("about:blank")
                    time.sleep(1)
                except Exception:
                    pass

        print("\nAll cars done.")
        ctx.close()


if __name__ == "__main__":
    main()