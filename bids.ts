import type Database from "better-sqlite3";
import { loadBidState, saveBidState, type BidMemory } from "./db.ts";
import type {
  AuctionBidItem,
  DirectClient,
  KeywordBid,
  SearchQueryRow,
} from "./direct.ts";
import { recordChange } from "./history.ts";
import type { JevAnswers, JevAsk, JevRequest, SiteProfile } from "./judge.ts";
import type { LedgerRow, Project, ProjectPipeline } from "./model.ts";
import { moscowParts } from "./slots.ts";
import { appendRows, type StatsSheets } from "./stats-sheet.ts";

const MIN_IMPRESSIONS = 10;
const TRAFFIC = 95;
const POSITION = 3;
const TOO_HIGH = 1.5;
const PARKED = 5_000_000;
const LEVELS = [85, 90, 95, 100, 110, 120];
const JUDGE_BATCH = 10;
const BID_STEP = 10_000;
const MAX_CUT = 0.3;
const MICRO = 1_000_000;
const DEFAULT_SKIP_CAMPAIGNS = ["По минималке"];
const BIDS_HEADER = [
  "Время",
  "Кампания",
  "Ключевая фраза",
  "Было, ₽",
  "Стало, ₽",
  "Изменение, ₽",
  "Ставка для 95% трафика, ₽",
  "Трафик до, %",
  "Ср. позиция показа",
  "Причина",
];

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

const round2 = (n: number): number => Math.round(n * 100) / 100;

export type BidsSheets = Pick<StatsSheets, "metadata" | "readValues" | "addTab" | "appendValues">;

export type BidsAsk = JevAsk & { backend?: () => string | undefined };

export type BidsDeps = {
  now: () => number;
  db: Database.Database;
  client: (pipe: ProjectPipeline) => Promise<DirectClient>;
  ask?: () => Promise<BidsAsk>;
  sheets?: () => Promise<BidsSheets>;
};

export interface LadderPoint {
  volume: number;
  bid: number;
  price: number;
}

export interface BidCase {
  keywordId: number;
  keyword: string;
  campaign: string;
  campaignId: number;
  adGroupId?: number;
  bid: number;
  direction: "up" | "down";
  options: LadderPoint[];
  position: number;
  impressions: number;
  volume: number;
  price: number;
  need: number | null;
}

export interface BidChoice {
  point: LadderPoint | null;
  confidence: number;
  judge: string;
}

export interface BidChange {
  keywordId: number;
  campaignId: number;
  adGroupId?: number;
  campaign: string;
  keyword: string;
  oldBid: number;
  newBid: number;
  need: number | null;
  volume: number;
  position: number | null;
  reason: string;
}

export function ladder(forecast: AuctionBidItem[]): LadderPoint[] {
  const points = new Map<number, LadderPoint>();
  for (const level of LEVELS) {
    let best: AuctionBidItem | undefined;
    for (const entry of forecast) {
      if ((entry.TrafficVolume ?? 0) >= level && (best === undefined || (entry.Bid ?? 0) < (best.Bid ?? 0))) {
        best = entry;
      }
    }
    if (best !== undefined) {
      const bid = best.Bid ?? 0;
      if (!points.has(bid)) {
        points.set(bid, { volume: level, bid, price: best.Price ?? 0 });
      }
    }
  }
  let top: AuctionBidItem | undefined;
  for (const entry of forecast) {
    if (
      top === undefined ||
      (entry.TrafficVolume ?? 0) > (top.TrafficVolume ?? 0) ||
      ((entry.TrafficVolume ?? 0) === (top.TrafficVolume ?? 0) && (entry.Bid ?? 0) < (top.Bid ?? 0))
    ) {
      top = entry;
    }
  }
  if (top !== undefined) {
    const bid = top.Bid ?? 0;
    if (!points.has(bid)) {
      points.set(bid, { volume: top.TrafficVolume ?? 0, bid, price: top.Price ?? 0 });
    }
  }
  return [...points.values()].sort((a, b) => a.bid - b.bid);
}

export function options(
  points: LadderPoint[],
  bid: number,
  direction: "up" | "down",
  floorVolume: number,
): LadderPoint[] {
  let current = -1;
  points.forEach((point, index) => {
    if (point.bid <= bid) current = index;
  });
  if (direction === "up") return points.slice(current + 1, current + 4);
  return points
    .slice(0, current + 1)
    .filter((point) => point.volume >= floorVolume && point.bid < bid)
    .reverse()
    .slice(0, 3);
}

