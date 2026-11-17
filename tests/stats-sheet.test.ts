import { describe, expect, it } from "vitest";
import { createDirectClient } from "../direct.ts";
import type { HttpResponse, FetchFn } from "../yandex-oauth.ts";
import type { AccountRow } from "../db.ts";
import { fixturePipelineProject } from "./fixtures/projects.ts";
import { pipelineJobs, pipelineSchema, type Project } from "../model.ts";
import { createSheetsClient, type SheetsFetch } from "../sheets.ts";
import {
  appendRows,
  runStatsSheet,
  STATS_CORRECTIONS_TAB,
  STATS_DYNAMICS_TAB,
  STATS_HEADER,
  STATS_TAB,
  type StatsSheetDeps,
  type StatsSheets,
} from "../stats-sheet.ts";

const res = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function fakeFetch(responses: HttpResponse[]) {
  const calls: {
    url: string;
    init?: { method?: string; headers?: Record<string, string>; body?: string };
  }[] = [];
  const queue = [...responses];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  };
  return { fetch, calls };
}

type TabRef = { sheetId: number; title: string; index?: number };

function stubSheets(
  opts: { tabs?: TabRef[]; values?: Record<string, unknown[][]> } = {},
) {
  const tabs = new Map<string, TabRef>((opts.tabs ?? []).map((t) => [t.title, t]));
  const calls = {
    appendValues: [] as { range: string; values: (string | number)[][] }[],
    writeValues: [] as { range: string; values: (string | number)[][] }[],
    addTab: [] as string[],
    batchUpdate: 0,
    readValues: [] as string[],
  };
  const client: StatsSheets = {
    metadata: async () => ({ tabs, sheets: [...tabs.values()] }),
    readValues: async (_sheetId, range) => {
      calls.readValues.push(range);
      return opts.values?.[range] ?? [];
    },
    writeValues: async (_sheetId, range, values) => {
      calls.writeValues.push({ range, values });
    },
    appendValues: async (_sheetId, range, values) => {
      calls.appendValues.push({ range, values });
    },
    addTab: async (_sheetId, title) => {
      calls.addTab.push(title);
      const sheetId = 100 + calls.addTab.length;
      tabs.set(title, { sheetId, title });
      return sheetId;
    },
    batchUpdate: async () => {
      calls.batchUpdate += 1;
    },
  };
  return { client, calls };
}

const account = (): AccountRow => ({
  id: "acc-gamma",
  login: "gamma",
  isAgency: false,
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.parse("2026-11-04T00:00:00Z") + 86_400_000,
  createdAt: 1,
  source: "yandex",
});

const statsProject = (
  stats?: { enabled: boolean; sheetId?: string },
  pipelineExtra?: Partial<NonNullable<Project["pipeline"]>>,
): Project => {
  const base = fixturePipelineProject();
  return {
    ...base,
    pipeline: { ...base.pipeline!, ...(stats === undefined ? {} : { stats }), ...pipelineExtra },
  };
};

const fakeDeps = (over: Partial<StatsSheetDeps> = {}): StatsSheetDeps => ({
  now: () => Date.parse("2026-11-04T03:00:00Z"),
  getAccount: () => account(),
  ensureFresh: async (a) => a,
  keywordReport: async () => [],
  sheets: async () => {
    throw new Error("sheets not wired");
  },
  ...over,
});

const keywordRow = {
  CampaignName: "Camp A",
  Criterion: "[купить фильтр] -бесплатно -своими руками",
  Impressions: 200,
  Clicks: 20,
  Cost: 100,
  AvgImpressionPosition: 3.25,
  AvgClickPosition: 1.75,
  AvgTrafficVolume: 88,
};

