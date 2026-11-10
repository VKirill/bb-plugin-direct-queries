import { describe, expect, it } from "vitest";
import { fixturePipelineProject } from "./fixtures/projects.ts";
import { runPipeline, type PipelineDeps } from "../pipeline.ts";
import { MissingSecret } from "../secrets.ts";
import type { AccountRow, JudgementRow, QueryRow } from "../db.ts";
import type { SearchQueryRow } from "../direct.ts";
import type { JudgeResult } from "../judge.ts";
import { jobsOf } from "../model.ts";
import { dayStatus } from "../ledger.ts";

const T0300 = Date.parse("2026-11-04T00:00:00Z");

const reportRow = (): SearchQueryRow => ({
  Date: "2026-11-03",
  CampaignId: 11,
  CampaignName: "Search",
  AdGroupId: 22,
  Query: "фильтр цех",
  Impressions: 10,
  Clicks: 1,
  Cost: 12.5,
  AvgImpressionPosition: 3,
  AvgClickPosition: 2,
  Conversions: 0,
});

const judgement = (): JudgeResult => ({
  query: "фильтр цех",
  campaign: "Search",
  status: "релевантен",
  score: 80,
  reason: "ok",
  intent: "commercial",
  confidence: 0.9,
  decisionSource: "jev",
});

const account = (): AccountRow => ({
  id: "acc-gamma",
  login: "gamma",
  isAgency: false,
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: T0300 + 86_400_000,
  createdAt: 1,
  source: "yandex",
});

function fakes(over: Partial<PipelineDeps> & { calls?: { publish: number; judge: number; libraryApply: boolean[] } } = {}) {
  const calls = over.calls ?? { publish: 0, judge: 0, libraryApply: [] as boolean[] };
  const stored = {
    queries: [] as QueryRow[],
    judgements: [] as JudgementRow[],
    feedback: [] as ReturnType<PipelineDeps["loadFeedback"]>,
  };
  const deps: PipelineDeps = {
    now: () => T0300,
    getSecret: async () => "secret",
    getAccount: () => account(),
    ensureFresh: async (a) => a,
    searchQueryReport: async () => [reportRow()],
    loadQueries: () => stored.queries,
    saveQueries: (_p, _d, rows) => {
      stored.queries = rows;
    },
    loadJudgements: () => stored.judgements,
    saveJudgements: (rows) => {
      stored.judgements = rows;
    },
    loadFeedback: () => stored.feedback,
    saveFeedback: (rows) => {
      stored.feedback = rows;
    },
    pullDecisions: async () => [],
    judgeQueries: async () => {
      calls.judge += 1;
      return [judgement()];
    },
    reviewSerp: async () => [],
    publishDay: async () => {
      calls.publish += 1;
      return { written: 1 };
    },
    syncLibrary: async ({ apply }) => {
      calls.libraryApply.push(apply);
      return { added: apply ? 1 : 0, created: 0 };
    },
    ...over,
  };
  return { deps, calls, stored };
}

const project = fixturePipelineProject();
const night = jobsOf(project).find((j) => j.id === "night-export")!;

