import { describe, expect, it } from "vitest";
import { liveDirect } from "./helpers.ts";

describe("keyword growth live", () => {
  it(
    "keywordBids with keywordIds returns those ids with numeric Search bids",
    async () => {
      const { client } = liveDirect();
      const campaigns = await client.campaigns({ states: ["ON"] });
      const campaignIds = campaigns.map((c) => c.Id);
      expect(campaignIds.length).toBeGreaterThan(0);
      const bids = await client.keywordBids(campaignIds);
      const usable = bids.filter(
        (item) => typeof item.Search?.Bid === "number" && (item.Search?.Bid ?? 0) > 0,
      );
      expect(usable.length).toBeGreaterThanOrEqual(3);
      const ids = usable.slice(0, 3).map((item) => item.KeywordId);
      const rows = await client.keywordBids({ keywordIds: ids });
      expect(rows.map((item) => item.KeywordId).sort((a, b) => a - b)).toEqual(
        [...ids].sort((a, b) => a - b),
      );
      for (const item of rows) {
        expect(typeof item.Search?.Bid).toBe("number");
      }
    },
    15 * 60 * 1000,
  );

  it(
    "addKeywords through the live client throws before any request leaves",
    async () => {
      const { client } = liveDirect();
      const campaigns = await client.campaigns({ states: ["ON"] });
      const groups = await client.adGroups(campaigns.slice(0, 10).map((c) => c.Id));
      const adGroupId = groups[0]?.Id ?? 1;
      await expect(
        client.addKeywords([{ adGroupId, keyword: "live guard probe" }]),
      ).rejects.toThrow("live guard: write blocked");
    },
    15 * 60 * 1000,
  );
});
