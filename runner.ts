import type { Job, LedgerRow, Project, Settings, Stage } from "./model.ts";
import { buildJobScript } from "./jobscript.ts";
import { addDays, dueSlots, moscowParts } from "./slots.ts";
import { dayStatus, morningLine } from "./ledger.ts";
import { seedProjects, seedSettings } from "./seed.ts";

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface HostPort {
  start(
    hostId: string,
    input: { runId: string; cwd: string; script: string },
  ): Promise<{ pid: number }>;
  status(
    hostId: string,
    input: { runId: string },
  ): Promise<{ alive: boolean; exitCode?: number; stages: Record<string, unknown>[] }>;
  tail(
    hostId: string,
    input: { runId: string; stageId: string; lines?: number },
  ): Promise<{ out: string; err: string }>;
  notify(
    hostId: string,
    input: { command: string; text: string },
  ): Promise<{ exitCode: number }>;
}

export type Trigger = "schedule" | "catch-up" | "manual";

export interface StoredRun {
  projectId: string;
  jobId: string;
  day: string;
  runId: string;
  attempt: number;
  trigger: Trigger;
  pid?: number;
  alive: boolean;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  rows: LedgerRow[];
}

interface Meta {
  lastTick?: number;
  lastMorningDay?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const maskText = (s: string): string =>
  s
    .replace(/\b(token|key|password|secret)\b\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");

const hostError = (e: unknown): string =>
  maskText(e instanceof Error ? e.message : String(e)).slice(0, 200);

const runKey = (r: Pick<StoredRun, "projectId" | "jobId" | "day" | "runId">): string =>
  `run:${r.projectId}:${r.jobId}:${r.day}:${r.runId}`;

const runDirFor = (cwd: string, runId: string): string => {
  const parts = cwd.split("/").filter(Boolean);
  return `/${parts.slice(0, 2).join("/")}/.direct-queries/runs/${runId}`;
};

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const baseRow = (run: StoredRun, stageId: string): LedgerRow => ({
  projectId: run.projectId,
  jobId: run.jobId,
  day: run.day,
  runId: run.runId,
  attempt: run.attempt,
  trigger: run.trigger,
  stageId,
  status: "ok",
  startedAt: run.startedAt,
});

const toRows = (run: StoredRun, stages: Record<string, unknown>[]): LedgerRow[] =>
  stages.map((s) => {
    const startedAt = str(s.startedAt) ?? run.startedAt;
    const finishedAt = str(s.finishedAt);
    return {
      ...baseRow(run, str(s.stageId) ?? "?"),
      status: (str(s.status) ?? "ok") as LedgerRow["status"],
      startedAt,
      finishedAt,
      durationSec:
        finishedAt !== undefined
          ? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000))
          : undefined,
      rowsIn: num(s.rowsIn),
      rowsOut: num(s.rowsOut),
      paid: s.paid as LedgerRow["paid"],
      judge: str(s.judge),
      firstError: s.firstError === undefined ? undefined : maskText(String(s.firstError)),
    };
  });

const markerRow = (run: StoredRun, stageId: string): LedgerRow => ({
  ...baseRow(run, stageId),
  status: "running",
});

