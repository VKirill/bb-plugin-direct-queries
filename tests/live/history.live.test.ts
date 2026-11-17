import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations, cacheGet } from "../../db.ts";
import { syncDirectChanges } from "../../history.ts";
import { liveDirect } from "./helpers.ts";

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe("history live account (read-only)", () => {
  it(
    "first sync baselines campaign snapshots and a second sync resolves",
    async () => {
      const db = new Database(":memory:");
      applyMigrations(db);
      const { client } = liveDirect();
      const campaigns = await client.campaigns();
      const first = await syncDirectChanges(client, db, { accountId: "live" });
      expect(first.added).toBe(0);
      for (const c of campaigns) {
        expect(
          cacheGet(db, "changeSnap", `live||campaign|${c.Id}`, Date.now()),
        ).toBeDefined();
      }
      expect(
        cacheGet<string>(db, "changesTs", "live|", Date.now()),
      ).toMatch(TIMESTAMP_RE);
      await syncDirectChanges(client, db, { accountId: "live" });
      expect(
        cacheGet<string>(db, "changesTs", "live|", Date.now()),
      ).toMatch(TIMESTAMP_RE);
    },
    20 * 60 * 1000,
  );
});
