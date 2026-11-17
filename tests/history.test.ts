import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations, cacheGet, cacheSet } from "../db.ts";
import {
  listChanges,
  recordChange,
  recordChanges,
  syncDirectChanges,
  withHistory,
} from "../history.ts";
import { createDirectClient } from "../direct.ts";
import type { DirectClient } from "../direct.ts";
import type { SyncDirectClient } from "../history.ts";

const open = () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
};

const T0 = Date.parse("2026-11-16T12:00:00Z");
const TS = "2026-11-16T11:00:00Z";
const CAMPAIGN_SNAP = { Name: "Camp", NegativeKeywords: ["w"], ExcludedSites: ["a.ru"] };

const campaign = (over: Partial<{
  Id: number; Name: string; NegativeKeywords: { Items: string[] };
}> = {}) => ({
  Id: 10,
  Name: "Camp",
  State: "ON",
  Status: "ACCEPTED",
  Type: "TEXT",
  NegativeKeywords: { Items: ["w"] },
  ...over,
});

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    campaigns: async () => [campaign()],
    campaignExcludedSites: async () => new Map([[10, ["a.ru"]]]),
    adGroupsByIds: async () => [],
    keywordsByIds: async () => [],
    sharedSets: async () => [],
    updateCampaignNegatives: async (items: { id: number; phrases: string[] }[]) =>
      items.map((i) => ({ Id: i.id })),
    ...over,
  } as unknown as DirectClient;
}

const NO_UNPROCESSED = { CampaignIds: [], AdGroupIds: [], AdIds: [] };

const feed = (over: Partial<SyncDirectClient> = {}): SyncDirectClient => ({
  changesCheckCampaigns: async () => ({
    Campaigns: [{ CampaignId: 10, ChangesIn: ["SELF"] }],
    Timestamp: TS,
  }),
  changesCheck: async () => ({
    Modified: { CampaignIds: [10], AdGroupIds: [], AdIds: [] },
    Unprocessed: NO_UNPROCESSED,
    Timestamp: TS,
  }),
  campaigns: async () => [campaign()],
  campaignExcludedSites: async () => new Map([[10, ["a.ru"]]]),
  adGroups: async () => [],
  adGroupsByIds: async () => [],
  keywords: async () => [],
  keywordsByIds: async () => [],
  sharedSets: async () => [],
  ...over,
});

const seedCursor = (db: Database.Database, accountId = "acc-1", ts = TS) =>
  cacheSet(db, "changesTs", `${accountId}|`, ts, null);

describe("withHistory", () => {
  it("records one before→after row for updateCampaignNegatives", async () => {
    const db = open();
    const wrapped = withHistory(fakeClient(), {
      db,
      accountId: "acc-1",
      origin: { source: "rpc", actor: "test" },
      now: () => T0,
    });
    await wrapped.updateCampaignNegatives([{ id: 10, phrases: ["w", "x"] }]);
    const rows = listChanges(db, {});
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.source).toBe("rpc");
    expect(r.actor).toBe("test");
    expect(r.accountId).toBe("acc-1");
    expect(r.objectType).toBe("campaign");
    expect(r.objectId).toBe("10");
    expect(r.campaignId).toBe(10);
    expect(r.field).toBe("NegativeKeywords");
    expect(r.before).toEqual(["w"]);
    expect(r.after).toEqual(["w", "x"]);
  });

  it("a write that throws records nothing", async () => {
    const db = open();
    const wrapped = withHistory(
      fakeClient({
        updateCampaignNegatives: async () => {
          throw new Error("direct down");
        },
      }),
      { db, accountId: "acc-1", origin: { source: "job", actor: "j" }, now: () => T0 },
    );
    await expect(
      wrapped.updateCampaignNegatives([{ id: 10, phrases: ["w", "x"] }]),
    ).rejects.toThrow("direct down");
    expect(listChanges(db, {})).toEqual([]);
  });

  it("an item with Errors gets no row", async () => {
    const db = open();
    const wrapped = withHistory(
      fakeClient({
        updateCampaignNegatives: async () => [
          { Id: 10, Errors: [{ Code: 8800, Message: "bad" }] },
        ],
      }),
      { db, accountId: "acc-1", origin: { source: "rpc", actor: "t" }, now: () => T0 },
    );
    await wrapped.updateCampaignNegatives([{ id: 10, phrases: ["w", "x"] }]);
    expect(listChanges(db, {})).toEqual([]);
  });

  it("addSharedSet records Name and NegativeKeywords", async () => {
    const db = open();
    const wrapped = withHistory(
      fakeClient({ addSharedSet: async () => 42 }),
      { db, accountId: "acc-1", origin: { source: "job", actor: "lib" }, now: () => T0 },
    );
    const id = await wrapped.addSharedSet("Required set", ["neg1"]);
    expect(id).toBe(42);
    const rows = listChanges(db, {});
    expect(rows).toHaveLength(2);
    const name = rows.find((r) => r.field === "Name")!;
    expect(name.objectType).toBe("shared_set");
    expect(name.objectId).toBe("42");
    expect(name.before).toBeNull();
    expect(name.after).toBe("Required set");
    const neg = rows.find((r) => r.field === "NegativeKeywords")!;
    expect(neg.before).toBeNull();
    expect(neg.after).toEqual(["neg1"]);
  });
});

