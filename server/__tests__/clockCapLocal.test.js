/**
 * SPARK-11: the fleet apply must reach the local (isLocal) host too — spark2
 * runs sparkDash itself, so `sparkIds: "all"` includes it. This pins the local
 * branch of runOnSpark: execFile with an argv array on the host-user drop (no
 * SSH), running the same validated commands the remote path uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";

const { applyClockCap } = await import("../clockCap.js");

const FRESH_BOOT = "3626a1f4-0f2e-4b7a-9d6a-1f0e3a2b4c5d";
const LOCAL = { id: "spark2", name: "spark2", isLocal: true, ssh: { user: "dan" } };

/** '---'-separated status output: marker, boot_id, clocks.gr, temperature. */
function statusText(markerMhz, bootId = FRESH_BOOT) {
  const marker = markerMhz == null ? "" : `${markerMhz} ${bootId}`;
  return `${marker}\n---${bootId}\n---1998\n---64`;
}

test("applyClockCap on the local host runs execFile with the -lgc + marker commands", async (t) => {
  // Pin the invocation inputs: no host-mount namespace, dan resolves to a
  // non-root uid, and the process is not root — the local drop picks the
  // plain `sh -c` fallback either way.
  t.mock.method(fs, "existsSync", () => false);
  t.mock.method(fs, "readFileSync", () => "dan:x:1000:1000::/home/dan:/bin/bash\n");
  t.mock.method(process, "getuid", () => 1000);

  const calls = [];
  t.mock.method(childProcess, "execFile", (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const cmd = args.join(" ");
    // First round trip: nvidia-smi -lgc. Second: marker write + status.
    const out = cmd.includes("-lgc") ? "" : statusText(2000);
    setImmediate(() => cb(null, out, ""));
  });

  const status = await applyClockCap(LOCAL, 2000);

  assert.equal(calls.length, 2);
  // Local branch: execFile on this host, no ssh binary in sight.
  assert.equal(calls[0].file, "sh");
  assert.equal(calls[0].args[0], "-c");
  assert.match(calls[0].args[1], /sudo -n \/usr\/bin\/nvidia-smi -lgc 0,2000/);
  assert.match(calls[1].args[1], /printf '%s\\n' "2000 \$b"/);
  assert.match(calls[1].args[1], /cat \/proc\/sys\/kernel\/random\/boot_id/);
  // The fresh status comes back as the resolved cap.
  assert.equal(status.mhz, 2000);
  assert.equal(status.stale, false);
  assert.equal(status.markerMhz, null);
  assert.equal(status.graphicsClockMHz, 1998);
});

test("applyClockCap on the local host throws when the marker write fails", async (t) => {
  t.mock.method(fs, "existsSync", () => false);
  t.mock.method(fs, "readFileSync", () => "dan:x:1000:1000::/home/dan:/bin/bash\n");
  t.mock.method(process, "getuid", () => 1000);

  t.mock.method(childProcess, "execFile", (file, args, opts, cb) => {
    const cmd = args.join(" ");
    const out = cmd.includes("-lgc") ? "" : statusText(null);
    setImmediate(() => cb(null, out, ""));
  });

  await assert.rejects(
    () => applyClockCap(LOCAL, 2000),
    /marker write failed on spark2/
  );
});
