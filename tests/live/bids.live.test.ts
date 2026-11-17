import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../db.ts";
import { createDirectClient, type DirectTransport } from "../../direct.ts";
import { runBids, type BidsDeps } from "../../bids.ts";
import type { JevRequest } from "../../judge.ts";
import { fixturePipelineProject } from "../fixtures/projects.ts";
import { moscowParts } from "../../slots.ts";
import type { Project } from "../../model.ts";
import { liveDirect } from "./helpers.ts";

const counting = (inner: DirectTransport): { transport: DirectTransport; writes: string[] } => {
  const writes: string[] = [];
  return {
    writes,
    transport: {
      call(service, method, params) {
        if (method !== "get") writes.push(`${service}.${method}`);
        return inner.call(service, method, params);
      },
      report(params) {
        return inner.report(params);
      },
    },
  };
};

describe("bids live", () => {
  it("keywordBids returns search bids with auction forecasts for ON campaigns", async () => {
    const { client } = liveDirect();
    const campaigns = await client.campaigns({ states: ["ON"] });
    const ids = campaigns.map((c) => c.Id);
    expect(ids.length).toBeGreaterThan(0);
    const bids = await client.keywordBids(ids);
    const usable = bids.filter(
      (item) =>
        typeof item.Search?.Bid === "number" &&
        (item.Search?.AuctionBids?.AuctionBidItems?.length ?? 0) > 0,
    );
    expect(usable.length).toBeGreaterThan(0);
    expect(usable.some((item) => (item.Search?.Bid ?? 0) >= 10_000)).toBe(true);
  });

  it("runBids with apply false proposes safe bids and writes nothing", async () => {
    const { transport } = liveDirect();
    const counted = counting(transport);
    const client = createDirectClient({ transport: counted.transport });
    const db = new Database(":memory:");
    applyMigrations(db);
    const base = fixturePipelineProject();
    const project: Project = {
      ...base,
      pipeline: {
        ...base.pipeline!,
        bids: { enabled: true, apply: false, skipCampaigns: [] },
      },
    };
    const deps: BidsDeps = {
      now: () => Date.now(),
      db,
      client: async () => client,
      ask: async () =>
        (async (req: JevRequest) =>
          Object.fromEntries(
            Object.keys(req.questions).map((key) => [key, { choice: "c1", confidence: 1 }]),
          )) as never,
    };
    const day = moscowParts(Date.now()).date;
    const out = await runBids(deps, project, day, {
      trigger: "schedule",
      runId: "live-bids",
      attempt: 1,
    });
    expect(out.rows[0].status, out.rows[0].firstError).toBe("ok");
    expect(counted.writes).toEqual([]);
    for (const change of out.changes) {
      expect(change.newBid).toBeGreaterThan(5_000_000);
      expect(change.newBid * 10).toBeGreaterThanOrEqual(change.oldBid * 7);
    }
  });
});
