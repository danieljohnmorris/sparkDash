/**
 * SPARK-6: automatic GPU clock cap control (1800–2200 MHz) by temperature.
 *
 * One controller instance runs in the sparkDash backend and ticks every node
 * that is in Auto mode roughly every 10 s (one SSH round trip per node per
 * tick). Hysteresis: step down 100 MHz when the GPU reaches HIGH_C (default
 * 72 °C — the "hold" threshold), step back up when it drops to LOW_C (default
 * 67 °C — the "release" threshold), hold in between. A minimum dwell between
 * steps stops flapping; a node still rising well above HIGH_C (≥ HOT_C,
 * default 77 °C) may skip the dwell and step down immediately.
 *
 * The cap is applied through the same narrow sudoers rule as the manual
 * presets (server/clockCap.js) and the node keeps the same
 * `~/.config/sparkdash/gpu-clock-cap` marker, plus a sibling
 * `gpu-clock-mode` file containing `auto`. That mode file is the source of
 * truth: it survives sparkDash restarts (the controller re-adopts the node)
 * and a Spark reboot (a stale boot_id means the cap is gone, so Auto
 * re-applies it). Choosing a preset or Unlocked removes the mode file, which
 * turns Auto off for that node.
 *
 * All thresholds are env-configurable, never hardcoded in the UI:
 *   SPARKDASH_CLOCK_AUTO_HIGH_C   (default 72)
 *   SPARKDASH_CLOCK_AUTO_LOW_C    (default 67)
 *   SPARKDASH_CLOCK_AUTO_HOT_C    (default 77, dwell-skipping fast path)
 *   SPARKDASH_CLOCK_AUTO_POLL_MS  (default 10000)
 *   SPARKDASH_CLOCK_AUTO_DWELL_MS (default 60000)
 */
import {
  AUTO_CAPS,
  AUTO_MODE_REL_PATH,
  CLOCK_CAP_PRESETS,
  applyCapCommand,
  autoTickCommand,
  parseAutoCap,
  parseTempC,
  removeMarkerCommand,
  resolveCapStatus,
  revertCapCommand,
  runOnSpark,
  splitStatusSections,
  statusCommand,
  writeAutoModeCommand,
  writeMarkerCommand,
} from "./clockCap.js";

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Default controller configuration (env-overridable, clamped to sane bounds). */
export function defaultConfig() {
  const highC = numEnv("SPARKDASH_CLOCK_AUTO_HIGH_C", 72);
  const lowC = numEnv("SPARKDASH_CLOCK_AUTO_LOW_C", 67);
  return {
    /** Step down at/above this GPU temperature (°C). */
    highC,
    /** Step up at/below this GPU temperature (°C). */
    lowC,
    /** Dwell-skipping fast path: still rising at/above this → step down now. */
    hotC: numEnv("SPARKDASH_CLOCK_AUTO_HOT_C", highC + 5),
    /** ms between controller ticks per node. */
    pollMs: Math.max(1000, numEnv("SPARKDASH_CLOCK_AUTO_POLL_MS", 10_000)),
    /** Minimum ms between applied steps on one node. */
    dwellMs: Math.max(0, numEnv("SPARKDASH_CLOCK_AUTO_DWELL_MS", 60_000)),
    /** Cap applied when Auto starts and no in-band cap is present. */
    startCap: 2000,
    /** Step-log length kept per node for the UI. */
    logMax: 20,
    /** ms between failure events for one node (the state is always shown). */
    failureEventMs: 5 * 60_000,
  };
}

/**
 * Pure hysteresis decision for one node. Returns "down", "up" or null (hold).
 * @param {{
 *   tempC: number | null, prevTempC: number | null, cap: number,
 *   lastStepAt: number, now: number,
 *   highC: number, lowC: number, hotC: number, dwellMs: number,
 * }} p
 */