export const cutFloor = (bid: number): number => Math.ceil((bid * 7) / 100_000) * BID_STEP;

const pointLabel = (point: { bid: number; volume: number; price: number }): string =>
  `ставка ${Math.round(point.bid / MICRO)} ₽, объём трафика ${point.volume}%, прогноз цены клика ${Math.round(point.price / MICRO)} ₽`;

const buildRequest = (batch: BidCase[], profile: SiteProfile): JevRequest => {
  const questions: Record<string, unknown> = {};
  batch.forEach((bidCase, index) => {
    const goal =
      bidCase.direction === "up"
        ? "Средняя позиция показа хуже 3. Выбери, на сколько ступеней объёма трафика поднять ставку. Больше ступень — выше место, но дороже клик. Поднимай настолько, насколько оправдано ценностью фразы для профиля клиента; для нецелевой или слабой фразы выбери «оставить»."
        : "Средняя позиция показа лучше 1,5: фраза стоит выше нужного. Выбери, на сколько ступеней снизить ставку, чтобы перестать переплачивать и остаться на позиции 1–3 с объёмом трафика не ниже 95%.";
    const criteria: Record<string, string> = {
      c0: `Оставить: ${pointLabel({ bid: bidCase.bid, volume: bidCase.volume, price: bidCase.price })}`,
    };
    bidCase.options.forEach((point, i) => {
      criteria[`c${i + 1}`] = `${bidCase.direction === "up" ? "Поднять" : "Снизить"} до: ${pointLabel(point)}`;
    });
    questions[`bid_${index}`] = {
      type: "choice",
      instructions: `Ключевая фраза items[${index}]. ${goal}`,
      criteria,
    };
  });
  return {
    state: {
      profile,
      goal: `Реклама ${profile.company} в Яндекс Директе: позиция показа 1–3, объём трафика 95–100%, без переплаты за клик.`,
      items: batch.map((bidCase) => ({
        keyword: bidCase.keyword,
        campaign: bidCase.campaign,
        average_position: round2(bidCase.position),
        impressions: bidCase.impressions,
      })),
    },
    questions,
  };
};

const readAnswers = (
  batch: BidCase[],
  answers: JevAnswers,
): Map<number, { point: LadderPoint | null; confidence: number }> | null => {
  const out = new Map<number, { point: LadderPoint | null; confidence: number }>();
  for (let index = 0; index < batch.length; index++) {
    const answer = answers[`bid_${index}`];
    const choice = typeof answer?.choice === "string" ? answer.choice : "";
    const match = /^c(\d+)$/.exec(choice);
    if (!match) return null;
    const number = Number(match[1]);
    const bidCase = batch[index];
    if (number > bidCase.options.length) return null;
    const confidence = Number(answer?.confidence);
    out.set(bidCase.keywordId, {
      point: number === 0 ? null : bidCase.options[number - 1],
      confidence: Number.isFinite(confidence) ? Math.round(confidence * 100) / 100 : 0,
    });
  }
  return out;
};

export async function choose(
  cases: BidCase[],
  ask: (() => Promise<BidsAsk>) | undefined,
  profile: SiteProfile,
): Promise<{ picks: Map<number, BidChoice>; judge: string }> {
  const picks = new Map<number, BidChoice>();
  if (cases.length === 0) return { picks, judge: "" };
  const fallback = (list: BidCase[]): void => {
    for (const bidCase of list) {
      picks.set(bidCase.keywordId, {
        point: bidCase.options[0] ?? null,
        confidence: 0,
        judge: "fallback",
      });
    }
  };
  let askFn: BidsAsk | undefined;
  if (ask !== undefined) {
    try {
      askFn = await ask();
    } catch {
      askFn = undefined;
    }
  }
  if (askFn === undefined) {
    fallback(cases);
    return { picks, judge: "fallback" };
  }
  let judge = "fallback";
  for (let start = 0; start < cases.length; start += JUDGE_BATCH) {
    const batch = cases.slice(start, start + JUDGE_BATCH);
    try {
      const answers = await askFn(buildRequest(batch, profile));
      const read = readAnswers(batch, answers);
      if (read === null) {
        fallback(batch);
        continue;
      }
      const backend = askFn.backend?.() ?? "gemini";
      for (const [keywordId, pick] of read) {
        picks.set(keywordId, { ...pick, judge: backend });
      }
      judge = backend;
    } catch {
      fallback(batch);
    }
  }
  return { picks, judge };
}

