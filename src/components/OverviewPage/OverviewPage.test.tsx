import { describe, expect, it } from "vitest";
import { OverviewPage } from "./OverviewPage";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import type { SparkSnapshot } from "../../api/types";

/** The RTX PRO 6000 host as the live instance reported it. */
function host(overrides: { cpuTemp?: number; kind?: "spark" | "host" } = {}): SparkSnapshot {
  return {
    id: "rtx-pro-6000",
    name: "RTX PRO 6000",
    kind: overrides.kind ?? "host",
    online: true,
    uptime: 1000,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPort: 30000,
    llmPorts: [30000],
    metrics: {
      gpu: {
        usage: 37,
        temperature: 44,
        vram: { used: 90_000, total: 97_887, available: 7_887, percentage: 92 },
        power: { draw: 80, limit: 600 },
      },
      cpu: { temperature: overrides.cpuTemp ?? 0 },
      ram: { used: 40_000, total: 128_000 },
      storage: [
        { label: "/", device: "nvme1n1p2", used: 836_010, total: 1_875_626, percentage: 44.6 },
      ],
      llm: [{ available: true, backend: "sglang", modelId: "qwen38-exl3-ple8", generationTps: 0, prefillTps: 0 }],
    },
  } as unknown as SparkSnapshot;
}

/** Bar labels in render order. */
function barLabels(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll(
      ".ov-lbl > span:first-child, .space-y-1 > div:first-child > span:first-child"
    ),
  ].map(
    (el) => el.textContent ?? ""
  );
}

describe("Overview card", () => {
  it("shows a two-node model span and its standalone from API fixtures", () => {
    const head = makeSpark("head");
    const worker = { ...makeSpark("worker"), role: "worker", workerNode: true, workerHeadId: "head" } as SparkSnapshot;
    const standalone = { ...makeSpark("standalone"), role: "standalone" } as SparkSnapshot;
    const { container } = render(<OverviewPage sparks={[head, worker, standalone]} />);

    const headCard = [...container.querySelectorAll(".ov-sc")].find((card) => card.textContent?.includes("Spark head"))!;
    expect(headCard.textContent).toContain("fixture-model");
    expect(headCard.textContent).toContain("Spark worker");
    expect(headCard.textContent).toContain("HEAD");
    expect(headCard.textContent).toContain("WORKER");
    const standaloneCard = [...container.querySelectorAll(".ov-sc")].find((card) => card.textContent?.includes("Spark standalone"))!;
    expect(standaloneCard.textContent).toContain("fixture-model");
    expect(standaloneCard.textContent).toContain("STANDALONE");
  });

  it("groups a three-node pair without inventing topology", () => {
    const head = makeSpark("head");
    const workers = ["worker-1", "worker-2"].map((id) => ({ ...makeSpark(id), role: "worker", workerNode: true, workerHeadId: "head" })) as SparkSnapshot[];
    const { container } = render(<OverviewPage sparks={[head, ...workers]} />);
    const headCard = [...container.querySelectorAll(".ov-sc")].find((card) => card.textContent?.includes("Spark head"))!;
    expect(headCard.textContent).toContain("Spark worker-1");
    expect(headCard.textContent).toContain("Spark worker-2");
    expect(headCard.textContent!.match(/WORKER/g)).toHaveLength(2);
  });

  it("names each bar for what it measures", () => {
    const { container } = render(<OverviewPage sparks={[host({ cpuTemp: 51 })]} />);
    expect(barLabels(container)).toEqual(["VRAM", "GPU", "RAM", "GPU temp", "GPU power"]);
  });

  it("calls the temperature bar GPU temp even without a CPU sensor", () => {
    // A GB10 has no CPU package sensor; this used to read "Temperature".
    const { container } = render(<OverviewPage sparks={[host({ kind: "spark" })]} />);
    expect(barLabels(container)).toEqual(["VRAM", "GPU", "GPU temp", "GPU power"]);
  });

  it("fits a 1.8 TB root disk in the Storage mini-stat", () => {
    const { container } = render(<OverviewPage sparks={[host()]} />);
    const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Storage");
    const value = label?.nextElementSibling as HTMLElement | null;
    expect(value?.textContent).toBe("816 GB / 1.8 TB");
    expect(value?.title).toBe("816.4 GB of 1831.7 GB used (45%)");
  });

  it("calls SGLang by its name", () => {
    const { container } = render(<OverviewPage sparks={[host()]} />);
    // The engine name rides in the model row's tooltip.
    expect(container.querySelector('[title*="SGLang"]')).not.toBeNull();
    expect(container.innerHTML).not.toContain("sgLang");
  });
});
