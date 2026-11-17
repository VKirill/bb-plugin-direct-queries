import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { en } from "../i18n.ts";
import { recommendationText, type Recommendation, type Summary } from "../analytics.ts";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Strings = typeof en;
type Account = { id: string; login: string; displayName?: string; isAgency: boolean };
type AgencyClient = { Login: string; ClientInfo?: string };
type AnalyticsResult = {
  goals: number[];
  summary: Summary;
  recommendations: Recommendation[];
};
type Selection = { accountId: string; clientLogin?: string; from: string; to: string };
type Period = "7" | "30" | "custom";

const DAY_MS = 24 * 60 * 60 * 1000;

function localDate(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const money = (value: number): string => value.toFixed(2);
const amount = (value: number | null): string => (value === null ? "—" : String(value));
const rate = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)}%`);

const maskText = (s: string): string =>
  s
    .replace(/\b(token|key|password|secret)\b\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");

export function AnalyticsTab({ t, rpc }: { t: Strings; rpc: Rpc }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState("");
  const [clients, setClients] = useState<AgencyClient[]>([]);
  const [clientLogin, setClientLogin] = useState("");
  const [period, setPeriod] = useState<Period>("7");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [result, setResult] = useState<{
    ctx: Selection & { label: string };
    data: AnalyticsResult;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const selectionRef = useRef<Selection>({ accountId: "", from: "", to: "" });
  const requestRef = useRef(0);

  const reload = useCallback(() => {
    rpc.call("accounts.list", null).then((r) => setAccounts((r as Account[] | undefined) ?? []));
  }, [rpc]);
  useEffect(reload, [reload]);

  useEffect(() => {
    if (accounts && accounts.length > 0 && !accountId) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  useEffect(() => {
    if (period === "custom") return;
    const days = Number(period);
    const last = Date.now() - DAY_MS;
    setTo(localDate(last));
    setFrom(localDate(last - (days - 1) * DAY_MS));
  }, [period]);

  const account = accounts?.find((a) => a.id === accountId);
  useEffect(() => {
    setClients([]);
    if (!account?.isAgency) return;
    let cancelled = false;
    void rpc
      .call("accounts.clients", { accountId: account.id })
      .then((r) => {
        if (!cancelled) setClients((r as AgencyClient[] | undefined) ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setClients([]);
        setErr(maskText(e instanceof Error ? e.message : String(e)));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, account?.id, account?.isAgency]);

  useEffect(() => {
    selectionRef.current = { accountId, clientLogin: clientLogin || undefined, from, to };
    setResult(null);
    setPending(false);
  }, [accountId, clientLogin, from, to]);

  if (accounts === null) return <Skeleton className="dq-skel" />;

  const accountLabel = account?.displayName || account?.login || accountId;

  const matchesSelection = (ctx: Selection): boolean => {
    const now = selectionRef.current;
    return (
      now.accountId === ctx.accountId &&
      now.clientLogin === ctx.clientLogin &&
      now.from === ctx.from &&
      now.to === ctx.to
    );
  };

  const show = () => {
    const client = clients.some((c) => c.Login === clientLogin) ? clientLogin : "";
    const ctx: Selection & { label: string } = {
      accountId,
      clientLogin: client || undefined,
      from,
      to,
      label: client ? `${accountLabel} · ${client}` : accountLabel,
    };
    const request = ++requestRef.current;
    setErr("");
    setPending(true);
    void rpc
      .call("analytics", {
        accountId: ctx.accountId,
        clientLogin: ctx.clientLogin,
        from: ctx.from,
        to: ctx.to,
      })
      .then(
        (r) => {
          if (request !== requestRef.current) return;
          if (matchesSelection(ctx)) {
            setResult({ ctx, data: r as AnalyticsResult });
          }
          setPending(false);
        },
        (e: unknown) => {
          if (request !== requestRef.current) return;
          if (!matchesSelection(ctx)) return;
          setErr(e instanceof Error ? e.message : String(e));
          setPending(false);
        },
      );
  };

  const totals = result?.data.summary.totals;

  return (
    <div className="dq-section">
      <section className="dq-panel">
        <div className="dq-panel-head">
          <h3>{t.analyticsTab}</h3>
        </div>
        <div className="dq-panel-body">
          <div className="dq-field">
            <Label>{t.account}</Label>
            <select
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                setClientLogin("");
              }}
            >
              <option value="" />
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login}
                </option>
              ))}
            </select>
          </div>
          {account?.isAgency && (
            <div className="dq-field">
              <Label>{t.client}</Label>
              <select value={clientLogin} onChange={(e) => setClientLogin(e.target.value)}>
                <option value="" />
                {clients.map((c) => (
                  <option key={c.Login} value={c.Login}>
                    {c.ClientInfo ? `${c.Login} — ${c.ClientInfo}` : c.Login}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="dq-field">
            <Label>{t.period}</Label>
            <div className="dq-seg">
              <button
                type="button"
                className="dq-seg-item"
                aria-pressed={period === "7"}
                onClick={() => setPeriod("7")}
              >
                {t.last7}
              </button>
              <button
                type="button"
                className="dq-seg-item"
                aria-pressed={period === "30"}
                onClick={() => setPeriod("30")}
              >
                {t.last30}
              </button>
              <button
                type="button"
                className="dq-seg-item"
                aria-pressed={period === "custom"}
                onClick={() => setPeriod("custom")}
              >
                {t.customPeriod}
              </button>
            </div>
          </div>
          {period === "custom" && (
            <>
              <div className="dq-field">
                <Label>{t.from}</Label>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="dq-field">
                <Label>{t.to}</Label>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="dq-actions">
            <Button size="sm" onClick={show} disabled={pending}>
              {t.show}
            </Button>
          </div>
          {err && <p className="dq-error">{err}</p>}
        </div>
      </section>

      {result && totals && (
        <>
          <p className="dq-sub">
            {result.ctx.label} · {result.ctx.from} — {result.ctx.to}
          </p>
          <div className="dq-an-cards">
            <section className="dq-card">
              <h3>{t.spend}</h3>
              <p>{money(totals.cost)} ₽</p>
            </section>
            <section className="dq-card">
              <h3>{t.clicks}</h3>
              <p>{amount(totals.clicks)}</p>
            </section>
            <section className="dq-card">
              <h3>{t.ctr}</h3>
              <p>{rate(totals.ctr)}</p>
            </section>
            <section className="dq-card">
              <h3>{t.conversions}</h3>
              <p>{amount(totals.conversions)}</p>
            </section>
            <section className="dq-card">
              <h3>{t.cpa}</h3>
              <p>{totals.cpa === null ? "—" : `${money(totals.cpa)} ₽`}</p>
            </section>
          </div>

          <section className="dq-panel">
            <div className="dq-panel-head">
              <h3>{t.byDay}</h3>
            </div>
            <div className="dq-panel-body">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.date}</TableHead>
                    <TableHead>{t.spend}</TableHead>
                    <TableHead>{t.clicks}</TableHead>
                    <TableHead>{t.conversions}</TableHead>
                    <TableHead>{t.cpa}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.data.summary.byDay.map((row) => (
                    <TableRow key={row.date}>
                      <TableCell>{row.date}</TableCell>
                      <TableCell>{money(row.cost)}</TableCell>
                      <TableCell>{amount(row.clicks)}</TableCell>
                      <TableCell>{amount(row.conversions)}</TableCell>
                      <TableCell>{row.cpa === null ? "—" : money(row.cpa)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          <section className="dq-panel">
            <div className="dq-panel-head">
              <h3>{t.byCampaign}</h3>
            </div>
            <div className="dq-panel-body">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.campaigns}</TableHead>
                    <TableHead>{t.spend}</TableHead>
                    <TableHead>{t.clicks}</TableHead>
                    <TableHead>{t.ctr}</TableHead>
                    <TableHead>{t.conversions}</TableHead>
                    <TableHead>{t.cpa}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.data.summary.byCampaign.map((row) => (
                    <TableRow key={row.campaignId}>
                      <TableCell>{row.campaignName}</TableCell>
                      <TableCell>{money(row.cost)}</TableCell>
                      <TableCell>{amount(row.clicks)}</TableCell>
                      <TableCell>{rate(row.ctr)}</TableCell>
                      <TableCell>{amount(row.conversions)}</TableCell>
                      <TableCell>{row.cpa === null ? "—" : money(row.cpa)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {result.data.summary.byGoal.length > 0 && (
            <section className="dq-panel">
              <div className="dq-panel-head">
                <h3>{t.byGoal}</h3>
              </div>
              <div className="dq-panel-body">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.byGoal}</TableHead>
                      <TableHead>{t.conversions}</TableHead>
                      <TableHead>{t.cpa}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.summary.byGoal.map((row) => (
                      <TableRow key={row.goalId}>
                        <TableCell>{row.goalId}</TableCell>
                        <TableCell>{amount(row.conversions)}</TableCell>
                        <TableCell>{row.cpa === null ? "—" : money(row.cpa)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          <section className="dq-panel">
            <div className="dq-panel-head">
              <h3>{t.whatToFix}</h3>
            </div>
            <div className="dq-panel-body">
              {result.data.recommendations.length === 0 ? (
                <p className="dq-hint">{t.nothingToFix}</p>
              ) : (
                <ul className="dq-clients">
                  {result.data.recommendations.map((r, i) => (
                    <li key={i}>{recommendationText(r, t)}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
