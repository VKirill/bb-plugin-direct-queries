import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations, loadBidState, saveBidState } from "../db.ts";
import { createDirectClient, type DirectTransport, type KeywordBid } from "../direct.ts";
import { recordChange } from "../history.ts";
import type { Project } from "../model.ts";
import type { JevRequest } from "../judge.ts";
import { fixturePipelineProject } from "./fixtures/projects.ts";
import {
  choose,
  cutFloor,
  ladder,
  options,
  runBids,
  type BidCase,
  type BidsAsk,
  type BidsDeps,
} from "../bids.ts";

vi.mock("../history.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../history.ts")>();
  return { ...mod, recordChange: vi.fn() };
});
const recordChangeMock = vi.mocked(recordChange);

const DAY = "2026-11-04";
const NOW = Date.parse("2026-11-04T06:03:00Z");
const MICRO = 1_000_000;

const point = (volume: number, bid: number, price = 0) => ({
  TrafficVolume: volume,
  Bid: bid,
  Price: price,
});

const FORECAST = [
  point(85, 8_000_000),
  point(90, 9_000_000),
  point(95, 10_000_000),
  point(100, 12_000_000),
  point(110, 15_000_000),
  point(120, 20_000_000),
];

const kwBid = (
  keywordId: number,
  campaignId: number,
  bid: number,
  items: ReturnType<typeof point>[],
  adGroupId = 1,
): KeywordBid => ({
  KeywordId: keywordId,
  CampaignId: campaignId,
  AdGroupId: adGroupId,
  ServingStatus: "ELIGIBLE",
  Search: { Bid: bid, AuctionBids: { AuctionBidItems: items } },
});

const kw = (id: number, text: string, campaignId = 11) => ({
  Id: id,
  Keyword: text,
  CampaignId: campaignId,
  AdGroupId: 1,
  State: "ON",
});

const campaign = (id: number, name: string, state = "ON") => ({
  Id: id,
  Name: name,
  State: state,
  Status: "ACCEPTED",
  Type: "TEXT_CAMPAIGN",
});

const reportTsv = (rows: [number, number, number | string][]): string =>
  [
    "CriterionId\tImpressions\tAvgImpressionPosition",
    ...rows.map(([id, imp, pos]) => `${id}\t${imp}\t${pos}`),
    "",
  ].join("\n");

type Call = { service: string; method: string; params: Record<string, any> };

interface FakeHandlers {
  campaigns?: ReturnType<typeof campaign>[];
  keywordBids?: Record<number, KeywordBid[]>;
  keywords?: ReturnType<typeof kw>[];
  reportTsv?: string;
  setResults?: (items: { KeywordId: number; SearchBid: number }[]) => unknown[];
  keywordBidsError?: Record<number, Error>;
}

