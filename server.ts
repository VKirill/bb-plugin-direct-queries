import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostContract } from "./host.ts";
import { createRunner, type StoredRun, type Store } from "./runner.ts";
import {
  ledgerRowSchema,
  passportCompleteness,
  projectSchema,
  settingsSchema,
  siteProfileSchema,
  type LedgerRow,
  type Project,
  type ProjectPassport,
  type Settings,
} from "./model.ts";
import { seedProjects, seedSettings } from "./seed.ts";
import { addDays, moscowParts } from "./slots.ts";
import { morningLine } from "./ledger.ts";
import {
  cachePort,
  consumeOauthState,
  getAccount,
  listAccounts,
  listFeedback,
  listJudgements,
  listQueries,
  MIGRATIONS,
  publicAccount,
  putOauthState,
  removeAccount,
  replaceFeedback,
  replaceQueries,
  upsertAccount,
  upsertJudgements,
  type AccountRow,
} from "./db.ts";
import { createSecrets, type SecretName } from "./secrets.ts";
import { runLibrarySync, runPipeline, type PipelineDeps } from "./pipeline.ts";
import {
  authorizeUrl,
  exchangeCode,
  refreshToken,
  userInfo,
  ensureFresh,
  type FetchFn,
} from "./yandex-oauth.ts";
import { createDirectClient } from "./direct.ts";
import { createOhmyClient, ohmyDirectTransport } from "./ohmyseo.ts";
import { createSheetsClient } from "./sheets.ts";
import { createJudge } from "./judge.ts";
import { createSerp } from "./serp.ts";
import { applyLibrarySync, planLibrarySync, phrase } from "./library.ts";
import { suggestPhrases } from "./negatives.ts";

const importPayloadSchema = z.object({
  projects: z.array(projectSchema),
  settings: settingsSchema.optional(),
});

export async function importConfig(
  store: Store,
  json: unknown,
): Promise<{ imported: string[] }> {
  const parsed = importPayloadSchema.parse(json);
  const current = (await store.get<Project[]>("projects")) ?? [];
  const incoming = new Map(parsed.projects.map((p) => [p.id, p]));
  const next: Project[] = [];
  const seen = new Set<string>();
  for (const p of current) {
    const upd = incoming.get(p.id);
    if (upd) {
      next.push(upd);
      seen.add(p.id);
    } else next.push(p);
  }
  for (const p of parsed.projects) {
    if (!seen.has(p.id)) next.push(p);
  }
  await store.set("projects", next);
  if (parsed.settings !== undefined) await store.set("settings", parsed.settings);
  return { imported: parsed.projects.map((p) => p.id) };
}

const accountPublicSchema = z.object({
  id: z.string(),
  login: z.string(),
  displayName: z.string().optional(),
  isAgency: z.boolean(),
  expiresAt: z.number(),
  source: z.enum(["yandex", "ohmyseo"]),
});

const ohmyseoAccountSchema = z.object({
  label: z.string(),
  yandexLogin: z.string(),
  isDefault: z.boolean(),
  denied: z.boolean(),
  imported: z.boolean(),
});

const passportViewSchema = z.object({
  passport: siteProfileSchema.nullable(),
  completeness: z
    .object({
      filled: z.number(),
      total: z.number(),
      missing: z.array(z.string()),
    })
    .nullable(),
});