const keywordText = (keyword: string): string =>
  keyword
    .split(/\s+/)
    .filter((word) => word.length > 0 && !word.startsWith("-"))
    .join(" ");

const moscowStamp = (ms: number): string => {
  const m = moscowParts(ms);
  return `${m.date} ${String(m.hour).padStart(2, "0")}:${String(m.minute).padStart(2, "0")}`;
};

interface Candidate {
  keywordId: number;
  campaignId: number;
  adGroupId?: number;
  bid: number;
  forecast: AuctionBidItem[];
}

interface Pending {
  cand: Candidate;
  keyword: string;
  campaign: string;
  oldBid: number;
  newBid: number;
  need: number | null;
  volume: number;
  price: number;
  position: number | null;
  reason: string;
}

const needOf = (forecast: AuctionBidItem[]): number | null => {
  let need: number | null = null;
  for (const entry of forecast) {
    if ((entry.TrafficVolume ?? 0) < TRAFFIC) continue;
    const bid = entry.Bid ?? 0;
    if (need === null || bid < need) need = bid;
  }
  return need;
};

const currentStats = (forecast: AuctionBidItem[], bid: number): { volume: number; price: number } => {
  let volume = 0;
  let price = 0;
  for (const entry of forecast) {
    if ((entry.Bid ?? Number.POSITIVE_INFINITY) > bid) continue;
    volume = Math.max(volume, entry.TrafficVolume ?? 0);
    price = Math.max(price, entry.Price ?? 0);
  }
  return { volume, price };
};

const toChange = (p: Pending): BidChange => ({
  keywordId: p.cand.keywordId,
  campaignId: p.cand.campaignId,
  adGroupId: p.cand.adGroupId,
  campaign: p.campaign,
  keyword: p.keyword,
  oldBid: p.oldBid,
  newBid: p.newBid,
  need: p.need,
  volume: p.volume,
  position: p.position,
  reason: p.reason,
});

