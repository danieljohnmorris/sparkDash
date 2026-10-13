/**
 * Settings defaults the UI mirrors as its pre-load fallback (App.tsx). A
 * mismatch shows one thing until /api/settings answers and another after.
 */
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(dir, "settings.json");
const { loadSettings, updateSettings } = await import("../../settings.js");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("showVramBreakdown defaults on, and the fresh file records it", () => {
  const s = loadSettings();
  assert.equal(s.showVramBreakdown, true);
  const onDisk = JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8"));
  assert.equal(onDisk.showVramBreakdown, true);
});

test("an older settings.json without the key gets the default", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().showVramBreakdown, true);
});

test("showVramBreakdown turns off and is stored as a boolean", () => {
  assert.equal(updateSettings({ showVramBreakdown: false }).showVramBreakdown, false);
  assert.equal(updateSettings({ showVramBreakdown: 1 }).showVramBreakdown, true);
  assert.equal(loadSettings().showVramBreakdown, true);
});

test("prometheusExport is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().prometheusExport, false);
  assert.equal(updateSettings({ prometheusExport: "yes" }).prometheusExport, true);
  assert.equal(loadSettings().prometheusExport, true);
  assert.equal(updateSettings({ prometheusExport: 0 }).prometheusExport, false);
});

test("clockCapTarget persists the fleet mode and rejects invalid shapes", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  updateSettings({ clockCapTarget: { mode: "fixed", mhz: 2000 } });
  assert.deepEqual(loadSettings().clockCapTarget, { mode: "fixed", mhz: 2000 });

  updateSettings({ clockCapTarget: { mode: "unlocked", mhz: null } });
  assert.deepEqual(loadSettings().clockCapTarget, { mode: "unlocked", mhz: null });

  updateSettings({ clockCapTarget: { mode: "auto", mhz: null } });
  assert.deepEqual(loadSettings().clockCapTarget, { mode: "auto", mhz: null });

  // Invalid mode / off-preset MHz fall back to "no fleet target".
  updateSettings({ clockCapTarget: { mode: "turbo", mhz: 2000 } });
  assert.equal(loadSettings().clockCapTarget, null);
  updateSettings({ clockCapTarget: { mode: "fixed", mhz: 2500 } });
  assert.equal(loadSettings().clockCapTarget, null);
  updateSettings({ clockCapTarget: "auto" });
  assert.equal(loadSettings().clockCapTarget, null);
});
