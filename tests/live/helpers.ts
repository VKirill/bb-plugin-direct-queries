import { createOhmyClient, ohmyDirectTransport } from "../../ohmyseo.ts";
import { createDirectClient, DirectApiError } from "../../direct.ts";
import type { DirectClient, DirectTransport, SearchQueryRow } from "../../direct.ts";
import { createSheetsClient } from "../../sheets.ts";
import type { SheetsFetch } from "../../sheets.ts";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export function liveGuard(inner: DirectTransport): DirectTransport {
  return {
    call(service, method, params) {
      if (method !== "get" && service !== "changes") {
        return Promise.reject(new Error(`live guard: write blocked ${service}.${method}`));
      }
      return inner.call(service, method, params);
    },
    report(params) {
      return inner.report(params);
    },
  };
}

export interface LiveDirect {
  client: DirectClient;
  transport: DirectTransport;
}

export function liveDirect(): LiveDirect {
  const transport = liveGuard(
    ohmyDirectTransport({
      client: createOhmyClient({
        auth: requireEnv("OHMY_SEO_MCP_AUTH"),
        fetch,
      }),
      account: requireEnv("DIRECT_QUERIES_LIVE_ACCOUNT"),
    }),
  );
  return { client: createDirectClient({ transport }), transport };
}

const REPORT_RETRY_MS = 10_000;
const REPORT_ATTEMPTS = 10;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseCell = (cell: string): string | number | null => {
  if (cell === "--" || cell === "") return null;
  const n = Number(cell);
  return Number.isNaN(n) ? cell : n;
};

export function parseReportRows(tsv: string, fields: string[]): SearchQueryRow[] {
  const lines = tsv.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return [];
  let cols = fields;
  const first = lines[0].split("\t");
  if (first.every((cell) => fields.includes(cell))) {
    cols = first;
    lines.shift();
  }
  return lines.map((line) => {
    const cells = line.split("\t");
    const row: SearchQueryRow = {};
    cols.forEach((field, i) => {
      row[field] = parseCell(cells[i] ?? "");
    });
    return row;
  });
}

export async function liveReportRows(
  transport: DirectTransport,
  params: Record<string, unknown>,
  fields: string[],
): Promise<SearchQueryRow[]> {
  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
    try {
      return parseReportRows(await transport.report(params), fields);
    } catch (error) {
      if (!(error instanceof DirectApiError) || error.code !== 202) throw error;
      if (attempt === REPORT_ATTEMPTS) break;
      await sleep(REPORT_RETRY_MS);
    }
  }
  throw new DirectApiError(0, "report not ready", `still pending after ${REPORT_ATTEMPTS} tries`);
}

export interface LiveSheets {
  client: ReturnType<typeof createSheetsClient>;
  sheetId: string;
  metadata: () => unknown;
}

export function liveSheets(): LiveSheets {
  const sheetId = requireEnv("DIRECT_QUERIES_LIVE_SHEET_ID");
  let captured: unknown;
  const recordingFetch: SheetsFetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("fields=spreadsheetId")) {
      captured = await response.clone().json();
    }
    return response;
  };
  const client = createSheetsClient({
    clientId: requireEnv("GOOGLE_SHEETS_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_SHEETS_CLIENT_SECRET"),
    refreshToken: requireEnv("GOOGLE_SHEETS_REFRESH_TOKEN"),
    fetch: recordingFetch,
  });
  return { client, sheetId, metadata: () => captured };
}

export function pastDay(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
