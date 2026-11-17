import { createHash } from "node:crypto";
import type { FetchFn } from "./yandex-oauth.ts";

const BASE_URL = "https://api.direct.yandex.com/json/v5/";
const RETRY_CODES = new Set([52, 152, 506, 1000]);
const MAX_RETRIES = 3;
const MAX_REPORT_TRIES = 30;
const DEFAULT_RETRY_IN_SEC = 10;
export const REPORT_WAIT_BUDGET_MS = 4 * 60_000;
const PAGE_LIMIT = 10000;
const CRITERIA_BATCH = 10;
const IDS_BATCH = 1000;
const CHANGES_BATCH = 3000;

export const ALL_CAMPAIGN_STATES = [
  "ON",
  "SUSPENDED",
  "OFF",
  "ENDED",
  "ARCHIVED",
  "CONVERTED",
];

const REPORT_FIELDS = [
  "Date",
  "CampaignId",
  "CampaignName",
  "AdGroupId",
  "AdGroupName",
  "Query",
  "CriterionType",
  "Criterion",
  "CriterionId",
  "MatchType",
  "TargetingCategory",
  "Impressions",
  "Clicks",
  "Cost",
  "AvgImpressionPosition",
  "AvgClickPosition",
  "Conversions",
];

const PLACEMENT_FIELDS = [
  "CampaignId",
  "CampaignName",
  "Placement",
  "AdNetworkType",
  "Impressions",
  "Clicks",
  "Cost",
  "Conversions",
];

const PERFORMANCE_FIELDS = [
  "Date",
  "CampaignId",
  "CampaignName",
  "CampaignType",
  "AdNetworkType",
  "Impressions",
  "Clicks",
  "Cost",
  "Conversions",
  "CostPerConversion",
];

const GOALS_PER_REPORT = 10;

function performanceParseFields(goals: number[]): string[] {
  if (goals.length === 0) return PERFORMANCE_FIELDS;
  const fields: string[] = [];
  for (const field of PERFORMANCE_FIELDS) {
    if (field === "Conversions") {
      fields.push(...goals.map((goal) => `Conversions_${goal}_AUTO`));
    } else if (field === "CostPerConversion") {
      fields.push(...goals.map((goal) => `CostPerConversion_${goal}_AUTO`));
    } else {
      fields.push(field);
    }
  }
  return fields;
}

function performanceRowKey(row: SearchQueryRow): string {
  return `${String(row.Date ?? "")}|${String(row.CampaignId ?? "")}|${String(row.AdNetworkType ?? "")}`;
}

const KEYWORD_FIELDS = [
  "CampaignName",
  "Criterion",
  "Impressions",
  "Clicks",
  "Cost",
  "AvgImpressionPosition",
  "AvgClickPosition",
  "AvgTrafficVolume",
];

export class DirectApiError extends Error {
  readonly code: number;
  readonly detail?: string;

  constructor(code: number, message: string, detail?: string) {
    super(message);
    this.name = "DirectApiError";
    this.code = code;
    this.detail = detail;
  }
}

export class DirectItemRejected extends Error {
  readonly id: number;
  readonly details: string;

  constructor(id: number, details: string) {
    super(`Direct rejected ${id}: ${details}`);
    this.name = "DirectItemRejected";
    this.id = id;
    this.details = details;
  }
}

export interface DirectUnits {
  spent: number;
  rest: number;
  limit: number;
}

export interface SearchQueryRow {
  [field: string]: string | number | null;
}

export interface Campaign {
  Id: number;
  Name: string;
  State: string;
  Status: string;
  Type: string;
  NegativeKeywords?: { Items?: string[] };
}

export interface AdGroup {
  Id: number;
  CampaignId: number;
  Name: string;
  NegativeKeywordSharedSetIds?: number[];
  NegativeKeywords?: { Items?: string[] };
}

export interface Keyword {
  Id: number;
  Keyword: string;
  CampaignId: number;
  AdGroupId: number;
  State: string;
}

export interface AuctionBidItem {
  TrafficVolume?: number;
  Bid?: number;
  Price?: number;
}

export interface KeywordBid {
  KeywordId: number;
  CampaignId: number;
  AdGroupId: number;
  ServingStatus?: string;
  Search?: {
    Bid?: number;
    AuctionBids?: { AuctionBidItems?: AuctionBidItem[] };
  };
}

export interface SharedSet {
  Id: number;
  Name: string;
  NegativeKeywords: string[];
}

export interface AgencyClient {
  Login: string;
  ClientInfo?: string;
}

