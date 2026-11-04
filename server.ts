import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostContract } from "./host.ts";
import { createRunner, type StoredRun, type Store } from "./runner.ts";
import {
  ledgerRowSchema,
  projectSchema,
  settingsSchema,
  type LedgerRow,
  type Project,
  type Settings,
} from "./model.ts";
import { seedProjects, seedSettings } from "./seed.ts";
import { addDays, moscowParts } from "./slots.ts";
import { morningLine } from "./ledger.ts";

const importPayloadSchema = z.object({
  projects: z.array(projectSchema),
  settings: settingsSchema.optional(),
});

export async function importConfig(
  store: Store,
  json: unknown,
): Promise<{ imported: string[] }> {
  const parsed = importPayloadSchema.parse(json);
  const current = (await store.get<Project[]>("projects")) ?? [];
  const incoming = new Map(parsed.projects.map((p) => [p.id, p]));
  const next: Project[] = [];
  const seen = new Set<string>();
  for (const p of current) {
    const upd = incoming.get(p.id);
    if (upd) {
      next.push(upd);
      seen.add(p.id);
    } else next.push(p);
  }
  for (const p of parsed.projects) {
    if (!seen.has(p.id)) next.push(p);
  }
  await store.set("projects", next);
  if (parsed.settings !== undefined) await store.set("settings", parsed.settings);
  return { imported: parsed.projects.map((p) => p.id) };
}