export function decideAutoStep({ tempC, prevTempC, cap, lastStepAt, now, highC, lowC, hotC, dwellMs }) {
  if (!Number.isFinite(tempC) || !AUTO_CAPS.includes(cap)) return null;
  const canDown = cap > AUTO_CAPS[0];
  const canUp = cap < AUTO_CAPS[AUTO_CAPS.length - 1];
  // Hot fast path: still rising well above HIGH_C — skip the dwell.
  const rising = prevTempC == null || tempC >= prevTempC;
  if (tempC >= hotC && rising) return canDown ? "down" : null;
  if (now - lastStepAt < dwellMs) return null;
  if (tempC >= highC) return canDown ? "down" : null;
  if (tempC <= lowC) return canUp ? "up" : null;
  return null;
}

/** Next cap one 100 MHz step in `dir`, clamped to the 1800–2200 band. */
export function stepAutoCap(cap, dir) {
  const i = AUTO_CAPS.indexOf(cap);
  if (i === -1) return parseAutoCap(cap);
  const next = dir === "down" ? AUTO_CAPS[i - 1] : AUTO_CAPS[i + 1];
  return next ?? cap;
}

/** Parse an autoTickCommand() reply: mode file, then the four status sections. */
export function parseTickOutput(text) {
  const parts = String(text ?? "").split("---");
  return {
    auto: /^\s*auto\b/.test(parts[0] ?? ""),
    marker: parts[1] ?? "",
    bootId: parts[2] ?? "",
    clocks: parts[3] ?? "",
    temp: parts[4] ?? "",
  };
}

function emptyNodeState() {
  return {
    enabled: false,
    cap: null,
    lastStepAt: 0,
    prevTempC: null,
    lastTempC: null,
    log: [],
    lastError: null,
    lastFailureEventAt: 0,
    busy: false,
  };
}

/**
 * Temperature-driven clock-cap controller. `run` is injectable so tests can
 * feed fake temps and canned command replies (no hardware needed); it defaults
 * to the same runOnSpark path the manual presets use.
 */
export class ClockCapAutoController {
  /**
   * @param {{
   *   config?: Partial<ReturnType<typeof defaultConfig>>,
   *   run?: (spark: unknown, cmd: string) => Promise<string>,
   *   now?: () => number,
   *   onEvent?: (event: { type: string, severity: string, sparkId: string, sparkName: string, message: string }) => void,
   * }} opts
   */
  constructor({ config = {}, run, now = Date.now, onEvent = null } = {}) {
    this.cfg = { ...defaultConfig(), ...config };
    this._run = run ?? ((spark, cmd) => runOnSpark(spark, cmd));
    this._now = now;
    this._onEvent = onEvent;
    this._timer = null;
    /** @type {Map<string, ReturnType<typeof emptyNodeState>>} */
    this._state = new Map();
    /**
     * Fleet-wide clock-cap target persisted in settings (SPARK-11). When set
     * to a fixed MHz or "unlocked", every tick also reconciles nodes that are
     * NOT in Auto, so a reboot / out-of-band -rgc cannot silently undo the
     * fleet cap. null or { mode: "auto" } = reconcile off (Auto nodes manage
     * themselves through tick()).
     * @type {{ mode: "auto" | "fixed" | "unlocked", mhz: number | null } | null}
     */
    this._fleetTarget = null;
    /** Per-node reconcile bookkeeping: busy flag + last reapply attempt. */
    this._reconcile = new Map();
  }

  /** The current fleet-wide target, or null. */
  get fleetTarget() {
    return this._fleetTarget;
  }

  /**
   * Set the fleet-wide target (SPARK-11). Only the three validated shapes are
   * accepted — anything else clears the target and turns reconcile off.
   * @param {{ mode?: string, mhz?: unknown } | null | undefined} target
   */
  setFleetTarget(target) {
    if (!target || typeof target !== "object") {
      this._fleetTarget = null;
      return;
    }
    if (target.mode === "auto") {
      this._fleetTarget = { mode: "auto", mhz: null };
    } else if (target.mode === "unlocked") {
      this._fleetTarget = { mode: "unlocked", mhz: null };
    } else if (target.mode === "fixed" && Number.isInteger(target.mhz) && CLOCK_CAP_PRESETS.includes(target.mhz)) {
      this._fleetTarget = { mode: "fixed", mhz: target.mhz };
    } else {
      this._fleetTarget = null;
    }
  }

