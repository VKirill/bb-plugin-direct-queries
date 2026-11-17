import { describe, expect, it } from "vitest";
import {
  build,
  runWeeklyTree,
  SETTLE_DAYS,
  WEEKLY_TREE_HEADER,
  type WeeklyTreeRow,
} from "../weekly-tree.ts";
import { pipelineJobs, pipelineSchema, type LedgerRow, type Project } from "../model.ts";
import {
  isNightExportRunning,
  runLibrarySync,
  runPipeline,
  type PipelineDeps,
} from "../pipeline.ts";
import type { AccountRow } from "../db.ts";
import type { SearchQueryRow } from "../direct.ts";
import { fixturePipelineProject } from "./fixtures/projects.ts";

const T0300 = Date.parse("2026-11-04T00:00:00Z");

const treeRows: WeeklyTreeRow[] = [
  // week of Monday 2026-11-09
  { date: "2026-11-09", CampaignName: "Camp A", Query: "Query One", Impressions: 100, Clicks: 10, Cost: 100, AvgImpressionPosition: 2, AvgClickPosition: 1 },
  { date: "2026-11-10", CampaignName: "Camp A", Query: "Query One", Impressions: 50, Clicks: 5, Cost: 50, AvgImpressionPosition: 4, AvgClickPosition: 3 },
  { date: "2026-11-11", CampaignName: "Camp A", Query: "Query Two", Impressions: 200, Clicks: 20, Cost: 200, AvgImpressionPosition: 6, AvgClickPosition: 5 },
  { date: "2026-11-12", CampaignName: "Camp B", Query: "Query Three", Impressions: 300, Clicks: 30, Cost: 300, AvgImpressionPosition: 8, AvgClickPosition: 7 },
  { date: "2026-11-13", CampaignName: "Camp B", Query: "Query Four", Impressions: 40, Clicks: 0, Cost: 0, AvgImpressionPosition: null, AvgClickPosition: null },
  // week of Monday 2026-11-02
  { date: "2026-11-03", CampaignName: "Camp A", Query: "Query One", Impressions: 10, Clicks: 1, Cost: 10, AvgImpressionPosition: 2, AvgClickPosition: 2 },
  { date: "2026-11-04", CampaignName: "Camp C", Query: "Query Five", Impressions: 20, Clicks: 2, Cost: 20, AvgImpressionPosition: 5, AvgClickPosition: 4 },
];

