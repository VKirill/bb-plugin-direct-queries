import { describe, it, expect } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import plugin from "../server.ts";

function fakeBb() {
  const kv = new Map<string, unknown>();
  const db = new Database(":memory:");
  const registrations = {
    rpc: null as Record<string, (input: unknown) => unknown> | null,
    cli: null as { name: string; commands: Array<{ name: string }> } | null,
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
        get: async () => ({}),
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
      },
    },
    cli: {
      register: (decl: { name: string; commands: Array<{ name: string }> }) => {
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

const CLI_COMMANDS = ["status", "run", "enable", "disable", "morning", "import", "export", "pipeline"];

describe("server entry", () => {
  it("registers the ten RPC methods and seven CLI commands of the plan", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    expect(Object.keys(registrations.rpc ?? {})).toEqual(
      expect.arrayContaining(RPC_METHODS),
    );
    expect(Object.keys(registrations.rpc ?? {})).toHaveLength(18);
    expect(registrations.cli?.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(CLI_COMMANDS),
    );
    expect(registrations.cli?.commands).toHaveLength(8);
    expect(registrations.schedules.map((s) => s.name)).toContain("tick");
    expect(registrations.schedules.find((s) => s.name === "tick")?.cron).toBe("* * * * *");
    expect(registrations.http).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/oauth/start", auth: "local" },
        { method: "GET", path: "/oauth/callback", auth: "none" },
      ]),
    );
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

  it("oauth.redirectUri is the plugin HTTP callback", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const { uri } = (await registrations.rpc!["oauth.redirectUri"](null)) as { uri: string };
    expect(uri).toBe("https://bb.example/api/v1/plugins/direct-queries/http/oauth/callback");
  });
});
