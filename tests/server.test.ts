import { describe, it, expect, vi, afterEach } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import plugin from "../server.ts";
import { upsertAccount } from "../db.ts";
import { recordChanges, type ChangeEntry } from "../history.ts";

function fakeBb() {
  const kv = new Map<string, unknown>();
  const db = new Database(":memory:");
  const registrations = {
    rpc: null as Record<string, (input: unknown) => unknown> | null,
    rpcCalls: [] as Array<Record<string, (input: unknown) => unknown>>,
    cli: null as {
      name: string;
      commands: Array<{ name: string; usage: string }>;
      run: (argv: string[]) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
    } | null,
    schedules: [] as Array<{ name: string; cron: string }>,
    disposals: [] as Array<() => unknown>,
    http: [] as Array<{ method: string; path: string; auth?: string }>,
  };
  const bb = {
    pluginId: "direct-queries",
    storage: {
      kv: {
        get: async <T>(key: string): Promise<T | undefined> => kv.get(key) as T | undefined,
        set: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix?: string) => [...kv.keys()].filter((k) => k.startsWith(prefix ?? "")),
      },
      database: () => db,
      migrate: (handle: Database.Database, statements: string[]) => {
        for (const sql of statements) handle.exec(sql);
      },
    },
    settings: {
      define: () => ({
        get: async () => ({ yandexClientId: "cid", yandexClientSecret: "csec" }),
        experimental_set: async () => ({}),
        onChange: () => undefined,
      }),
    },
    sdk: {
      plugins: {
        callRpc: async () => ({ value: null }),
      },
    },
    http: {
      route: (method: string, path: string, _handler: unknown, opts?: { auth?: string }) => {
        registrations.http.push({ method, path, auth: opts?.auth });
      },
    },
    realtime: { publish: () => undefined },
    server: {
      experimental_appUrl: "https://bb.example",
      loopbackBaseUrl: "http://127.0.0.1:38886",
    },
    hosts: {
      experimental_client: () => ({ call: async () => ({ pid: 1 }) }),
    },
    rpc: {
      register: (_contract: unknown, handlers: Record<string, (input: unknown) => unknown>) => {
        registrations.rpc = handlers;
        registrations.rpcCalls.push(handlers);
      },
    },
    cli: {
      register: (decl: {
        name: string;
        commands: Array<{ name: string; usage: string }>;
        run: (argv: string[]) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
      }) => {
        registrations.cli = decl;
      },
    },
    background: {
      schedule: (name: string, cron: string, _fn: () => unknown) => {
        registrations.schedules.push({ name, cron });
      },
    },
    onDispose: (fn: () => unknown) => {
      registrations.disposals.push(fn);
    },
  };
  return { bb, registrations, kv };
}

const RPC_METHODS = [
  "overview",
  "projects.list",
  "projects.save",
  "projects.setEnabled",
  "ledger.list",
  "run",
  "stage.tail",
  "settings.get",
  "settings.save",
  "morning.preview",
  "accounts.list",
  "accounts.remove",
  "accounts.clients",
  "accounts.campaigns",
  "oauth.redirectUri",
  "secrets.status",
  "pipeline.run",
  "pipeline.preview",
];

const CLI_COMMANDS = [
  "status",
  "run",
  "enable",
  "disable",
  "morning",
  "import",
  "export",
  "pipeline",
  "stats",
  "history",
];