  _event(type, severity, spark, message) {
    if (!this._onEvent) return;
    try {
      this._onEvent({ type, severity, sparkId: spark.id, sparkName: spark.name || spark.id, message });
    } catch {
      /* event sinks must never break the loop */
    }
  }

  /** Whether the controller is managing this node right now. */
  isEnabled(sparkId) {
    return this._state.get(sparkId)?.enabled === true;
  }

  /** Public per-node Auto state for the API/UI, or null when Auto is off. */
  publicState(sparkId) {
    const s = this._state.get(sparkId);
    if (!s || !s.enabled) return null;
    return {
      enabled: true,
      cap: s.cap,
      lastTempC: s.lastTempC,
      lastStep: s.log[0] ?? null,
      log: s.log.map((e) => ({ ...e })),
      lastError: s.lastError,
    };
  }

  /**
   * Apply `cap`, write the marker, and verify the marker landed. Throws on
   * failure — the caller leaves the last cap in place.
   */
  async _applyCap(spark, s, cap, tempC, dir, { log = true } = {}) {
    const next = parseAutoCap(cap);
    await this._run(spark, `${applyCapCommand(next)} 2>&1 && ${writeMarkerCommand(next)}`);
    // Marker must match the applied cap; a failed write is an error, not a
    // silent mismatch the UI would show as stock.
    const text = await this._run(spark, statusCommand());
    const sec = splitStatusSections(text);
    const status = resolveCapStatus(sec.marker, sec.bootId, sec.clocks);
    if (status.mhz !== next) {
      throw new Error(
        `Auto cap ${next} MHz did not land (marker shows ${status.mhz ?? "nothing"})`
      );
    }
    const from = s.cap;
    s.cap = next;
    s.lastStepAt = this._now();
    s.lastError = null;
    if (log) {
      s.log.unshift({ at: s.lastStepAt, from, to: next, tempC, dir });
      if (s.log.length > this.cfg.logMax) s.log.length = this.cfg.logMax;
    }
    this._event(
      dir === "resume" ? "gpu.clockcap.auto.resumed" : "gpu.clockcap.auto.step",
      "info",
      spark,
      dir === "resume"
        ? `Auto clock cap resumed at ${next} MHz on ${spark.name || spark.id}`
        : `Auto clock cap ${dir} ${from ?? "?"} → ${next} MHz at ${tempC ?? "?"} °C on ${spark.name || spark.id}`
    );
  }

  _recordFailure(spark, s, err) {
    const msg = String(err?.message || err).split("\n")[0].slice(0, 200);
    s.lastError = msg;
    const now = this._now();
    // Log every failure in the state (UI), but throttle the fleet event log —
    // an offline node would otherwise spam one event per 10 s tick.
    if (now - s.lastFailureEventAt >= this.cfg.failureEventMs) {
      s.lastFailureEventAt = now;
      this._event("gpu.clockcap.auto.failed", "error", spark, `Auto clock cap failed on ${spark.name || spark.id}: ${msg}`);
    }
  }

  /**
   * Turn Auto on for a node: apply the start cap if the current one is not in
   * the 1800–2200 band, write the mode marker, adopt the state.
   */
  async enable(spark) {
    const text = await this._run(spark, autoTickCommand());
    const t = parseTickOutput(text);
    const status = resolveCapStatus(t.marker, t.bootId, t.clocks);
    const tempC = parseTempC(t.temp);
    const cap = AUTO_CAPS.includes(status.mhz) ? status.mhz : this.cfg.startCap;
    const s = emptyNodeState();
    s.enabled = true;
    s.cap = cap;
    s.lastTempC = tempC;
    s.prevTempC = tempC;
    if (status.mhz !== cap) {
      await this._applyCap(spark, s, cap, tempC, "resume", { log: false });
    }
    await this._run(spark, writeAutoModeCommand());
    this._state.set(spark.id, s);
    this._event("gpu.clockcap.auto.enabled", "info", spark, `Auto clock cap enabled on ${spark.name || spark.id} (1800–2200 MHz, step from ${cap} MHz)`);
    return { ok: true, cap, tempC, graphicsClockMHz: status.graphicsClockMHz };
  }

