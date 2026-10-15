import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { fetchClockCap, setClockCap, setClockCapMode } from "../../api/client";
import type { ClockCapAutoStep, ClockCapResult, ClockCapSparkStatus } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { GaugeIcon, RotateIcon, ThermometerIcon, XIcon } from "../ui/icons";

/** Preset caps in MHz (1800–2400 every 50 MHz). The server rejects anything outside this exact list. */
const PRESETS = [
  1800, 1850, 1900, 1950, 2000, 2050, 2100, 2150, 2200, 2250, 2300, 2350, 2400,
];

/** Auto mode steps within this band only (SPARK-6). */
const AUTO_BAND = [1800, 2200] as const;

/** Render an Auto step the way the spec shows it: "↓ 2000 → 1900 at 19:42, 71 °C". */
function formatStep(s: ClockCapAutoStep): string {
  const arrow = s.dir === "down" ? "↓" : "↑";
  const time = new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const temp = s.tempC != null ? `, ${Math.round(s.tempC)} °C` : "";
  return `${arrow} ${s.from ?? "stock"} → ${s.to} at ${time}${temp}`;
}

interface ClockCapPanelProps {
  sparkId: string;
  sparkName: string;
  /** Every registered spark — used to name targets in the confirm dialog. */
  fleet?: { id: string; name: string }[];
}

interface Target {
  ids: string[] | "all";
  label: string;
}

function useEscape(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, onClose]);
}

/** One node's status line: cap from the marker, graphics clock live from nvidia-smi. */
function CapStatusLine({ status }: { status: ClockCapSparkStatus | undefined }) {
  if (!status) return <span className="text-xs text-muted">Loading cap status…</span>;
  if (!status.ok) {
    return (
      <span className="text-xs text-muted" title={status.error}>
        Cap status unavailable{status.error ? ` — ${status.error}` : ""}
      </span>
    );
  }
  const graphics =
    status.graphicsClockMHz != null ? `${status.graphicsClockMHz} MHz` : "—";
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-muted">Cap</span>
      <Tag tone={status.mhz != null ? "acc" : "neutral"}>
        {status.mhz != null ? `${status.mhz} MHz` : "Uncapped"}
      </Tag>
      {status.auto?.enabled ? (
        <Tag tone="good" title={`Auto: steps 100 MHz between ${AUTO_BAND[0]} and ${AUTO_BAND[1]} MHz by GPU temperature (step down at 72 °C, back up at 67 °C)`}>
          Auto
        </Tag>
      ) : null}
      {status.stale && status.markerMhz != null ? (
        <Tag tone="warn" title={`A ${status.markerMhz} MHz cap marker from an earlier boot is stale; the reboot cleared it.`}>
          stale
        </Tag>
      ) : null}
      <span className="text-muted">Graphics</span>
      <span className="mono">{graphics}</span>
      <span className="text-muted">Temp</span>
      <span className="mono">{status.tempC != null ? `${Math.round(status.tempC)} °C` : "—"}</span>
    </span>
  );
}