describe("runPipeline", () => {
  it("runs a day with rows through to upload", async () => {
    const { deps, calls } = fakes();
    const rows = await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    expect(rows.find((r) => r.stageId === "report")?.status).toBe("ok");
    expect(rows.find((r) => r.stageId === "upload")?.status).toBe("ok");
    expect(calls.publish).toBe(1);
    expect(dayStatus(rows, night, "2026-11-03")).toBe("green");
  });

  it("a serp failure leaves the run amber and publishDay is still called", async () => {
    const { deps, calls } = fakes({
      reviewSerp: async () => {
        throw new Error("xmlstock down");
      },
    });
    const rows = await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    expect(rows.find((r) => r.stageId === "serp")?.status).toBe("failed");
    expect(rows.find((r) => r.stageId === "upload")?.status).toBe("ok");
    expect(calls.publish).toBe(1);
    expect(dayStatus(rows, night, "2026-11-03")).toBe("amber");
  });

  it("a judge failure makes it red with no publishDay", async () => {
    const { deps, calls } = fakes({
      judgeQueries: async () => {
        throw new Error("jev 503");
      },
    });
    const rows = await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    expect(rows.find((r) => r.stageId === "audit")?.status).toBe("failed");
    expect(rows.some((r) => r.stageId === "upload")).toBe(false);
    expect(calls.publish).toBe(0);
    expect(dayStatus(rows, night, "2026-11-03")).toBe("red");
  });

  it("0 report rows give no-shows and no upload", async () => {
    const { deps, calls } = fakes({
      searchQueryReport: async () => [],
    });
    const rows = await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    expect(rows.find((r) => r.stageId === "report")?.status).toBe("no-shows");
    expect(rows.some((r) => r.stageId === "upload")).toBe(false);
    expect(calls.publish).toBe(0);
    expect(dayStatus(rows, night, "2026-11-03")).toBe("grey");
  });

  it("dryRun makes no publishDay or Direct write", async () => {
    const { deps, calls } = fakes();
    await runPipeline(deps, project, "2026-11-03", { trigger: "schedule", dryRun: true });
    expect(calls.publish).toBe(0);
    expect(calls.libraryApply).toEqual([false]);
  });

  it("a missing Jev key fails the audit stage naming the setting and OPENLUX_API_KEY", async () => {
    const { deps, calls } = fakes({
      getSecret: async (name) => {
        if (name === "openluxKey") throw new MissingSecret("openluxKey");
        return "secret";
      },
    });
    const rows = await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    const audit = rows.find((r) => r.stageId === "audit")!;
    expect(audit.status).toBe("failed");
    expect(audit.firstError).toContain("openluxKey");
    expect(audit.firstError).toContain("OPENLUX_API_KEY");
    expect(audit.firstError).not.toMatch(/sk-|secret-value|api[_-]?key\s*[:=]\s*\S+/i);
    expect(calls.publish).toBe(0);
  });

  it("a catch-up with stored judgements makes no judge call", async () => {
    const { deps, calls, stored } = fakes();
    stored.judgements = [
      {
        projectId: "gamma",
        campaignId: 11,
        queryNorm: "фильтр цех",
        status: "релевантен",
        score: 80,
        reason: "cached",
        judge: "openlux",
        judgedAt: 1,
      },
    ];
    await runPipeline(deps, project, "2026-11-03", { trigger: "catch-up" });
    expect(calls.judge).toBe(0);
    expect(calls.publish).toBe(1);
  });

  it("reportDay today passes the run day to the search-query report", async () => {
    const seen: string[] = [];
    const { deps } = fakes({
      searchQueryReport: async ({ date }) => {
        seen.push(date);
        return [reportRow()];
      },
    });
    const todayProject = {
      ...project,
      pipeline: {
        ...project.pipeline!,
        schedule: { ...project.pipeline!.schedule, reportDay: "today" as const },
      },
    };
    await runPipeline(deps, todayProject, "2026-11-04", { trigger: "schedule" });
    expect(seen).toEqual(["2026-11-04"]);
  });

  it("a second scheduled run for the same day fetches the report again", async () => {
    let reportCalls = 0;
    const { deps } = fakes({
      searchQueryReport: async () => {
        reportCalls += 1;
        return [reportRow()];
      },
    });
    await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    expect(reportCalls).toBe(2);
  });

  it("negatives level campaign calls applyNegatives with resolved targets and skips the library", async () => {
    const calls: {
      level?: string;
      apply?: boolean;
      approved?: { phrase: string; campaignId?: number; adGroupId?: number; campaign?: string }[];
    }[] = [];
    const { deps, calls: lib } = fakes({
      pullDecisions: async () => [
        { query: "фильтр цех", campaign: "Search", decision: "minus", comment: "", date: "2026-11-03" },
      ],
      applyNegatives: async (args) => {
        calls.push(args);
        return { campaigns: [], groups: [], keywords: [], skipped: [], errors: [], applied: args.apply };
      },
    });
    const campaignProject = {
      ...project,
      pipeline: {
        ...project.pipeline!,
        negatives: { level: "campaign" as const, apply: true },
      },
    };
    await runPipeline(deps, campaignProject, "2026-11-03", { trigger: "schedule" });
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("campaign");
    expect(calls[0].apply).toBe(true);
    expect(calls[0].approved).toEqual([
      { query: "фильтр цех", phrase: "фильтр цех", campaignId: 11, adGroupId: 22, campaign: "Search" },
    ]);
    expect(lib.libraryApply).toEqual([]);
  });

  it("negatives apply false plans without writes", async () => {
    const calls: { apply?: boolean }[] = [];
    const { deps } = fakes({
      pullDecisions: async () => [
        { query: "фильтр цех", campaign: "Search", decision: "minus", comment: "", date: "2026-11-03" },
      ],
      applyNegatives: async (args) => {
        calls.push(args);
        return { campaigns: [], groups: [], keywords: [], skipped: [], errors: [], applied: args.apply };
      },
    });
    const planProject = {
      ...project,
      pipeline: {
        ...project.pipeline!,
        negatives: { level: "adgroup" as const, apply: false },
      },
    };
    const rows = await runPipeline(deps, planProject, "2026-11-03", { trigger: "schedule" });
    expect(calls).toHaveLength(1);
    expect(calls[0].apply).toBe(false);
    const library = rows.find((r) => r.stageId === "library")!;
    expect(library.status).toBe("ok");
    expect(library.firstError).toContain("plan only");
  });
});