describe("build", () => {
  it("returns the 15-column header and week → campaign → query totals", () => {
    expect(WEEKLY_TREE_HEADER).toEqual([
      "Неделя / кампания / запрос",
      "Показы",
      "Клики",
      "Расход, ₽",
      "Цена клика, ₽",
      "Доля расхода",
      "Ср. позиция показа",
      "Ср. позиция клика",
      "Пн, ₽",
      "Вт, ₽",
      "Ср, ₽",
      "Чт, ₽",
      "Пт, ₽",
      "Сб, ₽",
      "Вс, ₽",
    ]);
    expect(WEEKLY_TREE_HEADER).toHaveLength(15);

    const built = build(treeRows);
    expect(built.header).toEqual(WEEKLY_TREE_HEADER);
    expect(built.lines.map((line) => line.depth)).toEqual([
      0, 1, 2, 2, 1, 2, 2, 0, 1, 2, 1, 2,
    ]);
    expect(built.lines[0].values).toEqual([
      "09.11.2026 – 15.11.2026", 690, 65, 650, 10, 1, 5.8, 5.15,
      100, 50, 200, 300, 0, 0, 0,
    ]);
    expect(built.lines[1].values).toEqual([
      "Camp A", 350, 35, 350, 10, 0.5385, 4.57, 3.57,
      100, 50, 200, 0, 0, 0, 0,
    ]);
    expect(built.lines[2].values).toEqual([
      "query two", 200, 20, 200, 10, 0.3077, 6, 5,
      0, 0, 200, 0, 0, 0, 0,
    ]);
    expect(built.lines[3].values).toEqual([
      "query one", 150, 15, 150, 10, 0.2308, 2.67, 1.67,
      100, 50, 0, 0, 0, 0, 0,
    ]);
    expect(built.lines[4].values).toEqual([
      "Camp B", 340, 30, 300, 10, 0.4615, 7.06, 7,
      0, 0, 0, 300, 0, 0, 0,
    ]);
    expect(built.lines[5].values).toEqual([
      "query three", 300, 30, 300, 10, 0.4615, 8, 7,
      0, 0, 0, 300, 0, 0, 0,
    ]);
    expect(built.lines[6].values).toEqual([
      "без расхода: 1 запросов", 40, "", "", "", "", "", "",
      "", "", "", "", "", "", "",
    ]);
    expect(built.lines[7].values).toEqual([
      "02.11.2026 – 08.11.2026", 30, 3, 30, 10, 1, 4, 3.33,
      0, 10, 20, 0, 0, 0, 0,
    ]);
    expect(built.lines[8].values).toEqual([
      "Camp C", 20, 2, 20, 10, 0.6667, 5, 4,
      0, 0, 20, 0, 0, 0, 0,
    ]);
    expect(built.lines[9].values).toEqual([
      "query five", 20, 2, 20, 10, 0.6667, 5, 4,
      0, 0, 20, 0, 0, 0, 0,
    ]);
    expect(built.lines[10].values).toEqual([
      "Camp A", 10, 1, 10, 10, 0.3333, 2, 2,
      0, 10, 0, 0, 0, 0, 0,
    ]);
    expect(built.lines[11].values).toEqual([
      "query one", 10, 1, 10, 10, 0.3333, 2, 2,
      0, 10, 0, 0, 0, 0, 0,
    ]);

    // campaign shares inside a week sum to the week's spend share
    const weekA = built.lines[0].values;
    const campAShare = built.lines[1].values[5] as number;
    const campBShare = built.lines[4].values[5] as number;
    expect(campAShare + campBShare).toBeCloseTo(weekA[5] as number, 4);

    expect(built.groups).toEqual([
      { start: 2, end: 8, depth: 1 },
      { start: 3, end: 5, depth: 2 },
      { start: 6, end: 8, depth: 2 },
      { start: 9, end: 13, depth: 1 },
      { start: 10, end: 11, depth: 2 },
      { start: 12, end: 13, depth: 2 },
    ]);
  });

  it("merges queries that differ only by case and whitespace", () => {
    const built = build([
      { date: "2026-11-09", CampaignName: "C", Query: "Foo Bar", Impressions: 1, Clicks: 1, Cost: 10, AvgImpressionPosition: 1, AvgClickPosition: 1 },
      { date: "2026-11-10", CampaignName: "C", Query: "  foo bar ", Impressions: 2, Clicks: 0, Cost: 5, AvgImpressionPosition: null, AvgClickPosition: null },
    ]);
    const queryLines = built.lines.filter((line) => line.depth === 2);
    expect(queryLines).toHaveLength(1);
    expect(queryLines[0].values[0]).toBe("foo bar");
    expect(queryLines[0].values[3]).toBe(15);
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

const reportRow = (date: string): SearchQueryRow => ({
  Date: date,
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

// runWeeklyTree keys the settled-day cache by project, date and the report
// scope (account, client login, resolved campaign ids).
const SCOPE = '["acc-gamma",null,null]';
const cacheKey = (date: string, scope = SCOPE) => `gamma:${date}:${scope}`;

function fakes(over: Partial<PipelineDeps> = {}) {
  const calls = {
    reportDates: [] as string[],
    reportCalls: [] as { date: string; campaignIds?: number[] }[],
    cacheSets: [] as string[],
    published: [] as {
      sheetId: string;
      header: string[];
      rows: (string | number)[][];
      groups: { start: number; end: number; depth: number }[];
    }[],
    cache: new Map<string, unknown>(),
  };
  const deps: PipelineDeps = {
    now: () => T0300,
    getSecret: async () => "secret",
    getAccount: () => account(),
    ensureFresh: async (a) => a,
    searchQueryReport: async ({ date, campaignIds }) => {
      calls.reportDates.push(date);
      calls.reportCalls.push({ date, campaignIds });
      return [reportRow(date)];
    },
    loadQueries: () => [],
    saveQueries: () => {},
    loadJudgements: () => [],
    saveJudgements: () => {},
    loadFeedback: () => [],
    pullDecisions: async () => [],
    judgeQueries: async () => [],
    reviewSerp: async () => [],
    publishDay: async () => ({ written: 0 }),
    syncLibrary: async () => ({ added: 0, created: 0 }),
    weeklyCache: {
      get: <T>(key: string) => calls.cache.get(key) as T | undefined,
      set: (key: string, value: unknown) => {
        calls.cacheSets.push(key);
        calls.cache.set(key, value);
      },
    },
    publishWeeklyTree: async (sheetId, header, rows, groups) => {
      calls.published.push({ sheetId, header, rows, groups });
    },
    ...over,
  };
  return { deps, calls };
}

const treeProject = (): Project => ({
  ...fixturePipelineProject(),
  pipeline: {
    ...fixturePipelineProject().pipeline!,
    weeklyTree: { enabled: true, weeks: 2 },
  },
});

describe("runWeeklyTree", () => {
  it("serves a day older than SETTLE_DAYS from the cache without a report call", async () => {
    expect(SETTLE_DAYS).toBe(3);
    const { deps, calls } = fakes();
    calls.cache.set(cacheKey("2026-11-05"), [
      {
        date: "2026-11-05",
        CampaignName: "Camp Z",
        Query: "cached query",
        Impressions: 7,
        Clicks: 1,
        Cost: 5,
        AvgImpressionPosition: 3,
        AvgClickPosition: 2,
      },
    ]);
    const rows = await runWeeklyTree(deps, treeProject(), "2026-11-10", {
      trigger: "schedule",
      runId: "run-1",
      attempt: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].jobId).toBe("weekly-tree");
    expect(rows[0].stageId).toBe("weekly-tree");
    // 2026-11-05 is 5 days before day and cached: no report call for it,
    // but day itself and every other date are fetched
    expect(calls.reportDates).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);
    expect(calls.reportDates).toContain("2026-11-10");
    // only settled fetched days are written back to the cache
    expect(calls.cacheSets).toEqual([
      cacheKey("2026-11-02"),
      cacheKey("2026-11-03"),
      cacheKey("2026-11-04"),
      cacheKey("2026-11-06"),
    ]);
    // 8 report rows + 1 cached row
    expect(rows[0].rowsIn).toBe(9);
    expect(calls.published).toHaveLength(1);
    expect(calls.published[0].header).toEqual(WEEKLY_TREE_HEADER);
    expect(calls.published[0].sheetId).toBe("sheet-gamma");
    expect(calls.published[0].rows.some((row) => row[0] === "Camp Z")).toBe(true);
  });

  it("does not reuse cached days after the report scope changes", async () => {
    const scoped = (ids: number[]): Project => ({
      ...treeProject(),
      pipeline: {
        ...treeProject().pipeline!,
        campaignFilter: { ids },
      },
    });
    const opts = { trigger: "schedule" as const, runId: "r", attempt: 1 };
    const { deps, calls } = fakes();
    await runWeeklyTree(deps, scoped([11]), "2026-11-10", opts);
    expect(calls.reportDates).toHaveLength(9);
    expect(calls.reportCalls.every((c) => c.campaignIds?.join() === "11")).toBe(true);

    // same scope: settled days come from the cache again
    await runWeeklyTree(deps, scoped([11]), "2026-11-10", opts);
    expect(calls.reportDates.slice(9)).toEqual([
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);

    // new campaign selection: every date is fetched again under the new scope
    await runWeeklyTree(deps, scoped([22]), "2026-11-10", opts);
    const third = calls.reportCalls.slice(13);
    expect(third).toHaveLength(9);
    expect(third.every((c) => c.campaignIds?.join() === "22")).toBe(true);
  });

  it("does not request an unfiltered report when the campaign name filter matches nothing", async () => {
    const { deps, calls } = fakes({
      listCampaigns: async () => [
        { Id: 11, Name: "Search", State: "ACTIVE", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
      ],
    });
    const filtered: Project = {
      ...treeProject(),
      pipeline: {
        ...treeProject().pipeline!,
        campaignFilter: { nameContains: "no-such-campaign" },
      },
    };
    const opts = { trigger: "schedule" as const, runId: "r", attempt: 1 };
    const rows = await runWeeklyTree(deps, filtered, "2026-11-10", opts);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].firstError).toBe("no campaigns match the filter");
    expect(calls.reportDates).toEqual([]);
    expect(calls.published).toEqual([]);

    // no campaignFilter stays the intentional unrestricted selection
    const unrestricted = await runWeeklyTree(deps, treeProject(), "2026-11-10", opts);
    expect(unrestricted[0].status).toBe("ok");
    expect(calls.reportDates).not.toEqual([]);
  });
});

describe("pipelineJobs weekly-tree", () => {
  it("adds job weekly-tree at the scripts' hours only when enabled", () => {
    const pipe = fixturePipelineProject().pipeline!;
    expect(pipelineJobs(pipe).some((j) => j.id === "weekly-tree")).toBe(false);
    const disabled = pipelineJobs({ ...pipe, weeklyTree: { enabled: false, weeks: 4 } });
    expect(disabled.map((j) => j.id)).toEqual(pipelineJobs(pipe).map((j) => j.id));
    const enabled = pipelineJobs({ ...pipe, weeklyTree: { enabled: true, weeks: 4 } });
    const job = enabled.find((j) => j.id === "weekly-tree")!;
    expect(job.hours).toEqual([0, 4, 8, 12, 16, 18, 20]);
    expect(job.reportDay).toBe("today");
  });

  it("pipelineSchema keeps weeklyTree with defaults through the save path", () => {
    const parsed = pipelineSchema.parse({
      ...fixturePipelineProject().pipeline!,
      weeklyTree: { enabled: true },
    });
    expect(parsed.weeklyTree).toEqual({ enabled: true, weeks: 8 });
    expect(pipelineJobs(parsed).some((j) => j.id === "weekly-tree")).toBe(true);
  });
});

describe("night lock", () => {
  it("library-sync and weekly-tree skip while the same project's night-export runs", async () => {
    let release!: (rows: SearchQueryRow[]) => void;
    const gate = new Promise<SearchQueryRow[]>((resolve) => {
      release = resolve;
    });
    const { deps } = fakes({
      searchQueryReport: () => gate,
    });
    const project = fixturePipelineProject();
    const pipelinePromise = runPipeline(deps, project, "2026-11-03", {
      trigger: "schedule",
      runId: "night-1",
      attempt: 1,
    });
    expect(isNightExportRunning("gamma")).toBe(true);

    const syncRows = await runLibrarySync(deps, project, { runId: "sync-1", attempt: 1 });
    expect(syncRows).toHaveLength(1);
    expect(syncRows[0].status).toBe("skipped");
    expect(syncRows[0].firstError).toBe("идёт ночная выгрузка");

    const treeRowsResult = await runWeeklyTree(deps, treeProject(), "2026-11-10", {
      trigger: "schedule",
      runId: "tree-1",
      attempt: 1,
    });
    expect(treeRowsResult).toHaveLength(1);
    expect(treeRowsResult[0].status).toBe("skipped");
    expect(treeRowsResult[0].firstError).toBe("идёт ночная выгрузка");

    release([reportRow("2026-11-03")]);
    const rows: LedgerRow[] = await pipelinePromise;
    expect(rows.length).toBeGreaterThan(0);
    expect(isNightExportRunning("gamma")).toBe(false);
  });

  it("an early return inside runPipeline still clears the flag", async () => {
    const { deps } = fakes({
      ensureFresh: async () => {
        throw new Error("token expired token=abc123");
      },
    });
    const rows = await runPipeline(deps, fixturePipelineProject(), "2026-11-03", {
      trigger: "schedule",
    });
    expect(rows.find((r) => r.stageId === "token")?.status).toBe("failed");
    expect(isNightExportRunning("gamma")).toBe(false);
  });
});