export async function runBids(
  deps: BidsDeps,
  project: Project,
  day: string,
  opts: {
    trigger: LedgerRow["trigger"];
    dryRun?: boolean;
    runId?: string;
    attempt?: number;
  },
): Promise<{ rows: LedgerRow[]; changes: BidChange[]; rejected: { keywordId: number; details: string }[] }> {
  const pipe = project.pipeline;
  const startedAt = iso(deps.now());
  const bidsRow = (
    status: LedgerRow["status"],
    extra: Partial<LedgerRow> = {},
  ): LedgerRow => {
    const finishedAt = iso(deps.now());
    return {
      projectId: project.id,
      jobId: "bids",
      day,
      runId: opts.runId ?? `bids-${day}`,
      attempt: opts.attempt ?? 1,
      trigger: opts.trigger,
      stageId: "bids",
      status,
      startedAt,
      finishedAt,
      durationSec: Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)),
      firstError:
        extra.firstError === undefined ? undefined : maskText(String(extra.firstError)).slice(0, 400),
      rowsIn: extra.rowsIn,
      rowsOut: extra.rowsOut,
      judge: extra.judge,
    };
  };
  const done = (
    status: LedgerRow["status"],
    extra: Partial<LedgerRow>,
    changes: BidChange[],
    rejected: { keywordId: number; details: string }[],
  ) => ({ rows: [bidsRow(status, extra)], changes, rejected });

  const bids = pipe?.bids;
  if (!pipe || bids?.enabled !== true) {
    return done("skipped", { firstError: "bids disabled" }, [], []);
  }

  const rejected: { keywordId: number; details: string }[] = [];
  let rowsIn: number | undefined;
  try {
    const client = await deps.client(pipe);
    const campaigns = await client.campaigns({ states: ["ON"] });
    const filter = pipe.campaignFilter;
    const needle = filter?.nameContains?.trim().toLowerCase();
    const skip = (bids.skipCampaigns ?? DEFAULT_SKIP_CAMPAIGNS)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const scope = new Map<number, string>();
    for (const campaign of campaigns) {
      if (campaign.State !== "ON") continue;
      if (filter?.ids?.length && !filter.ids.includes(campaign.Id)) continue;
      if (needle && !campaign.Name.toLowerCase().includes(needle)) continue;
      if (skip.some((name) => campaign.Name.includes(name))) continue;
      scope.set(campaign.Id, campaign.Name);
    }
    const matchingIds = [...scope.keys()];
    if (matchingIds.length === 0) {
      return done("skipped", { firstError: "ни одна кампания не подходит", rowsIn: 0 }, [], []);
    }

    const items: KeywordBid[] = [];
    const skippedCampaigns: string[] = [];
    for (const id of matchingIds) {
      try {
        items.push(...(await client.keywordBids([id])));
      } catch (e) {
        skippedCampaigns.push(`keywordbids ${id}: ${failMsg(e)}`);
      }
    }
    if (skippedCampaigns.length === matchingIds.length) {
      return done("failed", { firstError: skippedCampaigns.join("; ") }, [], rejected);
    }

    const keywordRows = await client.keywords(matchingIds);
    const kwText = new Map(keywordRows.map((k) => [k.Id, k.Keyword]));

    const candidates: Candidate[] = [];
    for (const item of items) {
      const forecast = item.Search?.AuctionBids?.AuctionBidItems ?? [];
      const bid = item.Search?.Bid;
      const text = kwText.get(item.KeywordId);
      if (
        forecast.length === 0 ||
        typeof bid !== "number" ||
        bid <= PARKED ||
        text === "---autotargeting"
      ) {
        continue;
      }
      candidates.push({
        keywordId: item.KeywordId,
        campaignId: item.CampaignId,
        adGroupId: item.AdGroupId,
        bid,
        forecast,
      });
    }
    rowsIn = candidates.length;

    const report = await client.keywordReport({
      dateFrom: day,
      dateTo: day,
      campaignIds: matchingIds,
      fields: ["CriterionId", "Impressions", "AvgImpressionPosition"],
    });
    const totals = new Map<number, [number, number]>();
    for (const row of report) {
      const pos = row.AvgImpressionPosition;
      if (pos === null || pos === undefined || pos === "" || pos === "--") continue;
      const id = num(row.CriterionId);
      const imp = Math.trunc(num(row.Impressions));
      const entry = totals.get(id) ?? [0, 0];
      entry[0] += imp;
      entry[1] += imp * num(pos);
      totals.set(id, entry);
    }

    const state = loadBidState(deps.db, project.id);
    const memories = new Map<number, BidMemory>();
    for (const cand of candidates) {
      const memory = state.get(cand.keywordId) ?? {
        keywordId: cand.keywordId,
        day: "",
        impressions: 0,
        weighted: 0,
        sinceImpressions: 0,
        sinceWeighted: 0,
      };
      const current = totals.get(cand.keywordId) ?? [0, 0];
      if (memory.day !== day) {
        memory.day = day;
        memory.impressions = 0;
        memory.weighted = 0;
      }
      memory.sinceImpressions += Math.max(0, current[0] - memory.impressions);
      memory.sinceWeighted += Math.max(0, current[1] - memory.weighted);
      memory.impressions = current[0];
      memory.weighted = current[1];
      memories.set(cand.keywordId, memory);
    }

    const pending: Pending[] = [];
    const cases: BidCase[] = [];
    for (const cand of candidates) {
      const memory = memories.get(cand.keywordId)!;
      const bid = cand.bid;
      const need = needOf(cand.forecast);
      const { volume, price } = currentStats(cand.forecast, bid);
      const position =
        memory.sinceImpressions >= MIN_IMPRESSIONS
          ? memory.sinceWeighted / memory.sinceImpressions
          : null;
      const rawText = kwText.get(cand.keywordId);
      const keyword = rawText === undefined ? String(cand.keywordId) : keywordText(rawText);
      const campaign = scope.get(cand.campaignId) ?? String(cand.campaignId);
      const base = { cand, keyword, campaign, oldBid: bid, need, volume, price, position };
      if (need !== null && bid < need) {
        pending.push({
          ...base,
          newBid: need,
          reason: `трафик ${volume}% < ${TRAFFIC}%: ставка на уровень ${TRAFFIC}%`,
        });
        continue;
      }
      if (position !== null && (position > POSITION || (position < TOO_HIGH && need !== null))) {
        const direction = position > POSITION ? "up" : "down";
        const steps = options(ladder(cand.forecast), bid, direction, TRAFFIC);
        if (steps.length === 0) continue;
        cases.push({
          keywordId: cand.keywordId,
          keyword,
          campaign,
          campaignId: cand.campaignId,
          adGroupId: cand.adGroupId,
          bid,
          direction,
          options: steps,
          position,
          impressions: memory.sinceImpressions,
          volume,
          price,
          need,
        });
      }
    }

    const { picks, judge } = await choose(cases, deps.ask, pipe.profile);
    for (const bidCase of cases) {
      const pick = picks.get(bidCase.keywordId);
      if (pick === undefined || pick.point === null) continue;
      const point = pick.point;
      const newBid =
        bidCase.direction === "up"
          ? point.bid
          : Math.max(point.bid, cutFloor(bidCase.bid), PARKED + BID_STEP);
      if (newBid === bidCase.bid || (bidCase.direction === "down" && newBid >= bidCase.bid)) {
        continue;
      }
      const word = bidCase.direction === "up" ? "хуже 3" : "лучше 1.5";
      const note = pick.judge === "fallback" ? "Jev недоступен, 1 ступень" : pick.judge;
      let reason =
        `позиция ${bidCase.position.toFixed(2)} ${word} за ${bidCase.impressions} показов → ` +
        `объём ${point.volume}%, прогноз цены клика ${Math.round(point.price / MICRO)} ₽ ` +
        `(${note}, уверенность ${pick.confidence})`;
      if (newBid !== point.bid) reason += "; снижение ограничено 30% за прогон";
      pending.push({
        cand: {
          keywordId: bidCase.keywordId,
          campaignId: bidCase.campaignId,
          adGroupId: bidCase.adGroupId,
          bid: bidCase.bid,
          forecast: [],
        },
        keyword: bidCase.keyword,
        campaign: bidCase.campaign,
        oldBid: bidCase.bid,
        newBid,
        need: bidCase.need,
        volume: bidCase.volume,
        price: bidCase.price,
        position: bidCase.position,
        reason,
      });
    }

    const changes = pending
      .filter((p) => p.newBid !== p.oldBid)
      .map(toChange);

    const apply = bids.apply === true && opts.dryRun !== true;
    let applied: BidChange[] = [];
    if (apply) {
      for (let i = 0; i < changes.length; i += 1000) {
        const chunk = changes.slice(i, i + 1000);
        const res = await client.setKeywordBids(
          chunk.map((change) => ({ keywordId: change.keywordId, searchBid: change.newBid })),
        );
        rejected.push(...res.rejected);
        const okIds = new Set(res.ok);
        const okChunk = chunk.filter((change) => okIds.has(change.keywordId));
        const at = iso(deps.now());
        for (const change of okChunk) {
          const memory = memories.get(change.keywordId);
          if (memory !== undefined) {
            memory.sinceImpressions = 0;
            memory.sinceWeighted = 0;
          }
          recordChange(deps.db, {
            at,
            accountId: pipe.accountId,
            clientLogin: pipe.clientLogin,
            source: "job",
            actor: "bids",
            objectType: "keyword",
            objectId: String(change.keywordId),
            campaignId: change.campaignId,
            adGroupId: change.adGroupId,
            field: "SearchBid",
            before: change.oldBid / MICRO,
            after: change.newBid / MICRO,
            note: change.reason,
          });
        }
        applied.push(...okChunk);
        saveBidState(
          deps.db,
          project.id,
          okChunk.map((change) => memories.get(change.keywordId)!),
        );
      }
      saveBidState(deps.db, project.id, [...memories.values()]);
    }

    const notes: string[] = [];
    if (!apply) notes.push(`proposal: ${changes.length} changes (apply off)`);
    if (skippedCampaigns.length > 0) notes.push(`${skippedCampaigns.length} campaigns skipped`);
    if (rejected.length > 0) notes.push(`${rejected.length} rejected`);

    const sheetId = pipe.stats?.sheetId;
    if (apply && applied.length > 0 && pipe.stats?.enabled === true && sheetId) {
      try {
        const sheets = await deps.sheets!();
        const stamp = moscowStamp(deps.now());
        const values = applied.map((change) => [
          stamp,
          change.campaign,
          keywordText(change.keyword),
          change.oldBid / MICRO,
          change.newBid / MICRO,
          round2((change.newBid - change.oldBid) / MICRO),
          change.need === null ? "" : change.need / MICRO,
          change.volume,
          change.position === null ? "" : round2(change.position),
          change.reason,
        ]);
        await appendRows(sheets, sheetId, "Ставки", [...BIDS_HEADER], values);
      } catch (e) {
        notes.push(`sheet: ${failMsg(e)}`);
      }
    }

    return done(
      "ok",
      {
        rowsIn,
        rowsOut: apply ? applied.length : changes.length,
        judge: cases.length > 0 ? judge || "fallback" : undefined,
        firstError: notes.length > 0 ? notes.join("; ") : undefined,
      },
      changes,
      rejected,
    );
  } catch (e) {
    return done("failed", { firstError: failMsg(e), rowsIn }, [], rejected);
  }
}