describe("DirectClient.keywordReport", () => {
  it("sends CRITERIA_PERFORMANCE_REPORT with the keyword field list", async () => {
    const tsv = [
      "CampaignName\tCriterion\tImpressions\tClicks\tCost\tAvgImpressionPosition\tAvgClickPosition\tAvgTrafficVolume",
      "Camp A\t[купить фильтр] -бесплатно\t200\t20\t100\t3.25\t1.75\t88",
      "",
    ].join("\n");
    const { fetch, calls } = fakeFetch([res(200, tsv)]);
    const client = createDirectClient({ token: "t", fetch });
    const rows = await client.keywordReport({
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
    });
    const body = JSON.parse(String(calls[0].init?.body ?? "{}")) as {
      params: Record<string, unknown>;
    };
    expect(body.params.ReportType).toBe("CRITERIA_PERFORMANCE_REPORT");
    expect(body.params.FieldNames).toEqual([
      "CampaignName",
      "Criterion",
      "Impressions",
      "Clicks",
      "Cost",
      "AvgImpressionPosition",
      "AvgClickPosition",
      "AvgTrafficVolume",
    ]);
    expect(body.params.DateRangeType).toBe("CUSTOM_DATE");
    expect(body.params.Format).toBe("TSV");
    expect(rows).toHaveLength(1);
    expect(rows[0].Criterion).toBe("[купить фильтр] -бесплатно");
    expect(rows[0].Cost).toBe(100);
  });

  it("sends a CampaignId filter when campaignIds are given", async () => {
    const tsv = [
      "CampaignName\tCriterion\tImpressions\tClicks\tCost\tAvgImpressionPosition\tAvgClickPosition\tAvgTrafficVolume",
      "Camp A\tkw\t1\t1\t1\t1\t1\t1",
      "",
    ].join("\n");
    const { fetch, calls } = fakeFetch([res(200, tsv)]);
    const client = createDirectClient({ token: "t", fetch });
    await client.keywordReport({
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
      campaignIds: [101, 202],
    });
    const body = JSON.parse(String(calls[0].init?.body ?? "{}")) as {
      params: { SelectionCriteria: { Filter?: unknown } };
    };
    expect(body.params.SelectionCriteria.Filter).toEqual([
      { Field: "CampaignId", Operator: "IN", Values: ["101", "202"] },
    ]);
  });
});

