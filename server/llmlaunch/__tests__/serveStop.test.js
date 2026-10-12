/**
 * Unit tests for TensorFold/docker serve-stop helpers (SPARK-10).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseServeStopOutput,
  serveStopRemoteCommand,
  stopServingContainers,
  SERVE_CONTAINER_NAMES,
} from "../serveStop.js";

test("serveStopRemoteCommand lists known container names", () => {
  const cmd = serveStopRemoteCommand(["glm53-flash-tf", "qwen38-flash-next-tf"]);
  assert.match(cmd, /glm53-flash-tf/);
  assert.match(cmd, /docker stop -t 30/);
  assert.match(cmd, /SERVING_PORT/);
});

test("parseServeStopOutput collects STOPPED lines and SERVING_PORT", () => {
  assert.deepEqual(parseServeStopOutput(["STOPPED:glm53-flash-tf", "SERVING_PORT=0", ""].join("\n")), {
    stopped: ["glm53-flash-tf"],
    servingPort: false,
  });
  assert.deepEqual(parseServeStopOutput("SERVING_PORT=1\n"), { stopped: [], servingPort: true });
});

test("stopServingContainers uses ssh exec and returns parsed names", async () => {
  const calls = [];
  const exec = async (spark, cmd) => {
    calls.push({ spark, cmd });
    return ["STOPPED:glm53-flash-tf", "STOPPED:qwen38-flash-next-tf", "SERVING_PORT=0"].join("\n");
  };
  const out = await stopServingContainers({ id: "spark1" }, exec);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spark.id, "spark1");
  assert.match(calls[0].cmd, /glm53-flash-tf/);
  assert.deepEqual(out.stopped, ["glm53-flash-tf", "qwen38-flash-next-tf"]);
  assert.equal(out.servingPort, false);
});

test("SERVE_CONTAINER_NAMES includes live TensorFold GLM name", () => {
  assert.ok(SERVE_CONTAINER_NAMES.includes("glm53-flash-tf"));
});
