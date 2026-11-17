import { describe, expect, it } from "vitest";
import { build, WEEKLY_TREE_HEADER, type WeeklyTreeRow } from "../../weekly-tree.ts";
import { WEEKLY_TREE_TAB } from "../../sheets.ts";
import { liveSheets, requireEnv } from "./helpers.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const META_FIELDS =
  "sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),rowGroups)";

type TreeGroup = { start: number; end: number; depth: number };

const sheetsToken = async (): Promise<string> => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_SHEETS_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_SHEETS_CLIENT_SECRET"),
      refresh_token: requireEnv("GOOGLE_SHEETS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`sheets token ${res.status}`);
  return body.access_token;
};

const sheetsGet = async (token: string, sheetId: string, path: string): Promise<Record<string, unknown>> => {
  const res = await fetch(`${SHEETS_API}/${sheetId}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sheets GET ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Record<string, unknown>;
};

const tabRowGroups = (meta: Record<string, unknown>): TreeGroup[] => {
  const sheets = Array.isArray(meta.sheets) ? (meta.sheets as Record<string, unknown>[]) : [];
  const tab = sheets.find(
    (entry) => (entry.properties as Record<string, unknown> | undefined)?.title === WEEKLY_TREE_TAB,
  );
  const groups = Array.isArray(tab?.rowGroups) ? (tab.rowGroups as Record<string, unknown>[]) : [];
  return groups.map((group) => {
    const range = (group.range ?? {}) as Record<string, unknown>;
    return {
      start: Number(range.startIndex),
      end: Number(range.endIndex),
      depth: Number(group.depth ?? 0),
    };
  });
};

const byRange = (groups: TreeGroup[]): TreeGroup[] =>
  [...groups].sort((a, b) => a.start - b.start || a.end - b.end || a.depth - b.depth);

const row = (
  date: string,
  CampaignName: string,
  Query: string,
  Impressions: number,
  Clicks: number,
  Cost: number,
  AvgImpressionPosition: number | null,
  AvgClickPosition: number | null,
): WeeklyTreeRow => ({
  date,
  CampaignName,
  Query,
  Impressions,
  Clicks,
  Cost,
  AvgImpressionPosition,
  AvgClickPosition,
});

// 2 weeks × 2 campaigns × 2 queries; the second query of each campaign in a
// week spends nothing and lands on the «без расхода» line.
const bigRows: WeeklyTreeRow[] = [
  row("2026-11-02", "Camp A", "Query One", 100, 10, 100, 2, 1),
  row("2026-11-03", "Camp A", "Query Two", 50, 5, 50, 4, 3),
  row("2026-11-04", "Camp B", "Query Three", 200, 20, 200, 6, 5),
  row("2026-11-05", "Camp B", "Query Four", 40, 0, 0, null, null),
  row("2026-11-09", "Camp A", "Query One", 80, 8, 80, 3, 2),
  row("2026-11-10", "Camp A", "Query Two", 60, 6, 60, 5, 4),
  row("2026-11-11", "Camp B", "Query Three", 120, 12, 120, 7, 6),
  row("2026-11-12", "Camp B", "Query Four", 30, 0, 0, null, null),
];

const smallRows: WeeklyTreeRow[] = [
  row("2026-11-16", "Camp A", "Query One", 10, 1, 5, 2, 2),
];

describe("weekly tree on the scratch sheet", () => {
  it("publishes a fixture tree, then a smaller one, and the tab matches", async () => {
    const { client, sheetId } = liveSheets();
    const token = await sheetsToken();

    const big = build(bigRows);
    await client.publishWeeklyTree(
      sheetId,
      big.header,
      big.lines.map((line) => line.values),
      big.groups,
    );

    const afterBig = await sheetsGet(
      token,
      sheetId,
      `?fields=${encodeURIComponent(META_FIELDS)}`,
    );
    expect(tabRowGroups(afterBig).length).toBeGreaterThan(0);

    const small = build(smallRows);
    await client.publishWeeklyTree(
      sheetId,
      small.header,
      small.lines.map((line) => line.values),
      small.groups,
    );

    const values = await sheetsGet(
      token,
      sheetId,
      `/values/${encodeURIComponent(`'${WEEKLY_TREE_TAB}'!A1:O10`)}`,
    );
    const grid = (values.values ?? []) as unknown[][];
    expect(grid[0]).toEqual([...WEEKLY_TREE_HEADER]);
    expect(grid.length).toBe(small.lines.length + 1);

    const afterSmall = await sheetsGet(
      token,
      sheetId,
      `?fields=${encodeURIComponent(META_FIELDS)}`,
    );
    expect(byRange(tabRowGroups(afterSmall))).toEqual(byRange(small.groups));
  });
});
