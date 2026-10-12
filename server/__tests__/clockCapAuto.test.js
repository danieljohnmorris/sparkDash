/**
 * SPARK-6 acceptance tests: feed fake GPU temperatures to the Auto clock-cap
 * controller (no hardware, no SSH — the run function is a fake Spark node)
 * and assert the step behaviour, band limits, dwell and hot fast path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_MODE_REL_PATH,
  autoTickCommand,
  statusCommand,
} from "../clockCap.js";
import {
  FleetClockAuto,
  parseFleetAutoCap,
  AUTO_RANGE,
  AUTO_CAP_PRESETS,
  AUTO_HOLD_TEMP_C,
  AUTO_RELEASE_TEMP_C,
  DEFAULT_AUTO_CAP_MHZ,
  ClockCapAutoController,
  decideAutoStep,
  defaultConfig,
  parseTickOutput,
  stepAutoCap,
} from "../clockCapAuto.js";

const FRESH_BOOT = "3626a1f4-0f2e-4b7a-9d6a-1f0e3a2b4c5d";
const NEW_BOOT = "00000000-1111-2222-3333-444444444444";
const MODE_CMD = `cat ~/${AUTO_MODE_REL_PATH} 2>/dev/null`;

/**
 * A fake Spark node: honours the exact commands the controller issues and
 * keeps marker/boot_id/temperature state like the real node would.
 */
class FakeNode {
  constructor({
    id = "s1",
    name = "spark1",
    bootId = FRESH_BOOT,
    cap = 2000,
    markerBoot = null,
    tempC = 60,
    mode = null,
    brokenMarker = false,
    failApply = false,
  } = {}) {
    this.id = id;
    this.name = name;
    this.bootId = bootId;
    this.cap = cap; // what nvidia-smi currently enforces (null = stock)
    this.markerCap = cap; // marker file content
    this.markerBoot = markerBoot ?? bootId;
    this.tempC = tempC;
    this.mode = mode;
    this.brokenMarker = brokenMarker;
    this.failApply = failApply;
    this.capsApplied = [];
    this.commands = [];
  }

  statusText() {
    return [
      this.markerCap != null ? `${this.markerCap} ${this.markerBoot}` : "",
      this.bootId,
      "1850",
      String(this.tempC),
    ].join("\n---\n");
  }

  async run(_spark, cmd) {
    this.commands.push(cmd);
    if (cmd.includes("-lgc 0,")) {
      if (this.failApply) throw new Error("sudo: a password is required");
      const mhz = Number(cmd.match(/-lgc 0,(\d+)/)[1]);
      this.cap = mhz;
      this.capsApplied.push(mhz);
      // The marker write rides in the same command; a broken write leaves the
      // old marker behind so the controller's verification must catch it.
      if (!this.brokenMarker) {
        this.markerCap = mhz;
        this.markerBoot = this.bootId;
      }
      return "set";
    }
    if (cmd.includes("printf 'auto")) {
      this.mode = "auto";
      return "";
    }
    if (cmd.includes(`rm -f ~/${AUTO_MODE_REL_PATH}`)) {
      this.mode = null;
      return "";
    }
    if (cmd === MODE_CMD) return this.mode ?? "";
    if (cmd === autoTickCommand()) {
      return [this.mode ?? "", this.statusText()].join("\n---\n");
    }
    if (cmd === statusCommand()) return this.statusText();
    throw new Error(`unexpected command: ${cmd}`);
  }

  /** All caps actually applied through -lgc, in order. */
  lastApplied() {
    return this.capsApplied[this.capsApplied.length - 1] ?? null;
  }
}

