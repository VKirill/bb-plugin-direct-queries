import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.ts";
import type { LedgerRow, Project } from "../model.ts";
import type { en } from "../i18n.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Strings = typeof en;
type Account = { id: string; login: string; isAgency: boolean };
type AgencyClient = { Login: string; ClientInfo?: string };
type Campaign = { Id: number; Name: string };

function yesterdayMsk(now = Date.now()): string {
  const msk = new Date(now + 3 * 3600 * 1000);
  msk.setUTCDate(msk.getUTCDate() - 1);
  return msk.toISOString().slice(0, 10);
}

export function parseHours(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
}

function asCampaigns(value: unknown): Campaign[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { Id?: unknown; Name?: unknown };
    if (typeof row.Id !== "number") return [];
    return [{ Id: row.Id, Name: typeof row.Name === "string" ? row.Name : String(row.Id) }];
  });
}

function emptyPipeline(): Project {
  return {
    id: crypto.randomUUID(),
    title: "",
    site: "",
    enabled: true,
    jobs: [],
    pipeline: {
      accountId: "",
      profile: {
        site: "",
        company: "",
        buyer: "",
        offers: [],
        advertising_goal: "",
        boundaries: [],
      },
      serp: { enabled: true, budget: 25, lr: 225, device: "desktop" },
      library: { enabled: true, apply: false },
      schedule: { hour: 3, catchUpHours: [4, 6, 9, 12], syncHours: [0, 4, 8, 12, 16, 20] },
    },
  };
}

