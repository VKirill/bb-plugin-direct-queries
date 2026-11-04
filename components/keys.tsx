import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { en } from "../i18n.ts";
import { CATALOG_NAMES, type SecretName } from "../secrets.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { savePluginSecrets, usePluginId } from "./plugin-id.ts";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Strings = typeof en;

const KEY_ROWS: Array<{ name: SecretName; label: keyof Strings }> = [
  { name: "openluxKey", label: "keyOpenlux" },
  { name: "typesafeKey", label: "keyTypesafe" },
  { name: "xmlstockUser", label: "keyXmlstockUser" },
  { name: "xmlstockKey", label: "keyXmlstockKey" },
  { name: "googleClientId", label: "keyGoogleClientId" },
  { name: "googleClientSecret", label: "keyGoogleClientSecret" },
  { name: "googleRefreshToken", label: "keyGoogleRefresh" },
  { name: "telegramBotToken", label: "keyTelegramBot" },
];

function pill(t: Strings, set: boolean): { text: string; cls: string } {
  if (!set) return { text: t.keyMissing, cls: "dq-pill dq-pill-miss" };
  return { text: t.keySetPlugin, cls: "dq-pill dq-pill-ok" };
}

export function KeysPanel({ t, rpc }: { t: Strings; rpc: Rpc }) {
  const pluginId = usePluginId();
  const [status, setStatus] = useState<Record<string, boolean> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    rpc.call("secrets.status", null).then((r) => setStatus(r as Record<string, boolean>));
  }, [rpc]);

  if (status === null) return <Skeleton className="dq-skel" />;

  return (
    <section className="dq-panel">
      <div className="dq-panel-head">
        <h3>{t.keys}</h3>
      </div>
      <div className="dq-panel-body">
        {KEY_ROWS.map((row) => {
          const set = Boolean(status[row.name]);
          const p = pill(t, set);
          return (
            <div key={row.name} className="dq-field">
              <Label>
                {t[row.label]}{" "}
                <span className={p.cls}>{p.text}</span>
                {!set && (
                  <span className="dq-hint">
                    {" "}
                    {t.keyFromCatalog}: {CATALOG_NAMES[row.name]}
                  </span>
                )}
              </Label>
              <div className="dq-actions">
                <Input
                  type="password"
                  value={draft[row.name] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [row.name]: e.target.value })}
                  autoComplete="off"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!draft[row.name]}
                  onClick={() => {
                    const value = draft[row.name];
                    if (!value) return;
                    void savePluginSecrets(pluginId, { [row.name]: value }).then(() => {
                      setDraft({ ...draft, [row.name]: "" });
                      setStatus({ ...status, [row.name]: true });
                    });
                  }}
                >
                  {t.save}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