export const rpcContract = defineRpcContract({
  overview: {
    input: z.object({ days: z.number().int().min(1).max(90).default(7) }),
    output: z.unknown(),
  },
  "projects.list": { input: z.null(), output: z.array(projectSchema) },
  "projects.save": { input: z.object({ project: projectSchema }), output: projectSchema },
  "projects.setEnabled": {
    input: z.object({
      projectId: z.string(),
      jobId: z.string().optional(),
      enabled: z.boolean(),
    }),
    output: z.boolean(),
  },
  "ledger.list": {
    input: z.object({
      projectId: z.string(),
      day: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    output: z.array(ledgerRowSchema),
  },
  run: {
    input: z.object({
      projectId: z.string(),
      jobId: z.string(),
      day: z.string().optional(),
    }),
    output: z.object({ runId: z.string(), day: z.string() }),
  },
  "stage.tail": {
    input: z.object({
      runId: z.string(),
      stageId: z.string(),
      lines: z.number().int().min(1).max(200).optional(),
    }),
    output: z.object({ out: z.string(), err: z.string() }),
  },
  "settings.get": { input: z.null(), output: settingsSchema },
  "settings.save": { input: settingsSchema, output: settingsSchema },
  "morning.preview": { input: z.null(), output: z.object({ text: z.string() }) },
});

export default async function plugin(bb: BbPluginApi) {
  const store: Store = bb.storage.kv;
  const lifecycle = new AbortController();
  bb.onDispose(async () => {
    lifecycle.abort();
  });

  const client = bb.hosts.experimental_client({ contract: hostContract });
  const opts = (hostId: string) => ({ hostId, signal: lifecycle.signal });
  const host = {
    start: (hostId: string, input: { runId: string; cwd: string; script: string }) =>
      client.call("start", input, opts(hostId)),
    status: (hostId: string, input: { runId: string }) =>
      client.call("status", input, opts(hostId)),
    tail: (hostId: string, input: { runId: string; stageId: string; lines?: number }) =>
      client.call("tail", input, opts(hostId)),
    notify: (hostId: string, input: { command: string; text: string }) =>
      client.call("notify", input, opts(hostId)),
  };

  const runner = createRunner({ store, host, now: () => Date.now(), newRunId: randomUUID });

  let queue: Promise<void> = Promise.resolve();
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };

  const projects = async (): Promise<Project[]> =>
    (await store.get<Project[]>("projects")) ?? [];
  const saveProjects = (list: Project[]): Promise<void> => store.set("projects", list);
  const settings = async (): Promise<Settings> =>
    (await store.get<Settings>("settings")) ?? seedSettings();

  const ensureSeed = async (): Promise<void> => {
    if ((await store.get("projects")) === undefined) await saveProjects(seedProjects());
    if ((await store.get("settings")) === undefined) await store.set("settings", seedSettings());
  };

  const findRun = async (runId: string): Promise<StoredRun | undefined> => {
    for (const key of await store.list("run:")) {
      if (key.endsWith(`:${runId}`)) return store.get<StoredRun>(key);
    }
    return undefined;
  };

  const morningText = async (): Promise<string> => {
    const list = await projects();
    const yesterday = addDays(moscowParts(Date.now()).date, -1);
    const rows: LedgerRow[] = [];
    for (const key of await store.list("run:")) {
      const run = await store.get<StoredRun>(key);
      if (run?.day === yesterday) rows.push(...run.rows);
    }
    return morningLine(list, rows, yesterday);
  };

  bb.rpc.register(rpcContract, {
    overview: ({ days }) => serial(() => runner.overview(days)),
    "projects.list": async () => {
      await ensureSeed();
      return projects();
    },
    "projects.save": ({ project }) =>
      serial(async () => {
        const list = await projects();
        const i = list.findIndex((p) => p.id === project.id);
        if (i === -1) list.push(project);
        else list[i] = project;
        await saveProjects(list);
        return project;
      }),
    "projects.setEnabled": ({ projectId, jobId, enabled }) =>
      serial(async () => {
        await ensureSeed();
        const list = await projects();
        const p = list.find((x) => x.id === projectId);
        if (!p) throw new Error("projectMissing");
        if (jobId === undefined) p.enabled = enabled;
        else {
          const j = p.jobs.find((x) => x.id === jobId);
          if (!j) throw new Error("jobMissing");
          j.enabled = enabled;
        }
        await saveProjects(list);
        return true;
      }),
    "ledger.list": ({ projectId, day, limit }) =>
      serial(() => runner.ledger(projectId, day, limit)),
    run: ({ projectId, jobId, day }) => serial(() => runner.start(projectId, jobId, day, "manual")),
    "stage.tail": async ({ runId, stageId, lines }) => {
      const run = await findRun(runId);
      if (!run) throw new Error("runMissing");
      const p = (await projects()).find((x) => x.id === run.projectId);
      if (!p) throw new Error("projectMissing");
      return host.tail(p.hostId, { runId, stageId, lines });
    },
    "settings.get": async () => {
      await ensureSeed();
      return settings();
    },
    "settings.save": async (next) => {
      await store.set("settings", next);
      return next;
    },
    "morning.preview": async () => {
      await ensureSeed();
      return { text: await morningText() };
    },
  });

  bb.background.schedule("tick", "* * * * *", () => serial(() => runner.tick()));

  bb.cli.register({
    name: "direct-queries",
    summary: "Registry, schedule, run ledger and morning line for Direct query pipelines",
    commands: [
      {
        name: "status",
        summary: "Show the per-job day grid and running jobs",
        usage: "bb direct-queries status [--json]",
      },
      {
        name: "run",
        summary: "Run one project job now",
        usage: "bb direct-queries run <project> <job> [--date YYYY-MM-DD]",
      },
      {
        name: "enable",
        summary: "Enable a project or one of its jobs",
        usage: "bb direct-queries enable <project> [job]",
      },
      {
        name: "disable",
        summary: "Disable a project or one of its jobs",
        usage: "bb direct-queries disable <project> [job]",
      },
      {
        name: "morning",
        summary: "Preview or send the morning line",
        usage: "bb direct-queries morning [--dry-run|--send]",
      },
      {
        name: "import",
        summary: "Import projects and optional settings from a local JSON file",
        usage: "bb direct-queries import <file>",
      },
      {
        name: "export",
        summary: "Print stored projects and settings as JSON",
        usage: "bb direct-queries export",
      },
    ],
    run: async (argv) => {
      try {
        switch (argv[0]) {
          case "status": {
            const ov = await serial(() => runner.overview(7));
            if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(ov) };
            const lines = ov.projects.flatMap((p) => [
              `${p.enabled ? "●" : "○"} ${p.site}`,
              ...p.jobs.map(
                (j) =>
                  `  ${j.title} [${j.jobId}]: ${ov.days.map((d, i) => `${d.slice(5)} ${j.cells[i].status}`).join(" · ")}`,
              ),
            ]);
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "run": {
            const dateI = argv.indexOf("--date");
            const day = dateI === -1 ? undefined : argv[dateI + 1];
            const r = await serial(() => runner.start(argv[1] ?? "", argv[2] ?? "", day, "manual"));
            return { exitCode: 0, stdout: JSON.stringify(r) };
          }
          case "enable":
          case "disable": {
            const enabled = argv[0] === "enable";
            await ensureSeed();
            const list = await projects();
            const p = list.find((x) => x.id === argv[1]);
            if (!p) return { exitCode: 1, stderr: "projectMissing" };
            if (argv[2] === undefined) p.enabled = enabled;
            else {
              const j = p.jobs.find((x) => x.id === argv[2]);
              if (!j) return { exitCode: 1, stderr: "jobMissing" };
              j.enabled = enabled;
            }
            await saveProjects(list);
            return { exitCode: 0, stdout: "ok" };
          }
          case "morning": {
            const text = await morningText();
            if (argv.includes("--send")) {
              const s = await settings();
              const { exitCode } = await host.notify(s.morningLine.hostId, {
                command: s.morningLine.command,
                text,
              });
              return { exitCode, stdout: exitCode === 0 ? "sent" : "notify failed" };
            }
            return { exitCode: 0, stdout: text };
          }
          case "import": {
            const file = argv[1];
            if (!file) return { exitCode: 1, stderr: "usage: bb direct-queries import <file>" };
            const json: unknown = JSON.parse(await readFile(file, "utf8"));
            try {
              const { imported } = await importConfig(store, json);
              return {
                exitCode: 0,
                stdout: `imported ${imported.length} projects: ${imported.join(", ")}`,
              };
            } catch (e) {
              if (e instanceof z.ZodError) {
                return {
                  exitCode: 1,
                  stderr: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
                };
              }
              throw e;
            }
          }
          case "export": {
            await ensureSeed();
            return {
              exitCode: 0,
              stdout: JSON.stringify({ projects: await projects(), settings: await settings() }),
            };
          }
          default:
            return {
              exitCode: 0,
              stdout:
                "bb direct-queries status [--json] | run <project> <job> [--date D] | enable|disable <project> [job] | morning [--dry-run|--send] | import <file> | export",
            };
        }
      } catch (e) {
        return { exitCode: 1, stderr: e instanceof Error ? e.message : "failed" };
      }
    },
  });
}
