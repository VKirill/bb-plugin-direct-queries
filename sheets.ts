import { REVIEW_COLUMNS, type ReviewRow } from "./review.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const RETRY_DELAYS = [10, 20, 40, 80];
const RETRY_AFTER_LIMIT = 120;
const MAX_ATTEMPTS = 4;
const DATE_TAB = /^\d{4}-\d{2}-\d{2}$/;

export type SheetsFetch = typeof fetch;
export type SheetsSleep = (seconds: number) => Promise<void>;
export type SheetsNow = () => number;

export type CreateSheetsClientInput = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch: SheetsFetch;
  sleep?: SheetsSleep;
  now?: SheetsNow;
};

export type ClientDecision = {
  query: string;
  campaign: string;
  decision: "minus" | "keep";
  comment: string;
  date: string;
};

export type PublishDayResult = {
  tabId?: number;
  written: number;
};

type SheetProps = { sheetId: number; title: string; index?: number };

const defaultSleep: SheetsSleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const encodeRange = (range: string): string => encodeURIComponent(range);

const isDateTab = (title: string): boolean => DATE_TAB.test(title);

const retryAfterSeconds = (headers: Headers, fallback: number): number => {
  const raw = headers.get("Retry-After");
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(parsed, RETRY_AFTER_LIMIT);
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const queryKey = (query: string): string => query.trim().toLowerCase();

const toInt = (value: string | number): number => {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
};

const toFloatOrEmpty = (value: string | number): number | "" => {
  if (value === "" || value === undefined) return "";
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : "";
};

const rowToValues = (row: ReviewRow): (string | number)[] =>
  REVIEW_COLUMNS.map((column) => row[column]);

const valuesToRow = (headers: string[], cells: unknown[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    out[headers[i]] = cells[i] === undefined || cells[i] === null ? "" : String(cells[i]);
  }
  return out;
};

const colLetter = (index: number): string => {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const fill = (
  sheetId: number,
  row: number,
  start: number,
  end: number,
  color: { red: number; green: number; blue: number },
) => ({
  repeatCell: {
    range: {
      sheetId,
      startRowIndex: row,
      endRowIndex: row + 1,
      startColumnIndex: start,
      endColumnIndex: end,
    },
    cell: { userEnteredFormat: { backgroundColor: color } },
    fields: "userEnteredFormat.backgroundColor",
  },
});

export const createSheetsClient = (input: CreateSheetsClientInput) => {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | undefined;

  const retryJson = async (url: string, init: RequestInit): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await input.fetch(url, init);
        if (response.status === 429 || response.status >= 500) {
          const body = await response.text();
          lastError = new Error(`Google Sheets HTTP ${response.status}: ${body.slice(0, 500)}`);
          if (attempt >= MAX_ATTEMPTS - 1) break;
          const fallback = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
          await sleep(retryAfterSeconds(response.headers, fallback));
          continue;
        }
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Google Sheets HTTP ${response.status}: ${body.slice(0, 500)}`);
        }
        return readJson(response);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.startsWith("Google Sheets HTTP ")) {
          const code = Number(error.message.slice("Google Sheets HTTP ".length).split(":")[0]);
          if (code !== 429 && !(code >= 500)) throw error;
        }
        if (attempt >= MAX_ATTEMPTS - 1) break;
        await sleep(RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1]);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Google Sheets: ${String(lastError)}`);
  };

  const getToken = async (): Promise<string> => {
    const t = now();
    if (cached && t < cached.expiresAt) return cached.token;
    const body = asRecord(
      await retryJson(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          refresh_token: input.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      }),
    );
    const token = String(body.access_token ?? "");
    const expiresIn = Number(body.expires_in) || 3600;
    cached = { token, expiresAt: t + expiresIn * 1000 - 30_000 };
    return token;
  };

  const api = async (method: string, path: string, payload?: unknown): Promise<unknown> => {
    const token = await getToken();
    return retryJson(`${SHEETS_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  };

  const drive = async (method: string, url: string, payload?: unknown): Promise<unknown> => {
    const token = await getToken();
    return retryJson(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  };

  const metadata = async (sheetId: string): Promise<{ tabs: Map<string, SheetProps>; sheets: SheetProps[] }> => {
    const body = asRecord(
      await api("GET", `/${sheetId}?fields=spreadsheetId,sheets(properties(sheetId,title,index))`),
    );
    const sheets: SheetProps[] = [];
    const list = Array.isArray(body.sheets) ? body.sheets : [];
    for (const item of list) {
      const props = asRecord(asRecord(item).properties);
      sheets.push({
        sheetId: Number(props.sheetId),
        title: String(props.title ?? ""),
        index: Number(props.index ?? 0),
      });
    }
    return { sheets, tabs: new Map(sheets.map((tab) => [tab.title, tab])) };
  };

  const sheetRows = async (
    sheetId: string,
    title: string,
  ): Promise<{ headers: string[]; byQuery: Map<string, Record<string, string>>; ordered: Record<string, string>[] }> => {
    const body = asRecord(await api("GET", `/${sheetId}/values/${encodeRange(`'${title}'!A1:Z`)}`));
    const values = Array.isArray(body.values) ? (body.values as unknown[][]) : [];
    if (values.length === 0) return { headers: [], byQuery: new Map(), ordered: [] };
    const headers = values[0].map((cell) => String(cell));
    const queryIndex = headers.indexOf("Поисковый запрос");
    const byQuery = new Map<string, Record<string, string>>();
    const ordered: Record<string, string>[] = [];
    for (const raw of values.slice(1)) {
      if (queryIndex < 0 || raw.length <= queryIndex || !raw[queryIndex]) continue;
      const row = valuesToRow(headers, raw);
      const key = queryKey(row["Поисковый запрос"] ?? "");
      if (!key) continue;
      byQuery.set(key, row);
      ordered.push(row);
    }
    return { headers, byQuery, ordered };
  };

  const formatTab = async (sheetId: string, tabId: number, values: (string | number)[][]) => {
    const numberCols = ["Ср. позиция показа", "Ср. позиция клика"] as const;
    const moneyCols = ["Расход, ₽", "Цена клика, ₽"] as const;
    await api("POST", `/${sheetId}:batchUpdate`, {
      requests: [
        ...numberCols.map((name) => ({
          repeatCell: {
            range: {
              sheetId: tabId,
              startRowIndex: 1,
              startColumnIndex: REVIEW_COLUMNS.indexOf(name),
              endColumnIndex: REVIEW_COLUMNS.indexOf(name) + 1,
            },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0.00" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        })),
        ...moneyCols.map((name) => ({
          repeatCell: {
            range: {
              sheetId: tabId,
              startRowIndex: 1,
              startColumnIndex: REVIEW_COLUMNS.indexOf(name),
              endColumnIndex: REVIEW_COLUMNS.indexOf(name) + 1,
            },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        })),
      ],
    });
    const rivalColumn = REVIEW_COLUMNS.indexOf("Есть конкуренты");
    const candidateColumn = REVIEW_COLUMNS.indexOf("Кандидат в минус");
    const colors: unknown[] = [
      {
        repeatCell: {
          range: { sheetId: tabId, startRowIndex: 1 },
          cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
          fields: "userEnteredFormat.backgroundColor",
        },
      },
    ];
    for (let index = 0; index < values.length; index++) {
      const row = values[index];
      const rivals = String(row[rivalColumn] ?? "");
      const candidate = String(row[candidateColumn] ?? "");
      if (rivals.startsWith("Да")) {
        colors.push(fill(tabId, index + 1, rivalColumn, rivalColumn + 1, { red: 0.72, green: 0.88, blue: 0.72 }));
      } else if (rivals === "Нет" && candidate === "Да") {
        colors.push(fill(tabId, index + 1, 0, REVIEW_COLUMNS.length, { red: 0.96, green: 0.8, blue: 0.8 }));
      }
    }
    colors.push({
      setBasicFilter: {
        filter: {
          range: {
            sheetId: tabId,
            startRowIndex: 0,
            endRowIndex: values.length + 1,
            startColumnIndex: 0,
            endColumnIndex: REVIEW_COLUMNS.length,
          },
        },
      },
    });
    await api("POST", `/${sheetId}:batchUpdate`, { requests: colors });
    await api("POST", `/${sheetId}:batchUpdate`, {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId: tabId,
              startRowIndex: 1,
              startColumnIndex: REVIEW_COLUMNS.indexOf("Решение клиента"),
              endColumnIndex: REVIEW_COLUMNS.indexOf("Решение клиента") + 1,
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "В минус" },
                  { userEnteredValue: "Оставить" },
                  { userEnteredValue: "Не уверен" },
                ],
              },
              strict: true,
              showCustomUi: true,
            },
          },
        },
      ],
    });
  };

  const publishDay = async (
    sheetId: string,
    date: string,
    rows: ReviewRow[],
  ): Promise<PublishDayResult> => {
    if (rows.length === 0) return { written: 0 };
    const { tabs } = await metadata(sheetId);
    let tabId = tabs.get(date)?.sheetId;
    let existing = new Map<string, Record<string, string>>();
    if (tabId === undefined) {
      const reply = asRecord(
        await api("POST", `/${sheetId}:batchUpdate`, {
          requests: [
            {
              addSheet: {
                properties: {
                  title: date,
                  index: 0,
                  gridProperties: { frozenRowCount: 1 },
                },
              },
            },
          ],
        }),
      );
      const replies = Array.isArray(reply.replies) ? reply.replies : [];
      const added = asRecord(asRecord(asRecord(replies[0]).addSheet).properties);
      tabId = Number(added.sheetId);
    } else {
      existing = (await sheetRows(sheetId, date)).byQuery;
      await api("POST", `/${sheetId}:batchUpdate`, {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: tabId, index: 0 },
              fields: "index",
            },
          },
        ],
      });
    }
    const decisionIndex = REVIEW_COLUMNS.indexOf("Решение клиента");
    const commentIndex = REVIEW_COLUMNS.indexOf("Комментарий клиента");
    const candidateIndex = REVIEW_COLUMNS.indexOf("Кандидат в минус");
    const minusIndex = REVIEW_COLUMNS.indexOf("Предлагаемый минус");
    const sourceIndex = REVIEW_COLUMNS.indexOf("Источник предложения");
    const queryIndex = REVIEW_COLUMNS.indexOf("Поисковый запрос");
    const clicksIndex = REVIEW_COLUMNS.indexOf("Клики");
    const impressionsIndex = REVIEW_COLUMNS.indexOf("Показы");
    const values = rows.map((row) => {
      const cells = rowToValues(row);
      const old = existing.get(queryKey(String(cells[queryIndex] ?? "")));
      cells[decisionIndex] = old?.["Решение клиента"] || cells[decisionIndex] || "";
      cells[commentIndex] = old?.["Комментарий клиента"] ?? cells[commentIndex] ?? "";
      if (cells[decisionIndex] === "Оставить") {
        cells[candidateIndex] = "Нет";
        cells[minusIndex] = "";
        cells[sourceIndex] = "";
      }
      cells[impressionsIndex] = toInt(cells[impressionsIndex]);
      cells[clicksIndex] = toInt(cells[clicksIndex]);
      for (const name of ["Ср. позиция показа", "Ср. позиция клика", "Расход, ₽", "Цена клика, ₽"] as const) {
        const i = REVIEW_COLUMNS.indexOf(name);
        const converted = toFloatOrEmpty(cells[i]);
        if (converted !== "") cells[i] = converted;
      }
      return cells;
    });
    values.sort(
      (a, b) =>
        Number(a[candidateIndex] === "Нет") - Number(b[candidateIndex] === "Нет") ||
        toInt(b[clicksIndex]) - toInt(a[clicksIndex]) ||
        toInt(b[impressionsIndex]) - toInt(a[impressionsIndex]),
    );
    if (existing.size > 0) {
      await api("POST", `/${sheetId}/values/${encodeRange(`'${date}'!A2:Z`)}:clear`, {});
    }
    await api("PUT", `/${sheetId}/values/${encodeRange(`'${date}'!A1`)}?valueInputOption=RAW`, {
      values: [REVIEW_COLUMNS.slice(), ...values],
    });
    await formatTab(sheetId, tabId, values);
    return { tabId, written: values.length };
  };

  const pullDecisions = async (sheetId: string): Promise<ClientDecision[]> => {
    const { sheets } = await metadata(sheetId);
    const byQuery = new Map<string, ClientDecision>();
    for (const tab of [...sheets].sort((a, b) => a.title.localeCompare(b.title))) {
      if (!isDateTab(tab.title)) continue;
      const { ordered } = await sheetRows(sheetId, tab.title);
      for (const row of ordered) {
        const query = (row["Поисковый запрос"] ?? "").trim();
        const label = (row["Решение клиента"] ?? "").trim();
        if (!query) continue;
        if (label !== "В минус" && label !== "Оставить") continue;
        byQuery.set(queryKey(query), {
          query,
          campaign: (row["Кампании"] ?? "").trim(),
          decision: label === "В минус" ? "minus" : "keep",
          comment: (row["Комментарий клиента"] ?? "").trim(),
          date: tab.title,
        });
      }
    }
    return [...byQuery.values()];
  };

  const shareByLink = async (sheetId: string): Promise<void> => {
    const url = `${DRIVE_API}/${sheetId}/permissions`;
    const body = asRecord(await drive("GET", `${url}?fields=permissions(id,type,role,allowFileDiscovery)`));
    const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    const current = permissions
      .map((item) => asRecord(item))
      .find((item) => item.type === "anyone");
    if (current) {
      if (current.role === "writer" && !current.allowFileDiscovery) return;
      await drive("PATCH", `${url}/${String(current.id)}`, {
        role: "writer",
        allowFileDiscovery: false,
      });
      return;
    }
    await drive("POST", url, {
      type: "anyone",
      role: "writer",
      allowFileDiscovery: false,
    });
  };

  const refreshLibraryColumn = async (
    sheetId: string,
    inLibrary: (query: string) => boolean,
  ): Promise<void> => {
    const { sheets } = await metadata(sheetId);
    for (const tab of sheets) {
      if (!isDateTab(tab.title)) continue;
      const { headers, ordered } = await sheetRows(sheetId, tab.title);
      const column = headers.indexOf("В библиотеке");
      if (column < 0) continue;
      const values = ordered.map((row) => {
        const query = row["Поисковый запрос"] ?? "";
        try {
          return [inLibrary(query) ? "да" : "нет"];
        } catch {
          return [""];
        }
      });
      if (values.length === 0) continue;
      const letter = colLetter(column);
      await api(
        "PUT",
        `/${sheetId}/values/${encodeRange(`'${tab.title}'!${letter}2`)}?valueInputOption=RAW`,
        { values },
      );
    }
  };

  return { publishDay, pullDecisions, shareByLink, refreshLibraryColumn };
};
