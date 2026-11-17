import { beforeAll, describe, expect, it } from "vitest";
import {
  createDirectClient,
  DirectApiError,
  type DirectTransport,
} from "../../direct.ts";
import { liveDirect, liveReportRows, pastDay } from "./helpers.ts";

const SPEND_FIELDS = ["Date", "Cost"];

describe("direct report wait live (read-only)", () => {
  let spendDay: string | undefined;

  beforeAll(async () => {
    const { transport } = liveDirect();
    const from = pastDay(10);
    const to = pastDay(1);
    const spend = await liveReportRows(
      transport,
      {
        SelectionCriteria: { DateFrom: from, DateTo: to },
        FieldNames: SPEND_FIELDS,
        ReportName: `direct-queries live report-wait ${from}_${to}`,
        ReportType: "CUSTOM_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "YES",
        IncludeDiscount: "NO",
      },
      SPEND_FIELDS,
    );
    spendDay = spend
      .filter(
        (row) =>
          Number(row.Cost) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(row.Date)),
      )
      .map((row) => String(row.Date))
      .sort()
      .at(-1);
    if (!spendDay) throw new Error("no account spend in the last 10 days");
  }, 1_000_000);

  it("searchQueryReport returns rows or 'report not ready' within 420 s", async () => {
    const { client } = liveDirect();
    const started = Date.now();
    let failure: unknown;
    try {
      await client.searchQueryReport({ dateFrom: spendDay!, dateTo: spendDay! });
    } catch (e) {
      failure = e;
    }
    expect(Date.now() - started).toBeLessThan(420_000);
    if (failure !== undefined) {
      expect(failure).toBeInstanceOf(DirectApiError);
      expect((failure as DirectApiError).message).toBe("report not ready");
    }
  });

  it("two identical keywordReport calls carry the same ReportName and row count", async () => {
    const { transport } = liveDirect();
    const names: unknown[] = [];
    const recording: DirectTransport = {
      call: (service, method, params) => transport.call(service, method, params),
      report: async (params) => {
        names.push((params as { ReportName?: unknown }).ReportName);
        return transport.report(params);
      },
    };
    const client = createDirectClient({ transport: recording });
    const args = { dateFrom: spendDay!, dateTo: spendDay! };
    const first = await client.keywordReport(args);
    const second = await client.keywordReport(args);
    expect(names).toHaveLength(2);
    expect(typeof names[0]).toBe("string");
    expect(names[0]).toBe(names[1]);
    expect(second).toHaveLength(first.length);
  });
});
