import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../api/client", () => ({
  stopAllLlms: vi.fn(),
}));

import { stopAllLlms } from "../api/client";
import { StopAllLlms } from "./StopAllLlms";
import { render, flush } from "../testing/render";

function dialog() {
  return document.body.querySelector<HTMLDivElement>('[role="dialog"]');
}

/** The modal sheet stays mounted through its 240 ms exit animation. */
// Promise.withResolvers needs lib es2024, which this project's tsconfig does not set.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("StopAllLlms", () => {
  beforeEach(() => {
    vi.mocked(stopAllLlms).mockReset();
  });

  function openDialog(container: HTMLElement) {
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Stop all LLMs")
    );
    expect(trigger).toBeDefined();
    act(() => trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Stop serving on every Spark?");
  }

  // Drives the confirm dialog the way a user would: type the phrase, tick the box, confirm.
  async function confirm() {
    const sheet = dialog()!;
    const phrase = sheet.querySelector<HTMLInputElement>("input.field-input--mono")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(phrase, "unload");
      phrase.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const checkbox = sheet.querySelector<HTMLInputElement>(".check-row input")!;
    act(() => checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const confirmButton = Array.from(sheet.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Stop all LLMs");
    expect(confirmButton).toBeDefined();
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  it("confirms before stopping, then calls the batch API fleet-wide", async () => {
    vi.mocked(stopAllLlms).mockResolvedValue({
      success: true,
      results: [{ id: "a", name: "a", ok: true, stopped: ["GLM"] }],
    });
    const { container } = render(<StopAllLlms />);
    openDialog(container);
    expect(stopAllLlms).not.toHaveBeenCalled();

    await confirm();
    expect(stopAllLlms).toHaveBeenCalledTimes(1);
    expect(stopAllLlms).toHaveBeenCalledWith("all");
    // The sheet stays mounted for its 240 ms exit animation, then unmounts.
    await act(async () => {
      await delay(300);
    });
    expect(dialog()).toBeNull();
  });

  it("does not call the API when cancelled", async () => {
    const { container } = render(<StopAllLlms />);
    openDialog(container);
    await act(async () => {
      Array.from(dialog()!.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Cancel")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await delay(300);
    });
    expect(dialog()).toBeNull();
    expect(stopAllLlms).not.toHaveBeenCalled();
  });

  it("reports per-Spark failures instead of failing silently", async () => {
    vi.mocked(stopAllLlms).mockResolvedValue({
      success: false,
      results: [
        { id: "a", name: "a", ok: true, stopped: ["GLM"] },
        { id: "b", name: "b", ok: false, error: "Could not read the launcher states over SSH" },
      ],
    });
    const { container } = render(<StopAllLlms />);
    openDialog(container);
    await confirm();
    const msg = container.querySelector<HTMLElement>(".ov-batchmsg");
    expect(msg?.textContent).toContain("1 model unloaded");
    expect(msg?.textContent).toContain("1 Spark failed");
  });
});
