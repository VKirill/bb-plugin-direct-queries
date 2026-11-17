import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db.ts";
import type { FeedbackRow } from "../db.ts";
import {
  createDirectClient,
  type DirectTransport,
  type KeywordBid,
} from "../direct.ts";
import { recordChange } from "../history.ts";
import type { Project } from "../model.ts";
import { fixturePipelineProject } from "./fixtures/projects.ts";
import {
  keywordWords,
  runKeywordGrowth,
  type KeywordGrowthDeps,
} from "../keyword-growth.ts";

vi.mock("../history.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../history.ts")>();
  return { ...mod, recordChange: vi.fn() };
});
const recordChangeMock = vi.mocked(recordChange);

const DAY = "2026-11-17";
const NOW = Date.parse("2026-11-17T03:20:00Z");

const campaign = (id: number, name: string, state = "ON") => ({
  Id: id,
  Name: name,
  State: state,
  Status: "ACCEPTED",
  Type: "TEXT_CAMPAIGN",
});

const kw = (id: number, text: string, adGroupId: number, campaignId = 11) => ({
  Id: id,
  Keyword: text,
  CampaignId: campaignId,
  AdGroupId: adGroupId,
  State: "ON",
});

const kwBid = (
  keywordId: number,
  campaignId: number,
  bid: number,
  adGroupId = 101,
): KeywordBid => ({
  KeywordId: keywordId,
  CampaignId: campaignId,
  AdGroupId: adGroupId,
  Search: { Bid: bid },
});

const fb = (query: string, decision: string, campaignName = ""): FeedbackRow => ({
  projectId: "gamma",
  query,
  campaign: campaignName,
  decision,
  comment: "",
  day: "2026-11-16",
  pulledAt: NOW,
});

const GROWTH_FIELDS = [
  "Date",
  "CampaignId",
  "CampaignName",
  "AdGroupId",
  "Query",
  "CriterionId",
  "Impressions",
  "Clicks",
];

const growthTsv = (rows: (string | number)[][]): string =>
  [
    GROWTH_FIELDS.join("\t"),
    ...rows.map((row) => row.join("\t")),
    "",
  ].join("\n");

type Call = { service: string; method: string; params: Record<string, any> };

interface FakeHandlers {
  campaigns?: ReturnType<typeof campaign>[];
  keywords?: ReturnType<typeof kw>[];
  keywordBids?: KeywordBid[];
  addResults?: (items: { AdGroupId: number; Keyword: string; Bid?: number }[]) => unknown[];
  reportTsv?: string;
}

function fakeDirect(handlers: FakeHandlers) {
  const calls: Call[] = [];
  const transport: DirectTransport = {
    call: async (service, method, params) => {
      calls.push({ service, method, params: params as Record<string, any> });
      if (service === "campaigns" && method === "get") {
        return { Campaigns: handlers.campaigns ?? [] };
      }
      if (service === "keywords" && method === "get") {
        return { Keywords: handlers.keywords ?? [] };
      }
      if (service === "keywordbids" && method === "get") {
        const criteria = (params as any).SelectionCriteria ?? {};
        const ids = (criteria.KeywordIds ?? []) as number[];
        return {
          KeywordBids: (handlers.keywordBids ?? []).filter((b) =>
            ids.includes(b.KeywordId),
          ),
        };
      }
      if (service === "keywords" && method === "add") {
        const items = ((params as any).Keywords ?? []) as {
          AdGroupId: number;
          Keyword: string;
          Bid?: number;
        }[];
        return {
          AddResults: handlers.addResults
            ? handlers.addResults(items)
            : items.map((_, i) => ({ Id: 9000 + i })),
        };
      }
      throw new Error(`unexpected ${service}.${method}`);
    },
    report: async (params) => {
      calls.push({ service: "reports", method: "report", params: params as Record<string, any> });
      return handlers.reportTsv ?? "";
    },
  };
  return { transport, calls, client: createDirectClient({ transport }) };
}

const callsTo = (calls: Call[], service: string, method: string) =>
  calls.filter((c) => c.service === service && c.method === method);

const openDb = () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
};