function fakeDirect(handlers: FakeHandlers) {
  const calls: Call[] = [];
  const transport: DirectTransport = {
    call: async (service, method, params) => {
      calls.push({ service, method, params: params as Record<string, any> });
      if (service === "campaigns" && method === "get") {
        return { Campaigns: handlers.campaigns ?? [] };
      }
      if (service === "keywordbids" && method === "get") {
        const criteria = (params as any).SelectionCriteria ?? {};
        const ids = (criteria.CampaignIds ?? []) as number[];
        const out: KeywordBid[] = [];
        for (const id of ids) {
          const err = handlers.keywordBidsError?.[id];
          if (err) throw err;
          out.push(...(handlers.keywordBids?.[id] ?? []));
        }
        return { KeywordBids: out };
      }
      if (service === "keywords" && method === "get") {
        return { Keywords: handlers.keywords ?? [] };
      }
      if (service === "keywordbids" && method === "set") {
        const items = ((params as any).KeywordBids ?? []) as {
          KeywordId: number;
          SearchBid: number;
        }[];
        return {
          SetResults: handlers.setResults
            ? handlers.setResults(items)
            : items.map(() => ({})),
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

const bidsOf = (calls: Call[], service: string, method: string) =>
  calls.filter((c) => c.service === service && c.method === method);

const openDb = () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
};

const bidsProject = (
  bids?: { enabled?: boolean; apply?: boolean; skipCampaigns?: string[] },
  pipeExtra: Record<string, unknown> = {},
): Project => {
  const base = fixturePipelineProject();
  return {
    ...base,
    pipeline: {
      ...base.pipeline!,
      ...(bids === undefined ? {} : { bids }),
      ...pipeExtra,
    } as Project["pipeline"],
  };
};

const profile = {
  site: "https://gamma.example/",
  company: "Gamma",
  buyer: "Buyers",
  offers: ["Offer"],
  advertising_goal: "Orders",
  boundaries: ["Off-topic"],
};

const mkCase = (over: Partial<BidCase> = {}): BidCase => ({
  keywordId: 101,
  keyword: "купить фильтр",
  campaign: "Поиск",
  campaignId: 11,
  bid: 10_000_000,
  direction: "up",
  options: [
    { volume: 100, bid: 12_000_000, price: 0 },
    { volume: 110, bid: 15_000_000, price: 0 },
    { volume: 120, bid: 20_000_000, price: 0 },
  ],
  position: 4.2,
  impressions: 50,
  volume: 95,
  price: 0,
  need: 10_000_000,
  ...over,
});

const stubSheets = (opts: { failAppend?: boolean } = {}) => {
  const calls = {
    appendValues: [] as { range: string; values: unknown[][] }[],
    addTab: [] as string[],
    readValues: [] as string[],
  };
  const tabs = new Map<string, { sheetId: number; title: string }>([
    ["Ставки", { sheetId: 7, title: "Ставки" }],
  ]);
  const client = {
    metadata: async () => ({ tabs, sheets: [...tabs.values()] }),
    readValues: async (_id: string, range: string) => {
      calls.readValues.push(range);
      if (range === "'Ставки'!A1:Z1") return [["Время"]];
      return [];
    },
    appendValues: async (_id: string, range: string, values: unknown[][]) => {
      if (opts.failAppend) throw new Error("sheet exploded");
      calls.appendValues.push({ range, values });
    },
    addTab: async (_id: string, title: string) => {
      calls.addTab.push(title);
      return 9;
    },
  };
  return { client, calls };
};

beforeEach(() => {
  recordChangeMock.mockClear();
});

describe("ladder", () => {
  it("returns ascending points covering every level", () => {
    const points = ladder(FORECAST);
    expect(points.map((p) => p.bid)).toEqual([
      8_000_000, 9_000_000, 10_000_000, 12_000_000, 15_000_000, 20_000_000,
    ]);
    expect(points.map((p) => p.volume)).toEqual([85, 90, 95, 100, 110, 120]);
  });

  it("keeps the cheapest bid per level and adds the forecast top", () => {
    const points = ladder([
      point(95, 20_000_000),
      point(95, 12_000_000),
      point(100, 15_000_000),
      point(130, 25_000_000),
    ]);
    expect(points.map((p) => p.bid)).toEqual([12_000_000, 15_000_000, 25_000_000]);
    expect(points.some((p) => p.bid === 25_000_000)).toBe(true);
  });
});

describe("options", () => {
  const points = ladder(FORECAST);

  it("up returns at most 3 points above the current bid", () => {
    expect(options(points, 10_000_000, "up", 95).map((p) => p.bid)).toEqual([
      12_000_000, 15_000_000, 20_000_000,
    ]);
    expect(options(points, 9_000_000, "up", 95).map((p) => p.bid)).toEqual([
      10_000_000, 12_000_000, 15_000_000,
    ]);
    expect(options(points, 20_000_000, "up", 95)).toEqual([]);
  });

  it("down keeps only points at or above the floor volume, nearest first", () => {
    const down = options(points, 20_000_000, "down", 95);
    expect(down.map((p) => p.bid)).toEqual([15_000_000, 12_000_000, 10_000_000]);
    expect(down.every((p) => p.volume >= 95)).toBe(true);
    expect(down.every((p) => p.bid < 20_000_000)).toBe(true);
  });
});

describe("cutFloor", () => {
  it("caps a lowering at 70% in 10000-micro steps", () => {
    expect(cutFloor(20_000_000)).toBe(14_000_000);
    expect(cutFloor(11_000_000)).toBe(7_700_000);
    expect(cutFloor(10_010_000)).toBe(7_010_000);
  });
});

describe("choose", () => {
  const askThat = (answers: Record<string, unknown>, backend?: () => string | undefined): BidsAsk =>
    Object.assign(async (_req: JevRequest) => answers as never, backend ? { backend } : {});

  it("sends batched choice questions and maps cN to options", async () => {
    let seen: JevRequest | undefined;
    const ask: BidsAsk = async (req) => {
      seen = req;
      return { bid_0: { choice: "c2", confidence: 0.8 } };
    };
    const { picks, judge } = await choose([mkCase()], async () => ask, profile);
    expect(picks.get(101)?.point?.bid).toBe(15_000_000);
    expect(picks.get(101)?.confidence).toBe(0.8);
    expect(judge).toBe("gemini");
    expect(seen?.state.items).toEqual([
      { keyword: "купить фильтр", campaign: "Поиск", average_position: 4.2, impressions: 50 },
    ]);
    expect(Object.keys(seen?.questions ?? {})).toEqual(["bid_0"]);
    const q = (seen?.questions as Record<string, any>).bid_0;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual(["c0", "c1", "c2", "c3"]);
  });

  it("c0 keeps the bid, backend label is reported", async () => {
    const ask = askThat({ bid_0: { choice: "c0", confidence: 0.5 } }, () => "typesafe");
    const { picks, judge } = await choose([mkCase()], async () => ask, profile);
    expect(picks.get(101)?.point).toBeNull();
    expect(judge).toBe("typesafe");
  });

  it("falls back to the first option when the judge fails or answers garbage", async () => {
    const throwing = await choose([mkCase()], async () => {
      throw new Error("no key");
    }, profile);
    expect(throwing.picks.get(101)?.point?.bid).toBe(12_000_000);
    expect(throwing.judge).toBe("fallback");

    const bad = await choose(
      [mkCase()],
      async () => askThat({ bid_0: { choice: "c9", confidence: 1 } }),
      profile,
    );
    expect(bad.picks.get(101)?.point?.bid).toBe(12_000_000);
    expect(bad.judge).toBe("fallback");

    const askFails = await choose(
      [mkCase()],
      async () =>
        (async () => {
          throw new Error("jev down");
        }) as BidsAsk,
      profile,
    );
    expect(askFails.picks.get(101)?.point?.bid).toBe(12_000_000);
    expect(askFails.judge).toBe("fallback");
  });
});

describe("runBids decisions", () => {
  const handlers = (over: Partial<FakeHandlers> = {}): FakeHandlers => ({
    campaigns: [campaign(11, "Поиск Основная")],
    keywordBids: { 11: [kwBid(101, 11, 12_000_000, FORECAST)] },
    keywords: [kw(101, "[купить фильтр] -бесплатно")],
    reportTsv: reportTsv([[101, 30, 4.2]]),
    ...over,
  });

  const run = async (
    h: FakeHandlers,
    opts: {
      bids?: { enabled?: boolean; apply?: boolean; skipCampaigns?: string[] };
      pipeExtra?: Record<string, unknown>;
      ask?: BidsDeps["ask"];
      db?: Database.Database;
      sheets?: BidsDeps["sheets"];
      dryRun?: boolean;
    } = {},
  ) => {
    const fake = fakeDirect(h);
    const db = opts.db ?? openDb();
    const deps: BidsDeps = {
      now: () => NOW,
      db,
      client: async () => fake.client,
      ask: opts.ask ?? (async () => async () => ({})),
      sheets: opts.sheets,
    };
    const out = await runBids(deps, bidsProject(opts.bids ?? { enabled: true, apply: false }, opts.pipeExtra), DAY, {
      trigger: "schedule",
      runId: "run-1",
      attempt: 1,
      dryRun: opts.dryRun,
    });
    return { ...out, calls: fake.calls, db };
  };

  it("a bid below the 95% level jumps there without asking the judge", async () => {
    const forecast = [
      point(85, 4_000_000),
      point(90, 5_000_000),
      point(95, 7_000_000),
      point(100, 9_000_000),
      point(110, 12_000_000),
      point(120, 18_000_000),
    ];
    const ask = vi.fn();
    const { changes, rows } = await run(
      handlers({
        keywordBids: { 11: [kwBid(101, 11, 6_000_000, forecast)] },
        reportTsv: reportTsv([[101, 30, 1.2]]),
      }),
      { ask: async () => ask as never },
    );
    expect(ask).not.toHaveBeenCalled();
    expect(changes).toHaveLength(1);
    expect(changes[0].newBid).toBe(7_000_000);
    expect(changes[0].oldBid).toBe(6_000_000);
    expect(changes[0].reason).toContain("трафик");
    expect(rows[0].status).toBe("ok");
  });

  it("position 4.2 asks the judge and sets the chosen step", async () => {
    const ask: BidsAsk = async () => ({ bid_0: { choice: "c1", confidence: 0.9 } });
    const { changes } = await run(handlers(), { ask: async () => ask });
    expect(changes).toHaveLength(1);
    expect(changes[0].newBid).toBe(15_000_000);
    expect(changes[0].oldBid).toBe(12_000_000);
  });

  it("a judge failure takes the first option", async () => {
    const ask: BidsAsk = async () => {
      throw new Error("down");
    };
    const { changes } = await run(
      handlers({
        keywordBids: { 11: [kwBid(101, 11, 10_000_000, FORECAST)] },
      }),
      { ask: async () => ask },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].newBid).toBe(12_000_000);
    expect(changes[0].reason).toContain("Jev недоступен");
  });

  it("a lowering is capped at 30% per run in 10000-micro steps", async () => {
    const ask: BidsAsk = async () => ({ bid_0: { choice: "c3", confidence: 1 } });
    const { changes } = await run(
      handlers({
        keywordBids: { 11: [kwBid(101, 11, 20_000_000, FORECAST)] },
        reportTsv: reportTsv([[101, 20, 1.2]]),
      }),
      { ask: async () => ask },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].newBid).toBe(14_000_000);
    expect(changes[0].newBid % 10_000).toBe(0);
    expect(changes[0].reason).toContain("30%");
  });

  it("a low bid floors the lowering at 5.01 ₽", async () => {
    const forecast = [
      point(85, 2_000_000),
      point(90, 2_500_000),
      point(95, 3_000_000),
      point(100, 4_000_000),
      point(110, 5_000_000),
      point(120, 8_000_000),
    ];
    const ask: BidsAsk = async () => ({ bid_0: { choice: "c3", confidence: 1 } });
    const { changes } = await run(
      handlers({
        keywordBids: { 11: [kwBid(101, 11, 6_000_000, forecast)] },
        reportTsv: reportTsv([[101, 20, 1.2]]),
      }),
      { ask: async () => ask },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].newBid).toBe(5_010_000);
  });
});

describe("runBids writes", () => {
  const handlers = (over: Partial<FakeHandlers> = {}): FakeHandlers => ({
    campaigns: [campaign(11, "Поиск Основная")],
    keywordBids: { 11: [kwBid(101, 11, 12_000_000, FORECAST)] },
    keywords: [kw(101, "[купить фильтр] -бесплатно")],
    reportTsv: reportTsv([[101, 30, 4.2]]),
    ...over,
  });
  const goodAsk: BidsDeps["ask"] = async () =>
    (async () => ({ bid_0: { choice: "c1", confidence: 0.9 } })) as BidsAsk;

  const run = async (
    h: FakeHandlers,
    opts: {
      bids?: { enabled?: boolean; apply?: boolean; skipCampaigns?: string[] };
      pipeExtra?: Record<string, unknown>;
      ask?: BidsDeps["ask"];
      db?: Database.Database;
      sheets?: BidsDeps["sheets"];
      dryRun?: boolean;
    } = {},
  ) => {
    const fake = fakeDirect(h);
    const db = opts.db ?? openDb();
    const deps: BidsDeps = {
      now: () => NOW,
      db,
      client: async () => fake.client,
      ask: opts.ask ?? goodAsk,
      sheets: opts.sheets,
    };
    const out = await runBids(deps, bidsProject(opts.bids ?? { enabled: true, apply: false }, opts.pipeExtra), DAY, {
      trigger: "schedule",
      runId: "run-1",
      attempt: 1,
      dryRun: opts.dryRun,
    });
    return { ...out, calls: fake.calls, db };
  };

  it("apply false makes no set, no recordChange, no sheet append and leaves bid_state", async () => {
    const db = openDb();
    saveBidState(db, "gamma", [
      {
        keywordId: 101,
        day: DAY,
        impressions: 5,
        weighted: 10,
        sinceImpressions: 5,
        sinceWeighted: 10,
      },
    ]);
    const before = db.prepare(`SELECT * FROM bid_state ORDER BY keyword_id`).all();
    const sheets = stubSheets();
    const { changes, rows, calls } = await run(handlers(), {
      bids: { enabled: true, apply: false },
      db,
      sheets: async () => sheets.client as never,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].newBid).toBe(15_000_000);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].firstError).toContain("proposal: 1 changes");
    expect(bidsOf(calls, "keywordbids", "set")).toHaveLength(0);
    expect(recordChangeMock).not.toHaveBeenCalled();
    expect(sheets.calls.appendValues).toHaveLength(0);
    expect(db.prepare(`SELECT * FROM bid_state ORDER BY keyword_id`).all()).toEqual(before);
  });

  it("dryRun with apply true behaves like a proposal", async () => {
    const sheets = stubSheets();
    const { rows, calls } = await run(handlers(), {
      bids: { enabled: true, apply: true },
      sheets: async () => sheets.client as never,
      dryRun: true,
    });
    expect(rows[0].status).toBe("ok");
    expect(bidsOf(calls, "keywordbids", "set")).toHaveLength(0);
    expect(recordChangeMock).not.toHaveBeenCalled();
    expect(sheets.calls.appendValues).toHaveLength(0);
  });

  it("apply true records each applied change and appends the sheet row", async () => {
    const sheets = stubSheets();
    const { changes, rows, calls } = await run(handlers(), {
      bids: { enabled: true, apply: true },
      pipeExtra: { stats: { enabled: true, sheetId: "stats-1" } },
      sheets: async () => sheets.client as never,
    });
    expect(rows[0].status).toBe("ok");
    expect(changes).toHaveLength(1);
    const setCalls = bidsOf(calls, "keywordbids", "set");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params).toEqual({
      KeywordBids: [{ KeywordId: 101, SearchBid: 15_000_000 }],
    });
    expect(recordChangeMock).toHaveBeenCalledTimes(1);
    expect(recordChangeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: "job",
        actor: "bids",
        objectType: "keyword",
        objectId: "101",
        field: "SearchBid",
        before: 12,
        after: 15,
      }),
    );
    expect(sheets.calls.appendValues).toHaveLength(1);
    const values = sheets.calls.appendValues[0].values;
    expect(values).toHaveLength(1);
    expect(values[0][0]).toContain("2026-11-04");
    expect(values[0][1]).toBe("Поиск Основная");
    expect(values[0][2]).toBe("[купить фильтр]");
    expect(values[0][3]).toBe(12);
    expect(values[0][4]).toBe(15);
  });

  it("a rejected SetResults item gets no history, no sheet row and keeps its counters", async () => {
    const sheets = stubSheets();
    const { rejected, calls } = await run(
      handlers({
        keywordBids: {
          11: [
            kwBid(101, 11, 12_000_000, FORECAST),
            kwBid(102, 11, 12_000_000, FORECAST, 2),
          ],
        },
        keywords: [kw(101, "фраза раз"), kw(102, "фраза два", 11)],
        reportTsv: reportTsv([
          [101, 30, 4.2],
          [102, 30, 4.2],
        ]),
        setResults: (items) =>
          items.map((item) =>
            item.KeywordId === 101 ? { Errors: [{ Details: "bid rejected" }] } : {},
          ),
      }),
      {
        bids: { enabled: true, apply: true },
        pipeExtra: { stats: { enabled: true, sheetId: "stats-1" } },
        sheets: async () => sheets.client as never,
      },
    );
    expect(rejected).toEqual([{ keywordId: 101, details: "bid rejected" }]);
    expect(recordChangeMock).toHaveBeenCalledTimes(1);
    expect(recordChangeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ objectId: "102" }),
    );
    const values = sheets.calls.appendValues.flatMap((c) => c.values);
    expect(values).toHaveLength(1);
    expect(String(values[0][2])).toBe("фраза два");
    const setCall = bidsOf(calls, "keywordbids", "set")[0];
    expect(setCall.params.KeywordBids).toHaveLength(2);
  });

  it("writes Direct bids even without a stats sheet configured", async () => {
    const sheets = stubSheets();
    const { rows, calls } = await run(handlers(), {
      bids: { enabled: true, apply: true },
      sheets: async () => sheets.client as never,
    });
    expect(rows[0].status).toBe("ok");
    expect(bidsOf(calls, "keywordbids", "set")).toHaveLength(1);
    expect(recordChangeMock).toHaveBeenCalledTimes(1);
    expect(sheets.calls.appendValues).toHaveLength(0);
  });

  it("a sheet failure keeps the run ok and notes the sheet", async () => {
    const sheets = stubSheets({ failAppend: true });
    const { rows } = await run(handlers(), {
      bids: { enabled: true, apply: true },
      pipeExtra: { stats: { enabled: true, sheetId: "stats-1" } },
      sheets: async () => sheets.client as never,
    });
    expect(rows[0].status).toBe("ok");
    expect(rows[0].firstError).toContain("sheet:");
    expect(recordChangeMock).toHaveBeenCalledTimes(1);
  });
});

