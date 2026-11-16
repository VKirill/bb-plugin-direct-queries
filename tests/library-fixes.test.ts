import { describe, expect, it } from "vitest";
import {
  createDirectClient,
  DirectItemRejected,
  type AdGroup,
  type Campaign,
} from "../direct.ts";
import { applyNegatives, type NegativesDirect } from "../apply-negatives.ts";
import { applyLibrarySync, keywordConflicts, planLibrarySync, type LibraryDirect } from "../library.ts";

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

describe("keywordConflicts word forms", () => {
  it("does not treat different Russian word forms as the same word", () => {
    expect(keywordConflicts("скрубберщик вакансии", ["скруббер"])).toEqual([]);
    expect(keywordConflicts("очистка газона", ["газов"])).toEqual([]);
  });

  it("still matches a word form that differs only by an ending", () => {
    expect(keywordConflicts("скрубберы для очистки газов", ["скруббер"])).toEqual(["скруббер"]);
    expect(keywordConflicts("очистка газа", ["газов"])).toEqual(["газов"]);
  });
});

describe("DirectItemRejected", () => {
  const transport = (result: unknown) => ({
    call: async () => result,
    report: async () => "",
  });

  it("throws when an UpdateResults item has Errors and no Id", async () => {
    const client = createDirectClient({
      transport: transport({
        UpdateResults: [{ Errors: [{ Code: 8000, Message: "Invalid", Details: "strategy" }] }],
      }),
    });
    const err = await client.updateCampaignNegatives([{ id: 7, phrases: ["x"] }]).then(
      () => {
        throw new Error("should have thrown");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DirectItemRejected);
    expect((err as DirectItemRejected).id).toBe(7);
    expect((err as DirectItemRejected).details).toBe("strategy");
  });

  it("passes an item that only has Warnings", async () => {
    const item = { Id: 7, Warnings: [{ Code: 10000, Message: "w" }] };
    const client = createDirectClient({ transport: transport({ UpdateResults: [item] }) });
    await expect(client.updateCampaignNegatives([{ id: 7, phrases: ["x"] }])).resolves.toEqual([
      item,
    ]);
  });

  it("throws for a rejected addSharedSet", async () => {
    const client = createDirectClient({
      transport: transport({ AddResults: [{ Errors: [{ Code: 8000, Message: "m" }] }] }),
    });
    await expect(client.addSharedSet("набор", ["x"])).rejects.toBeInstanceOf(DirectItemRejected);
  });

  it("throws for a rejected deleteKeywords with the keyword id", async () => {
    const client = createDirectClient({
      transport: transport({ DeleteResults: [{ Errors: [{ Code: 8800, Message: "m" }] }] }),
    });
    const err = await client.deleteKeywords([5]).then(
      () => {
        throw new Error("should have thrown");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DirectItemRejected);
    expect((err as DirectItemRejected).id).toBe(5);
  });
});

describe("applyNegatives skipped campaigns", () => {
  it("writes the second campaign and lists the rejected one in skippedCampaigns", async () => {
    const written: number[] = [];
    const direct: NegativesDirect = {
      updateCampaignNegatives: async (items) => {
        for (const item of items) {
          if (item.id === 1) throw new DirectItemRejected(1, "strategy");
          written.push(item.id);
        }
        return items;
      },
      updateAdGroupNegatives: async (items) => items,
      updateKeywords: async (items) => items,
    };
    const result = await applyNegatives(direct, {
      level: "campaign",
      apply: true,
      campaigns: [campaign(1, "Кампания A"), campaign(2, "Кампания B")],
      groups: [],
      keywords: [],
      approved: [
        { query: "q1", phrase: "минус один", campaignId: 1 },
        { query: "q2", phrase: "минус два", campaignId: 2 },
      ],
    });
    expect(written).toEqual([2]);
    expect(result.campaigns.map((c) => c.campaignId)).toEqual([2]);
    expect(result.skippedCampaigns).toEqual([
      { campaignId: 1, details: "strategy", phrases: ["минус один"] },
    ]);
    expect(result.errors).toEqual([]);
  });
});

describe("applyLibrarySync skipped campaigns", () => {
  it("counts only the campaign whose writes all succeeded", async () => {
    const plan = planLibrarySync({
      campaigns: [campaign(1, "Кампания A"), campaign(2, "Кампания B")],
      groups: [group(11, 1, [99]), group(22, 2, [77])],
      sharedSets: [],
      keywords: [],
      approved: [
        { phrase: "своими руками", campaignId: 1 },
        { phrase: "бесплатно", campaignId: 2 },
      ],
    });
    let nextId = 500;
    const direct: LibraryDirect = {
      addSharedSet: async () => nextId++,
      updateSharedSet: async (id, phrases) => phrases,
      updateAdGroupSharedSets: async (items) => {
        if (items.some((item) => item.id === 11)) throw new DirectItemRejected(11, "strategy");
        return items;
      },
      deleteKeywords: async (ids) => ids,
    };
    const result = await applyLibrarySync(direct, plan, { apply: true });
    expect(result.created).toBe(1);
    expect(result.added).toBe(1);
    expect(result.attached).toBe(1);
    expect(result.skippedCampaigns).toEqual([
      { campaignId: 1, details: "strategy", createdSetIds: [500] },
    ]);
    expect(result.errors).toEqual([]);
  });
});