const stubSheets = () => {
  const calls = {
    appendValues: [] as { range: string; values: unknown[][] }[],
    addTab: [] as string[],
    readValues: [] as string[],
  };
  const client = {
    metadata: async () => ({
      tabs: new Map([["Новые фразы", { sheetId: 3, title: "Новые фразы" }]]),
      sheets: [{ sheetId: 3, title: "Новые фразы" }],
    }),
    readValues: async (_id: string, range: string) => {
      calls.readValues.push(range);
      return range === "'Новые фразы'!A1:Z1" ? [["Время"]] : [];
    },
    appendValues: async (_id: string, range: string, values: unknown[][]) => {
      calls.appendValues.push({ range, values });
    },
    addTab: async (_id: string, title: string) => {
      calls.addTab.push(title);
      return 4;
    },
  };
  return { client, calls };
};

const growthProject = (
  growth: { enabled?: boolean; apply?: boolean; minImpressions?: number; days?: number } = {
    enabled: true,
    apply: true,
  },
  pipeExtra: Record<string, unknown> = {},
): Project => {
  const base = fixturePipelineProject();
  return {
    ...base,
    pipeline: {
      ...base.pipeline!,
      keywordGrowth: growth,
      ...pipeExtra,
    } as Project["pipeline"],
  };
};

const runGrowth = async (
  handlers: FakeHandlers,
  opts: {
    growth?: Parameters<typeof growthProject>[0];
    pipeExtra?: Record<string, unknown>;
    project?: Project;
    feedback?: FeedbackRow[];
    sheets?: KeywordGrowthDeps["sheets"];
    dryRun?: boolean;
  } = {},
) => {
  const fake = fakeDirect(handlers);
  const db = openDb();
  const deps: KeywordGrowthDeps = {
    now: () => NOW,
    db,
    client: async () => fake.client,
    loadFeedback: () => opts.feedback ?? [],
    sheets: opts.sheets,
  };
  const rows = await runKeywordGrowth(
    deps,
    opts.project ?? growthProject(opts.growth, opts.pipeExtra),
    DAY,
    { trigger: "schedule", runId: "run-1", attempt: 1, dryRun: opts.dryRun },
  );
  return { rows, calls: fake.calls, db };
};

beforeEach(() => {
  recordChangeMock.mockClear();
});

describe("keywordWords", () => {
  it("drops minus words and Direct operators, then applies phraseKey", () => {
    expect(keywordWords("[очистка газ] -бу")).toBe("газ очистка");
    expect(keywordWords("Газ очистка!")).toBe("газ очистка");
    expect(keywordWords("-купить +фильтр")).toBe("фильтр");
    expect(keywordWords("очистка [газ]")).toBe("газ очистка");
  });
});

