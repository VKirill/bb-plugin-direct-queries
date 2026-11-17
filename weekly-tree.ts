import type { LedgerRow, Project } from "./model.ts";
import type { SearchQueryRow } from "./direct.ts";
import {
  campaignIdsFor,
  campaignSelectionEmpty,
  isNightExportRunning,
  type PipelineDeps,
  type Trigger,
} from "./pipeline.ts";
import { addDays } from "./slots.ts";

export const WEEKLY_TREE_HEADER = [
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
];

export const SETTLE_DAYS = 3;

export interface WeeklyTreeRow {
  date: string;
  CampaignName: string;
  Query: string;
  Impressions: number;
  Clicks: number;
  Cost: number;
  AvgImpressionPosition: number | null;
  AvgClickPosition: number | null;
}

export interface WeeklyTreeLine {
  depth: 0 | 1 | 2;
  values: (string | number)[];
}

export interface WeeklyTreeGroup {
  start: number;
  end: number;
  depth: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const maskText = (s: string): string =>
  s
    .replace(/\b(token|key|password|secret)\b\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");

const failMsg = (e: unknown): string => maskText(e instanceof Error ? e.message : String(e)).slice(0, 400);

const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

// Python round(): half-to-even on the scaled value.
const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  const rounded =
    fraction > 0.5 ? floor + 1 : fraction < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  return rounded / factor;
};

const weekdayIndex = (date: string): number => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (day + 6) % 7;
};

const mondayOf = (date: string): string => addDays(date, -weekdayIndex(date));

const labelDate = (date: string): string => {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
};

class SpendTotal {
  impressions = 0;
  clicks = 0;
  cost = 0;
  impressionPosition = 0;
  clickPosition = 0;
  days = [0, 0, 0, 0, 0, 0, 0];

  add(row: WeeklyTreeRow): void {
    const impressions = Math.trunc(num(row.Impressions));
    const clicks = Math.trunc(num(row.Clicks));
    const cost = num(row.Cost);
    this.impressions += impressions;
    this.clicks += clicks;
    this.cost += cost;
    if (row.AvgImpressionPosition != null) {
      this.impressionPosition += row.AvgImpressionPosition * impressions;
    }
    if (row.AvgClickPosition != null) {
      this.clickPosition += row.AvgClickPosition * clicks;
    }
    this.days[weekdayIndex(row.date)] += cost;
  }

  merge(other: SpendTotal): void {
    this.impressions += other.impressions;
    this.clicks += other.clicks;
    this.cost += other.cost;
    this.impressionPosition += other.impressionPosition;
    this.clickPosition += other.clickPosition;
    for (let i = 0; i < 7; i++) this.days[i] += other.days[i];
  }

  values(label: string, weekCost: number): (string | number)[] {
    return [
      label,
      this.impressions,
      this.clicks,
      round(this.cost, 2),
      this.clicks ? round(this.cost / this.clicks, 2) : 0,
      weekCost ? round(this.cost / weekCost, 4) : 0,
      this.impressions ? round(this.impressionPosition / this.impressions, 2) : "",
      this.clicks ? round(this.clickPosition / this.clicks, 2) : "",
      ...this.days.map((day) => round(day, 2)),
    ];
  }
}

export function build(rows: WeeklyTreeRow[]): {
  header: string[];
  lines: WeeklyTreeLine[];
  groups: WeeklyTreeGroup[];
} {
  const weeks = new Map<string, Map<string, Map<string, { query: string; total: SpendTotal }>>>();
  for (const row of rows) {
    const monday = mondayOf(row.date);
    let campaigns = weeks.get(monday);
    if (campaigns === undefined) weeks.set(monday, (campaigns = new Map()));
    let queries = campaigns.get(row.CampaignName);
    if (queries === undefined) campaigns.set(row.CampaignName, (queries = new Map()));
    const key = row.Query.toLowerCase().trim();
    let entry = queries.get(key);
    if (entry === undefined) {
      queries.set(key, (entry = { query: key, total: new SpendTotal() }));
    }
    entry.total.add(row);
  }
  const lines: WeeklyTreeLine[] = [];
  for (const monday of [...weeks.keys()].sort().reverse()) {
    const campaigns = weeks.get(monday)!;
    const campaignTotals = new Map<string, SpendTotal>();
    for (const [name, queries] of campaigns) {
      const total = new SpendTotal();
      for (const entry of queries.values()) total.merge(entry.total);
      campaignTotals.set(name, total);
    }
    const week = new SpendTotal();
    for (const total of campaignTotals.values()) week.merge(total);
    lines.push({
      depth: 0,
      values: week.values(`${labelDate(monday)} – ${labelDate(addDays(monday, 6))}`, week.cost),
    });
    const ordered = [...campaignTotals.entries()].sort((a, b) => b[1].cost - a[1].cost);
    for (const [name, total] of ordered) {
      lines.push({ depth: 1, values: total.values(name, week.cost) });
      const queries = [...campaigns.get(name)!.values()];
      const paid = queries
        .filter((q) => q.total.cost > 0)
        .sort((a, b) => b.total.cost - a.total.cost);
      for (const query of paid) {
        lines.push({ depth: 2, values: query.total.values(query.query, week.cost) });
      }
      const free = queries.filter((q) => q.total.cost === 0);
      if (free.length > 0) {
        lines.push({
          depth: 2,
          values: [
            `без расхода: ${free.length} запросов`,
            free.reduce((sum, q) => sum + q.total.impressions, 0),
            ...Array<string>(WEEKLY_TREE_HEADER.length - 2).fill(""),
          ],
        });
      }
    }
  }
  const groups: WeeklyTreeGroup[] = [];
  for (let i = 0; i < lines.length; i++) {
    const depth = lines[i].depth;
    if (depth === 2) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].depth <= depth) {
        end = j;
        break;
      }
    }
    if (end > i + 1) groups.push({ start: i + 2, end: end + 1, depth: depth + 1 });
  }
  return { header: WEEKLY_TREE_HEADER, lines, groups };
}

