import { describe, it, expect, vi, beforeEach } from "vitest";

type NavRegistration = { id: string; title: string; icon: string; path: string };

const registrations = vi.hoisted(() => ({ nav: [] as NavRegistration[] }));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (
    setup: (app: { slots: { navPanel: (d: NavRegistration) => void } }) => void,
  ) => {
    setup({ slots: { navPanel: (d) => registrations.nav.push(d) } });
    return {};
  },
  useRpc: () => ({ call: async () => undefined }),
  useRealtime: () => undefined,
  experimental_usePluginId: () => "direct-queries",
  experimental_copyToClipboard: async () => true,
}));

async function registration(): Promise<NavRegistration> {
  vi.resetModules();
  registrations.nav.length = 0;
  await import("../app.tsx");
  return registrations.nav[0];
}

beforeEach(() => {
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-pk-lang");
  document.body.innerHTML = "";
});

describe("navPanel registration", () => {
  it("uses the brand icon name and the English title with lang=en", async () => {
    const reg = await registration();
    expect(reg.icon).toBe("direct-queries/brand");
    expect(reg.title).toBe("Direct queries");
    expect(reg.id).toBe("direct-queries");
    expect(reg.path).toBe("direct-queries");
  });

  it("uses the brand icon name and the Russian title with lang=ru", async () => {
    document.documentElement.lang = "ru";
    const reg = await registration();
    expect(reg.icon).toBe("direct-queries/brand");
    expect(reg.title).toBe("Запросы Директа");
  });
});