describe("runStatsSheet", () => {
  it("appends one day's rows under the exact 11-column stats header", async () => {
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 1, title: STATS_TAB }],
      values: {
        [`'${STATS_TAB}'!A2:A`]: [],
        [`'${STATS_TAB}'!A1:Z1`]: [[...STATS_HEADER]],
      },
    });
    const reportCalls: unknown[] = [];
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        keywordReport: async (args) => {
          reportCalls.push(args);
          return [
            keywordRow,
            {
              CampaignName: "Camp B",
              Criterion: "plain kw",
              Impressions: 5,
              Clicks: 0,
              Cost: 0,
              AvgImpressionPosition: null,
              AvgClickPosition: null,
              AvgTrafficVolume: null,
            },
          ];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }),
      "2026-11-03",
      { trigger: "schedule", runId: "r1", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    expect(reportCalls).toHaveLength(1);
    expect(STATS_HEADER).toEqual([
      "Дата",
      "Кампания",
      "Ключевая фраза",
      "Показы",
      "Клики",
      "Расход, ₽",
      "CTR, %",
      "Ср. цена клика, ₽",
      "Ср. позиция показа",
      "Ср. позиция клика",
      "Объём трафика, %",
    ]);
    const append = calls.appendValues.find((c) => c.range === `'${STATS_TAB}'!A1`);
    expect(append).toBeDefined();
    expect(append!.values).toEqual([
      ["2026-11-03", "Camp A", "[купить фильтр] руками", 200, 20, 100, 10, 5, 3.25, 1.75, 88],
      ["2026-11-03", "Camp B", "plain kw", 5, 0, 0, 0, "", "", "", ""],
    ]);
    expect(append!.values[0]).toHaveLength(STATS_HEADER.length);
  });

  it("a second run for the same date appends nothing", async () => {
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 1, title: STATS_TAB }],
      values: { [`'${STATS_TAB}'!A2:A`]: [["2026-11-02"], ["2026-11-03"]] },
    });
    let reportCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        keywordReport: async () => {
          reportCalls += 1;
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }),
      "2026-11-03",
      { trigger: "schedule", runId: "r2", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    expect(rows[0].rowsOut).toBe(0);
    expect(reportCalls).toBe(0);
    expect(calls.appendValues).toHaveLength(0);
  });

  it("rebuilds the dynamics and by-day tabs from the stats tab", async () => {
    const statsValues = [
      [...STATS_HEADER],
      ["2026-11-02", "Camp", "kw one", 100, 10, 50, 10, 5, 2.5, 1.5, 80],
      ["2026-11-03", "Camp", "kw one", 200, 20, 100, 10, 5, 3.5, 2, 90],
    ];
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 1, title: STATS_TAB }],
      values: {
        [`'${STATS_TAB}'!A2:A`]: [["2026-11-02"], ["2026-11-03"]],
        [`'${STATS_TAB}'!A1:K`]: statsValues,
      },
    });
    const rows = await runStatsSheet(
      fakeDeps({ sheets: async () => client }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }),
      "2026-11-03",
      { trigger: "schedule", runId: "r3", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    expect(calls.addTab).toEqual([STATS_DYNAMICS_TAB, STATS_CORRECTIONS_TAB]);
    const dyn = calls.writeValues.find((c) => c.range === `'${STATS_DYNAMICS_TAB}'!A1`);
    expect(dyn?.values).toEqual([
      ["Кампания", "Ключевая фраза", "2026-11-03", "2026-11-02"],
      ["Camp", "kw one", 3.5, 2.5],
    ]);
    const corr = calls.writeValues.find((c) => c.range === `'${STATS_CORRECTIONS_TAB}'!A1`);
    expect(corr?.values).toEqual([
      ["Кампания", "Ключевая фраза", "Ставку меняли", "Показатель", "2026-11-03", "2026-11-02"],
      ["Camp", "kw one", "Нет", "Ставка на конец дня, ₽", "", ""],
      ["Camp", "kw one", "Нет", "Ср. позиция показа", 3.5, 2.5],
      ["Camp", "kw one", "Нет", "Показы", 200, 100],
      ["Camp", "kw one", "Нет", "Клики", 20, 10],
      ["Camp", "kw one", "Нет", "Цена клика, ₽", 5, 5],
      ["Camp", "kw one", "Нет", "Трафик, %", 90, 80],
    ]);
  });

  it("passes campaignFilter.ids to the keyword report", async () => {
    const { client } = stubSheets({ tabs: [] });
    const reportArgs: { campaignIds?: number[] }[] = [];
    let listCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        listCampaigns: async () => {
          listCalls += 1;
          return [];
        },
        keywordReport: async (args) => {
          reportArgs.push(args);
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }, {
        campaignFilter: { ids: [101] },
      }),
      "2026-11-03",
      { trigger: "schedule", runId: "r5", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    expect(reportArgs).toHaveLength(1);
    expect(reportArgs[0].campaignIds).toEqual([101]);
    expect(listCalls).toBe(0);
  });

  it("resolves campaignFilter.nameContains through listCampaigns", async () => {
    const { client } = stubSheets({ tabs: [] });
    const reportArgs: { campaignIds?: number[] }[] = [];
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        listCampaigns: async () => [
          { Id: 101, Name: "Alpha campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
          { Id: 202, Name: "Beta campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
        ],
        keywordReport: async (args) => {
          reportArgs.push(args);
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }, {
        campaignFilter: { nameContains: "alpha" },
      }),
      "2026-11-03",
      { trigger: "schedule", runId: "r6", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    expect(reportArgs).toHaveLength(1);
    expect(reportArgs[0].campaignIds).toEqual([101]);
  });

  it("campaignFilter.ids [] alone reports the whole account", async () => {
    const { client, calls } = stubSheets({ tabs: [] });
    const reportArgs: { campaignIds?: number[] }[] = [];
    let listCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        listCampaigns: async () => {
          listCalls += 1;
          return [];
        },
        keywordReport: async (args) => {
          reportArgs.push(args);
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }, {
        campaignFilter: { ids: [] },
      }),
      "2026-11-03",
      { trigger: "schedule", runId: "r15", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    expect(reportArgs).toHaveLength(1);
    expect(reportArgs[0].campaignIds).toBeUndefined();
    expect(listCalls).toBe(0);
    expect(
      calls.appendValues.some((c) => c.range === `'${STATS_TAB}'!A1`),
    ).toBe(true);
  });

  it("keeps look-alike keywords as separate rows in the day and dynamics tabs", async () => {
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 1, title: STATS_TAB }],
      values: { [`'${STATS_TAB}'!A2:A`]: [] },
    });
    let appended: (string | number)[][] = [];
    const stateful: StatsSheets = {
      ...client,
      appendValues: async (sheetId, range, values) => {
        await client.appendValues(sheetId, range, values);
        if (range === `'${STATS_TAB}'!A1`) appended = values;
      },
      readValues: async (sheetId, range) => {
        if (range === `'${STATS_TAB}'!A1:K`) return appended;
        return client.readValues(sheetId, range);
      },
    };
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => stateful,
        keywordReport: async () => [
          { ...keywordRow, Criterion: "00123", Impressions: 10, Clicks: 1 },
          { ...keywordRow, Criterion: "123", Impressions: 20, Clicks: 2 },
        ],
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }),
      "2026-11-03",
      { trigger: "schedule", runId: "r16", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    const append = calls.appendValues.find((c) => c.range === `'${STATS_TAB}'!A1`);
    expect(
      append!.values.filter((r) => r[0] === "2026-11-03").map((r) => r[2]),
    ).toEqual(["123", "00123"]);
    const dyn = calls.writeValues.find((c) => c.range === `'${STATS_DYNAMICS_TAB}'!A1`);
    expect(dyn?.values).toEqual([
      ["Кампания", "Ключевая фраза", "2026-11-03"],
      ["Camp A", "123", 3.25],
      ["Camp A", "00123", 3.25],
    ]);
  });

  it("a nameContains filter matching no campaign gives a skipped row with no report or append", async () => {
    const { client, calls } = stubSheets({ tabs: [] });
    let reportCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        listCampaigns: async () => [
          { Id: 101, Name: "Alpha campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
          { Id: 202, Name: "Beta campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
        ],
        keywordReport: async () => {
          reportCalls += 1;
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }, {
        campaignFilter: { nameContains: "gamma" },
      }),
      "2026-11-03",
      { trigger: "schedule", runId: "r8", attempt: 1 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].firstError).toBe("ни одна кампания не подходит под фильтр проекта");
    expect(reportCalls).toBe(0);
    expect(calls.appendValues).toHaveLength(0);
  });

  it("ids and nameContains with an empty intersection give a skipped row with no report or append", async () => {
    const { client, calls } = stubSheets({ tabs: [] });
    let reportCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        listCampaigns: async () => [
          { Id: 101, Name: "Alpha campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
          { Id: 202, Name: "Beta campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
        ],
        keywordReport: async () => {
          reportCalls += 1;
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }, {
        campaignFilter: { ids: [101], nameContains: "beta" },
      }),
      "2026-11-03",
      { trigger: "schedule", runId: "r9", attempt: 1 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].firstError).toBe("ни одна кампания не подходит под фильтр проекта");
    expect(reportCalls).toBe(0);
    expect(calls.appendValues).toHaveLength(0);
  });

  it("a recorded date with a nameContains filter matching no campaign is still skipped", async () => {
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 1, title: STATS_TAB }],
      values: { [`'${STATS_TAB}'!A2:A`]: [["2026-11-03"]] },
    });
    let reportCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        listCampaigns: async () => [
          { Id: 101, Name: "Alpha campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
          { Id: 202, Name: "Beta campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
        ],
        keywordReport: async () => {
          reportCalls += 1;
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }, {
        campaignFilter: { nameContains: "gamma" },
      }),
      "2026-11-03",
      { trigger: "schedule", runId: "r10", attempt: 1 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].firstError).toBe("ни одна кампания не подходит под фильтр проекта");
    expect(reportCalls).toBe(0);
    expect(calls.appendValues).toHaveLength(0);
  });

  it("a recorded date with an empty ids/nameContains intersection is still skipped", async () => {
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 1, title: STATS_TAB }],
      values: { [`'${STATS_TAB}'!A2:A`]: [["2026-11-03"]] },
    });
    let reportCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        listCampaigns: async () => [
          { Id: 101, Name: "Alpha campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
          { Id: 202, Name: "Beta campaign", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
        ],
        keywordReport: async () => {
          reportCalls += 1;
          return [keywordRow];
        },
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }, {
        campaignFilter: { ids: [101], nameContains: "beta" },
      }),
      "2026-11-03",
      { trigger: "schedule", runId: "r11", attempt: 1 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].firstError).toBe("ни одна кампания не подходит под фильтр проекта");
    expect(reportCalls).toBe(0);
    expect(calls.appendValues).toHaveLength(0);
  });

  it("keeps dates that have stats but no position in the derived tabs", async () => {
    const statsValues = [
      [...STATS_HEADER],
      ["2026-11-02", "Camp", "kw one", 100, 10, 50, 10, 5, "", 1.5, 80],
    ];
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 1, title: STATS_TAB }],
      values: {
        [`'${STATS_TAB}'!A2:A`]: [["2026-11-02"]],
        [`'${STATS_TAB}'!A1:K`]: statsValues,
      },
    });
    const rows = await runStatsSheet(
      fakeDeps({ sheets: async () => client }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }),
      "2026-11-02",
      { trigger: "schedule", runId: "r7", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    const dyn = calls.writeValues.find((c) => c.range === `'${STATS_DYNAMICS_TAB}'!A1`);
    expect(dyn?.values).toEqual([
      ["Кампания", "Ключевая фраза", "2026-11-02"],
      ["Camp", "kw one", ""],
    ]);
    const corr = calls.writeValues.find((c) => c.range === `'${STATS_CORRECTIONS_TAB}'!A1`);
    expect(corr?.values).toEqual([
      ["Кампания", "Ключевая фраза", "Ставку меняли", "Показатель", "2026-11-02"],
      ["Camp", "kw one", "Нет", "Ставка на конец дня, ₽", ""],
      ["Camp", "kw one", "Нет", "Ср. позиция показа", ""],
      ["Camp", "kw one", "Нет", "Показы", 100],
      ["Camp", "kw one", "Нет", "Клики", 10],
      ["Camp", "kw one", "Нет", "Цена клика, ₽", 5],
      ["Camp", "kw one", "Нет", "Трафик, %", 80],
    ]);
  });

  it("no sheetId gives a skipped row without touching sheets or Direct", async () => {
    let sheetsCalls = 0;
    let reportCalls = 0;
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => {
          sheetsCalls += 1;
          throw new Error("must not be called");
        },
        keywordReport: async () => {
          reportCalls += 1;
          return [];
        },
      }),
      statsProject({ enabled: true }),
      "2026-11-03",
      { trigger: "schedule", runId: "r4", attempt: 1 },
    );
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].firstError).toBe("no statistics sheet");
    expect(sheetsCalls).toBe(0);
    expect(reportCalls).toBe(0);
  });

  it("an empty keyword report still creates the stats, dynamics and by-day tabs", async () => {
    const { client, calls } = stubSheets({ tabs: [] });
    const rows = await runStatsSheet(
      fakeDeps({
        sheets: async () => client,
        keywordReport: async () => [],
      }),
      statsProject({ enabled: true, sheetId: "stats-sheet-1" }),
      "2026-11-03",
      { trigger: "schedule", runId: "r12", attempt: 1 },
    );
    expect(rows[0].status).toBe("ok");
    expect(calls.addTab).toEqual([STATS_TAB, STATS_DYNAMICS_TAB, STATS_CORRECTIONS_TAB]);
    const statsAppend = calls.appendValues.find((c) => c.range === `'${STATS_TAB}'!A1`);
    expect(statsAppend?.values).toEqual([[...STATS_HEADER]]);
    const dyn = calls.writeValues.find((c) => c.range === `'${STATS_DYNAMICS_TAB}'!A1`);
    expect(dyn?.values).toEqual([["Кампания", "Ключевая фраза"]]);
    const corr = calls.writeValues.find((c) => c.range === `'${STATS_CORRECTIONS_TAB}'!A1`);
    expect(corr?.values).toEqual([["Кампания", "Ключевая фраза", "Ставку меняли", "Показатель"]]);
  });

  it("a failed append after tab creation writes the header once on retry", async () => {
    const { client, calls } = stubSheets({
      tabs: [],
      values: {
        [`'${STATS_TAB}'!A1:K`]: [
          [...STATS_HEADER],
          ["2026-11-03", "Camp", "kw one", 100, 10, 50, 10, 5, 2.5, 1.5, 80],
        ],
      },
    });
    let failAppend = true;
    const flaky: StatsSheets = {
      ...client,
      appendValues: async (sheetId, range, values) => {
        if (failAppend && range === `'${STATS_TAB}'!A1`) throw new Error("append boom");
        return client.appendValues(sheetId, range, values);
      },
    };
    const deps = fakeDeps({
      sheets: async () => flaky,
      keywordReport: async () => [keywordRow],
    });
    const project = statsProject({ enabled: true, sheetId: "stats-sheet-1" });
    const first = await runStatsSheet(deps, project, "2026-11-03", {
      trigger: "schedule",
      runId: "r13",
      attempt: 1,
    });
    expect(first[0].status).toBe("failed");
    failAppend = false;
    const second = await runStatsSheet(deps, project, "2026-11-03", {
      trigger: "schedule",
      runId: "r14",
      attempt: 1,
    });
    expect(second[0].status).toBe("ok");
    const statsAppends = calls.appendValues.filter((c) => c.range === `'${STATS_TAB}'!A1`);
    expect(statsAppends).toHaveLength(1);
    expect(statsAppends[0].values[0]).toEqual([...STATS_HEADER]);
    expect(statsAppends[0].values.filter((row) => row[0] === "2026-11-03")).toHaveLength(1);
    const dyn = calls.writeValues.find((c) => c.range === `'${STATS_DYNAMICS_TAB}'!A1`);
    expect(dyn?.values).toEqual([
      ["Кампания", "Ключевая фраза", "2026-11-03"],
      ["Camp", "kw one", 2.5],
    ]);
  });
});

