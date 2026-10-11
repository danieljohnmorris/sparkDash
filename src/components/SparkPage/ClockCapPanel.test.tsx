import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchClockCap: vi.fn(),
  setClockCap: vi.fn(),
  setClockCapMode: vi.fn(),
}));

import { fetchClockCap, setClockCap, setClockCapMode } from "../../api/client";
import { ClockCapPanel } from "./ClockCapPanel";
import { flush, render } from "../../testing/render";

function okStatus(overrides = {}) {
  return {
    id: "s1",
    name: "spark1",
    ok: true,
    mhz: 2000,
    stale: false,
    graphicsClockMHz: 1990,
    ...overrides,
  };
}

function presetButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(".sp-cap__presets > button")].find(
    (b) => b.textContent === label
  );
  if (!btn) throw new Error(`preset button "${label}" not found`);
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
  vi.mocked(fetchClockCap).mockResolvedValue({ success: true, sparks: [okStatus()] });
  vi.mocked(setClockCap).mockReset();
  vi.mocked(setClockCapMode).mockReset();
});

describe("ClockCapPanel", () => {
  it("shows the current cap from the marker and the live graphics clock", async () => {
    const { container } = render(
      <ClockCapPanel sparkId="s1" sparkName="spark1" fleet={[{ id: "s1", name: "spark1" }]} />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("2000 MHz");
    expect(text).toContain("1990 MHz");
  });

  it("shows Unlocked with no cap and a stale marker from an earlier boot", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus({ mhz: null, stale: true, markerMhz: 1800, graphicsClockMHz: 2412 })],
    });
    const { container } = render(<ClockCapPanel sparkId="s1" sparkName="spark1" />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Unlocked");
    expect(text).toContain("stale");
    expect(text).toContain("2412 MHz");
  });

  it("confirms before applying, naming the node and MHz", async () => {
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: 1800,
      results: [{ id: "s1", name: "spark1", ok: true, mhz: 1800, graphicsClockMHz: 1798 }],
    });
    const { container } = render(<ClockCapPanel sparkId="s1" sparkName="spark1" />);
    await flush();

    act(() => presetButton(container, "1800").click());
    const sheet = document.body.querySelector(".modal-sheet")!;
    expect(sheet).toBeTruthy();
    expect(sheet.textContent).toContain("spark1");
    expect(sheet.textContent).toContain("1800 MHz");
    expect(vi.mocked(setClockCap)).not.toHaveBeenCalled();

    await act(async () => dialogButton("Set 1800 MHz").click());
    await flush();
    expect(vi.mocked(setClockCap)).toHaveBeenCalledWith(["s1"], 1800);
    // Fresh status from the apply response: the panel shows the new cap + clock.
    expect(container.textContent).toContain("1800 MHz");
    expect(container.textContent).toContain("1798 MHz");
  });

  it("targets every Spark when All Sparks is selected", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus(), okStatus({ id: "s2", name: "spark2", mhz: 2000, graphicsClockMHz: 2001 })],
    });
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: null,
      results: [
        { id: "s1", name: "spark1", ok: true, mhz: null, graphicsClockMHz: 2400 },
        { id: "s2", name: "spark2", ok: true, mhz: null, graphicsClockMHz: 2401 },
      ],
    });
    const { container } = render(
      <ClockCapPanel sparkId="s2" sparkName="spark2" fleet={[{ id: "s1", name: "spark1" }, { id: "s2", name: "spark2" }]} />
    );
    await flush();

    act(() => [...container.querySelectorAll<HTMLButtonElement>(".seg > button")].find((b) => b.textContent === "All Sparks")!.click());
    act(() => presetButton(container, "Unlocked").click());
    await act(async () => dialogButton("Unlocked — confirm").click());
    await flush();
    expect(vi.mocked(setClockCap)).toHaveBeenCalledWith("all", null);
    expect(container.textContent).toContain("Unlocked");
  });

  it("reports a per-node failure instead of failing silently", async () => {
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: 2100,
      results: [{ id: "s1", name: "spark1", ok: false, error: "SSH to spark1:22 failed: sudo: a password is required" }],
    });
    const { container } = render(<ClockCapPanel sparkId="s1" sparkName="spark1" />);
    await flush();

    act(() => presetButton(container, "2100").click());
    await act(async () => dialogButton("Set 2100 MHz").click());
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Clock cap failed");
    expect(text).toContain("sudo: a password is required");
    // The dialog stays open so the failure is visible next to the action.
    expect(document.body.querySelector(".modal-sheet")).toBeTruthy();
  });

  it("shows the Auto badge, temp, last step and step log when Auto is on", async () => {
    const at = new Date("2026-10-11T19:42:00").getTime();
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [
        okStatus({
          mhz: 1900,
          graphicsClockMHz: 1895,
          tempC: 71,
          auto: {
            enabled: true,
            cap: 1900,
            lastTempC: 71,
            lastStep: { at, from: 2000, to: 1900, tempC: 71, dir: "down" },
            log: [{ at, from: 2000, to: 1900, tempC: 71, dir: "down" }],
            lastError: null,
          },
        }),
      ],
    });
    const { container } = render(<ClockCapPanel sparkId="s1" sparkName="spark1" />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Auto");
    expect(text).toContain("71 °C");
    expect(text).toContain("Last step");
    expect(text).toMatch(/↓ 2000 → 1900/);
    // Vitest's expect has no message arg here — assert the shape instead.
    expect(/↓ 2000 → 1900 at \d{2}:\d{2}/.test(text)).toBe(true);
    expect(container.querySelector(".sp-cap__auto-log")?.children.length).toBe(1);
  });

  it("confirms, then enables Auto through the mode endpoint", async () => {
    vi.mocked(setClockCapMode).mockResolvedValue({
      success: true,
      mode: "auto",
      results: [{ id: "s1", name: "spark1", ok: true, cap: 2000, tempC: 60 }],
    });
    const { container } = render(<ClockCapPanel sparkId="s1" sparkName="spark1" />);
    await flush();

    act(() => [...container.querySelectorAll<HTMLButtonElement>(".sp-cap__row > button")].find((b) => b.textContent?.includes("Auto"))!.click());
    const sheet = document.body.querySelector(".modal-sheet")!;
    expect(sheet.textContent).toContain("spark1");
    expect(vi.mocked(setClockCapMode)).not.toHaveBeenCalled();

    await act(async () => dialogButton("Enable Auto").click());
    await flush();
    expect(vi.mocked(setClockCapMode)).toHaveBeenCalledWith(["s1"], "auto");
    // The enable response folds in: Auto badge + start cap without a refresh.
    expect(container.textContent).toContain("Auto cap");
    expect(container.textContent).toContain("2000 MHz");
  });

  it("reports an Auto enable failure instead of failing silently", async () => {
    vi.mocked(setClockCapMode).mockResolvedValue({
      success: true,
      mode: "auto",
      results: [{ id: "s1", name: "spark1", ok: false, error: "SSH to spark1:22 failed" }],
    });
    const { container } = render(<ClockCapPanel sparkId="s1" sparkName="spark1" />);
    await flush();

    act(() => [...container.querySelectorAll<HTMLButtonElement>(".sp-cap__row > button")].find((b) => b.textContent?.includes("Auto"))!.click());
    await act(async () => dialogButton("Enable Auto").click());
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Clock cap failed");
    expect(text).toContain("SSH to spark1:22 failed");
  });
});
