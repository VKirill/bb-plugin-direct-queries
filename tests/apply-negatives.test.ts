import { describe, expect, it } from "vitest";
import type { AdGroup, Campaign, Keyword } from "../direct.ts";
import { applyNegatives, type NegativesDirect } from "../apply-negatives.ts";
import { phraseLength } from "../library.ts";

const campaign = (over: Partial<Campaign>): Campaign => ({
  Id: 1,
  Name: "Camp",
  State: "ON",
  Status: "ACCEPTED",
  Type: "TEXT_CAMPAIGN",
  ...over,
});

const group = (over: Partial<AdGroup>): AdGroup => ({
  Id: 10,
  CampaignId: 1,
  Name: "Group",
  ...over,
});

const keyword = (over: Partial<Keyword>): Keyword => ({
  Id: 100,
  Keyword: "купить фильтр",
  CampaignId: 1,
  AdGroupId: 10,
  State: "ON",
  ...over,
});

function fakeDirect() {
  const calls = {
    campaignUpdates: [] as { id: number; phrases: string[] }[][],
    groupUpdates: [] as { id: number; phrases: string[] }[][],
    keywordUpdates: [] as { id: number; keyword: string }[][],
  };
  const direct: NegativesDirect = {
    updateCampaignNegatives: async (items) => {
      calls.campaignUpdates.push(items);
      return items;
    },
    updateAdGroupNegatives: async (items) => {
      calls.groupUpdates.push(items);
      return items;
    },
    updateKeywords: async (items) => {
      calls.keywordUpdates.push(items);
      return items;
    },
  };
  return { direct, calls };
}

describe("applyNegatives campaign level", () => {
  it("merges approved phrases into existing negatives without duplicates, one update per campaign", async () => {
    const { direct, calls } = fakeDirect();
    const campaigns = [
      campaign({ Id: 1, Name: "A", NegativeKeywords: { Items: ["бесплатно"] } }),
      campaign({ Id: 2, Name: "B", NegativeKeywords: { Items: [] } }),
    ];
    const result = await applyNegatives(direct, {
      level: "campaign",
      apply: true,
      campaigns,
      groups: [],
      keywords: [],
      approved: [
        { query: "q1", phrase: "бесплатно", campaignId: 1 },
        { query: "q2", phrase: "своими руками", campaignId: 1 },
        { query: "q2b", phrase: "своими руками", campaignId: 1 },
        { query: "q3", phrase: "ещё минус", campaignId: 2 },
        { query: "q4", phrase: "бесплатно доставка", campaignId: 1 },
      ],
    });
    expect(calls.campaignUpdates).toHaveLength(2);
    const a = calls.campaignUpdates.find((u) => u[0].id === 1)!;
    const b = calls.campaignUpdates.find((u) => u[0].id === 2)!;
    expect(a[0].phrases).toEqual(["бесплатно", "своими руками"]);
    expect(b[0].phrases).toEqual(["ещё минус"]);
    expect(result.campaigns.map((c) => c.campaignId)).toEqual([1, 2]);
    expect(result.campaigns[0].added).toEqual(["своими руками"]);
    expect(calls.groupUpdates).toHaveLength(0);
    expect(calls.keywordUpdates).toHaveLength(0);
  });

  it("skips phrases whose campaign cannot be resolved", async () => {
    const { direct, calls } = fakeDirect();
    const result = await applyNegatives(direct, {
      level: "campaign",
      apply: true,
      campaigns: [campaign({ Id: 1 })],
      groups: [],
      keywords: [],
      approved: [{ query: "q", phrase: "новый минус", campaignId: 999 }],
    });
    expect(calls.campaignUpdates).toHaveLength(0);
    expect(result.campaigns).toHaveLength(0);
    expect(result.skipped).toEqual([
      { query: "q", phrase: "новый минус", reason: "campaign not found" },
    ]);
  });
});

