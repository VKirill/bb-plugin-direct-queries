import { describe, it, expect } from "vitest";
import type { EvaluatedPlacement } from "../placements.ts";
import { REVIEW_COLUMNS, type ReviewRow } from "../review.ts";
import { createSheetsClient, PLACEMENT_COLUMNS } from "../sheets.ts";

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const blankRow = (overrides: Partial<ReviewRow> = {}): ReviewRow => {
  const row = Object.fromEntries(REVIEW_COLUMNS.map((column) => [column, ""])) as ReviewRow;
  return {
    ...row,
    "Дата сбора": "2026-11-03",
    "Поисковый запрос": "sample query",
    "Кандидат в минус": "Да",
    Кампании: "Camp A",
    Показы: 10,
    Клики: 2,
    "Расход, ₽": "1.50",
    ...overrides,
  };
};

const creds = {
  clientId: "client_test",
  clientSecret: "secret_test",
  refreshToken: "refresh_test",
};

describe("createSheetsClient retries", () => {
  it("returns the 200 body after 429, 429, 200 with waits of 10 and 20 s", async () => {
    const waits: number[] = [];
    let apiCalls = 0;
    let lastBody: unknown;
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonRes({ access_token: "tok", expires_in: 3600 });
      }
      apiCalls += 1;
      if (apiCalls === 1) return jsonRes({ error: "rate" }, 429);
      if (apiCalls === 2) return jsonRes({ error: "rate" }, 429);
      lastBody = { sheets: [] };
      return jsonRes(lastBody);
    };
    const client = createSheetsClient({
      ...creds,
      fetch: fetchFn,
      sleep: async (seconds) => {
        waits.push(seconds);
      },
    });
    const decisions = await client.pullDecisions("sheet_test");
    expect(waits).toEqual([10, 20]);
    expect(apiCalls).toBe(3);
    expect(decisions).toEqual([]);
    expect(lastBody).toEqual({ sheets: [] });
  });

  it("honours Retry-After 3 instead of the default backoff", async () => {
    const waits: number[] = [];
    let apiCalls = 0;
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonRes({ access_token: "tok", expires_in: 3600 });
      }
      apiCalls += 1;
      if (apiCalls === 1) return jsonRes({ error: "rate" }, 429, { "Retry-After": "3" });
      return jsonRes({ sheets: [] });
    };
    const client = createSheetsClient({
      ...creds,
      fetch: fetchFn,
      sleep: async (seconds) => {
        waits.push(seconds);
      },
    });
    await client.pullDecisions("sheet_test");
    expect(waits).toEqual([3]);
  });

  it("requests an access token once for two API calls", async () => {
    let tokenCalls = 0;
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        tokenCalls += 1;
        return jsonRes({ access_token: "tok", expires_in: 3600 });
      }
      return jsonRes({ sheets: [] });
    };
    const client = createSheetsClient({
      ...creds,
      fetch: fetchFn,
      sleep: async () => {
        throw new Error("sleep should not run");
      },
      now: () => 1_000_000,
    });
    await client.pullDecisions("sheet_test");
    await client.pullDecisions("sheet_test");
    expect(tokenCalls).toBe(1);
  });
});

describe("publishDay", () => {
  it("writes nothing for an empty day", async () => {
    let calls = 0;
    const client = createSheetsClient({
      ...creds,
      fetch: async () => {
        calls += 1;
        return jsonRes({});
      },
      sleep: async () => undefined,
    });
    const result = await client.publishDay("sheet_test", "2026-11-03", []);
    expect(result).toEqual({ written: 0 });
    expect(calls).toBe(0);
  });

  it("keeps an existing «Решение клиента» for the same query", async () => {
    const existing = [
      [...REVIEW_COLUMNS],
      REVIEW_COLUMNS.map((column) => {
        if (column === "Поисковый запрос") return "sample query";
        if (column === "Решение клиента") return "В минус";
        if (column === "Комментарий клиента") return "leave this";
        if (column === "Кампании") return "Camp A";
        if (column === "Кандидат в минус") return "Нет";
        return "";
      }),
    ];
    let putBody: { values?: unknown[][] } | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonRes({ access_token: "tok", expires_in: 3600 });
      }
      if (method === "GET" && url.includes("fields=spreadsheetId")) {
        return jsonRes({
          spreadsheetId: "sheet_test",
          sheets: [{ properties: { sheetId: 7, title: "2026-11-03", index: 0 } }],
        });
      }
      if (method === "GET" && url.includes("/values/")) {
        return jsonRes({ values: existing });
      }
      if (method === "PUT" && url.includes("/values/")) {
        putBody = JSON.parse(String(init?.body ?? "{}")) as { values?: unknown[][] };
        return jsonRes({});
      }
      return jsonRes({ replies: [] });
    };
    const client = createSheetsClient({
      ...creds,
      fetch: fetchFn,
      sleep: async () => undefined,
    });
    const result = await client.publishDay("sheet_test", "2026-11-03", [
      blankRow({ "Кандидат в минус": "Да", "Решение клиента": "" }),
    ]);
    expect(result.tabId).toBe(7);
    expect(result.written).toBe(1);
    const header = putBody?.values?.[0];
    const data = putBody?.values?.[1];
    expect(header).toEqual([...REVIEW_COLUMNS]);
    const decisionIndex = REVIEW_COLUMNS.indexOf("Решение клиента");
    const commentIndex = REVIEW_COLUMNS.indexOf("Комментарий клиента");
    const queryIndex = REVIEW_COLUMNS.indexOf("Поисковый запрос");
    expect(data?.[queryIndex]).toBe("sample query");
    expect(data?.[decisionIndex]).toBe("В минус");
    expect(data?.[commentIndex]).toBe("leave this");
  });
});

