import type { Job, LedgerRow, Project } from "./model.ts";

export type DayStatus = "green" | "amber" | "red" | "grey" | "empty" | "running";

function latestRun(rows: LedgerRow[]): LedgerRow[] {
  if (rows.length === 0) return rows;
  let max = rows[0].startedAt;
  for (const r of rows) if (r.startedAt > max) max = r.startedAt;
  const runId = rows.find((r) => r.startedAt === max)?.runId;
  return rows.filter((r) => r.runId === runId);
}

function isRequired(job: Job, stageId: string): boolean {
  return job.stages.find((s) => s.id === stageId)?.required ?? true;
}

function weekdayOf(day: string): number {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function dayStatus(rows: LedgerRow[], job: Job, day: string): DayStatus {
  const own = rows.filter((r) => r.jobId === job.id && r.day === day);
  if (own.length === 0) {
    if (!job.enabled) return "grey";
    if (!job.weekdays.includes(weekdayOf(day))) return "grey";
    return "empty";
  }
  const run = latestRun(own);
  if (run.some((r) => r.status === "running")) return "running";
  if (run.some((r) => r.status === "no-shows")) return "grey";
  const failed = run.filter((r) => r.status === "failed");
  if (failed.some((r) => isRequired(job, r.stageId))) return "red";
  if (failed.length > 0) return "amber";
  return "green";
}

export function morningLine(projects: Project[], rows: LedgerRow[], day: string): string {
  const dd = day.slice(8, 10);
  const mm = day.slice(5, 7);
  const lines = [`Директ, запросы за ${dd}.${mm}`];
  for (const p of projects) {
    if (!p.enabled) continue;
    const job =
      p.jobs.find((j) => j.id === "night-export" && j.enabled) ??
      p.jobs.find((j) => j.enabled) ??
      p.jobs[0];
    if (!job) continue;
    const own = rows.filter((r) => r.projectId === p.id && r.jobId === job.id && r.day === day);
    const status = dayStatus(own, job, day);
    const run = latestRun(own);
    const stageTitle = (stageId: string): string =>
      job.stages.find((s) => s.id === stageId)?.title ?? stageId;
    switch (status) {
      case "green":
      case "amber": {
        const exp =
          run.find((r) => r.stageId === "export") ??
          [...run].reverse().find((r) => r.rowsOut !== undefined);
        const cand = run.find((r) => r.stageId === "candidates");
        let line = `✅ ${p.site}: ${exp?.rowsOut ?? "—"} запросов, ${cand?.rowsOut ?? "—"} кандидатов в минус`;
        if (status === "amber") {
          const names = run.filter((r) => r.status === "failed").map((r) => stageTitle(r.stageId));
          if (names.length > 0) line += `, без: ${names.join(", ")}`;
        }
        lines.push(line);
        break;
      }
      case "red": {
        const f =
          run.find((r) => r.status === "failed" && isRequired(job, r.stageId)) ??
          run.find((r) => r.status === "failed");
        lines.push(`❌ ${p.site}: упало на «${stageTitle(f?.stageId ?? "?")}»: ${f?.firstError ?? "ошибка"}`);
        break;
      }
      case "grey":
        lines.push(`⚪ ${p.site}: показов не было`);
        break;
      case "running":
        lines.push(`⏳ ${p.site}: ещё идёт`);
        break;
      default:
        lines.push(`❔ ${p.site}: не запускался`);
    }
  }
  return lines.join("\n");
}