test("decideAutoStep: 72/67 hysteresis with 60 s dwell and 77 °C fast path", () => {
  const base = { cap: 2000, lastStepAt: 0, now: 60_000, highC: 72, lowC: 67, hotC: 77, dwellMs: 60_000 };
  assert.equal(decideAutoStep({ ...base, tempC: 71, prevTempC: 65 }), null, "between 67 and 72: hold");
  assert.equal(decideAutoStep({ ...base, tempC: 72, prevTempC: 65 }), "down", "≥ 72: step down");
  assert.equal(decideAutoStep({ ...base, tempC: 67, prevTempC: 71 }), "up", "≤ 67: step up");
  assert.equal(decideAutoStep({ ...base, tempC: 72, prevTempC: 65, lastStepAt: 50_000 }), null, "within dwell: hold");
  assert.equal(
    decideAutoStep({ ...base, tempC: 78, prevTempC: 76, lastStepAt: 50_000 }),
    "down",
    "≥ 77 and rising: skip the dwell"
  );
  assert.equal(
    decideAutoStep({ ...base, tempC: 78, prevTempC: 80, lastStepAt: 50_000 }),
    null,
    "≥ 77 but falling: respect the dwell"
  );
  assert.equal(decideAutoStep({ ...base, tempC: null }), null, "no temp reading: hold");
  assert.equal(decideAutoStep({ ...base, cap: 1800, tempC: 80 }), "down" && null, "floor cannot step down");
  assert.equal(decideAutoStep({ ...base, cap: 2200, tempC: 60 }), null, "ceiling cannot step up");
});

test("stepAutoCap walks the 100 MHz band and clamps at 1800/2200", () => {
  assert.equal(stepAutoCap(2000, "down"), 1900);
  assert.equal(stepAutoCap(1900, "up"), 2000);
  assert.equal(stepAutoCap(1800, "down"), 1800);
  assert.equal(stepAutoCap(2200, "up"), 2200);
});

test("parseTickOutput splits mode file from the four status sections", () => {
  const t = parseTickOutput(["auto", `2000 ${FRESH_BOOT}`, FRESH_BOOT, "1850", "71"].join("\n---\n"));
  assert.equal(t.auto, true);
  assert.equal(t.marker.trim(), `2000 ${FRESH_BOOT}`);
  assert.equal(t.temp.trim(), "71");
  assert.equal(parseTickOutput("").auto, false);
});

test("defaultConfig: env overrides the thresholds, defaults are 72/67", () => {
  assert.equal(defaultConfig().highC, 72);
  assert.equal(defaultConfig().lowC, 67);
  const prev = { h: process.env.SPARKDASH_CLOCK_AUTO_HIGH_C, l: process.env.SPARKDASH_CLOCK_AUTO_LOW_C };
  try {
    process.env.SPARKDASH_CLOCK_AUTO_HIGH_C = "70";
    process.env.SPARKDASH_CLOCK_AUTO_LOW_C = "65";
    const cfg = defaultConfig();
    assert.equal(cfg.highC, 70);
    assert.equal(cfg.lowC, 65);
    assert.equal(cfg.hotC, 75, "hot path defaults to high + 5");
  } finally {
    if (prev.h === undefined) delete process.env.SPARKDASH_CLOCK_AUTO_HIGH_C;
    else process.env.SPARKDASH_CLOCK_AUTO_HIGH_C = prev.h;
    if (prev.l === undefined) delete process.env.SPARKDASH_CLOCK_AUTO_LOW_C;
    else process.env.SPARKDASH_CLOCK_AUTO_LOW_C = prev.l;
  }
});

test("enable starts at the current in-band cap, else 2000, and marks the node auto", async () => {
  const inBand = new FakeNode({ cap: 1900 });
  const c = new ClockCapAutoController({ run: (s, cmd) => inBand.run(s, cmd), onEvent: () => {} });
  const res = await c.enable(inBand);
  assert.equal(res.cap, 1900);
  assert.equal(inBand.mode, "auto");
  assert.equal(inBand.lastApplied(), null, "no re-apply needed when the current cap is in band");

  const stock = new FakeNode({ cap: null });
  const c2 = new ClockCapAutoController({ run: (s, cmd) => stock.run(s, cmd), onEvent: () => {} });
  assert.equal((await c2.enable(stock)).cap, 2000);
  assert.equal(stock.lastApplied(), 2000, "stock node gets the 2000 start cap");

  const aboveBand = new FakeNode({ cap: 2400 });
  const c3 = new ClockCapAutoController({ run: (s, cmd) => aboveBand.run(s, cmd), onEvent: () => {} });
  assert.equal((await c3.enable(aboveBand)).cap, 2000, "a 2400 manual cap is replaced by 2000");
});

