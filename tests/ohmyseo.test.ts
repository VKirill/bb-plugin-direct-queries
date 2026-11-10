import { describe, it, expect } from "vitest";
import {
  createOhmyClient,
  ohmyDirectTransport,
  OhmyError,
  OHMYSEO_MCP_URL,
} from "../ohmyseo.ts";
import { createDirectClient, DirectApiError } from "../direct.ts";
import type { FetchFn, HttpResponse } from "../yandex-oauth.ts";

interface RecordedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

const res = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { get: () => null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const mcpReply = (payload: unknown): HttpResponse =>
  res(200, {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });

function fakeFetch(responses: HttpResponse[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch call");
    return next;
  };
  return { fetch, calls };
}

const toolCall = (call: RecordedCall) => {
  const body = JSON.parse(call.init?.body ?? "{}") as {
    jsonrpc: string;
    method: string;
    params: { name: string; arguments: Record<string, unknown> };
  };
  expect(body.jsonrpc).toBe("2.0");
  expect(body.method).toBe("tools/call");
  return body.params;
};

const transportFor = (fetch: FetchFn, account = "label-1") =>
  ohmyDirectTransport({
    client: createOhmyClient({ auth: "Bearer ohmy_test", fetch }),
    account,
  });

describe("ohmyDirectTransport", () => {
  it("a write call sends confirm and acknowledge_live", async () => {
    const { fetch, calls } = fakeFetch([
      mcpReply({ ok: true, status: 200, data: { result: { UpdateResults: [] } } }),
    ]);
    const transport = transportFor(fetch);
    await transport.call("campaigns", "update", { Campaigns: [{ Id: 1 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OHMYSEO_MCP_URL);
    expect(calls[0].init?.headers?.Authorization).toBe("Bearer ohmy_test");
    const params = toolCall(calls[0]);
    expect(params.name).toBe("yandex_direct_api");
    const args = params.arguments;
    expect(args.endpoint).toBe("/json/v5/campaigns");
    expect(args.account).toBe("label-1");
    expect(args.body).toEqual({ method: "update", params: { Campaigns: [{ Id: 1 }] } });
    expect(args.confirm).toBe(true);
    expect(args.acknowledge_live).toBe("UPDATE /json/v5/campaigns");
  });

  it("a get call sends neither confirm nor acknowledge_live", async () => {
    const { fetch, calls } = fakeFetch([
      mcpReply({ ok: true, status: 200, data: { result: { Campaigns: [] } } }),
    ]);
    const transport = transportFor(fetch);
    await transport.call("campaigns", "get", { SelectionCriteria: {} });
    const args = toolCall(calls[0]).arguments;
    expect(args.endpoint).toBe("/json/v5/campaigns");
    expect(args.body).toEqual({ method: "get", params: { SelectionCriteria: {} } });
    expect(args).not.toHaveProperty("confirm");
    expect(args).not.toHaveProperty("acknowledge_live");
  });

  it("report sends /json/v5/reports with a body without method and returns tsv", async () => {
    const tsv = "Date\tQuery\n2026-11-10\tx";
    const { fetch, calls } = fakeFetch([
      mcpReply({ ok: true, status: 200, tsv, rows: 1 }),
    ]);
    const transport = transportFor(fetch);
    const out = await transport.report({ SelectionCriteria: {}, FieldNames: ["Date"] });
    expect(out).toBe(tsv);
    const args = toolCall(calls[0]).arguments;
    expect(args.endpoint).toBe("/json/v5/reports");
    const body = args.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("method");
    expect(body.params).toEqual({ SelectionCriteria: {}, FieldNames: ["Date"] });
  });
});

describe("createDirectClient with an OhMySEO transport", () => {
  it("campaigns() returns rows from a mocked ok reply", async () => {
    const campaigns = [
      { Id: 1, Name: "C", State: "ON", Status: "ACCEPTED", Type: "TEXT_CAMPAIGN" },
    ];
    const { fetch } = fakeFetch([
      mcpReply({ ok: true, status: 200, data: { result: { Campaigns: campaigns } } }),
    ]);
    const client = createDirectClient({ transport: transportFor(fetch) });
    expect(await client.campaigns()).toEqual(campaigns);
  });

  it("an ok:false reply throws DirectApiError with the Direct code", async () => {
    const { fetch } = fakeFetch([
      mcpReply({
        ok: false,
        status: 400,
        body: { error: { error_code: 53, error_string: "access denied" } },
      }),
    ]);
    const client = createDirectClient({ transport: transportFor(fetch) });
    const err = await client.campaigns().then(
      () => {
        throw new Error("should have thrown");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DirectApiError);
    expect((err as DirectApiError).code).toBe(53);
  });

  it("searchQueryReport retries a pending report and parses the tsv", async () => {
    const sleeps: number[] = [];
    const { fetch } = fakeFetch([
      mcpReply({ ok: true, status: 202, pending: true }),
      mcpReply({ ok: true, status: 200, tsv: "Date\tQuery\n2026-11-10\tx", rows: 1 }),
    ]);
    const client = createDirectClient({
      transport: transportFor(fetch),
      sleep: async (ms) => void sleeps.push(ms),
    });
    const rows = await client.searchQueryReport({
      dateFrom: "2026-11-10",
      dateTo: "2026-11-10",
    });
    expect(sleeps).toEqual([10_000]);
    expect(rows).toHaveLength(1);
    expect(rows[0].Query).toBe("x");
  });
});

describe("createOhmyClient", () => {
  it("listAccounts maps gateway accounts", async () => {
    const { fetch, calls } = fakeFetch([
      mcpReply({
        accounts: [
          {
            id: "a1",
            label: "label-1",
            yandex_login: "login1",
            scopes_granted: ["direct:api"],
            is_default: true,
          },
          {
            id: "a2",
            label: "label-2",
            yandex_login: "login2",
            is_default: false,
            direct_access_denied: true,
          },
        ],
      }),
    ]);
    const client = createOhmyClient({ auth: "Bearer x", fetch });
    const accounts = await client.listAccounts();
    expect(toolCall(calls[0]).name).toBe("list_accounts");
    expect(accounts).toEqual([
      { label: "label-1", yandexLogin: "login1", isDefault: true, denied: false },
      { label: "label-2", yandexLogin: "login2", isDefault: false, denied: true },
    ]);
  });

  it("throws OhmyError on a JSON-RPC error and on http 401", async () => {
    const { fetch: fetchErr } = fakeFetch([
      res(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }),
    ]);
    await expect(
      createOhmyClient({ auth: "x", fetch: fetchErr }).listAccounts(),
    ).rejects.toBeInstanceOf(OhmyError);

    const { fetch: fetchAuth } = fakeFetch([res(401, "unauthorized")]);
    const err = await createOhmyClient({ auth: "x", fetch: fetchAuth })
      .listAccounts()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(OhmyError);
    expect((err as OhmyError).code).toBe("auth");
  });
});
