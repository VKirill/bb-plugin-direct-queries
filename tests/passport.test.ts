import { describe, it, expect } from "vitest";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { passportCompleteness, projectSchema, siteProfileSchema } from "../model.ts";
import { createJudge, type CachePort, type SiteProfile } from "../judge.ts";
import { fixturePipelineProject } from "./fixtures/projects.ts";
import plugin from "../server.ts";

const OLD_PROFILE = {
  site: "https://gamma.example/",
  company: "Gamma",
  buyer: "Buyers",
  offers: ["Offer"],
  advertising_goal: "Orders",
  boundaries: ["Off-topic"],
};

const PROFILE: SiteProfile = { ...OLD_PROFILE };

const memoryCache = (): CachePort => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: (key: string, value: unknown) => void map.set(key, value),
  };
};

const JEV_ANSWERS = JSON.stringify({
  answers: {
    relevance_0: {
      score: 1.5,
      confidence: 0.8,
      probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 },
    },
    intent_0: { choice: "commercial" },
  },
});

function fakeBb() {
  const kv = new Map<string, unknown>();
  const db = new Database(":memory:");
  const registrations = {
    rpc: null as Record<string, (input: unknown) => unknown> | null,
    rpcCalls: [] as Array<Record<string, (input: unknown) => unknown>>,
    cli: null as {
      name: string;
      commands: Array<{ name: string; usage?: string }>;
      run: (
        argv: string[],
        ctx: unknown,
      ) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
    } | null,
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
      route: () => undefined,
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
      register: (decl: NonNullable<typeof registrations.cli>) => {
        registrations.cli = decl;
      },
    },
    background: {
      schedule: () => undefined,
    },
    onDispose: () => undefined,
  };
  return { bb, registrations };
}

type PassportView = {
  passport: Record<string, unknown> | null;
  completeness: { filled: number; total: number; missing: string[] } | null;
};

describe("passport schema", () => {
  it("a stored profile without the new fields still parses", () => {
    expect(siteProfileSchema.parse(OLD_PROFILE)).toEqual(OLD_PROFILE);
    expect(projectSchema.safeParse(fixturePipelineProject()).success).toBe(true);
  });

  it("passportCompleteness counts the eight judged fields", () => {
    const profile = {
      ...OLD_PROFILE,
      geo: ["Москва"],
      target_segments: ["заводы"],
      non_target: ["бесплатно"],
    };
    expect(passportCompleteness(profile)).toEqual({
      filled: 6,
      total: 8,
      missing: ["target_examples", "non_target_examples"],
    });
  });
});

describe("judge passport fields", () => {
  it("the request names profile.non_target when the passport has it", async () => {
    const bodies: string[] = [];
    const fetch = async (
      _url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      bodies.push(init?.body ?? "");
      return { status: 200, text: async () => JEV_ANSWERS };
    };
    const judge = createJudge({
      openluxKey: "k",
      fetch,
      sleep: async () => {},
      now: () => 0,
      cache: memoryCache(),
    });
    await judge.judgeQueries(
      { ...PROFILE, non_target: ["бесплатные сервисы"] },
      [{ campaign: "К", query: "клапан бесплатно" }],
      [],
    );
    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0]);
    expect(payload.questions.relevance_0.instructions).toContain("profile.non_target");
  });
});

describe("passport RPC", () => {
  it("passportSet stores the passport and passportGet returns it with updated_at", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const passportRpc = registrations.rpcCalls.find((h) => "passportGet" in h)!;
    const project = fixturePipelineProject();
    await registrations.rpc!["projects.save"]({ project });
    const passport = {
      ...project.pipeline!.profile,
      geo: ["Москва и область"],
      non_target: ["бесплатные сервисы", "вакансии"],
    };
    const set = (await passportRpc["passportSet"]({
      projectId: "gamma",
      passport,
    })) as PassportView;
    expect(set.passport?.["updated_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const got = (await passportRpc["passportGet"]({ projectId: "gamma" })) as PassportView;
    expect(got.passport).toEqual(set.passport);
    expect(got.completeness).toEqual({
      filled: 5,
      total: 8,
      missing: ["target_segments", "target_examples", "non_target_examples"],
    });
  });
});

describe("passport CLI", () => {
  it("lists the passport usages and round-trips get/set", async () => {
    const { bb, registrations } = fakeBb();
    await plugin(bb as unknown as BbPluginApi);
    const getUsage = await registrations.cli!.run(["passport", "get"], null);
    expect(getUsage.exitCode).toBe(1);
    expect(getUsage.stderr).toBe(
      "usage: bb direct-queries passport get <project> [--json]",
    );
    const setUsage = await registrations.cli!.run(["passport", "set", "gamma"], null);
    expect(setUsage.exitCode).toBe(1);
    expect(setUsage.stderr).toBe(
      "usage: bb direct-queries passport set <project> --file <path>",
    );
    const allUsage = await registrations.cli!.run([], null);
    expect(allUsage.stdout).toContain("passport get <project> [--json]");
    expect(allUsage.stdout).toContain("passport set <project> --file <path>");

    const project = fixturePipelineProject();
    await registrations.rpc!["projects.save"]({ project });
    const file = "/tmp/dq3-passport-set.json";
    writeFileSync(
      file,
      JSON.stringify({ ...project.pipeline!.profile, brand_policy: "свой бренд — целевой" }),
    );
    try {
      const setRes = await registrations.cli!.run(
        ["passport", "set", "gamma", "--file", file],
        null,
      );
      expect(setRes.exitCode).toBe(0);
      expect(setRes.stdout).toContain("3/8");
      const getJson = await registrations.cli!.run(["passport", "get", "gamma", "--json"], null);
      const view = JSON.parse(getJson.stdout ?? "{}") as PassportView;
      expect(view.passport?.["brand_policy"]).toBe("свой бренд — целевой");
      expect(view.passport?.["updated_at"]).toEqual(expect.any(String));
      const getText = await registrations.cli!.run(["passport", "get", "gamma"], null);
      expect(getText.stdout).toContain("3/8");
    } finally {
      unlinkSync(file);
    }
  });
});

describe("project-passport skill", () => {
  it("exists with name frontmatter and a description", () => {
    const path = join(process.cwd(), "skills/project-passport/SKILL.md");
    const content = readFileSync(path, "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(frontmatter).toContain("name: project-passport");
    expect(frontmatter).toMatch(/description:\s*\S/);
  });
});
