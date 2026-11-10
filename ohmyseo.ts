import type { FetchFn } from "./yandex-oauth.ts";
import { DirectApiError, type DirectTransport } from "./direct.ts";

export const OHMYSEO_MCP_URL = "https://mcp.ohmy-seo.ru/mcp";
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

function unwrapReport(payload: unknown): string {
  const env = asRecord(payload);
  if (!env) throw new DirectApiError(0, "ohmyseo report: bad reply");
  if (env.ok === false) {
    const inner = asRecord(env.data) ?? asRecord(env.body);
    throw directError(asRecord(inner)?.error ?? env.error);
  }
  if (env.pending === true) throw new DirectApiError(202, "report pending");
  const inner = asRecord(env.data) ?? asRecord(env.body);
  const tsv = env.tsv ?? inner?.tsv ?? asRecord(inner?.result)?.tsv;
  if (typeof tsv === "string") return tsv;
  throw new DirectApiError(0, "ohmyseo report: no tsv in reply");
}

export function createOhmyClient(opts: { auth: string; fetch: FetchFn }): OhmyClient {
  let nextId = 0;

  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await opts.fetch(OHMYSEO_MCP_URL, {
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
    });
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
        body: { params },
        ...baseArgs(),
      };
      return unwrapReport(await opts.client.callTool(DIRECT_API_TOOL, args));
    },
  };
}
