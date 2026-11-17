import type Database from "better-sqlite3";
import { cacheGet, cacheSet } from "./db.ts";
import { ALL_CAMPAIGN_STATES, type DirectClient } from "./direct.ts";

export type ChangeSource = "job" | "rpc" | "cli" | "agent" | "direct";
export type ChangeOrigin = { source: ChangeSource; actor: string };
export type ChangeObjectType = "campaign" | "ad_group" | "keyword" | "shared_set" | "ad";

export type ChangeEntry = {
  id?: number;
  at: string;
  accountId: string;
  clientLogin?: string;
  source: ChangeSource;
  actor: string;
  objectType: ChangeObjectType;
  objectId: string;
  campaignId?: number;
  adGroupId?: number;
  field: string;
  before: unknown;
  after: unknown;
  note?: string;
};

export type ChangeFilter = {
  accountId?: string;
  since?: string;
  source?: ChangeSource;
  limit?: number;
  before?: { at: string; id: number };
};

const INSERT_SQL = `INSERT INTO change_history
  (at, account_id, client_login, source, actor, object_type, object_id, campaign_id, ad_group_id, field, before, after, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const jsonOrNull = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

const jsonEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

const rowParams = (e: ChangeEntry): unknown[] => [
  e.at,
  e.accountId,
  e.clientLogin ?? null,
  e.source,
  e.actor,
  e.objectType,
  e.objectId,
  e.campaignId ?? null,
  e.adGroupId ?? null,
  e.field,
  jsonOrNull(e.before),
  jsonOrNull(e.after),
  e.note ?? null,
];

export function recordChange(db: Database.Database, entry: ChangeEntry): void {
  db.prepare(INSERT_SQL).run(...rowParams(entry));
}

export function recordChanges(db: Database.Database, entries: ChangeEntry[]): void {
  if (!entries.length) return;
  const ins = db.prepare(INSERT_SQL);
  const tx = db.transaction(() => {
    for (const e of entries) ins.run(...rowParams(e));
  });
  tx();
}

type ChangeSqlRow = {
  id: number;
  at: string;
  account_id: string;
  client_login: string | null;
  source: string;
  actor: string;
  object_type: string;
  object_id: string;
  campaign_id: number | null;
  ad_group_id: number | null;
  field: string;
  before: string | null;
  after: string | null;
  note: string | null;
};

export type ChangeListEntry = ChangeEntry & { id: number };

const toEntry = (r: ChangeSqlRow): ChangeListEntry => ({
  id: r.id,
  at: r.at,
  accountId: r.account_id,
  clientLogin: r.client_login ?? undefined,
  source: r.source as ChangeSource,
  actor: r.actor,
  objectType: r.object_type as ChangeObjectType,
  objectId: r.object_id,
  campaignId: r.campaign_id ?? undefined,
  adGroupId: r.ad_group_id ?? undefined,
  field: r.field,
  before: r.before === null ? null : JSON.parse(r.before),
  after: r.after === null ? null : JSON.parse(r.after),
  note: r.note ?? undefined,
});

export function listChanges(
  db: Database.Database,
  filter: ChangeFilter = {},
): ChangeListEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.accountId !== undefined) {
    where.push("account_id = ?");
    params.push(filter.accountId);
  }
  if (filter.since !== undefined) {
    where.push("at >= ?");
    params.push(filter.since);
  }
  if (filter.source !== undefined) {
    where.push("source = ?");
    params.push(filter.source);
  }
  if (filter.before !== undefined) {
    where.push("(at < ? OR (at = ? AND id < ?))");
    params.push(filter.before.at, filter.before.at, filter.before.id);
  }
  const limit = filter.limit ?? 200;
  const rows = db
    .prepare(
      `SELECT * FROM change_history${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as ChangeSqlRow[];
  return rows.map(toEntry);
}

const snapKey = (prefix: string, objectType: string, objectId: string | number): string =>
  `${prefix}|${objectType}|${objectId}`;

const snapGet = <T>(
  db: Database.Database,
  prefix: string,
  objectType: string,
  objectId: string | number,
  nowMs: number,
): T | undefined => cacheGet<T>(db, "changeSnap", snapKey(prefix, objectType, objectId), nowMs);

