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

export const siteProfileSchema = z.object({
  site: z.string(),
  company: z.string(),
  buyer: z.string(),
  offers: z.array(z.string()),
  advertising_goal: z.string(),
  boundaries: z.array(z.string()),
  evidence: z.array(z.string()).optional(),
  geo: z.array(z.string()).optional(),
  target_segments: z.array(z.string()).optional(),
  non_target: z.array(z.string()).optional(),
  brand_policy: z.string().optional(),
  target_examples: z.array(z.string()).optional(),
  non_target_examples: z.array(z.string()).optional(),
  placement_rules: z.array(z.string()).optional(),
  updated_at: z.string().optional(),
});
export type SiteProfile = z.infer<typeof siteProfileSchema>;
export type ProjectPassport = SiteProfile;

const PASSPORT_JUDGED_FIELDS = [
  "offers",
  "advertising_goal",
  "boundaries",
  "target_segments",
  "non_target",
  "geo",
  "target_examples",
  "non_target_examples",
] as const;

export function passportCompleteness(profile: SiteProfile): {
  filled: number;
  total: number;
  missing: string[];
} {
  const missing = PASSPORT_JUDGED_FIELDS.filter((field) => {
    const value = profile[field];
    if (Array.isArray(value)) return !value.some((item) => item.trim().length > 0);
    return value === undefined || value.trim().length === 0;
  });
  return {
    filled: PASSPORT_JUDGED_FIELDS.length - missing.length,
    total: PASSPORT_JUDGED_FIELDS.length,
    missing: [...missing],
  };
}

export const pipelineSchema = z.object({
  accountId: z.string(),
  clientLogin: z.string().optional(),
  campaignFilter: z
    .object({
      ids: z.array(z.number()).optional(),
      nameContains: z.string().optional(),
    })
    .optional(),
  sheetId: z.string().optional(),
  profile: siteProfileSchema,
  serp: z.object({
    enabled: z.boolean(),
    budget: z.number().default(25),
    lr: z.number().default(225),
    device: z.string(),
  }),
  library: z.object({
    enabled: z.boolean(),
    apply: z.boolean(),
  }),
  schedule: z.object({
    hour: z.number().int().min(0).max(23).default(3),
    catchUpHours: z.array(z.number().int().min(0).max(23)).default([4, 6, 9, 12]),
    syncHours: z.array(z.number().int().min(0).max(23)).default([0, 4, 8, 12, 16, 20]),
  }),
});
export type ProjectPipeline = z.infer<typeof pipelineSchema>;

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

const stage = (
  id: string,
  title: string,
  required: boolean,
  emptyStops = false,
): Stage => ({
  id,
  title,
  command: "",
  required,
  outputs: [],
  reuse: false,
  emptyStops,
});

export const PIPELINE_NIGHT_STAGES: Stage[] = [
  stage("token", "Токен", true),
  stage("report", "Отчёт Директа", true, true),
  stage("feedback", "Решения клиента", false),
  stage("audit", "Оценка запросов", true),
  stage("serp", "Проверка выдачи", false),
  stage("candidates", "Кандидаты в минус", false),
  stage("review", "Выгрузка клиенту", true),
  stage("upload", "Загрузка в таблицу", true),
  stage("library", "Синхронизация минусов", false),
];

export function pipelineJobs(pipeline: ProjectPipeline): Job[] {
  const hour = pipeline.schedule.hour;
  const jobs: Job[] = [
    {
      id: "night-export",
      title: "Ночная выгрузка",
      hours: [hour],
      minute: 0,
      weekdays: ALL_DAYS,
      reportDay: "yesterday",
      prelude: "",
      stages: PIPELINE_NIGHT_STAGES,
      catchUpHours: pipeline.schedule.catchUpHours,
      timeoutMin: 300,
      enabled: true,
    },
  ];
  if (pipeline.library.enabled) {
    jobs.push({
      id: "library-sync",
      title: "Синхронизация минусов",
      hours: pipeline.schedule.syncHours,
      minute: 0,
      weekdays: ALL_DAYS,
      reportDay: "today",
      prelude: "",
      stages: [stage("sync", "Синхронизация", true)],
      catchUpHours: [],
      timeoutMin: 60,
      enabled: true,
    });
  }
  return jobs;
}

export const projectSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    site: z.string(),
    hostId: z.string().optional(),
    cwd: z.string().optional(),
    direct: z
      .object({
        account: z.string(),
        clientLogin: z.string().optional(),
        campaignFilter: z.string().optional(),
      })
      .optional(),
    sheetId: z.string().optional(),
    notes: z.string().optional(),
    enabled: z.boolean(),
    jobs: z.array(jobSchema).default([]),
    pipeline: pipelineSchema.optional(),
  })
  .refine(
    (p) => {
      if (p.pipeline) return true;
      return p.jobs.length > 0 && Boolean(p.hostId) && Boolean(p.cwd);
    },
    { message: "project needs jobs and host, or a pipeline" },
  );
export type Project = z.infer<typeof projectSchema>;

export function jobsOf(project: Project): Job[] {
  if (project.pipeline) return pipelineJobs(project.pipeline);
  return project.jobs ?? [];
}

export const settingsSchema = z.object({
  morningLine: z.object({
    enabled: z.boolean(),
    hostId: z.string(),
    command: z.string(),
    hour: z.number().int().min(0).max(23),
  }),
  telegram: z
    .object({
      enabled: z.boolean(),
      chatId: z.string(),
    })
    .default({ enabled: false, chatId: "" }),
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
