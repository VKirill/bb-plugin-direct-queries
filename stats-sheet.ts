import type { AccountRow } from "./db.ts";
import type { SearchQueryRow } from "./direct.ts";
import type { LedgerRow, Project } from "./model.ts";
import { campaignIdsFor, type PipelineDeps, type Trigger } from "./pipeline.ts";
import type { SheetsClient } from "./sheets.ts";

export const STATS_TAB = "Статистика ключевых фраз";
export const STATS_DYNAMICS_TAB = "Динамика";
export const STATS_CORRECTIONS_TAB = "Статистика по дням";
export const BIDS_TAB = "Ставки";

export const STATS_HEADER = [
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
];

type Cell = string | number;
type StatKey = string;

export type StatsSheets = Pick<
  SheetsClient,
  "metadata" | "readValues" | "writeValues" | "appendValues" | "addTab" | "batchUpdate"
>;

type TabsMap = Awaited<ReturnType<SheetsClient["metadata"]>>["tabs"];

export type StatsSheetDeps = {
  now: () => number;
  getAccount: (id: string) => AccountRow | undefined;
  ensureFresh: (account: AccountRow) => Promise<AccountRow>;
  saveAccount?: (account: AccountRow) => void;
  listCampaigns?: PipelineDeps["listCampaigns"];
  keywordReport: (args: {
    account: AccountRow;
    clientLogin?: string;
    dateFrom: string;
    dateTo: string;
    campaignIds?: number[];
  }) => Promise<SearchQueryRow[]>;
  sheets: () => Promise<StatsSheets>;
};

const iso = (ms: number): string => new Date(ms).toISOString();