const snapSet = (
  db: Database.Database,
  prefix: string,
  objectType: string,
  objectId: string | number,
  value: unknown,
): void => cacheSet(db, "changeSnap", snapKey(prefix, objectType, objectId), value, null);

const snapDel = (
  db: Database.Database,
  prefix: string,
  objectType: string,
  objectId: string | number,
): void => {
  db.prepare("DELETE FROM cache WHERE ns = 'changeSnap' AND key = ?").run(
    snapKey(prefix, objectType, objectId),
  );
};

type EntryBody = {
  objectType: ChangeObjectType;
  objectId: string;
  campaignId?: number;
  adGroupId?: number;
  field: string;
  before: unknown;
  after: unknown;
  note?: string;
};

const itemFailed = (item: unknown): boolean => {
  const errs = (item as { Errors?: unknown } | null | undefined)?.Errors;
  return Array.isArray(errs) && errs.length > 0;
};

export function withHistory(
  client: DirectClient,
  ctx: {
    db: Database.Database;
    accountId: string;
    clientLogin?: string;
    origin: ChangeOrigin;
    now?: () => number;
  },
): DirectClient {
  const now = ctx.now ?? Date.now;
  const prefix = `${ctx.accountId}|${ctx.clientLogin ?? ""}`;

  const entry = (at: string, source: ChangeSource, body: EntryBody): ChangeEntry => ({
    at,
    accountId: ctx.accountId,
    clientLogin: ctx.clientLogin,
    source,
    actor: source === "direct" ? "direct" : ctx.origin.actor,
    ...body,
  });

  const commit = (
    entries: ChangeEntry[],
    snaps: Array<[string, string | number, unknown]>,
  ): void => {
    recordChanges(ctx.db, entries);
    for (const [objectType, objectId, value] of snaps) {
      snapSet(ctx.db, prefix, objectType, objectId, value);
    }
  };

  return {
    ...client,
    get units() {
      return client.units;
    },

    async updateCampaignNegatives(items: { id: number; phrases: string[] }[]) {
      if (!items.length) return client.updateCampaignNegatives(items);
      const campaigns = await client.campaigns({
        ids: [...new Set(items.map((i) => i.id))],
        states: ALL_CAMPAIGN_STATES,
      });
      const byId = new Map(campaigns.map((c) => [c.Id, c]));
      const result = await client.updateCampaignNegatives(items);
      const at = new Date(now()).toISOString();
      const entries: ChangeEntry[] = [];
      const snaps: Array<[string, string | number, unknown]> = [];
      const results = Array.isArray(result) ? result : null;
      items.forEach((item, i) => {
        const before = byId.get(item.id)?.NegativeKeywords?.Items ?? [];
        const snap = snapGet<{ NegativeKeywords?: unknown }>(
          ctx.db, prefix, "campaign", item.id, now(),
        );
        if (snap && !jsonEqual(snap.NegativeKeywords, before)) {
          entries.push(entry(at, "direct", {
            objectType: "campaign", objectId: String(item.id), campaignId: item.id,
            field: "NegativeKeywords", before: snap.NegativeKeywords, after: before,
          }));
        }
        const ok = results ? !itemFailed(results[i]) : true;
        if (ok) {
          entries.push(entry(at, ctx.origin.source, {
            objectType: "campaign", objectId: String(item.id), campaignId: item.id,
            field: "NegativeKeywords", before, after: item.phrases,
          }));
        }
        if (snap) {
          snaps.push(["campaign", item.id, { ...snap, NegativeKeywords: ok ? item.phrases : before }]);
        }
      });
      commit(entries, snaps);
      return result;
    },

    async updateExcludedSites(items: { id: number; sites: string[] }[]) {
      if (!items.length) return client.updateExcludedSites(items);
      const ids = [...new Set(items.map((i) => i.id))];
      const excluded = await client.campaignExcludedSites(ids);
      const result = await client.updateExcludedSites(items);
      const at = new Date(now()).toISOString();
      const entries: ChangeEntry[] = [];
      const snaps: Array<[string, string | number, unknown]> = [];
      const results = Array.isArray(result) ? result : null;
      items.forEach((item, i) => {
        const before = excluded.get(item.id) ?? [];
        const snap = snapGet<{ ExcludedSites?: unknown }>(
          ctx.db, prefix, "campaign", item.id, now(),
        );
        if (snap && !jsonEqual(snap.ExcludedSites, before)) {
          entries.push(entry(at, "direct", {
            objectType: "campaign", objectId: String(item.id), campaignId: item.id,
            field: "ExcludedSites", before: snap.ExcludedSites, after: before,
          }));
        }
        const ok = results ? !itemFailed(results[i]) : true;
        if (ok) {
          entries.push(entry(at, ctx.origin.source, {
            objectType: "campaign", objectId: String(item.id), campaignId: item.id,
            field: "ExcludedSites", before, after: item.sites,
          }));
        }
        if (snap) {
          snaps.push(["campaign", item.id, { ...snap, ExcludedSites: ok ? item.sites : before }]);
        }
      });
      commit(entries, snaps);
      return result;
    },

    async updateAdGroupNegatives(items: { id: number; phrases: string[] }[]) {
      if (!items.length) return client.updateAdGroupNegatives(items);
      const groups = await client.adGroupsByIds([...new Set(items.map((i) => i.id))]);
      const byId = new Map(groups.map((g) => [g.Id, g]));
      const result = await client.updateAdGroupNegatives(items);
      const at = new Date(now()).toISOString();
      const entries: ChangeEntry[] = [];
      const snaps: Array<[string, string | number, unknown]> = [];
      const results = Array.isArray(result) ? result : null;
      items.forEach((item, i) => {
        const group = byId.get(item.id);
        const before = group?.NegativeKeywords?.Items ?? [];
        const snap = snapGet<{ NegativeKeywords?: unknown }>(
          ctx.db, prefix, "ad_group", item.id, now(),
        );
        if (snap && !jsonEqual(snap.NegativeKeywords, before)) {
          entries.push(entry(at, "direct", {
            objectType: "ad_group", objectId: String(item.id),
            campaignId: group?.CampaignId, adGroupId: item.id,
            field: "NegativeKeywords", before: snap.NegativeKeywords, after: before,
          }));
        }
        const ok = results ? !itemFailed(results[i]) : true;
        if (ok) {
          entries.push(entry(at, ctx.origin.source, {
            objectType: "ad_group", objectId: String(item.id),
            campaignId: group?.CampaignId, adGroupId: item.id,
            field: "NegativeKeywords", before, after: item.phrases,
          }));
        }
        if (snap) {
          snaps.push(["ad_group", item.id, { ...snap, NegativeKeywords: ok ? item.phrases : before }]);
        }
      });
      commit(entries, snaps);
      return result;
    },

    async updateAdGroupSharedSets(items: { id: number; sharedSetIds: number[] }[]) {
      if (!items.length) return client.updateAdGroupSharedSets(items);
      const groups = await client.adGroupsByIds([...new Set(items.map((i) => i.id))]);
      const byId = new Map(groups.map((g) => [g.Id, g]));
      const result = await client.updateAdGroupSharedSets(items);
      const at = new Date(now()).toISOString();
      const entries: ChangeEntry[] = [];
      const snaps: Array<[string, string | number, unknown]> = [];
      const results = Array.isArray(result) ? result : null;
      items.forEach((item, i) => {
        const group = byId.get(item.id);
        const before = group?.NegativeKeywordSharedSetIds ?? [];
        const snap = snapGet<{ NegativeKeywordSharedSetIds?: unknown }>(
          ctx.db, prefix, "ad_group", item.id, now(),
        );
        if (snap && !jsonEqual(snap.NegativeKeywordSharedSetIds, before)) {
          entries.push(entry(at, "direct", {
            objectType: "ad_group", objectId: String(item.id),
            campaignId: group?.CampaignId, adGroupId: item.id,
            field: "NegativeKeywordSharedSetIds",
            before: snap.NegativeKeywordSharedSetIds, after: before,
          }));
        }
        const ok = results ? !itemFailed(results[i]) : true;
        if (ok) {
          entries.push(entry(at, ctx.origin.source, {
            objectType: "ad_group", objectId: String(item.id),
            campaignId: group?.CampaignId, adGroupId: item.id,
            field: "NegativeKeywordSharedSetIds", before, after: item.sharedSetIds,
          }));
        }
        if (snap) {
          snaps.push(["ad_group", item.id, {
            ...snap,
            NegativeKeywordSharedSetIds: ok ? item.sharedSetIds : before,
          }]);
        }
      });
      commit(entries, snaps);
      return result;
    },

    async updateKeywords(items: { id: number; keyword: string }[]) {
      if (!items.length) return client.updateKeywords(items);
      const keywords = await client.keywordsByIds([...new Set(items.map((i) => i.id))]);
      const byId = new Map(keywords.map((k) => [k.Id, k]));
      const result = await client.updateKeywords(items);
      const at = new Date(now()).toISOString();
      const entries: ChangeEntry[] = [];
      const snaps: Array<[string, string | number, unknown]> = [];
      const results = Array.isArray(result) ? result : null;
      const kwSnaps = new Map<number, Record<string, string> | null>();
      const kwSnap = (groupId: number): Record<string, string> | null => {
        if (!kwSnaps.has(groupId)) {
          kwSnaps.set(
            groupId,
            snapGet<Record<string, string>>(ctx.db, prefix, "keywords", groupId, now()) ?? null,
          );
        }
        return kwSnaps.get(groupId) ?? null;
      };
      items.forEach((item, i) => {
        const keyword = byId.get(item.id);
        const before = keyword?.Keyword ?? null;
        const groupId = keyword?.AdGroupId;
        const snap = groupId === undefined ? null : kwSnap(groupId);
        if (snap && groupId !== undefined) {
          const prev = snap[String(item.id)] ?? null;
          if (!jsonEqual(prev, before)) {
            entries.push(entry(at, "direct", {
              objectType: "keyword", objectId: String(item.id),
              campaignId: keyword?.CampaignId, adGroupId: groupId,
              field: "Keyword", before: prev, after: before,
            }));
          }
        }
        const ok = results ? !itemFailed(results[i]) : true;
        if (ok) {
          entries.push(entry(at, ctx.origin.source, {
            objectType: "keyword", objectId: String(item.id),
            campaignId: keyword?.CampaignId, adGroupId: groupId,
            field: "Keyword", before, after: item.keyword,
          }));
        }
        if (snap && groupId !== undefined) {
          if (ok) snap[String(item.id)] = item.keyword;
          else if (typeof before === "string") snap[String(item.id)] = before;
          else delete snap[String(item.id)];
        }
      });
      for (const [groupId, snap] of kwSnaps) {
        if (snap !== null) snaps.push(["keywords", groupId, snap]);
      }
      commit(entries, snaps);
      return result;
    },

    async deleteKeywords(ids: number[]) {
      if (!ids.length) return client.deleteKeywords(ids);
      const keywords = await client.keywordsByIds([...new Set(ids)]);
      const byId = new Map(keywords.map((k) => [k.Id, k]));
      const result = await client.deleteKeywords(ids);
      const at = new Date(now()).toISOString();
      const entries: ChangeEntry[] = [];
      const snaps: Array<[string, string | number, unknown]> = [];
      const results = Array.isArray(result) ? result : null;
      const kwSnaps = new Map<number, Record<string, string> | null>();
      const kwSnap = (groupId: number): Record<string, string> | null => {
        if (!kwSnaps.has(groupId)) {
          kwSnaps.set(
            groupId,
            snapGet<Record<string, string>>(ctx.db, prefix, "keywords", groupId, now()) ?? null,
          );
        }
        return kwSnaps.get(groupId) ?? null;
      };
      ids.forEach((id, i) => {
        const keyword = byId.get(id);
        const before = keyword?.Keyword ?? null;
        const groupId = keyword?.AdGroupId;
        const snap = groupId === undefined ? null : kwSnap(groupId);
        if (snap && groupId !== undefined) {
          const prev = snap[String(id)] ?? null;
          if (!jsonEqual(prev, before)) {
            entries.push(entry(at, "direct", {
              objectType: "keyword", objectId: String(id),
              campaignId: keyword?.CampaignId, adGroupId: groupId,
              field: "Keyword", before: prev, after: before,
            }));
          }
        }
        const ok = results ? !itemFailed(results[i]) : true;
        if (ok) {
          entries.push(entry(at, ctx.origin.source, {
            objectType: "keyword", objectId: String(id),
            campaignId: keyword?.CampaignId, adGroupId: groupId,
            field: "Keyword", before, after: null, note: "deleted",
          }));
        }
        if (snap && groupId !== undefined) {
          if (ok) delete snap[String(id)];
          else if (typeof before === "string") snap[String(id)] = before;
        }
      });
      for (const [groupId, snap] of kwSnaps) {
        if (snap !== null) snaps.push(["keywords", groupId, snap]);
      }
      commit(entries, snaps);
      return result;
    },

    async updateSharedSet(id: number, negativeKeywords: string[]) {
      const sets = await client.sharedSets([id]);
      const before = sets.find((s) => s.Id === id)?.NegativeKeywords ?? [];
      const result = await client.updateSharedSet(id, negativeKeywords);
      const at = new Date(now()).toISOString();
      const entries: ChangeEntry[] = [];
      const snaps: Array<[string, string | number, unknown]> = [];
      const snap = snapGet<{ NegativeKeywords?: unknown }>(
        ctx.db, prefix, "shared_set", id, now(),
      );
      if (snap && !jsonEqual(snap.NegativeKeywords, before)) {
        entries.push(entry(at, "direct", {
          objectType: "shared_set", objectId: String(id),
          field: "NegativeKeywords", before: snap.NegativeKeywords, after: before,
        }));
      }
      const ok = !Array.isArray(result) || !itemFailed(result[0]);
      if (ok) {
        entries.push(entry(at, ctx.origin.source, {
          objectType: "shared_set", objectId: String(id),
          field: "NegativeKeywords", before, after: negativeKeywords,
        }));
      }
      if (snap) {
        snaps.push(["shared_set", id, { ...snap, NegativeKeywords: ok ? negativeKeywords : before }]);
      }
      commit(entries, snaps);
      return result;
    },

    async addSharedSet(name: string, negativeKeywords: string[]) {
      const newId = await client.addSharedSet(name, negativeKeywords);
      if (typeof newId === "number") {
        const at = new Date(now()).toISOString();
        recordChanges(ctx.db, [
          entry(at, ctx.origin.source, {
            objectType: "shared_set", objectId: String(newId),
            field: "Name", before: null, after: name, note: "created",
          }),
          entry(at, ctx.origin.source, {
            objectType: "shared_set", objectId: String(newId),
            field: "NegativeKeywords", before: null, after: negativeKeywords, note: "created",
          }),
        ]);
      }
      return newId;
    },
  };
}