  /** Turn Auto off for a node (a preset / Unlocked choice takes over). */
  async disable(spark) {
    await this._run(spark, `rm -f ~/${AUTO_MODE_REL_PATH}`);
    const s = this._state.get(spark.id);
    if (s) {
      s.enabled = false;
      this._state.delete(spark.id);
    }
    this._event("gpu.clockcap.auto.disabled", "info", spark, `Auto clock cap disabled on ${spark.name || spark.id}`);
    return { ok: true };
  }

  /**
   * One controller tick for a node: read mode + marker + boot_id + clocks +
   * temp in a single round trip, then step (or re-adopt after a backend
   * restart / Spark reboot). No-ops when the node is not in Auto — including
   * when the mode file disappeared, which turns Auto off.
   */
  async tick(spark) {
    const s = this._state.get(spark.id);
    if (!s?.enabled || s.busy) return;
    s.busy = true;
    try {
      const text = await this._run(spark, autoTickCommand());
      const t = parseTickOutput(text);
      if (!t.auto) {
        // Mode file gone (removed out-of-band) → Auto is off.
        s.enabled = false;
        this._state.delete(spark.id);
        return;
      }
      const status = resolveCapStatus(t.marker, t.bootId, t.clocks);
      const tempC = parseTempC(t.temp);
      s.lastTempC = tempC;
      if (status.stale) {
        // Spark rebooted: the cap (and its boot_id) is gone. Auto is still on
        // (the mode file survives — it has no boot_id), so re-apply.
        await this._applyCap(spark, s, this.cfg.startCap, tempC, "resume", { log: false });
        s.prevTempC = tempC;
        return;
      }
      if (!AUTO_CAPS.includes(s.cap)) {
        // Backend restarted (or first tick after discover): adopt the current
        // cap when it is in band, else apply the start cap.
        const cap = AUTO_CAPS.includes(status.mhz) ? status.mhz : this.cfg.startCap;
        if (cap !== status.mhz) {
          await this._applyCap(spark, s, cap, tempC, "resume", { log: false });
        } else {
          s.cap = cap;
        }
        s.prevTempC = tempC;
        return;
      }
      const dir = decideAutoStep({
        tempC,
        prevTempC: s.prevTempC,
        cap: s.cap,
        lastStepAt: s.lastStepAt,
        now: this._now(),
        highC: this.cfg.highC,
        lowC: this.cfg.lowC,
        hotC: this.cfg.hotC,
        dwellMs: this.cfg.dwellMs,
      });
      s.prevTempC = tempC;
      if (!dir) {
        s.lastError = null;
        return;
      }
      await this._applyCap(spark, s, stepAutoCap(s.cap, dir), tempC, dir);
    } catch (err) {
      // Leave the last cap in place; surface the failure instead of failing
      // silently.
      this._recordFailure(spark, s, err);
    } finally {
      s.busy = false;
    }
  }