const maskText = (s: string): string =>
  s
    .replace(/\b(token|key|password|secret)\b\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");

const failMsg = (e: unknown): string => maskText(e instanceof Error ? e.message : String(e)).slice(0, 400);

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const cellNum = (value: unknown): number => {
  if (value === "" || value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const cellNumOrEmpty = (value: unknown): number | "" => {
  if (value === "" || value === null || value === undefined || value === "--") return "";
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : "";
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const keywordText = (keyword: unknown): string =>
  String(keyword ?? "")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !word.startsWith("-"))
    .join(" ");

const padRow = (row: unknown[], width: number): unknown[] =>
  row.length >= width ? row : [...row, ...Array(width - row.length).fill("")];

const fmt1 = (n: number): string => n.toFixed(1).replace(".", ",");
const fmt0 = (n: number): string => n.toFixed(0);

export async function appendRows(
  sheets: Pick<StatsSheets, "metadata" | "readValues" | "addTab" | "appendValues">,
  sheetId: string,
  tab: string,
  header: Cell[],
  rows: Cell[][],
): Promise<void> {
  const { tabs } = await sheets.metadata(sheetId);
  const send = async (values: Cell[][]): Promise<void> => {
    try {
      await sheets.appendValues(sheetId, `'${tab}'!A1`, values);
    } catch (e) {
      // An append is not idempotent: the POST may have committed while its
      // response was lost. When every appended row's column-A key is already
      // in the tab the write landed, so the append counts as done.
      const keys = new Set(rows.map((row) => String(row[0] ?? "")));
      if (keys.size === 0) throw e;
      const column = await sheets.readValues(sheetId, `'${tab}'!A:A`);
      const present = new Set(column.map((row) => String(row[0] ?? "")));
      if (![...keys].every((key) => present.has(key))) throw e;
    }
  };
  if (!tabs.has(tab)) {
    await sheets.addTab(sheetId, tab);
    await send([header, ...rows]);
    return;
  }
  if (rows.length === 0) return;
  const firstRow = await sheets.readValues(sheetId, `'${tab}'!A1:Z1`);
  const hasHeader =
    firstRow.length > 0 && firstRow[0].some((cell) => String(cell ?? "") !== "");
  await send(hasHeader ? rows : [header, ...rows]);
}

const dayRows = (day: string, rows: SearchQueryRow[]): Cell[][] => {
  const sorted = [...rows].sort(
    (a, b) =>
      Math.trunc(cellNum(b.Clicks)) - Math.trunc(cellNum(a.Clicks)) ||
      Math.trunc(cellNum(b.Impressions)) - Math.trunc(cellNum(a.Impressions)),
  );
  return sorted.map((row) => {
    const impressions = Math.trunc(cellNum(row.Impressions));
    const clicks = Math.trunc(cellNum(row.Clicks));
    const cost = cellNum(row.Cost);
    return [
      day,
      String(row.CampaignName ?? ""),
      keywordText(row.Criterion),
      impressions,
      clicks,
      round2(cost),
      impressions ? round2((clicks / impressions) * 100) : "",
      clicks ? round2(cost / clicks) : "",
      cellNumOrEmpty(row.AvgImpressionPosition),
      cellNumOrEmpty(row.AvgClickPosition),
      cellNumOrEmpty(row.AvgTrafficVolume),
    ];
  });
};

interface DayStat {
  impressions: number;
  clicks: number;
  cost: number;
  trafficImpressions: number;
  trafficVolume: number;
}

const ensureTab = async (
  sheets: StatsSheets,
  sheetId: string,
  tabs: TabsMap,
  title: string,
): Promise<number> => {
  const existing = tabs.get(title);
  if (existing) return existing.sheetId;
  const added = await sheets.addTab(sheetId, title);
  tabs.set(title, { sheetId: added, title });
  return added;
};

const rebuildDynamics = async (
  sheets: StatsSheets,
  sheetId: string,
): Promise<{ keywords: number; days: number; corrected: number }> => {
  const { tabs } = await sheets.metadata(sheetId);
  const rows = tabs.has(STATS_TAB)
    ? await sheets.readValues(sheetId, `'${STATS_TAB}'!A1:K`)
    : [];
  const header = rows[0];
  const width = header?.length ?? 0;
  const positionIndex = header
    ? header.map((cell) => String(cell)).indexOf("Ср. позиция показа")
    : -1;
  if (header && positionIndex < 0) {
    throw new Error("stats tab header misses «Ср. позиция показа»");
  }

  const sums = new Map<StatKey, Map<string, [number, number]>>();
  const impressions = new Map<StatKey, number>();
  const daily = new Map<StatKey, Map<string, DayStat>>();
  const keyParts = new Map<StatKey, { campaign: string; keyword: string }>();

  for (const raw of rows.slice(1)) {
    const row = padRow(raw, width);
    const campaign = String(row[1] ?? "");
    const keyword = keywordText(row[2]);
    const key = `${campaign}\t${keyword}`;
    keyParts.set(key, { campaign, keyword });
    const imp = cellNum(row[3]);
    const date = String(row[0] ?? "");
    impressions.set(key, (impressions.get(key) ?? 0) + imp);
    let days = sums.get(key);
    if (days === undefined) {
      days = new Map();
      sums.set(key, days);
    }
    const pos = row[positionIndex];
    if (pos !== "" && pos !== null && pos !== undefined && imp !== 0) {
      const pair: [number, number] = days.get(date) ?? [0, 0];
      pair[0] += imp;
      pair[1] += imp * cellNum(pos);
      days.set(date, pair);
    }
    let dmap = daily.get(key);
    if (dmap === undefined) {
      dmap = new Map();
      daily.set(key, dmap);
    }
    let stat = dmap.get(date);
    if (stat === undefined) {
      stat = { impressions: 0, clicks: 0, cost: 0, trafficImpressions: 0, trafficVolume: 0 };
      dmap.set(date, stat);
    }
    stat.impressions += imp;
    stat.clicks += cellNum(row[4]);
    stat.cost += cellNum(row[5]);
    const traffic = row[10];
    if (traffic !== "" && traffic !== null && traffic !== undefined && imp !== 0) {
      stat.trafficImpressions += imp;
      stat.trafficVolume += imp * cellNum(traffic);
    }
  }

  const table = new Map<StatKey, Map<string, number>>();
  for (const [key, days] of sums) {
    const out = new Map<string, number>();
    for (const [date, pair] of days) out.set(date, round2(pair[1] / pair[0]));
    table.set(key, out);
  }

  const changes = new Map<StatKey, [string, Cell, Cell][]>();
  const notes = new Map<string, string[]>();
  if (tabs.has(BIDS_TAB)) {
    const bidRows = await sheets.readValues(sheetId, `'${BIDS_TAB}'!A2:F`);
    for (const raw of bidRows) {
      if (raw.length < 5) continue;
      const row = padRow(raw, 6);
      const campaign = String(row[1] ?? "");
      const keyword = keywordText(row[2]);
      const key = `${campaign}\t${keyword}`;
      keyParts.set(key, { campaign, keyword });
      const stamp = String(row[0] ?? "");
      const day = stamp.slice(0, 10);
      const noteKey = `${key}\t${day}`;
      const noteList = notes.get(noteKey) ?? [];
      noteList.push(`${stamp.slice(11, 16)} ставка ${String(row[3] ?? "")} → ${String(row[4] ?? "")} ₽`);
      notes.set(noteKey, noteList);
      const log = changes.get(key) ?? [];
      log.push([stamp, row[3] as Cell, row[4] as Cell]);
      changes.set(key, log);
    }
  }

  const dateSet = new Set<string>();
  for (const days of table.values()) for (const date of days.keys()) dateSet.add(date);
  for (const dmap of daily.values()) for (const date of dmap.keys()) dateSet.add(date);
  for (const noteKey of notes.keys()) dateSet.add(noteKey.slice(noteKey.lastIndexOf("\t") + 1));
  const dates = [...dateSet].sort((a, b) => cmpStr(b, a));

  const dynKeys = [...table.keys()].sort((a, b) => {
    const ka = keyParts.get(a)!;
    const kb = keyParts.get(b)!;
    return (
      cmpStr(ka.campaign, kb.campaign) ||
      (impressions.get(b) ?? 0) - (impressions.get(a) ?? 0) ||
      cmpStr(ka.keyword, kb.keyword)
    );
  });

  const dynValues: Cell[][] = [["Кампания", "Ключевая фраза", ...dates]];
  for (const key of dynKeys) {
    const { campaign, keyword } = keyParts.get(key)!;
    const days = table.get(key)!;
    dynValues.push([campaign, keyword, ...dates.map((date) => days.get(date) ?? "")]);
  }

  const dayStat = (key: StatKey, date: string): DayStat | undefined => daily.get(key)?.get(date);
  const dayNote = (key: StatKey, date: string): string => {
    const lines: string[] = [];
    const stat = dayStat(key, date);
    if (stat && stat.impressions) {
      lines.push(
        `Показы ${stat.impressions} · клики ${stat.clicks} · CTR ${fmt1((stat.clicks / stat.impressions) * 100)}%`,
      );
      lines.push(
        `Расход ${fmt0(stat.cost)} ₽` +
          (stat.clicks ? ` · цена клика ${fmt0(stat.cost / stat.clicks)} ₽` : ""),
      );
      if (stat.trafficImpressions) {
        lines.push(`Трафик ${fmt0(stat.trafficVolume / stat.trafficImpressions)}%`);
      }
    }
    return [...lines, ...(notes.get(`${key}\t${date}`) ?? [])].join("\n");
  };

  const dynTabId = await ensureTab(sheets, sheetId, tabs, STATS_DYNAMICS_TAB);
  await sheets.batchUpdate(sheetId, [
    { updateCells: { range: { sheetId: dynTabId }, fields: "userEnteredValue,note" } },
    {
      updateSheetProperties: {
        properties: {
          sheetId: dynTabId,
          gridProperties: {
            frozenRowCount: 1,
            frozenColumnCount: 0,
            rowCount: Math.max(dynValues.length + 10, 100),
            columnCount: Math.max(dynValues[0].length + 2, 26),
          },
        },
        fields:
          "gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.rowCount,gridProperties.columnCount",
      },
    },
    { setBasicFilter: { filter: { range: { sheetId: dynTabId } } } },
  ]);
  await sheets.writeValues(sheetId, `'${STATS_DYNAMICS_TAB}'!A1`, dynValues);

  const noteRequests: unknown[] = [];
  dynKeys.forEach((key, index) => {
    const cells = dates.map((date) => ({ note: dayNote(key, date) }));
    if (cells.some((cell) => cell.note)) {
      noteRequests.push({
        updateCells: {
          range: {
            sheetId: dynTabId,
            startRowIndex: index + 1,
            endRowIndex: index + 2,
            startColumnIndex: 2,
            endColumnIndex: 2 + dates.length,
          },
          rows: [{ values: cells }],
          fields: "note",
        },
      });
    }
  });
  for (let i = 0; i < noteRequests.length; i += 500) {
    await sheets.batchUpdate(sheetId, noteRequests.slice(i, i + 500));
  }

  const correctionValues: Cell[][] = [
    ["Кампания", "Ключевая фраза", "Ставку меняли", "Показатель", ...dates],
  ];
  const allKeys = new Set<StatKey>([...table.keys(), ...changes.keys()]);
  const sortedKeys = [...allKeys].sort((a, b) => {
    const ka = keyParts.get(a)!;
    const kb = keyParts.get(b)!;
    return (
      cmpStr(ka.campaign, kb.campaign) ||
      Number(changes.has(a) ? 0 : 1) - Number(changes.has(b) ? 0 : 1) ||
      cmpStr(ka.keyword, kb.keyword)
    );
  });
  for (const key of sortedKeys) {
    const { campaign, keyword } = keyParts.get(key)!;
    const log = (changes.get(key) ?? [])
      .slice()
      .sort(
        (a, b) =>
          cmpStr(String(a[0]), String(b[0])) ||
          cmpStr(String(a[1]), String(b[1])) ||
          cmpStr(String(a[2]), String(b[2])),
      );
    const bids = dates.map((date): Cell => {
      const done = log.filter((item) => String(item[0]).slice(0, 10) <= date);
      if (done.length > 0) return done[done.length - 1][2];
      return log.length > 0 ? log[0][1] : "";
    });
    const metricRows: [string, Cell[]][] = [
      ["Ставка на конец дня, ₽", bids],
      ["Ср. позиция показа", dates.map((date) => table.get(key)?.get(date) ?? "")],
      ["Показы", dates.map((date) => dayStat(key, date)?.impressions ?? "")],
      ["Клики", dates.map((date) => dayStat(key, date)?.clicks ?? "")],
      [
        "Цена клика, ₽",
        dates.map((date) => {
          const stat = dayStat(key, date);
          return stat && stat.clicks ? Math.round(stat.cost / stat.clicks) : "";
        }),
      ],
      [
        "Трафик, %",
        dates.map((date) => {
          const stat = dayStat(key, date);
          return stat && stat.trafficImpressions
            ? Math.round(stat.trafficVolume / stat.trafficImpressions)
            : "";
        }),
      ],
    ];
    for (const [metric, cells] of metricRows) {
      correctionValues.push([campaign, keyword, log.length > 0 ? "Да" : "Нет", metric, ...cells]);
    }
  }

  const corrTabId = await ensureTab(sheets, sheetId, tabs, STATS_CORRECTIONS_TAB);
  await sheets.batchUpdate(sheetId, [
    { updateCells: { range: { sheetId: corrTabId }, fields: "userEnteredValue" } },
    {
      updateSheetProperties: {
        properties: {
          sheetId: corrTabId,
          gridProperties: {
            frozenRowCount: 1,
            frozenColumnCount: 0,
            rowCount: Math.max(correctionValues.length + 10, 100),
            columnCount: Math.max(correctionValues[0].length + 2, 26),
          },
        },
        fields:
          "gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.rowCount,gridProperties.columnCount",
      },
    },
    { setBasicFilter: { filter: { range: { sheetId: corrTabId } } } },
  ]);
  await sheets.writeValues(sheetId, `'${STATS_CORRECTIONS_TAB}'!A1`, correctionValues);

  return { keywords: dynKeys.length, days: dates.length, corrected: sortedKeys.length };
};

export async function runStatsSheet(
  deps: StatsSheetDeps,
  project: Project,
  day: string,
  opts: { trigger: Trigger; dryRun?: boolean; runId?: string; attempt?: number },
): Promise<LedgerRow[]> {
  const pipe = project.pipeline;
  const startedAt = iso(deps.now());
  const statsRow = (status: LedgerRow["status"], extra: Partial<LedgerRow> = {}): LedgerRow => {
    const finishedAt = iso(deps.now());
    return {
      projectId: project.id,
      jobId: "stats-sheet",
      day,
      runId: opts.runId ?? `stats-${day}`,
      attempt: opts.attempt ?? 1,
      trigger: opts.trigger,
      stageId: "stats",
      status,
      startedAt,
      finishedAt,
      durationSec: Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)),
      firstError:
        extra.firstError === undefined
          ? undefined
          : maskText(String(extra.firstError)).slice(0, 400),
      rowsIn: extra.rowsIn,
      rowsOut: extra.rowsOut,
    };
  };

  const sheetId = pipe?.stats?.sheetId;
  if (!pipe?.stats?.enabled || !sheetId) {
    return [statsRow("skipped", { firstError: "no statistics sheet" })];
  }
  if (opts.dryRun === true) {
    return [statsRow("ok", { firstError: "dry-run" })];
  }
  try {
    const account = deps.getAccount(pipe.accountId);
    if (!account) throw new Error(`account ${pipe.accountId} missing`);
    const fresh = await deps.ensureFresh(account);
    deps.saveAccount?.(fresh);
    const campaignIds = await campaignIdsFor(deps, pipe, fresh);
    if (campaignIds?.length === 0) {
      return [
        statsRow("skipped", { firstError: "ни одна кампания не подходит под фильтр проекта" }),
      ];
    }
    const sheets = await deps.sheets();
    const { tabs } = await sheets.metadata(sheetId);
    const recorded = tabs.has(STATS_TAB)
      ? (await sheets.readValues(sheetId, `'${STATS_TAB}'!A2:A`)).some(
          (row) => String(row[0] ?? "").slice(0, 10) === day,
        )
      : false;
    let appended = 0;
    if (!recorded) {
      const raw = await deps.keywordReport({
        account: fresh,
        clientLogin: pipe.clientLogin,
        dateFrom: day,
        dateTo: day,
        campaignIds,
      });
      const values = dayRows(day, raw);
      await appendRows(sheets, sheetId, STATS_TAB, [...STATS_HEADER], values);
      appended = values.length;
    }
    await rebuildDynamics(sheets, sheetId);
    return [
      statsRow("ok", {
        rowsOut: appended,
        firstError: recorded ? "date already in sheet" : undefined,
      }),
    ];
  } catch (e) {
    return [statsRow("failed", { firstError: failMsg(e) })];
  }
}
