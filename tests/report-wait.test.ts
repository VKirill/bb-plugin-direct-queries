import { describe, expect, it } from "vitest";
import {
  createDirectClient,
  DirectApiError,
  REPORT_WAIT_BUDGET_MS,
  type DirectTransport,
} from "../direct.ts";
import { createOhmyClient, OHMY_CALL_TIMEOUT_MS, OhmyError } from "../ohmyseo.ts";
import type { FetchFn, HttpResponse } from "../yandex-oauth.ts";

const res = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function fakeFetch(responses: HttpResponse[]) {
  const calls: { url: string; init?: { body?: string } }[] = [];
  const queue = [...responses];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  };
  return { fetch, calls };
}

const captureTransport = () => {
  const seen: { ReportName?: unknown }[] = [];
  const transport: DirectTransport = {
    call: async () => ({}),
    report: async (params) => {
      seen.push(params as { ReportName?: unknown });
      return "";
    },
  };
  return { transport, seen };
};

describe("stable report names", () => {
  it("searchQueryReport reuses one ReportName for identical args and varies it with params", async () => {
    const { transport, seen } = captureTransport();
    let clock = 1234567890123;
    const client = createDirectClient({ transport, now: () => clock });
    const args = { dateFrom: "2026-11-10", dateTo: "2026-11-10", campaignIds: [5, 2] };
    await client.searchQueryReport(args);
    clock = 1;
    await client.searchQueryReport({ ...args });
    await client.searchQueryReport({ ...args, campaignIds: [2, 5] });
    await client.searchQueryReport({ ...args, dateTo: "2026-11-11" });
    await client.searchQueryReport({ ...args, campaignIds: [5, 3] });
    await client.searchQueryReport({ dateFrom: args.dateFrom, dateTo: args.dateTo });
    const names = seen.map((p) => String(p.ReportName));
    expect(names).toHaveLength(6);
    expect(names[0]).toBe(names[1]);
    expect(names[2]).toBe(names[0]);
    expect(new Set([names[0], names[3], names[4], names[5]]).size).toBe(4);
    for (const name of names) expect(name).not.toContain("1234567890");
  });

  it("placementsReport, keywordReport and performanceReport derive ReportName from params only", async () => {
    const { transport, seen } = captureTransport();
    let clock = 1234567890123;
    const client = createDirectClient({ transport, now: () => clock });
    const args = { dateFrom: "2026-11-10", dateTo: "2026-11-10", campaignIds: [7] };
    await client.placementsReport(args);
    clock = 1;
    await client.placementsReport({ ...args });
    await client.keywordReport(args);
    await client.keywordReport({ ...args });
    await client.keywordReport({ ...args, fields: ["Criterion", "Impressions"] });
    await client.performanceReport({ dateFrom: args.dateFrom, dateTo: args.dateTo });
    await client.performanceReport({
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      goals: [42],
    });
    await client.performanceReport({
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      goals: [42],
    });
    const names = seen.map((p) => String(p.ReportName));
    expect(names).toHaveLength(8);
    expect(names[0]).toBe(names[1]);
    expect(names[2]).toBe(names[3]);
    expect(names[4]).not.toBe(names[2]);
    expect(names[5]).not.toBe(names[6]);
    expect(names[6]).toBe(names[7]);
    for (const name of names) expect(name).not.toContain("1234567890");
  });

  it("args.reportName still wins", async () => {
    const { transport, seen } = captureTransport();
    const client = createDirectClient({ transport });
    await client.searchQueryReport({
      dateFrom: "2026-11-10",
      dateTo: "2026-11-10",
      reportName: "custom-name",
    });
    expect(seen[0].ReportName).toBe("custom-name");
  });
});

describe("bounded report wait", () => {
  it("throws 'report not ready' at REPORT_WAIT_BUDGET_MS with at most 4 transport calls", async () => {
    expect(REPORT_WAIT_BUDGET_MS).toBe(240_000);
    let clock = 0;
    const seen: { ReportName?: unknown }[] = [];
    const transport: DirectTransport = {
      call: async () => ({}),
      report: async (params) => {
        seen.push(params as { ReportName?: unknown });
        clock += 87_000;
        throw new DirectApiError(202, "report pending");
      },
    };
    const client = createDirectClient({
      transport,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const err = await client
      .searchQueryReport({ dateFrom: "2026-11-10", dateTo: "2026-11-10" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DirectApiError);
    expect((err as DirectApiError).message).toBe("report not ready");
    expect((err as DirectApiError).detail).toContain(String(seen[0].ReportName));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it("the HTTP transport stops at the same budget before MAX_REPORT_TRIES", async () => {
    let clock = 0;
    const { fetch, calls } = fakeFetch(
      Array.from({ length: 30 }, () => res(202, "", { retryin: "10" })),
    );
    const client = createDirectClient({
      token: "t",
      fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const err = await client
      .searchQueryReport({ dateFrom: "2026-11-10", dateTo: "2026-11-10" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DirectApiError);
    expect((err as DirectApiError).message).toBe("report not ready");
    expect(calls.length).toBeLessThanOrEqual(25);
  });
});

describe("ohmyseo call timeout", () => {
  it("createOhmyClient with timeoutMs throws OhmyError 'timeout' on abort", async () => {
    expect(OHMY_CALL_TIMEOUT_MS).toBe(150_000);
    const fetch: FetchFn = (_url, init) =>
      new Promise<HttpResponse>((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (!signal) {
          reject(new Error("fetch init has no abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = createOhmyClient({ auth: "x", fetch, timeoutMs: 50 });
    const err = await client.callTool("list_accounts", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OhmyError);
    expect((err as Error).message).toContain("timeout");
  });
});
