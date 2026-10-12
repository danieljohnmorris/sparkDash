import { useEffect, useRef, useState } from "react";
import { stopAllLlms } from "../api/client";
import { ConfirmShutdownDialog } from "./ConfirmShutdownDialog";
import { StopIcon } from "./ui/icons";

/**
 * "Stop all LLMs" with its confirmation and result message, next to "Shut down all"
 * in the Overview header. Runs the registered stop script of every launcher the
 * status probe reports running, on every Spark — the engines exit and their VRAM
 * is freed. This is the fleet-wide form of a Spark card's Unload control.
 */
export function StopAllLlms({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await stopAllLlms("all");
      const fail = res.results.filter((r) => !r.ok).length;
      const stopped = res.results.reduce((n, r) => n + (r.stopped?.length ?? 0), 0);
      const parts = [`${stopped} model${stopped === 1 ? "" : "s"} unloaded`];
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
        onClick={() => setOpen(true)}
        disabled={busy}
        title="Stop every running model: each launcher's stop script runs on its Spark, freeing VRAM"
        className={`btn ${className}`}
      >
        <StopIcon className="h-3.5 w-3.5" />
        Stop all LLMs
      </button>
      <ConfirmShutdownDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={run}
        title="Stop all LLMs"
        description="Stop serving on every Spark? Each model's stop script runs on its Spark — the engines exit and their VRAM is freed."
        confirmLabel="Stop all LLMs"
        confirmPhrase="unload"
        busyLabel="Stopping…"
        warnings={["In-flight LLM requests are dropped."]}
        note="The engine processes exit; nothing powers off. Start a model again at any time."
        ackText="I understand in-flight requests will be dropped."
      />
    </>
  );
}