describe("server entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the RPC methods and CLI commands of the plan", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    expect(Object.keys(registrations.rpc ?? {})).toEqual(
      expect.arrayContaining(RPC_METHODS),
    );
    expect(Object.keys(registrations.rpc ?? {})).toHaveLength(18);
    expect(registrations.cli?.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(CLI_COMMANDS),
    );
    expect(registrations.cli?.commands).toHaveLength(10);
    const stats = registrations.cli?.commands.find((c) => c.name === "stats");
    expect(stats?.usage.startsWith("bb direct-queries stats")).toBe(true);
    expect(registrations.schedules.map((s) => s.name)).toContain("tick");
    expect(registrations.schedules.find((s) => s.name === "tick")?.cron).toBe("* * * * *");
    expect(registrations.schedules).toEqual(
      expect.arrayContaining([{ name: "history-sync", cron: "0 * * * *" }]),
    );
    expect(registrations.http).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/oauth/start", auth: "local" },
        { method: "GET", path: "/oauth/callback", auth: "none" },
      ]),
    );
  });

  it("stats without --from/--to prints usage", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const result = await registrations.cli!.run(["stats"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage");
  });

  it("registers the analytics RPC", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const analytics = registrations.rpcCalls.find((h) => "analytics" in h);
    expect(analytics?.["analytics"]).toBeTypeOf("function");
  });

  it("registers the OhMySEO account RPCs", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const ohmyseo = registrations.rpcCalls.find((h) => "ohmyseoAccounts" in h);
    expect(ohmyseo?.["ohmyseoAccounts"]).toBeTypeOf("function");
    expect(ohmyseo?.["ohmyseoImport"]).toBeTypeOf("function");
    await expect(
      ohmyseo!["ohmyseoAccounts"](null) as Promise<unknown>,
    ).rejects.toThrow("OHMY_SEO_MCP_AUTH");
  });

  it("projects.list stores no projects on first call", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const list = (await registrations.rpc!["projects.list"](null)) as Array<{ site: string }>;
    expect(list).toEqual([]);
  });

  it("settings.get returns the default morning line", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const s = (await registrations.rpc!["settings.get"](null)) as {
      morningLine: { hour: number; hostId: string; enabled: boolean };
    };
    expect(s.morningLine.hour).toBe(9);
    expect(s.morningLine.hostId).toBe("");
    expect(s.morningLine.enabled).toBe(false);
  });

  it("registers the history RPCs and the history CLI", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const hist = registrations.rpcCalls.find((h) => "history" in h && "historySync" in h);
    expect(hist?.["history"]).toBeTypeOf("function");
    expect(hist?.["historySync"]).toBeTypeOf("function");
    await expect(hist!["history"]({}) as Promise<unknown[]>).resolves.toEqual([]);
    const cli = registrations.cli as unknown as {
      run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
    };
    const out = await cli.run(["history", "--json"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("[]");
  });

  it("historySync covers a connected account without an enabled pipeline project", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const db = (
      bb as unknown as { storage: { database: () => Database.Database } }
    ).storage.database();
    upsertAccount(db, {
      id: "acc-lonely",
      login: "lonely",
      isAgency: false,
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: 0,
      createdAt: 1,
      source: "yandex",
    });
    const hist = registrations.rpcCalls.find((h) => "history" in h && "historySync" in h)!;
    const out = (await hist["historySync"]({ accountId: "acc-lonely" })) as {
      results: Array<{ accountId: string; added: number; error?: string }>;
    };
    vi.unstubAllGlobals();
    expect(out.results).toHaveLength(1);
    expect(out.results[0].accountId).toBe("acc-lonely");
    expect(out.results[0].error).toBeTypeOf("string");
  });

  it("historySync expands agency accounts into per-client targets", async () => {
    const { bb, registrations, kv } = fakeBb();
    kv.set("projects", [
      {
        id: "p-disabled",
        title: "Disabled",
        site: "example.com",
        enabled: false,
        jobs: [],
        pipeline: { accountId: "acc-agency", clientLogin: "client-a" },
      },
    ]);
    const calls: Array<{
      url: string;
      init?: { headers?: Record<string, string>; body?: string };
    }> = [];
    vi.stubGlobal(
      "fetch",
      async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        calls.push({ url: String(url), init });
        const body = JSON.parse(init?.body ?? "{}") as {
          method: string;
          params?: { Page?: { Offset?: number } };
        };
        let result: unknown = {};
        if (String(url).endsWith("/agencyclients")) {
          result =
            body.params?.Page?.Offset === undefined
              ? { Clients: [{ Login: "client-a" }], LimitedBy: 1 }
              : { Clients: [{ Login: "client-b" }] };
        } else if (String(url).endsWith("/changes")) {
          result =
            body.method === "checkCampaigns"
              ? { Campaigns: [], Timestamp: "2026-11-16T11:00:00Z" }
              : { Modified: { CampaignIds: [], AdGroupIds: [], AdIds: [] } };
        } else if (String(url).endsWith("/campaigns")) {
          result = { Campaigns: [] };
        }
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ result }),
        };
      },
    );
    await plugin(bb as unknown as BbPluginApi);
    const db = (
      bb as unknown as { storage: { database: () => Database.Database } }
    ).storage.database();
    const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
    upsertAccount(db, {
      id: "acc-agency",
      login: "agency",
      isAgency: true,
      accessToken: "tok-agency",
      refreshToken: "ref",
      expiresAt: farFuture,
      createdAt: 1,
      source: "yandex",
    });
    upsertAccount(db, {
      id: "acc-plain",
      login: "plain",
      isAgency: false,
      accessToken: "tok-plain",
      refreshToken: "ref",
      expiresAt: farFuture,
      createdAt: 1,
      source: "yandex",
    });
    const hist = registrations.rpcCalls.find((h) => "history" in h && "historySync" in h)!;
    const out = (await hist["historySync"]({})) as {
      results: Array<{
        accountId: string;
        clientLogin?: string;
        added: number;
        error?: string;
      }>;
    };
    vi.unstubAllGlobals();
    expect(out.results).toHaveLength(3);
    expect(out.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "acc-agency",
          clientLogin: "client-a",
          added: 0,
        }),
        expect.objectContaining({
          accountId: "acc-agency",
          clientLogin: "client-b",
          added: 0,
        }),
        expect.objectContaining({ accountId: "acc-plain", added: 0 }),
      ]),
    );
    expect(out.results.every((r) => r.error === undefined)).toBe(true);
    const checkCampaigns = calls.filter((c) => {
      try {
        return JSON.parse(c.init?.body ?? "{}").method === "checkCampaigns";
      } catch {
        return false;
      }
    });
    expect(checkCampaigns).toHaveLength(3);
    expect(checkCampaigns.map((c) => c.init?.headers?.["Client-Login"])).toEqual(
      expect.arrayContaining(["client-a", "client-b", undefined]),
    );
    const agencyCalls = calls.filter((c) => c.url.endsWith("/agencyclients"));
    expect(agencyCalls).toHaveLength(2);
    expect(JSON.parse(agencyCalls[0].init?.body ?? "{}")).toEqual({
      method: "get",
      params: {
        SelectionCriteria: {},
        FieldNames: ["Login", "ClientInfo"],
        Page: { Limit: 10000 },
      },
    });
    expect(JSON.parse(agencyCalls[1].init?.body ?? "{}")).toEqual({
      method: "get",
      params: {
        SelectionCriteria: {},
        FieldNames: ["Login", "ClientInfo"],
        Page: { Limit: 10000, Offset: 1 },
      },
    });
    const plainCalls = calls.filter(
      (c) => c.init?.headers?.Authorization === "Bearer tok-plain",
    );
    expect(plainCalls.length).toBeGreaterThan(0);
    expect(plainCalls.every((c) => c.init?.headers?.["Client-Login"] === undefined)).toBe(
      true,
    );
  });

  it("history CLI pages internally and the RPC history accepts a before cursor", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const db = (
      bb as unknown as { storage: { database: () => Database.Database } }
    ).storage.database();
    const base = Date.parse("2026-11-16T00:00:00Z");
    const entries: ChangeEntry[] = [];
    for (let i = 0; i < 1001; i += 1) {
      entries.push({
        at: new Date(base + Math.floor(i / 3) * 1000).toISOString(),
        accountId: "acc-page",
        source: "direct",
        actor: "direct",
        objectType: "campaign",
        objectId: String(i),
        campaignId: i,
        field: "Name",
        before: `b${i}`,
        after: `a${i}`,
      });
    }
    recordChanges(db, entries);
    const cli = registrations.cli as unknown as {
      run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
    };
    const out = await cli.run(["history", "--json"]);
    expect(out.exitCode).toBe(0);
    const rows = JSON.parse(out.stdout) as Array<{ id: number }>;
    expect(rows).toHaveLength(1001);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1001);
    const hist = registrations.rpcCalls.find((h) => "history" in h && "historySync" in h)!;
    const first = (await hist["history"]({ limit: 200 })) as Array<{
      id: number;
      at: string;
    }>;
    expect(first).toHaveLength(200);
    const last = first[first.length - 1];
    const second = (await hist["history"]({
      limit: 200,
      before: { at: last.at, id: last.id },
    })) as Array<{ id: number }>;
    expect(second).toHaveLength(200);
    expect(second[0].id).toBeLessThan(last.id);
    const ids = new Set([...first, ...second].map((r) => r.id));
    expect(ids.size).toBe(400);
  });

  it("oauth.redirectUri is the plugin HTTP callback", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const { uri } = (await registrations.rpc!["oauth.redirectUri"](null)) as { uri: string };
    expect(uri).toBe("https://bb.example/api/v1/plugins/direct-queries/http/oauth/callback");
  });
});
