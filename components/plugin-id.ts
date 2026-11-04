import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";

export function usePluginId(): string {
  return experimental_usePluginId() || "direct-queries";
}

export function oauthStartHref(pluginId: string): string {
  return `/api/v1/plugins/${pluginId}/http/oauth/start`;
}

export async function savePluginSecrets(pluginId: string, values: Record<string, string>): Promise<void> {
  await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
}
