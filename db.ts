import type Database from "better-sqlite3";
import type { CachePort } from "./judge.ts";

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    display_name TEXT,
    is_agency INTEGER NOT NULL DEFAULT 0,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS queries (
    project_id TEXT NOT NULL,
    day TEXT NOT NULL,
    campaign_id INTEGER NOT NULL,
    campaign TEXT NOT NULL,
    ad_group_id INTEGER NOT NULL,
    query TEXT NOT NULL,
    impressions REAL,
    clicks REAL,
    cost REAL,
    avg_impression_position REAL,
    avg_click_position REAL,
    conversions REAL,
    PRIMARY KEY (project_id, day, campaign_id, ad_group_id, query)
  )`,
  `CREATE TABLE IF NOT EXISTS judgements (
    project_id TEXT NOT NULL,
    campaign_id INTEGER NOT NULL,
    query_norm TEXT NOT NULL,
    status TEXT NOT NULL,
    score REAL,
    reason TEXT,
    judge TEXT,
    judged_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, campaign_id, query_norm)
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    project_id TEXT NOT NULL,
    query TEXT NOT NULL,
    campaign TEXT NOT NULL,
    decision TEXT NOT NULL,
    comment TEXT,
    day TEXT NOT NULL,
    pulled_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, query, campaign, day)
  )`,
  `CREATE TABLE IF NOT EXISTS cache (
    ns TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (ns, key)
  )`,
];

export function applyMigrations(db: Database.Database): void {
  for (const sql of MIGRATIONS) db.exec(sql);
}

export type AccountRow = {
  id: string;
  login: string;
  displayName?: string;
  isAgency: boolean;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  createdAt: number;
};

export type QueryRow = {
  projectId: string;
  day: string;
  campaignId: number;
  campaign: string;
  adGroupId: number;
  query: string;
  impressions: number;
  clicks: number;
  cost: number;
  avgImpressionPosition: number | null;
  avgClickPosition: number | null;
  conversions: number;
};

export type JudgementRow = {
  projectId: string;
  campaignId: number;
  queryNorm: string;
  status: string;
  score: number | null;
  reason: string;
  judge: string;
  judgedAt: number;
};

export type FeedbackRow = {
  projectId: string;
  query: string;
  campaign: string;
  decision: string;
  comment: string;
  day: string;
  pulledAt: number;
};

type AccountSql = {
  id: string;
  login: string;
  display_name: string | null;
  is_agency: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  created_at: number;
};

const toAccount = (row: AccountSql): AccountRow => ({
  id: row.id,
  login: row.login,
  displayName: row.display_name ?? undefined,
  isAgency: row.is_agency === 1,
  accessToken: row.access_token,
  refreshToken: row.refresh_token,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

export function upsertAccount(db: Database.Database, account: AccountRow): void {
  db.prepare(
    `INSERT INTO accounts (id, login, display_name, is_agency, access_token, refresh_token, expires_at, created_at)
     VALUES (@id, @login, @display_name, @is_agency, @access_token, @refresh_token, @expires_at, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       login=excluded.login,
       display_name=excluded.display_name,
       is_agency=excluded.is_agency,
       access_token=excluded.access_token,
       refresh_token=excluded.refresh_token,
       expires_at=excluded.expires_at`,
  ).run({
    id: account.id,
    login: account.login,
    display_name: account.displayName ?? null,
    is_agency: account.isAgency ? 1 : 0,
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expires_at: account.expiresAt,
    created_at: account.createdAt,
  });
}

export function getAccount(db: Database.Database, id: string): AccountRow | undefined {
  const row = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountSql | undefined;
  return row ? toAccount(row) : undefined;
}

export function listAccounts(db: Database.Database): AccountRow[] {
  return (db.prepare(`SELECT * FROM accounts ORDER BY login`).all() as AccountSql[]).map(toAccount);
}

export function removeAccount(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id).changes > 0;
}

export function putOauthState(db: Database.Database, state: string, createdAt: number): void {
  db.prepare(`INSERT OR REPLACE INTO oauth_states (state, created_at) VALUES (?, ?)`).run(state, createdAt);
}

export function consumeOauthState(
  db: Database.Database,
  state: string,
  now: number,
  maxAgeMs: number,
): boolean {
  const row = db.prepare(`SELECT created_at FROM oauth_states WHERE state = ?`).get(state) as
    | { created_at: number }
    | undefined;
  db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
  if (!row) return false;
  return now - row.created_at <= maxAgeMs;
}

export function listQueries(db: Database.Database, projectId: string, day: string): QueryRow[] {
  const rows = db
    .prepare(`SELECT * FROM queries WHERE project_id = ? AND day = ?`)
    .all(projectId, day) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    projectId: String(r.project_id),
    day: String(r.day),
    campaignId: Number(r.campaign_id),
    campaign: String(r.campaign),
    adGroupId: Number(r.ad_group_id),
    query: String(r.query),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    cost: Number(r.cost ?? 0),
    avgImpressionPosition: r.avg_impression_position == null ? null : Number(r.avg_impression_position),
    avgClickPosition: r.avg_click_position == null ? null : Number(r.avg_click_position),
    conversions: Number(r.conversions ?? 0),
  }));
}

export function replaceQueries(db: Database.Database, projectId: string, day: string, rows: QueryRow[]): void {
  const del = db.prepare(`DELETE FROM queries WHERE project_id = ? AND day = ?`);
  const ins = db.prepare(
    `INSERT INTO queries (
      project_id, day, campaign_id, campaign, ad_group_id, query,
      impressions, clicks, cost, avg_impression_position, avg_click_position, conversions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    del.run(projectId, day);
    for (const r of rows) {
      ins.run(
        r.projectId,
        r.day,
        r.campaignId,
        r.campaign,
        r.adGroupId,
        r.query,
        r.impressions,
        r.clicks,
        r.cost,
        r.avgImpressionPosition,
        r.avgClickPosition,
        r.conversions,
      );
    }
  });
  tx();
}

