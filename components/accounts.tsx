import { Fragment, useCallback, useEffect, useState } from "react";
import { experimental_copyToClipboard, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { en } from "../i18n.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { oauthStartHref, savePluginSecrets, usePluginId } from "./plugin-id.ts";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Strings = typeof en;
type Account = { id: string; login: string; displayName?: string; isAgency: boolean; expiresAt: number };
type AgencyClient = { Login: string; ClientInfo?: string };

function tokenLabel(t: Strings, expiresAt: number, now: number): { text: string; cls: string } {
  if (expiresAt <= now) return { text: t.expired, cls: "dq-pill dq-pill-warn" };
  const d = new Date(expiresAt);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return { text: `${t.validUntil} ${dd}.${mm}`, cls: "dq-pill dq-pill-ok" };
}

export function AccountsTab({ t, rpc }: { t: Strings; rpc: Rpc }) {
  const pluginId = usePluginId();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [uri, setUri] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [clients, setClients] = useState<AgencyClient[]>([]);

  const reload = useCallback(() => {
    rpc.call("accounts.list", null).then((r) => setAccounts(r as Account[]));
    rpc.call("oauth.redirectUri", null).then((r) => setUri((r as { uri: string }).uri));
  }, [rpc]);

  useEffect(reload, [reload]);
  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const signIn = oauthStartHref(pluginId);
  if (accounts === null) return <Skeleton className="dq-skel" />;

  return (
    <div className="dq-section">
      <section className="dq-panel">
        <div className="dq-panel-head">
          <h3>{t.yandexApp}</h3>
        </div>
        <div className="dq-panel-body">
          <div className="dq-field">
            <Label>{t.clientId}</Label>
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
          </div>
          <div className="dq-field">
            <Label>{t.clientSecret}</Label>
            <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
          </div>
          <div className="dq-actions">
            <Button
              size="sm"
              onClick={() => {
                const values: Record<string, string> = {};
                if (clientId) values.yandexClientId = clientId;
                if (clientSecret) values.yandexClientSecret = clientSecret;
                if (Object.keys(values).length) void savePluginSecrets(pluginId, values).then(() => setClientSecret(""));
              }}
            >
              {t.save}
            </Button>
          </div>
          <div className="dq-field">
            <Label>{t.redirectUri}</Label>
            <div className="dq-actions">
              <span className="dq-uri">{uri}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void experimental_copyToClipboard({ text: uri })}
              >
                {t.copy}
              </Button>
            </div>
          </div>
          <p className="dq-hint">{t.oauthHint}</p>
        </div>
      </section>
      <section className="dq-panel">
        <div className="dq-panel-head">
          <h3>{t.connectedAccounts}</h3>
          <a className="dq-accent" href={signIn} target="_blank" rel="noreferrer">
            {t.signInYandex}
          </a>
        </div>
        <div className="dq-panel-body">
          {accounts.length === 0 ? (
            <div className="dq-empty">
              <h2>{t.noAccounts}</h2>
              <p>{t.noAccountsBody}</p>
              <a className="dq-accent" href={signIn} target="_blank" rel="noreferrer">
                {t.signInYandex}
              </a>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.login}</TableHead>
                  <TableHead>{t.type}</TableHead>
                  <TableHead>{t.token}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => {
                  const tok = tokenLabel(t, a.expiresAt, Date.now());
                  return (
                    <Fragment key={a.id}>
                      <TableRow
                        onClick={() => {
                          if (!a.isAgency) return;
                          setExpanded(expanded === a.id ? null : a.id);
                          void rpc.call("accounts.clients", { accountId: a.id }).then((r) => setClients(r as AgencyClient[]));
                        }}
                      >
                        <TableCell>{a.login}</TableCell>
                        <TableCell>
                          <span className={a.isAgency ? "dq-pill dq-pill-info" : "dq-pill dq-pill-muted"}>
                            {a.isAgency ? t.agency : t.directType}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className={tok.cls}>{tok.text}</span>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              void rpc.call("accounts.remove", { accountId: a.id }).then(reload);
                            }}
                          >
                            {t.remove}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expanded === a.id && a.isAgency && (
                        <TableRow>
                          <TableCell colSpan={4}>
                            <ul className="dq-clients">
                              {clients.map((c) => (
                                <li key={c.Login}>
                                  {c.Login}
                                  {c.ClientInfo ? ` — ${c.ClientInfo}` : ""}
                                </li>
                              ))}
                            </ul>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </section>
    </div>
  );
}