  /**
   * One reconcile pass for a node that is NOT in Auto (SPARK-11): with a
   * fleet-wide target persisted in settings, reapplies the cap whenever the
   * node's live status drifted — a stale marker after a reboot, an
   * out-of-band `nvidia-smi -rgc`, or a marker MHz that no longer matches the
   * target. Records a `gpu.clockcap.reapplied` event. No-ops when there is no
   * fixed/unlocked fleet target; Auto nodes are handled by tick().
   * @param {unknown} spark registry entry (id, name, isLocal, ssh)
   */
  async reconcileTick(spark) {
    const target = this._fleetTarget;
    if (!target || target.mode === "auto") return;
    if (this.isEnabled(spark.id)) return; // Auto owns this node's cap.
    let rc = this._reconcile.get(spark.id);
    if (!rc) {
      rc = { busy: false, lastAttemptAt: 0, lastError: null, lastFailureEventAt: 0 };
      this._reconcile.set(spark.id, rc);
    }
    if (rc.busy) return;
    // Don't hammer an unreachable node once per tick: after a failed reapply,
    // wait out the dwell before trying again (a successful reapply fixes the
    // drift, so the next tick sees no drift and stops here anyway).
    if (rc.lastAttemptAt && this._now() - rc.lastAttemptAt < this.cfg.dwellMs) return;
    rc.busy = true;
    try {
      const text = await this._run(spark, statusCommand());
      const sec = splitStatusSections(text);
      const status = resolveCapStatus(sec.marker, sec.bootId, sec.clocks);
      const drifted =
        target.mode === "unlocked" ? status.mhz != null : status.mhz !== target.mhz;
      if (!drifted) {
        rc.lastAttemptAt = 0;
        return;
      }
      rc.lastAttemptAt = this._now();
      const reason = status.stale
        ? "stale marker (reboot)"
        : status.mhz == null
          ? "cap missing"
          : `cap ${status.mhz} MHz`;
      if (target.mode === "unlocked") {
        await this._run(
          spark,
          `${revertCapCommand()} 2>&1; ${removeMarkerCommand()}`
        );
      } else {
        await this._run(
          spark,
          `${applyCapCommand(target.mhz)} 2>&1; ${writeMarkerCommand(target.mhz)}`
        );
      }
      // Verify the reapply actually landed; a failed marker write must not
      // report success (the next tick will retry).
      const vtext = await this._run(spark, statusCommand());
      const vsec = splitStatusSections(vtext);
      const vstatus = resolveCapStatus(vsec.marker, vsec.bootId, vsec.clocks);
      if (target.mode === "fixed" && vstatus.mhz !== target.mhz) {
        throw new Error(
          `Reapplied cap ${target.mhz} MHz did not land (marker shows ${vstatus.mhz ?? "nothing"})`
        );
      }
      if (target.mode === "unlocked" && vstatus.mhz != null) {
        throw new Error("Revert did not land — a clock cap is still applied");
      }
      rc.lastAttemptAt = 0;
      this._event(
        "gpu.clockcap.reapplied",
        "info",
        spark,
        `Clock cap ${
          target.mode === "unlocked" ? "Unlocked" : `${target.mhz} MHz`
        } reapplied on ${spark.name || spark.id} (drift: ${reason})`
      );
    } catch (err) {
      this._recordFailure(spark, rc, err);
    } finally {
      rc.busy = false;
    }
  }

  /**
   * Re-adopt nodes that are still in Auto after a backend restart: read each
   * node's mode file once; a stale cap is repaired on the node's next tick.
   */
  async discover(sparks) {
    for (const spark of sparks) {
      try {
        const text = await this._run(spark, `cat ~/${AUTO_MODE_REL_PATH} 2>/dev/null`);
        if (!/^\s*auto\b/.test(text)) continue;
        const s = emptyNodeState();
        s.enabled = true;
        this._state.set(spark.id, s);
        this._event("gpu.clockcap.auto.resumed", "info", spark, `Auto clock cap still enabled on ${spark.name || spark.id} after restart`);
      } catch {
        /* unreachable node — retried on later discovery/ticks */
      }
    }
  }

  /** Start the background loop over all Auto nodes + fleet reconcile. */
  start(registry) {
    if (this._timer) return;
    void this.discover(registry.sparks);
    this._timer = setInterval(() => {
      for (const spark of registry.sparks) {
        if (this.isEnabled(spark.id)) void this.tick(spark);
        else void this.reconcileTick(spark);
      }
    }, this.cfg.pollMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
