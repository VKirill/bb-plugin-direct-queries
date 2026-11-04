import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { buildJobScript } from "../jobscript.ts";
import type { Job, Stage } from "../model.ts";
import entry from "../host.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
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

const job = (stages: Stage[]): Job => ({
  id: "j",
  title: "J",
  hours: [3],
  minute: 0,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  reportDay: "today",
  prelude: "",
  stages,
  catchUpHours: [],
  timeoutMin: 60,
  enabled: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("host entry", () => {
  let home: string;
  let work: string;
  let oldHome: string | undefined;

  beforeAll(() => {
    oldHome = process.env.HOME;
    home = mkdtempSync("/tmp/dq-home-");
    work = mkdtempSync("/tmp/dq-work-");
    process.env.HOME = home;
  });

  afterAll(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  });

  it("start returns a pid while the job runs; status reports the finished run", async () => {
    const harness = experimental_createHostEntryHarness(entry);
    try {
      const runId = "run1";
      const runDir = path.join(home, ".direct-queries", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const script = buildJobScript(
        job([st("slow", "sleep 1"), st("fast", "echo done")]),
        { date: "2026-11-04", cwd: work, runDir, catchUp: false },
      );
      const { pid } = await harness.experimental_call("start", { runId, cwd: work, script });
      expect(pid).toBeGreaterThan(0);

      const during = await harness.experimental_call("status", { runId });
      expect(during.alive).toBe(true);

      let after = during;
      for (let i = 0; i < 40 && after.alive; i++) {
        await sleep(250);
        after = await harness.experimental_call("status", { runId });
      }
      expect(after.alive).toBe(false);
      expect(after.exitCode).toBe(0);
      expect(after.stages.map((s) => s.stageId)).toEqual(["slow", "fast"]);
      expect(after.stages.every((s) => s.status === "ok")).toBe(true);

      const tail = await harness.experimental_call("tail", { runId, stageId: "fast", lines: 10 });
      expect(tail.out).toContain("done");
    } finally {
      await harness.experimental_dispose();
    }
  }, 20000);

  it("rejects a bad runId and a missing cwd", async () => {
    const harness = experimental_createHostEntryHarness(entry);
    try {
      await expect(
        harness.experimental_call("start", { runId: "../evil", cwd: work, script: "true" }),
      ).rejects.toThrow();
      await expect(
        harness.experimental_call("start", { runId: "run2", cwd: path.join(work, "nope"), script: "true" }),
      ).rejects.toThrow("cwdInvalid");
      await expect(
        harness.experimental_call("start", { runId: "run3", cwd: "relative/path", script: "true" }),
      ).rejects.toThrow("cwdInvalid");
    } finally {
      await harness.experimental_dispose();
    }
  });

  it("status of an unknown run is not alive and has no stages", async () => {
    const harness = experimental_createHostEntryHarness(entry);
    try {
      const s = await harness.experimental_call("status", { runId: "nope" });
      expect(s.alive).toBe(false);
      expect(s.exitCode).toBeUndefined();
      expect(s.stages).toEqual([]);
    } finally {
      await harness.experimental_dispose();
    }
  });

  it("notify replaces {file} and returns the exit code", async () => {
    const harness = experimental_createHostEntryHarness(entry);
    try {
      const ok = await harness.experimental_call("notify", {
        command: "grep -q hello {file}",
        text: "hello world",
      });
      expect(ok.exitCode).toBe(0);
      const bad = await harness.experimental_call("notify", {
        command: "grep -q absent {file}",
        text: "hello world",
      });
      expect(bad.exitCode).toBe(1);
    } finally {
      await harness.experimental_dispose();
    }
  });
});
