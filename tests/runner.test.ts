import { describe, it, expect } from "vitest";
import { createRunner, type HostPort, type Store, type StoredRun } from "../runner.ts";
import type { LedgerRow, Project, Settings } from "../model.ts";
import { fixturePipelineProject, fixtureProjects, fixtureSettings } from "./fixtures/projects.ts";

class MemStore implements Store {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(prefix?: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix ?? ""));
  }
}

class FakeHost implements HostPort {
  started: Array<{ hostId: string; runId: string; cwd: string; script: string }> = [];
  notifies: Array<{ hostId: string; command: string; text: string }> = [];
  nextStatus: Record<string, unknown> = { alive: false, exitCode: 0, stages: [] };
  startError: Error | null = null;
  calls = 0;
  async start(hostId: string, input: { runId: string; cwd: string; script: string }) {
    this.calls++;
    if (this.startError && this.calls === 1) throw this.startError;
    this.started.push({ hostId, ...input });
    return { pid: 1000 + this.started.length };
  }
  async status(_hostId: string, _input: { runId: string }) {
    return this.nextStatus as { alive: boolean; exitCode?: number; stages: Record<string, unknown>[] };
  }
  async tail() {
    return { out: "", err: "" };
  }
  async notify(hostId: string, input: { command: string; text: string }) {
    this.notifies.push({ hostId, ...input });
    return { exitCode: 0 };
  }
}

const runs = async (store: MemStore): Promise<StoredRun[]> => {
  const out: StoredRun[] = [];
  for (const k of await store.list("run:")) out.push((await store.get<StoredRun>(k))!);
  return out;
};

let seq = 0;
const setup = (store = new MemStore(), host = new FakeHost()) => {
  seq = 0;
  const r = createRunner({
    store,
    host,
    now: () => currentNow,
    newRunId: () => `run-${++seq}`,
  });
  return { store, host, runner: r };
};
const withFixtures = async (store = new MemStore(), host = new FakeHost()) => {
  const ctx = setup(store, host);
  await ctx.store.set("projects", fixtureProjects());
  await ctx.store.set("settings", fixtureSettings());
  return ctx;
};
let currentNow = 0;
const at = (iso: string) => (currentNow = Date.parse(iso));

// 2026-11-04: 00:00Z = 03:00 MSK, 01:00Z = 04:00 MSK, 03:00Z = 06:00 MSK, 06:00Z = 09:00 MSK.
const T0300 = "2026-11-04T00:00:00Z";
const T0400 = "2026-11-04T01:00:00Z";
const T0900 = "2026-11-04T06:00:00Z";

const alpha = fixtureProjects().find((p) => p.site === "alpha.example")!;