describe("syncDirectChanges", () => {
  const group = (over: Record<string, unknown> = {}) => ({
    Id: 20,
    CampaignId: 1,
    Name: "G",
    NegativeKeywords: { Items: [] },
    NegativeKeywordSharedSetIds: [],
    ...over,
  });

  const baselineFeed = (over: Partial<SyncDirectClient> = {}): SyncDirectClient =>
    feed({
      changesCheckCampaigns: async () => ({ Campaigns: [], Timestamp: TS }),
      campaigns: async () => [
        campaign({ Id: 1, Name: "Old" }),
        campaign({ Id: 2, Name: "Second" }),
      ],
      campaignExcludedSites: async () =>
        new Map([
          [1, ["a.ru"]],
          [2, ["b.ru"]],
        ]),
      adGroups: async () => [group()],
      keywords: async () => [
        { Id: 5, Keyword: "buy shoes", CampaignId: 1, AdGroupId: 20, State: "ON" },
        { Id: 6, Keyword: "buy hats", CampaignId: 1, AdGroupId: 20, State: "ON" },
      ],
      ...over,
    });

  it("first sync baselines every object without rows and stores the cursor", async () => {
    const db = open();
    const r = await syncDirectChanges(baselineFeed(), db, {
      accountId: "acc-1",
      now: () => T0,
    });
    expect(r).toEqual({ added: 0, skipped: 0, timestamp: TS });
    expect(listChanges(db, {})).toEqual([]);
    expect(cacheGet(db, "changeSnap", "acc-1||campaign|1", T0)).toEqual({
      Name: "Old",
      NegativeKeywords: ["w"],
      ExcludedSites: ["a.ru"],
    });
    expect(cacheGet(db, "changeSnap", "acc-1||campaign|2", T0)).toEqual({
      Name: "Second",
      NegativeKeywords: ["w"],
      ExcludedSites: ["b.ru"],
    });
    expect(cacheGet(db, "changeSnap", "acc-1||ad_group|20", T0)).toEqual({
      Name: "G",
      NegativeKeywords: [],
      NegativeKeywordSharedSetIds: [],
    });
    expect(cacheGet(db, "changeSnap", "acc-1||keywords|20", T0)).toEqual({
      "5": "buy shoes",
      "6": "buy hats",
    });
    expect(cacheGet<string>(db, "changesTs", "acc-1|", T0)).toBe(TS);
  });

  it("after the baseline a renamed campaign gives a Name row, not 'first seen'", async () => {
    const db = open();
    await syncDirectChanges(baselineFeed(), db, { accountId: "acc-1", now: () => T0 });
    const client = feed({
      changesCheckCampaigns: async () => ({
        Campaigns: [{ CampaignId: 1, ChangesIn: ["SELF"] }],
        Timestamp: "2026-11-16T12:30:00Z",
      }),
      changesCheck: async () => ({
        Modified: { CampaignIds: [1], AdGroupIds: [], AdIds: [] },
        Unprocessed: NO_UNPROCESSED,
        Timestamp: "2026-11-16T12:30:00Z",
      }),
      campaigns: async () => [campaign({ Id: 1, Name: "New" })],
      campaignExcludedSites: async () => new Map([[1, ["a.ru"]]]),
    });
    const r = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0 + 60_000,
    });
    expect(r.added).toBe(1);
    const rows = listChanges(db, {});
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source).toBe("direct");
    expect(row.objectType).toBe("campaign");
    expect(row.objectId).toBe("1");
    expect(row.field).toBe("Name");
    expect(row.before).toBe("Old");
    expect(row.after).toBe("New");
    expect(row.note).toBeUndefined();
  });

  it("a feed-named object without a snapshot gets one 'created' row", async () => {
    const db = open();
    await syncDirectChanges(baselineFeed(), db, { accountId: "acc-1", now: () => T0 });
    const client = feed({
      changesCheckCampaigns: async () => ({
        Campaigns: [{ CampaignId: 99, ChangesIn: ["SELF"] }],
        Timestamp: "2026-11-16T12:30:00Z",
      }),
      changesCheck: async () => ({
        Modified: { CampaignIds: [99], AdGroupIds: [], AdIds: [] },
        Unprocessed: NO_UNPROCESSED,
        Timestamp: "2026-11-16T12:30:00Z",
      }),
      campaigns: async () => [campaign({ Id: 99, Name: "Fresh" })],
      campaignExcludedSites: async () => new Map([[99, []]]),
    });
    const r = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0 + 60_000,
    });
    expect(r.added).toBe(1);
    const rows = listChanges(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].objectType).toBe("campaign");
    expect(rows[0].objectId).toBe("99");
    expect(rows[0].field).toBe("modified");
    expect(rows[0].note).toBe("created");
    expect(rows[0].before).toBeNull();
    expect(rows[0].after).toEqual({
      Name: "Fresh",
      NegativeKeywords: ["w"],
      ExcludedSites: [],
    });
  });

  it("records a direct campaign rename and a keyword text edit", async () => {
    const db = open();
    cacheSet(db, "changeSnap", "acc-1||campaign|10", CAMPAIGN_SNAP, null);
    seedCursor(db);
    cacheSet(
      db,
      "changeSnap",
      "acc-1||ad_group|20",
      { Name: "G", NegativeKeywords: [], NegativeKeywordSharedSetIds: [] },
      null,
    );
    cacheSet(db, "changeSnap", "acc-1||keywords|20", { "5": "buy shoes" }, null);
    const client = feed({
      campaigns: async () => [campaign({ Name: "New" })],
      adGroupsByIds: async () => [
        {
          Id: 20,
          CampaignId: 10,
          Name: "G",
          NegativeKeywords: { Items: [] },
          NegativeKeywordSharedSetIds: [],
        },
      ],
      keywords: async () => [
        { Id: 5, Keyword: "buy red shoes", CampaignId: 10, AdGroupId: 20, State: "ON" },
      ],
      changesCheck: async () => ({
        Modified: { CampaignIds: [10], AdGroupIds: [20], AdIds: [] },
        Unprocessed: NO_UNPROCESSED,
        Timestamp: TS,
      }),
    });
    const r = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0,
    });
    expect(r.added).toBe(2);
    const rows = listChanges(db, {});
    const rename = rows.find((x) => x.field === "Name");
    expect(rename).toBeDefined();
    expect(rename!.source).toBe("direct");
    expect(rename!.objectType).toBe("campaign");
    expect(rename!.objectId).toBe("10");
    expect(rename!.before).toBe("Camp");
    expect(rename!.after).toBe("New");
    const kw = rows.find((x) => x.field === "Keyword");
    expect(kw).toBeDefined();
    expect(kw!.objectType).toBe("keyword");
    expect(kw!.objectId).toBe("5");
    expect(kw!.campaignId).toBe(10);
    expect(kw!.adGroupId).toBe(20);
    expect(kw!.before).toBe("buy shoes");
    expect(kw!.after).toBe("buy red shoes");
  });

  it("keeps a pending manual ExcludedSites edit visible after a plugin write", async () => {
    const db = open();
    cacheSet(db, "changeSnap", "acc-1||campaign|10", CAMPAIGN_SNAP, null);
    seedCursor(db);
    const writer = fakeClient({
      updateCampaignNegatives: async (items: { id: number; phrases: string[] }[]) =>
        items.map((i) => ({ Id: i.id })),
    });
    const wrapped = withHistory(writer, {
      db,
      accountId: "acc-1",
      origin: { source: "job", actor: "night-export" },
      now: () => T0,
    });
    await wrapped.updateCampaignNegatives([{ id: 10, phrases: ["w", "x"] }]);
    const client = feed({
      campaigns: async () => [campaign({ NegativeKeywords: { Items: ["w", "x"] } })],
      campaignExcludedSites: async () => new Map([[10, ["b.ru"]]]),
    });
    await syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 + 60_000 });
    const rows = listChanges(db, {});
    const pluginRow = rows.find((r) => r.source === "job" && r.field === "NegativeKeywords");
    expect(pluginRow).toBeDefined();
    expect(pluginRow!.after).toEqual(["w", "x"]);
    const directExcluded = rows.find((r) => r.source === "direct" && r.field === "ExcludedSites");
    expect(directExcluded).toBeDefined();
    expect(directExcluded!.objectType).toBe("campaign");
    expect(directExcluded!.before).toEqual(["a.ru"]);
    expect(directExcluded!.after).toEqual(["b.ru"]);
  });

  it("a failed detail read stores nothing and the next sync recovers", async () => {
    const db = open();
    cacheSet(db, "changeSnap", "acc-1||campaign|10", CAMPAIGN_SNAP, null);
    const oldCursor = "2026-11-16T10:00:00Z";
    seedCursor(db, "acc-1", oldCursor);
    let failReads = true;
    const client = feed({
      campaigns: async () => {
        if (failReads) throw new Error("read failed");
        return [campaign({ Name: "New" })];
      },
    });
    await expect(
      syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 }),
    ).rejects.toThrow("read failed");
    expect(listChanges(db, {})).toEqual([]);
    expect(cacheGet<string>(db, "changesTs", "acc-1|", T0)).toBe(oldCursor);
    expect(cacheGet(db, "changeSnap", "acc-1||campaign|10", T0)).toEqual(CAMPAIGN_SNAP);
    failReads = false;
    const r = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0 + 60_000,
    });
    expect(r.added).toBe(1);
    expect(r.timestamp).toBe(TS);
    expect(cacheGet<string>(db, "changesTs", "acc-1|", T0)).toBe(TS);
    const rename = listChanges(db, {}).find((x) => x.field === "Name");
    expect(rename).toBeDefined();
    expect(rename!.before).toBe("Camp");
    expect(rename!.after).toBe("New");
  });

  it("skips a direct row echoed by a recent plugin row and listChanges filters", async () => {
    const db = open();
    cacheSet(db, "changeSnap", "acc-1||campaign|10", CAMPAIGN_SNAP, null);
    seedCursor(db);
    recordChange(db, {
      at: new Date(T0 - 5 * 60_000).toISOString(),
      accountId: "acc-1",
      source: "rpc",
      actor: "cli-agent",
      objectType: "campaign",
      objectId: "10",
      campaignId: 10,
      field: "NegativeKeywords",
      before: ["w"],
      after: ["x"],
    });
    recordChange(db, {
      at: new Date(T0 - 60_000).toISOString(),
      accountId: "acc-2",
      source: "direct",
      actor: "direct",
      objectType: "campaign",
      objectId: "99",
      field: "Name",
      before: "A",
      after: "B",
    });
    const client = feed({
      campaigns: async () => [
        campaign({ Name: "Camp", NegativeKeywords: { Items: ["x"] } }),
      ],
      campaignExcludedSites: async () => new Map([[10, ["a.ru"]]]),
    });
    const r = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0,
    });
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
    expect(listChanges(db, { accountId: "acc-1" })).toHaveLength(1);
    expect(
      listChanges(db, { accountId: "acc-1", since: new Date(T0 - 10 * 60_000).toISOString() }),
    ).toHaveLength(1);
    expect(listChanges(db, { accountId: "acc-1", since: new Date(T0).toISOString() })).toHaveLength(0);
    expect(listChanges(db, { source: "direct" })).toHaveLength(1);
    expect(listChanges(db, { source: "rpc" })).toHaveLength(1);
  });

  it("an old plugin echo does not suppress a later manual change to the same value", async () => {
    const db = open();
    cacheSet(db, "changeSnap", "acc-1||campaign|10", CAMPAIGN_SNAP, null);
    seedCursor(db);
    recordChange(db, {
      at: new Date(T0 - 65 * 60_000).toISOString(),
      accountId: "acc-1",
      source: "rpc",
      actor: "cli-agent",
      objectType: "campaign",
      objectId: "10",
      campaignId: 10,
      field: "NegativeKeywords",
      before: ["w"],
      after: ["x"],
    });
    const client = feed({
      campaigns: async () => [
        campaign({ Name: "Camp", NegativeKeywords: { Items: ["x"] } }),
      ],
      campaignExcludedSites: async () => new Map([[10, ["a.ru"]]]),
    });
    const r = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0,
    });
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(0);
    const row = listChanges(db, {}).find(
      (x) => x.source === "direct" && x.field === "NegativeKeywords",
    )!;
    expect(row.before).toEqual(["w"]);
    expect(row.after).toEqual(["x"]);
  });

  it("re-asks changes.check for unprocessed ids and records the change", async () => {
    const db = open();
    cacheSet(db, "changeSnap", "acc-1||campaign|10", CAMPAIGN_SNAP, null);
    seedCursor(db);
    const calls: Array<{ service: string; method: string; params: unknown }> = [];
    let checkCalls = 0;
    const client = createDirectClient({
      transport: {
        call: async (service: string, method: string, params: unknown) => {
          calls.push({ service, method, params });
          if (service === "changes" && method === "checkCampaigns") {
            return {
              Campaigns: [{ CampaignId: 10, ChangesIn: ["SELF"] }],
              Timestamp: TS,
            };
          }
          if (service === "changes" && method === "check") {
            checkCalls += 1;
            if (checkCalls === 1) {
              return {
                Modified: { CampaignIds: [], AdGroupIds: [], AdIds: [] },
                Unprocessed: { CampaignIds: [10], AdGroupIds: [], AdIds: [] },
                Timestamp: TS,
              };
            }
            return {
              Modified: { CampaignIds: [10], AdGroupIds: [], AdIds: [] },
              Timestamp: TS,
            };
          }
          if (service === "campaigns" && method === "get") {
            const fields = (params as { FieldNames?: string[] }).FieldNames ?? [];
            if (fields.includes("ExcludedSites")) {
              return { Campaigns: [{ Id: 10, ExcludedSites: { Items: ["a.ru"] } }] };
            }
            return { Campaigns: [campaign({ Name: "New" })] };
          }
          if (service === "adgroups") return { AdGroups: [] };
          if (service === "keywords") return { Keywords: [] };
          return {};
        },
        report: async () => "",
      },
    });
    const r = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0,
    });
    expect(r.added).toBe(1);
    const checkParams = calls
      .filter((c) => c.service === "changes" && c.method === "check")
      .map((c) => c.params);
    expect(checkParams).toHaveLength(2);
    expect(checkParams[1]).toEqual({
      CampaignIds: [10],
      FieldNames: ["CampaignIds", "AdGroupIds", "AdIds"],
      Timestamp: TS,
    });
    const rename = listChanges(db, {}).find((x) => x.field === "Name");
    expect(rename).toBeDefined();
    expect(rename!.before).toBe("Camp");
    expect(rename!.after).toBe("New");
  });

  it("rejects when changes.check leaves objects unprocessed after 3 asks", async () => {
    const db = open();
    seedCursor(db);
    const calls: Array<{ service: string; method: string }> = [];
    const client = createDirectClient({
      transport: {
        call: async (service: string, method: string) => {
          calls.push({ service, method });
          if (service === "changes" && method === "checkCampaigns") {
            return {
              Campaigns: [{ CampaignId: 10, ChangesIn: ["SELF"] }],
              Timestamp: TS,
            };
          }
          if (service === "changes" && method === "check") {
            return {
              Modified: { CampaignIds: [], AdGroupIds: [], AdIds: [] },
              Unprocessed: { CampaignIds: [10], AdGroupIds: [], AdIds: [] },
              Timestamp: TS,
            };
          }
          return {};
        },
        report: async () => "",
      },
    });
    await expect(
      syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 }),
    ).rejects.toThrow("changes.check left 1 objects unprocessed");
    expect(
      calls.filter((c) => c.service === "changes" && c.method === "check"),
    ).toHaveLength(3);
    expect(listChanges(db, {})).toEqual([]);
    expect(cacheGet<string>(db, "changesTs", "acc-1|", T0)).toBe(TS);
    expect(cacheGet(db, "changeSnap", "acc-1||campaign|10", T0)).toBeUndefined();
  });

  it("records manual changes around a plugin write instead of suppressing them", async () => {
    const db = open();
    cacheSet(db, "changeSnap", "acc-1||campaign|10", CAMPAIGN_SNAP, null);
    seedCursor(db);
    const wrapped = withHistory(fakeClient(), {
      db,
      accountId: "acc-1",
      origin: { source: "rpc", actor: "agent" },
      now: () => T0,
    });
    await wrapped.updateCampaignNegatives([{ id: 10, phrases: ["x"] }]);
    const syncWith = (items: string[]) =>
      feed({
        campaigns: async () => [campaign({ NegativeKeywords: { Items: items } })],
        campaignExcludedSites: async () => new Map([[10, ["a.ru"]]]),
      });
    const first = await syncDirectChanges(syncWith(["w"]), db, {
      accountId: "acc-1",
      now: () => T0 + 60_000,
    });
    expect(first.added).toBe(1);
    const second = await syncDirectChanges(syncWith(["x"]), db, {
      accountId: "acc-1",
      now: () => T0 + 120_000,
    });
    expect(second.added).toBe(1);
    const manualRows = listChanges(db, {}).filter(
      (r) => r.source === "direct" && r.field === "NegativeKeywords",
    );
    expect(manualRows).toHaveLength(2);
    expect(manualRows.map((r) => r.after)).toEqual(
      expect.arrayContaining([["w"], ["x"]]),
    );
    recordChange(db, {
      at: new Date(T0 + 170_000).toISOString(),
      accountId: "acc-1",
      source: "rpc",
      actor: "agent",
      objectType: "campaign",
      objectId: "10",
      campaignId: 10,
      field: "NegativeKeywords",
      before: ["x"],
      after: ["y"],
    });
    const echo = await syncDirectChanges(syncWith(["y"]), db, {
      accountId: "acc-1",
      now: () => T0 + 180_000,
    });
    expect(echo.added).toBe(0);
    expect(echo.skipped).toBe(1);
  });

  it("first sync pages campaigns.get with LimitedBy and commits the baseline", async () => {
    const db = open();
    const calls: Array<{ service: string; method: string; params: unknown }> = [];
    const client = createDirectClient({
      transport: {
        call: async (service: string, method: string, params: unknown) => {
          calls.push({ service, method, params });
          const p = params as {
            FieldNames?: string[];
            Page?: { Offset?: number };
          };
          if (service === "changes" && method === "checkCampaigns") {
            return { Campaigns: [], Timestamp: TS };
          }
          if (service === "campaigns" && method === "get") {
            if (p.FieldNames?.includes("ExcludedSites")) {
              return {
                Campaigns: [
                  { Id: 7, ExcludedSites: { Items: [] } },
                  { Id: 8, ExcludedSites: { Items: [] } },
                ],
              };
            }
            if (p.Page?.Offset === undefined) {
              return {
                Campaigns: [campaign({ Id: 7, Name: "Paged" })],
                LimitedBy: 10000,
              };
            }
            return { Campaigns: [campaign({ Id: 8, Name: "Paged2" })] };
          }
          if (service === "adgroups") return { AdGroups: [] };
          if (service === "keywords") return { Keywords: [] };
          return {};
        },
        report: async () => "",
      },
    });
    const r = await syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 });
    expect(r).toEqual({ added: 0, skipped: 0, timestamp: TS });
    const gets = calls.filter(
      (c) =>
        c.service === "campaigns" &&
        c.method === "get" &&
        ((c.params as { FieldNames?: string[] }).FieldNames ?? []).includes(
          "NegativeKeywords",
        ),
    );
    expect(gets).toHaveLength(2);
    expect(gets[0].params).toMatchObject({ Page: { Limit: 10000 } });
    expect(gets[1].params).toMatchObject({ Page: { Limit: 10000, Offset: 10000 } });
    expect(cacheGet(db, "changeSnap", "acc-1||campaign|7", T0)).toMatchObject({
      Name: "Paged",
    });
    expect(cacheGet(db, "changeSnap", "acc-1||campaign|8", T0)).toMatchObject({
      Name: "Paged2",
    });
    expect(cacheGet<string>(db, "changesTs", "acc-1|", T0)).toBe(TS);
  });

  it("batches campaign detail reads at 1000 ids", async () => {
    const db = open();
    seedCursor(db);
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    const detailIds: number[][] = [];
    const client = createDirectClient({
      transport: {
        call: async (service: string, method: string, params: unknown) => {
          const p = params as {
            FieldNames?: string[];
            SelectionCriteria?: { Ids?: number[] };
          };
          if (service === "changes" && method === "checkCampaigns") {
            return {
              Campaigns: [{ CampaignId: 1, ChangesIn: ["SELF"] }],
              Timestamp: TS,
            };
          }
          if (service === "changes" && method === "check") {
            return {
              Modified: { CampaignIds: ids, AdGroupIds: [], AdIds: [] },
              Unprocessed: NO_UNPROCESSED,
              Timestamp: TS,
            };
          }
          if (service === "campaigns" && method === "get") {
            if (p.FieldNames?.includes("ExcludedSites")) return { Campaigns: [] };
            detailIds.push(p.SelectionCriteria?.Ids ?? []);
            return { Campaigns: [] };
          }
          if (service === "adgroups") return { AdGroups: [] };
          if (service === "keywords") return { Keywords: [] };
          return {};
        },
        report: async () => "",
      },
    });
    const r = await syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 });
    expect(r.timestamp).toBe(TS);
    expect(detailIds).toEqual([ids.slice(0, 1000), [1001]]);
  });

  it("a failed campaign detail batch stores nothing and keeps the cursor", async () => {
    const db = open();
    const old = "2026-11-16T10:00:00Z";
    seedCursor(db, "acc-1", old);
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    let detailCalls = 0;
    const client = createDirectClient({
      transport: {
        call: async (service: string, method: string, params: unknown) => {
          const p = params as { FieldNames?: string[] };
          if (service === "changes" && method === "checkCampaigns") {
            return {
              Campaigns: [{ CampaignId: 1, ChangesIn: ["SELF"] }],
              Timestamp: TS,
            };
          }
          if (service === "changes" && method === "check") {
            return {
              Modified: { CampaignIds: ids, AdGroupIds: [], AdIds: [] },
              Unprocessed: NO_UNPROCESSED,
              Timestamp: TS,
            };
          }
          if (service === "campaigns" && method === "get") {
            if (p.FieldNames?.includes("ExcludedSites")) return { Campaigns: [] };
            detailCalls += 1;
            if (detailCalls === 2) throw new Error("batch failed");
            return { Campaigns: [] };
          }
          return {};
        },
        report: async () => "",
      },
    });
    await expect(
      syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 }),
    ).rejects.toThrow("batch failed");
    expect(detailCalls).toBe(2);
    expect(listChanges(db, {})).toEqual([]);
    expect(cacheGet<string>(db, "changesTs", "acc-1|", T0)).toBe(old);
  });

  it("records a rename of a campaign that is now archived in Direct", async () => {
    const db = open();
    const directCampaigns = [campaign({ Id: 10, Name: "Old" })];
    let checks = 0;
    const client = createDirectClient({
      transport: {
        call: async (service: string, method: string, params: unknown) => {
          const p = params as {
            SelectionCriteria?: { States?: string[]; Ids?: number[] };
            FieldNames?: string[];
          };
          if (service === "changes" && method === "checkCampaigns") {
            checks += 1;
            return checks === 1
              ? { Campaigns: [], Timestamp: TS }
              : {
                  Campaigns: [{ CampaignId: 10, ChangesIn: ["SELF"] }],
                  Timestamp: "2026-11-16T12:30:00Z",
                };
          }
          if (service === "changes" && method === "check") {
            return {
              Modified: { CampaignIds: [10], AdGroupIds: [], AdIds: [] },
              Unprocessed: NO_UNPROCESSED,
              Timestamp: "2026-11-16T12:30:00Z",
            };
          }
          if (service === "campaigns" && method === "get") {
            if (p.FieldNames?.includes("ExcludedSites")) {
              const ids = p.SelectionCriteria?.Ids;
              return {
                Campaigns: directCampaigns
                  .filter((c) => ids === undefined || ids.includes(c.Id))
                  .map((c) => ({ Id: c.Id, ExcludedSites: { Items: [] } })),
              };
            }
            const states = p.SelectionCriteria?.States;
            const ids = p.SelectionCriteria?.Ids;
            return {
              Campaigns: directCampaigns.filter(
                (c) =>
                  (states === undefined || states.includes(c.State)) &&
                  (ids === undefined || ids.includes(c.Id)),
              ),
            };
          }
          if (service === "adgroups") return { AdGroups: [] };
          if (service === "keywords") return { Keywords: [] };
          return {};
        },
        report: async () => "",
      },
    });
    const first = await syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 });
    expect(first.added).toBe(0);
    directCampaigns[0] = { ...campaign({ Id: 10, Name: "New" }), State: "ARCHIVED" };
    const second = await syncDirectChanges(client, db, {
      accountId: "acc-1",
      now: () => T0 + 60_000,
    });
    expect(second.added).toBe(1);
    const rows = listChanges(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("direct");
    expect(rows[0].objectType).toBe("campaign");
    expect(rows[0].objectId).toBe("10");
    expect(rows[0].field).toBe("Name");
    expect(rows[0].before).toBe("Old");
    expect(rows[0].after).toBe("New");
  });

  it("a feed-named campaign missing from the detail read gets a 'not found' row", async () => {
    const db = open();
    cacheSet(
      db,
      "changeSnap",
      "acc-1||campaign|11",
      { Name: "Gone", NegativeKeywords: [], ExcludedSites: [] },
      null,
    );
    seedCursor(db);
    const client = feed({
      changesCheckCampaigns: async () => ({
        Campaigns: [{ CampaignId: 11, ChangesIn: ["SELF"] }],
        Timestamp: TS,
      }),
      changesCheck: async () => ({
        Modified: { CampaignIds: [11], AdGroupIds: [], AdIds: [] },
        Unprocessed: NO_UNPROCESSED,
        Timestamp: TS,
      }),
      campaigns: async () => [],
      campaignExcludedSites: async () => new Map(),
    });
    const r = await syncDirectChanges(client, db, { accountId: "acc-1", now: () => T0 });
    expect(r.added).toBe(1);
    const rows = listChanges(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].objectType).toBe("campaign");
    expect(rows[0].objectId).toBe("11");
    expect(rows[0].campaignId).toBe(11);
    expect(rows[0].field).toBe("modified");
    expect(rows[0].note).toBe("not found");
    expect(rows[0].before).toEqual({
      Name: "Gone",
      NegativeKeywords: [],
      ExcludedSites: [],
    });
    expect(rows[0].after).toBeNull();
    expect(cacheGet(db, "changeSnap", "acc-1||campaign|11", T0)).toBeUndefined();
  });
});

