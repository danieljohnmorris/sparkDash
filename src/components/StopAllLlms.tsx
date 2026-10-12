import { useEffect, useRef, useState } from "react";
import { stopAllLlms } from "../api/client";
import { StopIcon } from "./ui/icons";

/**
 * "Stop all LLMs" next to "Shut down all" in the Overview header.
 * One click (no confirm): stops registered launchers and TensorFold/recipe
 * Docker containers on every Spark so VRAM is freed.
 */
export function StopAllLlms({ className = "" }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function run() {
    setBusy(true);
    setMsg({ text: "Stopping…", tone: "ok" });
    try {
      const res = await stopAllLlms("all");
      const fail = res.results.filter((r) => !r.ok).length;
      const stopped = res.results.reduce((n, r) => n + (r.stopped?.length ?? 0), 0);
      const parts =
        stopped === 0 && fail === 0
          ? ["Nothing was serving"]
          : [`${stopped} model${stopped === 1 ? "" : "s"} unloaded`];
      if (fail) parts.push(`${fail} Spark${fail === 1 ? "" : "s"} failed`);
      setMsg({ text: parts.join(", "), tone: fail === 0 ? "ok" : "err" });
    } catch (err: unknown) {
      setMsg({ text: err instanceof Error ? err.message : "Batch stop failed", tone: "err" });
    } finally {
      setBusy(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), 6000);
    }
  }

  return (
    <>
      {msg ? (
        <span className={`ov-batchmsg ${msg.tone === "ok" ? "is-ok" : "is-err"}`} role="status">
          {msg.text}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title="Stop every running model on every Spark (one click; frees VRAM)"
        className={`btn ${className}`}
      >
        <StopIcon className="h-3.5 w-3.5" />
        {busy ? "Stopping…" : "Stop all LLMs"}
      </button>
    </>
  );
}