type SleepFn = (ms: number) => Promise<void>;

export interface DirectTransport {
  call(service: string, method: string, params: unknown): Promise<unknown>;
  report(params: unknown): Promise<string>;
}

interface CallResult {
  [key: string]: unknown;
  LimitedBy?: number;
}

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseUnits(header: string | null): DirectUnits | undefined {
  if (!header) return undefined;
  const parts = header.split("/").map((p) => Number(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((p) => Number.isNaN(p))) return undefined;
  return { spent: parts[0], rest: parts[1], limit: parts[2] };
}

function toError(body: unknown, status: number): DirectApiError {
  const e = (body ?? {}) as Record<string, unknown>;
  return new DirectApiError(
    Number(e.error_code ?? status),
    String(e.error_string ?? `direct api error ${status}`),
    typeof e.error_detail === "string" ? e.error_detail : undefined,
  );
}

function checkItems(results: unknown, ids: number[], label = ""): void {
  if (!Array.isArray(results)) return;
  results.forEach((raw, index) => {
    const item = (raw ?? {}) as { Id?: number; Errors?: { Details?: string; Message?: string }[] };
    if (item.Id !== undefined || !Array.isArray(item.Errors) || !item.Errors.length) return;
    const details = item.Errors.map((e) => e?.Details || e?.Message).filter(Boolean).join("; ");
    throw new DirectItemRejected(ids[index] ?? 0, `${label}${details}`);
  });
}

function parseCell(cell: string): string | number | null {
  if (cell === "--" || cell === "") return null;
  const n = Number(cell);
  return Number.isNaN(n) ? cell : n;
}

const TEXT_FIELDS = new Set([
  "Date",
  "CampaignName",
  "CampaignType",
  "AdGroupName",
  "Criterion",
  "Query",
  "Placement",
  "AdNetworkType",
  "MatchType",
  "CriterionType",
]);

function parseTextCell(cell: string): string | null {
  if (cell === "--" || cell === "") return null;
  return cell;
}

function parseTsv(text: string, fields: string[] = REPORT_FIELDS): SearchQueryRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return [];
  let cols = fields;
  const first = lines[0].split("\t");
  if (first.length > 1 && first.every((cell) => fields.includes(cell))) {
    cols = first;
    lines.shift();
  }
  return lines.map((line) => {
    const cells = line.split("\t");
    const row: SearchQueryRow = {};
    cols.forEach((field, i) => {
      const cell = cells[i] ?? "";
      row[field] = TEXT_FIELDS.has(field) ? parseTextCell(cell) : parseCell(cell);
    });
    return row;
  });
}

const campaignValues = (ids: number[]): string[] =>
  [...ids].sort((a, b) => a - b).map(String);

