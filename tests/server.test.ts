import { describe, it, expect } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.ts";

// The SDK's createFakePluginHost needs better-sqlite3, which this plugin does
// not depend on; a minimal bb double captures the same registrations.
function fakeBb() {
  const kv = new Map<string, unknown>();
  const registrations = {
    rpc: null as Record<string, (input: unknown) => unknown> | null,
    cli: null as { name: string; commands: Array<{ name: string }> } | null,
    schedules: [] as Array<{ name: string; cron: string }>,
    disposals: [] as Array<() => unknown>,
  };
  const bb = {
    storage: {
      kv: {
        get: async <T>(key: string): Promise<T | undefined> => kv.get(key) as T | undefined,
        set: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix?: string) => [...kv.keys()].filter((k) => k.startsWith(prefix ?? "")),
      },
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
];

const CLI_COMMANDS = ["status", "run", "enable", "disable", "morning", "import", "export"];

describe("server entry", () => {
  it("registers the ten RPC methods and seven CLI commands of the plan", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    expect(Object.keys(registrations.rpc ?? {})).toEqual(
      expect.arrayContaining(RPC_METHODS),
    );
    expect(Object.keys(registrations.rpc ?? {})).toHaveLength(10);
    expect(registrations.cli?.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(CLI_COMMANDS),
    );
    expect(registrations.cli?.commands).toHaveLength(7);
    expect(registrations.schedules.map((s) => s.name)).toContain("tick");
    expect(registrations.schedules.find((s) => s.name === "tick")?.cron).toBe("* * * * *");
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
});
