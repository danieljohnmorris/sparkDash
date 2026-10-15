import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  fetchClockCap: vi.fn(),
  fetchFleetClockAuto: vi.fn(),
  setClockCap: vi.fn(),
  setFleetClockAuto: vi.fn(),
}));

import {
  fetchClockCap,
  fetchFleetClockAuto,
  setClockCap,
  setFleetClockAuto,
} from "../api/client";
import type { SparkSnapshot } from "../api/types";
import { FleetClockCap } from "./FleetClockCap";
import { flush, render } from "../testing/render";

const PRESETS = [1800, 1850, 1900, 1950, 2000, 2050, 2100, 2150, 2200, 2250, 2300, 2350, 2400];

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
    presets: [...PRESETS],
    sparks: [],
    ...overrides,
  };
}

function spark(id: string, temp: number | null): SparkSnapshot {
  return {
    id,
    name: id.toUpperCase(),
    online: true,
    metrics: { gpu: temp == null ? null : { temperature: temp } },
  } as unknown as SparkSnapshot;
}

function presetButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(".ov-cap__presets > button")].find(
    (b) => b.textContent === label
  );
  if (!btn) throw new Error(`preset button "${label}" not found`);
  return btn;
}

function autoToggle(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Auto thermal hold"]');
  if (!btn) throw new Error("Auto thermal hold switch not found");
  return btn;
}

function dialogButton(label: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll<HTMLButtonElement>(".modal-sheet button")].find(
    (b) => b.textContent?.includes(label)
  );
  if (!btn) throw new Error(`dialog button "${label}" not found`);
  return btn;
}

beforeEach(() => {
  vi.mocked(fetchClockCap).mockResolvedValue({ success: true, sparks: [okStatus("a", { mhz: 2000 })] });
  vi.mocked(fetchFleetClockAuto).mockResolvedValue(autoState());
  vi.mocked(setClockCap).mockReset();
  vi.mocked(setFleetClockAuto).mockReset();
});

