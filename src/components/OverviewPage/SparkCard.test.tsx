import { act } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import type { SparkSnapshot } from "../../api/types";

function worker(): SparkSnapshot {
  return { ...makeSpark("w"), role: "worker", workerNode: true, workerHeadId: "h", workerLabel: "cfg-label" } as SparkSnapshot;
}
function head(online: boolean): SparkSnapshot {
  const h = makeSpark("h", online);
  return {
    ...h,
    role: "head",
    metrics: { ...h.metrics, llm: [{ available: true, backend: "vllm", modelId: "big-model", generationTps: 12, prefillTps: 100, contextLength: 4096 }] },
  } as unknown as SparkSnapshot;
}
function headWithModel(models: string[] | undefined, modelId: string | null = "big-model"): SparkSnapshot {
  return {
    ...makeSpark("h"),
    role: "head",
    metrics: { ...makeSpark("h").metrics, llm: [{ available: true, backend: "vllm", modelId, models, generationTps: 12, prefillTps: 100, contextLength: 4096 }] },
  } as unknown as SparkSnapshot;
}

describe("SparkCard", () => {
  it("is a plain container whose name is the only link; no interactive element nests another", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    const card = container.querySelector(".ov-sc")!;
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("tabindex")).toBeNull();
    const link = card.querySelector<HTMLAnchorElement>("a.ov-sc__link")!;
    expect(link.textContent).toBe("Spark a");
    for (const el of card.querySelectorAll("button, a, [role=button]")) {
      expect(el.querySelector("button, a, [role=button]")).toBeNull();
    }
    act(() => link.click());
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("does not select when clicking the card body (only the stretched name does)", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    act(() => container.querySelector<HTMLElement>(".ov-sc__body")?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a worker shows its online head's model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(true)} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("big-model");
  });

  it("a worker does not show an offline head's stale model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(false)} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("big-model");
    expect(container.textContent).toContain("No model on head");
    expect(container.textContent).toContain("Head is offline");
  });

  it("shows the derived head model and every member with its role", () => {
    const workerTwo = { ...worker(), id: "w2", name: "Spark w2" } as SparkSnapshot;
    const { container } = render(
      <SparkCard spark={head(true)} groupSparks={[head(true), worker(), workerTwo]} temperatureUnit="celsius" />,
    );
    const group = container.querySelector<HTMLElement>(".ov-group")!;
    expect(group).not.toBeNull();
    expect(group.textContent).toContain("Spark h");
    expect(group.textContent).toContain("Spark w");
    expect(group.textContent).toContain("Spark w2");
    expect(group.textContent).toContain("big-model");
    expect(group.textContent).toContain("HEAD");
    expect(group.textContent).toContain("WORKER");
    expect(group.textContent!.match(/WORKER/g)).toHaveLength(2);
  });

  it("shows a worker with an unmatched configured head as unknown", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={null} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("Head unknown");
    expect(container.textContent).toContain("No model on head");
  });

  it("uses the first served model id when modelId is absent", () => {
    const { container } = render(<SparkCard spark={headWithModel(["models-fallback"])} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("models-fallback");
  });
});
