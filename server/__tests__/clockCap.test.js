/**
 * Unit tests for the clock-cap command builders, marker parsing and the
 * stale-boot_id rule. The command strings are the exact shells that run on the
 * node — they must contain nothing but the validated preset integer and the
 * node-side $(cat boot_id) capture.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOCK_CAP_PRESETS,
  NVSMI,
  applyCapCommand,
  parseClockCap,
  parseClocksGr,
  parseMarkerLine,
  removeMarkerCommand,
  revertCapCommand,
  resolveCapStatus,
  splitStatusSections,
  statusCommand,
  writeMarkerCommand,
} from "../clockCap.js";

const FRESH_BOOT = "3626a1f4-0f2e-4b7a-9d6a-1f0e3a2b4c5d";
const OLD_BOOT = "00000000-1111-2222-3333-444444444444";

test("presets are 1500..2400 every 100 MHz", () => {
  assert.deepEqual([...CLOCK_CAP_PRESETS], [1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400]);
});

test("parseClockCap accepts exactly the preset integers", () => {
  for (const mhz of CLOCK_CAP_PRESETS) {
    assert.equal(parseClockCap(mhz), mhz);
    assert.equal(parseClockCap(String(mhz)), mhz);
  }
});

test("parseClockCap rejects out-of-list and non-integer values", () => {
  for (const bad of [0, 1, 1499, 2450, 2500, 1800.5, "1800.5", "abc", "", null, undefined, true, [], {}, NaN]) {
    assert.throws(() => parseClockCap(bad), /Invalid clock cap/);
  }
});

test("cap commands are the narrow sudoers invocations", () => {
  assert.equal(applyCapCommand(2000), `sudo -n ${NVSMI} -lgc 0,2000`);
  assert.equal(applyCapCommand("2400"), `sudo -n ${NVSMI} -lgc 0,2400`);
  assert.equal(revertCapCommand(), `sudo -n ${NVSMI} -rgc`);
});

test("invalid caps never reach a command string", () => {
  assert.throws(() => applyCapCommand("2500; rm -rf /"), /Invalid clock cap/);
  assert.throws(() => applyCapCommand("2400 0"), /Invalid clock cap/);
  assert.throws(() => writeMarkerCommand("1500 || touch /tmp/pwned"), /Invalid clock cap/);
});

test("writeMarkerCommand writes <MHz> <boot_id> from the node's boot_id", () => {
  const cmd = writeMarkerCommand(1800);
  assert.match(cmd, /^mkdir -p ~\/\.config\/sparkdash/);
  assert.match(cmd, /cat \/proc\/sys\/kernel\/random\/boot_id/);
  assert.match(cmd, /printf '%s\\n' "1800 \$b" > ~\/\.config\/sparkdash\/gpu-clock-cap$/);
});

test("removeMarkerCommand and statusCommand reference the marker path", () => {
  assert.equal(removeMarkerCommand(), "rm -f ~/.config/sparkdash/gpu-clock-cap");
  assert.match(statusCommand(), /cat ~\/\.config\/sparkdash\/gpu-clock-cap 2>\/dev\/null/);
  assert.match(statusCommand(), /clocks\.gr/);
});

test("parseMarkerLine accepts <MHz> <boot_id> and rejects the rest", () => {
  assert.deepEqual(parseMarkerLine(`2000 ${FRESH_BOOT}\n`), { mhz: 2000, bootId: FRESH_BOOT });
  assert.equal(parseMarkerLine(""), null);
  assert.equal(parseMarkerLine("nvidia-smi: no devices"), null);
  assert.equal(parseMarkerLine(`2400 not-a-boot-id`), null);
  assert.equal(parseMarkerLine(`24.5 ${FRESH_BOOT}`), null);
});

test("resolveCapStatus: matching boot_id shows the cap", () => {
  const s = resolveCapStatus(`1800 ${FRESH_BOOT}`, FRESH_BOOT, "1795");
  assert.equal(s.mhz, 1800);
  assert.equal(s.stale, false);
  assert.equal(s.graphicsClockMHz, 1795);
});

test("resolveCapStatus: a marker from an earlier boot is stale → stock", () => {
  const s = resolveCapStatus(`1900 ${OLD_BOOT}`, FRESH_BOOT, "2412");
  assert.equal(s.mhz, null);
  assert.equal(s.stale, true);
  assert.equal(s.markerMhz, 1900);
  assert.equal(s.graphicsClockMHz, 2412);
});

test("resolveCapStatus: no marker (or unreadable boot_id) is Unlocked", () => {
  assert.equal(resolveCapStatus("", FRESH_BOOT, "2400").mhz, null);
  assert.equal(resolveCapStatus(`1800 ${FRESH_BOOT}`, "", "2400").mhz, null);
  const empty = resolveCapStatus("", FRESH_BOOT, "");
  assert.equal(empty.graphicsClockMHz, null);
});

test("parseClocksGr takes the first parseable GPU and skips [N/A]", () => {
  assert.equal(parseClocksGr("1795"), 1795);
  assert.equal(parseClocksGr("[N/A]\n1802"), 1802);
  assert.equal(parseClocksGr("[N/A, N/A]"), null);
  assert.equal(parseClocksGr(""), null);
});

test("splitStatusSections splits marker / boot_id / clocks", () => {
  const { marker, bootId, clocks } = splitStatusSections(`1800 ${FRESH_BOOT}\n---\n${FRESH_BOOT}\n---\n1795\n`);
  assert.equal(marker.trim(), `1800 ${FRESH_BOOT}`);
  assert.equal(bootId.trim(), FRESH_BOOT);
  assert.equal(clocks.trim(), "1795");
});
