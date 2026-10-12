import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../api/client", () => ({
  stopAllLlms: vi.fn(),
}));

import { stopAllLlms } from "../api/client";
import { StopAllLlms } from "./StopAllLlms";
import { render, flush } from "../testing/render";

describe("StopAllLlms", () => {
  beforeEach(() => {
    vi.mocked(stopAllLlms).mockReset();
  });

  it("one click calls the batch API fleet-wide with no confirm dialog", async () => {
    vi.mocked(stopAllLlms).mockResolvedValue({
      success: true,
      results: [{ id: "a", name: "a", ok: true, stopped: ["GLM"] }],
    });
    const { container } = render(<StopAllLlms />);
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Stop all LLMs")
    );
    expect(trigger).toBeDefined();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(stopAllLlms).toHaveBeenCalledTimes(1);
    expect(stopAllLlms).toHaveBeenCalledWith("all");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".ov-batchmsg")?.textContent).toContain("1 model unloaded");
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
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Stop all LLMs")
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const msg = container.querySelector<HTMLElement>(".ov-batchmsg");
    expect(msg?.textContent).toContain("1 model unloaded");
    expect(msg?.textContent).toContain("1 Spark failed");
  });
});
