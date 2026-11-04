import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  applyMigrations,
  cacheGet,
  cacheSet,
  getAccount,
  upsertAccount,
  type AccountRow,
} from "../db.ts";

const open = () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
};

const account = (over: Partial<AccountRow> = {}): AccountRow => ({
  id: "acc-1",
  login: "agency",
  displayName: "Agency",
  isAgency: true,
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: 1000,
  createdAt: 1,
  ...over,
});

describe("db migrations", () => {
  it("are idempotent", () => {
    const db = open();
    applyMigrations(db);
    applyMigrations(db);
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toEqual(
      expect.arrayContaining(["accounts", "oauth_states", "queries", "judgements", "feedback", "cache"]),
    );
  });
});

describe("cache port", () => {
  it("stores JSON and expires it", () => {
    const db = open();
    cacheSet(db, "judge", "q1", { ok: true }, 50);
    expect(cacheGet(db, "judge", "q1", 10)).toEqual({ ok: true });
    expect(cacheGet(db, "judge", "q1", 50)).toBeUndefined();
    expect(cacheGet(db, "judge", "q1", 51)).toBeUndefined();
    cacheSet(db, "judge", "q2", { n: 2 });
    expect(cacheGet(db, "judge", "q2", 9_000)).toEqual({ n: 2 });
  });
});

describe("accounts", () => {
  it("upserts by id", () => {
    const db = open();
    upsertAccount(db, account());
    upsertAccount(db, account({ login: "agency2", accessToken: "tok2", expiresAt: 2000 }));
    const got = getAccount(db, "acc-1")!;
    expect(got.login).toBe("agency2");
    expect(got.accessToken).toBe("tok2");
    expect(got.expiresAt).toBe(2000);
    expect(got.createdAt).toBe(1);
  });
});
