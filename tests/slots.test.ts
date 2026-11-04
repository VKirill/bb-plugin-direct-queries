import { describe, it, expect } from "vitest";
import { dueSlots, moscowParts, addDays } from "../slots.ts";
import { fixtureProjects } from "./fixtures/projects.ts";
import type { Job, Project } from "../model.ts";

const projects = fixtureProjects();
const alpha = projects.find((p) => p.site === "alpha.example")!;
const beta = projects.find((p) => p.site === "beta.example")!;
const never = () => false;
const always = () => true;

// 2026-11-04 is a Wednesday; 00:00Z = 03:00 MSK, 03:00Z = 06:00 MSK.
const t0300 = Date.parse("2026-11-04T00:00:00Z");

describe("moscowParts", () => {
  it("computes Moscow wall time", () => {
    expect(moscowParts(t0300)).toEqual({ date: "2026-11-04", hour: 3, minute: 0, weekday: 3 });
    expect(addDays("2026-11-04", -1)).toBe("2026-11-03");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("dueSlots", () => {
  it("fires night-export at 03:00 MSK for yesterday", () => {
    const due = dueSlots(projects, t0300 - 60000, t0300, never);
    expect(due).toContainEqual({
      projectId: alpha.id,
      jobId: "night-export",
      day: "2026-11-03",
      trigger: "schedule",
    });
  });

  it("does not fire twice across consecutive ticks", () => {
    const first = dueSlots(projects, t0300 - 60000, t0300, never);
    const second = dueSlots(projects, t0300, t0300 + 60000, never);
    expect(first.filter((d) => d.jobId === "night-export")).toHaveLength(1);
    expect(second.filter((d) => d.jobId === "night-export")).toHaveLength(0);
  });

  it("fires catch-up at 04, 06, 09, 12 MSK only while unsettled", () => {
    for (const [utc, msk] of [
      ["2026-11-04T01:00:00Z", 4],
      ["2026-11-04T03:00:00Z", 6],
      ["2026-11-04T06:00:00Z", 9],
      ["2026-11-04T09:00:00Z", 12],
    ] as const) {
      const t = Date.parse(utc);
      const due = dueSlots(projects, t - 60000, t, never);
      expect(due, `${msk}:00 MSK catch-up`).toContainEqual({
        projectId: alpha.id,
        jobId: "night-export",
        day: "2026-11-03",
        trigger: "catch-up",
      });
      expect(dueSlots(projects, t - 60000, t, always).some((d) => d.jobId === "night-export")).toBe(false);
    }
    // 05:00 MSK is not a catch-up hour
    const t0500 = Date.parse("2026-11-04T02:00:00Z");
    expect(dueSlots(projects, t0500 - 60000, t0500, never).some((d) => d.jobId === "night-export")).toBe(false);
  });

  it("catches up missed slots after a 2h gap", () => {
    const due = dueSlots(projects, t0300 - 2 * 3600 * 1000, t0300, never);
    expect(due).toContainEqual({
      projectId: alpha.id,
      jobId: "night-export",
      day: "2026-11-03",
      trigger: "schedule",
    });
    // only once even though the window is long
    expect(due.filter((d) => d.jobId === "night-export" && d.trigger === "schedule")).toHaveLength(1);
  });

  it("skips disabled projects and jobs outside weekdays", () => {
    expect(dueSlots(projects, t0300 - 60000, t0300, never).some((d) => d.projectId === beta.id)).toBe(false);
    const tuesdayOnly: Job = { ...alpha.jobs[0], id: "tue-job", weekdays: [2] };
    const p: Project[] = [{ ...alpha, jobs: [tuesdayOnly] }];
    expect(dueSlots(p, t0300 - 60000, t0300, never)).toHaveLength(0);
    const disabledJob: Job = { ...alpha.jobs[0], id: "off-job", enabled: false };
    const p2: Project[] = [{ ...alpha, jobs: [disabledJob] }];
    expect(dueSlots(p2, t0300 - 60000, t0300, never)).toHaveLength(0);
  });

  it("fires bids at :03 and beta autominus stays off", () => {
    // 06:03 MSK = 03:03Z
    const t0603 = Date.parse("2026-11-04T03:03:00Z");
    const due = dueSlots(projects, t0603 - 60000, t0603, never);
    expect(due).toContainEqual({ projectId: alpha.id, jobId: "bids", day: "2026-11-04", trigger: "schedule" });
    expect(due.some((d) => d.projectId === beta.id)).toBe(false);
  });
});