describe("publishPlacements", () => {
  const placement = (over: Partial<EvaluatedPlacement> = {}): EvaluatedPlacement => ({
    campaignId: 11,
    campaign: "RSYA",
    placement: "com.example.game",
    impressions: 1000,
    clicks: 50,
    ctr: 5,
    cost: 400,
    conversions: 0,
    verdict: "exclude",
    rule: "regex /game/",
    ...over,
  });

  it("writes the Площадки header and keeps the client's «Решение»", async () => {
    const existing = [
      [...PLACEMENT_COLUMNS],
      PLACEMENT_COLUMNS.map((column) => {
        if (column === "Кампания") return "RSYA";
        if (column === "Площадка") return "com.example.game";
        if (column === "Решение") return "Оставить";
        return "";
      }),
    ];
    let putBody: { values?: unknown[][] } | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonRes({ access_token: "tok", expires_in: 3600 });
      }
      if (method === "GET" && url.includes("fields=spreadsheetId")) {
        return jsonRes({
          spreadsheetId: "sheet_test",
          sheets: [{ properties: { sheetId: 9, title: "Площадки", index: 1 } }],
        });
      }
      if (method === "GET" && url.includes("/values/")) {
        return jsonRes({ values: existing });
      }
      if (method === "PUT" && url.includes("/values/")) {
        putBody = JSON.parse(String(init?.body ?? "{}")) as { values?: unknown[][] };
        return jsonRes({});
      }
      return jsonRes({});
    };
    const client = createSheetsClient({
      ...creds,
      fetch: fetchFn,
      sleep: async () => undefined,
    });
    const result = await client.publishPlacements("sheet_test", [
      placement(),
      placement({ placement: "other.site", verdict: "watch", rule: "" }),
    ]);
    expect(result.written).toBe(2);
    expect(putBody?.values?.[0]).toEqual([...PLACEMENT_COLUMNS]);
    const decisionIndex = PLACEMENT_COLUMNS.indexOf("Решение");
    const placementIndex = PLACEMENT_COLUMNS.indexOf("Площадка");
    const gameRow = putBody?.values?.find((row) => row[placementIndex] === "com.example.game");
    expect(gameRow?.[decisionIndex]).toBe("Оставить");
    expect(result.decisions).toContainEqual({
      campaignId: 11,
      placement: "com.example.game",
      decision: "keep",
    });
  });
});

describe("pullDecisions", () => {
  it("maps «В минус» to minus and «Оставить» to keep", async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonRes({ access_token: "tok", expires_in: 3600 });
      }
      if (method === "GET" && url.includes("fields=spreadsheetId")) {
        return jsonRes({
          spreadsheetId: "sheet_test",
          sheets: [{ properties: { sheetId: 7, title: "2026-11-03", index: 0 } }],
        });
      }
      return jsonRes({
        values: [
          [...REVIEW_COLUMNS],
          REVIEW_COLUMNS.map((column) => {
            if (column === "Поисковый запрос") return "minus query";
            if (column === "Решение клиента") return "В минус";
            if (column === "Кампании") return "Camp A";
            if (column === "Комментарий клиента") return "drop it";
            return "";
          }),
          REVIEW_COLUMNS.map((column) => {
            if (column === "Поисковый запрос") return "keep query";
            if (column === "Решение клиента") return "Оставить";
            if (column === "Кампании") return "Camp B";
            return "";
          }),
        ],
      });
    };
    const client = createSheetsClient({
      ...creds,
      fetch: fetchFn,
      sleep: async () => undefined,
    });
    const decisions = await client.pullDecisions("sheet_test");
    expect(decisions).toEqual([
      {
        query: "minus query",
        campaign: "Camp A",
        decision: "minus",
        comment: "drop it",
        date: "2026-11-03",
      },
      {
        query: "keep query",
        campaign: "Camp B",
        decision: "keep",
        comment: "",
        date: "2026-11-03",
      },
    ]);
  });
});