export function createRunner(args: {
  store: Store;
  host: HostPort;
  now: () => number;
  newRunId: () => string;
}) {
  const { store, host, now, newRunId } = args;

  let ensured = false;
  const ensure = async (): Promise<void> => {
    if (ensured) return;
    ensured = true;
    if ((await store.get("projects")) === undefined) await store.set("projects", seedProjects());
    if ((await store.get("settings")) === undefined) await store.set("settings", seedSettings());
  };

  const loadProjects = async (): Promise<Project[]> => (await store.get<Project[]>("projects")) ?? [];
  const loadSettings = async (): Promise<Settings> =>
    (await store.get<Settings>("settings")) ?? seedSettings();
  const loadRuns = async (): Promise<StoredRun[]> => {
    const out: StoredRun[] = [];
    for (const key of await store.list("run:")) {
      const run = await store.get<StoredRun>(key);
      if (run !== undefined) out.push(run);
    }
    return out;
  };
  const saveRun = (run: StoredRun): Promise<void> => store.set(runKey(run), run);

  const jobOf = (projects: Project[], pid: string, jid: string): Job | undefined =>
    projects.find((p) => p.id === pid)?.jobs.find((j) => j.id === jid);

  const reportDay = (job: Job, ms: number): string => {
    const m = moscowParts(ms);
    return job.reportDay === "yesterday" ? addDays(m.date, -1) : m.date;
  };

  const startOne = async (
    projects: Project[],
    runs: StoredRun[],
    projectId: string,
    jobId: string,
    day: string,
    trigger: Trigger,
  ): Promise<StoredRun> => {
    const project = projects.find((p) => p.id === projectId);
    const job = jobOf(projects, projectId, jobId);
    if (!project || !job) throw new Error("jobMissing");
    if (runs.some((r) => r.projectId === projectId && r.jobId === jobId && r.alive))
      throw new Error("jobRunning");
    const runId = newRunId();
    const firstStage = job.stages[0]?.id ?? job.id;
    const run: StoredRun = {
      projectId,
      jobId,
      day,
      runId,
      attempt: runs.filter((r) => r.projectId === projectId && r.jobId === jobId && r.day === day).length + 1,
      trigger,
      alive: true,
      startedAt: iso(now()),
      rows: [],
    };
    run.rows = [markerRow(run, firstStage)];
    const script = buildJobScript(job, {
      date: day,
      cwd: project.cwd,
      runDir: runDirFor(project.cwd, runId),
      catchUp: trigger === "catch-up",
    });
    try {
      const { pid } = await host.start(project.hostId, { runId, cwd: project.cwd, script });
      run.pid = pid;
    } catch (e) {
      run.alive = false;
      run.finishedAt = iso(now());
      run.rows = [
        {
          ...baseRow(run, job.id),
          status: "failed",
          finishedAt: run.finishedAt,
          firstError: `host ${project.hostId} unreachable: ${hostError(e)}`,
        },
      ];
    }
    runs.push(run);
    await saveRun(run);
    return run;
  };

  const tick = async (): Promise<void> => {
    await ensure();
    const at = now();
    const projects = await loadProjects();
    const settings = await loadSettings();
    const meta = (await store.get<Meta>("meta")) ?? {};
    const lastTick = meta.lastTick ?? at - 60000;
    const runs = await loadRuns();

    // 1. poll in-flight runs on their hosts
    for (const run of runs.filter((r) => r.alive)) {
      const project = projects.find((p) => p.id === run.projectId);
      const job = jobOf(projects, run.projectId, run.jobId);
      if (!project || !job) {
        run.alive = false;
        run.finishedAt = iso(at);
        await saveRun(run);
        continue;
      }
      try {
        const st = await host.status(project.hostId, { runId: run.runId });
        const skipped = run.rows.filter((r) => r.status === "skipped");
        if (st.stages.length > 0) run.rows = [...toRows(run, st.stages), ...skipped];
        if (!st.alive) {
          run.alive = false;
          run.finishedAt = iso(at);
          run.exitCode = st.exitCode;
          run.rows = run.rows.filter((r) => r.status !== "running");
          if (st.stages.length === 0)
            run.rows.push({
              ...baseRow(run, job.id),
              status: st.exitCode === 0 ? "skipped" : "failed",
              finishedAt: run.finishedAt,
              firstError:
                st.exitCode === 0 ? undefined : `exit ${st.exitCode ?? "unknown"}`,
            });
        } else {
          const next = job.stages.find((s: Stage) => !run.rows.some((r) => r.stageId === s.id));
          run.rows = run.rows.filter((r) => r.status !== "running");
          run.rows.push(markerRow(run, next?.id ?? job.stages[job.stages.length - 1]?.id ?? job.id));
        }
      } catch {
        // host unreachable this tick: keep the run alive; timeoutMin bounds it
      }
      if (run.alive && at - Date.parse(run.startedAt) > job.timeoutMin * 60000) {
        run.alive = false;
        run.finishedAt = iso(at);
        run.rows = run.rows.filter((r) => r.status !== "running");
        run.rows.push({
          ...baseRow(run, "timeout"),
          status: "failed",
          finishedAt: run.finishedAt,
          firstError: "timeout",
        });
      }
      await saveRun(run);
    }

    // 2. morning line, once per Moscow day
    const m = moscowParts(at);
    if (
      settings.morningLine.enabled &&
      m.hour === settings.morningLine.hour &&
      meta.lastMorningDay !== m.date
    ) {
      const day = addDays(m.date, -1);
      const dayRows = runs.flatMap((r) => (r.day === day ? r.rows : []));
      const text = morningLine(projects, dayRows, day);
      try {
        await host.notify(settings.morningLine.hostId, {
          command: settings.morningLine.command,
          text,
        });
        meta.lastMorningDay = m.date;
      } catch {
        // notify failed: retry on the next tick of this Moscow hour
      }
    }

    // 3. start due jobs
    const isSettled = (pid: string, jid: string, day: string): boolean =>
      runs.some((r) => {
        if (r.projectId !== pid || r.jobId !== jid || r.day !== day) return false;
        if (r.alive) return true;
        const job = jobOf(projects, pid, jid);
        if (!job) return false;
        const s = dayStatus(r.rows.filter((x) => x.status !== "skipped"), job, day);
        return s === "green" || s === "grey";
      });
    for (const due of dueSlots(projects, lastTick, at, isSettled)) {
      const running = runs.find(
        (r) => r.projectId === due.projectId && r.jobId === due.jobId && r.alive,
      );
      const job = jobOf(projects, due.projectId, due.jobId);
      if (running && job) {
        running.rows.push({
          ...baseRow(running, job.id),
          status: "skipped",
          finishedAt: iso(at),
          firstError: `${due.trigger} slot while run ${running.runId} is running`,
        });
        await saveRun(running);
        continue;
      }
      try {
        await startOne(projects, runs, due.projectId, due.jobId, due.day, due.trigger);
      } catch {
        // a missing job/project must not stop the rest of the tick
      }
    }

    meta.lastTick = at;
    await store.set("meta", meta);
  };

  return {
    tick,

    async start(
      projectId: string,
      jobId: string,
      day?: string,
      trigger: Trigger = "manual",
    ): Promise<{ runId: string; day: string }> {
      await ensure();
      const projects = await loadProjects();
      const job = jobOf(projects, projectId, jobId);
      const run = await startOne(
        projects,
        await loadRuns(),
        projectId,
        jobId,
        day ?? (job ? reportDay(job, now()) : moscowParts(now()).date),
        trigger,
      );
      return { runId: run.runId, day: run.day };
    },

    async overview(days: number = 7): Promise<{
      days: string[];
      projects: Array<{
        projectId: string;
        title: string;
        site: string;
        enabled: boolean;
        jobs: Array<{
          jobId: string;
          title: string;
          enabled: boolean;
          cells: Array<{ day: string; status: string }>;
          lastRun?: { runId: string; day: string; trigger: Trigger; status: string; finishedAt?: string };
        }>;
      }>;
    }> {
      await ensure();
      const projects = await loadProjects();
      const runs = await loadRuns();
      const today = moscowParts(now()).date;
      const dates: string[] = [];
      for (let i = days - 1; i >= 0; i--) dates.push(addDays(today, -i));
      return {
        days: dates,
        projects: projects.map((p) => ({
          projectId: p.id,
          title: p.title,
          site: p.site,
          enabled: p.enabled,
          jobs: p.jobs.map((j) => {
            const mine = runs.filter((r) => r.projectId === p.id && r.jobId === j.id);
            const latest = mine
              .slice()
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
            return {
              jobId: j.id,
              title: j.title,
              enabled: j.enabled,
              cells: dates.map((d) => ({
                day: d,
                status: dayStatus(
                  mine.flatMap((r) => (r.day === d ? r.rows : [])),
                  j,
                  d,
                ),
              })),
              ...(latest === undefined
                ? {}
                : {
                    lastRun: {
                      runId: latest.runId,
                      day: latest.day,
                      trigger: latest.trigger,
                      status: dayStatus(latest.rows, j, latest.day),
                      finishedAt: latest.finishedAt,
                    },
                  }),
            };
          }),
        })),
      };
    },

    async ledger(projectId: string, day?: string, limit: number = 100): Promise<LedgerRow[]> {
      await ensure();
      const runs = await loadRuns();
      return runs
        .filter((r) => r.projectId === projectId && (day === undefined || r.day === day))
        .flatMap((r) => r.rows)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit);
    },
  };
}