describe("runner tick", () => {
  it("starts night-export at 03:00 MSK for yesterday, once", async () => {
    const { runner, host } = await withFixtures();
    at(T0300);
    await runner.tick();
    expect(host.started).toHaveLength(1);
    expect(host.started[0].hostId).toBe("host_alpha");
    expect(host.started[0].script).toContain("search_window_2026-11-03.tsv");
    // second tick in the same minute starts nothing
    at("2026-11-04T00:00:30Z");
    await runner.tick();
    expect(host.started).toHaveLength(1);
    // the day after the boundary does not refire
    at("2026-11-04T00:01:00Z");
    await runner.tick();
    expect(host.started).toHaveLength(1);
  });

  it("catch-up refires at 04:00 MSK after a failed run, not after a green one", async () => {
    const { runner, host, store } = await withFixtures();
    at(T0300);
    await runner.tick();
    expect(host.started).toHaveLength(1);

    // the run finishes with a required stage failed
    host.nextStatus = {
      alive: false,
      exitCode: 1,
      stages: [
        { stageId: "export", status: "failed", exitCode: 1, startedAt: "2026-11-04T00:00:01Z", finishedAt: "2026-11-04T00:30:00Z", firstError: "TimeoutError" },
      ],
    };
    at("2026-11-04T00:01:00Z");
    await runner.tick();

    at(T0400);
    await runner.tick();
    // 04:00 MSK also fires the library-sync and weekly-tree schedules
    expect(host.started).toHaveLength(4);
    const all = await runs(store);
    const catchUp = all.find((r) => r.trigger === "catch-up");
    expect(catchUp).toBeDefined();
    expect(catchUp!.jobId).toBe("night-export");
    expect(catchUp!.day).toBe("2026-11-03");
    const catchUpStart = host.started.find((s) => s.script.includes("reused"));
    expect(catchUpStart).toBeDefined(); // catch-up script has reuse branches

    // now it finishes green: no more catch-up at 06:00 MSK
    host.nextStatus = {
      alive: false,
      exitCode: 0,
      stages: [{ stageId: "upload", status: "ok", exitCode: 0, startedAt: "2026-11-04T01:00:01Z", finishedAt: "2026-11-04T01:10:00Z", rowsOut: 5 }],
    };
    at("2026-11-04T01:01:00Z");
    await runner.tick();
    at("2026-11-04T03:00:00Z"); // 06:00 MSK catch-up hour
    await runner.tick();
    expect(host.started).toHaveLength(4);
  });

  it("a host that throws on start yields a failed row and the tick continues", async () => {
    const { runner, host, store } = await withFixtures();
    host.startError = new Error("connect ECONNREFUSED 10.0.0.1 token=abc123");
    // 00:00 MSK: library-sync and weekly-tree are both due
    at("2026-11-03T21:00:00Z");
    await runner.tick();
    expect(host.calls).toBe(2);
    const all = await runs(store);
    const failed = all.filter((r) => !r.alive);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const row = failed.flatMap((r) => r.rows).find((x) => x.status === "failed")!;
    expect(row.firstError).toMatch(/^host host_alpha unreachable/);
    expect(row.firstError).toContain("***");
    expect(row.firstError).not.toContain("abc123");
    // the other due job was still started
    expect(host.started).toHaveLength(1);
  });

  it("a due slot while a run is alive is recorded as skipped, not started", async () => {
    const { runner, host, store } = await withFixtures();
    host.nextStatus = { alive: true, stages: [] };
    at(T0300);
    await runner.tick();
    expect(host.started).toHaveLength(1);
    // restart the same slot manually while the run is alive
    const store2 = store;
    const all = await runs(store2);
    const alive = all.find((r) => r.alive)!;
    alive.rows.push({
      projectId: alpha.id, jobId: "night-export", day: "2026-11-03", runId: alive.runId,
      attempt: 1, trigger: "schedule", stageId: "night-export", status: "skipped",
      startedAt: "2026-11-04T00:00:30Z",
    });
    await store2.set(`run:${alive.projectId}:${alive.jobId}:${alive.day}:${alive.runId}`, alive);
    // a catch-up hour while running: isSettled is true (run alive) → no catch-up start;
    // library-sync and weekly-tree still fire their 04:00 MSK schedule
    at(T0400);
    await runner.tick();
    expect(host.started).toHaveLength(3);
    const after = await runs(store2);
    const night = after.find((r) => r.jobId === "night-export" && r.day === "2026-11-03")!;
    expect(night.rows.some((x) => x.status === "skipped")).toBe(true);
    expect(after.filter((r) => r.jobId === "night-export" && r.day === "2026-11-03")).toHaveLength(1);
  });

  it("a run that dies without stages is marked failed, not left running", async () => {
    const { runner, host, store } = await withFixtures();
    at(T0300);
    await runner.tick();
    expect(host.started).toHaveLength(1);
    host.nextStatus = { alive: false, exitCode: 1, stages: [] };
    at("2026-11-04T00:01:00Z");
    await runner.tick();
    const all = await runs(store);
    const dead = all.find((r) => r.jobId === "night-export")!;
    expect(dead.alive).toBe(false);
    expect(dead.exitCode).toBe(1);
    expect(dead.rows.some((x) => x.status === "running")).toBe(false);
    const failRow = dead.rows.find((x) => x.status === "failed")!;
    expect(failRow.firstError).toContain("1");
    const { dayStatus } = await import("../ledger.ts");
    const night = alpha.jobs.find((j) => j.id === "night-export")!;
    expect(dayStatus(dead.rows, night, "2026-11-03")).toBe("red");
    // a clean exit 0 with no stages (prelude early-exit) is skipped, not failed
    at("2026-11-04T01:00:00Z"); // 04:00 MSK: library-sync due
    await runner.tick();
    host.nextStatus = { alive: false, exitCode: 0, stages: [] };
    at("2026-11-04T01:01:00Z");
    await runner.tick();
    const after2 = await runs(store);
    const lib = after2.find((r) => r.jobId === "library-sync")!;
    expect(lib.alive).toBe(false);
    expect(lib.rows.some((x) => x.status === "running")).toBe(false);
    expect(lib.rows.some((x) => x.status === "skipped")).toBe(true);
    expect(lib.rows.some((x) => x.status === "failed")).toBe(false);
  });
});