export function PipelineForm({
  t,
  rpc,
  project,
  onSaved,
}: {
  t: Strings;
  rpc: Rpc;
  project?: Project;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Project>(project ?? emptyPipeline());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [clients, setClients] = useState<AgencyClient[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<LedgerRow[] | null>(null);

  const pipe = draft.pipeline!;
  const account = accounts.find((a) => a.id === pipe.accountId);

  useEffect(() => {
    rpc.call("accounts.list", null).then((r) => setAccounts(r as Account[]));
  }, [rpc]);

  const loadClients = useCallback(
    (accountId: string) => {
      const acc = accounts.find((a) => a.id === accountId);
      if (!acc?.isAgency) {
        setClients([]);
        return;
      }
      void rpc.call("accounts.clients", { accountId }).then((r) => setClients(r as AgencyClient[]));
    },
    [accounts, rpc],
  );

  useEffect(() => {
    if (pipe.accountId) loadClients(pipe.accountId);
  }, [pipe.accountId, loadClients]);

  useEffect(() => {
    if (!pipe.accountId) return;
    void rpc
      .call("accounts.campaigns", { accountId: pipe.accountId, clientLogin: pipe.clientLogin })
      .then((r) => setCampaigns(asCampaigns(r)));
  }, [rpc, pipe.accountId, pipe.clientLogin]);

  const setPipe = (next: Partial<NonNullable<Project["pipeline"]>>) =>
    setDraft({ ...draft, pipeline: { ...pipe, ...next } });

  return (
    <section className="dq-card">
      <div className="dq-field">
        <Label>{t.project}</Label>
        <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </div>
      <div className="dq-field">
        <Label>{t.site}</Label>
        <Input
          value={draft.site}
          onChange={(e) => {
            const site = e.target.value;
            setDraft({
              ...draft,
              site,
              pipeline: { ...pipe, profile: { ...pipe.profile, site } },
            });
          }}
        />
      </div>
      <div className="dq-field">
        <Label>{t.yandexAccount}</Label>
        <select
          value={pipe.accountId}
          onChange={(e) => setPipe({ accountId: e.target.value, clientLogin: undefined })}
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
          <Label>{t.clientLogin}</Label>
          <select
            value={pipe.clientLogin ?? ""}
            onChange={(e) => setPipe({ clientLogin: e.target.value || undefined })}
          >
            <option value="" />
            {clients.map((c) => (
              <option key={c.Login} value={c.Login}>
                {c.ClientInfo ? `${c.Login} — ${c.ClientInfo}` : c.Login}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="dq-field dq-field-top">
        <Label>{t.campaigns}</Label>
        <div className="dq-campaigns">
          {campaigns.map((c) => {
            const ids = pipe.campaignFilter?.ids ?? [];
            const on = ids.includes(c.Id);
            return (
              <label key={c.Id} className="dq-check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = on ? ids.filter((id) => id !== c.Id) : [...ids, c.Id];
                    setPipe({
                      campaignFilter: { ...pipe.campaignFilter, ids: next },
                    });
                  }}
                />
                {c.Name}
              </label>
            );
          })}
          <Input
            placeholder={t.nameContains}
            value={pipe.campaignFilter?.nameContains ?? ""}
            onChange={(e) =>
              setPipe({
                campaignFilter: { ...pipe.campaignFilter, nameContains: e.target.value || undefined },
              })
            }
          />
        </div>
      </div>
      <div className="dq-field">
        <Label>{t.sheetId}</Label>
        <div className="dq-actions">
          <Input value={pipe.sheetId ?? ""} onChange={(e) => setPipe({ sheetId: e.target.value || undefined })} />
          {pipe.sheetId && (
            <a href={`https://docs.google.com/spreadsheets/d/${pipe.sheetId}`} target="_blank" rel="noreferrer">
              {t.openSheet}
            </a>
          )}
        </div>
      </div>
      <h3>{t.siteProfile}</h3>
      <div className="dq-field">
        <Label>{t.company}</Label>
        <Input
          value={pipe.profile.company}
          onChange={(e) => setPipe({ profile: { ...pipe.profile, company: e.target.value } })}
        />
      </div>
      <div className="dq-field">
        <Label>{t.buyer}</Label>
        <Input value={pipe.profile.buyer} onChange={(e) => setPipe({ profile: { ...pipe.profile, buyer: e.target.value } })} />
      </div>
      <div className="dq-field dq-field-top">
        <Label>{t.offers}</Label>
        <textarea
          className="dq-json"
          value={pipe.profile.offers.join("\n")}
          onChange={(e) =>
            setPipe({ profile: { ...pipe.profile, offers: e.target.value.split("\n") } })
          }
        />
      </div>
      <div className="dq-field">
        <Label>{t.adGoal}</Label>
        <Input
          value={pipe.profile.advertising_goal}
          onChange={(e) => setPipe({ profile: { ...pipe.profile, advertising_goal: e.target.value } })}
        />
      </div>
      <div className="dq-field dq-field-top">
        <Label>{t.notTarget}</Label>
        <textarea
          className="dq-json"
          value={pipe.profile.boundaries.join("\n")}
          onChange={(e) =>
            setPipe({ profile: { ...pipe.profile, boundaries: e.target.value.split("\n") } })
          }
        />
      </div>
      <h3>{t.serpCheck}</h3>
      <div className="dq-field">
        <Label>{t.enabled}</Label>
        <Switch checked={pipe.serp.enabled} onCheckedChange={(v) => setPipe({ serp: { ...pipe.serp, enabled: v } })} />
      </div>
      <div className="dq-field">
        <Label>{t.budgetNight}</Label>
        <Input
          type="number"
          value={pipe.serp.budget}
          onChange={(e) => setPipe({ serp: { ...pipe.serp, budget: Number(e.target.value) } })}
        />
      </div>
      <div className="dq-field">
        <Label>{t.regionLr}</Label>
        <Input
          type="number"
          value={pipe.serp.lr}
          onChange={(e) => setPipe({ serp: { ...pipe.serp, lr: Number(e.target.value) } })}
        />
      </div>
      <h3>{t.libraries}</h3>
      <div className="dq-field">
        <Label>{t.syncNegatives}</Label>
        <Switch checked={pipe.library.enabled} onCheckedChange={(v) => setPipe({ library: { ...pipe.library, enabled: v } })} />
      </div>
      <div className="dq-field">
        <Label>{t.writeDirect}</Label>
        <Switch checked={pipe.library.apply} onCheckedChange={(v) => setPipe({ library: { ...pipe.library, apply: v } })} />
      </div>
      <h3>{t.schedule}</h3>
      <div className="dq-field">
        <Label>{t.nightHour}</Label>
        <Input
          type="number"
          min={0}
          max={23}
          value={pipe.schedule.hour}
          onChange={(e) => setPipe({ schedule: { ...pipe.schedule, hour: Number(e.target.value) } })}
        />
      </div>
      <div className="dq-field">
        <Label>{t.catchUpHours}</Label>
        <Input
          value={pipe.schedule.catchUpHours.join(", ")}
          onChange={(e) => setPipe({ schedule: { ...pipe.schedule, catchUpHours: parseHours(e.target.value) } })}
        />
      </div>
      <div className="dq-field">
        <Label>{t.syncHours}</Label>
        <Input
          value={pipe.schedule.syncHours.join(", ")}
          onChange={(e) => setPipe({ schedule: { ...pipe.schedule, syncHours: parseHours(e.target.value) } })}
        />
      </div>
      <div className="dq-actions">
        <button
          type="button"
          className="dq-accent"
          onClick={() => {
            const compact = (rows: string[]) => rows.map((s) => s.trim()).filter((s) => s.length > 0);
            const project: Project = {
              ...draft,
              pipeline: {
                ...pipe,
                profile: {
                  ...pipe.profile,
                  offers: compact(pipe.profile.offers),
                  boundaries: compact(pipe.profile.boundaries),
                },
              },
            };
            void rpc.call("projects.save", { project }).then(() => {
              setSaved(true);
              onSaved();
            });
          }}
        >
          {saved ? t.saved : t.save}
        </button>
        <Button
          variant="outline"
          onClick={() => {
            const day = yesterdayMsk();
            void rpc.call("pipeline.preview", { projectId: draft.id, day }).then((r) => {
              const { day: d } = r as { day: string };
              return rpc.call("ledger.list", { projectId: draft.id, day: d, limit: 200 }).then((rows) => {
                setPreview(rows as LedgerRow[]);
              });
            });
          }}
        >
          {t.dryRunYesterday}
        </Button>
      </div>
      {preview && (
        <Table>
          <TableBody>
            {preview.map((r, i) => (
              <TableRow key={i}>
                <TableCell>{r.stageId}</TableCell>
                <TableCell>{r.status}</TableCell>
                <TableCell className="dq-err">{r.firstError ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
