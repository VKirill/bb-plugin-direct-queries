import type { Campaign } from "./direct.ts";
import type {
  ApplyNegativesLevel,
  ApprovedNegative,
  NegativesResult,
} from "./apply-negatives.ts";
import { phrase, phraseKey, type ApprovedPhrase } from "./library.ts";
import type { Feedback, JudgeItem, JudgeResult, SiteProfile } from "./judge.ts";
import { negativesConfig, type LedgerRow, type Project, type ProjectPipeline } from "./model.ts";
import { negativeCandidates, suggestPhrases, type AuditRow } from "./negatives.ts";
import { buildReviewRows, type ReviewRow } from "./review.ts";
import type { SerpAuditRow, SerpReview } from "./serp.ts";
import { moscowParts } from "./slots.ts";
import type { SecretName } from "./secrets.ts";
import type { AccountRow, FeedbackRow, JudgementRow, QueryRow } from "./db.ts";
import type { ClientDecision, PublishDayResult } from "./sheets.ts";
import type { SearchQueryRow } from "./direct.ts";
import type { PhraseSuggestion } from "./negatives.ts";

export type Trigger = "schedule" | "catch-up" | "manual";

const MSK_SERP_END = 6;

const iso = (ms: number): string => new Date(ms).toISOString();

const maskText = (s: string): string =>
  s
    .replace(/\b(token|key|password|secret)\b\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");

const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const normQuery = (q: string): string => q.toLowerCase().trim();

export type PipelineDeps = {
  now: () => number;
  getSecret: (name: SecretName) => Promise<string>;
  getAccount: (id: string) => AccountRow | undefined;
  saveAccount?: (account: AccountRow) => void;
  ensureFresh: (account: AccountRow) => Promise<AccountRow>;
  searchQueryReport: (args: {
    account: AccountRow;
    clientLogin?: string;
    date: string;
    campaignIds?: number[];
  }) => Promise<SearchQueryRow[]>;
  listCampaigns?: (args: { account: AccountRow; clientLogin?: string }) => Promise<Campaign[]>;
  loadQueries: (projectId: string, day: string) => QueryRow[];
  saveQueries: (projectId: string, day: string, rows: QueryRow[]) => void;
  loadJudgements: (projectId: string) => JudgementRow[];
  saveJudgements: (rows: JudgementRow[]) => void;
  saveFeedback?: (rows: FeedbackRow[]) => void;
  loadFeedback: (projectId: string) => FeedbackRow[];
  pullDecisions: (sheetId: string) => Promise<ClientDecision[]>;
  judgeQueries: (profile: SiteProfile, items: JudgeItem[], feedback: Feedback) => Promise<JudgeResult[]>;
  reviewSerp: (profile: SiteProfile, rows: SerpAuditRow[]) => Promise<SerpReview[]>;
  suggestNegatives?: (queries: string[]) => Promise<Record<string, string | PhraseSuggestion>>;
  publishDay: (sheetId: string, date: string, rows: ReviewRow[]) => Promise<PublishDayResult>;
  syncLibrary: (args: {
    apply: boolean;
    approved: ApprovedPhrase[];
    account: AccountRow;
    clientLogin?: string;
  }) => Promise<{ added: number; created: number }>;
  applyNegatives?: (args: {
    level: ApplyNegativesLevel;
    apply: boolean;
    approved: ApprovedNegative[];
    account: AccountRow;
    clientLogin?: string;
  }) => Promise<NegativesResult>;
  refreshLibraryColumn?: (sheetId: string, inLibrary: (query: string) => boolean) => Promise<void>;
  listDirectInventory?: (args: {
    account: AccountRow;
    clientLogin?: string;
  }) => Promise<{
    campaigns: Campaign[];
    groups: import("./direct.ts").AdGroup[];
    sharedSets: import("./direct.ts").SharedSet[];
    keywords: import("./direct.ts").Keyword[];
  }>;
};

type RunCtx = {
  projectId: string;
  jobId: string;
  day: string;
  runId: string;
  attempt: number;
  trigger: Trigger;
};

const stageRow = (
  ctx: RunCtx,
  stageId: string,
  startedAt: string,
  finishedAt: string,
  status: LedgerRow["status"],
  extra: Partial<LedgerRow> = {},
): LedgerRow => ({
  ...ctx,
  stageId,
  status,
  startedAt,
  finishedAt,
  durationSec: Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)),
  firstError: extra.firstError === undefined ? undefined : maskText(String(extra.firstError)).slice(0, 400),
  rowsIn: extra.rowsIn,
  rowsOut: extra.rowsOut,
  paid: extra.paid,
  judge: extra.judge,
});

