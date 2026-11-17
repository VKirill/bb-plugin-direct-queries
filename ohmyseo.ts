import type { FetchFn } from "./yandex-oauth.ts";
import { DirectApiError, type DirectTransport } from "./direct.ts";

export const OHMYSEO_MCP_URL = "https://mcp.ohmy-seo.ru/mcp";
export const OHMY_CALL_TIMEOUT_MS = 150_000;
const DIRECT_API_TOOL = "yandex_direct_api";

export class OhmyError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "OhmyError";
    this.code = code;
  }
}

export interface OhmyAccount {
  label: string;
  yandexLogin: string;
  isDefault: boolean;
  denied: boolean;
}

export interface OhmyClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listAccounts(): Promise<OhmyAccount[]>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

function parseReply(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const dataLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .reverse();
  candidates.push(...dataLines);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const rec = asRecord(parsed);
      if (rec) return rec;
    } catch {
      // try the next candidate
    }
  }
  throw new OhmyError("ohmyseo: unparseable reply");
}

function directError(error: unknown): DirectApiError {
  const e = asRecord(error) ?? {};
  return new DirectApiError(
    Number(e.error_code ?? 0),
    String(e.error_string ?? "direct api error"),
    typeof e.error_detail === "string" ? e.error_detail : undefined,
  );
}

function unwrap(payload: unknown): unknown {
  const env = asRecord(payload);
  if (!env) return payload;
  const inner = asRecord(env.data) ?? asRecord(env.body);
  if (env.ok === false) {
    throw directError(asRecord(inner)?.error ?? env.error);
  }
  const holder = inner ?? env;
  if (holder.error) throw directError(holder.error);
  return holder.result ?? holder;
}

const REPORT_MONEY_FIELDS = new Set([
  "Cost",
  "AvgCpc",
  "AvgCpm",
  "AvgEffectiveBid",
  "Revenue",
  "CostPerConversion",
]);

const DIRECT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isMoneyField = (name: string): boolean =>
  REPORT_MONEY_FIELDS.has(name) ||
  name.startsWith("CostPerConversion_") ||
  name.startsWith("Revenue_");

const microsToRubles = (cell: string): string => {
  if (cell === "" || cell === "--") return cell;
  const micros = Number(cell);
  if (!Number.isFinite(micros)) return cell;
  return String(Math.round(micros / 10_000) / 100);
};

function normalizeReportTsv(tsv: string, fields?: string[]): string {
  const lines = tsv.split(/\r?\n/);
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length > 0 && lines[0].startsWith('"')) lines.shift();
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.trim() !== "" && !last.startsWith("Total rows")) break;
    lines.pop();
  }
  if (lines.length === 0) return "";
  const header = lines[0].split("\t");
  const isHeader =
    (header.length > 1 || fields !== undefined) &&
    header.every((cell) =>
      fields === undefined ? DIRECT_FIELD_NAME.test(cell) : fields.includes(cell),
    );
  if (!isHeader) return lines.join("\n");
  const moneyCols = header.flatMap((name, i) => (isMoneyField(name) ? [i] : []));
  if (moneyCols.length === 0) return lines.join("\n");
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    for (const i of moneyCols) {
      if (i < cells.length) cells[i] = microsToRubles(cells[i]);
    }
    out.push(cells.join("\t"));
  }
  return out.join("\n");
}

function unwrapReport(payload: unknown): string {
  const env = asRecord(payload);
  if (!env) throw new DirectApiError(0, "ohmyseo report: bad reply");
  if (env.pending === true || env.status === 202 || env.status === 201) {
    throw new DirectApiError(202, "report pending");
  }
  if (env.ok === false) {
    const inner = asRecord(env.data) ?? asRecord(env.body);
    throw directError(asRecord(inner)?.error ?? env.error);
  }
  const inner = asRecord(env.data) ?? asRecord(env.body);
  const tsv = env.tsv ?? inner?.tsv ?? asRecord(inner?.result)?.tsv;
  if (typeof tsv === "string") return tsv;
  throw new DirectApiError(0, "ohmyseo report: no tsv in reply");
}

const reportFieldNames = (params: unknown): string[] | undefined => {
  const list = asRecord(params)?.FieldNames;
  if (!Array.isArray(list)) return undefined;
  const names = list.filter((name): name is string => typeof name === "string");
  return names.length > 0 ? names : undefined;
};

export function createOhmyClient(opts: {
  auth: string;
  fetch: FetchFn;
  timeoutMs?: number;
}): OhmyClient {
  const timeoutMs = opts.timeoutMs ?? OHMY_CALL_TIMEOUT_MS;
  let nextId = 0;

  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = {
      method: "POST",
      headers: {
        Authorization: opts.auth,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++nextId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal,
    };
    try {
      const res = await opts.fetch(OHMYSEO_MCP_URL, init);
      if (res.status === 401 || res.status === 403) {
        throw new OhmyError(`ohmyseo unauthorized (http ${res.status})`, "auth");
      }
      if (res.status < 200 || res.status >= 300) {
        throw new OhmyError(`ohmyseo http ${res.status}`);
      }
      const reply = parseReply(await res.text());
      if (reply.error) {
        const e = asRecord(reply.error);
        throw new OhmyError(String(e?.message ?? "ohmyseo rpc error"));
      }
      const result = asRecord(reply.result);
      if (!result) throw new OhmyError("ohmyseo: empty reply");
      const content = Array.isArray(result.content) ? result.content : [];
      const first = asRecord(content[0]);
      const raw = typeof first?.text === "string" ? first.text : "";
      if (result.isError) throw new OhmyError(raw || "ohmyseo tool error");
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    } catch (e) {
      if (signal.aborted) {
        throw new OhmyError(`ohmyseo timeout after ${timeoutMs / 1000}s`);
      }
      throw e;
    }
  };

  const listAccounts = async (): Promise<OhmyAccount[]> => {
    const payload = await callTool("list_accounts", {});
    const rec = asRecord(payload);
    const list = Array.isArray(rec?.accounts) ? rec.accounts : [];
    return list.flatMap((item) => {
      const a = asRecord(item);
      const label = typeof a?.label === "string" ? a.label : "";
      if (!label) return [];
      return [
        {
          label,
          yandexLogin: String(a?.yandex_login ?? ""),
          isDefault: Boolean(a?.is_default),
          denied: Boolean(a?.direct_access_denied),
        },
      ];
    });
  };

  return { callTool, listAccounts };
}

export function ohmyDirectTransport(opts: {
  client: OhmyClient;
  account: string;
  clientLogin?: string;
}): DirectTransport {
  const baseArgs = (): Record<string, unknown> => ({
    account: opts.account,
    ...(opts.clientLogin ? { client_login: opts.clientLogin } : {}),
  });

  return {
    async call(service, method, params) {
      const args: Record<string, unknown> = {
        endpoint: `/json/v5/${service}`,
        method: "POST",
        force_refresh: true,
        body: { method, params },
        ...baseArgs(),
      };
      if (method !== "get") {
        args.confirm = true;
        args.acknowledge_live = `${method.toUpperCase()} /json/v5/${service}`;
      }
      return unwrap(await opts.client.callTool(DIRECT_API_TOOL, args));
    },

    async report(params) {
      const args: Record<string, unknown> = {
        endpoint: "/json/v5/reports",
        method: "POST",
        force_refresh: true,
        body: { params },
        ...baseArgs(),
      };
      const tsv = unwrapReport(await opts.client.callTool(DIRECT_API_TOOL, args));
      return normalizeReportTsv(tsv, reportFieldNames(params));
    },
  };
}