test("under load: ≥ 72 °C steps down 100 MHz per tick, never below 1800; ≤ 67 °C steps up", async () => {
  const node = new FakeNode({ cap: 2000 });
  let clock = 1_000_000;
  const c = new ClockCapAutoController({ run: (s, cmd) => node.run(s, cmd), now: () => clock, onEvent: () => {} });
  await c.enable(node);
  assert.equal(c.publicState(node.id).cap, 2000);

  const tick = async () => {
    await c.tick(node);
    clock += 60_000; // past the dwell between ticks
  };

  node.tempC = 72;
  await tick();
  assert.equal(c.publicState(node.id).cap, 1900);
  node.tempC = 75;
  await tick();
  assert.equal(c.publicState(node.id).cap, 1800);
  node.tempC = 80;
  await tick();
  assert.equal(c.publicState(node.id).cap, 1800, "never steps below 1800");
  assert.deepEqual(node.capsApplied, [1900, 1800], "no -lgc once at the floor");

  node.tempC = 71;
  await tick();
  assert.equal(c.publicState(node.id).cap, 1800, "between 67 and 72: hold");
  node.tempC = 67;
  await tick();
  assert.equal(c.publicState(node.id).cap, 1900);
  node.tempC = 65;
  await tick();
  assert.equal(c.publicState(node.id).cap, 2000);
  node.tempC = 60;
  await tick();
  assert.equal(c.publicState(node.id).cap, 2100);
  await tick();
  assert.equal(c.publicState(node.id).cap, 2200);
  await tick();
  assert.equal(c.publicState(node.id).cap, 2200, "never steps above 2200");
  assert.deepEqual(node.capsApplied, [1900, 1800, 1900, 2000, 2100, 2200]);

  const st = c.publicState(node.id);
  assert.equal(st.lastStep.to, 2200);
  assert.equal(st.lastStep.dir, "up");
  assert.ok(st.log.length <= 20, "log capped at 20");
  assert.equal(st.lastStep.tempC, 60);
});

test("no step more often than the dwell, but the hot fast path skips it", async () => {
  const node = new FakeNode({ cap: 2000 });
  let clock = 1_000_000;
  const c = new ClockCapAutoController({ run: (s, cmd) => node.run(s, cmd), now: () => clock, onEvent: () => {} });
  await c.enable(node);

  node.tempC = 78; // hot and rising (prev 60)
  clock += 10_000; // one poll, far inside the 60 s dwell
  await c.tick(node);
  assert.equal(c.publicState(node.id).cap, 1900, "≥ 77 °C skips the dwell");

  node.tempC = 72; // plain HIGH_C now, but the dwell has not elapsed
  clock += 10_000;
  await c.tick(node);
  assert.equal(c.publicState(node.id).cap, 1900, "dwell holds between steps");

  clock += 60_000;
  await c.tick(node);
  assert.equal(c.publicState(node.id).cap, 1800, "dwell elapsed: step down");
  assert.deepEqual(node.capsApplied, [1900, 1800]);
});

test("a preset / Unlocked choice turns Auto off", async () => {
  const node = new FakeNode({ cap: 2000 });
  const c = new ClockCapAutoController({ run: (s, cmd) => node.run(s, cmd), onEvent: () => {} });
  await c.enable(node);
  assert.equal(c.isEnabled(node.id), true);
  await c.disable(node);
  assert.equal(c.isEnabled(node.id), false);
  assert.equal(node.mode, null, "mode marker removed");
  assert.equal(c.publicState(node.id), null);

  node.tempC = 90;
  await c.tick(node);
  assert.equal(node.lastApplied(), null, "the controller no longer touches the node");
});

test("Spark reboot: stale boot_id means stock, Auto re-applies and resumes", async () => {
  const node = new FakeNode({ cap: 1900 });
  let clock = 1_000_000;
  const c = new ClockCapAutoController({ run: (s, cmd) => node.run(s, cmd), now: () => clock, onEvent: () => {} });
  await c.enable(node);

  // Reboot: new boot_id, the old marker no longer matches, cap gone.
  node.bootId = NEW_BOOT;
  node.cap = null;
  node.markerBoot = FRESH_BOOT;
  clock += 60_000;
  await c.tick(node);
  assert.equal(c.publicState(node.id).cap, 2000, "resumed at the start cap");
  assert.equal(node.cap, 2000);
  assert.equal(node.markerBoot, NEW_BOOT, "fresh marker carries the new boot_id");
});

