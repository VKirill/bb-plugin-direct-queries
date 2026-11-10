import { describe, expect, it } from "vitest";
import { createDirectClient, type DirectTransport, type SearchQueryRow } from "../direct.ts";
import type { HttpResponse, FetchFn } from "../yandex-oauth.ts";
import {
  evaluatePlacements,
  planExclusions,
  resolveTemplate,
  EXCLUDED_SITES_LIMIT,
} from "../placements.ts";
import { runPipeline, type PipelineDeps } from "../pipeline.ts";
import { fixturePipelineProject } from "./fixtures/projects.ts";
import type { AccountRow, JudgementRow, QueryRow } from "../db.ts";
import type { JudgeResult } from "../judge.ts";
import type { SiteProfile } from "../model.ts";

const T0300 = Date.parse("2026-11-04T00:00:00Z");

const placementRow = (over: Partial<SearchQueryRow> = {}): SearchQueryRow => ({
  CampaignId: 11,
  CampaignName: "RSYA",
  Placement: "example.com",
  AdNetworkType: "AD_NETWORK",
  Impressions: 1000,
  Clicks: 10,
  Cost: 50,
  Conversions: 1,
  ...over,
});

const profile = (over: Partial<SiteProfile> = {}): SiteProfile => ({
  site: "https://gamma.example/",
  company: "Gamma",
  buyer: "Buyers",
  offers: ["Offer"],
  advertising_goal: "Orders",
  boundaries: ["Off-topic"],
  ...over,
});