describe("applyNegatives adgroup level", () => {
  it("never sends a group more than 4096 characters and lists the overflow", async () => {
    const { direct, calls } = fakeDirect();
    const filler = "x".repeat(3800);
    const campaigns = [campaign({ Id: 1 }), campaign({ Id: 2, Name: "B" })];
    const groups = [
      group({ Id: 10, CampaignId: 1, NegativeKeywords: { Items: [filler] } }),
      group({ Id: 11, CampaignId: 1, NegativeKeywords: { Items: [] } }),
      group({ Id: 12, CampaignId: 2, NegativeKeywords: { Items: [] } }),
      group({ Id: 13, CampaignId: 2, NegativeKeywords: { Items: [] } }),
    ];
    const result = await applyNegatives(direct, {
      level: "adgroup",
      apply: true,
      campaigns,
      groups,
      keywords: [],
      approved: [
        { query: "q1", phrase: "а".repeat(200), adGroupId: 10 },
        { query: "q2", phrase: "б".repeat(200), adGroupId: 10 },
        { query: "q3", phrase: "в".repeat(200), adGroupId: 10 },
        { query: "q4", phrase: "свой минус", campaignId: 2 },
      ],
    });
    const sent = calls.groupUpdates.flat();
    for (const item of sent) {
      expect(phraseLength(item.phrases)).toBeLessThanOrEqual(4096);
    }
    const g10 = result.groups.find((g) => g.groupId === 10)!;
    expect(g10.added).toEqual(["а".repeat(200)]);
    expect(g10.overflow).toEqual(["б".repeat(200), "в".repeat(200)]);
    // a campaign-level item fans out to every group of that campaign
    expect(result.groups.find((g) => g.groupId === 12)?.added).toEqual(["свой минус"]);
    expect(result.groups.find((g) => g.groupId === 13)?.added).toEqual(["свой минус"]);
    expect(result.groups.some((g) => g.groupId === 11)).toBe(false);
    const sent10 = calls.groupUpdates.flat().find((u) => u.id === 10)!;
    expect(sent10.phrases).toEqual([filler, "а".repeat(200)]);
  });
});

describe("applyNegatives keyword level", () => {
  it("appends ' -word' to the matched keyword and sends a two-word phrase to the ad group", async () => {
    const { direct, calls } = fakeDirect();
    const groups = [group({ Id: 10, CampaignId: 1, NegativeKeywords: { Items: [] } })];
    const keywords = [
      keyword({ Id: 100, Keyword: "купить фильтр", CampaignId: 1, AdGroupId: 10 }),
      keyword({ Id: 101, Keyword: "другое", CampaignId: 1, AdGroupId: 10 }),
    ];
    const result = await applyNegatives(direct, {
      level: "keyword",
      apply: true,
      campaigns: [campaign({ Id: 1 })],
      groups,
      keywords,
      approved: [
        { query: "купить фильтр бесплатно", phrase: "бесплатно", adGroupId: 10 },
        { query: "купить фильтр своими руками", phrase: "своими руками", adGroupId: 10 },
      ],
    });
    expect(calls.keywordUpdates).toEqual([
      [{ id: 100, keyword: "купить фильтр -бесплатно" }],
    ]);
    expect(calls.groupUpdates).toEqual([
      [{ id: 10, phrases: ["своими руками"] }],
    ]);
    expect(result.keywords).toEqual([
      { keywordId: 100, keyword: "купить фильтр -бесплатно", minusWords: ["бесплатно"] },
    ]);
    expect(result.groups[0].added).toEqual(["своими руками"]);
  });
});

describe("applyNegatives apply flag", () => {
  it("apply false makes no Direct write call and returns the planned changes", async () => {
    const { direct, calls } = fakeDirect();
    const result = await applyNegatives(direct, {
      level: "campaign",
      apply: false,
      campaigns: [campaign({ Id: 1, NegativeKeywords: { Items: ["старый"] } })],
      groups: [],
      keywords: [],
      approved: [{ query: "q", phrase: "новый минус", campaignId: 1 }],
    });
    expect(calls.campaignUpdates).toHaveLength(0);
    expect(calls.groupUpdates).toHaveLength(0);
    expect(calls.keywordUpdates).toHaveLength(0);
    expect(result.applied).toBe(false);
    expect(result.campaigns).toEqual([
      {
        campaignId: 1,
        campaignName: "Camp",
        phrases: ["старый", "новый минус"],
        added: ["новый минус"],
        overflow: [],
      },
    ]);
  });
});