export const rpcContract = defineRpcContract({
  overview: {
    input: z.object({ days: z.number().int().min(1).max(90).default(7) }),
    output: z.unknown(),
  },
  "projects.list": { input: z.null(), output: z.array(projectSchema) },
  "projects.save": { input: z.object({ project: projectSchema }), output: projectSchema },
  "projects.setEnabled": {
    input: z.object({
      projectId: z.string(),
      jobId: z.string().optional(),
      enabled: z.boolean(),
    }),
    output: z.boolean(),
  },
  passportGet: {
    input: z.object({ projectId: z.string() }),
    output: passportViewSchema,
  },
  passportSet: {
    input: z.object({ projectId: z.string(), passport: siteProfileSchema }),
    output: passportViewSchema,
  },
  "ledger.list": {
    input: z.object({
      projectId: z.string(),
      day: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    output: z.array(ledgerRowSchema),
  },
  run: {
    input: z.object({
      projectId: z.string(),
      jobId: z.string(),
      day: z.string().optional(),
    }),
    output: z.object({ runId: z.string(), day: z.string() }),
  },
  "stage.tail": {
    input: z.object({
      runId: z.string(),
      stageId: z.string(),
      lines: z.number().int().min(1).max(200).optional(),
    }),
    output: z.object({ out: z.string(), err: z.string() }),
  },
  "settings.get": { input: z.null(), output: settingsSchema },
  "settings.save": { input: settingsSchema, output: settingsSchema },
  "morning.preview": { input: z.null(), output: z.object({ text: z.string() }) },
  "accounts.list": { input: z.null(), output: z.array(accountPublicSchema) },
  "accounts.remove": { input: z.object({ accountId: z.string() }), output: z.boolean() },
  "accounts.clients": {
    input: z.object({ accountId: z.string() }),
    output: z.array(z.object({ Login: z.string(), ClientInfo: z.string().optional() })),
  },
  "accounts.campaigns": {
    input: z.object({ accountId: z.string(), clientLogin: z.string().optional() }),
    output: z.unknown(),
  },
  ohmyseoAccounts: { input: z.null(), output: z.array(ohmyseoAccountSchema) },
  ohmyseoImport: {
    input: z.object({ labels: z.array(z.string()) }),
    output: z.object({ imported: z.array(z.string()) }),
  },
  "oauth.redirectUri": { input: z.null(), output: z.object({ uri: z.string() }) },
  "secrets.status": {
    input: z.null(),
    output: z.record(z.string(), z.boolean()),
  },
  "pipeline.run": {
    input: z.object({
      projectId: z.string(),
      day: z.string().optional(),
      dryRun: z.boolean().optional(),
    }),
    output: z.object({ runId: z.string(), day: z.string() }),
  },
  "pipeline.preview": {
    input: z.object({ projectId: z.string(), day: z.string().optional() }),
    output: z.object({ runId: z.string(), day: z.string() }),
  },
});

const oauthRedirectUri = (bb: BbPluginApi): string => {
  const origin = (bb.server.experimental_appUrl ?? bb.server.loopbackBaseUrl).replace(/\/$/, "");
  return `${origin}/api/v1/plugins/${bb.pluginId}/http/oauth/callback`;
};

const directClientFactory =
  (secrets: ReturnType<typeof createSecrets>, fetchFn: FetchFn) =>
  async (account: AccountRow, clientLogin?: string) => {
    if (account.source === "ohmyseo") {
      const auth = await secrets.get("ohmyseoAuth");
      const client = createOhmyClient({ auth, fetch: fetchFn });
      return createDirectClient({
        transport: ohmyDirectTransport({
          client,
          account: account.ohmyLabel ?? account.login,
          clientLogin,
        }),
      });
    }
    return createDirectClient({ token: account.accessToken, clientLogin, fetch: fetchFn });
  };

function liveDeps(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  secrets: ReturnType<typeof createSecrets>,
): PipelineDeps {
  const fetchFn = fetch;
  const now = () => Date.now();
  const directClientFor = directClientFactory(secrets, fetchFn);
  return {
    now,
    getSecret: (name: SecretName) => secrets.get(name),
    getAccount: (id) => getAccount(db, id),
    saveAccount: (account) => upsertAccount(db, account),
    ensureFresh: async (account) => {
      if (account.source === "ohmyseo") return account;
      const clientId = await secrets.get("yandexClientId");
      const clientSecret = await secrets.get("yandexClientSecret");
      const tokens = await ensureFresh(
        {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: account.expiresAt,
        },
        now(),
        (t) =>
          refreshToken({
            refreshToken: t.refreshToken,
            clientId,
            clientSecret,
            fetch: fetchFn,
          }),
      );
      return {
        ...account,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      };
    },
    searchQueryReport: async ({ account, clientLogin, date, campaignIds }) => {
      const client = await directClientFor(account, clientLogin);
      return client.searchQueryReport({ dateFrom: date, dateTo: date, campaignIds });
    },
    listCampaigns: async ({ account, clientLogin }) => {
      const client = await directClientFor(account, clientLogin);
      return client.campaigns();
    },
    loadQueries: (projectId, day) => listQueries(db, projectId, day),
    saveQueries: (projectId, day, rows) => replaceQueries(db, projectId, day, rows),
    loadJudgements: (projectId) => listJudgements(db, projectId),
    saveJudgements: (rows) => upsertJudgements(db, rows),
    saveFeedback: (rows) => {
      if (rows[0]) replaceFeedback(db, rows[0].projectId, rows);
    },
    loadFeedback: (projectId) => listFeedback(db, projectId),
    pullDecisions: async (sheetId) => {
      const sheets = createSheetsClient({
        clientId: await secrets.get("googleClientId"),
        clientSecret: await secrets.get("googleClientSecret"),
        refreshToken: await secrets.get("googleRefreshToken"),
        fetch: fetchFn,
      });
      return sheets.pullDecisions(sheetId);
    },
    judgeQueries: async (profile, items, feedback) => {
      const judge = createJudge({
        openluxKey: await secrets.get("openluxKey"),
        typesafeKey: await secrets.get("typesafeKey").catch(() => undefined),
        fetch: fetchFn,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now,
        cache: cachePort(db, "judge", now),
      });
      return judge.judgeQueries(profile, items, feedback);
    },
    reviewSerp: async (profile, rows) => {
      const out = [];
      const host = (() => {
        try {
          return new URL(profile.site).hostname;
        } catch {
          return profile.site;
        }
      })();
      const serp = createSerp({
        user: await secrets.get("xmlstockUser"),
        key: await secrets.get("xmlstockKey"),
        fetch: fetchFn,
        cache: cachePort(db, "serp", now),
        now,
        budget: 25,
        judge: createJudge({
          openluxKey: await secrets.get("openluxKey"),
          typesafeKey: await secrets.get("typesafeKey").catch(() => undefined),
          fetch: fetchFn,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now,
          cache: cachePort(db, "judge", now),
        }),
      });
      for (const row of rows) {
        const review = await serp.reviewItem(profile, row, host);
        if (review) out.push(review);
      }
      return out;
    },
    suggestNegatives: async (queries) => {
      const judge = createJudge({
        openluxKey: await secrets.get("openluxKey"),
        typesafeKey: await secrets.get("typesafeKey").catch(() => undefined),
        fetch: fetchFn,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now,
        cache: cachePort(db, "judge", now),
      });
      return suggestPhrases(queries, (q) => phrase(q), [], judge, cachePort(db, "neg", now));
    },
    publishDay: async (sheetId, date, rows) => {
      const sheets = createSheetsClient({
        clientId: await secrets.get("googleClientId"),
        clientSecret: await secrets.get("googleClientSecret"),
        refreshToken: await secrets.get("googleRefreshToken"),
        fetch: fetchFn,
      });
      return sheets.publishDay(sheetId, date, rows);
    },
    syncLibrary: async ({ apply, approved, account, clientLogin }) => {
      const client = await directClientFor(account, clientLogin);
      const campaigns = await client.campaigns();
      const ids = campaigns.map((c) => c.Id);
      const groups = ids.length ? await client.adGroups(ids) : [];
      const sharedSets = await client.sharedSets();
      const keywords = ids.length ? await client.keywords(ids) : [];
      const plan = planLibrarySync({ campaigns, groups, sharedSets, keywords, approved });
      return applyLibrarySync(client, plan, { apply });
    },
    refreshLibraryColumn: async (sheetId, inLibrary) => {
      const sheets = createSheetsClient({
        clientId: await secrets.get("googleClientId"),
        clientSecret: await secrets.get("googleClientSecret"),
        refreshToken: await secrets.get("googleRefreshToken"),
        fetch: fetchFn,
      });
      await sheets.refreshLibraryColumn(sheetId, inLibrary);
    },
    listDirectInventory: async ({ account, clientLogin }) => {
      const client = await directClientFor(account, clientLogin);
      const campaigns = await client.campaigns();
      const ids = campaigns.map((c) => c.Id);
      return {
        campaigns,
        groups: ids.length ? await client.adGroups(ids) : [],
        sharedSets: await client.sharedSets(),
        keywords: ids.length ? await client.keywords(ids) : [],
      };
    },
  };
}

export default async function plugin(bb: BbPluginApi) {
  const store: Store = bb.storage.kv;
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const secrets = createSecrets(bb);
  const deps = liveDeps(db, secrets);
  const lifecycle = new AbortController();
  bb.onDispose(async () => {
    lifecycle.abort();
  });

  const client = bb.hosts.experimental_client({ contract: hostContract });
  const opts = (hostId: string) => ({ hostId, signal: lifecycle.signal });
  const host = {
    start: (hostId: string, input: { runId: string; cwd: string; script: string }) =>
      client.call("start", input, opts(hostId)),
    status: (hostId: string, input: { runId: string }) =>
      client.call("status", input, opts(hostId)),
    tail: (hostId: string, input: { runId: string; stageId: string; lines?: number }) =>
      client.call("tail", input, opts(hostId)),
    notify: (hostId: string, input: { command: string; text: string }) =>
      client.call("notify", input, opts(hostId)),
  };

  const sendTelegram = async (text: string): Promise<void> => {
    const token = await secrets.get("telegramBotToken");
    const settings = (await store.get<Settings>("settings")) ?? seedSettings();
    const chatId = settings.telegram?.chatId;
    if (!chatId) throw new Error("telegram chatId missing");
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}`);
  };

  const runner = createRunner({
    store,
    host,
    now: () => Date.now(),
    newRunId: randomUUID,
    pipeline: {
      run: (project, day, runOpts) => runPipeline(deps, project, day, runOpts),
      sync: (project, runOpts) => runLibrarySync(deps, project, runOpts),
    },
    sendTelegram,
  });

  let queue: Promise<void> = Promise.resolve();
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };

  const projects = async (): Promise<Project[]> =>
    (await store.get<Project[]>("projects")) ?? [];
  const saveProjects = (list: Project[]): Promise<void> => store.set("projects", list);
  const settings = async (): Promise<Settings> =>
    (await store.get<Settings>("settings")) ?? seedSettings();

  const ensureSeed = async (): Promise<void> => {
    if ((await store.get("projects")) === undefined) await saveProjects(seedProjects());
    if ((await store.get("settings")) === undefined) await store.set("settings", seedSettings());
  };

  const passportViewOf = (p: Project) => {
    const profile = p.pipeline?.profile;
    return profile
      ? { passport: profile, completeness: passportCompleteness(profile) }
      : { passport: null, completeness: null };
  };

  const passportViewFor = async (projectId: string) => {
    await ensureSeed();
    const p = (await projects()).find((x) => x.id === projectId);
    if (!p) throw new Error("projectMissing");
    return passportViewOf(p);
  };

  const savePassport = async (projectId: string, passport: ProjectPassport) => {
    await ensureSeed();
    const list = await projects();
    const p = list.find((x) => x.id === projectId);
    if (!p) throw new Error("projectMissing");
    if (!p.pipeline) throw new Error("pipelineMissing");
    p.pipeline.profile = siteProfileSchema.parse({
      ...passport,
      updated_at: new Date().toISOString(),
    });
    await saveProjects(list);
    return passportViewOf(p);
  };

  const passportLine = (c: { filled: number; total: number; missing: string[] }): string =>
    `passport ${c.filled}/${c.total} filled${c.missing.length ? ` (missing: ${c.missing.join(", ")})` : ""}`;

  const findRun = async (runId: string): Promise<StoredRun | undefined> => {
    for (const key of await store.list("run:")) {
      if (key.endsWith(`:${runId}`)) return store.get<StoredRun>(key);
    }
    return undefined;
  };

  const morningText = async (): Promise<string> => {
    const list = await projects();
    const yesterday = addDays(moscowParts(Date.now()).date, -1);
    const rows: LedgerRow[] = [];
    for (const key of await store.list("run:")) {
      const run = await store.get<StoredRun>(key);
      if (run?.day === yesterday) rows.push(...run.rows);
    }
    return morningLine(list, rows, yesterday);
  };

  const directClientFor = directClientFactory(secrets, fetch);
  const ohmyClient = async () =>
    createOhmyClient({ auth: await secrets.get("ohmyseoAuth"), fetch });

  const directFor = async (accountId: string, clientLogin?: string) => {
    const account = getAccount(db, accountId);
    if (!account) throw new Error("accountMissing");
    const fresh = await deps.ensureFresh(account);
    upsertAccount(db, fresh);
    return directClientFor(fresh, clientLogin);
  };

  bb.http.route(
    "GET",
    "/oauth/start",
    async (context) => {
      const clientId = await secrets.get("yandexClientId");
      const state = randomUUID();
      putOauthState(db, state, Date.now());
      const url = authorizeUrl({
        clientId,
        redirectUri: oauthRedirectUri(bb),
        state,
      });
      return context.redirect(url, 302);
    },
    { auth: "local" },
  );

  bb.http.route(
    "GET",
    "/oauth/callback",
    async (context) => {
      const url = new URL(context.req.url);
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!consumeOauthState(db, state, Date.now(), 10 * 60 * 1000)) {
        return context.html("Invalid or expired OAuth state", 400);
      }
      const tokens = await exchangeCode({
        code,
        clientId: await secrets.get("yandexClientId"),
        clientSecret: await secrets.get("yandexClientSecret"),
        fetch,
      });
      const info = await userInfo({ accessToken: tokens.accessToken, fetch });
      let isAgency = false;
      try {
        await createDirectClient({ token: tokens.accessToken, fetch }).agencyClients();
        isAgency = true;
      } catch {
        isAgency = false;
      }
      const existing = listAccounts(db).find((a) => a.login === info.login);
      upsertAccount(db, {
        id: existing?.id ?? (info.id || randomUUID()),
        login: info.login,
        displayName: info.displayName,
        isAgency,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        createdAt: existing?.createdAt ?? Date.now(),
        source: "yandex",
      });
      bb.realtime.publish("changed", { accounts: true });
      const ru = `Аккаунт ${info.login} подключён, можно закрыть вкладку`;
      const en = `Account ${info.login} connected, you can close this tab`;
      const lang = context.req.header("accept-language") ?? "";
      const body = lang.toLowerCase().includes("en") && !lang.toLowerCase().includes("ru") ? `${en}<br>${ru}` : `${ru}<br>${en}`;
      return context.html(`<!doctype html><meta charset="utf-8"><title>${ru}</title><p>${body}</p>`);
    },
    { auth: "none" },
  );

  const { ohmyseoAccounts, ohmyseoImport, passportGet, passportSet, ...mainRpcContract } = rpcContract;

  bb.rpc.register({ ohmyseoAccounts, ohmyseoImport }, {
    ohmyseoAccounts: async () => {
      const client = await ohmyClient();
      const accounts = await client.listAccounts();
      const imported = new Set(
        listAccounts(db)
          .filter((a) => a.source === "ohmyseo")
          .map((a) => a.ohmyLabel),
      );
      return accounts.map((a) => ({ ...a, imported: imported.has(a.label) }));
    },
    ohmyseoImport: async ({ labels }) => {
      const client = await ohmyClient();
      const accounts = await client.listAccounts();
      const wanted = new Set(labels);
      const byId = new Map(listAccounts(db).map((a) => [a.id, a]));
      const imported: string[] = [];
      for (const a of accounts) {
        if (!wanted.has(a.label)) continue;
        const id = `ohmy:${a.label}`;
        upsertAccount(db, {
          id,
          login: a.yandexLogin,
          displayName: a.yandexLogin,
          isAgency: false,
          accessToken: "",
          refreshToken: "",
          expiresAt: 0,
          createdAt: byId.get(id)?.createdAt ?? Date.now(),
          source: "ohmyseo",
          ohmyLabel: a.label,
        });
        imported.push(a.label);
      }
      bb.realtime.publish("changed", { accounts: true });
      return { imported };
    },
  });

  bb.rpc.register({ passportGet, passportSet }, {
    passportGet: ({ projectId }) => serial(() => passportViewFor(projectId)),
    passportSet: ({ projectId, passport }) => serial(() => savePassport(projectId, passport)),
  });

  bb.rpc.register(mainRpcContract, {
    overview: ({ days }) => serial(() => runner.overview(days)),
    "projects.list": async () => {
      await ensureSeed();
      return projects();
    },
    "projects.save": ({ project }) =>
      serial(async () => {
        const list = await projects();
        const i = list.findIndex((p) => p.id === project.id);
        if (i === -1) list.push(project);
        else list[i] = project;
        await saveProjects(list);
        return project;
      }),
    "projects.setEnabled": ({ projectId, jobId, enabled }) =>
      serial(async () => {
        await ensureSeed();
        const list = await projects();
        const p = list.find((x) => x.id === projectId);
        if (!p) throw new Error("projectMissing");
        if (jobId === undefined) p.enabled = enabled;
        else {
          const j = p.jobs.find((x) => x.id === jobId);
          if (!j) throw new Error("jobMissing");
          j.enabled = enabled;
        }
        await saveProjects(list);
        return true;
      }),
    "ledger.list": ({ projectId, day, limit }) =>
      serial(() => runner.ledger(projectId, day, limit)),
    run: ({ projectId, jobId, day }) => serial(() => runner.start(projectId, jobId, day, "manual")),
    "stage.tail": async ({ runId, stageId, lines }) => {
      const run = await findRun(runId);
      if (!run) throw new Error("runMissing");
      const p = (await projects()).find((x) => x.id === run.projectId);
      if (!p) throw new Error("projectMissing");
      if (p.pipeline || !p.hostId) return { out: "", err: "" };
      return host.tail(p.hostId, { runId, stageId, lines });
    },
    "settings.get": async () => {
      await ensureSeed();
      return settingsSchema.parse(await settings());
    },
    "settings.save": async (next) => {
      await store.set("settings", next);
      return next;
    },
    "morning.preview": async () => {
      await ensureSeed();
      return { text: await morningText() };
    },
    "accounts.list": async () => listAccounts(db).map(publicAccount),
    "accounts.remove": async ({ accountId }) => removeAccount(db, accountId),
    "accounts.clients": async ({ accountId }) => {
      const direct = await directFor(accountId);
      return direct.agencyClients();
    },
    "accounts.campaigns": async ({ accountId, clientLogin }) => {
      const direct = await directFor(accountId, clientLogin);
      return direct.campaigns();
    },
    "oauth.redirectUri": async () => ({ uri: oauthRedirectUri(bb) }),
    "secrets.status": async () => secrets.status(),
    "pipeline.run": ({ projectId, day, dryRun }) =>
      serial(() => runner.start(projectId, "night-export", day, "manual", dryRun)),
    "pipeline.preview": ({ projectId, day }) =>
      serial(() => runner.start(projectId, "night-export", day, "manual", true)),
  });

  bb.background.schedule("tick", "* * * * *", () => serial(() => runner.tick()));

  bb.cli.register({
    name: "direct-queries",
    summary: "Registry, schedule, run ledger and morning line for Direct query pipelines",
    commands: [
      {
        name: "status",
        summary: "Show the per-job day grid and running jobs",
        usage: "bb direct-queries status [--json]",
      },
      {
        name: "run",
        summary: "Run one project job now",
        usage: "bb direct-queries run <project> <job> [--date YYYY-MM-DD]",
      },
      {
        name: "enable",
        summary: "Enable a project or one of its jobs",
        usage: "bb direct-queries enable <project> [job]",
      },
      {
        name: "disable",
        summary: "Disable a project or one of its jobs",
        usage: "bb direct-queries disable <project> [job]",
      },
      {
        name: "morning",
        summary: "Preview or send the morning line",
        usage: "bb direct-queries morning [--dry-run|--send]",
      },
      {
        name: "import",
        summary: "Import projects and optional settings from a local JSON file",
        usage: "bb direct-queries import <file>",
      },
      {
        name: "export",
        summary: "Print stored projects and settings as JSON",
        usage: "bb direct-queries export",
      },
      {
        name: "pipeline",
        summary: "Run the built-in analysis pipeline",
        usage: "bb direct-queries pipeline run <project> [--date YYYY-MM-DD] [--dry-run]",
      },
    ],
    run: async (argv) => {
      try {
        switch (argv[0]) {
          case "status": {
            const ov = await serial(() => runner.overview(7));
            if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(ov) };
            const lines = ov.projects.flatMap((p) => [
              `${p.enabled ? "●" : "○"} ${p.site}`,
              ...p.jobs.map(
                (j) =>
                  `  ${j.title} [${j.jobId}]: ${ov.days.map((d, i) => `${d.slice(5)} ${j.cells[i].status}`).join(" · ")}`,
              ),
            ]);
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "run": {
            const dateI = argv.indexOf("--date");
            const day = dateI === -1 ? undefined : argv[dateI + 1];
            const r = await serial(() => runner.start(argv[1] ?? "", argv[2] ?? "", day, "manual"));
            return { exitCode: 0, stdout: JSON.stringify(r) };
          }
          case "pipeline": {
            if (argv[1] !== "run") {
              return {
                exitCode: 1,
                stderr: "usage: bb direct-queries pipeline run <project> [--date D] [--dry-run]",
              };
            }
            const dateI = argv.indexOf("--date");
            const day = dateI === -1 ? undefined : argv[dateI + 1];
            const r = await serial(() =>
              runner.start(argv[2] ?? "", "night-export", day, "manual", argv.includes("--dry-run")),
            );
            return { exitCode: 0, stdout: JSON.stringify(r) };
          }
          case "enable":
          case "disable": {
            const enabled = argv[0] === "enable";
            await ensureSeed();
            const list = await projects();
            const p = list.find((x) => x.id === argv[1]);
            if (!p) return { exitCode: 1, stderr: "projectMissing" };
            if (argv[2] === undefined) p.enabled = enabled;
            else {
              const j = p.jobs.find((x) => x.id === argv[2]);
              if (!j) return { exitCode: 1, stderr: "jobMissing" };
              j.enabled = enabled;
            }
            await saveProjects(list);
            return { exitCode: 0, stdout: "ok" };
          }
          case "morning": {
            const text = await morningText();
            if (argv.includes("--send")) {
              const s = await settings();
              if (s.telegram?.enabled) {
                await sendTelegram(text);
                return { exitCode: 0, stdout: "sent" };
              }
              const { exitCode } = await host.notify(s.morningLine.hostId, {
                command: s.morningLine.command,
                text,
              });
              return { exitCode, stdout: exitCode === 0 ? "sent" : "notify failed" };
            }
            return { exitCode: 0, stdout: text };
          }
          case "import": {
            const file = argv[1];
            if (!file) return { exitCode: 1, stderr: "usage: bb direct-queries import <file>" };
            const json: unknown = JSON.parse(await readFile(file, "utf8"));
            try {
              const { imported } = await importConfig(store, json);
              return {
                exitCode: 0,
                stdout: `imported ${imported.length} projects: ${imported.join(", ")}`,
              };
            } catch (e) {
              if (e instanceof z.ZodError) {
                return {
                  exitCode: 1,
                  stderr: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
                };
              }
              throw e;
            }
          }
          case "export": {
            await ensureSeed();
            return {
              exitCode: 0,
              stdout: JSON.stringify({ projects: await projects(), settings: await settings() }),
            };
          }
          case "passport": {
            const sub = argv[1];
            const projectId = argv[2];
            if (sub === "get") {
              if (!projectId) {
                return {
                  exitCode: 1,
                  stderr: "usage: bb direct-queries passport get <project> [--json]",
                };
              }
              const view = await serial(() => passportViewFor(projectId));
              if (argv.includes("--json")) {
                return { exitCode: 0, stdout: JSON.stringify(view) };
              }
              if (!view.completeness) return { exitCode: 1, stderr: "passportMissing" };
              return { exitCode: 0, stdout: passportLine(view.completeness) };
            }
            if (sub === "set") {
              const fileAt = argv.indexOf("--file");
              const file = fileAt === -1 ? undefined : argv[fileAt + 1];
              if (!projectId || !file) {
                return {
                  exitCode: 1,
                  stderr: "usage: bb direct-queries passport set <project> --file <path>",
                };
              }
              const json: unknown = JSON.parse(await readFile(file, "utf8"));
              let passport: ProjectPassport;
              try {
                passport = siteProfileSchema.parse(json);
              } catch (e) {
                if (e instanceof z.ZodError) {
                  return {
                    exitCode: 1,
                    stderr: e.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join("\n"),
                  };
                }
                throw e;
              }
              const view = await serial(() => savePassport(projectId, passport));
              return {
                exitCode: 0,
                stdout: view.completeness
                  ? `saved ${passportLine(view.completeness)}`
                  : "saved",
              };
            }
            return {
              exitCode: 1,
              stderr:
                "usage: bb direct-queries passport get <project> [--json] | passport set <project> --file <path>",
            };
          }
          default:
            return {
              exitCode: 0,
              stdout:
                "bb direct-queries status [--json] | run <project> <job> [--date D] | pipeline run <project> [--date D] [--dry-run] | enable|disable <project> [job] | morning [--dry-run|--send] | import <file> | export | passport get <project> [--json] | passport set <project> --file <path>",
            };
        }
      } catch (e) {
        return { exitCode: 1, stderr: e instanceof Error ? e.message : "failed" };
      }
    },
  });
}
