import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";

const calls: Array<{ method: string; input: unknown }> = [];
const routes: Record<string, (input: unknown) => unknown> = {};

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

beforeEach(() => {
  calls.length = 0;
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
    expect(await screen.findByRole("heading", { name: "Запросы Директа" })).toBeTruthy();
  });

  it("empty overview shows a button that opens the Projects tab", async () => {
    routes.overview = async () => ({ days, projects: [] });
    render(createElement(Page));
    const btn = await screen.findByRole("button", { name: "Open projects" });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(
        document.querySelector('.dq-tabs button:nth-child(2)')?.getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });
});