describe("FleetClockCap", () => {
  it("shows per-Spark readouts: live temp, cap, and auto holding state", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a", { mhz: 2000 }), okStatus("b")],
    });
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(
      autoState({
        enabled: true,
        sparks: [
          { id: "a", name: "A", holding: true, since: Date.now(), lastError: null },
          { id: "b", name: "B", holding: false, since: null, lastError: null },
        ],
      })
    );
    const { container } = render(<FleetClockCap sparks={[spark("a", 74), spark("b", 55)]} />);
    await flush();

    const rows = [...container.querySelectorAll(".ov-cap__spark")];
    expect(rows.map((r) => r.querySelector(".ov-cap__name")?.textContent)).toEqual(["A", "B"]);
    expect(rows[0].textContent).toContain("74 °C");
    expect(rows[0].textContent).toContain("2000 MHz");
    expect(rows[0].textContent).toContain("auto hold");
    expect(rows[1].textContent).toContain("55 °C");
    expect(rows[1].textContent).toContain("Uncapped");
  });

  it("targets every Spark from the single fleet control", async () => {
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: 1900,
      results: [okStatus("a", { mhz: 1900 }), okStatus("b", { mhz: 1900 })],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    await act(async () => {
      presetButton(container, "1900").click();
    });
    await flush();

    const confirm = dialogButton("Set 1900 MHz");
    await act(async () => {
      confirm.click();
    });
    await flush();

    expect(setClockCap).toHaveBeenCalledWith("all", 1900);
  });

  it("applies a 50 MHz-step preset fleet-wide", async () => {
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: 1850,
      results: [okStatus("a", { mhz: 1850 })],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60)]} />);
    await flush();

    await act(async () => {
      presetButton(container, "1850").click();
    });
    await flush();
    await act(async () => {
      dialogButton("Set 1850 MHz").click();
    });
    await flush();

    expect(setClockCap).toHaveBeenCalledWith("all", 1850);
  });

  it("toggles the Auto thermal hold switch in one action", async () => {
    vi.mocked(setFleetClockAuto).mockResolvedValue(autoState({ enabled: true }));
    const { container } = render(<FleetClockCap sparks={[spark("a", 60)]} />);
    await flush();

    const toggle = autoToggle(container);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(setFleetClockAuto).toHaveBeenCalledWith(true, undefined);
    expect(autoToggle(container).getAttribute("aria-checked")).toBe("true");
  });

  it("retargets the held cap from the Fleet presets when Auto thermal hold is on", async () => {
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(autoState({ enabled: true, capMhz: 2000 }));
    vi.mocked(setFleetClockAuto).mockResolvedValue(autoState({ enabled: true, capMhz: 2150 }));
    const { container } = render(<FleetClockCap sparks={[spark("a", 60)]} />);
    await flush();

    await act(async () => {
      presetButton(container, "2150").click();
    });
    await flush();

    expect(setFleetClockAuto).toHaveBeenCalledWith(true, 2150);
  });

  it("shows the on-state help text plus Holding since when Auto is on and a GPU is hot", async () => {
    const since = new Date("2026-10-15T14:32:00").getTime();
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(
      autoState({
        enabled: true,
        capMhz: 2100,
        sparks: [{ id: "a", name: "A", holding: true, since, lastError: null }],
      })
    );
    const { container } = render(<FleetClockCap sparks={[spark("a", 75)]} />);
    await flush();

    expect(container.textContent).toContain(
      "When any GPU reaches 72 °C, all Sparks are capped at 2100 MHz. When all are at or below 67 °C, the cap is released."
    );
    const state = container.querySelector('[data-testid="auto-hold-state"]');
    expect(state?.textContent).toContain("Holding since");
    expect(state?.textContent).toMatch(/\d{2}:\d{2}/);
    expect(state?.className).toContain("is-holding");
  });

  it("shows Idle when Auto is on but nothing is held", async () => {
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(autoState({ enabled: true }));
    const { container } = render(<FleetClockCap sparks={[spark("a", 55)]} />);
    await flush();

    const state = container.querySelector('[data-testid="auto-hold-state"]');
    expect(state?.textContent).toBe("Idle");
    expect(state?.className).not.toContain("is-holding");
  });

  it("shows the off-state help text when Auto is off", async () => {
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(autoState({ enabled: false }));
    const { container } = render(<FleetClockCap sparks={[spark("a", 55)]} />);
    await flush();

    expect(container.textContent).toContain("Off: the preset you pick is applied now and stays.");
    // SPARK-12: the duplicate Hold cap dropdown is gone — only the Fleet presets remain.
    expect(container.querySelector(".ov-cap__capselect")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("Hold cap");
  });

  it("disables Uncapped while Auto thermal hold is on", async () => {
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(autoState({ enabled: true }));
    const { container } = render(<FleetClockCap sparks={[spark("a", 60)]} />);
    await flush();

    expect(presetButton(container, "Uncapped").disabled).toBe(true);
  });

  it("surfaces a per-node failure instead of failing silently", async () => {
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: 1900,
      results: [
        { id: "a", name: "A", ok: true, mhz: 1900 },
        { id: "b", name: "B", ok: false, error: "ssh: connection refused" },
      ],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    await act(async () => {
      presetButton(container, "1900").click();
    });
    await flush();
    await act(async () => {
      dialogButton("Set 1900 MHz").click();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Clock cap failed");
    expect(alert?.textContent).toContain("ssh: connection refused");
  });

  // ─── SPARK-11/SPARK-12: on-load preselect from the backend reads ───

  it("highlights the preset matching the fleet's uniform cap on load", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a", { mhz: 2000 }), okStatus("b", { mhz: 2000 })],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    expect(presetButton(container, "2000").getAttribute("aria-pressed")).toBe("true");
    expect(presetButton(container, "1800").getAttribute("aria-pressed")).toBe("false");
    expect(presetButton(container, "Uncapped").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).not.toContain("Mixed");
  });

  it("highlights Uncapped when every node reports stock clocks", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a"), okStatus("b")],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    expect(presetButton(container, "Uncapped").getAttribute("aria-pressed")).toBe("true");
    expect(presetButton(container, "2000").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows Mixed and highlights nothing when the nodes' caps differ", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a", { mhz: 2000 }), okStatus("b", { mhz: 1800 })],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    expect(container.textContent).toContain("Mixed");
    for (const label of ["1800", "1850", "1900", "2000", "2100", "2200", "Uncapped"]) {
      expect(presetButton(container, label).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("shows the Auto thermal hold switch on and highlights the held cap from the backend", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [
        okStatus("a", { mhz: 2000, auto: { enabled: true, cap: 2000, lastTempC: 60, lastStep: null, log: [], lastError: null } }),
        okStatus("b", { mhz: 2000, auto: { enabled: true, cap: 2000, lastTempC: 61, lastStep: null, log: [], lastError: null } }),
      ],
    });
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(
      autoState({
        enabled: true,
        capMhz: 2150,
        sparks: [{ id: "a", name: "A", holding: false, since: null, lastError: null }],
      })
    );
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    expect(autoToggle(container).getAttribute("aria-checked")).toBe("true");
    expect(presetButton(container, "2150").getAttribute("aria-pressed")).toBe("true");
    expect(presetButton(container, "2000").getAttribute("aria-pressed")).toBe("false");
  });
});