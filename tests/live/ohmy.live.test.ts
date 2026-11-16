import { describe, expect, it } from "vitest";
import type { DirectTransport } from "../../direct.ts";
import { liveDirect, liveGuard, liveReportRows, liveSheets, pastDay } from "./helpers.ts";

describe("ohmy live account (read-only)", () => {
  it("campaigns() returns at least one campaign", async () => {
    const { client } = liveDirect();
    const campaigns = await client.campaigns();
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
  });

  it("a 30-day CUSTOM_REPORT of Date, Cost, Clicks parses into rows with ruble costs", async () => {
    const { transport } = liveDirect();
    const fields = ["Date", "Cost", "Clicks"];
    const rows = await liveReportRows(
      transport,
      {
        SelectionCriteria: { DateFrom: pastDay(30), DateTo: pastDay(1) },
        FieldNames: fields,
        ReportName: `live ohmy check ${Date.now()}`,
        ReportType: "CUSTOM_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "YES",
        IncludeDiscount: "NO",
      },
      fields,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    let cost = 0;
    let clicks = 0;
    for (const row of rows) {
      expect(row.Date).not.toBe("Date");
      expect(String(row.Date ?? "")).not.toMatch(/^"/);
      expect(typeof row.Cost).toBe("number");
      cost += Number(row.Cost);
      clicks += Number(row.Clicks);
    }
    expect(clicks === 0 ? 0 : cost / clicks).toBeLessThan(100_000);
  });

  it("changes.checkCampaigns returns a Timestamp string", async () => {
    const { transport } = liveDirect();
    const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19) + "Z";
    const res = (await transport.call("changes", "checkCampaigns", {
      Timestamp: since,
    })) as { Timestamp?: unknown };
    expect(typeof res.Timestamp).toBe("string");
    expect(res.Timestamp).toBeTruthy();
  });

  it("liveGuard blocks writes before any request is sent", async () => {
    let sent = 0;
    const inner: DirectTransport = {
      call: async () => {
        sent += 1;
        return {};
      },
      report: async () => {
        sent += 1;
        return "";
      },
    };
    const guarded = liveGuard(inner);
    await expect(guarded.call("campaigns", "update", {})).rejects.toThrow(
      "live guard: write blocked campaigns.update",
    );
    expect(sent).toBe(0);
    await guarded.call("campaigns", "get", {});
    await guarded.call("changes", "checkCampaigns", {});
    await guarded.report({});
    expect(sent).toBe(3);
  });

  it("liveSheets() reads the scratch sheet metadata", async () => {
    const sheets = liveSheets();
    await sheets.client.pullDecisions(sheets.sheetId);
    const meta = sheets.metadata() as
      | { sheets?: { properties?: { title?: unknown } }[] }
      | undefined;
    const titles = (meta?.sheets ?? []).map((sheet) => sheet.properties?.title);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles[0]).toBeTruthy();
  });
});
