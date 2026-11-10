// Writes approved negative phrases into Yandex Direct at the level the project
// chose: campaign negatives, ad-group negatives or keyword minus-words.
// The 'library' level stays on the shared-set path in library.ts.

import type { AdGroup, Campaign, Keyword } from "./direct.ts";
import { covered, negativesIndex, phraseKey, phraseLength } from "./library.ts";
import { directSafe, words } from "./negatives.ts";

export const CAMPAIGN_NEGATIVES_CHAR_LIMIT = 20000;
export const GROUP_NEGATIVES_CHAR_LIMIT = 4096;
export const KEYWORD_CHAR_LIMIT = 4096;

const OPERATOR = /[!\[\]"]+/;

export type ApplyNegativesLevel = "campaign" | "adgroup" | "keyword";

export interface ApprovedNegative {
  query: string;
  phrase: string;
  campaignId?: number;
  adGroupId?: number;
  campaign?: string;
}

export interface NegativesDirect {
  updateCampaignNegatives(items: { id: number; phrases: string[] }[]): Promise<unknown>;
  updateAdGroupNegatives(items: { id: number; phrases: string[] }[]): Promise<unknown>;
  updateKeywords(items: { id: number; keyword: string }[]): Promise<unknown>;
}

export interface CampaignNegativesPlan {
  campaignId: number;
  campaignName: string;
  phrases: string[];
  added: string[];
  overflow: string[];
}

export interface GroupNegativesPlan {
  groupId: number;
  groupName: string;
  phrases: string[];
  added: string[];
  overflow: string[];
}

export interface KeywordNegativesPlan {
  keywordId: number;
  keyword: string;
  minusWords: string[];
}

export interface SkippedNegative {
  query: string;
  phrase: string;
  reason: string;
}

export interface NegativesError {
  target: string;
  error: string;
}

export interface NegativesPlan {
  campaigns: CampaignNegativesPlan[];
  groups: GroupNegativesPlan[];
  keywords: KeywordNegativesPlan[];
  skipped: SkippedNegative[];
  errors: NegativesError[];
}

export interface NegativesResult extends NegativesPlan {
  applied: boolean;
}

interface NegativesInput {
  approved: ApprovedNegative[];
  campaigns: Campaign[];
  groups: AdGroup[];
  keywords: Keyword[];
}

function existingNegatives(owner: { NegativeKeywords?: { Items?: string[] } }): string[] {
  return owner.NegativeKeywords?.Items ?? [];
}

function mergeNegatives(
  existing: string[],
  rawAdditions: string[],
  limit: number,
): { phrases: string[]; added: string[]; overflow: string[] } {
  const index = negativesIndex(existing);
  const phrases = [...existing];
  const added: string[] = [];
  const overflow: string[] = [];
  let length = phraseLength(existing);
  for (const raw of rawAdditions) {
    const item = directSafe(raw);
    if (!item || covered(item, index)) continue;
    const cost = phraseLength([item]);
    if (length + cost > limit) {
      overflow.push(item);
      continue;
    }
    phrases.push(item);
    added.push(item);
    length += cost;
    index[0].add(phraseKey(item));
    if (!OPERATOR.test(item)) {
      index[1].push(new Set(phraseKey(item).split(" ").filter(Boolean)));
    }
  }
  return { phrases, added, overflow };
}

function findCampaign(input: NegativesInput, item: ApprovedNegative): Campaign | undefined {
  if (item.campaignId !== undefined) {
    const found = input.campaigns.find((c) => c.Id === item.campaignId);
    if (found) return found;
  }
  if (item.adGroupId !== undefined) {
    const group = input.groups.find((g) => g.Id === item.adGroupId);
    const campaign = group && input.campaigns.find((c) => c.Id === group.CampaignId);
    if (campaign) return campaign;
  }
  if (item.campaign) {
    const name = item.campaign.trim().toLowerCase();
    return input.campaigns.find((c) => c.Name.trim().toLowerCase() === name);
  }
  return undefined;
}

function groupsFor(input: NegativesInput, item: ApprovedNegative): AdGroup[] {
  if (item.adGroupId !== undefined) {
    const group = input.groups.find((g) => g.Id === item.adGroupId);
    return group ? [group] : [];
  }
  const campaign = findCampaign(input, item);
  if (!campaign) return [];
  return input.groups.filter((g) => g.CampaignId === campaign.Id);
}

function pushSkipped(plan: NegativesPlan, item: ApprovedNegative, reason: string): void {
  plan.skipped.push({ query: item.query, phrase: item.phrase, reason });
}

function planCampaignLevel(input: NegativesInput, plan: NegativesPlan): void {
  const byCampaign = new Map<number, ApprovedNegative[]>();
  for (const item of input.approved) {
    const campaign = findCampaign(input, item);
    if (!campaign) {
      pushSkipped(plan, item, "campaign not found");
      continue;
    }
    const list = byCampaign.get(campaign.Id) ?? [];
    list.push(item);
    byCampaign.set(campaign.Id, list);
  }
  for (const [campaignId, items] of byCampaign) {
    const campaign = input.campaigns.find((c) => c.Id === campaignId)!;
    const merged = mergeNegatives(
      existingNegatives(campaign),
      items.map((item) => item.phrase),
      CAMPAIGN_NEGATIVES_CHAR_LIMIT,
    );
    if (!merged.added.length && !merged.overflow.length) continue;
    plan.campaigns.push({
      campaignId: campaign.Id,
      campaignName: campaign.Name,
      phrases: merged.phrases,
      added: merged.added,
      overflow: merged.overflow,
    });
  }
}

function planGroupLevel(input: NegativesInput, plan: NegativesPlan): void {
  const byGroup = new Map<number, ApprovedNegative[]>();
  for (const item of input.approved) {
    const groups = groupsFor(input, item);
    if (!groups.length) {
      pushSkipped(plan, item, "ad group not found");
      continue;
    }
    for (const group of groups) {
      const list = byGroup.get(group.Id) ?? [];
      list.push(item);
      byGroup.set(group.Id, list);
    }
  }
  for (const [groupId, items] of byGroup) {
    const group = input.groups.find((g) => g.Id === groupId)!;
    const merged = mergeNegatives(
      existingNegatives(group),
      items.map((item) => item.phrase),
      GROUP_NEGATIVES_CHAR_LIMIT,
    );
    if (!merged.added.length && !merged.overflow.length) continue;
    plan.groups.push({
      groupId: group.Id,
      groupName: group.Name,
      phrases: merged.phrases,
      added: merged.added,
      overflow: merged.overflow,
    });
  }
}

interface KeywordScope {
  keywords: Keyword[];
  fallbackGroups: () => AdGroup[];
}

function keywordScope(input: NegativesInput, item: ApprovedNegative, plan: NegativesPlan): KeywordScope | undefined {
  if (item.adGroupId !== undefined) {
    const group = input.groups.find((g) => g.Id === item.adGroupId);
    return {
      keywords: input.keywords.filter((k) => k.AdGroupId === item.adGroupId),
      fallbackGroups: () => (group ? [group] : []),
    };
  }
  const campaign = findCampaign(input, item);
  if (!campaign) {
    pushSkipped(plan, item, "campaign not found");
    return undefined;
  }
  return {
    keywords: input.keywords.filter((k) => k.CampaignId === campaign.Id),
    fallbackGroups: () => input.groups.filter((g) => g.CampaignId === campaign.Id),
  };
}

function keywordMatches(keyword: Keyword, query: string): boolean {
  const positive = words(keyword.Keyword.split(" -")[0]);
  if (!positive.length) return false;
  const queryTokens = new Set(words(query));
  return positive.every((w) => queryTokens.has(w));
}

function existingMinusWords(keyword: Keyword): Set<string> {
  const minus = keyword.Keyword.split(" -").slice(1).join(" ");
  return new Set(words(minus));
}

function planKeywordLevel(input: NegativesInput, plan: NegativesPlan): void {
  const updates = new Map<number, { keyword: Keyword; minusWords: string[]; seen: Set<string> }>();
  const groupFallback = new Map<number, ApprovedNegative[]>();

  const addToGroups = (item: ApprovedNegative, groups: AdGroup[]): void => {
    if (!groups.length) {
      pushSkipped(plan, item, "ad group not found");
      return;
    }
    for (const group of groups) {
      const list = groupFallback.get(group.Id) ?? [];
      list.push(item);
      groupFallback.set(group.Id, list);
    }
  };

  for (const item of input.approved) {
    const scope = keywordScope(input, item, plan);
    if (!scope) continue;
    const minusWords = words(item.phrase);
    const matched = scope.keywords.filter((k) => keywordMatches(k, item.query));
    if (minusWords.length !== 1 || !matched.length) {
      addToGroups(item, scope.fallbackGroups());
      continue;
    }
    const minusWord = minusWords[0];
    for (const keyword of matched) {
      const entry = updates.get(keyword.Id) ?? {
        keyword,
        minusWords: [],
        seen: existingMinusWords(keyword),
      };
      if (entry.seen.has(minusWord)) continue;
      const prospective = `${keyword.Keyword}${[...entry.minusWords, minusWord]
        .map((w) => ` -${w}`)
        .join("")}`;
      if (prospective.length > KEYWORD_CHAR_LIMIT) {
        pushSkipped(plan, item, "keyword too long");
        continue;
      }
      entry.minusWords.push(minusWord);
      entry.seen.add(minusWord);
      updates.set(keyword.Id, entry);
    }
  }

  for (const { keyword, minusWords } of updates.values()) {
    const suffix = minusWords.map((w) => ` -${w}`).join("");
    plan.keywords.push({
      keywordId: keyword.Id,
      keyword: `${keyword.Keyword}${suffix}`,
      minusWords,
    });
  }

  for (const [groupId, items] of groupFallback) {
    const group = input.groups.find((g) => g.Id === groupId)!;
    const merged = mergeNegatives(
      existingNegatives(group),
      items.map((item) => item.phrase),
      GROUP_NEGATIVES_CHAR_LIMIT,
    );
    if (!merged.added.length && !merged.overflow.length) continue;
    plan.groups.push({
      groupId: group.Id,
      groupName: group.Name,
      phrases: merged.phrases,
      added: merged.added,
      overflow: merged.overflow,
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writePlan(direct: NegativesDirect, plan: NegativesPlan): Promise<void> {
  for (const campaign of plan.campaigns) {
    if (!campaign.added.length) continue;
    try {
      await direct.updateCampaignNegatives([{ id: campaign.campaignId, phrases: campaign.phrases }]);
    } catch (err) {
      plan.errors.push({ target: `campaign ${campaign.campaignId}`, error: errorMessage(err) });
    }
  }
  const groups = plan.groups.filter((group) => group.added.length);
  if (groups.length) {
    try {
      await direct.updateAdGroupNegatives(
        groups.map((group) => ({ id: group.groupId, phrases: group.phrases })),
      );
    } catch (err) {
      plan.errors.push({ target: "ad groups", error: errorMessage(err) });
    }
  }
  if (plan.keywords.length) {
    try {
      await direct.updateKeywords(
        plan.keywords.map((keyword) => ({ id: keyword.keywordId, keyword: keyword.keyword })),
      );
    } catch (err) {
      plan.errors.push({ target: "keywords", error: errorMessage(err) });
    }
  }
}

export async function applyNegatives(
  direct: NegativesDirect,
  input: {
    level: ApplyNegativesLevel;
    apply: boolean;
    approved: ApprovedNegative[];
    campaigns: Campaign[];
    groups: AdGroup[];
    keywords: Keyword[];
  },
): Promise<NegativesResult> {
  const plan: NegativesPlan = { campaigns: [], groups: [], keywords: [], skipped: [], errors: [] };
  const scope: NegativesInput = {
    approved: input.approved,
    campaigns: input.campaigns,
    groups: input.groups,
    keywords: input.keywords,
  };
  if (input.level === "campaign") planCampaignLevel(scope, plan);
  else if (input.level === "adgroup") planGroupLevel(scope, plan);
  else planKeywordLevel(scope, plan);
  if (input.apply) await writePlan(direct, plan);
  return { ...plan, applied: input.apply };
}
