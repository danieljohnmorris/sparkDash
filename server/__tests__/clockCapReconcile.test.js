/**
 * SPARK-11: with a fleet-wide clock-cap target persisted in settings, the
 * clockCapAuto tick loop reconciles nodes that are NOT in Auto: a stale
 * marker after a reboot, an out-of-band -rgc, or a mismatched marker MHz all
 * get the cap reapplied, with a gpu.clockcap.reapplied event. The controller's
 * `run` is injected, so no SSH/execFile/hardware is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ClockCapAutoController } from "../clockCapAuto.js";

const FRESH_BOOT = "3626a1f4-0f2e-4b7a-9d6a-1f0e3a2b4c5d";
const OLD_BOOT = "00000000-1111-2222-3333-444444444444";
const SPARK = { id: "spark1", name: "spark1", isLocal: false };

/** '---'-separated status output: marker, boot_id, clocks.gr, temperature. */
function statusText({ markerMhz = null, markerBootId = null, bootId = FRESH_BOOT, clock = 2412 } = {}) {
  const marker = markerMhz == null ? "" : `${markerMhz} ${markerBootId ?? bootId}`;
  return `${marker}\n---${bootId}\n---${clock}\n---64`;
}

/**
 * Scripted run(): the reconcile flow issues statusCommand() (read + verify)
 * and the apply/revert command. `state` holds the marker the node currently
 * reports; the apply/revert command updates it so the verify read sees it.
 */
function scriptedNode(initial) {
  const calls = [];
  const state = { bootId: FRESH_BOOT, ...initial };
  const run = async (_spark, cmd) => {
    calls.push(cmd);
    if (cmd.includes("-lgc")) {
      const mhz = Number(cmd.match(/-lgc 0,(\d+)/)?.[1]);
      state.markerMhz = mhz;
      state.markerBootId = FRESH_BOOT;
      return "";
    }
    if (cmd.includes("-rgc")) {
      state.markerMhz = null;
      return "";
    }
    if (cmd.includes("clocks.gr")) {
      // autoTickCommand reads the mode file first, '---'-separated: an empty
      // first section.
      const prefix = cmd.includes("gpu-clock-mode") ? "---" : "";
      return (
        prefix +
        statusText({
          markerMhz: state.markerMhz,
          markerBootId: state.markerBootId,
          bootId: state.bootId,
        })
      );
    }
    if (cmd.includes("gpu-clock-mode")) {
      return "";
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { run, calls, state };
}

function controller(run, events = []) {
  return new ClockCapAutoController({
    config: { dwellMs: 0, pollMs: 1000 },
    run,
    now: () => 1_730_000_000_000,
    onEvent: (e) => events.push(e),
  });
}

test("reconcileTick reapplies a fixed target after a reboot cleared the marker (stale boot_id)", async () => {
  const node = scriptedNode({ markerMhz: 1800, markerBootId: OLD_BOOT, bootId: FRESH_BOOT });
  const events = [];
  const c = controller(node.run, events);
  c.setFleetTarget({ mode: "fixed", mhz: 2000 });

  await c.reconcileTick(SPARK);

  // Drift: stale marker → effective mhz null ≠ 2000. Reapply + verify read.
  assert.equal(node.calls.filter((cmd) => cmd.includes("-lgc")).length, 1);
  assert.match(node.calls.find((cmd) => cmd.includes("-lgc")), /-lgc 0,2000/);
  assert.match(node.calls.find((cmd) => cmd.includes("-lgc")), /printf '%s\\n' "2000 \$b"/);
  assert.equal(node.calls.filter((cmd) => cmd.includes("clocks.gr")).length, 2);
  const ev = events.find((e) => e.type === "gpu.clockcap.reapplied");
  assert.ok(ev, "reapplied event recorded");
  assert.equal(ev.sparkId, "spark1");
  assert.match(ev.message, /stale marker/);
  assert.match(ev.message, /2000 MHz/);
});

test("reconcileTick reapplies when the marker is gone (-rgc) or MHz mismatched", async () => {
  for (const initial of [{ markerMhz: null }, { markerMhz: 1800, bootId: FRESH_BOOT }]) {
    const node = scriptedNode(initial);
    const events = [];
    const c = controller(node.run, events);
    c.setFleetTarget({ mode: "fixed", mhz: 2000 });

    await c.reconcileTick(SPARK);

    assert.equal(node.calls.filter((cmd) => cmd.includes("-lgc")).length, 1, JSON.stringify(initial));
    assert.ok(events.find((e) => e.type === "gpu.clockcap.reapplied"), JSON.stringify(initial));
  }
});

test("reconcileTick does nothing when the node already matches the target", async () => {
  const node = scriptedNode({ markerMhz: 2000, bootId: FRESH_BOOT });
  const events = [];
  const c = controller(node.run, events);
  c.setFleetTarget({ mode: "fixed", mhz: 2000 });

  await c.reconcileTick(SPARK);

  // One status read (drift detection), no apply, no verify, no event.
  assert.equal(node.calls.length, 1);
  assert.deepEqual(events, []);
});

test("reconcileTick reverts and removes the marker when the target is Unlocked", async () => {
  const node = scriptedNode({ markerMhz: 2000, bootId: FRESH_BOOT });
  const events = [];
  const c = controller(node.run, events);
  c.setFleetTarget({ mode: "unlocked", mhz: null });

  await c.reconcileTick(SPARK);

  assert.equal(node.calls.filter((cmd) => cmd.includes("-rgc")).length, 1);
  assert.match(node.calls.find((cmd) => cmd.includes("-rgc")), /rm -f ~\/\.config\/sparkdash\/gpu-clock-cap/);
  const ev = events.find((e) => e.type === "gpu.clockcap.reapplied");
  assert.ok(ev);
  assert.match(ev.message, /Unlocked/);
});

test("reconcileTick leaves Auto-managed nodes alone and no-ops without a target", async () => {
  const node = scriptedNode({ markerMhz: 2000, bootId: FRESH_BOOT });
  const events = [];
  const c = controller(node.run, events);

  // No fleet target: nothing happens, not even a status read.
  await c.reconcileTick(SPARK);
  assert.equal(node.calls.length, 0);

  // Auto target: reconcile stays off (Auto's own tick re-applies).
  c.setFleetTarget({ mode: "auto", mhz: null });
  await c.reconcileTick(SPARK);
  assert.equal(node.calls.length, 0);

  // Fixed target, but the node is in Auto: tick() owns the cap. The node
  // reports 2000 in-band, so enable() adopts it without applying; a non-Auto
  // node at 2000 under a 2100 target would have been reapplied here.
  c.setFleetTarget({ mode: "fixed", mhz: 2100 });
  await c.enable({ ...SPARK, id: "spark1" });
  await c.reconcileTick(SPARK);
  assert.equal(node.calls.filter((cmd) => cmd.includes("-lgc")).length, 0);
});

test("setFleetTarget only accepts the three validated shapes", () => {
  const c = new ClockCapAutoController({ run: async () => "" });
  c.setFleetTarget({ mode: "fixed", mhz: 2400 });
  assert.deepEqual(c.fleetTarget, { mode: "fixed", mhz: 2400 });
  c.setFleetTarget({ mode: "fixed", mhz: 2500 }); // not a preset → cleared
  assert.equal(c.fleetTarget, null);
  c.setFleetTarget({ mode: "turbo" });
  assert.equal(c.fleetTarget, null);
  c.setFleetTarget(null);
  assert.equal(c.fleetTarget, null);
});