test("sparkDash restart: discover re-adopts the mode file and resumes at the marker cap", async () => {
  const node = new FakeNode({ cap: 1900, mode: "auto" });
  const c = new ClockCapAutoController({ run: (s, cmd) => node.run(s, cmd), onEvent: () => {} });
  await c.discover([node]);
  assert.equal(c.isEnabled(node.id), true);
  await c.tick(node);
  assert.equal(c.publicState(node.id).cap, 1900, "adopted the marker cap without re-applying");
  assert.equal(node.lastApplied(), null);

  // A marker outside the band is replaced by the start cap.
  const node2 = new FakeNode({ cap: 2400, mode: "auto" });
  const c2 = new ClockCapAutoController({ run: (s, cmd) => node2.run(s, cmd), onEvent: () => {} });
  await c2.discover([node2]);
  await c2.tick(node2);
  assert.equal(c2.publicState(node2.id).cap, 2000);
  assert.deepEqual(node2.capsApplied, [2000]);
});

test("failures are surfaced, not silent, and leave the last cap in place", async () => {
  const node = new FakeNode({ cap: 2000, failApply: true });
  const events = [];
  let clock = 1_000_000;
  const c = new ClockCapAutoController({
    run: (s, cmd) => node.run(s, cmd),
    now: () => clock,
    onEvent: (e) => events.push(e),
  });
  await c.enable(node);
  node.tempC = 75;
  clock += 60_000;
  await c.tick(node);
  const st = c.publicState(node.id);
  assert.equal(st.cap, 2000, "last cap kept");
  assert.match(st.lastError, /password is required/);
  assert.equal(events.filter((e) => e.type === "gpu.clockcap.auto.failed").length, 1, "failure logged once, throttled");

  clock += 10_000;
  await c.tick(node);
  assert.equal(events.filter((e) => e.type === "gpu.clockcap.auto.failed").length, 1, "no event spam per tick");

  // A broken marker write is caught by the verification, cap unchanged.
  const broken = new FakeNode({ cap: 2000, brokenMarker: true });
  const c2 = new ClockCapAutoController({ run: (s, cmd) => broken.run(s, cmd), onEvent: () => {} });
  await c2.enable(broken); // enable at 2000: no apply needed, marker already fine
  broken.tempC = 72;
  clock += 60_000;
  await c2.tick(broken);
  assert.equal(c2.publicState(broken.id).cap, 2000);
  assert.match(c2.publicState(broken.id).lastError, /did not land/);
  assert.equal(broken.cap, 1900, "nvidia-smi did run, but the state waits for a verified marker");
});

// --- SPARK-7 fleet controller ---

function spark(id, name = id) {
  return { id, name };
}

/** Two-node fleet with mutable temps; applies/reverts are recorded, not executed. */
function harness({ temps = {}, sparks = [spark("a"), spark("b")], applyError = null } = {}) {
  const events = [];
  const calls = [];
  const controller = new FleetClockAuto({
    sparks: () => sparks,
    readTemp: (s) => temps[s.id] ?? null,
    readStatus: async () => ({ mhz: null }),
    apply: async (s, mhz) => {
      calls.push(["apply", s.id, mhz]);
      if (applyError) throw applyError;
      return { mhz };
    },
    revert: async (s) => {
      calls.push(["revert", s.id]);
      if (applyError) throw applyError;
      return { mhz: null };
    },
    recordEvent: (event) => events.push(event),
  });
  return { controller, events, calls };
}

test("parseFleetAutoCap accepts exactly the presets inside the auto range and nothing else", () => {
  assert.deepEqual(AUTO_CAP_PRESETS, [1800, 1900, 2000, 2100, 2200]);
  assert.deepEqual(AUTO_RANGE, { min: 1800, max: 2200 });
  assert.equal(parseFleetAutoCap(1800), 1800);
  assert.equal(parseFleetAutoCap("2200"), 2200);
  for (const bad of [1700, 2300, 2000.5, "abc"]) {
    assert.throws(() => parseFleetAutoCap(bad));
  }
});

