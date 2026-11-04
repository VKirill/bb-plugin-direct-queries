import { z } from "zod";

export const stageSchema = z.object({
  id: z.string(),
  title: z.string(),
  command: z.string(),
  required: z.boolean(),
  outputs: z.array(z.string()),
  reuse: z.boolean(),
  emptyStops: z.boolean(),
});
export type Stage = z.infer<typeof stageSchema>;

export const jobSchema = z.object({
  id: z.string(),
  title: z.string(),
  hours: z.array(z.number().int().min(0).max(23)),
  minute: z.number().int().min(0).max(59),
  weekdays: z.array(z.number().int().min(1).max(7)),
  reportDay: z.enum(["yesterday", "today"]),
  prelude: z.string(),
  stages: z.array(stageSchema),
  catchUpHours: z.array(z.number().int().min(0).max(23)),
  timeoutMin: z.number(),
  enabled: z.boolean(),
});
export type Job = z.infer<typeof jobSchema>;

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  site: z.string(),
  hostId: z.string(),
  cwd: z.string(),
  direct: z.object({
    account: z.string(),
    clientLogin: z.string().optional(),
    campaignFilter: z.string().optional(),
  }),
  sheetId: z.string().optional(),
  notes: z.string().optional(),
  enabled: z.boolean(),
  jobs: z.array(jobSchema),
});
export type Project = z.infer<typeof projectSchema>;

export const settingsSchema = z.object({
  morningLine: z.object({
    enabled: z.boolean(),
    hostId: z.string(),
    command: z.string(),
    hour: z.number().int().min(0).max(23),
  }),
  timeZone: z.literal("Europe/Moscow"),
});
export type Settings = z.infer<typeof settingsSchema>;

export const ledgerRowSchema = z.object({
  projectId: z.string(),
  jobId: z.string(),
  day: z.string(),
  runId: z.string(),
  attempt: z.number(),
  trigger: z.enum(["schedule", "catch-up", "manual"]),
  stageId: z.string(),
  status: z.enum(["ok", "failed", "skipped", "reused", "no-shows", "running"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationSec: z.number().optional(),
  rowsIn: z.number().optional(),
  rowsOut: z.number().optional(),
  paid: z
    .object({
      xmlstock: z.number().optional(),
      jev: z.number().optional(),
      spendRub: z.number().optional(),
    })
    .optional(),
  judge: z.string().optional(),
  firstError: z.string().optional(),
});
export type LedgerRow = z.infer<typeof ledgerRowSchema>;
