/**
 * Stop LLM serving that was started outside sparkDash launchers (TensorFold /
 * recipe Docker containers). SPARK-9 only ran registered stop.sh via pidfiles;
 * live GLM runs as docker glm53-flash-tf with zero launchers, so Unload was a
 * silent no-op. This module finds those containers over SSH and stops them.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { sshExec } from "../collectors/ssh.js";

const execFileAsync = promisify(execFile);

/** Well-known serving container names on Daniel's Sparks (TensorFold / recipes). */
export const SERVE_CONTAINER_NAMES = [
  "glm53-flash-tf",
  "qwen38-flash-next-tf",
  "dsv41-head",
  "dsv41-worker",
];

/**
 * Remote bash that lists matching running containers, stops+removes them, and
 * prints STOPPED:<name> lines. Also flags SERVING_PORT if :8888 still answers
 * after the stop attempt (so the API can refuse silent success).
 */
export function serveStopRemoteCommand(names = SERVE_CONTAINER_NAMES) {
  const list = names.map((n) => n.replace(/'/g, "")).filter(Boolean);
  if (list.length === 0) throw new Error("serve container name list is empty");
  // Exact-name match via grep -x -F -f; also catch any container publishing 8888.
  const nameFile = list.join("\\n");
  return [
    "set +e",
    `printf '%b\\n' '${nameFile}' > /tmp/sparkdash-serve-names.$$`,
    "names=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -x -F -f /tmp/sparkdash-serve-names.$$)",
    "rm -f /tmp/sparkdash-serve-names.$$",
    // Containers publishing host port 8888 (TensorFold API) even if unnamed above.
    "ports=$(docker ps --format '{{.Names}}\\t{{.Ports}}' 2>/dev/null | awk -F'\\t' '$2 ~ /(^|,| )0\\.0\\.0\\.0:8888->|:8888->/ {print $1}')",
    "all=$(printf '%s\\n%s\\n' \"$names\" \"$ports\" | awk 'NF && !seen[$0]++')",
    'for n in $all; do',
    '  docker stop -t 30 "$n" >/dev/null 2>&1',
    '  docker rm -f "$n" >/dev/null 2>&1',
    '  echo "STOPPED:$n"',
    "done",
    // Still answering on 8888 after stop? Caller must not report success.
    'if curl -sf --max-time 2 http://127.0.0.1:8888/health >/dev/null 2>&1; then echo SERVING_PORT=1; else echo SERVING_PORT=0; fi',
  ].join("\n");
}

/** Parse STOPPED: and SERVING_PORT= lines from remote stdout. */
export function parseServeStopOutput(stdout) {
  const stopped = [];
  let servingPort = false;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = /^STOPPED:(.+)$/.exec(line.trim());
    if (m) stopped.push(m[1]);
    if (line.trim() === "SERVING_PORT=1") servingPort = true;
  }
  return { stopped, servingPort };
}

/**
 * Stop docker-served LLMs on one Spark. Returns { stopped: string[], servingPort: boolean }.
 * @param {(spark: object, cmd: string, opts?: object) => Promise<string>} exec
 */
async function localBash(cmd, timeoutMs) {
  const { stdout } = await execFileAsync("/bin/bash", ["-c", cmd], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout).trim();
}

/**
 * Stop docker-served LLMs on one Spark. Returns { stopped: string[], servingPort: boolean }.
 * Local Sparks run the script with bash (no SSH); remotes use sshExec.
 * @param {(spark: object, cmd: string, opts?: object) => Promise<string>} [exec]
 */
export async function stopServingContainers(spark, exec = sshExec, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const cmd = serveStopRemoteCommand(options.names);
  const run =
    spark?.isLocal
      ? () => localBash(cmd, timeoutMs)
      : () => exec(spark, cmd, { timeoutMs });
  const stdout = await run();
  return parseServeStopOutput(stdout);
}