test("holds the cap at the hold temperature and releases at the release temperature", async () => {
  const temps = { a: 71, b: 30 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true);

  temps.a = AUTO_HOLD_TEMP_C; // exactly at hold: cap
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", DEFAULT_AUTO_CAP_MHZ]]);

  temps.a = 68; // hysteresis band: keep holding, no calls
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", DEFAULT_AUTO_CAP_MHZ]]);

  temps.a = AUTO_RELEASE_TEMP_C; // exactly at release: revert
  await controller.tick();
  assert.deepEqual(calls, [
    ["apply", "a", DEFAULT_AUTO_CAP_MHZ],
    ["revert", "a"],
  ]);

  temps.a = 68; // released stays released in the band
  await controller.tick();
  assert.deepEqual(calls, [
    ["apply", "a", DEFAULT_AUTO_CAP_MHZ],
    ["revert", "a"],
  ]);
});

test("uses the configured auto cap and validates it against the range", async () => {
  const temps = { a: 80 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true, 2200);
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", 2200]]);

  await assert.rejects(() => controller.setEnabled(true, 2400), /Auto cap must be between/);
  // The invalid request must not have changed the running cap.
  temps.a = 30;
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", 2200], ["revert", "a"]]);
});

test("nodes without a fresh reading are skipped, not reverted", async () => {
  const temps = { a: null, b: 90 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true);
  await controller.tick();
  assert.deepEqual(calls, [["apply", "b", DEFAULT_AUTO_CAP_MHZ]]);
  // b cools below release but a is still unreadable — b reverts, a untouched.
  temps.a = 40;
  temps.b = 20;
  await controller.tick();
  assert.deepEqual(calls, [
    ["apply", "b", DEFAULT_AUTO_CAP_MHZ],
    ["revert", "b"],
  ]);
});

test("set failure records an error event and keeps the node unheld for a retry", async () => {
  const { controller, events, calls } = harness({
    applyError: new Error("nvidia-smi failed"),
    temps: { a: 85 },
  });
  await controller.setEnabled(true);
  await controller.tick();
  assert.equal(calls.length, 1);
  assert.equal(events.filter((e) => e.type === "gpu.clockcap.auto.failed").length, 1);

  // Still unheld: the next tick retries the apply instead of waiting for release.
  await controller.tick();
  assert.equal(calls.length, 2);
  const status = controller.status();
  assert.equal(status.sparks.find((s) => s.id === "a").lastError, "nvidia-smi failed");
});

test("disabling stops the loop and clears per-node state without touching caps", async () => {
  const temps = { a: 85 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true);
  await controller.tick();
  assert.equal(calls.length, 1);

  await controller.setEnabled(false);
  assert.equal(controller.status().enabled, false);
  assert.deepEqual(controller.status().sparks.map((s) => s.holding), [false, false]);
  await controller.tick();
  assert.equal(calls.length, 1); // no further actuation after disable
});

test("enabling adopts existing caps so auto releases what it holds", async () => {
  const sparks = [spark("a"), spark("b")];
  const calls = [];
  const controller = new FleetClockAuto({
    sparks: () => sparks,
    readTemp: () => 30, // cool: auto would revert held caps
    readStatus: async (s) => ({ mhz: s.id === "a" ? 2200 : null }),
    apply: async () => assert.fail("must not apply on a cool fleet"),
    revert: async (s) => {
      calls.push(["revert", s.id]);
      return { mhz: null };
    },
    recordEvent: () => {},
  });
  await controller.setEnabled(true);
  await controller.tick();
  // a had a cap (adopted, so released); b never had one (left alone).
  assert.deepEqual(calls, [["revert", "a"]]);
});

test("status exposes thresholds, range, and per-node holding state", async () => {
  const temps = { a: 90, b: 40 };
  const { controller } = harness({ temps });
  await controller.setEnabled(true, 2100);
  await controller.tick();
  const status = controller.status();
  assert.equal(status.enabled, true);
  assert.equal(status.capMhz, 2100);
  assert.equal(status.holdTempC, 72);
  assert.equal(status.releaseTempC, 67);
  assert.deepEqual(status.presets, [1800, 1900, 2000, 2100, 2200]);
  assert.deepEqual(
    status.sparks.map((s) => [s.id, s.holding]),
    [["a", true], ["b", false]]
  );
});
