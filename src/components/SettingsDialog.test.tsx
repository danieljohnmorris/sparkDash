import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchClockCap: vi.fn(),
  fetchFleetClockAuto: vi.fn(),
  setClockCap: vi.fn(),
  setFleetClockAuto: vi.fn(),
}));
vi.mock("../api/authToken", () => ({
  getToken: vi.fn().mockReturnValue(""),
  onTokenChange: vi.fn().mockReturnValue(() => {}),
  requestTokenPrompt: vi.fn(),
  clearToken: vi.fn(),
}));

import {
  fetchSettings,
  fetchClockCap,
  fetchFleetClockAuto,
  setClockCap,
  setFleetClockAuto,
} from "../api/client";
import type { Settings, SparkSnapshot } from "../api/types";
import { SettingsDialog } from "./SettingsDialog";
import { flush, render } from "../testing/render";

const fetchSettingsMock = vi.mocked(fetchSettings);
const fetchClockCapMock = vi.mocked(fetchClockCap);
const fetchAutoMock = vi.mocked(fetchFleetClockAuto);
const setClockCapMock = vi.mocked(setClockCap);
const setAutoMock = vi.mocked(setFleetClockAuto);

const DEFAULT_SETTINGS: Settings = {
  pollIntervalMs: 2000,
  defaultLlmPort: 8888,
  autoHideOffline: false,
  hideWorkers: false,
  temperatureUnit: "celsius",
  energyCurrency: "$",
  energyPricePerKwh: null,
  showFleetEnergy: true,
  showFleetExceptions: false,
  showOverviewSearch: false,
  showLlmTokenTotals: true,
  showVramBreakdown: true,
  benchShareImage: false,
  benchDebugTraces: false,
  prometheusExport: false,
} as Settings;

function okStatus(id: string, overrides = {}) {
  return { id, name: id.toUpperCase(), ok: true, mhz: null, stale: false, graphicsClockMHz: null, ...overrides };
}

function autoState(overrides = {}) {
  return {
    enabled: false,
    capMhz: 1800,
    holdTempC: 72,
    releaseTempC: 67,
    range: { min: 1800, max: 2400 },
    presets: [1800, 1850, 1900, 1950, 2000, 2050, 2100, 2150, 2200, 2250, 2300, 2350, 2400],
    sparks: [],
    ...overrides,
  };
}

function spark(id: string): SparkSnapshot {
  return { id, name: id.toUpperCase(), online: true, metrics: { gpu: null } } as SparkSnapshot;
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
}

/** The confirm sheet FleetClockCap portals to document.body (narrow modal-sheet). */
function confirmSheet(): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].find((d) =>
    d.classList.contains("modal-sheet--narrow")
  );
  if (!el) throw new Error("confirm sheet not open");
  return el;
}

function button(label: string, scope: HTMLElement = dialog()): HTMLButtonElement {
  const el = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`button not found: ${label}`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  fetchSettingsMock.mockResolvedValue(DEFAULT_SETTINGS);
  fetchClockCapMock.mockResolvedValue({ success: true, sparks: [okStatus("s1"), okStatus("s2", { mhz: 2000 })] });
  fetchAutoMock.mockResolvedValue(autoState());
  setClockCapMock.mockReset();
  setAutoMock.mockReset();
});

describe("SettingsDialog fleet clock control", () => {
  it("hosts the fleet-wide clock cap panel with 50 MHz presets, Uncapped and the Auto thermal hold switch", async () => {
    const { container } = render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1"), spark("s2")]} />);
    await flush();

    // The moved panel is present, with the 1800–2400 every-50-MHz range and Uncapped.
    expect(container.textContent).toContain("GPU clock cap");
    const presetGroup = container.querySelector('[aria-label="Fleet clock cap preset"]')!;
    for (const mhz of [1800, 1850, 1900, 1950, 2000, 2050, 2100, 2150, 2200, 2250, 2300, 2350, 2400]) {
      expect(presetGroup.textContent).toContain(String(mhz));
    }
    expect(presetGroup.textContent).toContain("Uncapped");
    // Auto thermal hold is a real on/off switch with the off-state help text.
    const toggle = dialog().querySelector('[role="switch"][aria-label="Auto thermal hold"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Off: the preset you pick is applied now and stays.");
  });

  it("shows the on-state help text and live hold state when Auto thermal hold is on", async () => {
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(
      autoState({
        enabled: true,
        capMhz: 2100,
        sparks: [{ id: "s1", name: "s1", holding: true, since: Date.now(), lastError: null }],
      })
    );
    const { container } = render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1")]} />);
    await flush();

    expect(container.textContent).toContain(
      "When any GPU reaches 72 °C, all Sparks are capped at 2100 MHz. When all are at or below 67 °C, the cap is released."
    );
    expect(container.querySelector('[data-testid="auto-hold-state"]')?.textContent).toContain("Holding since");
  });

  it("applies a preset fleet-wide from Settings after confirm", async () => {
    setClockCapMock.mockResolvedValue({
      success: true,
      mhz: 1800,
      results: [{ id: "s1", name: "s1", ok: true, mhz: 1800, graphicsClockMHz: 1799 }],
    });
    render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1"), spark("s2")]} />);
    await flush();

    act(() => button("1800").click());
    await flush();
    // Confirm dialog names the whole fleet before anything is applied.
    expect(setClockCapMock).not.toHaveBeenCalled();
    await act(async () => button("Set 1800 MHz", confirmSheet()).click());
    await flush();

    expect(setClockCapMock).toHaveBeenCalledWith("all", 1800);
  });

  it("uncaps every Spark from Settings", async () => {
    setClockCapMock.mockResolvedValue({
      success: true,
      mhz: null,
      results: [{ id: "s1", name: "s1", ok: true, mhz: null }],
    });
    render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1")]} />);
    await flush();

    act(() => button("Uncapped").click());
    await flush();
    await act(async () => button("Uncapped — confirm", confirmSheet()).click());
    await flush();

    expect(setClockCapMock).toHaveBeenCalledWith("all", null);
  });

  it("toggles fleet-wide Auto thermal hold from Settings", async () => {
    setAutoMock.mockResolvedValue(autoState({ enabled: true }));
    const { container } = render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1")]} />);
    await flush();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Auto thermal hold"]'
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => toggle.click());
    await flush();

    expect(setAutoMock).toHaveBeenCalledWith(true, undefined);
    expect(container.querySelector('[role="switch"][aria-label="Auto thermal hold"]')!.getAttribute("aria-checked")).toBe(
      "true"
    );
  });
});
