import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const SECRET_NAMES = [
  "yandexClientId",
  "yandexClientSecret",
  "openluxKey",
  "typesafeKey",
  "xmlstockUser",
  "xmlstockKey",
  "googleClientId",
  "googleClientSecret",
  "googleRefreshToken",
  "telegramBotToken",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const CATALOG_NAMES: Record<SecretName, string> = {
  yandexClientId: "YANDEX_CLIENT_ID",
  yandexClientSecret: "YANDEX_CLIENT_SECRET",
  openluxKey: "OPENLUX_API_KEY",
  typesafeKey: "TYPESAFE_API_KEY",
  xmlstockUser: "XMLSTOCK_USER",
  xmlstockKey: "XMLSTOCK_KEY",
  googleClientId: "GOOGLE_SHEETS_CLIENT_ID",
  googleClientSecret: "GOOGLE_SHEETS_CLIENT_SECRET",
  googleRefreshToken: "GOOGLE_SHEETS_REFRESH_TOKEN",
  telegramBotToken: "TG_AIVECH_BOT",
};

export class MissingSecret extends Error {
  readonly setting: string;
  readonly catalog: string;

  constructor(setting: SecretName | string, catalog?: string) {
    const name = setting as SecretName;
    const catalogName = catalog ?? CATALOG_NAMES[name] ?? String(setting);
    super(`Missing setting ${setting} (Env Catalog ${catalogName})`);
    this.name = "MissingSecret";
    this.setting = String(setting);
    this.catalog = catalogName;
  }
}

const envValue = z.object({ value: z.string().nullable().optional() });

export type Secrets = {
  get: (name: SecretName) => Promise<string>;
  status: () => Promise<Record<SecretName, boolean>>;
};

export function createSecrets(bb: Pick<BbPluginApi, "settings" | "sdk">): Secrets {
  const handle = bb.settings.define({
    yandexClientId: { type: "string", label: "Yandex OAuth client id", secret: true },
    yandexClientSecret: { type: "string", label: "Yandex OAuth client secret", secret: true },
    openluxKey: { type: "string", label: "OpenLux API key", secret: true },
    typesafeKey: { type: "string", label: "TypeSafe API key", secret: true },
    xmlstockUser: { type: "string", label: "XMLStock user", secret: true },
    xmlstockKey: { type: "string", label: "XMLStock key", secret: true },
    googleClientId: { type: "string", label: "Google Sheets client id", secret: true },
    googleClientSecret: { type: "string", label: "Google Sheets client secret", secret: true },
    googleRefreshToken: { type: "string", label: "Google Sheets refresh token", secret: true },
    telegramBotToken: { type: "string", label: "Telegram bot token", secret: true },
  });

  const fromCatalog = async (name: SecretName): Promise<string | undefined> => {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "env-catalog",
        method: "env_get_value",
        input: { name: CATALOG_NAMES[name] },
        outputSchema: envValue,
      });
      return result.value ?? undefined;
    } catch {
      return undefined;
    }
  };

  const read = async (name: SecretName): Promise<string | undefined> => {
    const own = (await handle.get())[name];
    if (typeof own === "string" && own.length > 0) return own;
    const catalog = await fromCatalog(name);
    if (typeof catalog === "string" && catalog.length > 0) return catalog;
    return undefined;
  };

  return {
    async get(name: SecretName): Promise<string> {
      const value = await read(name);
      if (!value) throw new MissingSecret(name);
      return value;
    },
    async status(): Promise<Record<SecretName, boolean>> {
      const out = {} as Record<SecretName, boolean>;
      for (const name of SECRET_NAMES) out[name] = (await read(name)) !== undefined;
      return out;
    },
  };
}
