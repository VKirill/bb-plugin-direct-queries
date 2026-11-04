import { describe, it, expect } from "vitest";
import { dayStatus, morningLine } from "../ledger.ts";
import { fixtureProjects } from "./fixtures/projects.ts";
import type { LedgerRow } from "../model.ts";

const projects = fixtureProjects();
const alpha = projects.find((p) => p.site === "alpha.example")!;
const night = alpha.jobs.find((j) => j.id === "night-export")!;
const DAY = "2026-11-03";

const row = (stageId: string, status: LedgerRow["status"], extra: Partial<LedgerRow> = {}): LedgerRow => ({
  projectId: alpha.id,
  jobId: "night-export",
  day: DAY,
  runId: "r1",
  attempt: 1,
  trigger: "schedule",
  stageId,
  status,
  startedAt: "2026-11-04T00:00:00Z",
  ...extra,
});

describe("dayStatus", () => {
  it("green when all stages ok", () => {
    expect(dayStatus([row("export", "ok"), row("upload", "ok")], night, DAY)).toBe("green");
    expect(dayStatus([row("snapshot", "reused"), row("export", "ok")], night, DAY)).toBe("green");
  });

  it("amber when an optional stage failed", () => {
    expect(dayStatus([row("serp-review", "failed"), row("upload", "ok")], night, DAY)).toBe("amber");
  });

  it("red when a required stage failed", () => {
    expect(dayStatus([row("serp-review", "ok"), row("export", "failed")], night, DAY)).toBe("red");
  });

  it("grey on no-shows, disabled job or off-weekday", () => {
    expect(dayStatus([row("snapshot", "no-shows")], night, DAY)).toBe("grey");
    expect(dayStatus([], { ...night, enabled: false }, DAY)).toBe("grey");
    // 2026-11-03 is a Tuesday; a job that only runs Mondays has no rows and is grey
    expect(dayStatus([], { ...night, weekdays: [1] }, DAY)).toBe("grey");
  });

  it("empty when not run on a scheduled weekday", () => {
    expect(dayStatus([], night, DAY)).toBe("empty");
  });

  it("running when any stage is running", () => {
    expect(dayStatus([row("snapshot", "ok"), row("audit", "running")], night, DAY)).toBe("running");
  });

  it("uses only the latest run's rows", () => {
    const old = row("export", "failed", { runId: "r0", startedAt: "2026-11-03T23:00:00Z" });
    const fresh = row("export", "ok", { runId: "r2", startedAt: "2026-11-04T01:00:00Z" });
    expect(dayStatus([old, fresh], night, DAY)).toBe("green");
    const freshBad = row("export", "failed", { runId: "r3", startedAt: "2026-11-04T02:00:00Z" });
    expect(dayStatus([old, fresh, freshBad], night, DAY)).toBe("red");
  });
});

describe("morningLine", () => {
  it("starts with the Russian header for the day", () => {
    const text = morningLine(projects, [], DAY);
    expect(text.split("\n")[0]).toBe("Директ, запросы за 03.11");
  });

  it("green line shows queries and candidates", () => {
    const rows = [
      row("export", "ok", { rowsOut: 357 }),
      row("candidates", "ok", { rowsOut: 12 }),
      row("upload", "ok"),
    ];
    const text = morningLine(projects, rows, DAY);
    expect(text).toContain("✅ alpha.example: 357 запросов, 12 кандидатов в минус");
  });

  it("amber line names the failed optional stages", () => {
    const rows = [
      row("export", "ok", { rowsOut: 10 }),
      row("serp-review", "failed", { firstError: "boom" }),
      row("upload", "ok"),
    ];
    const text = morningLine(projects, rows, DAY);
    expect(text).toContain("без: Проверка выдачи");
  });

  it("red line names the failed stage and its firstError", () => {
    const text = morningLine(projects, [row("export", "failed", { firstError: "TimeoutError: read" })], DAY);
    expect(text).toContain("❌ alpha.example: упало на «Выгрузка клиенту»: TimeoutError: read");
  });

  it("grey, running and empty lines", () => {
    expect(morningLine(projects, [row("snapshot", "no-shows")], DAY)).toContain("⚪ alpha.example: показов не было");
    expect(morningLine(projects, [row("snapshot", "running")], DAY)).toContain("⏳ alpha.example: ещё идёт");
    expect(morningLine(projects, [], DAY)).toContain("❔ alpha.example: не запускался");
  });

  it("skips disabled projects", () => {
    const text = morningLine(projects, [], DAY);
    expect(text).not.toContain("beta.example");
  });
});
