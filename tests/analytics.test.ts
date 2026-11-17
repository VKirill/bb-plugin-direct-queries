import { describe, it, expect } from "vitest";
import {
  createDirectClient,
  DirectApiError,
  type DirectTransport,
  type SearchQueryRow,
} from "../direct.ts";
import {
  recommend,
  recommendationText,
  runAnalytics,
  summarize,
  type Recommendation,
} from "../analytics.ts";
import { en, ru } from "../i18n.ts";
import { createOhmyClient, ohmyDirectTransport } from "../ohmyseo.ts";
import type { FetchFn, HttpResponse } from "../yandex-oauth.ts";

const PERF_BASE = [
  "Date",
  "CampaignId",
  "CampaignName",
  "CampaignType",
  "AdNetworkType",
  "Impressions",
  "Clicks",
  "Cost",
];

function perfTsv(goals: number[], rows: string[][]): string {
  const header = goals.length
    ? [
        ...PERF_BASE,
        ...goals.map((goal) => `Conversions_${goal}_AUTO`),
        ...goals.map((goal) => `CostPerConversion_${goal}_AUTO`),
      ]
    : [...PERF_BASE, "Conversions", "CostPerConversion"];
  return [header.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n");
}

describe("performanceReport", () => {
  it("sends CUSTOM_REPORT with Cost, Conversions and CostPerConversion and no Goals keys", async () => {
    let captured: Record<string, unknown> | undefined;
    const transport: DirectTransport = {
      call: async () => ({}),
      report: async (params) => {
        captured = params as Record<string, unknown>;
        return "";
      },
    };
    const client = createDirectClient({ transport });
    await client.performanceReport({ dateFrom: "2026-11-01", dateTo: "2026-11-07" });
    const params = captured as {
      ReportType: string;
      DateRangeType: string;
      Format: string;
      FieldNames: string[];
    };
    expect(params.ReportType).toBe("CUSTOM_REPORT");
    expect(params.DateRangeType).toBe("CUSTOM_DATE");
    expect(params.Format).toBe("TSV");
    expect(params.FieldNames).toEqual(
      expect.arrayContaining(["Cost", "Conversions", "CostPerConversion", "AdNetworkType"]),
    );
    expect("Goals" in params).toBe(false);
    expect("AttributionModels" in params).toBe(false);
  });

  it("sends string Goals and AttributionModels and sums each goal column", async () => {
    let captured: Record<string, unknown> | undefined;
    const transport: DirectTransport = {
      call: async () => ({}),
      report: async (params) => {
        captured = params as Record<string, unknown>;
        return perfTsv([123, 456], [
          ["2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "SEARCH", "100", "10", "100", "3", "1", "30", "100"],
          ["2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "AD_NETWORK", "50", "5", "50", "2", "4", "20", "10"],
        ]);
      },
    };
    const client = createDirectClient({ transport });
    const rows = await client.performanceReport({
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
      goals: [123, 456],
    });
    expect(captured?.Goals).toEqual(["123", "456"]);
    expect(captured?.AttributionModels).toEqual(["AUTO"]);
    expect(rows.some((row) => row.Date === "Date")).toBe(false);
    const summary = summarize(rows, [123, 456]);
    expect(summary.totals.cost).toBe(150);
    expect(summary.totals.conversions).toBe(10);
    expect(summary.byGoal).toEqual([
      { goalId: 123, conversions: 5, cpa: 30 },
      { goalId: 456, conversions: 5, cpa: 30 },
    ]);
  });

  it("throws on a report header mismatch", async () => {
    const transport: DirectTransport = {
      call: async () => ({}),
      report: async () =>
        perfTsv([123], [["2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "SEARCH", "10", "2", "50", "1", "50"]]).replace(
          "CostPerConversion_123_AUTO",
          "CostPerConversion_123_AUTO\tExtra",
        ),
    };
    const client = createDirectClient({ transport });
    const err = await client
      .performanceReport({ dateFrom: "2026-11-03", dateTo: "2026-11-03", goals: [123] })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DirectApiError);
    expect((err as DirectApiError).message).toBe("report header mismatch");
  });
});

describe("performanceReport via the OhMySEO transport", () => {
  const mcpRes = (payload: unknown): HttpResponse => ({
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      }),
  });

  it("sends base FieldNames and still converts micros on suffixed goal columns", async () => {
    const tsv =
      '"direct-queries perf 2026-11-03_2026-11-03"\n' +
      "Date\tCampaignId\tCampaignName\tCampaignType\tAdNetworkType\tImpressions\tClicks\tCost\tConversions_456_AUTO\tCostPerConversion_456_AUTO\n" +
      "2026-11-03\t2\tCamp B\tTEXT_CAMPAIGN\tSEARCH\t100\t10\t1000000000\t5\t200000000\n" +
      "Total rows: 1\n";
    const sent: unknown[] = [];
    const fetch: FetchFn = async (_url, init) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return mcpRes({ ok: true, status: 200, tsv, rows: 1 });
    };
    const client = createDirectClient({
      transport: ohmyDirectTransport({
        client: createOhmyClient({ auth: "Bearer x", fetch }),
        account: "label-1",
      }),
    });
    const rows = await client.performanceReport({
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
      goals: [456],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].Cost).toBe(1000);
    expect(rows[0].Conversions_456_AUTO).toBe(5);
    expect(rows[0].CostPerConversion_456_AUTO).toBe(200);
    const rpc = sent[0] as {
      params: { arguments: { body: { params: { FieldNames: string[]; Goals: string[] } } } };
    };
    const fieldNames = rpc.params.arguments.body.params.FieldNames;
    expect(fieldNames).toEqual([
      "Date",
      "CampaignId",
      "CampaignName",
      "CampaignType",
      "AdNetworkType",
      "Impressions",
      "Clicks",
      "Cost",
      "Conversions",
      "CostPerConversion",
    ]);
    expect(rpc.params.arguments.body.params.Goals).toEqual(["456"]);
  });
});

describe("campaignGoals", () => {
  it("reads PriorityGoals from TextCampaign and UnifiedCampaign", async () => {
    const calls: Array<{ service: string; method: string; params: Record<string, unknown> }> = [];
    const transport: DirectTransport = {
      call: async (service, method, params) => {
        calls.push({ service, method, params: params as Record<string, unknown> });
        return {
          Campaigns: [
            { Id: 1, TextCampaign: { PriorityGoals: { Items: [{ GoalId: 123 }] } } },
            { Id: 2, UnifiedCampaign: { PriorityGoals: { Items: [{ GoalId: 456 }] } } },
          ],
        };
      },
      report: async () => "",
    };
    const client = createDirectClient({ transport });
    const goals = await client.campaignGoals([1, 2]);
    expect([...goals.entries()]).toEqual([
      [1, [123]],
      [2, [456]],
    ]);
    const params = calls[0].params as {
      SelectionCriteria: { Ids: number[] };
      TextCampaignFieldNames: string[];
      UnifiedCampaignFieldNames: string[];
    };
    expect(params.SelectionCriteria.Ids).toEqual([1, 2]);
    expect(params.TextCampaignFieldNames).toContain("PriorityGoals");
    expect(params.UnifiedCampaignFieldNames).toContain("PriorityGoals");
  });

  it("makes no Direct call for an empty id list", async () => {
    const calls: unknown[] = [];
    const transport: DirectTransport = {
      call: async (...args) => {
        calls.push(args);
        return {};
      },
      report: async () => "",
    };
    const client = createDirectClient({ transport });
    expect((await client.campaignGoals([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("goal chunking", () => {
  const goals = Array.from({ length: 11 }, (_, i) => i + 1);

  function chunkTransport() {
    const calls: Array<{ service: string; method: string; params: Record<string, unknown> }> = [];
    const reports: Array<{ params: Record<string, unknown>; text: string }> = [];
    const transport: DirectTransport = {
      call: async (service, method, params) => {
        calls.push({ service, method, params: params as Record<string, unknown> });
        if (service !== "campaigns" || method !== "get") return {};
        const ids = (params as { SelectionCriteria?: { Ids?: number[] } }).SelectionCriteria?.Ids ?? [1];
        return {
          Campaigns: ids.map((id) => ({
            Id: id,
            TextCampaign: { PriorityGoals: { Items: goals.map((goal) => ({ GoalId: goal })) } },
          })),
        };
      },
      report: async (params) => {
        const chunk = ((params as { Goals?: string[] }).Goals ?? []).map(Number);
        const row =
          chunk.length === 10
            ? ["2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "SEARCH", "100", "50", "1000",
               ...chunk.map(() => "0"), ...chunk.map(() => "0")]
            : ["2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "SEARCH", "100", "50", "1000",
               ...chunk.map((goal) => (goal === 11 ? "5" : "0")),
               ...chunk.map((goal) => (goal === 11 ? "200" : "0"))];
        const text = perfTsv(chunk, [row]);
        reports.push({ params: params as Record<string, unknown>, text });
        return text;
      },
    };
    return { transport, calls, reports };
  }

  it("splits eleven goals into two reports and counts spend once", async () => {
    const { transport, reports } = chunkTransport();
    const client = createDirectClient({ transport });
    const rows = await client.performanceReport({
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
      goals,
    });
    expect(reports).toHaveLength(2);
    expect((reports[0].params.Goals as string[]).map(Number)).toEqual(goals.slice(0, 10));
    expect(reports[1].params.Goals).toEqual(["11"]);
    const summary = summarize(rows, goals);
    expect(summary.totals.cost).toBe(1000);
    expect(summary.totals.clicks).toBe(50);
    expect(summary.totals.conversions).toBe(5);
    expect(summary.totals.cpa).toBe(200);
    expect(recommend(summary).filter((r) => r.kind === "zeroConversions")).toEqual([]);
  });

  it("runAnalytics discovers all eleven goals through campaigns.get", async () => {
    const { transport, calls, reports } = chunkTransport();
    const client = createDirectClient({ transport });
    const result = await runAnalytics(client, { from: "2026-11-03", to: "2026-11-03" });
    expect(result.goals).toEqual(goals);
    expect(reports).toHaveLength(2);
    expect(reports[1].params.Goals).toEqual(["11"]);
    expect(result.summary.totals.cpa).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["get", "get"]);
  });
});

describe("duplicate goals", () => {
  const dupGoals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1];

  it("deduplicates explicit goals before reporting and aggregation", async () => {
    const reports: Array<{ params: Record<string, unknown>; text: string }> = [];
    const transport: DirectTransport = {
      call: async () => ({}),
      report: async (params) => {
        const chunk = ((params as { Goals?: string[] }).Goals ?? []).map(Number);
        const text = perfTsv(chunk, [
          [
            "2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "SEARCH", "100", "50", "1000",
            ...chunk.map((goal) => (goal === 1 ? "5" : "0")),
            ...chunk.map((goal) => (goal === 1 ? "200" : "0")),
          ],
        ]);
        reports.push({ params: params as Record<string, unknown>, text });
        return text;
      },
    };
    const client = createDirectClient({ transport });
    const result = await runAnalytics(client, {
      from: "2026-11-03",
      to: "2026-11-03",
      goals: dupGoals,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].params.Goals).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(result.goals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.summary.totals.cost).toBe(1000);
    expect(result.summary.totals.clicks).toBe(50);
    expect(result.summary.totals.conversions).toBe(5);
    expect(result.summary.totals.cpa).toBe(200);
    expect(result.summary.byGoal).toHaveLength(10);
  });

  it("summarize counts a repeated goal id once", () => {
    const summary = summarize(
      [
        {
          Date: "2026-11-03",
          CampaignId: 1,
          CampaignName: "Camp A",
          CampaignType: "TEXT_CAMPAIGN",
          AdNetworkType: "SEARCH",
          Impressions: 100,
          Clicks: 50,
          Cost: 1000,
          Conversions_1_AUTO: 5,
        },
      ],
      [1, 1],
    );
    expect(summary.totals.conversions).toBe(5);
    expect(summary.totals.cpa).toBe(200);
    expect(summary.byGoal).toEqual([{ goalId: 1, conversions: 5, cpa: 200 }]);
  });
});

describe("runAnalytics goal selection", () => {
  it("sends no Goals when the caller passes an empty list", async () => {
    let captured: Record<string, unknown> | undefined;
    const calls: string[] = [];
    const transport: DirectTransport = {
      call: async (_service, method) => {
        calls.push(method);
        return {};
      },
      report: async (params) => {
        captured = params as Record<string, unknown>;
        return perfTsv([], [
          ["2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "SEARCH", "10", "2", "50", "1", "50"],
        ]);
      },
    };
    const client = createDirectClient({ transport });
    const result = await runAnalytics(client, {
      from: "2026-11-03",
      to: "2026-11-03",
      goals: [],
    });
    expect(result.goals).toEqual([]);
    expect("Goals" in (captured ?? {})).toBe(false);
    expect("AttributionModels" in (captured ?? {})).toBe(false);
    expect(result.summary.totals.conversions).toBe(1);
    expect(calls).toEqual([]);
  });

  it("resolves goals from campaigns when omitted and sends them as strings", async () => {
    let captured: Record<string, unknown> | undefined;
    const calls: string[] = [];
    const transport: DirectTransport = {
      call: async (service, method, params) => {
        calls.push(method);
        if (service !== "campaigns") return {};
        const ids = (params as { SelectionCriteria?: { Ids?: number[] } }).SelectionCriteria?.Ids;
        if (!ids) return { Campaigns: [{ Id: 1 }, { Id: 2 }] };
        return {
          Campaigns: [
            { Id: 1, TextCampaign: { PriorityGoals: { Items: [{ GoalId: 123 }] } } },
            { Id: 2, UnifiedCampaign: { PriorityGoals: { Items: [{ GoalId: 456 }] } } },
          ],
        };
      },
      report: async (params) => {
        captured = params as Record<string, unknown>;
        return perfTsv([123, 456], [
          ["2026-11-03", "1", "Camp A", "TEXT_CAMPAIGN", "SEARCH", "10", "2", "50", "1", "1", "50", "50"],
        ]);
      },
    };
    const client = createDirectClient({ transport });
    const result = await runAnalytics(client, { from: "2026-11-03", to: "2026-11-03" });
    expect(result.goals).toEqual([123, 456]);
    expect(captured?.Goals).toEqual(["123", "456"]);
    expect(captured?.AttributionModels).toEqual(["AUTO"]);
    expect(calls).toEqual(["get", "get"]);
  });

  it("discovers goals of archived campaigns so their conversions are counted", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const transport: DirectTransport = {
      call: async (service, method, params) => {
        calls.push(params as Record<string, unknown>);
        const criteria = (params as { SelectionCriteria?: Record<string, unknown> })
          .SelectionCriteria;
        if (criteria?.Ids) {
          return {
            Campaigns: (criteria.Ids as number[]).map((id) => ({
              Id: id,
              TextCampaign: {
                PriorityGoals: { Items: [{ GoalId: id === 2 ? 111 : 222 }] },
              },
            })),
          };
        }
        const states = (criteria?.States as string[] | undefined) ?? ["ON", "SUSPENDED", "OFF"];
        const campaigns: { Id: number }[] = [];
        if (states.includes("ON")) campaigns.push({ Id: 1 });
        if (states.includes("ARCHIVED")) campaigns.push({ Id: 2 });
        return { Campaigns: campaigns };
      },
      report: async (params) => {
        const goals = ((params as { Goals?: string[] }).Goals ?? []).map(Number);
        return perfTsv(goals, [
          [
            "2026-11-03", "2", "Old Camp", "TEXT_CAMPAIGN", "SEARCH", "100", "50", "1000",
            ...goals.map((goal) => (goal === 111 ? "5" : "0")),
            ...goals.map((goal) => (goal === 111 ? "200" : "0")),
          ],
        ]);
      },
    };
    const client = createDirectClient({ transport });
    const result = await runAnalytics(client, { from: "2026-11-03", to: "2026-11-03" });
    const states = (calls[0].SelectionCriteria as { States: string[] }).States;
    expect(states).toEqual(expect.arrayContaining(["ON", "SUSPENDED", "OFF", "ENDED", "ARCHIVED", "CONVERTED"]));
    expect(result.goals).toEqual([111, 222]);
    expect(result.summary.totals.conversions).toBe(5);
    expect(result.summary.totals.cpa).toBe(200);
    expect(result.recommendations.filter((r) => r.kind === "zeroConversions")).toEqual([]);
  });

  it("discovers goals of campaigns on the second page", async () => {
    const reports: Array<Record<string, unknown>> = [];
    let listCalls = 0;
    const transport: DirectTransport = {
      call: async (service, method, params) => {
        if (service !== "campaigns" || method !== "get") return {};
        const p = params as {
          SelectionCriteria?: { Ids?: number[] };
        };
        if (p.SelectionCriteria?.Ids) {
          return {
            Campaigns: p.SelectionCriteria.Ids.map((id) => ({
              Id: id,
              TextCampaign: {
                PriorityGoals: { Items: id === 2 ? [{ GoalId: 456 }] : [] },
              },
            })),
          };
        }
        listCalls += 1;
        return listCalls === 1
          ? { Campaigns: [{ Id: 1 }], LimitedBy: 10000 }
          : { Campaigns: [{ Id: 2 }] };
      },
      report: async (params) => {
        reports.push(params as Record<string, unknown>);
        const goals = ((params as { Goals?: string[] }).Goals ?? []).map(Number);
        return perfTsv(goals, [
          [
            "2026-11-03", "2", "Camp B", "TEXT_CAMPAIGN", "SEARCH", "100", "10", "1000",
            ...goals.map((goal) => (goal === 456 ? "5" : "0")),
            ...goals.map((goal) => (goal === 456 ? "200" : "0")),
          ],
        ]);
      },
    };
    const client = createDirectClient({ transport });
    const result = await runAnalytics(client, { from: "2026-11-03", to: "2026-11-03" });
    expect(listCalls).toBe(2);
    expect(result.goals).toEqual([456]);
    expect(reports).toHaveLength(1);
    expect(reports[0].Goals).toEqual(["456"]);
    expect(result.summary.totals.conversions).toBe(5);
    expect(result.summary.totals.cpa).toBe(200);
    expect(
      result.recommendations.filter((r) => r.campaignId === 2 && r.kind === "zeroConversions"),
    ).toEqual([]);
  });
});

describe("summarize", () => {
  it("computes ctr, cpc and cpa and keeps search metrics on SEARCH rows only", () => {
    const summary = summarize([
      {
        Date: "2026-11-03",
        CampaignId: 1,
        CampaignName: "Camp A",
        CampaignType: "TEXT_CAMPAIGN",
        AdNetworkType: "SEARCH",
        Impressions: 200,
        Clicks: 10,
        Cost: 100,
        Conversions: 5,
      },
      {
        Date: "2026-11-03",
        CampaignId: 1,
        CampaignName: "Camp A",
        CampaignType: "TEXT_CAMPAIGN",
        AdNetworkType: "AD_NETWORK",
        Impressions: 300,
        Clicks: 30,
        Cost: 300,
        Conversions: 5,
      },
    ]);
    expect(summary.totals.impressions).toBe(500);
    expect(summary.totals.clicks).toBe(40);
    expect(summary.totals.cost).toBe(400);
    expect(summary.totals.conversions).toBe(10);
    expect(summary.totals.ctr).toBe(8);
    expect(summary.totals.cpc).toBe(10);
    expect(summary.totals.cpa).toBe(40);
    expect(summary.byCampaign).toHaveLength(1);
    expect(summary.byCampaign[0].searchImpressions).toBe(200);
    expect(summary.byCampaign[0].searchClicks).toBe(10);
    expect(summary.byCampaign[0].searchCtr).toBe(5);
    expect(summary.byDay).toHaveLength(1);
    expect(summary.byGoal).toEqual([]);
  });

  it("returns null cpa at zero conversions", () => {
    const rows: SearchQueryRow[] = [
      {
        Date: "2026-11-03",
        CampaignId: 1,
        CampaignName: "Camp A",
        CampaignType: "TEXT_CAMPAIGN",
        AdNetworkType: "SEARCH",
        Impressions: 100,
        Clicks: 2,
        Cost: 50,
        Conversions: 0,
      },
    ];
    const summary = summarize(rows);
    expect(summary.totals.cpa).toBeNull();
    expect(summary.byCampaign[0].cpa).toBeNull();
    expect(summary.totals.ctr).toBe(2);
  });
});

describe("recommend", () => {
  const summary = summarize([
    {
      Date: "2026-11-03",
      CampaignId: 1,
      CampaignName: "A",
      CampaignType: "TEXT_CAMPAIGN",
      AdNetworkType: "SEARCH",
      Impressions: 2000,
      Clicks: 100,
      Cost: 3000,
      Conversions: 30,
    },
    {
      Date: "2026-11-03",
      CampaignId: 2,
      CampaignName: "B",
      CampaignType: "TEXT_CAMPAIGN",
      AdNetworkType: "SEARCH",
      Impressions: 1500,
      Clicks: 60,
      Cost: 1000,
      Conversions: 0,
    },
    {
      Date: "2026-11-03",
      CampaignId: 3,
      CampaignName: "C",
      CampaignType: "TEXT_CAMPAIGN",
      AdNetworkType: "SEARCH",
      Impressions: 1500,
      Clicks: 60,
      Cost: 2400,
      Conversions: 8,
    },
  ]);

  it("flags spend without conversions and CPA above 1.5x the account CPA, not a healthy campaign", () => {
    expect(summary.totals.cpa).toBeCloseTo(6400 / 38);
    const byName = new Map(recommend(summary).map((r) => [r.campaignName, r]));
    expect(byName.get("B")?.kind).toBe("zeroConversions");
    expect(byName.get("B")?.value).toBe(1000);
    expect(byName.get("C")?.kind).toBe("highCpa");
    expect(byName.has("A")).toBe(false);
  });

  it("flags zero conversions for any positive spend", () => {
    const single = summarize([
      {
        Date: "2026-11-03",
        CampaignId: 1,
        CampaignName: "Solo",
        CampaignType: "TEXT_CAMPAIGN",
        AdNetworkType: "SEARCH",
        Impressions: 100,
        Clicks: 10,
        Cost: 500,
        Conversions: 0,
      },
    ]);
    expect(recommend(single)).toEqual([
      { campaignId: 1, campaignName: "Solo", kind: "zeroConversions", value: 500, threshold: 0 },
    ]);

    const mixed = summarize([
      {
        Date: "2026-11-03",
        CampaignId: 1,
        CampaignName: "A",
        CampaignType: "TEXT_CAMPAIGN",
        AdNetworkType: "SEARCH",
        Impressions: 100,
        Clicks: 10,
        Cost: 1000,
        Conversions: 10,
      },
      {
        Date: "2026-11-03",
        CampaignId: 2,
        CampaignName: "B",
        CampaignType: "TEXT_CAMPAIGN",
        AdNetworkType: "SEARCH",
        Impressions: 100,
        Clicks: 5,
        Cost: 200,
        Conversions: 0,
      },
    ]);
    // Account CPA is 120 ₽, so B's 200 ₽ spend is below twice the account CPA.
    expect(recommend(mixed)).toEqual([
      { campaignId: 2, campaignName: "B", kind: "zeroConversions", value: 200, threshold: 0 },
    ]);
  });
});

describe("recommendationText", () => {
  it("renders a costShare recommendation with percent values", () => {
    const recommendation: Recommendation = {
      campaignId: 1,
      campaignName: "Camp A",
      kind: "costShare",
      value: 0.9,
      threshold: 0.2,
    };
    const text = recommendationText(recommendation, en);
    expect(text).toContain("Camp A");
    expect(text).toContain("90%");
    expect(text).toContain("20%");
    expect(recommendationText(recommendation, ru)).toContain("90%");
  });
});
