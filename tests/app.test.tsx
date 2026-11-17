import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createElement } from "react";

const calls: Array<{ method: string; input: unknown }> = [];
const routes: Record<string, (input: unknown) => unknown> = {};
const realtime: Record<string, () => void> = {};

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: (app: { slots: { navPanel: (d: { component: unknown }) => void } }) => void) => {
    let component: unknown;
    setup({ slots: { navPanel: (d) => (component = d.component) } });
    return { component };
  },
  useRpc: () => ({
    call: async (method: string, input?: unknown) => {
      calls.push({ method, input });
      return routes[method]?.(input);
    },
  }),
  useRealtime: (event: string, fn: () => void) => {
    realtime[event] = fn;
  },
  experimental_usePluginId: () => "direct-queries",
  experimental_copyToClipboard: async () => true,
}));

import { Page } from "../app.tsx";

const days = ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
const cells = (status: string) => days.map((day) => ({ day, status }));
const fixture = {
  days,
  projects: [
    {
      projectId: "alpha",
      title: "alpha.example",
      site: "alpha.example",
      enabled: true,
      jobs: [
        { jobId: "night-export", title: "Ночная выгрузка", enabled: true, cells: cells("green") },
        { jobId: "library-sync", title: "Синхронизация минусов", enabled: true, cells: cells("empty") },
      ],
    },
  ],
};
fixture.projects[0].jobs[0].cells[6].status = "failed";

const analyticsResult = (campaignName: string, cost: number) => ({
  goals: [],
  summary: {
    totals: { impressions: 100, clicks: 10, cost, conversions: 5, ctr: 10, cpc: 50, cpa: cost / 5 },
    byDay: [],
    byCampaign: [
      {
        campaignId: 1,
        campaignName,
        campaignType: "TEXT_CAMPAIGN",
        impressions: 100,
        clicks: 10,
        cost,
        conversions: 5,
        ctr: 10,
        cpc: 50,
        cpa: cost / 5,
        searchImpressions: 100,
        searchClicks: 10,
        searchCtr: 10,
      },
    ],
    byGoal: [],
  },
  recommendations: [],
});

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(realtime)) delete realtime[key];
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-pk-lang");
  document.body.innerHTML = "";
  routes.overview = async () => fixture;
  routes["ledger.list"] = async () => [
    {
      projectId: "alpha", jobId: "night-export", day: "2026-11-04", runId: "r1",
      attempt: 1, trigger: "schedule", stageId: "export", status: "failed",
      startedAt: "2026-11-04T00:00:00Z", finishedAt: "2026-11-04T00:05:00Z",
      firstError: "TimeoutError: read",
    },
  ];
  routes.run = async () => ({ runId: "r2", day: "2026-11-03" });
  routes["projects.list"] = async () => [];
  routes.history = async () => [];
  routes["accounts.list"] = async () => [];
  routes.historySync = async () => ({ results: [] });
  routes["settings.get"] = async () => ({ morningLine: { enabled: true, hostId: "h", command: "c {file}", hour: 9 }, timeZone: "Europe/Moscow" });
});