describe("listChanges paging", () => {
  it("pages 1001 rows by the before cursor, all ids once, newest first", () => {
    const db = open();
    const base = Date.parse("2026-11-16T00:00:00Z");
    recordChanges(
      db,
      Array.from({ length: 1001 }, (_, i) => ({
        at: new Date(base + Math.floor(i / 3) * 1000).toISOString(),
        accountId: "acc-page",
        source: "direct" as const,
        actor: "direct",
        objectType: "campaign" as const,
        objectId: String(i),
        campaignId: i,
        field: "Name",
        before: `b${i}`,
        after: `a${i}`,
      })),
    );
    const pages: number[][] = [];
    let before: { at: string; id: number } | undefined;
    for (;;) {
      const page = listChanges(db, { accountId: "acc-page", limit: 200, before });
      expect(page.every((r) => typeof r.id === "number")).toBe(true);
      pages.push(page.map((r) => r.id!));
      if (page.length < 200) break;
      const last = page[page.length - 1];
      before = { at: last.at, id: last.id! };
    }
    expect(pages.map((p) => p.length)).toEqual([200, 200, 200, 200, 200, 1]);
    const ids = pages.flat();
    expect(ids).toHaveLength(1001);
    expect(new Set(ids).size).toBe(1001);
    const all = listChanges(db, { accountId: "acc-page", limit: 2000 });
    expect(ids).toEqual(all.map((r) => r.id));
  });
});