describe("appendRows", () => {
  it("creates a missing tab with its header", async () => {
    const { client, calls } = stubSheets({ tabs: [] });
    await appendRows(client, "sheet1", "Новый лист", ["H1", "H2"], [["a", 1]]);
    expect(calls.addTab).toEqual(["Новый лист"]);
    expect(calls.appendValues).toEqual([
      { range: "'Новый лист'!A1", values: [["H1", "H2"], ["a", 1]] },
    ]);
  });

  it("appends to an existing tab without a header", async () => {
    const { client, calls } = stubSheets({
      tabs: [{ sheetId: 3, title: "Есть" }],
      values: { "'Есть'!A1:Z1": [["H1"]] },
    });
    await appendRows(client, "sheet1", "Есть", ["H1"], [["a"], ["b"]]);
    expect(calls.addTab).toEqual([]);
    expect(calls.appendValues).toEqual([{ range: "'Есть'!A1", values: [["a"], ["b"]] }]);
  });

  it("writes the header when an existing tab has no first row", async () => {
    const { client, calls } = stubSheets({ tabs: [{ sheetId: 3, title: "Пустой" }] });
    await appendRows(client, "sheet1", "Пустой", ["H1"], [["a"]]);
    expect(calls.addTab).toEqual([]);
    expect(calls.appendValues).toEqual([
      { range: "'Пустой'!A1", values: [["H1"], ["a"]] },
    ]);
  });
});

