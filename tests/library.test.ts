import { describe, expect, it } from "vitest";
import type { AdGroup, Campaign, Keyword, SharedSet } from "../direct.ts";
import {
  applyLibrarySync,
  covered,
  libraryName,
  negativesIndex,
  phraseLength,
  planLibrarySync,
  type LibraryDirect,
  type LibraryPlan,
} from "../library.ts";

const campaign = (id: number, name: string): Campaign => ({
  Id: id,
  Name: name,
  State: "ON",
  Status: "ACCEPTED",
  Type: "TEXT_CAMPAIGN",
});

const group = (id: number, campaignId: number, sharedSetIds: number[] = []): AdGroup => ({
  Id: id,
  CampaignId: campaignId,
  Name: `Группа ${id}`,
  NegativeKeywordSharedSetIds: sharedSetIds,
});

const set = (id: number, name: string, phrases: string[]): SharedSet => ({
  Id: id,
  Name: name,
  NegativeKeywords: phrases,
});

const keyword = (id: number, campaignId: number, text: string, adGroupId = 1): Keyword => ({
  Id: id,
  Keyword: text,
  CampaignId: campaignId,
  AdGroupId: adGroupId,
  State: "ON",
});

function recordingDirect(failCampaign?: (name: string) => boolean) {
  const calls: string[] = [];
  let nextId = 500;
  const attached: { id: number; sharedSetIds: number[] }[] = [];
  const created: { id: number; name: string; phrases: string[] }[] = [];
  const direct: LibraryDirect = {
    addSharedSet: async (name, phrases) => {
      calls.push("addSharedSet");
      if (failCampaign?.(name)) throw new Error(`write failed: ${name}`);
      const id = nextId++;
      created.push({ id, name, phrases });
      return id;
    },
    updateSharedSet: async (id, phrases) => {
      calls.push("updateSharedSet");
      if (failCampaign?.(String(id))) throw new Error(`write failed: ${id}`);
      return phrases;
    },
    updateAdGroupSharedSets: async (items) => {
      calls.push("updateAdGroupSharedSets");
      attached.push(...items);
      return items;
    },
    deleteKeywords: async (ids) => {
      calls.push("deleteKeywords");
      return ids;
    },
  };
  return { direct, calls, attached, created };
}

describe("covered", () => {
  it("treats ё and е as the same letter", () => {
    const index = negativesIndex(["взрывозащищенный вибратор"]);
    expect(covered("взрывозащищённый вибратор", index)).toBe(true);
    expect(covered("взрывозащищённый вибратор цена", index)).toBe(true);
  });
});

describe("planLibrarySync", () => {
  it("splits a library over 4096 characters into a second one", () => {
    const full = Array.from({ length: 120 }, (_, index) => "а".repeat(30) + ` ${String(index).padStart(3, "0")}`);
    expect(phraseLength(full)).toBe(3960);
    const name = libraryName("Кампания A");
    const plan = planLibrarySync({
      campaigns: [campaign(1, "Кампания A")],
      groups: [group(10, 1, [40])],
      sharedSets: [set(40, name, full)],
      keywords: [],
      approved: [{ phrase: "б".repeat(300), campaignId: 1 }],
    });
    expect(plan.campaigns).toHaveLength(1);
    expect(plan.campaigns[0].creates).toEqual([{ name: `${name} 2`, phrases: ["б".repeat(300)] }]);
    expect(plan.campaigns[0].updates).toEqual([]);
  });

  it("marks a keyword that contains an approved negative for deletion", () => {
    const plan = planLibrarySync({
      campaigns: [campaign(1, "Кампания A")],
      groups: [group(10, 1)],
      sharedSets: [],
      keywords: [keyword(88, 1, "купить фильтр бесплатно")],
      approved: [{ phrase: "бесплатно", campaignId: 1 }],
    });
    expect(plan.campaigns[0].deleteKeywords).toEqual([
      { Id: 88, Keyword: "купить фильтр бесплатно", CampaignId: 1, AdGroupId: 1 },
    ]);
  });
});

describe("applyLibrarySync", () => {
  const twoCampaigns = (): { input: Parameters<typeof planLibrarySync>[0]; plan: LibraryPlan } => {
    const input = {
      campaigns: [campaign(1, "Кампания A"), campaign(2, "Кампания B")],
      groups: [group(11, 1, [99]), group(22, 2, [77])],
      sharedSets: [] as SharedSet[],
      keywords: [] as Keyword[],
      approved: [
        { phrase: "своими руками", campaignId: 1 },
        { phrase: "бесплатно", campaignId: 2 },
      ],
    };
    return { input, plan: planLibrarySync(input) };
  };

  it("makes no write call when apply is false", async () => {
    const { plan } = twoCampaigns();
    const { direct, calls } = recordingDirect();
    const result = await applyLibrarySync(direct, plan, { apply: false });
    expect(calls).toEqual([]);
    expect(result).toEqual({ added: 0, created: 0, attached: 0, deletedKeywords: [], errors: [] });
  });

  it("reports a write error in campaign A while campaign B is synced", async () => {
    const { plan } = twoCampaigns();
    const { direct, calls, created, attached } = recordingDirect((name) => name === libraryName("Кампания A"));
    const result = await applyLibrarySync(direct, plan, { apply: true });
    expect(result.errors).toEqual([{ campaignId: 1, error: `write failed: ${libraryName("Кампания A")}` }]);
    expect(result.created).toBe(1);
    expect(result.added).toBe(1);
    expect(result.attached).toBe(1);
    expect(created).toEqual([{ id: 500, name: libraryName("Кампания B"), phrases: ["бесплатно"] }]);
    expect(attached).toEqual([{ id: 22, sharedSetIds: [77, 500] }]);
    expect(calls.includes("addSharedSet")).toBe(true);
  });

  it("keeps a group's existing set ids when attaching the new library", async () => {
    const plan = planLibrarySync({
      campaigns: [campaign(1, "Кампания A")],
      groups: [group(11, 1, [99])],
      sharedSets: [],
      keywords: [],
      approved: [{ phrase: "бесплатно", campaignId: 1 }],
    });
    const { direct, attached } = recordingDirect();
    await applyLibrarySync(direct, plan, { apply: true });
    expect(attached).toEqual([{ id: 11, sharedSetIds: [99, 500] }]);
  });
});
