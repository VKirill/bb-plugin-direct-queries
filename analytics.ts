import type { DirectClient, SearchQueryRow } from "./direct.ts";
import type { en } from "./i18n.ts";

export type Strings = typeof en;

export interface Totals {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
}

export type DayRow = Totals & { date: string };

export type CampaignRow = Totals & {
  campaignId: number;
  campaignName: string;
  campaignType: string;
  searchImpressions: number;
  searchClicks: number;
  searchCtr: number | null;
};

export type GoalRow = { goalId: number; conversions: number; cpa: number | null };

export type Summary = {
  totals: Totals;
  byDay: DayRow[];
  byCampaign: CampaignRow[];
  byGoal: GoalRow[];
};

export type Recommendation = {
  campaignId: number;
  campaignName: string;
  kind: "zeroConversions" | "highCpa" | "lowSearchCtr" | "costShare";
  value: number;
  threshold: number;
};

const num = (value: string | number | null | undefined): number => {
  if (typeof value === "number") return value;
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const percent = (part: number, whole: number): number | null =>
  whole === 0 ? null : (part / whole) * 100;

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

const finalize = <T extends Totals>(totals: T): T => ({
  ...totals,
  ctr: percent(totals.clicks, totals.impressions),
  cpc: ratio(totals.cost, totals.clicks),
  cpa: ratio(totals.cost, totals.conversions),
});

function conversionsOf(row: SearchQueryRow, goals: number[]): number {
  if (goals.length === 0) return num(row.Conversions);
  // Direct counts a visit that reaches two goals twice: every goal column is summed.
  return goals.reduce((sum, goal) => sum + num(row[`Conversions_${goal}_AUTO`]), 0);
}

export function summarize(rows: SearchQueryRow[], goals: number[] = []): Summary {
  const uniqueGoals = [...new Set(goals)];
  const totals: Totals = {
    impressions: 0,
    clicks: 0,
    cost: 0,
    conversions: 0,
    ctr: null,
    cpc: null,
    cpa: null,
  };
  const dayMap = new Map<string, DayRow>();
  const campaignMap = new Map<number, CampaignRow>();

  for (const row of rows) {
    const impressions = num(row.Impressions);
    const clicks = num(row.Clicks);
    const cost = num(row.Cost);
    const conversions = conversionsOf(row, uniqueGoals);
    const date = String(row.Date ?? "");
    const campaignId = num(row.CampaignId);
    const campaignName = String(row.CampaignName ?? "");
    const campaignType = String(row.CampaignType ?? "");
    const search = row.AdNetworkType === "SEARCH";

    totals.impressions += impressions;
    totals.clicks += clicks;
    totals.cost += cost;
    totals.conversions += conversions;

    let day = dayMap.get(date);
    if (!day) {
      day = { date, impressions: 0, clicks: 0, cost: 0, conversions: 0, ctr: null, cpc: null, cpa: null };
      dayMap.set(date, day);
    }
    day.impressions += impressions;
    day.clicks += clicks;
    day.cost += cost;
    day.conversions += conversions;

    let campaign = campaignMap.get(campaignId);
    if (!campaign) {
      campaign = {
        campaignId,
        campaignName,
        campaignType,
        impressions: 0,
        clicks: 0,
        cost: 0,
        conversions: 0,
        ctr: null,
        cpc: null,
        cpa: null,
        searchImpressions: 0,
        searchClicks: 0,
        searchCtr: null,
      };
      campaignMap.set(campaignId, campaign);
    }
    campaign.impressions += impressions;
    campaign.clicks += clicks;
    campaign.cost += cost;
    campaign.conversions += conversions;
    if (search) {
      campaign.searchImpressions += impressions;
      campaign.searchClicks += clicks;
    }
  }

  const byDay = [...dayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(finalize);
  const byCampaign = [...campaignMap.values()]
    .sort((a, b) => b.cost - a.cost)
    .map((campaign) => ({
      ...campaign,
      ...finalize(campaign),
      searchCtr: percent(campaign.searchClicks, campaign.searchImpressions),
    }));
  const byGoal: GoalRow[] = uniqueGoals.map((goal) => {
    const conversions = rows.reduce(
      (sum, row) => sum + num(row[`Conversions_${goal}_AUTO`]),
      0,
    );
    return { goalId: goal, conversions, cpa: ratio(totals.cost, conversions) };
  });

  return { totals: finalize(totals), byDay, byCampaign, byGoal };
}

export function recommend(summary: Summary): Recommendation[] {
  const accountCpa = summary.totals.cpa;
  const out: Recommendation[] = [];
  for (const campaign of summary.byCampaign) {
    const base = { campaignId: campaign.campaignId, campaignName: campaign.campaignName };
    if (campaign.conversions === 0 && campaign.cost > 0) {
      out.push({ ...base, kind: "zeroConversions", value: campaign.cost, threshold: 0 });
    }
    if (campaign.cpa !== null && accountCpa !== null && campaign.cpa > 1.5 * accountCpa) {
      out.push({ ...base, kind: "highCpa", value: campaign.cpa, threshold: 1.5 * accountCpa });
    }
    if (campaign.searchImpressions >= 1000 && campaign.searchCtr !== null && campaign.searchCtr < 1) {
      out.push({ ...base, kind: "lowSearchCtr", value: campaign.searchCtr, threshold: 1 });
    }
    if (
      summary.byCampaign.length >= 2 &&
      summary.totals.conversions > 0 &&
      campaign.cost / summary.totals.cost > 0.5 &&
      campaign.conversions / summary.totals.conversions < 0.2
    ) {
      out.push({
        ...base,
        kind: "costShare",
        value: campaign.cost / summary.totals.cost,
        threshold: 0.2,
      });
    }
  }
  return out;
}

const ALL_CAMPAIGN_STATES = ["ON", "SUSPENDED", "OFF", "ENDED", "ARCHIVED", "CONVERTED"];

export async function runAnalytics(
  client: Pick<DirectClient, "campaigns" | "campaignGoals" | "performanceReport">,
  args: { from: string; to: string; goals?: number[] },
): Promise<{ goals: number[]; summary: Summary; recommendations: Recommendation[] }> {
  let goals = args.goals === undefined ? undefined : [...new Set(args.goals)].sort((a, b) => a - b);
  if (goals === undefined) {
    // The performance report covers every campaign state, so discovery must too.
    const campaigns = await client.campaigns({ states: ALL_CAMPAIGN_STATES });
    const ids = campaigns.map((campaign) => campaign.Id);
    const discovered = ids.length ? await client.campaignGoals(ids) : new Map<number, number[]>();
    goals = [...new Set(ids.flatMap((id) => discovered.get(id) ?? []))].sort((a, b) => a - b);
  }
  const rows = await client.performanceReport({ dateFrom: args.from, dateTo: args.to, goals });
  const summary = summarize(rows, goals);
  return { goals, summary, recommendations: recommend(summary) };
}

const money = (value: number): string => value.toFixed(2);
const percentText = (value: number): string => `${Math.round(value * 100)}%`;
const plain = (value: number): string => String(value);

export function recommendationText(recommendation: Recommendation, t: Strings): string {
  const fill = (template: string, value: string, threshold: string): string =>
    template
      .replace("{name}", recommendation.campaignName)
      .replace("{value}", value)
      .replace("{threshold}", threshold);
  switch (recommendation.kind) {
    case "zeroConversions":
      return fill(t.recZeroConversions, money(recommendation.value), money(recommendation.threshold));
    case "highCpa":
      return fill(t.recHighCpa, money(recommendation.value), money(recommendation.threshold));
    case "lowSearchCtr":
      return fill(t.recLowSearchCtr, plain(recommendation.value), plain(recommendation.threshold));
    case "costShare":
      return fill(
        t.recCostShare,
        percentText(recommendation.value),
        percentText(recommendation.threshold),
      );
  }
}
