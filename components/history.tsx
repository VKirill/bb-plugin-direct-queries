import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { en } from "../i18n.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Strings = typeof en;

type ChangeSource = "job" | "rpc" | "cli" | "agent" | "direct";
type ChangeRow = {
  id: number;
  at: string;
  accountId: string;
  clientLogin?: string;
  source: string;
  actor: string;
  objectType: string;
  objectId: string;
  campaignId?: number;
  adGroupId?: number;
  field: string;
  before: unknown;
  after: unknown;
  note?: string;
};
type Account = { id: string; login: string };

const SOURCES = ["job", "rpc", "cli", "agent", "direct"] as const;
const SOURCE_LABEL: Record<ChangeSource, keyof Strings> = {
  job: "historySrcJob",
  rpc: "historySrcRpc",
  cli: "historySrcCli",
  agent: "historySrcAgent",
  direct: "historySrcDirect",
};

const PAGE = 200;

const fmtValue = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
};

const cut = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function HistoryTab({ t, rpc }: { t: Strings; rpc: Rpc }) {
  const [rows, setRows] = useState<ChangeRow[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const [accountId, setAccountId] = useState("");
  const [since, setSince] = useState("");
  const [source, setSource] = useState("");
  const gen = useRef(0);
  const olderLoaded = useRef(false);

  const historyInput = useCallback(
    (before?: { at: string; id: number }) => ({
      accountId: accountId || undefined,
      since: since || undefined,
      source: (source || undefined) as ChangeSource | undefined,
      limit: PAGE,
      before,
    }),
    [accountId, since, source],
  );

  const load = useCallback(() => {
    gen.current += 1;
    const g = gen.current;
    olderLoaded.current = false;
    setOlderError("");
    setLoadingOlder(false);
    setLoading(true);
    setError("");
    let pending = 2;
    let failed = false;
    const stale = () => g !== gen.current;
    const finish = () => {
      if (stale()) return;
      pending -= 1;
      if (pending > 0) return;
      setLoading(false);
      if (failed) setRows(null);
    };
    const fail = (e: unknown) => {
      if (stale()) return;
      failed = true;
      setError(e instanceof Error ? e.message : String(e));
      finish();
    };
    rpc
      .call("history", historyInput())
      .then(
        (r) => {
          if (stale()) return;
          const page = (r as ChangeRow[] | undefined) ?? [];
          setRows(page);
          setHasMore(page.length === PAGE);
          finish();
        },
        fail,
      );
    rpc
      .call("accounts.list", null)
      .then(
        (r) => {
          if (stale()) return;
          setAccounts((r as Account[] | undefined) ?? []);
          finish();
        },
        fail,
      );
  }, [rpc, historyInput]);

  const loadOlder = () => {
    if (loadingOlder || !rows?.length) return;
    const g = gen.current;
    const last = rows[rows.length - 1];
    setLoadingOlder(true);
    rpc.call("history", historyInput({ at: last.at, id: last.id })).then(
      (r) => {
        const page = (r as ChangeRow[] | undefined) ?? [];
        if (g !== gen.current) {
          setLoadingOlder(false);
          return;
        }
        setRows((prev) => [...(prev ?? []), ...page]);
        setHasMore(page.length === PAGE);
        olderLoaded.current = true;
        setLoadingOlder(false);
      },
      (e: unknown) => {
        if (g !== gen.current) return;
        setOlderError(e instanceof Error ? e.message : String(e));
        setLoadingOlder(false);
      },
    );
  };

  useEffect(load, [load]);
  const onChanged = useCallback(() => {
    if (!olderLoaded.current) load();
  }, [load]);
  useRealtime("changed", onChanged);

  const refresh = () => {
    setSyncError("");
    void rpc.call("historySync", {}).then((r) => {
      const results =
        (r as { results?: Array<{ error?: string }> } | undefined)?.results ?? [];
      const errs = results.map((x) => x.error).filter((e): e is string => Boolean(e));
      if (errs.length) setSyncError(errs.join("; "));
      load();
    }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  if (loading) return <Skeleton className="dq-skel" />;
  if (error) {
    return (
      <div className="dq-section">
        <p className="dq-error">{error}</p>
        <div className="dq-actions">
          <Button variant="outline" size="sm" onClick={load}>
            {t.historyRetry}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="dq-section">
      <div className="dq-history-filters">
        <div className="dq-field dq-history-filter">
          <Label>{t.historyAccount}</Label>
          <select
            className="dq-history-select"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">{t.historyAllAccounts}</option>
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.login}
              </option>
            ))}
          </select>
        </div>
        <div className="dq-field dq-history-filter">
          <Label>{t.historySince}</Label>
          <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </div>
        <div className="dq-field dq-history-filter">
          <Label>{t.historySource}</Label>
          <select
            className="dq-history-select"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">{t.historySourceAll}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t[SOURCE_LABEL[s]]}
              </option>
            ))}
          </select>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          {t.historyRefresh}
        </Button>
      </div>
      {syncError ? <p className="dq-error">{syncError}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.historyTime}</TableHead>
            <TableHead>{t.historySource}</TableHead>
            <TableHead>{t.historyObject}</TableHead>
            <TableHead>{t.historyField}</TableHead>
            <TableHead>{t.historyBefore}</TableHead>
            <TableHead>{t.historyAfter}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows === null || rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="dq-hint">
                {t.historyEmpty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => {
              const before = fmtValue(r.before);
              const after = fmtValue(r.after);
              return (
                <TableRow key={r.id}>
                  <TableCell className="dq-history-time">{r.at.slice(0, 16).replace("T", " ")}</TableCell>
                  <TableCell>
                    {r.source}
                    <span className="dq-sub"> / {r.actor}</span>
                  </TableCell>
                  <TableCell>
                    {r.objectType}:{r.objectId}
                    {r.note ? <span className="dq-sub"> ({r.note})</span> : null}
                  </TableCell>
                  <TableCell>{r.field}</TableCell>
                  <TableCell className="dq-history-value" title={before}>
                    {cut(before)}
                  </TableCell>
                  <TableCell className="dq-history-value" title={after}>
                    {cut(after)}
                  </TableCell>
                </TableRow>
              );
            }))}
          </TableBody>
        </Table>
      {hasMore ? (
        <div className="dq-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingOlder}
            onClick={loadOlder}
          >
            {t.historyLoadOlder}
          </Button>
        </div>
      ) : null}
      {olderError ? <p className="dq-error">{olderError}</p> : null}
    </div>
  );
}
