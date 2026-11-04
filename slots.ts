import type { Project } from "./model.ts";

export type Due = {
  projectId: string;
  jobId: string;
  day: string;
  trigger: "schedule" | "catch-up";
};

const MINUTE = 60000;
const WALK_CAP = 3 * 24 * 3600 * 1000;

const moscowFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function moscowParts(ms: number): { date: string; hour: number; minute: number; weekday: number } {
  const parts = moscowFmt.formatToParts(ms);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dueSlots(
  projects: Project[],
  lastTick: number,
  now: number,
  isSettled: (projectId: string, jobId: string, day: string) => boolean,
): Due[] {
  const due: Due[] = [];
  const seen = new Set<string>();
  let start = Math.floor(lastTick / MINUTE) * MINUTE + MINUTE;
  const cap = Math.ceil((now - WALK_CAP) / MINUTE) * MINUTE;
  if (start < cap) start = cap;
  for (let t = start; t <= now; t += MINUTE) {
    const m = moscowParts(t);
    for (const p of projects) {
      if (!p.enabled) continue;
      for (const j of p.jobs) {
        if (!j.enabled || !j.weekdays.includes(m.weekday)) continue;
        if (m.minute !== j.minute) continue;
        const day = j.reportDay === "yesterday" ? addDays(m.date, -1) : m.date;
        if (j.hours.includes(m.hour)) {
          const key = `${p.id} ${j.id} ${day} schedule`;
          if (!seen.has(key)) {
            seen.add(key);
            due.push({ projectId: p.id, jobId: j.id, day, trigger: "schedule" });
          }
        }
        if (j.catchUpHours.includes(m.hour) && !isSettled(p.id, j.id, day)) {
          const key = `${p.id} ${j.id} ${day} catch-up`;
          if (!seen.has(key)) {
            seen.add(key);
            due.push({ projectId: p.id, jobId: j.id, day, trigger: "catch-up" });
          }
        }
      }
    }
  }
  return due;
}