type MemTab = { sheetId: number; title: string; rows: unknown[][] };

function memorySheet() {
  const tabs = new Map<string, MemTab>();
  const appendPosts: string[] = [];
  const state = { loseAppendResponse: false, failAppend: false };
  let nextSheetId = 1;

  const colRow = (ref: string): { col: number; row: number } => {
    const m = /^([A-Z]*)(\d*)$/.exec(ref) ?? ["", "", ""];
    let col = 0;
    for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
    return { col, row: m[2] === "" ? 0 : Number(m[2]) };
  };

  const parseRange = (range: string) => {
    const bang = range.lastIndexOf("!");
    const title = range
      .slice(0, bang)
      .replace(/^'+|'+$/g, "")
      .replace(/''/g, "'");
    const [a, b] = range.slice(bang + 1).split(":");
    const start = colRow(a);
    const end = b === undefined ? start : colRow(b);
    return {
      title,
      c1: start.col || 1,
      r1: start.row || 1,
      c2: end.col || start.col || 1,
      r2: end.row || Number.MAX_SAFE_INTEGER,
    };
  };

  const sliceValues = (
    rows: unknown[][],
    range: { c1: number; r1: number; c2: number; r2: number },
  ): unknown[][] => {
    const out: unknown[][] = [];
    const last = Math.min(range.r2, rows.length);
    for (let r = range.r1; r <= last; r++) {
      const cells = (rows[r - 1] ?? []).slice(range.c1 - 1, range.c2);
      while (
        cells.length > 0 &&
        (cells[cells.length - 1] === "" || cells[cells.length - 1] === undefined)
      ) {
        cells.pop();
      }
      out.push(cells);
    }
    while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
    return out;
  };

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const fetchFn: SheetsFetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return json({ access_token: "tok", expires_in: 3600 });
    }
    const valuesMatch = /\/values\/([^?]+)/.exec(url);
    if (valuesMatch) {
      let range = decodeURIComponent(valuesMatch[1]);
      const isAppend = range.endsWith(":append");
      const isClear = range.endsWith(":clear");
      if (isAppend || isClear) range = range.slice(0, range.lastIndexOf(":"));
      const parsed = parseRange(range);
      const tab = tabs.get(parsed.title);
      if (method === "GET") {
        return json(tab ? { values: sliceValues(tab.rows, parsed) } : {});
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        values?: unknown[][];
      };
      const vals = (body.values ?? []).map((row) => [...row]);
      if (method === "PUT") {
        if (tab) tab.rows = vals;
        return json({});
      }
      if (isAppend) {
        appendPosts.push(range);
        if (state.failAppend) throw new TypeError("fetch failed");
        if (tab) tab.rows.push(...vals);
        if (state.loseAppendResponse) {
          state.loseAppendResponse = false;
          throw new TypeError("fetch failed");
        }
        return json({ updates: { updatedRows: vals.length } });
      }
      if (isClear) {
        if (tab) tab.rows = [];
        return json({});
      }
    }
    if (url.includes(":batchUpdate")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        requests?: { addSheet?: { properties?: { title?: string } } }[];
      };
      const replies = (body.requests ?? []).map((req) => {
        const title = req.addSheet?.properties?.title;
        if (typeof title === "string" && !tabs.has(title)) {
          const sheetId = nextSheetId++;
          tabs.set(title, { sheetId, title, rows: [] });
          return { addSheet: { properties: { sheetId, title, index: 0 } } };
        }
        return {};
      });
      return json({ spreadsheetId: "sheet1", replies });
    }
    if (method === "GET" && url.includes("/spreadsheets/")) {
      return json({
        spreadsheetId: "sheet1",
        sheets: [...tabs.values()].map((t) => ({
          properties: { sheetId: t.sheetId, title: t.title, index: 0 },
        })),
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };

  return {
    fetch: fetchFn,
    state,
    appendPosts,
    seed(title: string, rows: unknown[][]) {
      const sheetId = nextSheetId++;
      tabs.set(title, { sheetId, title, rows: rows.map((row) => [...row]) });
    },
    tab(title: string): MemTab {
      const tab = tabs.get(title);
      if (!tab) throw new Error(`no tab ${title}`);
      return tab;
    },
    client: () =>
      createSheetsClient({
        clientId: "cid",
        clientSecret: "csec",
        refreshToken: "rtok",
        fetch: fetchFn,
        sleep: async () => {},
      }),
  };
}

describe("appendRows lost append response", () => {
  const statsAppends = (mem: ReturnType<typeof memorySheet>) =>
    mem.appendPosts.filter((r) => r === `'${STATS_TAB}'!A1`);

  it("a committed append with a lost response writes one copy and sends the append once", async () => {
    const mem = memorySheet();
    mem.seed(STATS_TAB, [[...STATS_HEADER]]);
    mem.state.loseAppendResponse = true;
    const deps = fakeDeps({
      sheets: async () => mem.client(),
      keywordReport: async () => [
        keywordRow,
        { ...keywordRow, Criterion: "123", Clicks: 2, Impressions: 20 },
      ],
    });
    const project = statsProject({ enabled: true, sheetId: "sheet-1" });
    const first = await runStatsSheet(deps, project, "2026-11-03", {
      trigger: "schedule",
      runId: "r20",
      attempt: 1,
    });
    expect(first[0].status).toBe("ok");
    expect(statsAppends(mem)).toHaveLength(1);
    expect(
      mem.tab(STATS_TAB).rows.filter((row) => String(row[0]) === "2026-11-03"),
    ).toHaveLength(2);
    const second = await runStatsSheet(deps, project, "2026-11-03", {
      trigger: "schedule",
      runId: "r21",
      attempt: 1,
    });
    expect(second[0].status).toBe("ok");
    expect(statsAppends(mem)).toHaveLength(1);
    expect(
      mem.tab(STATS_TAB).rows.filter((row) => String(row[0]) === "2026-11-03"),
    ).toHaveLength(2);
  });

  it("an append that fails before storing gives failed and writes no rows for the day", async () => {
    const mem = memorySheet();
    mem.seed(STATS_TAB, [[...STATS_HEADER]]);
    mem.state.failAppend = true;
    const deps = fakeDeps({
      sheets: async () => mem.client(),
      keywordReport: async () => [keywordRow],
    });
    const rows = await runStatsSheet(
      deps,
      statsProject({ enabled: true, sheetId: "sheet-1" }),
      "2026-11-03",
      { trigger: "schedule", runId: "r22", attempt: 1 },
    );
    expect(rows[0].status).toBe("failed");
    expect(statsAppends(mem)).toHaveLength(1);
    expect(
      mem.tab(STATS_TAB).rows.filter((row) => String(row[0]) === "2026-11-03"),
    ).toHaveLength(0);
  });
});

describe("stats pipeline job", () => {
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

  it("adds stats-sheet at hour 6 and stores only the sheet id from a URL", () => {
    const pipe = pipelineSchema.parse({
      ...base,
      stats: {
        enabled: true,
        sheetId: "https://docs.google.com/spreadsheets/d/1AbC_dEf-123_xyz/edit#gid=0",
      },
    });
    expect(pipe.stats?.sheetId).toBe("1AbC_dEf-123_xyz");
    const job = pipelineJobs(pipe).find((j) => j.id === "stats-sheet")!;
    expect(job.hours).toEqual([6]);
    expect(job.reportDay).toBe("yesterday");
  });

  it("has no stats-sheet job without stats", () => {
    const pipe = pipelineSchema.parse(base);
    expect(pipelineJobs(pipe).some((j) => j.id === "stats-sheet")).toBe(false);
  });
});