// Report names must be stable: the same params always produce the same name so
// a later run or catch-up reads the report Direct already generated instead of
// queueing a new one. The hash covers every param that changes the report;
// boxed goal FieldNames are reduced to plain strings first.
function stableReportName(
  params: Record<string, unknown>,
  clientLogin: string | undefined,
  label = "",
  part?: number,
): string {
  const criteria = (params.SelectionCriteria ?? {}) as Record<string, unknown>;
  const hash = createHash("sha1")
    .update(
      JSON.stringify({
        ReportType: params.ReportType,
        DateFrom: criteria.DateFrom,
        DateTo: criteria.DateTo,
        FieldNames: Array.isArray(params.FieldNames)
          ? params.FieldNames.map(String)
          : params.FieldNames,
        Filter: criteria.Filter,
        Goals: params.Goals,
        AttributionModels: params.AttributionModels,
        part,
        clientLogin,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return `direct-queries${label ? ` ${label}` : ""} ${String(criteria.DateFrom)}_${String(criteria.DateTo)} ${hash}`;
}

function reportNotReady(params: unknown): DirectApiError {
  const name = (params as { ReportName?: unknown } | null | undefined)?.ReportName;
  return new DirectApiError(
    0,
    "report not ready",
    `report ${typeof name === "string" ? name : "(unnamed)"} stays queued in Direct; a catch-up run reads it`,
  );
}

interface HttpTransport extends DirectTransport {
  readonly units?: DirectUnits;
}

function createHttpTransport(opts: {
  token: string;
  clientLogin?: string;
  fetch: FetchFn;
  sleep: SleepFn;
  now: () => number;
}): HttpTransport {
  const sleep = opts.sleep;
  const now = opts.now;
  let units: DirectUnits | undefined;

  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    Authorization: `Bearer ${opts.token}`,
    "Accept-Language": "ru",
    "Content-Type": "application/json",
    ...(opts.clientLogin ? { "Client-Login": opts.clientLogin } : {}),
    ...extra,
  });

  async function call(service: string, method: string, params: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const res = await opts.fetch(`${BASE_URL}${service}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ method, params }),
      });
      units = parseUnits(res.headers.get("Units")) ?? units;
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // TSV or plain-text error page
      }
      if (body.error) {
        const err = toError(body.error, res.status);
        if (RETRY_CODES.has(err.code) && attempt <= MAX_RETRIES) {
          await sleep(1000 * attempt);
          continue;
        }
        throw err;
      }
      if (res.status === 200) return body.result ?? body;
      if (res.status >= 500 && attempt <= MAX_RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new DirectApiError(res.status, `http ${res.status}`, text.slice(0, 300));
    }
  }

  async function report(params: unknown): Promise<string> {
    const reportHeaders = headers({
      processingMode: "auto",
      returnMoneyInMicros: "false",
      skipReportHeader: "true",
      skipReportSummary: "true",
    });
    const startedAt = now();
    for (let attempt = 1; attempt <= MAX_REPORT_TRIES; attempt++) {
      const res = await opts.fetch(`${BASE_URL}reports`, {
        method: "POST",
        headers: reportHeaders,
        body: JSON.stringify({ params }),
      });
      units = parseUnits(res.headers.get("Units")) ?? units;
      if (res.status === 201 || res.status === 202) {
        if (now() - startedAt >= REPORT_WAIT_BUDGET_MS) break;
        const wait = Number(res.headers.get("retryIn")) || DEFAULT_RETRY_IN_SEC;
        await sleep(wait * 1000);
        continue;
      }
      const text = await res.text();
      if (res.status === 200) return text;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // plain-text error page
      }
      if (parsed.error) throw toError(parsed.error, res.status);
      if (res.status >= 500 && attempt <= MAX_RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new DirectApiError(res.status, `http ${res.status}`, text.slice(0, 300));
    }
    throw reportNotReady(params);
  }

  return {
    call,
    report,
    get units() {
      return units;
    },
  };
}

export type DirectClientOptions =
  | {
      token: string;
      clientLogin?: string;
      fetch: FetchFn;
      sleep?: SleepFn;
      now?: () => number;
    }
  | {
      transport: DirectTransport;
      sleep?: SleepFn;
      now?: () => number;
    };

export function createDirectClient(opts: DirectClientOptions) {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const clientLogin = "clientLogin" in opts ? opts.clientLogin : undefined;
  const transport: DirectTransport & { readonly units?: DirectUnits } =
    "transport" in opts
      ? opts.transport
      : createHttpTransport({
          token: opts.token,
          clientLogin: opts.clientLogin,
          fetch: opts.fetch,
          sleep,
          now,
        });

  const call = <T = CallResult>(service: string, method: string, params: unknown): Promise<T> =>
    transport.call(service, method, params) as Promise<T>;

  async function* paged(
    service: string,
    params: Record<string, unknown>,
    listKey: string,
  ): AsyncGenerator<Record<string, unknown>> {
    let offset: number | undefined;
    do {
      const res = await call<CallResult>(service, "get", {
        ...params,
        Page: { Limit: PAGE_LIMIT, ...(offset !== undefined ? { Offset: offset } : {}) },
      });
      const list = (res[listKey] as Record<string, unknown>[] | undefined) ?? [];
      for (const item of list) yield item;
      offset = res.LimitedBy;
    } while (offset !== undefined);
  }

  async function reportRows(
    params: Record<string, unknown>,
    fields: string[],
  ): Promise<SearchQueryRow[]> {
    const startedAt = now();
    for (let attempt = 1; attempt <= MAX_REPORT_TRIES; attempt++) {
      try {
        return parseTsv(await transport.report(params), fields);
      } catch (e) {
        if (!(e instanceof DirectApiError) || e.code !== 202) throw e;
        if (attempt === MAX_REPORT_TRIES || now() - startedAt >= REPORT_WAIT_BUDGET_MS) break;
        await sleep(DEFAULT_RETRY_IN_SEC * 1000);
      }
    }
    throw reportNotReady(params);
  }

  return {
    get units(): DirectUnits | undefined {
      return transport.units;
    },

    async campaigns(filter?: { states?: string[]; ids?: number[] }): Promise<Campaign[]> {
      const out: Campaign[] = [];
      const ids = filter?.ids ?? [];
      const batches: number[][] = [];
      for (let i = 0; i < ids.length; i += IDS_BATCH) {
        batches.push(ids.slice(i, i + IDS_BATCH));
      }
      if (!batches.length) batches.push([]);
      for (const batch of batches) {
        for await (const item of paged(
          "campaigns",
          {
            SelectionCriteria: {
              States: filter?.states ?? ["ON", "SUSPENDED", "OFF"],
              ...(batch.length ? { Ids: batch } : {}),
            },
            FieldNames: ["Id", "Name", "State", "Status", "Type", "NegativeKeywords"],
          },
          "Campaigns",
        )) {
          out.push(item as unknown as Campaign);
        }
      }
      return out;
    },

    async updateCampaignNegatives(items: { id: number; phrases: string[] }[]): Promise<unknown> {
      const res = await call<{ UpdateResults: unknown[] }>("campaigns", "update", {
        Campaigns: items.map((item) => ({
          Id: item.id,
          NegativeKeywords: { Items: item.phrases },
        })),
      });
      checkItems(
        res.UpdateResults,
        items.map((item) => item.id),
      );
      return res.UpdateResults;
    },

    async adGroups(campaignIds: number[]): Promise<AdGroup[]> {
      const out: AdGroup[] = [];
      for (let i = 0; i < campaignIds.length; i += CRITERIA_BATCH) {
        const batch = campaignIds.slice(i, i + CRITERIA_BATCH);
        for await (const item of paged(
          "adgroups",
          {
            SelectionCriteria: { CampaignIds: batch },
            FieldNames: [
              "Id",
              "CampaignId",
              "Name",
              "NegativeKeywordSharedSetIds",
              "NegativeKeywords",
            ],
          },
          "AdGroups",
        )) {
          out.push(item as unknown as AdGroup);
        }
      }
      return out;
    },

    async adGroupsByIds(ids: number[]): Promise<AdGroup[]> {
      const out: AdGroup[] = [];
      for (let i = 0; i < ids.length; i += IDS_BATCH) {
        const batch = ids.slice(i, i + IDS_BATCH);
        for await (const item of paged(
          "adgroups",
          {
            SelectionCriteria: { Ids: batch },
            FieldNames: [
              "Id",
              "CampaignId",
              "Name",
              "NegativeKeywordSharedSetIds",
              "NegativeKeywords",
            ],
          },
          "AdGroups",
        )) {
          out.push(item as unknown as AdGroup);
        }
      }
      return out;
    },

    async updateAdGroupSharedSets(
      items: { id: number; sharedSetIds: number[] }[],
    ): Promise<unknown> {
      const res = await call<{ UpdateResults: unknown[] }>("adgroups", "update", {
        AdGroups: items.map((item) => ({
          Id: item.id,
          NegativeKeywordSharedSetIds: item.sharedSetIds,
        })),
      });
      checkItems(
        res.UpdateResults,
        items.map((item) => item.id),
      );
      return res.UpdateResults;
    },

    async updateAdGroupNegatives(items: { id: number; phrases: string[] }[]): Promise<unknown> {
      const res = await call<{ UpdateResults: unknown[] }>("adgroups", "update", {
        AdGroups: items.map((item) => ({
          Id: item.id,
          NegativeKeywords: { Items: item.phrases },
        })),
      });
      checkItems(
        res.UpdateResults,
        items.map((item) => item.id),
      );
      return res.UpdateResults;
    },

    async keywords(campaignIds: number[]): Promise<Keyword[]> {
      const out: Keyword[] = [];
      for (let i = 0; i < campaignIds.length; i += CRITERIA_BATCH) {
        const batch = campaignIds.slice(i, i + CRITERIA_BATCH);
        for await (const item of paged(
          "keywords",
          {
            SelectionCriteria: { CampaignIds: batch },
            FieldNames: ["Id", "Keyword", "CampaignId", "AdGroupId", "State"],
          },
          "Keywords",
        )) {
          out.push(item as unknown as Keyword);
        }
      }
      return out;
    },

    async keywordsByIds(ids: number[]): Promise<Keyword[]> {
      const out: Keyword[] = [];
      for (let i = 0; i < ids.length; i += IDS_BATCH) {
        const batch = ids.slice(i, i + IDS_BATCH);
        for await (const item of paged(
          "keywords",
          {
            SelectionCriteria: { Ids: batch },
            FieldNames: ["Id", "Keyword", "CampaignId", "AdGroupId", "State"],
          },
          "Keywords",
        )) {
          out.push(item as unknown as Keyword);
        }
      }
      return out;
    },

    async deleteKeywords(ids: number[]): Promise<unknown> {
      const res = await call<{ DeleteResults: unknown[] }>("keywords", "delete", {
        SelectionCriteria: { Ids: ids },
      });
      checkItems(res.DeleteResults, ids);
      return res.DeleteResults;
    },

    async updateKeywords(items: { id: number; keyword: string }[]): Promise<unknown> {
      const res = await call<{ UpdateResults: unknown[] }>("keywords", "update", {
        Keywords: items.map((item) => ({ Id: item.id, Keyword: item.keyword })),
      });
      checkItems(
        res.UpdateResults,
        items.map((item) => item.id),
      );
      return res.UpdateResults;
    },

    async addKeywords(
      items: { adGroupId: number; keyword: string; bid?: number }[],
    ): Promise<{
      added: { index: number; id: number }[];
      rejected: { index: number; details: string }[];
    }> {
      const added: { index: number; id: number }[] = [];
      const rejected: { index: number; details: string }[] = [];
      for (let i = 0; i < items.length; i += IDS_BATCH) {
        const batch = items.slice(i, i + IDS_BATCH);
        const res = await call<{ AddResults?: unknown[] }>("keywords", "add", {
          Keywords: batch.map((item) => ({
            AdGroupId: item.adGroupId,
            Keyword: item.keyword,
            ...(item.bid !== undefined ? { Bid: item.bid } : {}),
          })),
        });
        if (!Array.isArray(res.AddResults)) {
          throw new DirectApiError(0, "keywords.add: no AddResults");
        }
        batch.forEach((_, j) => {
          const result = (res.AddResults![j] ?? {}) as {
            Id?: number;
            Errors?: { Details?: string; Message?: string }[];
          };
          const errors = Array.isArray(result.Errors) ? result.Errors : [];
          if (errors.length) {
            const details = errors
              .map((e) => e?.Details || e?.Message)
              .filter(Boolean)
              .join("; ");
            rejected.push({ index: i + j, details });
          } else {
            added.push({ index: i + j, id: result.Id ?? 0 });
          }
        });
      }
      return { added, rejected };
    },

    async keywordBids(target: number[] | { keywordIds: number[] }): Promise<KeywordBid[]> {
      const out: KeywordBid[] = [];
      const fetchBids = async (criteria: Record<string, unknown>): Promise<void> => {
        for await (const item of paged(
          "keywordbids",
          {
            SelectionCriteria: criteria,
            FieldNames: ["KeywordId", "CampaignId", "AdGroupId", "ServingStatus"],
            SearchFieldNames: ["Bid", "AuctionBids"],
          },
          "KeywordBids",
        )) {
          out.push(item as unknown as KeywordBid);
        }
      };
      if (Array.isArray(target)) {
        for (let i = 0; i < target.length; i += CRITERIA_BATCH) {
          const batch = target.slice(i, i + CRITERIA_BATCH);
          await fetchBids({ CampaignIds: batch, ServingStatuses: ["ELIGIBLE"] });
        }
        return out;
      }
      for (let i = 0; i < target.keywordIds.length; i += PAGE_LIMIT) {
        await fetchBids({ KeywordIds: target.keywordIds.slice(i, i + PAGE_LIMIT) });
      }
      return out;
    },

    async setKeywordBids(
      items: { keywordId: number; searchBid: number }[],
    ): Promise<{ ok: number[]; rejected: { keywordId: number; details: string }[] }> {
      const ok: number[] = [];
      const rejected: { keywordId: number; details: string }[] = [];
      for (let i = 0; i < items.length; i += 1000) {
        const batch = items.slice(i, i + 1000);
        const res = await call<{ SetResults?: unknown[] }>("keywordbids", "set", {
          KeywordBids: batch.map((item) => ({
            KeywordId: item.keywordId,
            SearchBid: item.searchBid,
          })),
        });
        if (!Array.isArray(res.SetResults)) {
          throw new DirectApiError(0, "keywordbids.set: no SetResults");
        }
        batch.forEach((item, index) => {
          const result = (res.SetResults![index] ?? {}) as {
            Errors?: { Details?: string; Message?: string }[];
          };
          const errors = Array.isArray(result.Errors) ? result.Errors : [];
          if (errors.length) {
            const details = errors
              .map((e) => e?.Details || e?.Message)
              .filter(Boolean)
              .join("; ");
            rejected.push({ keywordId: item.keywordId, details });
          } else {
            ok.push(item.keywordId);
          }
        });
      }
      return { ok, rejected };
    },

    async sharedSets(ids?: number[]): Promise<SharedSet[]> {
      const criteria: { Ids?: number[] } = {};
      if (ids?.length) criteria.Ids = ids;
      const out: SharedSet[] = [];
      for await (const item of paged(
        "negativekeywordsharedsets",
        {
          SelectionCriteria: criteria,
          FieldNames: ["Id", "Name", "NegativeKeywords"],
        },
        "NegativeKeywordSharedSets",
      )) {
        out.push(item as unknown as SharedSet);
      }
      return out;
    },

    async addSharedSet(name: string, negativeKeywords: string[]): Promise<number> {
      const res = await call<{ AddResults: { Id: number }[] }>("negativekeywordsharedsets", "add", {
        NegativeKeywordSharedSets: [{ Name: name, NegativeKeywords: negativeKeywords }],
      });
      checkItems(res.AddResults, [0], `${name}: `);
      return res.AddResults[0].Id;
    },

    async updateSharedSet(id: number, negativeKeywords: string[]): Promise<unknown> {
      const res = await call<{ UpdateResults: unknown[] }>("negativekeywordsharedsets", "update", {
        NegativeKeywordSharedSets: [{ Id: id, NegativeKeywords: negativeKeywords }],
      });
      checkItems(res.UpdateResults, [id]);
      return res.UpdateResults;
    },

    async agencyClients(): Promise<AgencyClient[]> {
      const out: AgencyClient[] = [];
      for await (const item of paged(
        "agencyclients",
        {
          SelectionCriteria: {},
          FieldNames: ["Login", "ClientInfo"],
        },
        "Clients",
      )) {
        out.push(item as unknown as AgencyClient);
      }
      return out;
    },

    async campaignExcludedSites(ids: number[]): Promise<Map<number, string[]>> {
      const out = new Map<number, string[]>();
      for (let i = 0; i < ids.length; i += CRITERIA_BATCH) {
        const batch = ids.slice(i, i + CRITERIA_BATCH);
        const res = await call<{
          Campaigns: { Id: number; ExcludedSites?: { Items?: string[] } }[];
        }>("campaigns", "get", {
          SelectionCriteria: { Ids: batch },
          FieldNames: ["Id", "ExcludedSites"],
        });
        for (const campaign of res.Campaigns ?? []) {
          out.set(campaign.Id, campaign.ExcludedSites?.Items ?? []);
        }
      }
      return out;
    },

    async updateExcludedSites(items: { id: number; sites: string[] }[]): Promise<unknown> {
      const res = await call<{ UpdateResults: unknown[] }>("campaigns", "update", {
        Campaigns: items.map((item) => ({
          Id: item.id,
          ExcludedSites: { Items: item.sites },
        })),
      });
      return res.UpdateResults;
    },

    async changesCheckCampaigns(
      timestamp: string,
    ): Promise<{ Campaigns: { CampaignId: number; ChangesIn: string[] }[]; Timestamp: string }> {
      const res = await call<{
        Campaigns?: { CampaignId: number; ChangesIn?: string[] }[];
        Timestamp?: string;
      }>("changes", "checkCampaigns", { Timestamp: timestamp });
      return {
        Campaigns: (res.Campaigns ?? []).map((c) => ({
          CampaignId: c.CampaignId,
          ChangesIn: c.ChangesIn ?? [],
        })),
        Timestamp: res.Timestamp ?? timestamp,
      };
    },

    async changesCheck(args: {
      campaignIds: number[];
      timestamp: string;
    }): Promise<{
      Modified: { CampaignIds: number[]; AdGroupIds: number[]; AdIds: number[] };
      Unprocessed: { CampaignIds: number[]; AdGroupIds: number[]; AdIds: number[] };
      Timestamp: string;
    }> {
      const modified = { CampaignIds: [] as number[], AdGroupIds: [] as number[], AdIds: [] as number[] };
      const unprocessed = {
        CampaignIds: [] as number[],
        AdGroupIds: [] as number[],
        AdIds: [] as number[],
      };
      const fieldNames = ["CampaignIds", "AdGroupIds", "AdIds"];
      const idKinds = ["CampaignIds", "AdGroupIds", "AdIds"] as const;
      type IdKind = (typeof idKinds)[number];
      let timestamp = args.timestamp;
      for (let i = 0; i < args.campaignIds.length; i += CHANGES_BATCH) {
        const batch = args.campaignIds.slice(i, i + CHANGES_BATCH);
        const pending: Record<IdKind, Set<number>> = {
          CampaignIds: new Set(),
          AdGroupIds: new Set(),
          AdIds: new Set(),
        };
        let selection: Record<string, number[]> = { CampaignIds: batch };
        for (let ask = 0; ask < 3; ask += 1) {
          const res = await call<{
            Modified?: { CampaignIds?: number[]; AdGroupIds?: number[]; AdIds?: number[] };
            Unprocessed?: { CampaignIds?: number[]; AdGroupIds?: number[]; AdIds?: number[] };
            Timestamp?: string;
          }>("changes", "check", {
            ...selection,
            FieldNames: fieldNames,
            Timestamp: args.timestamp,
          });
          if (i === 0 && ask === 0) timestamp = res.Timestamp ?? args.timestamp;
          modified.CampaignIds.push(...(res.Modified?.CampaignIds ?? []));
          modified.AdGroupIds.push(...(res.Modified?.AdGroupIds ?? []));
          modified.AdIds.push(...(res.Modified?.AdIds ?? []));
          const asked = Object.keys(selection)[0] as IdKind;
          pending[asked] = new Set(res.Unprocessed?.[asked] ?? []);
          for (const kind of idKinds) {
            if (kind === asked) continue;
            for (const id of res.Unprocessed?.[kind] ?? []) pending[kind].add(id);
          }
          const next = idKinds.find((kind) => pending[kind].size > 0);
          if (!next) break;
          selection = { [next]: [...pending[next]] };
        }
        for (const kind of idKinds) unprocessed[kind].push(...pending[kind]);
      }
      return { Modified: modified, Unprocessed: unprocessed, Timestamp: timestamp };
    },

    async searchQueryReport(args: {
      dateFrom: string;
      dateTo: string;
      campaignIds?: number[];
      reportName?: string;
    }): Promise<SearchQueryRow[]> {
      if (args.campaignIds?.length === 0) return [];
      const params: Record<string, unknown> = {
        SelectionCriteria: {
          DateFrom: args.dateFrom,
          DateTo: args.dateTo,
          ...(args.campaignIds?.length
            ? {
                Filter: [
                  {
                    Field: "CampaignId",
                    Operator: "IN",
                    Values: campaignValues(args.campaignIds),
                  },
                ],
              }
            : {}),
        },
        FieldNames: REPORT_FIELDS,
        ReportType: "SEARCH_QUERY_PERFORMANCE_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "YES",
        IncludeDiscount: "NO",
      };
      params.ReportName = args.reportName ?? stableReportName(params, clientLogin);
      return reportRows(params, REPORT_FIELDS);
    },

    async placementsReport(args: {
      dateFrom: string;
      dateTo: string;
      campaignIds?: number[];
      reportName?: string;
    }): Promise<SearchQueryRow[]> {
      if (args.campaignIds?.length === 0) return [];
      const filter = [
        { Field: "AdNetworkType", Operator: "EQUALS", Values: ["AD_NETWORK"] },
        ...(args.campaignIds?.length
          ? [
              {
                Field: "CampaignId",
                Operator: "IN",
                Values: campaignValues(args.campaignIds),
              },
            ]
          : []),
      ];
      const params: Record<string, unknown> = {
        SelectionCriteria: {
          DateFrom: args.dateFrom,
          DateTo: args.dateTo,
          Filter: filter,
        },
        FieldNames: PLACEMENT_FIELDS,
        ReportType: "CUSTOM_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "YES",
        IncludeDiscount: "NO",
      };
      params.ReportName =
        args.reportName ?? stableReportName(params, clientLogin, "placements");
      return reportRows(params, PLACEMENT_FIELDS);
    },

    async keywordReport(args: {
      dateFrom: string;
      dateTo: string;
      campaignIds?: number[];
      reportName?: string;
      fields?: string[];
    }): Promise<SearchQueryRow[]> {
      if (args.campaignIds?.length === 0) return [];
      const fields = args.fields ?? KEYWORD_FIELDS;
      const params: Record<string, unknown> = {
        SelectionCriteria: {
          DateFrom: args.dateFrom,
          DateTo: args.dateTo,
          ...(args.campaignIds?.length
            ? {
                Filter: [
                  {
                    Field: "CampaignId",
                    Operator: "IN",
                    Values: campaignValues(args.campaignIds),
                  },
                ],
              }
            : {}),
        },
        FieldNames: fields,
        ReportType: "CRITERIA_PERFORMANCE_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "YES",
        IncludeDiscount: "NO",
      };
      params.ReportName =
        args.reportName ?? stableReportName(params, clientLogin, "keywords");
      return reportRows(params, fields);
    },

    async campaignGoals(campaignIds: number[]): Promise<Map<number, number[]>> {
      const out = new Map<number, number[]>();
      for (let i = 0; i < campaignIds.length; i += CRITERIA_BATCH) {
        const batch = campaignIds.slice(i, i + CRITERIA_BATCH);
        const res = await call<{
          Campaigns: {
            Id: number;
            TextCampaign?: { PriorityGoals?: { Items?: { GoalId: number }[] } };
            UnifiedCampaign?: { PriorityGoals?: { Items?: { GoalId: number }[] } };
          }[];
        }>("campaigns", "get", {
          SelectionCriteria: { Ids: batch },
          FieldNames: ["Id", "Type"],
          TextCampaignFieldNames: ["PriorityGoals", "CounterIds"],
          UnifiedCampaignFieldNames: ["PriorityGoals", "CounterIds"],
        });
        for (const campaign of res.Campaigns ?? []) {
          const goals =
            (campaign.TextCampaign ?? campaign.UnifiedCampaign)?.PriorityGoals?.Items?.map(
              (item) => item.GoalId,
            ) ?? [];
          out.set(campaign.Id, goals);
        }
      }
      return out;
    },

    async performanceReport(args: {
      dateFrom: string;
      dateTo: string;
      goals?: number[];
      reportName?: string;
    }): Promise<SearchQueryRow[]> {
      const goals = [...new Set(args.goals ?? [])];
      const chunks: number[][] = [];
      for (let i = 0; i < goals.length; i += GOALS_PER_REPORT) {
        chunks.push(goals.slice(i, i + GOALS_PER_REPORT));
      }
      if (chunks.length === 0) chunks.push([]);
      const base: SearchQueryRow[] = [];
      const byKey = new Map<string, SearchQueryRow>();
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Goal reports return Conversions_<id>_AUTO columns that are not valid
        // Direct FieldNames values. The OhMySEO transport converts micros only
        // when every TSV header cell appears in params.FieldNames, so boxed
        // strings keep the JSON request identical while its field-name check
        // falls back to the pattern that matches the suffixed columns.
        const fieldNames = chunk.length
          ? PERFORMANCE_FIELDS.map((field) => new String(field))
          : PERFORMANCE_FIELDS;
        const params: Record<string, unknown> = {
          SelectionCriteria: { DateFrom: args.dateFrom, DateTo: args.dateTo },
          FieldNames: fieldNames,
          ReportType: "CUSTOM_REPORT",
          DateRangeType: "CUSTOM_DATE",
          Format: "TSV",
          IncludeVAT: "YES",
          IncludeDiscount: "NO",
        };
        if (chunk.length) {
          params.Goals = chunk.map(String);
          params.AttributionModels = ["AUTO"];
        }
        params.ReportName =
          args.reportName ?? stableReportName(params, clientLogin, "perf", i + 1);
        const rows = await reportRows(params, performanceParseFields(chunk));
        if (rows.some((row) => row.Date === "Date")) {
          throw new DirectApiError(0, "report header mismatch");
        }
        if (i === 0) {
          for (const row of rows) {
            base.push(row);
            byKey.set(performanceRowKey(row), row);
          }
          continue;
        }
        for (const row of rows) {
          const key = performanceRowKey(row);
          const target = byKey.get(key);
          if (target) {
            for (const goal of chunk) {
              target[`Conversions_${goal}_AUTO`] = row[`Conversions_${goal}_AUTO`];
              target[`CostPerConversion_${goal}_AUTO`] = row[`CostPerConversion_${goal}_AUTO`];
            }
            continue;
          }
          const added: SearchQueryRow = {
            Date: row.Date,
            CampaignId: row.CampaignId,
            CampaignName: row.CampaignName,
            CampaignType: row.CampaignType,
            AdNetworkType: row.AdNetworkType,
            Impressions: 0,
            Clicks: 0,
            Cost: 0,
          };
          for (const goal of chunk) {
            added[`Conversions_${goal}_AUTO`] = row[`Conversions_${goal}_AUTO`];
            added[`CostPerConversion_${goal}_AUTO`] = row[`CostPerConversion_${goal}_AUTO`];
          }
          base.push(added);
          byKey.set(key, added);
        }
      }
      return base;
    },
  };
}

export type DirectClient = ReturnType<typeof createDirectClient>;