describe("evaluatePlacements", () => {
  it("template 'apps-and-games' gives verdict 'exclude' for 'com.example.game'", () => {
    const rows = evaluatePlacements(
      [placementRow({ Placement: "com.example.game" })],
      resolveTemplate("apps-and-games"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("exclude");
    expect(rows[0].placement).toBe("com.example.game");
  });

  it("a keep rule matching the same placement turns the verdict to 'keep'", () => {
    const withKeep = resolveTemplate("apps-and-games", profile({
      placement_rules: ["keep: com\\.example\\.game"],
    }));
    const rows = evaluatePlacements(
      [placementRow({ Placement: "com.example.game" })],
      withKeep,
    );
    expect(rows[0].verdict).toBe("keep");
  });

  it("the passport's own domain is never excluded", () => {
    const rows = evaluatePlacements(
      [placementRow({ Placement: "gamma.example" })],
      resolveTemplate("safe", profile()),
    );
    expect(rows[0].verdict).toBe("keep");
  });

  it("costNoConv with minCost 300 excludes cost 300 with 0 conversions, not cost 299", () => {
    const template = resolveTemplate("safe");
    const rows = evaluatePlacements(
      [
        placementRow({ Placement: "a.com", Cost: 300, Conversions: 0 }),
        placementRow({ Placement: "b.com", Cost: 299, Conversions: 0 }),
      ],
      template,
    );
    expect(rows.find((r) => r.placement === "a.com")?.verdict).toBe("exclude");
    expect(rows.find((r) => r.placement === "b.com")?.verdict).toBe("watch");
  });
});

describe("planExclusions", () => {
  it("merges with current ExcludedSites without duplicates and never adds a keep site", () => {
    const plan = planExclusions(["old.com", "dup.com"], [
      { site: "dup.com" },
      { site: "new.com" },
      { site: "keep.com", keep: true },
    ]);
    expect(plan.items).toEqual(["old.com", "dup.com", "new.com"]);
    expect(plan.added).toBe(1);
    expect(plan.overflow).toBe(0);
  });

  it("returns at most 1000 items and reports the overflow count", () => {
    const current = Array.from({ length: EXCLUDED_SITES_LIMIT - 1 }, (_, i) => `s${i}.com`);
    const plan = planExclusions(current, ["a.com", "b.com", "c.com"]);
    expect(plan.items).toHaveLength(EXCLUDED_SITES_LIMIT);
    expect(plan.items.at(-1)).toBe("a.com");
    expect(plan.added).toBe(1);
    expect(plan.overflow).toBe(2);
  });
});

describe("placementsReport", () => {
  const tsv = [
    ["11", "RSYA", "com.example.game", "AD_NETWORK", "1000", "50", "400", "0"].join("\t"),
    "",
  ].join("\n");

  it("sends ReportType CUSTOM_REPORT with an AdNetworkType EQUALS AD_NETWORK filter", async () => {
    let captured: Record<string, unknown> | undefined;
    const transport: DirectTransport = {
      call: async () => ({}),
      report: async (params) => {
        captured = params as Record<string, unknown>;
        return tsv;
      },
    };
    const client = createDirectClient({ transport });
    const rows = await client.placementsReport({
      dateFrom: "2026-11-01",
      dateTo: "2026-11-07",
      campaignIds: [11],
    });
    const params = captured as {
      ReportType: string;
      FieldNames: string[];
      SelectionCriteria: {
        DateFrom: string;
        DateTo: string;
        Filter: { Field: string; Operator: string; Values: string[] }[];
      };
    };
    expect(params.ReportType).toBe("CUSTOM_REPORT");
    expect(params.FieldNames).toContain("Placement");
    expect(params.FieldNames).toContain("AdNetworkType");
    expect(params.SelectionCriteria.Filter).toContainEqual({
      Field: "AdNetworkType",
      Operator: "EQUALS",
      Values: ["AD_NETWORK"],
    });
    expect(params.SelectionCriteria.Filter).toContainEqual({
      Field: "CampaignId",
      Operator: "IN",
      Values: ["11"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].Placement).toBe("com.example.game");
    expect(rows[0].Cost).toBe(400);
  });
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

function fakes(over: Partial<PipelineDeps> = {}) {
  const stored = {
    queries: [] as QueryRow[],
    judgements: [] as JudgementRow[],
    feedback: [] as ReturnType<PipelineDeps["loadFeedback"]>,
  };
  const calls = { publishPlacements: 0, updateExcludedSites: [] as { campaignId: number; sites: string[] }[][] };
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
    judgeQueries: async () => [judgement()],
    reviewSerp: async () => [],
    publishDay: async () => ({ written: 1 }),
    syncLibrary: async () => ({ added: 0, created: 0 }),
    ...over,
  };
  return { deps, calls, stored };
}

const project = fixturePipelineProject();

describe("runPipeline placements stage", () => {
  it("has stage 'placements' with status 'skipped' for a project without placements enabled", async () => {
    const { deps } = fakes();
    const rows = await runPipeline(deps, project, "2026-11-03", { trigger: "schedule" });
    expect(rows.find((r) => r.stageId === "placements")?.status).toBe("skipped");
  });

  it("enabled placements publishes the tab and applies exclusions", async () => {
    const placementsProject = {
      ...project,
      pipeline: {
        ...project.pipeline!,
        placements: { enabled: true, template: "safe" as const, apply: true, days: 7 },
      },
    };
    const { deps, calls } = fakes({
      placementsReport: async () => [
        placementRow({ Placement: "bad.site", Cost: 400, Conversions: 0 }),
      ],
      publishPlacements: async ({ rows }) => {
        calls.publishPlacements += 1;
        return {
          written: rows.length,
          decisions: rows.map((r) => ({
            campaignId: r.campaignId,
            placement: r.placement,
            decision: "" as const,
          })),
        };
      },
      campaignExcludedSites: async () => new Map([[11, ["existing.com"]]]),
      updateExcludedSites: async ({ items }) => {
        calls.updateExcludedSites.push(items);
        return [];
      },
    });
    const rows = await runPipeline(deps, placementsProject, "2026-11-03", {
      trigger: "schedule",
    });
    const stage = rows.find((r) => r.stageId === "placements")!;
    expect(stage.status).toBe("ok");
    expect(calls.publishPlacements).toBe(1);
    expect(calls.updateExcludedSites).toEqual([
      [{ campaignId: 11, sites: ["existing.com", "bad.site"] }],
    ]);
  });
});