const failMsg = (e: unknown): string => maskText(e instanceof Error ? e.message : String(e)).slice(0, 400);

function toQueryRows(projectId: string, day: string, rows: SearchQueryRow[]): QueryRow[] {
  return rows.map((r) => ({
    projectId,
    day,
    campaignId: num(r.CampaignId),
    campaign: String(r.CampaignName ?? ""),
    adGroupId: num(r.AdGroupId),
    query: String(r.Query ?? ""),
    impressions: num(r.Impressions),
    clicks: num(r.Clicks),
    cost: num(r.Cost),
    avgImpressionPosition: r.AvgImpressionPosition == null || r.AvgImpressionPosition === "" ? null : num(r.AvgImpressionPosition),
    avgClickPosition: r.AvgClickPosition == null || r.AvgClickPosition === "" ? null : num(r.AvgClickPosition),
    conversions: num(r.Conversions),
  }));
}

const approvedNegatives = (feedback: FeedbackRow[], queries: QueryRow[]): ApprovedNegative[] => {
  const seen = new Set<string>();
  const out: ApprovedNegative[] = [];
  for (const f of feedback) {
    if (f.decision !== "minus") continue;
    const itemPhrase = phrase(f.query);
    const matches = queries.filter(
      (q) => normQuery(q.query) === normQuery(f.query) && (f.campaign === "" || q.campaign === f.campaign),
    );
    for (const q of matches.length ? matches : [undefined]) {
      const key = `${phraseKey(itemPhrase)}\t${q?.campaignId ?? ""}\t${q?.adGroupId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        query: f.query,
        phrase: itemPhrase,
        campaignId: q?.campaignId || undefined,
        adGroupId: q?.adGroupId || undefined,
        campaign: q?.campaign || f.campaign || undefined,
      });
    }
  }
  return out;
};

async function campaignIdsFor(
  deps: PipelineDeps,
  pipe: ProjectPipeline,
  account: AccountRow,
): Promise<number[] | undefined> {
  const filter = pipe.campaignFilter;
  if (!filter) return undefined;
  let ids = filter.ids?.slice();
  if (filter.nameContains && deps.listCampaigns) {
    const all = await deps.listCampaigns({ account, clientLogin: pipe.clientLogin });
    const needle = filter.nameContains.toLowerCase();
    const named = all.filter((c) => c.Name.toLowerCase().includes(needle)).map((c) => c.Id);
    ids = ids ? ids.filter((id) => named.includes(id)) : named;
  }
  return ids;
}

export async function runPipeline(
  deps: PipelineDeps,
  project: Project,
  day: string,
  opts: { trigger: Trigger; dryRun?: boolean; runId?: string; attempt?: number },
): Promise<LedgerRow[]> {
  const pipe = project.pipeline;
  if (!pipe) throw new Error("pipelineMissing");
  const ctx: RunCtx = {
    projectId: project.id,
    jobId: "night-export",
    day,
    runId: opts.runId ?? `pipe-${day}`,
    attempt: opts.attempt ?? 1,
    trigger: opts.trigger,
  };
  const dryRun = opts.dryRun === true;
  const rows: LedgerRow[] = [];
  let directAccount: AccountRow | undefined;
  let queries: QueryRow[] = [];
  let judgements: JudgeResult[] = [];
  let serpRows: SerpReview[] = [];
  let suggested: Record<string, string | PhraseSuggestion> = {};
  let reviewRows: ReviewRow[] = [];
  const catchUp = opts.trigger === "catch-up";

  const runStage = async (
    id: string,
    required: boolean,
    fn: () => Promise<Partial<LedgerRow> | void>,
  ): Promise<"ok" | "failed" | "stop"> => {
    const startedAt = iso(deps.now());
    try {
      const extra = (await fn()) ?? {};
      const status = (extra.status as LedgerRow["status"] | undefined) ?? "ok";
      rows.push(stageRow(ctx, id, startedAt, iso(deps.now()), status, extra));
      if (status === "no-shows") return "stop";
      return "ok";
    } catch (e) {
      rows.push(stageRow(ctx, id, startedAt, iso(deps.now()), "failed", { firstError: failMsg(e) }));
      return required ? "failed" : "ok";
    }
  };

  const tokenResult = await runStage("token", true, async () => {
    const account = deps.getAccount(pipe.accountId);
    if (!account) throw new Error(`account ${pipe.accountId} missing`);
    const fresh = await deps.ensureFresh(account);
    deps.saveAccount?.(fresh);
    directAccount = fresh;
  });
  if (tokenResult === "failed") return rows;

  const reportResult = await runStage("report", true, async () => {
    const stored = catchUp ? deps.loadQueries(project.id, day) : [];
    if (stored.length > 0) {
      queries = stored;
      return { status: "reused" as const, rowsIn: 0, rowsOut: stored.length };
    }
    const ids = await campaignIdsFor(deps, pipe, directAccount!);
    const raw = await deps.searchQueryReport({
      account: directAccount!,
      clientLogin: pipe.clientLogin,
      date: day,
      campaignIds: ids,
    });
    queries = toQueryRows(project.id, day, raw);
    deps.saveQueries(project.id, day, queries);
    if (queries.length === 0) return { status: "no-shows" as const, rowsIn: 0, rowsOut: 0 };
    return { rowsIn: 0, rowsOut: queries.length };
  });
  if (reportResult !== "ok") return rows;

  if (pipe.sheetId) {
    await runStage("feedback", false, async () => {
      const decisions = await deps.pullDecisions(pipe.sheetId!);
      const pulledAt = deps.now();
      const fb: FeedbackRow[] = decisions.map((d) => ({
        projectId: project.id,
        query: d.query,
        campaign: d.campaign,
        decision: d.decision,
        comment: d.comment,
        day: d.date,
        pulledAt,
      }));
      deps.saveFeedback?.(fb);
      return { rowsOut: fb.length };
    });
  } else {
    rows.push(
      stageRow(ctx, "feedback", iso(deps.now()), iso(deps.now()), "skipped", { firstError: "no sheetId" }),
    );
  }

  const feedbackRows = deps.loadFeedback(project.id);
  const feedback: Feedback = feedbackRows.map((f) => ({
    query: f.query,
    decision: f.decision === "minus" ? "irrelevant" : "relevant",
  }));

  const auditItems: JudgeItem[] = queries.map((q) => ({ campaign: q.campaign, query: q.query }));
  const storedJudgements = deps.loadJudgements(project.id);
  const byKey = new Map(storedJudgements.map((j) => [`${j.campaignId}\t${j.queryNorm}`, j]));
  const allCached =
    auditItems.length > 0 &&
    queries.every((q) => byKey.has(`${q.campaignId}\t${normQuery(q.query)}`));

  const auditResult = await runStage("audit", true, async () => {
    await deps.getSecret("openluxKey");
    if (allCached) {
      judgements = queries.map((q) => {
        const j = byKey.get(`${q.campaignId}\t${normQuery(q.query)}`)!;
        return {
          query: q.query,
          campaign: q.campaign,
          status: j.status as JudgeResult["status"],
          score: j.score,
          reason: j.reason,
          intent: "",
          confidence: null,
          decisionSource: "jev" as const,
        };
      });
      return { status: "reused" as const, rowsIn: queries.length, rowsOut: judgements.length, judge: "cached" };
    }
    judgements = await deps.judgeQueries(pipe.profile, auditItems, feedback);
    deps.saveJudgements(
      judgements.map((j, i) => ({
        projectId: project.id,
        campaignId: queries[i]?.campaignId ?? 0,
        queryNorm: normQuery(j.query),
        status: j.status,
        score: j.score,
        reason: j.reason,
        judge: j.decisionSource.startsWith("jev") ? "openlux" : j.decisionSource,
        judgedAt: deps.now(),
      })),
    );
    return {
      rowsIn: auditItems.length,
      rowsOut: judgements.length,
      paid: { jev: auditItems.length },
      judge: "openlux",
    };
  });
  if (auditResult === "failed") return rows;

  if (pipe.serp.enabled) {
    const hour = moscowParts(deps.now()).hour;
    if (hour >= MSK_SERP_END) {
      rows.push(
        stageRow(ctx, "serp", iso(deps.now()), iso(deps.now()), "skipped", {
          firstError: "outside 00–06 MSK",
        }),
      );
    } else {
      await runStage("serp", false, async () => {
        const audit: SerpAuditRow[] = queries.map((q, i) => ({
          CampaignId: String(q.campaignId),
          CampaignName: q.campaign,
          AdGroupId: String(q.adGroupId),
          Query: q.query,
          Impressions: q.impressions,
          Clicks: q.clicks,
          status: judgements[i]?.status ?? "",
        }));
        serpRows = await deps.reviewSerp(pipe.profile, audit);
        return { rowsIn: audit.length, rowsOut: serpRows.length, paid: { xmlstock: serpRows.length } };
      });
    }
  } else {
    rows.push(stageRow(ctx, "serp", iso(deps.now()), iso(deps.now()), "skipped"));
  }

  await runStage("candidates", false, async () => {
    const audit: AuditRow[] = queries.map((q, i) => ({
      CampaignId: String(q.campaignId),
      AdGroupId: String(q.adGroupId),
      Query: q.query,
      Impressions: q.impressions,
      Clicks: q.clicks,
      status: judgements[i]?.status ?? "",
    }));
    const cands = negativeCandidates(
      audit,
      serpRows.map((s) => ({
        CampaignId: s.CampaignId,
        AdGroupId: s.AdGroupId,
        Query: s.Query,
        review_status: s.review_status,
      })),
    );
    if (deps.suggestNegatives) {
      suggested = await deps.suggestNegatives(cands.map((c) => c.query));
    }
    return { rowsOut: cands.length };
  });

  const reviewResult = await runStage("review", true, async () => {
    reviewRows = buildReviewRows({
      date: day,
      audit: queries.map((q, i) => ({
        campaign: q.campaign,
        campaignId: String(q.campaignId),
        group: String(q.adGroupId),
        query: q.query,
        impressions: q.impressions,
        clicks: q.clicks,
        cost: q.cost,
        avgImpressionPosition: q.avgImpressionPosition ?? undefined,
        avgClickPosition: q.avgClickPosition ?? undefined,
        conversions: q.conversions,
        status: judgements[i]?.status ?? "",
        score: judgements[i]?.score ?? undefined,
        reason: judgements[i]?.reason,
      })),
      serp: serpRows.map((s) => ({
        campaignId: s.CampaignId,
        query: s.Query,
        reviewStatus: s.review_status,
        position: s.position,
        pageUrl: s.page_url,
      })),
      suggestedNegatives: suggested,
    });
    return { rowsIn: queries.length, rowsOut: reviewRows.length };
  });
  if (reviewResult === "failed") return rows;

  const sheetId = pipe.sheetId ?? project.sheetId;
  if (!sheetId) {
    rows.push(
      stageRow(ctx, "upload", iso(deps.now()), iso(deps.now()), "ok", { firstError: "no sheetId" }),
    );
  } else if (dryRun) {
    rows.push(
      stageRow(ctx, "upload", iso(deps.now()), iso(deps.now()), "ok", {
        rowsOut: reviewRows.length,
        firstError: "dry-run",
      }),
    );
  } else {
    const uploadResult = await runStage("upload", true, async () => {
      const published = await deps.publishDay(sheetId, day, reviewRows);
      return { rowsOut: published.written };
    });
    if (uploadResult === "failed") return rows;
  }

  const negatives = negativesConfig(pipe);
  if (!pipe.library.enabled) {
    rows.push(stageRow(ctx, "library", iso(deps.now()), iso(deps.now()), "skipped"));
  } else {
    await runStage("library", false, async () => {
      const apply = negatives.apply && !dryRun;
      if (negatives.level !== "library") {
        if (!deps.applyNegatives) {
          return { status: "skipped" as const, firstError: "applyNegatives not wired" };
        }
        const result = await deps.applyNegatives({
          level: negatives.level,
          apply,
          approved: approvedNegatives(feedbackRows, queries),
          account: directAccount!,
          clientLogin: pipe.clientLogin,
        });
        const planned =
          result.campaigns.reduce((n, c) => n + c.added.length, 0) +
          result.groups.reduce((n, g) => n + g.added.length, 0) +
          result.keywords.reduce((n, k) => n + k.minusWords.length, 0);
        const notes: string[] = [];
        if (dryRun || !apply) notes.push("plan only");
        const notPlaced =
          result.campaigns.reduce((n, c) => n + c.overflow.length, 0) +
          result.groups.reduce((n, g) => n + g.overflow.length, 0) +
          result.skipped.length +
          result.errors.length;
        if (notPlaced) notes.push(`${notPlaced} not placed`);
        return {
          rowsOut: apply ? planned : 0,
          firstError: notes.join("; ") || undefined,
        };
      }
      const approved: ApprovedPhrase[] = feedbackRows
        .filter((f) => f.decision === "minus")
        .map((f) => ({ phrase: phrase(f.query), campaignId: undefined }));
      const result = await deps.syncLibrary({
        apply,
        approved,
        account: directAccount!,
        clientLogin: pipe.clientLogin,
      });
      return {
        rowsOut: result.added + result.created,
        firstError: dryRun || !apply ? "plan only" : undefined,
      };
    });
  }

  return rows;
}

export async function runLibrarySync(
  deps: PipelineDeps,
  project: Project,
  opts: { runId?: string; attempt?: number; dryRun?: boolean } = {},
): Promise<LedgerRow[]> {
  const pipe = project.pipeline;
  if (!pipe) throw new Error("pipelineMissing");
  const day = moscowParts(deps.now()).date;
  const ctx: RunCtx = {
    projectId: project.id,
    jobId: "library-sync",
    day,
    runId: opts.runId ?? `sync-${day}`,
    attempt: opts.attempt ?? 1,
    trigger: "schedule",
  };
  const startedAt = iso(deps.now());
  try {
    const account = deps.getAccount(pipe.accountId);
    if (!account) throw new Error(`account ${pipe.accountId} missing`);
    const fresh = await deps.ensureFresh(account);
    deps.saveAccount?.(fresh);
    const sheetId = pipe.sheetId ?? project.sheetId;
    let approved: ApprovedPhrase[] = [];
    if (sheetId) {
      const decisions = await deps.pullDecisions(sheetId);
      approved = decisions
        .filter((d) => d.decision === "minus")
        .map((d) => ({ phrase: phrase(d.query) }));
      if (deps.refreshLibraryColumn) {
        const keys = new Set(approved.map((a) => a.phrase.toLowerCase()));
        await deps.refreshLibraryColumn(sheetId, (q) => keys.has(phrase(q).toLowerCase()));
      }
    }
    const result = await deps.syncLibrary({
      apply: negativesConfig(pipe).apply && !opts.dryRun,
      approved,
      account: fresh,
      clientLogin: pipe.clientLogin,
    });
    return [
      stageRow(ctx, "sync", startedAt, iso(deps.now()), "ok", {
        rowsOut: result.added + result.created,
      }),
    ];
  } catch (e) {
    return [stageRow(ctx, "sync", startedAt, iso(deps.now()), "failed", { firstError: failMsg(e) })];
  }
}
