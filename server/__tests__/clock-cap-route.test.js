/**
 * The clock-cap routes validate server-side before touching any node: an
 * out-of-list or non-integer MHz is a 400, the presets endpoint mirrors
 * server/clockCap.js, and the status route answers with an empty registry.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForListening(output, timeoutMs) {
  // Under a loaded machine a cold Node process can take seconds to print its
  // banner — poll instead of a fixed race, and surface what it did print.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes("server listening")) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`server did not start:\n${output()}`);
}

async function startServer(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-clockcap-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
      SPARKS_JSON_PATH: sparksPath,
      SETTINGS_JSON_PATH: path.join(tmp, "settings.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      LLM_TOKEN_JSON_PATH: path.join(tmp, "llm-token-totals.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await waitForListening(() => output, 15_000);
  return `http://127.0.0.1:${port}`;
}

test("POST /api/sparks/clock-cap rejects out-of-list and non-integer MHz", async (t) => {
  const base = await startServer(t);

  for (const mhz of [2500, 1499, 1800.5, "abc", 0, "2400 0"]) {
    const res = await fetch(`${base}/api/sparks/clock-cap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sparkIds: "all", mhz }),
    });
    assert.equal(res.status, 400, `mhz=${JSON.stringify(mhz)} must be rejected`);
    const body = await res.json();
    assert.match(body.error, /Invalid clock cap/);
  }
});

test("POST /api/sparks/clock-cap reports an empty fleet instead of pretending success", async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/sparks/clock-cap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sparkIds: "all", mhz: null }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /No matching Sparks/);
});

test("GET /api/sparks/clock-cap answers with an empty spark list", async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/sparks/clock-cap`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.sparks, []);
});

test("GET /api/sparks/clock-cap/presets mirrors the preset list", async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/sparks/clock-cap/presets`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.presets, [1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400]);
});

test("POST /api/sparks/clock-cap/mode rejects anything but auto and an empty fleet", async (t) => {
  const base = await startServer(t);

  const badMode = await fetch(`${base}/api/sparks/clock-cap/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sparkIds: "all", mode: "turbo" }),
  });
  assert.equal(badMode.status, 400);
  assert.match((await badMode.json()).error, /mode must be "auto"/);

  const noFleet = await fetch(`${base}/api/sparks/clock-cap/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sparkIds: "all", mode: "auto" }),
  });
  assert.equal(noFleet.status, 400);
  assert.match((await noFleet.json()).error, /No matching Sparks/);
});
