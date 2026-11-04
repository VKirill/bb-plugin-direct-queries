import { describe, it, expect } from "vitest";
import { buildJobScript } from "../jobscript.ts";
import type { Job, Stage } from "../model.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const st = (id: string, command: string, extra: Partial<Stage> = {}): Stage => ({
  id,
  title: id,
  command,
  required: true,
  outputs: [],
  reuse: false,
  emptyStops: false,
  ...extra,
});

const job = (stages: Stage[], prelude = ""): Job => ({
  id: "night-export",
  title: "Night",
  hours: [3],
  minute: 0,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  reportDay: "yesterday",
  prelude,
  stages,
  catchUpHours: [4],
  timeoutMin: 60,
  enabled: true,
});

function run(script: string, work: string): number {
  const file = path.join(work, "job.sh");
  writeFileSync(file, script);
  const res = spawnSync("sh", [file], { cwd: work });
  return res.status ?? 1;
}

function stages(runDir: string): Array<Record<string, unknown>> {
  const text = readFileSync(path.join(runDir, "stages.jsonl"), "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

function byId(list: Array<Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(list.map((l) => [l.stageId, l]));
}

const DATE = "2026-11-03";

describe("buildJobScript", () => {
  it("runs stages in order, counts rows, parses DQ_METRICS, exits 0", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job(
        [
          st("a", "printf 'h\\nx\\ny\\n' > out_{date}.csv; echo 'DQ_METRICS {\"jev\":3,\"judge\":\"jev\"}'", { outputs: ["out_{date}.csv"] }),
          st("b", "printf 'h\\nr\\n' > b_{date}.csv", { outputs: ["b_{date}.csv"] }),
        ],
        "export DQX=1",
      ),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(0);
    const by = byId(stages(runDir));
    expect(by.a.status).toBe("ok");
    expect(by.a.rowsOut).toBe(2);
    expect(by.a.paid).toEqual({ jev: 3 });
    expect(by.a.judge).toBe("jev");
    expect(by.b.status).toBe("ok");
    expect(by.b.rowsIn).toBe(2);
    expect(by.b.rowsOut).toBe(1);
    expect(readFileSync(path.join(runDir, "exit"), "utf8").trim()).toBe("0");
  });

  it("optional failure is recorded and the job goes on, ending with exit 1", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job([
        st("a", "echo boom >&2; exit 2", { required: false }),
        st("b", "touch b_ran"),
      ]),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(1);
    const by = byId(stages(runDir));
    expect(by.a.status).toBe("failed");
    expect(by.a.exitCode).toBe(2);
    expect(by.a.firstError).toBe("boom");
    expect(by.b.status).toBe("ok");
    expect(existsSync(path.join(work, "b_ran"))).toBe(true);
  });

  it("required failure is recorded and no later stage runs", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job([
        st("a", "echo fatal-line >&2; exit 1"),
        st("b", "touch b_ran"),
      ]),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(1);
    const list = stages(runDir);
    const by = byId(list);
    expect(by.a.status).toBe("failed");
    expect(by.a.firstError).toBe("fatal-line");
    expect(list).toHaveLength(1);
    expect(existsSync(path.join(work, "b_ran"))).toBe(false);
  });

  it("catch-up reuses non-empty outputs without running the command", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    writeFileSync(path.join(work, `snap_${DATE}.tsv`), "h\nrow\n");
    const script = buildJobScript(
      job([
        st("snap", "touch snap_ran; exit 9", { outputs: ["snap_{date}.tsv"], reuse: true }),
        st("b", "touch b_ran"),
      ]),
      { date: DATE, cwd: work, runDir, catchUp: true },
    );
    expect(run(script, work)).toBe(0);
    const by = byId(stages(runDir));
    expect(by.snap.status).toBe("reused");
    expect(by.snap.rowsOut).toBe(1);
    expect(by.b.status).toBe("ok");
    expect(by.b.rowsIn).toBe(1);
    expect(existsSync(path.join(work, "snap_ran"))).toBe(false);
  });

  it("reuse stage runs when an output is missing or empty", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    writeFileSync(path.join(work, `snap_${DATE}.tsv`), "");
    const script = buildJobScript(
      job([st("snap", "printf 'h\\nr\\n' > snap_{date}.tsv", { outputs: ["snap_{date}.tsv"], reuse: true })]),
      { date: DATE, cwd: work, runDir, catchUp: true },
    );
    expect(run(script, work)).toBe(0);
    const by = byId(stages(runDir));
    expect(by.snap.status).toBe("ok");
    expect(by.snap.rowsOut).toBe(1);
  });

  it("emptyStops with 0 data rows ends as no-shows, later stages skipped, exit 0", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job([
        st("snap", "printf 'h\\n' > snap_{date}.tsv", { outputs: ["snap_{date}.tsv"], emptyStops: true }),
        st("upload", "touch up_ran"),
      ]),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(0);
    const by = byId(stages(runDir));
    expect(by.snap.status).toBe("no-shows");
    expect(by.snap.rowsOut).toBe(0);
    expect(by.upload).toBeUndefined();
    expect(existsSync(path.join(work, "up_ran"))).toBe(false);
  });

  it("no-shows keeps exit 1 when an earlier optional stage failed", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job([
        st("opt", "exit 7", { required: false }),
        st("snap", "printf 'h\\n' > snap_{date}.tsv", { outputs: ["snap_{date}.tsv"], emptyStops: true }),
        st("upload", "touch up_ran"),
      ]),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(1);
    const by = byId(stages(runDir));
    expect(by.opt.status).toBe("failed");
    expect(by.snap.status).toBe("no-shows");
    expect(by.upload).toBeUndefined();
  });

  it("ignores a non-JSON DQ_METRICS line without breaking the JSONL", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job([st("a", "echo 'DQ_METRICS not json at all'; echo done")]),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(0);
    const by = byId(stages(runDir));
    expect(by.a.status).toBe("ok");
    expect(by.a.paid).toBeUndefined();
    expect(by.a.judge).toBeUndefined();
  });

  it("JSON-escapes stderr lines with quotes and backslashes", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job([st("a", "printf 'bad \"quoted\" \\\\ line\\n' >&2; exit 1")]),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(1);
    const by = byId(stages(runDir));
    expect(by.a.status).toBe("failed");
    expect(by.a.firstError).toBe('bad "quoted" \\ line');
  });

  it("prelude exports reach every stage", () => {
    const work = mkdtempSync("/tmp/dq-js-");
    const runDir = path.join(work, "run");
    mkdirSync(runDir);
    const script = buildJobScript(
      job([st("a", "test \"$DQX\" = 1")], "export DQX=1"),
      { date: DATE, cwd: work, runDir, catchUp: false },
    );
    expect(run(script, work)).toBe(0);
    const by = byId(stages(runDir));
    expect(by.a.status).toBe("ok");
  });
});
