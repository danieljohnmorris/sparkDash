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
  parseClockCap,
  parseTempC,
  resolveCapStatus,
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

  /** Start the background loop over all Auto nodes. */
  start(registry) {
    if (this._timer) return;
    void this.discover(registry.sparks);
    this._timer = setInterval(() => {
      for (const spark of registry.sparks) {
        if (this.isEnabled(spark.id)) void this.tick(spark);
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

/**
 * Fleet-wide GPU clock-cap auto mode (SPARK-7).
 * Coexists with ClockCapAutoController (SPARK-6 per-node Auto).
 * Caps for the fleet controller are validated by parseFleetAutoCap.
 */
export const AUTO_RANGE = Object.freeze({ min: 1800, max: 2200 });

/** Presets the auto cap may be set to (the clock-cap presets inside the range). */
export const AUTO_CAP_PRESETS = Object.freeze(
  CLOCK_CAP_PRESETS.filter((mhz) => mhz >= AUTO_RANGE.min && mhz <= AUTO_RANGE.max)
);

/** Hold the cap at or above this GPU temperature (°C). */
export const AUTO_HOLD_TEMP_C = 72;

/** Release the cap at or below this GPU temperature (°C). */
export const AUTO_RELEASE_TEMP_C = 67;

/** Default cap applied while holding. */
export const DEFAULT_AUTO_CAP_MHZ = 1800;

/** How often the controller samples temperatures. */
export const AUTO_POLL_MS = 5000;

/** Validate an auto cap: an exact preset that also sits inside the auto range. */
export function parseFleetAutoCap(raw) {
  const mhz = parseClockCap(raw);
  if (mhz < AUTO_RANGE.min || mhz > AUTO_RANGE.max) {
    throw new Error(
      `Auto cap must be between ${AUTO_RANGE.min} and ${AUTO_RANGE.max} MHz`
    );
  }
  return mhz;
}

export class FleetClockAuto {
  /**
   * @param {object} deps
   * @param {() => Array<{ id: string, name: string }>} deps.sparks Fleet snapshot, read fresh each tick.
   * @param {(spark: { id: string }) => number | null} deps.readTemp
   *   GPU temperature in °C, or null when the node is offline / has no fresh reading.
   * @param {(spark: { id: string }) => Promise<{ mhz: number | null }>} deps.readStatus
   *   Current cap status, used to adopt existing caps when auto is enabled.
   * @param {(spark: { id: string }, mhz: number) => Promise<unknown>} deps.apply Same signature as clockCap.applyClockCap.
   * @param {(spark: { id: string }) => Promise<unknown>} deps.revert Same signature as clockCap.revertClockCap.
   * @param {(event: object) => unknown} deps.recordEvent
   */
  constructor({ sparks, readTemp, readStatus, apply, revert, recordEvent }) {
    this._sparks = sparks;
    this._readTemp = readTemp;
    this._readStatus = readStatus;
    this._apply = apply;
    this._revert = revert;
    this._recordEvent = recordEvent;
    this._timer = null;
    this._ticking = false;
    this._enabled = false;
    this._capMhz = DEFAULT_AUTO_CAP_MHZ;
    /** Per-spark auto ownership: true while auto is holding a cap on that node. */
    this._holding = new Map();
    /** Last per-spark tick error, surfaced in status until the next success. */
    this._lastError = new Map();
  }

  /** Current controller state for the API/UI. */
  status() {
    return {
      enabled: this._enabled,
      capMhz: this._capMhz,
      holdTempC: AUTO_HOLD_TEMP_C,
      releaseTempC: AUTO_RELEASE_TEMP_C,
      range: { ...AUTO_RANGE },
      presets: [...AUTO_CAP_PRESETS],
      sparks: this._sparks().map((spark) => ({
        id: spark.id,
        name: spark.name,
        holding: this._holding.get(spark.id) === true,
        lastError: this._lastError.get(spark.id) ?? null,
      })),
    };
  }

  /**
   * Enable/disable fleet auto mode. When enabling with a capMhz, the value is
   * validated first so an invalid cap never flips the mode on. Existing caps
   * are adopted (best effort) so auto releases exactly what it holds.
   */
  async setEnabled(enabled, capMhz) {
    if (capMhz !== undefined) this._capMhz = parseFleetAutoCap(capMhz);
    this._enabled = Boolean(enabled);
    if (this._enabled) {
      await this._adoptExistingCaps();
      this._ensureTimer();
    } else {
      this._stopTimer();
      this._holding.clear();
      this._lastError.clear();
    }
    return this.status();
  }

  /** Start the tick loop if enabled (no-op otherwise). Safe to call twice. */
  start() {
    if (this._enabled) this._ensureTimer();
  }

  stop() {
    this._stopTimer();
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => void this.tick(), AUTO_POLL_MS);
    this._timer.unref?.();
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Seed per-node holding state from the current marker on each node. */
  async _adoptExistingCaps() {
    const results = await Promise.allSettled(
      this._sparks().map(async (spark) => {
        try {
          const status = await this._readStatus(spark);
          this._holding.set(spark.id, status.mhz != null);
          this._lastError.delete(spark.id);
        } catch {
          // Unreachable node at enable time: start unowned; the tick will
          // apply a cap if the node comes back hot.
          this._holding.set(spark.id, false);
        }
      })
    );
    return results;
  }

  /** One sampling pass. Overlapping ticks (slow SSH) are skipped, not queued. */
  async tick() {
    if (!this._enabled || this._ticking) return;
    this._ticking = true;
    try {
      await Promise.allSettled(
        this._sparks().map((spark) => this._tickSpark(spark))
      );
    } finally {
      this._ticking = false;
    }
  }

  async _tickSpark(spark) {
    const temp = this._readTemp(spark);
    if (!Number.isFinite(temp)) return; // offline or no fresh reading — hold state
    const name = spark.name || spark.id;
    try {
      if (temp >= AUTO_HOLD_TEMP_C && this._holding.get(spark.id) !== true) {
        await this._apply(spark, this._capMhz);
        this._holding.set(spark.id, true);
        this._lastError.delete(spark.id);
        this._recordEvent({
          type: "gpu.clockcap.auto.applied",
          severity: "info",
          sparkId: spark.id,
          sparkName: spark.name,
          message: `Auto: capped ${name} at ${this._capMhz} MHz (GPU ${Math.round(temp)}°C ≥ ${AUTO_HOLD_TEMP_C}°C)`,
        });
      } else if (temp <= AUTO_RELEASE_TEMP_C && this._holding.get(spark.id) === true) {
        await this._revert(spark);
        this._holding.set(spark.id, false);
        this._lastError.delete(spark.id);
        this._recordEvent({
          type: "gpu.clockcap.auto.released",
          severity: "info",
          sparkId: spark.id,
          sparkName: spark.name,
          message: `Auto: released clock cap on ${name} (GPU ${Math.round(temp)}°C ≤ ${AUTO_RELEASE_TEMP_C}°C)`,
        });
      }
    } catch (err) {
      const msg = (err?.message || String(err)).split("\n")[0].slice(0, 160);
      this._lastError.set(spark.id, msg);
      this._recordEvent({
        type: "gpu.clockcap.auto.failed",
        severity: "error",
        sparkId: spark.id,
        sparkName: spark.name,
        message: `Auto clock cap failed on ${name}: ${msg}`,
      });
    }
  }
}