describe("dashboard", () => {
  it("shows a failed cell on 04 and its stage error after click", async () => {
    render(createElement(Page));
    const cell = await screen.findByRole("button", { name: /failed/ });
    expect(cell.getAttribute("aria-label")).toContain("failed");
    fireEvent.click(cell);
    await waitFor(() => expect(screen.getByText("TimeoutError: read")).toBeTruthy());
  });

  it("Rerun calls run with projectId and jobId", async () => {
    render(createElement(Page));
    const rerun = (await screen.findAllByRole("button", { name: "Rerun" }))[0];
    fireEvent.click(rerun);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "run",
        input: { projectId: "alpha", jobId: "night-export" },
      }),
    );
  });

  it("shows the Russian heading with lang=ru", async () => {
    document.documentElement.lang = "ru";
    render(createElement(Page));
    // 0.4.0 renamed the panel to «Панель Яндекс Директ»; the pre-rename heading check is kept below for the record.
    /*
    expect(await screen.findByRole("heading", { name: "Запросы Директа" })).toBeTruthy();
    */
    expect(await screen.findByRole("heading", { name: "Панель Яндекс Директ" })).toBeTruthy();
  });

  it("Analytics tab shows spend, clicks, conversions and what to fix", async () => {
    routes["accounts.list"] = async () => [
      { id: "acc1", login: "acc1", isAgency: false, expiresAt: 0, source: "yandex" },
    ];
    routes.analytics = async () => ({
      goals: [123],
      summary: {
        totals: { impressions: 100, clicks: 10, cost: 500, conversions: 5, ctr: 10, cpc: 50, cpa: 100 },
        byDay: [
          {
            date: "2026-11-15",
            impressions: 100,
            clicks: 10,
            cost: 500,
            conversions: 5,
            ctr: 10,
            cpc: 50,
            cpa: 100,
          },
        ],
        byCampaign: [
          {
            campaignId: 1,
            campaignName: "Camp A",
            campaignType: "TEXT_CAMPAIGN",
            impressions: 100,
            clicks: 10,
            cost: 500,
            conversions: 5,
            ctr: 10,
            cpc: 50,
            cpa: 100,
            searchImpressions: 100,
            searchClicks: 10,
            searchCtr: 10,
          },
        ],
        byGoal: [{ goalId: 123, conversions: 5, cpa: 100 }],
      },
      recommendations: [
        { campaignId: 1, campaignName: "Camp A", kind: "zeroConversions", value: 500, threshold: 200 },
      ],
    });
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Analytics" }));
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("acc1"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(screen.getByText("What to fix")).toBeTruthy());
    expect(screen.getByText("Camp A")).toBeTruthy();
    expect(screen.getByText("500.00 ₽")).toBeTruthy();
    await waitFor(() => {
      const input = calls.find((c) => c.method === "analytics")?.input as {
        accountId: string;
        from: string;
        to: string;
      };
      expect(input.accountId).toBe("acc1");
      expect(input.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(input.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it("does not show an analytics response for a previously selected account", async () => {
    routes["accounts.list"] = async () => [
      { id: "acc1", login: "one", isAgency: false, expiresAt: 0, source: "yandex" },
      { id: "acc2", login: "two", isAgency: false, expiresAt: 0, source: "yandex" },
    ];
    let resolveStale: ((value: unknown) => void) | undefined;
    routes.analytics = (input) => {
      const accountId = (input as { accountId: string }).accountId;
      if (accountId === "acc1") {
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      }
      return Promise.resolve(analyticsResult("Camp B only", 2000));
    };
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Analytics" }));
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("acc1"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.change(select, { target: { value: "acc2" } });
    await act(async () => {
      resolveStale?.(analyticsResult("Camp A only", 1000));
    });
    expect(screen.queryByText("Camp A only")).toBeNull();
    expect(screen.queryByText("1000.00 ₽")).toBeNull();
    const show = screen.getByRole("button", { name: "Show" }) as HTMLButtonElement;
    await waitFor(() => expect(show.disabled).toBe(false));
    fireEvent.click(show);
    await waitFor(() => expect(screen.getByText("Camp B only")).toBeTruthy());
    expect(screen.getByText("2000.00 ₽")).toBeTruthy();
    expect(screen.queryByText("Camp A only")).toBeNull();
  });

  it("does not show an analytics error for a previously selected account", async () => {
    routes["accounts.list"] = async () => [
      { id: "acc1", login: "one", isAgency: false, expiresAt: 0, source: "yandex" },
      { id: "acc2", login: "two", isAgency: false, expiresAt: 0, source: "yandex" },
    ];
    let rejectStale: ((reason?: unknown) => void) | undefined;
    routes.analytics = (input) => {
      const accountId = (input as { accountId: string }).accountId;
      if (accountId === "acc1") {
        return new Promise((_resolve, reject) => {
          rejectStale = reject;
        });
      }
      return Promise.resolve(analyticsResult("Camp B only", 2000));
    };
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Analytics" }));
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("acc1"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.change(select, { target: { value: "acc2" } });
    await act(async () => {
      rejectStale?.(new Error("Report failed for account A"));
    });
    expect(screen.queryByText("Report failed for account A")).toBeNull();
    const show = screen.getByRole("button", { name: "Show" }) as HTMLButtonElement;
    await waitFor(() => expect(show.disabled).toBe(false));
    fireEvent.click(show);
    await waitFor(() => expect(screen.getByText("Camp B only")).toBeTruthy());
    const analyticsCalls = calls.filter((c) => c.method === "analytics");
    expect(analyticsCalls.map((c) => (c.input as { accountId: string }).accountId)).toEqual([
      "acc1",
      "acc2",
    ]);
  });

  it("lists only the selected agency's clients when a stale clients response arrives late", async () => {
    routes["accounts.list"] = async () => [
      { id: "agencyA", login: "agencyA", isAgency: true, expiresAt: 0, source: "yandex" },
      { id: "agencyB", login: "agencyB", isAgency: true, expiresAt: 0, source: "yandex" },
    ];
    const pendingClients: Record<string, (value: unknown) => void> = {};
    routes["accounts.clients"] = (input) => {
      const accountId = (input as { accountId: string }).accountId;
      return new Promise((resolve) => {
        pendingClients[accountId] = resolve;
      });
    };
    routes.analytics = async () => analyticsResult("Camp B", 500);
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Analytics" }));
    const accountSelect = (await screen.findAllByRole("combobox"))[0] as HTMLSelectElement;
    await waitFor(() => expect(accountSelect.value).toBe("agencyA"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "accounts.clients" &&
            (c.input as { accountId: string }).accountId === "agencyA",
        ),
      ).toBe(true),
    );
    fireEvent.change(accountSelect, { target: { value: "agencyB" } });
    await waitFor(() => expect(accountSelect.value).toBe("agencyB"));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "accounts.clients" &&
            (c.input as { accountId: string }).accountId === "agencyB",
        ),
      ).toBe(true),
    );
    await act(async () => {
      pendingClients["agencyB"]?.([{ Login: "clientB" }]);
    });
    const clientSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    await waitFor(() =>
      expect([...clientSelect.options].map((o) => o.value)).toContain("clientB"),
    );
    await act(async () => {
      pendingClients["agencyA"]?.([{ Login: "clientA" }]);
    });
    expect([...clientSelect.options].map((o) => o.value)).not.toContain("clientA");
    expect([...clientSelect.options].map((o) => o.value)).toContain("clientB");
    fireEvent.change(clientSelect, { target: { value: "clientB" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => {
      const input = calls.find((c) => c.method === "analytics")?.input as {
        accountId: string;
        clientLogin?: string;
      };
      expect(input.accountId).toBe("agencyB");
      expect(input.clientLogin).toBe("clientB");
    });
  });

  it("empty overview shows a button that opens the Projects tab", async () => {
    routes.overview = async () => ({ days, projects: [] });
    render(createElement(Page));
    const btn = await screen.findByRole("button", { name: "Open projects" });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(
        document.querySelector('.dq-tabs button:nth-child(3)')?.getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });
});

describe("change history tab", () => {
  it("shows the table headers after loading", async () => {
    routes.history = async () => [
      {
        id: 1,
        at: "2026-11-16T12:00:00.000Z",
        accountId: "acc-1",
        source: "direct",
        actor: "direct",
        objectType: "campaign",
        objectId: "10",
        campaignId: 10,
        field: "Name",
        before: "Old",
        after: "New",
      },
    ];
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Change history" }));
    const headers = await screen.findAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Time",
      "Source",
      "Object",
      "Field",
      "Before",
      "After",
    ]);
    expect(await screen.findByText("campaign:10")).toBeTruthy();
    expect(screen.getByText("Old")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("a rejected history RPC shows the error and Retry recovers", async () => {
    let fail = true;
    routes.history = async () => {
      if (fail) throw new Error("history down");
      return [];
    };
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Change history" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("history down")).toBeTruthy();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getAllByRole("columnheader")).toHaveLength(6));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows per-account historySync errors after Refresh", async () => {
    routes.historySync = async () => ({
      results: [
        { accountId: "acc-1", clientLogin: undefined, added: 0, skipped: 0, error: "direct read failed" },
      ],
    });
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Change history" }));
    await screen.findAllByRole("columnheader");
    fireEvent.click(screen.getByRole("button", { name: "Refresh from Direct" }));
    expect(await screen.findByText("direct read failed")).toBeTruthy();
    await screen.findAllByRole("columnheader");
  });

  it("Refresh calls historySync then reloads history", async () => {
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Change history" }));
    await screen.findAllByRole("columnheader");
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Refresh from Direct" }));
    await waitFor(() =>
      expect(calls.map((c) => c.method)).toEqual(
        expect.arrayContaining(["historySync", "history"]),
      ),
    );
  });

  const historyRow = (id: number, minute: number) => ({
    id,
    at: new Date(Date.parse("2026-11-16T00:00:00Z") + minute * 60_000).toISOString(),
    accountId: "acc-1",
    source: "direct",
    actor: "direct",
    objectType: "campaign",
    objectId: String(id),
    campaignId: id,
    field: "Name",
    before: "Old",
    after: "New",
  });
  const firstPage = Array.from({ length: 200 }, (_, i) => historyRow(1000 - i, i));
  const olderPage = Array.from({ length: 5 }, (_, i) => historyRow(800 - i, 200 + i));
  const bodyRows = () => document.querySelectorAll("tbody tr");

  it("Load older sends the last row's cursor and appends the next page", async () => {
    routes.history = async (input) =>
      (input as { before?: unknown } | undefined)?.before ? olderPage : firstPage;
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Change history" }));
    await waitFor(() => expect(bodyRows()).toHaveLength(200));
    const older = await screen.findByRole("button", { name: "Load older" });
    fireEvent.click(older);
    await waitFor(() => expect(bodyRows()).toHaveLength(205));
    const lastCall = calls.filter((c) => c.method === "history").at(-1);
    const input = lastCall?.input as {
      limit: number;
      before: { at: string; id: number };
    };
    const lastRow = firstPage[firstPage.length - 1];
    expect(input.limit).toBe(200);
    expect(input.before).toEqual({ at: lastRow.at, id: lastRow.id });
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    const historyCalls = calls.filter((c) => c.method === "history").length;
    await act(async () => {
      realtime.changed?.();
    });
    expect(calls.filter((c) => c.method === "history")).toHaveLength(historyCalls);
    expect(bodyRows()).toHaveLength(205);
  });

  it("drops a stale Load older response after a filter change", async () => {
    let resolveOlder: ((value: unknown) => void) | undefined;
    routes.history = (input) => {
      const before = (input as { before?: unknown } | undefined)?.before;
      if (!before) return Promise.resolve(firstPage);
      return new Promise((resolve) => {
        resolveOlder = resolve;
      });
    };
    render(createElement(Page));
    fireEvent.click(await screen.findByRole("button", { name: "Change history" }));
    await waitFor(() => expect(bodyRows()).toHaveLength(200));
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "history" &&
            (c.input as { before?: unknown }).before !== undefined,
        ),
      ).toBe(true),
    );
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "direct" } });
    await waitFor(() => expect(bodyRows()).toHaveLength(200));
    await act(async () => {
      resolveOlder?.(olderPage);
    });
    expect(bodyRows()).toHaveLength(200);
  });
});