describe("runBids scope and skips", () => {
  const goodAsk: BidsDeps["ask"] = async () =>
    (async () => ({ bid_0: { choice: "c1", confidence: 0.9 } })) as BidsAsk;

  const run = async (
    h: FakeHandlers,
    opts: {
      bids?: { enabled?: boolean; apply?: boolean; skipCampaigns?: string[] };
      pipeExtra?: Record<string, unknown>;
      ask?: BidsDeps["ask"];
      db?: Database.Database;
    } = {},
  ) => {
    const fake = fakeDirect(h);
    const deps: BidsDeps = {
      now: () => NOW,
      db: opts.db ?? openDb(),
      client: async () => fake.client,
      ask: opts.ask ?? goodAsk,
    };
    const out = await runBids(deps, bidsProject(opts.bids ?? { enabled: true, apply: false }, opts.pipeExtra), DAY, {
      trigger: "schedule",
      runId: "run-1",
      attempt: 1,
    });
    return { ...out, calls: fake.calls };
  };

  it("skips suspended campaigns and campaigns outside the filter", async () => {
    const { calls, changes } = await run(
      {
        campaigns: [
          campaign(11, "Кампания Раз"),
          campaign(12, "Кампания Два"),
          campaign(13, "Кампания Раз Три", "SUSPENDED"),
        ],
        keywordBids: {
          11: [kwBid(101, 11, 12_000_000, FORECAST)],
          12: [kwBid(102, 12, 12_000_000, FORECAST)],
          13: [kwBid(103, 13, 12_000_000, FORECAST)],
        },
        keywords: [kw(101, "фраза", 11), kw(102, "фраза", 12), kw(103, "фраза", 13)],
        reportTsv: reportTsv([[101, 30, 4.2]]),
      },
      {
        bids: { enabled: true, apply: false },
        pipeExtra: {
          campaignFilter: { ids: [11, 12, 13], nameContains: "Раз" },
        },
      },
    );
    const bidGets = bidsOf(calls, "keywordbids", "get");
    const readIds = bidGets.flatMap(
      (c) => (c.params.SelectionCriteria as any).CampaignIds as number[],
    );
    expect(readIds).toEqual([11]);
    const kwGet = bidsOf(calls, "keywords", "get")[0];
    expect((kwGet.params.SelectionCriteria as any).CampaignIds).toEqual([11]);
    const report = calls.find((c) => c.service === "reports");
    const filter = (report!.params as any).SelectionCriteria.Filter;
    expect(filter).toEqual([{ Field: "CampaignId", Operator: "IN", Values: ["11"] }]);
    expect(changes.map((c) => c.keywordId)).toEqual([101]);
  });

  it("a filter resolving to no campaigns skips the run before any keyword read", async () => {
    const { rows, calls, changes } = await run(
      {
        campaigns: [campaign(11, "Поиск")],
        keywordBids: { 11: [kwBid(101, 11, 12_000_000, FORECAST)] },
        keywords: [kw(101, "фраза")],
        reportTsv: reportTsv([[101, 30, 4.2]]),
      },
      {
        bids: { enabled: true, apply: false },
        pipeExtra: { campaignFilter: { nameContains: "нет такого" } },
      },
    );
    expect(rows[0].status).toBe("skipped");
    expect(changes).toEqual([]);
    expect(bidsOf(calls, "keywordbids", "get")).toHaveLength(0);
    expect(bidsOf(calls, "keywords", "get")).toHaveLength(0);
    expect(calls.filter((c) => c.service === "reports")).toHaveLength(0);
  });

  it("skips autotargeting, skip-listed campaigns, parked bids and thin samples", async () => {
    const forecast = FORECAST;
    const { changes } = await run(
      {
        campaigns: [campaign(11, "Поиск"), campaign(12, "Бренд По минималке")],
        keywordBids: {
          11: [
            kwBid(201, 11, 10_000_000, forecast),
            kwBid(202, 11, 12_000_000, forecast, 2),
            kwBid(203, 11, 4_000_000, forecast, 3),
            kwBid(204, 11, 12_000_000, forecast, 4),
          ],
          12: [kwBid(205, 12, 12_000_000, forecast)],
        },
        keywords: [
          kw(201, "нормальная фраза"),
          kw(202, "---autotargeting"),
          kw(203, "припаркованная"),
          kw(204, "мало показов"),
        ],
        reportTsv: reportTsv([
          [201, 30, 4.2],
          [202, 30, 4.2],
          [203, 30, 4.2],
          [204, 9, 4.2],
          [205, 30, 4.2],
        ]),
      },
      { bids: { enabled: true, apply: false } },
    );
    expect(changes.map((c) => c.keywordId)).toEqual([201]);
  });

  it("blank skip names skip nothing", async () => {
    const { changes } = await run(
      {
        campaigns: [campaign(11, "Любое имя")],
        keywordBids: { 11: [kwBid(101, 11, 12_000_000, FORECAST)] },
        keywords: [kw(101, "фраза")],
        reportTsv: reportTsv([[101, 30, 4.2]]),
      },
      { bids: { enabled: true, apply: false, skipCampaigns: ["", "   "] } },
    );
    expect(changes).toHaveLength(1);
  });
});

