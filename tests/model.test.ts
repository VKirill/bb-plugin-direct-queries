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

describe("pipelineSchema bids", () => {
  it("defaults bids fields and adds the bids job at [0,6,12,18] minute 3", () => {
    const pipe = pipelineSchema.parse({ ...base, bids: { enabled: true } });
    expect(pipe.bids).toEqual({
      enabled: true,
      apply: false,
      skipCampaigns: ["По минималке"],
    });
    const job = pipelineJobs(pipe).find((j) => j.id === "bids")!;
    expect(job.hours).toEqual([0, 6, 12, 18]);
    expect(job.minute).toBe(3);
    expect(job.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(job.reportDay).toBe("today");
    expect(job.timeoutMin).toBe(60);
    expect(job.catchUpHours).toEqual([]);
    expect(job.stages).toEqual([
      {
        id: "bids",
        title: "Ставки",
        command: "",
        required: true,
        outputs: [],
        reuse: false,
        emptyStops: false,
      },
    ]);
  });

  it("no bids job without bids.enabled", () => {
    const pipe = pipelineSchema.parse(base);
    expect(pipe.bids).toBeUndefined();
    expect(pipelineJobs(pipe).some((j) => j.id === "bids")).toBe(false);
    const off = pipelineSchema.parse({ ...base, bids: { enabled: false, apply: true } });
    expect(pipelineJobs(off).some((j) => j.id === "bids")).toBe(false);
  });
});
