import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import type { LedgerRow, Project, Settings } from "./model.ts";
import { useStrings } from "./i18n.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import "./app.css";

type Cell = { day: string; status: string };
type OverviewJob = {
  jobId: string;
  title: string;
  enabled: boolean;
  cells: Cell[];
  lastRun?: { runId: string; day: string; trigger: string; status: string; finishedAt?: string };
};
type OverviewProject = {
  projectId: string;
  title: string;
  site: string;
  enabled: boolean;
  jobs: OverviewJob[];
};
type Overview = { days: string[]; projects: OverviewProject[] };

type Selected = { project: OverviewProject; job: OverviewJob; day: string };

const STATUS_CLASS: Record<string, string> = {
  green: "dq-cell-ok",
  amber: "dq-cell-amber",
  red: "dq-cell-fail",
  grey: "dq-cell-grey",
  empty: "dq-cell-empty",
  running: "dq-cell-run",
};
const STATUS_GLYPH: Record<string, string> = {
  green: "●",
  amber: "◐",
  red: "●",
  grey: "◌",
  empty: "·",
  running: "…",
};

export function Page() {
  const rpc = useRpc<typeof rpcContract>();
  const t = useStrings();
  const [tab, setTab] = useState<"dashboard" | "projects" | "settings">("dashboard");
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Selected | null>(null);

  const reload = useCallback(() => {
    rpc.call("overview", { days: 7 }).then((d) => setOv(d as Overview), (e) => setError(String(e)));
  }, [rpc]);
  useEffect(reload, [reload]);

  return (
    <div className="dq-root">
      <header className="dq-header">
        <h1>{t.title}</h1>
        <nav className="dq-tabs">
          {(["dashboard", "projects", "settings"] as const).map((k) => (
            <Button
              key={k}
              variant={tab === k ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
            >
              {k === "dashboard" ? t.dashboardTab : k === "projects" ? t.projectsTab : t.settingsTab}
            </Button>
          ))}
        </nav>
      </header>
      {error && <p className="dq-error">{error}</p>}
      {tab === "dashboard" && (
        <Dashboard t={t} ov={ov} onPick={setSelected} onRerun={(p, j) => void rpc.call("run", { projectId: p, jobId: j }).then(reload)} onOpenProjects={() => setTab("projects")} />
      )}
      {tab === "projects" && <Projects t={t} rpc={rpc} />}
      {tab === "settings" && <SettingsTab t={t} rpc={rpc} />}
      {selected && <RunPanel t={t} rpc={rpc} sel={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Dashboard({
  t,
  ov,
  onPick,
  onRerun,
  onOpenProjects,
}: {
  t: ReturnType<typeof useStrings>;
  ov: Overview | null;
  onPick: (s: Selected) => void;
  onRerun: (projectId: string, jobId: string) => void;
  onOpenProjects: () => void;
}) {
  if (ov === null) return <Skeleton className="dq-skel" />;
  if (ov.projects.length === 0)
    return (
      <section className="dq-empty">
        <h2>{t.emptyTitle}</h2>
        <p>{t.emptyBody}</p>
        <OpenProjectsButton onOpen={onOpenProjects} />
      </section>
    );
  return (
    <div className="dq-grid-wrap">
      <table className="dq-grid">
        <thead>
          <tr>
            <th>{t.project} / {t.job}</th>
            {ov.days.map((d) => (
              <th key={d}>{d.slice(8)}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {ov.projects.map((p) =>
            p.jobs.map((j, i) => (
              <tr key={`${p.projectId}/${j.jobId}`} className={p.enabled ? "" : "dq-off"}>
                <th>
                  {i === 0 && <span className="dq-site">{p.site}{p.enabled ? "" : ` (${t.off})`}</span>}
                  <span className="dq-job">{j.title}</span>
                </th>
                {j.cells.map((c) => (
                  <td key={c.day}>
                    <button
                      type="button"
                      className={`dq-cell ${STATUS_CLASS[c.status] ?? "dq-cell-empty"}`}
                      aria-label={`${j.title} ${c.day}: ${t[c.status as keyof typeof t] ?? c.status} (${c.status})`}
                      onClick={() => onPick({ project: p, job: j, day: c.day })}
                    >
                      {STATUS_GLYPH[c.status] ?? "·"}
                    </button>
                  </td>
                ))}
                <td>
                  <Button variant="outline" size="sm" onClick={() => onRerun(p.projectId, j.jobId)}>
                    {t.rerun}
                  </Button>
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

function OpenProjectsButton({ onOpen }: { onOpen: () => void }) {
  const t = useStrings();
  return <Button onClick={onOpen}>{t.openProjects}</Button>;
}

function RunPanel({
  t,
  rpc,
  sel,
  onClose,
}: {
  t: ReturnType<typeof useStrings>;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  sel: Selected;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  useEffect(() => {
    rpc
      .call("ledger.list", { projectId: sel.project.projectId, day: sel.day, limit: 200 })
      .then((r) =>
        setRows(
          (r as LedgerRow[])
            .filter((x) => x.jobId === sel.job.jobId)
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
        ),
      );
  }, [rpc, sel]);
  return (
    <aside className="dq-panel">
      <header>
        <h2>
          {sel.project.site} · {sel.job.title} · {sel.day}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t.close}>
          ×
        </Button>
      </header>
      {rows === null ? (
        <Skeleton className="dq-skel" />
      ) : (
        <Table>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell>{r.stageId}</TableCell>
                <TableCell>{r.status}</TableCell>
                <TableCell>
                  {r.rowsIn ?? "—"} → {r.rowsOut ?? "—"}
                </TableCell>
                <TableCell>{r.durationSec !== undefined ? `${r.durationSec}s` : ""}</TableCell>
                <TableCell>{r.paid ? Object.values(r.paid).filter(Boolean).join("+") : ""}</TableCell>
                <TableCell>{r.judge ?? ""}</TableCell>
                <TableCell className="dq-err">{r.firstError ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </aside>
  );
}

function Projects({ t, rpc }: { t: ReturnType<typeof useStrings>; rpc: ReturnType<typeof useRpc<typeof rpcContract>> }) {
  const [list, setList] = useState<Project[] | null>(null);
  const reload = useCallback(() => {
    rpc.call("projects.list", null).then((r) => setList(r as Project[]));
  }, [rpc]);
  useEffect(reload, [reload]);
  if (list === null) return <Skeleton className="dq-skel" />;
  const toggle = (projectId: string, jobId: string | undefined, enabled: boolean) =>
    rpc.call("projects.setEnabled", { projectId, jobId, enabled }).then(reload);
  return (
    <div className="dq-section">
      {list.map((p) => (
        <section key={p.id} className="dq-card">
          <header className="dq-card-head">
            <div>
              <h3>{p.title}</h3>
              <p className="dq-sub">
                {p.site} · {p.hostId} · {p.cwd}
              </p>
            </div>
            <Switch checked={p.enabled} onCheckedChange={(v) => void toggle(p.id, undefined, v)} aria-label={`${p.site} ${t.enabled}`} />
          </header>
          {p.jobs.map((j) => (
            <div key={j.id} className="dq-job-row">
              <span>{j.title} <code>{j.id}</code></span>
              <Switch checked={j.enabled} onCheckedChange={(v) => void toggle(p.id, j.id, v)} aria-label={`${j.id} ${t.enabled}`} />
            </div>
          ))}
          <ProjectJson t={t} rpc={rpc} p={p} onSaved={reload} />
        </section>
      ))}
    </div>
  );
}

function ProjectJson({
  t,
  rpc,
  p,
  onSaved,
}: {
  t: ReturnType<typeof useStrings>;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  p: Project;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <details>
      <summary>{t.json}</summary>
      <textarea
        className="dq-json"
        defaultValue={JSON.stringify(p, null, 2)}
        onChange={(e) => setEditing(e.target.value)}
      />
      {err && <p className="dq-error">{err}</p>}
      <Button
        size="sm"
        onClick={() => {
          try {
            const project = JSON.parse(editing || JSON.stringify(p));
            void rpc.call("projects.save", { project }).then(() => {
              setSaved(true);
              setErr("");
              onSaved();
            });
          } catch (e) {
            setErr(`${t.invalidJson}: ${e instanceof Error ? e.message : ""}`);
          }
        }}
      >
        {saved ? t.saved : t.save}
      </Button>
    </details>
  );
}

function SettingsTab({ t, rpc }: { t: ReturnType<typeof useStrings>; rpc: ReturnType<typeof useRpc<typeof rpcContract>> }) {
  const [s, setS] = useState<Settings | null>(null);
  const [preview, setPreview] = useState("");
  useEffect(() => {
    rpc.call("settings.get", null).then((r) => setS(r as Settings));
  }, [rpc]);
  if (s === null) return <Skeleton className="dq-skel" />;
  const m = s.morningLine;
  const upd = (next: Partial<Settings["morningLine"]>) =>
    setS({ ...s, morningLine: { ...m, ...next } });
  return (
    <div className="dq-section">
      <section className="dq-card">
        <h3>{t.morningLine}</h3>
        <div className="dq-field">
          <Label>{t.enabled}</Label>
          <Switch checked={m.enabled} onCheckedChange={(v) => upd({ enabled: v })} />
        </div>
        <div className="dq-field">
          <Label>{t.morningHost}</Label>
          <Input value={m.hostId} onChange={(e) => upd({ hostId: e.target.value })} />
        </div>
        <div className="dq-field">
          <Label>{t.morningCommand}</Label>
          <Input value={m.command} onChange={(e) => upd({ command: e.target.value })} />
        </div>
        <div className="dq-field">
          <Label>{t.morningHour}</Label>
          <Input
            type="number"
            min={0}
            max={23}
            value={m.hour}
            onChange={(e) => upd({ hour: Number(e.target.value) })}
          />
        </div>
        <div className="dq-actions">
          <Button onClick={() => void rpc.call("settings.save", s).then((r) => setS(r as Settings))}>
            {t.save}
          </Button>
          <Button
            variant="outline"
            onClick={() => void rpc.call("morning.preview", null).then((r) => setPreview((r as { text: string }).text))}
          >
            {t.preview}
          </Button>
        </div>
        {preview && <pre className="dq-preview">{preview}</pre>}
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "direct-queries", title: "Direct queries", icon: "Search", path: "direct-queries", component: Page });
});