describe("bid_state", () => {
  it("accumulates counters between runs and resets them on an applied change", async () => {
    const db = openDb();
    const handlers = (report: string): FakeHandlers => ({
      campaigns: [campaign(11, "Поиск")],
      keywordBids: { 11: [kwBid(101, 11, 10_000_000, FORECAST)] },
      keywords: [kw(101, "фраза")],
      reportTsv: report,
    });
    const ask: BidsDeps["ask"] = async () =>
      (async () => ({ bid_0: { choice: "c1", confidence: 0.9 } })) as BidsAsk;
    const depsFor = (h: FakeHandlers): BidsDeps => ({
      now: () => NOW,
      db,
      client: async () => fakeDirect(h).client,
      ask,
    });
    const project = bidsProject({ enabled: true, apply: true });

    await runBids(depsFor(handlers(reportTsv([[101, 10, 2.0]]))), project, DAY, {
      trigger: "schedule",
      runId: "r1",
      attempt: 1,
    });
    let mem = loadBidState(db, "gamma").get(101)!;
    expect(mem.sinceImpressions).toBe(10);
    expect(mem.impressions).toBe(10);

    const h2 = handlers(reportTsv([[101, 25, 2.0]]));
    await runBids(depsFor(h2), project, DAY, {
      trigger: "schedule",
      runId: "r2",
      attempt: 1,
    });
    mem = loadBidState(db, "gamma").get(101)!;
    expect(mem.sinceImpressions).toBe(25);
    expect(mem.impressions).toBe(25);

    const h3 = handlers(reportTsv([[101, 30, 5.0]]));
    const out = await runBids(depsFor(h3), project, DAY, {
      trigger: "schedule",
      runId: "r3",
      attempt: 1,
    });
    expect(out.rows[0].status).toBe("ok");
    expect(out.changes.length).toBeGreaterThan(0);
    mem = loadBidState(db, "gamma").get(101)!;
    expect(mem.sinceImpressions).toBe(0);
    expect(mem.sinceWeighted).toBe(0);
    expect(mem.impressions).toBe(30);
  });

  it("loadBidState/saveBidState round-trips per project", () => {
    const db = openDb();
    saveBidState(db, "p1", [
      {
        keywordId: 7,
        day: DAY,
        impressions: 10,
        weighted: 25.5,
        sinceImpressions: 4,
        sinceWeighted: 9.5,
      },
    ]);
    expect(loadBidState(db, "p1").get(7)).toEqual({
      keywordId: 7,
      day: DAY,
      impressions: 10,
      weighted: 25.5,
      sinceImpressions: 4,
      sinceWeighted: 9.5,
    });
    expect(loadBidState(db, "p2").size).toBe(0);
    saveBidState(db, "p1", [
      {
        keywordId: 7,
        day: DAY,
        impressions: 20,
        weighted: 40,
        sinceImpressions: 0,
        sinceWeighted: 0,
      },
    ]);
    expect(loadBidState(db, "p1").get(7)!.sinceImpressions).toBe(0);
    expect(loadBidState(db, "p1").get(7)!.impressions).toBe(20);
  });
});