describe("runKeywordGrowth", () => {
  const happyHandlers = (over: Partial<FakeHandlers> = {}): FakeHandlers => ({
    campaigns: [campaign(11, "Поиск")],
    keywords: [],
    keywordBids: [kwBid(500, 11, 7_500_000, 101)],
    addResults: () => [{ Id: 424242 }],
    reportTsv: growthTsv([
      ["2026-11-15", 11, "Поиск", 101, "купить фильтр", 500, 7, 1],
      ["2026-11-16", 11, "Поиск", 101, "купить фильтр", 500, 3, 0],
      ["2026-11-17", 11, "Поиск", 102, "купить фильтр", 600, 2, 0],
    ]),
    ...over,
  });

  it("adds a kept query with 12 impressions to the group with most impressions at the matched keyword's bid", async () => {
    const sheets = stubSheets();
    const { rows, calls } = await runGrowth(happyHandlers(), {
      feedback: [fb("купить фильтр", "keep")],
      pipeExtra: { stats: { enabled: true, sheetId: "stats-1" } },
      sheets: async () => sheets.client as never,
    });
    expect(rows[0].status).toBe("ok");

    const report = callsTo(calls, "reports", "report");
    expect(report).toHaveLength(1);
    const params = report[0].params as {
      SelectionCriteria: {
        DateFrom: string;
        DateTo: string;
        Filter: { Field: string; Operator: string; Values: string[] }[];
      };
    };
    expect(params.SelectionCriteria.DateFrom).toBe("2026-11-13");
    expect(params.SelectionCriteria.DateTo).toBe("2026-11-17");
    expect(params.SelectionCriteria.Filter).toEqual([
      { Field: "CampaignId", Operator: "IN", Values: ["11"] },
    ]);

    const bidsCall = callsTo(calls, "keywordbids", "get");
    expect(bidsCall).toHaveLength(1);
    expect((bidsCall[0].params as any).SelectionCriteria).toEqual({
      KeywordIds: [500],
    });

    const adds = callsTo(calls, "keywords", "add");
    expect(adds).toHaveLength(1);
    expect(adds[0].params).toEqual({
      Keywords: [{ AdGroupId: 101, Keyword: "купить фильтр", Bid: 7_500_000 }],
    });

    expect(recordChangeMock).toHaveBeenCalledTimes(1);
    expect(recordChangeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: "job",
        actor: "keyword-growth",
        objectType: "keyword",
        objectId: "424242",
        campaignId: 11,
        adGroupId: 101,
        field: "Keyword",
        before: null,
        after: "купить фильтр",
      }),
    );

    expect(sheets.calls.appendValues).toHaveLength(1);
    expect(sheets.calls.appendValues[0].values).toEqual([
      ["2026-11-17 06:20", "Поиск", 101, "купить фильтр", 12, 1, 7.5, 424242],
    ]);
  });

  it("skips low impressions, minus decisions, duplicate words, long queries and out-of-scope campaigns", async () => {
    const sheets = stubSheets();
    const { rows, calls } = await runGrowth(
      {
        campaigns: [
          campaign(11, "Поиск"),
          campaign(12, "Другая"),
          campaign(13, "Архив", "SUSPENDED"),
        ],
        keywords: [kw(1, "[очистка газ] -бу", 101)],
        keywordBids: [],
        reportTsv: growthTsv([
          ["2026-11-17", 11, "Поиск", 101, "девять показов", 501, 9, 0],
          ["2026-11-17", 11, "Поиск", 101, "минус запрос", 502, 15, 0],
          ["2026-11-17", 11, "Поиск", 101, "газ очистка", 503, 12, 0],
          [
            "2026-11-17",
            11,
            "Поиск",
            101,
            "восемь слов фраза для проверки длины текста ещё",
            504,
            15,
            0,
          ],
        ]),
      },
      {
        growth: { enabled: true, apply: true },
        pipeExtra: { campaignFilter: { ids: [11, 13] } },
        feedback: [
          fb("девять показов", "keep"),
          fb("минус запрос", "keep"),
          fb("минус запрос", "minus"),
          fb("газ очистка", "keep", "Поиск"),
          fb("восемь слов фраза для проверки длины текста ещё", "keep"),
        ],
        sheets: async () => sheets.client as never,
      },
    );
    expect(rows[0].status).toBe("ok");
    expect(rows[0].rowsOut).toBe(0);

    const campaignsCall = callsTo(calls, "campaigns", "get");
    expect(
      (campaignsCall[0].params as any).SelectionCriteria.States,
    ).toEqual(["ON"]);
    const report = callsTo(calls, "reports", "report");
    expect(
      (report[0].params as any).SelectionCriteria.Filter,
    ).toEqual([{ Field: "CampaignId", Operator: "IN", Values: ["11"] }]);

    expect(callsTo(calls, "keywords", "add")).toHaveLength(0);
    expect(callsTo(calls, "keywordbids", "get")).toHaveLength(0);
    expect(recordChangeMock).not.toHaveBeenCalled();
    expect(sheets.calls.appendValues).toHaveLength(0);
  });

  it("matches a keep row whose campaign cell lists several names", async () => {
    const { rows, calls } = await runGrowth(
      {
        campaigns: [campaign(11, "Поиск")],
        keywords: [],
        keywordBids: [kwBid(500, 11, 7_500_000, 101)],
        addResults: () => [{ Id: 77 }],
        reportTsv: growthTsv([
          ["2026-11-17", 11, "Поиск", 101, "общий запрос", 500, 12, 0],
        ]),
      },
      { feedback: [fb("общий запрос", "keep", "Поиск | Архив")] },
    );
    expect(rows[0].status).toBe("ok");
    expect(callsTo(calls, "keywords", "add")).toHaveLength(1);
  });

  it("apply false and dry-run make no keywords.add, recordChange or appendRows call", async () => {
    for (const opts of [
      { growth: { enabled: true, apply: false } },
      { growth: { enabled: true, apply: true }, dryRun: true },
    ]) {
      recordChangeMock.mockClear();
      const sheets = stubSheets();
      const { rows, calls } = await runGrowth(happyHandlers(), {
        ...opts,
        feedback: [fb("купить фильтр", "keep")],
        pipeExtra: { stats: { enabled: true, sheetId: "stats-1" } },
        sheets: async () => sheets.client as never,
      });
      expect(rows[0].status).toBe("ok");
      expect(rows[0].firstError).toContain("proposal");
      expect(callsTo(calls, "keywords", "add")).toHaveLength(0);
      expect(recordChangeMock).not.toHaveBeenCalled();
      expect(sheets.calls.appendValues).toHaveLength(0);
    }
  });

  it("apply true records each added id and skips rejected AddResults items", async () => {
    const sheets = stubSheets();
    const { rows, calls } = await runGrowth(
      {
        campaigns: [campaign(11, "Поиск")],
        keywords: [],
        keywordBids: [
          kwBid(501, 11, 5_000_000, 101),
          kwBid(502, 11, 6_000_000, 101),
          kwBid(503, 11, 7_000_000, 101),
        ],
        addResults: () => [
          { Id: 1001 },
          { Errors: [{ Details: "duplicate keyword" }] },
          { Id: 1003 },
        ],
        reportTsv: growthTsv([
          ["2026-11-17", 11, "Поиск", 101, "фраза один", 501, 12, 1],
          ["2026-11-17", 11, "Поиск", 101, "фраза два", 502, 11, 0],
          ["2026-11-17", 11, "Поиск", 101, "фраза три", 503, 15, 2],
        ]),
      },
      {
        feedback: [
          fb("фраза один", "keep"),
          fb("фраза два", "keep"),
          fb("фраза три", "keep"),
        ],
        pipeExtra: { stats: { enabled: true, sheetId: "stats-1" } },
        sheets: async () => sheets.client as never,
      },
    );
    expect(rows[0].status).toBe("ok");
    expect(rows[0].firstError).toContain("rejected");

    const adds = callsTo(calls, "keywords", "add");
    expect(adds).toHaveLength(1);
    expect(adds[0].params).toEqual({
      Keywords: [
        { AdGroupId: 101, Keyword: "фраза один", Bid: 5_000_000 },
        { AdGroupId: 101, Keyword: "фраза два", Bid: 6_000_000 },
        { AdGroupId: 101, Keyword: "фраза три", Bid: 7_000_000 },
      ],
    });

    expect(recordChangeMock).toHaveBeenCalledTimes(2);
    const objectIds = recordChangeMock.mock.calls.map((c) => c[1].objectId);
    expect(objectIds).toEqual(["1001", "1003"]);

    expect(sheets.calls.appendValues).toHaveLength(1);
    const values = sheets.calls.appendValues[0].values;
    expect(values).toHaveLength(2);
    expect(values[0].at(-1)).toBe(1001);
    expect(values[1].at(-1)).toBe(1003);
  });

  it("does not append to the stats sheet without a sheetId", async () => {
    const sheets = stubSheets();
    const { rows } = await runGrowth(happyHandlers(), {
      feedback: [fb("купить фильтр", "keep")],
      pipeExtra: { stats: { enabled: true } },
      sheets: async () => sheets.client as never,
    });
    expect(rows[0].status).toBe("ok");
    expect(recordChangeMock).toHaveBeenCalledTimes(1);
    expect(sheets.calls.appendValues).toHaveLength(0);
  });

  it("skips when keywordGrowth is disabled", async () => {
    const { rows, calls } = await runGrowth(happyHandlers(), {
      growth: { enabled: false },
      feedback: [fb("купить фильтр", "keep")],
    });
    expect(rows[0].status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});
