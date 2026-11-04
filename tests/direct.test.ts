import { describe, it, expect } from "vitest";
import { createDirectClient, DirectApiError } from "../direct.ts";
import type { HttpResponse, FetchFn } from "../yandex-oauth.ts";

interface RecordedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

const res = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const ok = (result: unknown, headers: Record<string, string> = {}) =>
  res(200, { result }, headers);

const apiError = (code: number, status = 400) =>
  res(status, {
    error: { request_id: "r1", error_code: code, error_string: `error ${code}`, error_detail: "d" },
  });

function fakeFetch(responses: HttpResponse[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  };
  return { fetch, calls };
}

function sleepRecorder() {
  const calls: number[] = [];
  return { calls, fn: async (ms: number) => void calls.push(ms) };
}

describe("createDirectClient headers", () => {
  it("sends Client-Login only when given", async () => {
    const { fetch, calls } = fakeFetch([ok({ Campaigns: [] }), ok({ Campaigns: [] })]);
    const withLogin = createDirectClient({ token: "t", clientLogin: "agency-client", fetch });
    const without = createDirectClient({ token: "t", fetch });
    await withLogin.campaigns();
    await without.campaigns();
    expect(calls[0].init?.headers?.["Client-Login"]).toBe("agency-client");
    expect(calls[1].init?.headers?.["Client-Login"]).toBeUndefined();
    expect(calls[0].init?.headers?.Authorization).toBe("Bearer t");
    expect(calls[0].init?.headers?.["Accept-Language"]).toBe("ru");
  });

  it("parses the Units header", async () => {
    const { fetch } = fakeFetch([ok({ Campaigns: [] }, { units: "3/97/100" })]);
    const client = createDirectClient({ token: "t", fetch });
    await client.campaigns();
    expect(client.units).toEqual({ spent: 3, rest: 97, limit: 100 });
  });
});

describe("retries and errors", () => {
  it("retries error code 52 and then succeeds", async () => {
    const sleep = sleepRecorder();
    const { fetch, calls } = fakeFetch([apiError(52, 500), ok({ Campaigns: [{ Id: 1 }] })]);
    const client = createDirectClient({ token: "t", fetch, sleep: sleep.fn });
    const campaigns = await client.campaigns();
    expect(calls).toHaveLength(2);
    expect(sleep.calls).toEqual([1000]);
    expect(campaigns).toEqual([{ Id: 1 }]);
  });

  it("throws DirectApiError on code 8800 without retrying", async () => {
    const sleep = sleepRecorder();
    const { fetch, calls } = fakeFetch([apiError(8800)]);
    const client = createDirectClient({ token: "t", fetch, sleep: sleep.fn });
    const err = await client.campaigns().then(
      () => {
        throw new Error("should have thrown");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DirectApiError);
    expect((err as DirectApiError).code).toBe(8800);
    expect((err as DirectApiError).detail).toBe("d");
    expect(calls).toHaveLength(1);
    expect(sleep.calls).toEqual([]);
  });
});

describe("adGroups", () => {
  it("splits 25 campaign ids into 3 calls of at most 10", async () => {
    const { fetch, calls } = fakeFetch([
      ok({ AdGroups: [] }),
      ok({ AdGroups: [] }),
      ok({ AdGroups: [] }),
    ]);
    const client = createDirectClient({ token: "t", fetch });
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    await client.adGroups(ids);
    expect(calls).toHaveLength(3);
    const sizes = calls.map((c) => {
      const body = JSON.parse(c.init?.body ?? "{}") as {
        params: { SelectionCriteria: { CampaignIds: number[] } };
      };
      expect(body.params.SelectionCriteria.CampaignIds.every((id) => ids.includes(id))).toBe(true);
      return body.params.SelectionCriteria.CampaignIds.length;
    });
    expect(sizes).toEqual([10, 10, 5]);
    expect(calls[0].url).toBe("https://api.direct.yandex.com/json/v5/adgroups");
  });
});

describe("searchQueryReport", () => {
  const tsv = [
    ["Date", "CampaignId", "Query", "MatchType", "Impressions", "Clicks", "Cost"].join("\t"),
    ["2026-11-03", "100", "газоочистка купить", "--", "5", "2", "12.50"].join("\t"),
    "",
  ].join("\n");

  it("waits retryIn on 201/202 and returns parsed rows", async () => {
    const sleep = sleepRecorder();
    const { fetch, calls } = fakeFetch([
      res(201, "", { retryin: "1" }),
      res(202, "", { retryin: "2" }),
      res(200, tsv),
    ]);
    const client = createDirectClient({ token: "t", fetch, sleep: sleep.fn });
    const rows = await client.searchQueryReport({
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
      campaignIds: [100],
      reportName: "test-report",
    });
    expect(sleep.calls).toEqual([1000, 2000]);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("https://api.direct.yandex.com/json/v5/reports");
    const reqBody = JSON.parse(calls[0].init?.body ?? "{}") as {
      params: {
        ReportType: string;
        Format: string;
        SelectionCriteria: { Filter: { Values: string[] }[] };
      };
    };
    expect(reqBody.params.ReportType).toBe("SEARCH_QUERY_PERFORMANCE_REPORT");
    expect(reqBody.params.Format).toBe("TSV");
    expect(reqBody.params.SelectionCriteria.Filter[0].Values).toEqual(["100"]);
    expect(calls[0].init?.headers?.processingMode).toBe("auto");
    expect(rows).toHaveLength(1);
    expect(rows[0].MatchType).toBeNull();
    expect(rows[0].Cost).toBe(12.5);
    expect(typeof rows[0].Cost).toBe("number");
    expect(rows[0].Impressions).toBe(5);
    expect(rows[0].Query).toBe("газоочистка купить");
  });

  it("throws when the report never becomes ready", async () => {
    const sleep = sleepRecorder();
    const { fetch } = fakeFetch(Array.from({ length: 30 }, () => res(202, "", { retryin: "0" })));
    const client = createDirectClient({ token: "t", fetch, sleep: sleep.fn });
    await expect(
      client.searchQueryReport({ dateFrom: "2026-11-03", dateTo: "2026-11-03" }),
    ).rejects.toThrow("report not ready");
  });
});
