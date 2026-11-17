import type Database from "better-sqlite3";
import type { FeedbackRow } from "./db.ts";
import type { DirectClient } from "./direct.ts";
import { recordChange } from "./history.ts";
import { directSafe, phraseKey } from "./library.ts";
import type { LedgerRow, Project, ProjectPipeline } from "./model.ts";
import { isNightExportRunning } from "./pipeline.ts";
import { addDays, moscowParts } from "./slots.ts";
import { appendRows, type StatsSheets } from "./stats-sheet.ts";

const MICRO = 1_000_000;
const MAX_WORDS = 7;
const MAX_WORD_LENGTH = 35;

const growthHeader = (days: number): (string | number)[] => [
  "Время",
  "Кампания",
  "Группа",
  "Фраза",
  `Показы за ${days} дн.`,
  "Клики",
  "Стартовая ставка, ₽",
  "Id фразы",
];

const iso = (ms: number): string => new Date(ms).toISOString();

const maskText = (s: string): string =>
  s
    .replace(/\b(token|key|password|secret)\b\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");

const failMsg = (e: unknown): string =>
  maskText(e instanceof Error ? e.message : String(e)).slice(0, 400);

const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const normQuery = (q: string): string => q.toLowerCase().trim();

const moscowStamp = (ms: number): string => {
  const m = moscowParts(ms);
  return `${m.date} ${String(m.hour).padStart(2, "0")}:${String(m.minute).padStart(2, "0")}`;
};

export type KeywordGrowthSheets = Pick<
  StatsSheets,
  "metadata" | "readValues" | "addTab" | "appendValues"
>;

export type KeywordGrowthDeps = {
  now: () => number;
  db: Database.Database;
  client: (pipe: ProjectPipeline) => Promise<DirectClient>;
  loadFeedback: (projectId: string) => FeedbackRow[];
  sheets?: () => Promise<KeywordGrowthSheets>;
};

// words_key from keyword_growth.py: drop -word tokens, strip Direct operators
// [ ] ! + " from each word, then reuse the library's phrase key.
export function keywordWords(text: string): string {
  const plain = text
    .split(/\s+/)
    .filter((word) => word.length > 0 && !word.startsWith("-"))
    .map((word) => word.replace(/[\][!+"]/g, ""))
    .filter((word) => word.length > 0)
    .join(" ");
  return phraseKey(plain);
}

interface GroupAgg {
  impressions: number;
  campaignId: number;
  criteria: Map<number, number>;
}

interface Candidate {
  query: string;
  groupId: number;
  campaignId: number;
  campaign: string;
  source: number;
  impressions: number;
  clicks: number;
  bid?: number;
}

export async function runKeywordGrowth(
  deps: KeywordGrowthDeps,
  project: Project,
  day: string,
  opts: {
    trigger: LedgerRow["trigger"];
    dryRun?: boolean;
    runId?: string;
    attempt?: number;
  },
): Promise<LedgerRow[]> {
  const pipe = project.pipeline;
  const startedAt = iso(deps.now());
  const growthRow = (
    status: LedgerRow["status"],
    extra: Partial<LedgerRow> = {},
  ): LedgerRow => {
    const finishedAt = iso(deps.now());
    return {
      projectId: project.id,
      jobId: "keyword-growth",
      day,
      runId: opts.runId ?? `growth-${day}`,
      attempt: opts.attempt ?? 1,
      trigger: opts.trigger,
      stageId: "keyword-growth",
      status,
      startedAt,
      finishedAt,
      durationSec: Math.max(
        0,
        Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
      ),
      firstError:
        extra.firstError === undefined
          ? undefined
          : maskText(String(extra.firstError)).slice(0, 400),
      rowsIn: extra.rowsIn,
      rowsOut: extra.rowsOut,
    };
  };

  const growth = pipe?.keywordGrowth;
  if (!pipe || growth?.enabled !== true) {
    return [growthRow("skipped", { firstError: "keyword growth disabled" })];
  }
  if (isNightExportRunning(project.id)) {
    return [growthRow("skipped", { firstError: "идёт ночная выгрузка" })];
  }
  const minImpressions = growth.minImpressions ?? 10;
  const days = Math.max(1, growth.days ?? 5);

  try {
    const client = await deps.client(pipe);
    const campaigns = await client.campaigns({ states: ["ON"] });
    const filter = pipe.campaignFilter;
    const needle = filter?.nameContains?.trim().toLowerCase();
    const scope = new Map<number, string>();
    for (const campaign of campaigns) {
      if (campaign.State !== "ON") continue;
      if (filter?.ids?.length && !filter.ids.includes(campaign.Id)) continue;
      if (needle && !campaign.Name.toLowerCase().includes(needle)) continue;
      scope.set(campaign.Id, campaign.Name);
    }
    const campaignIds = [...scope.keys()];
    if (campaignIds.length === 0) {
      return [
        growthRow("skipped", {
          firstError: "ни одна кампания не подходит под фильтр проекта",
        }),
      ];
    }

    const raw = await client.searchQueryReport({
      dateFrom: addDays(day, 1 - days),
      dateTo: day,
      campaignIds,
    });

    const feedback = deps.loadFeedback(project.id);
    const keeps = feedback.filter((f) => f.decision === "keep");
    const minuses = feedback.filter((f) => f.decision === "minus");
    const decided = (
      rows: FeedbackRow[],
      queryKey: string,
      campaign: string,
    ): boolean =>
      rows.some(
        (f) =>
          normQuery(f.query) === queryKey &&
          (f.campaign === "" || f.campaign.split(" | ").includes(campaign)),
      );

    const totals = new Map<string, { impressions: number; clicks: number }>();
    const byGroup = new Map<string, Map<number, GroupAgg>>();
    for (const row of raw) {
      const query = normQuery(String(row.Query ?? ""));
      if (!query) continue;
      const campaignName = String(row.CampaignName ?? "");
      if (!decided(keeps, query, campaignName) || decided(minuses, query, campaignName)) {
        continue;
      }
      const impressions = num(row.Impressions);
      const clicks = num(row.Clicks);
      const total = totals.get(query) ?? { impressions: 0, clicks: 0 };
      total.impressions += impressions;
      total.clicks += clicks;
      totals.set(query, total);
      const groupId = num(row.AdGroupId);
      const criterionId = num(row.CriterionId);
      let groups = byGroup.get(query);
      if (!groups) {
        groups = new Map();
        byGroup.set(query, groups);
      }
      let group = groups.get(groupId);
      if (!group) {
        group = { impressions: 0, campaignId: num(row.CampaignId), criteria: new Map() };
        groups.set(groupId, group);
      }
      group.impressions += impressions;
      group.criteria.set(
        criterionId,
        (group.criteria.get(criterionId) ?? 0) + impressions,
      );
    }

    const picked: Candidate[] = [];
    for (const [query, total] of totals) {
      const text = directSafe(query);
      const words = text.split(/\s+/).filter((word) => word.length > 0);
      if (
        total.impressions <= minImpressions ||
        text === "" ||
        words.length > MAX_WORDS ||
        words.some((word) => word.length > MAX_WORD_LENGTH)
      ) {
        continue;
      }
      const groups = byGroup.get(query)!;
      let groupId = -1;
      let group: GroupAgg | undefined;
      let best = -1;
      for (const [id, g] of groups) {
        if (g.impressions > best) {
          best = g.impressions;
          groupId = id;
          group = g;
        }
      }
      if (group === undefined) continue;
      let source = 0;
      let sourceImpressions = -1;
      for (const [criterionId, impressions] of group.criteria) {
        if (impressions > sourceImpressions) {
          sourceImpressions = impressions;
          source = criterionId;
        }
      }
      picked.push({
        query: text,
        groupId,
        campaignId: group.campaignId,
        campaign: scope.get(group.campaignId) ?? String(group.campaignId),
        source,
        impressions: total.impressions,
        clicks: total.clicks,
      });
    }

    const targetGroups = new Set(picked.map((p) => p.groupId));
    const targetCampaignIds = [
      ...new Set(picked.map((p) => p.campaignId).filter((id) => id > 0)),
    ];
    const existing = new Map<number, Set<string>>();
    if (targetCampaignIds.length > 0) {
      for (const keyword of await client.keywords(targetCampaignIds)) {
        if (!targetGroups.has(keyword.AdGroupId)) continue;
        const words = existing.get(keyword.AdGroupId) ?? new Set<string>();
        words.add(keywordWords(keyword.Keyword));
        existing.set(keyword.AdGroupId, words);
      }
    }
    const fresh = picked.filter(
      (p) => !existing.get(p.groupId)?.has(keywordWords(p.query)),
    );

    const sources = [
      ...new Set(fresh.map((p) => p.source).filter((id) => id > 0)),
    ];
    if (sources.length > 0) {
      const bids = new Map<number, number>();
      for (const item of await client.keywordBids({ keywordIds: sources })) {
        const bid = item.Search?.Bid;
        if (typeof bid === "number" && Number.isFinite(bid)) {
          bids.set(item.KeywordId, bid);
        }
      }
      for (const p of fresh) {
        const bid = p.source > 0 ? bids.get(p.source) : undefined;
        p.bid = bid !== undefined && bid > 0 ? bid : undefined;
      }
    }

    const apply = growth.apply === true && opts.dryRun !== true;
    const notes: string[] = [];
    let added = 0;
    const sheetRows: (string | number)[][] = [];
    if (!apply) {
      notes.push(`proposal: ${fresh.length} keywords`);
    } else if (fresh.length > 0) {
      const result = await client.addKeywords(
        fresh.map((p) => ({
          adGroupId: p.groupId,
          keyword: p.query,
          ...(p.bid !== undefined ? { bid: p.bid } : {}),
        })),
      );
      const at = iso(deps.now());
      const stamp = moscowStamp(deps.now());
      for (const item of result.added) {
        const p = fresh[item.index];
        if (p === undefined) continue;
        recordChange(deps.db, {
          at,
          accountId: pipe.accountId,
          clientLogin: pipe.clientLogin,
          source: "job",
          actor: "keyword-growth",
          objectType: "keyword",
          objectId: String(item.id),
          campaignId: p.campaignId || undefined,
          adGroupId: p.groupId || undefined,
          field: "Keyword",
          before: null,
          after: p.query,
        });
        sheetRows.push([
          stamp,
          p.campaign,
          p.groupId,
          p.query,
          p.impressions,
          p.clicks,
          p.bid === undefined ? "" : round2(p.bid / MICRO),
          item.id,
        ]);
      }
      added = result.added.length;
      if (result.rejected.length > 0) {
        notes.push(`${result.rejected.length} rejected`);
      }
      const sheetId = pipe.stats?.sheetId;
      if (added > 0 && pipe.stats?.enabled === true && sheetId) {
        try {
          const sheets = await deps.sheets!();
          await appendRows(
            sheets,
            sheetId,
            "Новые фразы",
            growthHeader(days),
            sheetRows,
          );
        } catch (e) {
          notes.push(`sheet: ${failMsg(e)}`);
        }
      }
    }

    return [
      growthRow("ok", {
        rowsIn: raw.length,
        rowsOut: apply ? added : fresh.length,
        firstError:
          notes.join("; ") || (fresh.length === 0 ? "no candidates" : undefined),
      }),
    ];
  } catch (e) {
    return [growthRow("failed", { firstError: failMsg(e) })];
  }
}