export type SyncDirectClient = Pick<
  DirectClient,
  | "changesCheckCampaigns"
  | "changesCheck"
  | "campaigns"
  | "campaignExcludedSites"
  | "adGroups"
  | "adGroupsByIds"
  | "keywords"
  | "keywordsByIds"
  | "sharedSets"
>;

const ECHO_MS = 10 * 60 * 1000;

const fmtTs = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type CampaignSnap = { Name?: unknown; NegativeKeywords?: unknown; ExcludedSites?: unknown };
type AdGroupSnap = {
  Name?: unknown;
  NegativeKeywords?: unknown;
  NegativeKeywordSharedSetIds?: unknown;
};

export async function syncDirectChanges(
  client: SyncDirectClient,
  db: Database.Database,
  args: { accountId: string; clientLogin?: string; now?: () => number },
): Promise<{ added: number; skipped: number; timestamp: string }> {
  const now = args.now ?? Date.now;
  const nowMs = now();
  const prefix = `${args.accountId}|${args.clientLogin ?? ""}`;
  const cursorKey = prefix;
  const cursor = cacheGet<string>(db, "changesTs", cursorKey, nowMs);

  if (cursor === undefined) {
    const probe = await client.changesCheckCampaigns(fmtTs(nowMs - 60_000));
    const all = await client.campaigns({ states: ALL_CAMPAIGN_STATES });
    const allIds = all.map((c) => c.Id);
    const excludedAll = allIds.length
      ? await client.campaignExcludedSites(allIds)
      : new Map<number, string[]>();
    const allGroups = allIds.length ? await client.adGroups(allIds) : [];
    const allKeywords = allIds.length ? await client.keywords(allIds) : [];
    const keywordsByGroup = new Map<number, Record<string, string>>();
    for (const k of allKeywords) {
      const map = keywordsByGroup.get(k.AdGroupId) ?? {};
      map[String(k.Id)] = k.Keyword;
      keywordsByGroup.set(k.AdGroupId, map);
    }
    const tx = db.transaction(() => {
      for (const c of all) {
        snapSet(db, prefix, "campaign", c.Id, {
          Name: c.Name,
          NegativeKeywords: c.NegativeKeywords?.Items ?? [],
          ExcludedSites: excludedAll.get(c.Id) ?? [],
        });
      }
      for (const g of allGroups) {
        snapSet(db, prefix, "ad_group", g.Id, {
          Name: g.Name,
          NegativeKeywords: g.NegativeKeywords?.Items ?? [],
          NegativeKeywordSharedSetIds: g.NegativeKeywordSharedSetIds ?? [],
        });
        snapSet(db, prefix, "keywords", g.Id, keywordsByGroup.get(g.Id) ?? {});
      }
      cacheSet(db, "changesTs", cursorKey, probe.Timestamp, null);
    });
    tx();
    return { added: 0, skipped: 0, timestamp: probe.Timestamp };
  }

  const checkCampaigns = await client.changesCheckCampaigns(cursor);
  const kept = checkCampaigns.Campaigns
    .filter((c) => c.ChangesIn.includes("SELF") || c.ChangesIn.includes("CHILDREN"))
    .map((c) => c.CampaignId);
  const check = kept.length
    ? await client.changesCheck({ campaignIds: kept, timestamp: cursor })
    : null;
  const unprocessed = check?.Unprocessed ?? {
    CampaignIds: [] as number[],
    AdGroupIds: [] as number[],
    AdIds: [] as number[],
  };
  const leftover =
    (unprocessed.CampaignIds?.length ?? 0) +
    (unprocessed.AdGroupIds?.length ?? 0) +
    (unprocessed.AdIds?.length ?? 0);
  if (leftover > 0) {
    throw new Error(`changes.check left ${leftover} objects unprocessed`);
  }
  const modified = check?.Modified ?? {
    CampaignIds: [] as number[],
    AdGroupIds: [] as number[],
    AdIds: [] as number[],
  };

  const campaignIds = [...new Set(modified.CampaignIds)];
  const campaigns = campaignIds.length
    ? await client.campaigns({ ids: campaignIds, states: ALL_CAMPAIGN_STATES })
    : [];
  const excluded = campaignIds.length
    ? await client.campaignExcludedSites(campaignIds)
    : new Map<number, string[]>();
  const groupIds = [...new Set(modified.AdGroupIds)];
  const groups = groupIds.length ? await client.adGroupsByIds(groupIds) : [];
  const groupCampaignIds = [...new Set(groups.map((g) => g.CampaignId))];
  const keywordRows = groupCampaignIds.length ? await client.keywords(groupCampaignIds) : [];
  const groupSet = new Set(groupIds);
  const keywordsByGroup = new Map<number, Record<string, string>>();
  for (const k of keywordRows) {
    if (!groupSet.has(k.AdGroupId)) continue;
    const map = keywordsByGroup.get(k.AdGroupId) ?? {};
    map[String(k.Id)] = k.Keyword;
    keywordsByGroup.set(k.AdGroupId, map);
  }

  const at = new Date(nowMs).toISOString();
  const entries: ChangeEntry[] = [];
  const snaps: Array<[string, string | number, unknown]> = [];
  const direct = (
    objectType: ChangeObjectType,
    objectId: string,
    field: string,
    before: unknown,
    after: unknown,
    ids: { campaignId?: number; adGroupId?: number } = {},
    note?: string,
  ): void => {
    entries.push({
      at,
      accountId: args.accountId,
      clientLogin: args.clientLogin,
      source: "direct",
      actor: "direct",
      objectType,
      objectId,
      field,
      before,
      after,
      note,
      ...ids,
    });
  };

  for (const c of campaigns) {
    const current: CampaignSnap = {
      Name: c.Name,
      NegativeKeywords: c.NegativeKeywords?.Items ?? [],
      ExcludedSites: excluded.get(c.Id) ?? [],
    };
    const snap = snapGet<CampaignSnap>(db, prefix, "campaign", c.Id, nowMs);
    if (snap === undefined) {
      direct("campaign", String(c.Id), "modified", null, current, { campaignId: c.Id }, "created");
    } else {
      for (const field of ["Name", "NegativeKeywords", "ExcludedSites"] as const) {
        const before = snap[field];
        const after = current[field];
        if (jsonEqual(before, after)) continue;
        direct("campaign", String(c.Id), field, before, after, { campaignId: c.Id });
      }
    }
    snaps.push(["campaign", c.Id, current]);
  }

  const foundCampaignIds = new Set(campaigns.map((c) => c.Id));
  const goneCampaignIds: number[] = [];
  for (const id of campaignIds) {
    if (foundCampaignIds.has(id)) continue;
    const snap = snapGet<CampaignSnap>(db, prefix, "campaign", id, nowMs);
    direct(
      "campaign", String(id), "modified", snap ?? null, null,
      { campaignId: id }, "not found",
    );
    goneCampaignIds.push(id);
  }

  for (const g of groups) {
    const current: AdGroupSnap = {
      Name: g.Name,
      NegativeKeywords: g.NegativeKeywords?.Items ?? [],
      NegativeKeywordSharedSetIds: g.NegativeKeywordSharedSetIds ?? [],
    };
    const snap = snapGet<AdGroupSnap>(db, prefix, "ad_group", g.Id, nowMs);
    if (snap === undefined) {
      direct(
        "ad_group", String(g.Id), "modified", null, current,
        { campaignId: g.CampaignId, adGroupId: g.Id }, "created",
      );
    } else {
      for (const field of ["Name", "NegativeKeywords", "NegativeKeywordSharedSetIds"] as const) {
        const before = snap[field];
        const after = current[field];
        if (jsonEqual(before, after)) continue;
        direct(
          "ad_group", String(g.Id), field, before, after,
          { campaignId: g.CampaignId, adGroupId: g.Id },
        );
      }
    }
    snaps.push(["ad_group", g.Id, current]);
  }

  for (const g of groups) {
    const current = keywordsByGroup.get(g.Id) ?? {};
    const snap = snapGet<Record<string, string>>(db, prefix, "keywords", g.Id, nowMs);
    if (snap === undefined) {
      direct(
        "keyword", String(g.Id), "modified", null, current,
        { campaignId: g.CampaignId, adGroupId: g.Id }, "created",
      );
    } else {
      const ids = new Set([...Object.keys(snap), ...Object.keys(current)]);
      for (const id of ids) {
        const before = snap[id];
        const after = current[id];
        if (before === after) continue;
        if (before === undefined) {
          direct("keyword", id, "Keyword", null, after, { campaignId: g.CampaignId, adGroupId: g.Id }, "created");
        } else if (after === undefined) {
          direct("keyword", id, "Keyword", before, null, { campaignId: g.CampaignId, adGroupId: g.Id }, "deleted");
        } else {
          direct("keyword", id, "Keyword", before, after, { campaignId: g.CampaignId, adGroupId: g.Id });
        }
      }
    }
    snaps.push(["keywords", g.Id, current]);
  }

  for (const adId of modified.AdIds) {
    direct("ad", String(adId), "modified", null, null);
  }

  const echoSince = nowMs - ECHO_MS;
  const latestSel = db.prepare(
    `SELECT source, after, at FROM change_history
     WHERE account_id = ? AND client_login IS ? AND object_type = ? AND object_id = ? AND field = ?
     ORDER BY at DESC, id DESC LIMIT 1`,
  );
  const keptEntries: ChangeEntry[] = [];
  let skipped = 0;
  for (const e of entries) {
    const afterText = jsonOrNull(e.after);
    const latest = latestSel.get(
      e.accountId,
      e.clientLogin ?? null,
      e.objectType,
      e.objectId,
      e.field,
    ) as { source: string; after: string | null; at: string } | undefined;
    const echoed =
      latest !== undefined &&
      latest.source !== "direct" &&
      latest.after === afterText &&
      Date.parse(latest.at) >= echoSince;
    if (echoed) skipped += 1;
    else keptEntries.push(e);
  }

  const ins = db.prepare(INSERT_SQL);
  const tx = db.transaction(() => {
    for (const e of keptEntries) ins.run(...rowParams(e));
    for (const [objectType, objectId, value] of snaps) {
      snapSet(db, prefix, objectType, objectId, value);
    }
    for (const id of goneCampaignIds) snapDel(db, prefix, "campaign", id);
    cacheSet(db, "changesTs", cursorKey, checkCampaigns.Timestamp, null);
  });
  tx();
  return { added: keptEntries.length, skipped, timestamp: checkCampaigns.Timestamp };
}