export function ClockCapPanel({ sparkId, sparkName, fleet = [] }: ClockCapPanelProps) {
  const [statuses, setStatuses] = useState<ClockCapSparkStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allSparks, setAllSparks] = useState<"this" | "all">("this");
  const [pendingMhz, setPendingMhz] = useState<number | null | undefined>(undefined);
  const [pendingAuto, setPendingAuto] = useState(false);
  const [applying, setApplying] = useState(false);
  const [failures, setFailures] = useState<ClockCapResult[]>([]);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(pendingMhz !== undefined);
  const trapRef = useFocusTrap(mounted);
  const autoTitleId = useId();
  const { mounted: autoMounted, visible: autoVisible } = useModalPresence(pendingAuto);
  const autoTrapRef = useFocusTrap(autoMounted);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchClockCap();
      setStatuses(res.sparks ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEscape(pendingMhz !== undefined && !applying, () => setPendingMhz(undefined));
  useEscape(pendingAuto && !applying, () => setPendingAuto(false));

  const byId = new Map(statuses.map((s) => [s.id, s]));
  const current = byId.get(sparkId);

  const nameOf = useCallback(
    (id: string) =>
      byId.get(id)?.name || fleet.find((s) => s.id === id)?.name || id,
    [byId, fleet]
  );

  const targets: Target =
    allSparks === "all"
      ? {
          ids: "all",
          label: statuses.length
            ? statuses.map((s) => s.name || s.id).join(", ")
            : "every registered Spark",
        }
      : { ids: [sparkId], label: nameOf(sparkId) || sparkName };

  const confirmLabel =
    pendingMhz === null ? "Uncapped — confirm" : `Set ${pendingMhz} MHz`;

  const handleApply = async () => {
    if (pendingMhz === undefined) return;
    setApplying(true);
    setFailures([]);
    try {
      const res = await setClockCap(targets.ids, pendingMhz);
      const ok = res.results.filter((r) => r.ok);
      const failed = res.results.filter((r) => !r.ok);
      // Fold per-node results into the status list — the response carries the
      // fresh marker state and the live graphics clock, so the panel updates
      // without waiting for the next manual refresh.
      setStatuses((prev) => {
        const map = new Map(prev.map((s) => [s.id, s]));
        for (const r of ok) {
          map.set(r.id, {
            id: r.id,
            name: r.name,
            ok: true,
            mhz: r.mhz ?? null,
            stale: r.stale ?? false,
            graphicsClockMHz: r.graphicsClockMHz ?? null,
          });
        }
        for (const r of failed) {
          const existing = map.get(r.id);
          map.set(r.id, {
            id: r.id,
            name: r.name,
            ok: existing?.ok ?? false,
            mhz: existing?.mhz ?? null,
            stale: existing?.stale ?? false,
            graphicsClockMHz: existing?.graphicsClockMHz ?? null,
            error: r.error,
          });
        }
        return [...map.values()];
      });
      if (failed.length > 0) {
        setFailures(failed);
      } else {
        setPendingMhz(undefined);
      }
    } catch (err) {
      setFailures([
        {
          id: targets.ids === "all" ? "all" : targets.ids[0],
          name: targets.label,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      ]);
    } finally {
      setApplying(false);
    }
  };

  const handleEnableAuto = async () => {
    setApplying(true);
    setFailures([]);
    try {
      const res = await setClockCapMode(targets.ids, "auto");
      const ok = res.results.filter((r) => r.ok);
      const failed = res.results.filter((r) => !r.ok);
      // Fold the enable results in: the response carries the cap Auto starts
      // from, so the badge/step view updates without a full refresh.
      setStatuses((prev) => {
        const map = new Map(prev.map((s) => [s.id, s]));
        for (const r of ok) {
          const existing = map.get(r.id);
          map.set(r.id, {
            id: r.id,
            name: r.name,
            ok: true,
            mhz: r.cap ?? existing?.mhz ?? null,
            stale: existing?.stale ?? false,
            graphicsClockMHz: r.graphicsClockMHz ?? existing?.graphicsClockMHz ?? null,
            tempC: r.tempC ?? existing?.tempC ?? null,
            auto: {
              enabled: true,
              cap: r.cap ?? null,
              lastTempC: r.tempC ?? null,
              lastStep: null,
              log: [],
              lastError: null,
            },
          });
        }
        for (const r of failed) {
          const existing = map.get(r.id);
          map.set(r.id, {
            id: r.id,
            name: r.name,
            ok: existing?.ok ?? false,
            mhz: existing?.mhz ?? null,
            stale: existing?.stale ?? false,
            graphicsClockMHz: existing?.graphicsClockMHz ?? null,
            auto: existing?.auto ?? null,
            error: r.error,
          });
        }
        return [...map.values()];
      });
      if (failed.length > 0) {
        setFailures(failed);
      } else {
        setPendingAuto(false);
      }
    } catch (err) {
      setFailures([
        {
          id: targets.ids === "all" ? "all" : targets.ids[0],
          name: targets.label,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      ]);
    } finally {
      setApplying(false);
    }
  };

  const capButton = (mhz: number | null) => (
    <button
      key={mhz === null ? "unlocked" : mhz}
      type="button"
      disabled={applying || loading}
      onClick={() => setPendingMhz(mhz)}
      title={
        mhz === null
          ? "Remove the cap (nvidia-smi -rgc) and delete the marker"
          : `Apply a ${mhz} MHz clock cap on the selected target`
      }
    >
      {mhz === null ? "Uncapped" : mhz}
    </button>
  );

  return (
    <Panel
      title="GPU clock cap"
      icon={<GaugeIcon className="h-3.5 w-3.5 text-muted" />}
      hint="Caps the GPU graphics clock via nvidia-smi -lgc; Uncapped reverts to stock (-rgc). A reboot clears the cap."
      actions={
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void refresh()}
          disabled={loading || applying}
        >
          <RotateIcon className={`h-3 w-3${loading ? " animate-spin" : ""}`} />
          Refresh
        </button>
      }
    >
      <div className="sp-cap">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CapStatusLine status={current} />
          {loading && !current ? (
            <RotateIcon className="h-3.5 w-3.5 animate-spin text-muted" />
          ) : null}
        </div>

        {loadError ? (
          <p className="text-xs text-muted">Couldn't load cap status: {loadError}</p>
        ) : null}

        {failures.length > 0 ? (
          <div className="danger-box" role="alert">
            <b>Clock cap failed</b>
            <ul>
              {failures.map((f) => (
                <li key={`${f.id}-${f.error}`}>
                  {(nameOf(f.id) !== f.id ? nameOf(f.id) : f.name) || f.id}
                  {f.error ? `: ${f.error}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="sp-cap__row">
          <div className="seg" role="group" aria-label="Clock cap target">
            <button
              type="button"
              className={allSparks === "this" ? "is-on" : ""}
              aria-pressed={allSparks === "this"}
              disabled={applying}
              onClick={() => setAllSparks("this")}
            >
              This Spark
            </button>
            <button
              type="button"
              className={allSparks === "all" ? "is-on" : ""}
              aria-pressed={allSparks === "all"}
              disabled={applying}
              onClick={() => setAllSparks("all")}
            >
              All Sparks
            </button>
          </div>
        </div>

        <div className="sp-cap__row">
          <div className="seg sp-cap__presets" role="group" aria-label="Clock cap preset">
            {PRESETS.map((mhz) => capButton(mhz))}
            {capButton(null)}
          </div>
        </div>

        <div className="sp-cap__row">
          <button
            type="button"
            className={`btn btn--sm${current?.auto?.enabled ? " btn--primary" : " btn--ghost"}`}
            disabled={applying || loading}
            onClick={() => setPendingAuto(true)}
            title={`Auto: steps the cap 100 MHz between ${AUTO_BAND[0]} and ${AUTO_BAND[1]} MHz — down at ≥ 72 °C, back up at ≤ 67 °C`}
          >
            <ThermometerIcon className="h-3 w-3" />
            Auto {AUTO_BAND[0]}–{AUTO_BAND[1]}
          </button>
          {current?.auto?.enabled ? (
            <span className="text-xs text-muted">
              Auto cap {current.auto.cap != null ? <span className="mono">{current.auto.cap} MHz</span> : "…"}
              {current.auto.lastTempC != null ? <> · last {Math.round(current.auto.lastTempC)} °C</> : null}
            </span>
          ) : null}
        </div>

        {current?.auto?.enabled ? (
          <div className="sp-cap__auto">
            {current.auto.lastStep ? (
              <div className="sp-cap__auto-last text-xs">
                Last step <span className="mono">{formatStep(current.auto.lastStep)}</span>
              </div>
            ) : (
              <div className="sp-cap__auto-last text-xs text-muted">
                No steps yet — holds the cap until the GPU crosses 72 °C / 67 °C.
              </div>
            )}
            {current.auto.lastError ? (
              <p className="text-xs" role="alert">
                Auto error: {current.auto.lastError}
              </p>
            ) : null}
            {current.auto.log.length > 0 ? (
              <ul className="sp-cap__auto-log">
                {current.auto.log.map((s) => (
                  <li key={`${s.at}-${s.to}`} className="mono">
                    {formatStep(s)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {mounted
        ? createPortal(
            <div
              className={`modal-overlay${visible ? " is-open" : ""}`}
              onClick={(e) => {
                if (applying) return;
                if (e.target === e.currentTarget) setPendingMhz(undefined);
              }}
            >
              <div
                ref={trapRef}
                className="modal-sheet modal-sheet--narrow"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
              >
                <div className="modal-sheet__header">
                  <div className="modal-sheet__heading">
                    <h2 className="modal-sheet__title" id={titleId}>
                      <GaugeIcon className="h-4 w-4 shrink-0 text-accent" />
                      {pendingMhz === null ? "Remove clock cap" : "Apply clock cap"}
                    </h2>
                    <p className="modal-sheet__sub">
                      {pendingMhz === null
                        ? "Uncapped — revert to stock clocks"
                        : `${pendingMhz} MHz graphics clock cap`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="modal-sheet__close"
                    onClick={() => setPendingMhz(undefined)}
                    disabled={applying}
                    aria-label="Close"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </div>

                <div className="modal-sheet__body modal-sheet__stack">
                  <p className="modal-sheet__lead">
                    {pendingMhz === null
                      ? "Remove the clock cap and delete the marker on:"
                      : "Set the graphics clock cap to"}{" "}
                    <b>{targets.label}</b>
                    {pendingMhz != null ? <> to <b className="mono">{pendingMhz} MHz</b></> : null}?
                  </p>
                  <p className="text-xs text-muted">
                    Runs nvidia-smi{" "}
                    {pendingMhz === null ? "-rgc" : `-lgc 0,${pendingMhz}`} on{" "}
                    {targets.ids === "all" ? "every Spark" : "the selected Spark"} over SSH. The
                    cap clears on reboot.
                  </p>
                </div>

                <div className="modal-sheet__footer">
                  <div className="modal-sheet__footer-actions">
                    <button
                      type="button"
                      onClick={() => setPendingMhz(undefined)}
                      disabled={applying}
                      className="btn btn--ghost"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleApply()}
                      disabled={applying}
                      className="btn btn--primary"
                    >
                      {applying ? <RotateIcon className="h-3.5 w-3.5 animate-spin" /> : null}
                      {applying ? "Applying…" : confirmLabel}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {autoMounted
        ? createPortal(
            <div
              className={`modal-overlay${autoVisible ? " is-open" : ""}`}
              onClick={(e) => {
                if (applying) return;
                if (e.target === e.currentTarget) setPendingAuto(false);
              }}
            >
              <div
                ref={autoTrapRef}
                className="modal-sheet modal-sheet--narrow"
                role="dialog"
                aria-modal="true"
                aria-labelledby={autoTitleId}
              >
                <div className="modal-sheet__header">
                  <div className="modal-sheet__heading">
                    <h2 className="modal-sheet__title" id={autoTitleId}>
                      <ThermometerIcon className="h-4 w-4 shrink-0 text-accent" />
                      Auto clock cap
                    </h2>
                    <p className="modal-sheet__sub">
                      Temperature-driven {AUTO_BAND[0]}–{AUTO_BAND[1]} MHz
                    </p>
                  </div>
                  <button
                    type="button"
                    className="modal-sheet__close"
                    onClick={() => setPendingAuto(false)}
                    disabled={applying}
                    aria-label="Close"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </div>

                <div className="modal-sheet__body modal-sheet__stack">
                  <p className="modal-sheet__lead">
                    Step the graphics clock cap automatically on <b>{targets.label}</b>?
                  </p>
                  <p className="text-xs text-muted">
                    Steps down 100 MHz at ≥ 72 °C (immediately from 77 °C while the temperature
                    is still rising) and back up 100 MHz at ≤ 67 °C, never leaving{" "}
                    {AUTO_BAND[0]}–{AUTO_BAND[1]} MHz. Starts from the current cap when it is in
                    band, else 2000 MHz. Any preset or Uncapped choice turns Auto off.
                  </p>
                </div>

                <div className="modal-sheet__footer">
                  <div className="modal-sheet__footer-actions">
                    <button
                      type="button"
                      onClick={() => setPendingAuto(false)}
                      disabled={applying}
                      className="btn btn--ghost"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleEnableAuto()}
                      disabled={applying}
                      className="btn btn--primary"
                    >
                      {applying ? <RotateIcon className="h-3.5 w-3.5 animate-spin" /> : null}
                      {applying ? "Enabling…" : "Enable Auto"}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </Panel>
  );
}
