import { describe, expect, it } from "vitest";
import type { AccountRow } from "../../db.ts";
import { fixturePipelineProject } from "../fixtures/projects.ts";
import type { Project } from "../../model.ts";
import {
  runStatsSheet,
  STATS_CORRECTIONS_TAB,
  STATS_DYNAMICS_TAB,
  STATS_HEADER,
  STATS_TAB,
  type StatsSheetDeps,
} from "../../stats-sheet.ts";
import { liveDirect, liveReportRows, liveSheets, pastDay } from "./helpers.ts";

const account: AccountRow = {
  id: "live",
  login: "live",
  isAgency: false,
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
  createdAt: 0,
  source: "ohmyseo",
};

describe("stats sheet live", () => {
  it("runStatsSheet fills the stats tab for a past day exactly once", async () => {
    const sheets = liveSheets();
    const { client: direct, transport } = liveDirect();
    const { tabs } = await sheets.client.metadata(sheets.sheetId);
    for (const title of [STATS_TAB, STATS_DYNAMICS_TAB, STATS_CORRECTIONS_TAB]) {
      const tab = tabs.get(title);
      if (tab) {
        await sheets.client.batchUpdate(sheets.sheetId, [
          { deleteSheet: { sheetId: tab.sheetId } },
        ]);
      }
    }
    const base = fixturePipelineProject();
    const project: Project = {
      ...base,
      pipeline: {
        ...base.pipeline!,
        stats: { enabled: true, sheetId: sheets.sheetId },
      },
    };
    const deps: StatsSheetDeps = {
      now: () => Date.now(),
      getAccount: () => account,
      ensureFresh: async (a) => a,
      keywordReport: async ({ dateFrom, dateTo, campaignIds }) =>
        direct.keywordReport({ dateFrom, dateTo, campaignIds }),
      sheets: async () => sheets.client,
    };
    const spend = await liveReportRows(
      transport,
      {
        SelectionCriteria: { DateFrom: pastDay(10), DateTo: pastDay(1) },
        FieldNames: ["Date", "Cost"],
        ReportName: `direct-queries live stats day ${Date.now()}`,
        ReportType: "CUSTOM_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "YES",
        IncludeDiscount: "NO",
      },
      ["Date", "Cost"],
    );
    const day = spend
      .filter((row) => Number(row.Cost) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(row.Date)))
      .map((row) => String(row.Date))
      .sort()
      .at(-1);
    if (!day) {
      throw new Error("no account spend in the last 10 days");
    }
    const first = await runStatsSheet(deps, project, day, {
      trigger: "schedule",
      runId: "live-stats-1",
      attempt: 1,
    });
    expect(first[0].status, first[0].firstError).toBe("ok");
    const values = await sheets.client.readValues(sheets.sheetId, `'${STATS_TAB}'!A1:K`);
    expect(values[0]).toEqual([...STATS_HEADER]);
    const dayRows = values.slice(1).filter((row) => String(row[0]) === day);
    expect(dayRows.length).toBeGreaterThanOrEqual(1);
    const costIndex = STATS_HEADER.indexOf("Расход, ₽");
    for (const row of dayRows) {
      const cost = Number(row[costIndex]);
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeLessThan(1_000_000);
    }
    const count = values.length;
    const second = await runStatsSheet(deps, project, day, {
      trigger: "schedule",
      runId: "live-stats-2",
      attempt: 1,
    });
    expect(second[0].status, second[0].firstError).toBe("ok");
    const after = await sheets.client.readValues(sheets.sheetId, `'${STATS_TAB}'!A1:K`);
    expect(after.length).toBe(count);
  });
});