const position = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : num(v);

const toWeeklyRow = (row: SearchQueryRow, date: string): WeeklyTreeRow => ({
  date: String(row.Date ?? date),
  CampaignName: String(row.CampaignName ?? ""),
  Query: String(row.Query ?? ""),
  Impressions: num(row.Impressions),
  Clicks: num(row.Clicks),
  Cost: num(row.Cost),
  AvgImpressionPosition: position(row.AvgImpressionPosition),
  AvgClickPosition: position(row.AvgClickPosition),
});

export async function runWeeklyTree(
  deps: PipelineDeps,
  project: Project,
  day: string,
  opts: { trigger: Trigger; dryRun?: boolean; runId: string; attempt: number },
): Promise<LedgerRow[]> {
  const pipe = project.pipeline;
  if (!pipe) throw new Error("pipelineMissing");
  const startedAt = iso(deps.now());
  const finish = (status: LedgerRow["status"], extra: Partial<LedgerRow> = {}): LedgerRow => {
    const finishedAt = iso(deps.now());
    return {
      projectId: project.id,
      jobId: "weekly-tree",
      day,
      runId: opts.runId,
      attempt: opts.attempt,
      trigger: opts.trigger,
      stageId: "weekly-tree",
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
  try {
    if (isNightExportRunning(project.id)) {
      return [finish("skipped", { firstError: "идёт ночная выгрузка" })];
    }
    const sheetId = pipe.sheetId ?? project.sheetId;
    if (!sheetId) return [finish("skipped", { firstError: "no sheetId" })];
    if (!deps.publishWeeklyTree) {
      return [finish("skipped", { firstError: "publishWeeklyTree not wired" })];
    }
    const account = deps.getAccount(pipe.accountId);
    if (!account) throw new Error(`account ${pipe.accountId} missing`);
    const fresh = await deps.ensureFresh(account);
    deps.saveAccount?.(fresh);
    const campaignIds = await campaignIdsFor(deps, pipe, fresh);
    if (campaignSelectionEmpty(campaignIds)) {
      return [finish("skipped", { firstError: "no campaigns match the filter" })];
    }
    const weeks = pipe.weeklyTree?.weeks ?? 8;
    const startMonday = addDays(mondayOf(day), -7 * (weeks - 1));
    const dates: string[] = [];
    for (let date = startMonday; date <= day; date = addDays(date, 1)) dates.push(date);
    const cacheScope = JSON.stringify([
      fresh.id,
      pipe.clientLogin ?? null,
      campaignIds ?? null,
    ]);
    const dayMs = 86_400_000;
    const rows: WeeklyTreeRow[] = [];
    for (const date of dates) {
      const settled =
        Date.parse(`${day}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`) > SETTLE_DAYS * dayMs;
      const cacheKey = `${project.id}:${date}:${cacheScope}`;
      const cached = settled
        ? await deps.weeklyCache?.get<WeeklyTreeRow[]>(cacheKey)
        : undefined;
      let dayRows: WeeklyTreeRow[];
      if (Array.isArray(cached)) {
        dayRows = cached;
      } else {
        const raw = await deps.searchQueryReport({
          account: fresh,
          clientLogin: pipe.clientLogin,
          date,
          campaignIds,
        });
        dayRows = raw.map((row) => toWeeklyRow(row, date));
        if (settled) await deps.weeklyCache?.set(cacheKey, dayRows);
      }
      rows.push(...dayRows);
    }
    const built = build(rows);
    if (!opts.dryRun) {
      await deps.publishWeeklyTree(
        sheetId,
        built.header,
        built.lines.map((line) => line.values),
        built.groups,
      );
    }
    return [
      finish("ok", {
        rowsIn: rows.length,
        rowsOut: built.lines.length,
        firstError: opts.dryRun ? "dry-run" : undefined,
      }),
    ];
  } catch (e) {
    return [finish("failed", { firstError: failMsg(e) })];
  }
}
