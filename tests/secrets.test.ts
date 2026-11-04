import { describe, it, expect } from "vitest";
import { CATALOG_NAMES, createSecrets } from "../secrets.ts";

interface RpcCall {
  pluginId: string;
  method: string;
  input: { name: string };
}

function fakeBb(catalogValue: string | null = "x") {
  const calls: RpcCall[] = [];
  const bb = {
    settings: {
      define: () => ({ get: async () => ({}) }),
    },
    sdk: {
      plugins: {
        callRpc: async (call: RpcCall) => {
          calls.push(call);
          return { value: catalogValue };
        },
      },
    },
  };
  return { bb: bb as unknown as Parameters<typeof createSecrets>[0], calls };
}

describe("CATALOG_NAMES for Yandex OAuth", () => {
  it("uses the dedicated Direct Queries names", () => {
    expect(CATALOG_NAMES.yandexClientId).toBe("DIRECT_QUERIES_YANDEX_CLIENT_ID");
    expect(CATALOG_NAMES.yandexClientSecret).toBe("DIRECT_QUERIES_YANDEX_CLIENT_SECRET");
  });
});

describe("createSecrets Yandex client id fallback", () => {
  it("asks env-catalog for DIRECT_QUERIES_YANDEX_CLIENT_ID when the plugin setting is empty", async () => {
    const { bb, calls } = fakeBb("x");
    const secrets = createSecrets(bb);

    const value = await secrets.get("yandexClientId");

    expect(value).toBe("x");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      pluginId: "env-catalog",
      method: "env_get_value",
      input: { name: "DIRECT_QUERIES_YANDEX_CLIENT_ID" },
    });
  });
});
