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
  useRealtime: () => undefined,
  experimental_usePluginId: () => "direct-queries",
  experimental_copyToClipboard: async () => true,
}));

import { Page } from "../app.tsx";
import { parseHours, PipelineForm } from "../components/pipeline-form.tsx";
import { en, ru } from "../i18n.ts";

const REDIRECT = "https://bb.example/api/v1/plugins/direct-queries/http/oauth/callback";

beforeEach(() => {
  calls.length = 0;
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-pk-lang");
  document.body.innerHTML = "";
  routes.overview = async () => ({ days: [], projects: [] });
  routes["accounts.list"] = async () => [];
  routes["oauth.redirectUri"] = async () => ({ uri: REDIRECT });
  routes["secrets.status"] = async () => ({
    openluxKey: false,
    typesafeKey: true,
    xmlstockUser: true,
    xmlstockKey: true,
    googleClientId: true,
    googleClientSecret: true,
    googleRefreshToken: true,
    telegramBotToken: true,
    yandexClientId: true,
    yandexClientSecret: true,
  });
  routes["projects.list"] = async () => [];
  routes["settings.get"] = async () => ({
    morningLine: { enabled: false, hostId: "", command: "", hour: 9 },
    telegram: { enabled: false, chatId: "" },
    timeZone: "Europe/Moscow",
  });
  routes["accounts.clients"] = async () => [];
  routes["accounts.campaigns"] = async () => [];
});

async function openTab(name: string) {
  render(createElement(Page));
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("accounts screen", () => {
  it("empty state links to oauth/start and shows the redirect URI", async () => {
    await openTab("Accounts");
    const links = await screen.findAllByRole("link", { name: "Sign in with Yandex" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toContain("/http/oauth/start");
    }
    expect(screen.getByText(REDIRECT)).toBeTruthy();
    expect(screen.getByText("No Yandex accounts yet")).toBeTruthy();
  });

  it("with lang=ru the sign-in text is Войти через Яндекс", async () => {
    document.documentElement.lang = "ru";
    await openTab("Аккаунты");
    const links = await screen.findAllByRole("link", { name: "Войти через Яндекс" });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute("href")).toContain("/http/oauth/start");
  });

  it("agency row shows the agency pill and expands clients", async () => {
    routes["accounts.list"] = async () => [
      { id: "ag1", login: "agency-login", isAgency: true, expiresAt: Date.now() + 86400000 },
    ];
    routes["accounts.clients"] = async () => [{ Login: "client-a", ClientInfo: "Shop" }];
    await openTab("Accounts");
    expect(await screen.findByText("agency")).toBeTruthy();
    fireEvent.click(screen.getByText("agency-login"));
    await waitFor(() => expect(screen.getByText(/client-a/)).toBeTruthy());
    expect(calls).toContainEqual({ method: "accounts.clients", input: { accountId: "ag1" } });
  });

  it("Load from OhMySEO lists accounts and imports the selected label", async () => {
    routes["ohmyseoAccounts"] = async () => [
      { label: "label-1", yandexLogin: "login1", isDefault: true, denied: false, imported: false },
      { label: "label-2", yandexLogin: "login2", isDefault: false, denied: true, imported: false },
    ];
    routes["ohmyseoImport"] = async () => ({ imported: ["label-1"] });
    await openTab("Accounts");
    fireEvent.click(await screen.findByRole("button", { name: "Load from OhMySEO" }));
    expect(await screen.findByText(/label-1/)).toBeTruthy();
    expect(screen.getByText(/access closed/)).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect((boxes[1] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "ohmyseoImport", input: { labels: ["label-1"] } }),
    );
  });
});

describe("settings keys", () => {
  it("a missing key shows the missing pill", async () => {
    await openTab("Settings");
    expect(await screen.findByText("missing")).toBeTruthy();
    expect(screen.getByText("Jev OpenLux")).toBeTruthy();
  });

  it("Russian locale uses translated status pills", () => {
    expect(ru.keyMissing).toEqual("нет");
    expect(ru.keySetPlugin).toEqual("задан в плагине");
    expect(ru.keyFromCatalog).toEqual("из Env Catalog");
    expect(ru.agency).toEqual("агентство");
    expect(ru.directType).toEqual("прямой");
  });
});

describe("built-in project editor", () => {
  it("parseHours drops empty tokens and does not insert 0 from a delimiter", () => {
    expect(parseHours("")).toEqual([]);
    expect(parseHours("4, ")).toEqual([4]);
    expect(parseHours("4, 6")).toEqual([4, 6]);
    expect(parseHours("0")).toEqual([0]);
  });

  it("Enter in offers keeps a trailing blank line", async () => {
    const rpc = {
      call: async (method: string) => {
        if (method === "accounts.list") return [];
        if (method === "accounts.clients") return [];
        if (method === "accounts.campaigns") return [];
        return undefined;
      },
    };
    render(createElement(PipelineForm, { t: en, rpc: rpc as never, onSaved: () => undefined }));
    const offers = (await screen.findAllByRole("textbox")).find((el) => el.tagName === "TEXTAREA");
    expect(offers).toBeTruthy();
    fireEvent.change(offers!, { target: { value: "one\n" } });
    expect((offers as HTMLTextAreaElement).value).toEqual("one\n");
  });
});