export function listJudgements(db: Database.Database, projectId: string): JudgementRow[] {
  const rows = db.prepare(`SELECT * FROM judgements WHERE project_id = ?`).all(projectId) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    projectId: String(r.project_id),
    campaignId: Number(r.campaign_id),
    queryNorm: String(r.query_norm),
    status: String(r.status),
    score: r.score == null ? null : Number(r.score),
    reason: String(r.reason ?? ""),
    judge: String(r.judge ?? ""),
    judgedAt: Number(r.judged_at),
  }));
}

export function upsertJudgements(db: Database.Database, rows: JudgementRow[]): void {
  const ins = db.prepare(
    `INSERT INTO judgements (project_id, campaign_id, query_norm, status, score, reason, judge, judged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, campaign_id, query_norm) DO UPDATE SET
       status=excluded.status,
       score=excluded.score,
       reason=excluded.reason,
       judge=excluded.judge,
       judged_at=excluded.judged_at`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      ins.run(
        r.projectId,
        r.campaignId,
        r.queryNorm,
        r.status,
        r.score,
        r.reason,
        r.judge,
        r.judgedAt,
      );
    }
  });
  tx();
}

export function replaceFeedback(db: Database.Database, projectId: string, rows: FeedbackRow[]): void {
  const del = db.prepare(`DELETE FROM feedback WHERE project_id = ?`);
  const ins = db.prepare(
    `INSERT INTO feedback (project_id, query, campaign, decision, comment, day, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    del.run(projectId);
    for (const r of rows) {
      ins.run(r.projectId, r.query, r.campaign, r.decision, r.comment, r.day, r.pulledAt);
    }
  });
  tx();
}

export function listFeedback(db: Database.Database, projectId: string): FeedbackRow[] {
  const rows = db.prepare(`SELECT * FROM feedback WHERE project_id = ?`).all(projectId) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    projectId: String(r.project_id),
    query: String(r.query),
    campaign: String(r.campaign),
    decision: String(r.decision),
    comment: String(r.comment ?? ""),
    day: String(r.day),
    pulledAt: Number(r.pulled_at),
  }));
}

export function cacheGet<T>(db: Database.Database, ns: string, key: string, now: number): T | undefined {
  const row = db.prepare(`SELECT value, expires_at FROM cache WHERE ns = ? AND key = ?`).get(ns, key) as
    | { value: string; expires_at: number | null }
    | undefined;
  if (!row) return undefined;
  if (row.expires_at != null && row.expires_at <= now) {
    db.prepare(`DELETE FROM cache WHERE ns = ? AND key = ?`).run(ns, key);
    return undefined;
  }
  return JSON.parse(row.value) as T;
}

export function cacheSet(
  db: Database.Database,
  ns: string,
  key: string,
  value: unknown,
  expiresAt: number | null = null,
): void {
  db.prepare(`INSERT OR REPLACE INTO cache (ns, key, value, expires_at) VALUES (?, ?, ?, ?)`).run(
    ns,
    key,
    JSON.stringify(value),
    expiresAt,
  );
}

export function cachePort(db: Database.Database, ns: string, now: () => number): CachePort {
  return {
    get: <T>(key: string) => cacheGet<T>(db, ns, key, now()),
    set: (key: string, value: unknown) => cacheSet(db, ns, key, value),
  };
}

export function publicAccount(account: AccountRow): {
  id: string;
  login: string;
  displayName?: string;
  isAgency: boolean;
  expiresAt: number;
} {
  return {
    id: account.id,
    login: account.login,
    displayName: account.displayName,
    isAgency: account.isAgency,
    expiresAt: account.expiresAt,
  };
}
