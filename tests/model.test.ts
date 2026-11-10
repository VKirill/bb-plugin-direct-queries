import { describe, expect, it } from "vitest";
import { pipelineJobs, pipelineSchema } from "../model.ts";

const base = {
  accountId: "acc-1",
  profile: {
    site: "https://example.com/",
    company: "Co",
    buyer: "Buyers",
    offers: ["Offer"],
    advertising_goal: "Orders",
    boundaries: ["Off-topic"],
  },
  serp: { enabled: true, device: "desktop" },
  library: { enabled: true, apply: true },
  schedule: {},
};

const nightJob = (pipe: ReturnType<typeof pipelineSchema.parse>) =>
  pipelineJobs(pipe).find((j) => j.id === "night-export")!;

describe("pipelineSchema schedule and negatives", () => {
  it("parses an old schedule as daily/yesterday with library negatives", () => {
    const pipe = pipelineSchema.parse({
      ...base,
      schedule: { hour: 3, catchUpHours: [4, 6, 9, 12], syncHours: [0, 4, 8, 12, 16, 20] },
    });
    expect(pipe.schedule.mode).toBe("daily");
    expect(pipe.schedule.reportDay).toBe("yesterday");
    expect(pipe.negatives).toEqual({ level: "library", apply: true });
    const job = nightJob(pipe);
    expect(job.hours).toEqual([3]);
    expect(job.reportDay).toBe("yesterday");
    expect(pipelineJobs(pipe).some((j) => j.id === "library-sync")).toBe(true);
  });

  it("twice with hour 3 gives night hours [3, 15]", () => {
    const pipe = pipelineSchema.parse({ ...base, schedule: { hour: 3, mode: "twice" } });
    expect(nightJob(pipe).hours).toEqual([3, 15]);
  });

  it("custom hours are used as configured and empty falls back to the hour", () => {
    const custom = pipelineSchema.parse({
      ...base,
      schedule: { mode: "custom", hours: [22, 1, 9, 9] },
    });
    expect(nightJob(custom).hours).toEqual([1, 9, 22]);
    const empty = pipelineSchema.parse({ ...base, schedule: { mode: "custom", hours: [] } });
    expect(nightJob(empty).hours).toEqual([3]);
  });

  it("reportDay today flows into the night job", () => {
    const pipe = pipelineSchema.parse({
      ...base,
      schedule: { hour: 8, reportDay: "today" },
    });
    expect(nightJob(pipe).reportDay).toBe("today");
  });

  it("negatives apply defaults to library.apply and a non-library level drops library-sync", () => {
    const pipe = pipelineSchema.parse({
      ...base,
      library: { enabled: true, apply: false },
      negatives: { level: "campaign" },
    });
    expect(pipe.negatives).toEqual({ level: "campaign", apply: false });
    expect(pipelineJobs(pipe).some((j) => j.id === "library-sync")).toBe(false);
    const explicit = pipelineSchema.parse({
      ...base,
      negatives: { level: "adgroup", apply: true },
    });
    expect(explicit.negatives).toEqual({ level: "adgroup", apply: true });
  });
});
