import { describe, expect, it } from "vitest";
import { runAnalytics } from "../../analytics.ts";
import { liveDirect, liveReportRows, pastDay } from "./helpers.ts";

const SPEND_FIELDS = ["Date", "Cost"];

describe("analytics live account (read-only)", () => {
  it(
    "runAnalytics over the last 30 days resolves with totals and one row per spending day",
    { timeout: 1_400_000 },
    async () => {
      const { client, transport } = liveDirect();
      const from = pastDay(30);
      const to = pastDay(1);
      const result = await runAnalytics(client, { from, to });
      expect(result.summary.totals.cost).toBeGreaterThan(0);
      expect(result.summary.totals.clicks).toBeGreaterThan(0);
      expect(result.summary.totals.cost / result.summary.totals.clicks).toBeLessThan(100_000);

      const dates = result.summary.byDay.map((row) => row.date);
      expect(dates.length).toBeGreaterThanOrEqual(1);
      expect(new Set(dates).size).toBe(dates.length);
      for (const date of dates) {
        expect(date >= from && date <= to).toBe(true);
      }

      const spendRows = await liveReportRows(
        transport,
        {
          SelectionCriteria: { DateFrom: from, DateTo: to },
          FieldNames: SPEND_FIELDS,
          ReportName: `live analytics days ${Date.now()}`,
          ReportType: "CUSTOM_REPORT",
          DateRangeType: "CUSTOM_DATE",
          Format: "TSV",
          IncludeVAT: "YES",
          IncludeDiscount: "NO",
        },
        SPEND_FIELDS,
      );
      const spendDates = new Set(
        spendRows.filter((row) => Number(row.Cost) > 0).map((row) => String(row.Date)),
      );
      expect(spendDates.size).toBeGreaterThan(0);
      expect(
        new Set(result.summary.byDay.filter((row) => row.cost > 0).map((row) => row.date)),
      ).toEqual(spendDates);

      expect(result.goals.every((goal) => typeof goal === "number")).toBe(true);
      if (result.goals.length > 0) {
        expect(result.summary.byGoal).toHaveLength(result.goals.length);
        expect(result.summary.byGoal.map((row) => row.goalId)).toEqual(result.goals);
      }
    },
  );
});