describe("morning line", () => {
  it("sends once per Moscow day via host.notify, across runner restarts", async () => {
    const { runner, host, store } = await withFixtures();
    at(T0900);
    await runner.tick();
    expect(host.notifies).toHaveLength(1);
    expect(host.notifies[0].hostId).toBe("host_alpha");
    expect(host.notifies[0].command).toContain("{file}");
    expect(host.notifies[0].text).toContain("alpha.example");
    expect(host.notifies[0].text).toContain("Директ, запросы за 03.11");

    // another tick the same hour: still once
    at("2026-11-04T06:30:00Z");
    await runner.tick();
    expect(host.notifies).toHaveLength(1);

    // a new runner over the same store: still once
    const again = createRunner({ store, host, now: () => currentNow, newRunId: () => `x-${++seq}` });
    at("2026-11-04T06:45:00Z");
    await again.tick();
    expect(host.notifies).toHaveLength(1);

    // next Moscow day it sends again
    at("2026-11-05T06:00:00Z");
    await again.tick();
    expect(host.notifies).toHaveLength(2);
  });
});

describe("built-in pipeline schedule", () => {
  it("starts the pipeline in-process at 03:00 MSK with no host job", async () => {
    const store = new MemStore();
    const host = new FakeHost();
    const started: string[] = [];
    seq = 0;
    const runner = createRunner({
      store,
      host,
      now: () => currentNow,
      newRunId: () => `run-${++seq}`,
      pipeline: {
        run: async (project, day) => {
          started.push(`${project.id}:${day}`);
          return [] as LedgerRow[];
        },
        sync: async () => [],
      },
    });
    await store.set("projects", [fixturePipelineProject()]);
    await store.set("settings", fixtureSettings());
    at(T0300);
    await runner.tick();
    expect(host.started).toHaveLength(0);
    expect(started).toEqual(["gamma:2026-11-03"]);
  });
});

describe("seeding", () => {
  it("stores empty projects and default settings, and keeps later edits", async () => {
    const { runner, store } = setup();
    at(T0300);
    await runner.tick();
    const projects = (await store.get<Project[]>("projects"))!;
    expect(projects).toEqual([]);
    const settings = (await store.get<Settings>("settings"))!;
    expect(settings.morningLine.hour).toBe(9);
    expect(settings.morningLine.enabled).toBe(false);

    await store.set("projects", [{ ...alpha, title: "edited" }]);
    const again = createRunner({ store, host: new FakeHost(), now: () => currentNow, newRunId: () => `y-${++seq}` });
    at("2026-11-04T00:02:00Z");
    await again.tick();
    expect((await store.get<Project[]>("projects"))![0].title).toBe("edited");
  });
});
