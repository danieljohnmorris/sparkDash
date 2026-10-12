/**
 * Integration tests for POST /api/sparks/llm-stop-all: the batch stop behind the
 * Overview "Stop all LLMs" control and the Spark card's per-Spark Unload. Runs a
 * real server against a local Spark (no SSH), the same way api.test.js does.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
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

async function startServer(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-stopall-"));
  fs.writeFileSync(path.join(tmp, "sparks.json"), "[]\n");
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      HOME: tmp,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
      EVENTS_JSON_PATH: path.join(tmp, "events.json"),
      GPU_HISTORY_JSON_PATH: path.join(tmp, "gpu-history.json"),
      GPU_HISTORY_LONG_JSON_PATH: path.join(tmp, "gpu-history-long.json"),
      LLM_LAUNCHERS_JSON_PATH: path.join(tmp, "llm-launchers.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 6_000)),
  ]);
  return { port, tmp };
}

async function api(port, pathname, init) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("timed out");
}

function script(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

test("llm-stop-all stops every running launcher and reports per-Spark results", async (t) => {
  const { port, tmp } = await startServer(t);

  const created = await api(port, "/api/sparks", {
    method: "POST",
    body: JSON.stringify({ id: "alpha", name: "alpha", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: os.userInfo().username, auth: "key" } }),
  });
  assert.equal(created.status, 200);

  // Body validation: sparkIds must be "all" or an array of ids.
  assert.equal((await api(port, "/api/sparks/llm-stop-all", { method: "POST", body: JSON.stringify({ sparkIds: 7 }) })).status, 400);
  assert.equal((await api(port, "/api/sparks/llm-stop-all", { method: "POST", body: JSON.stringify({ sparkIds: ["alpha", 7] }) })).status, 400);

  // Unknown ids get a per-Spark result, not a 404.
  const missing = await api(port, "/api/sparks/llm-stop-all", { method: "POST", body: JSON.stringify({ sparkIds: ["nope"] }) });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.results, [{ id: "nope", name: "nope", ok: false, error: "Spark not found" }]);

  const base = "/api/sparks/alpha/llm-launchers";
  const llm = path.join(tmp, "glm");
  // The start script must still be running when the batch stop fires, so it
  // sleeps; the stop script kills it so nothing lingers after the test.
  script(llm, "start.sh", 'echo "loading"; sleep 300');
  script(llm, "stop.sh", 'pkill -f "sleep 300" 2>/dev/null; echo "stopped it"');
  const add = await api(port, base, { method: "POST", body: JSON.stringify({ name: "GLM 5.3", dir: llm, port: 8888 }) });
  assert.equal(add.status, 201);
  const lid = add.body.launcher.id;

  const start = await api(port, `${base}/${lid}/start`, { method: "POST" });
  assert.equal(start.status, 202);
  await until(async () => {
    const r = await api(port, `${base}?status=1`);
    return r.body.statuses?.[lid] === "running";
  });

  const stopAll = await api(port, "/api/sparks/llm-stop-all", { method: "POST" });
  assert.equal(stopAll.status, 200);
  assert.equal(stopAll.body.success, true);
  assert.equal(stopAll.body.results.length, 1);
  const entry = stopAll.body.results[0];
  assert.equal(entry.id, "alpha");
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.stopped, ["GLM 5.3"]);

  // The stop ran the registered stop script and the probe now reports stopped.
  const out = await until(async () => {
    const r = await api(port, `${base}/jobs/${(await api(port, base)).body.job.id}?since=0`);
    return r.body.job?.status !== "running" ? r.body : null;
  });
  assert.ok(out.lines.some((l) => l.text === "stopped it"), out.lines.map((l) => l.text).join("|"));
  const after = await api(port, `${base}?status=1`);
  assert.equal(after.body.statuses[lid], "stopped");

  // A second run with nothing running is a clean no-op, not an error.
  const again = await api(port, "/api/sparks/llm-stop-all", { method: "POST", body: JSON.stringify({ sparkIds: ["alpha"] }) });
  assert.equal(again.status, 200);
  assert.equal(again.body.success, true);
  assert.deepEqual(again.body.results[0].stopped, []);
});
