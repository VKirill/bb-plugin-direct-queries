// RSYA (ad-network) placements: report rows are scored by a filter template
// into keep / exclude / watch verdicts, and the exclude candidates are merged
// into each campaign's ExcludedSites (Direct caps that list at 1000 items).

import type { SearchQueryRow } from "./direct.ts";
import type { PlacementTemplateId, SiteProfile } from "./model.ts";

export const EXCLUDED_SITES_LIMIT = 1000;

export type PlacementRule =
  | { kind: "pattern"; match: string }
  | { kind: "costNoConv"; minCost: number }
  | { kind: "lowCtr"; maxCtr: number; minImpressions: number }
  | { kind: "highCtr"; minCtr: number; minImpressions: number }
  | { kind: "keep"; match: string };

export interface PlacementTemplate {
  id: string;
  title: string;
  rules: PlacementRule[];
}

const APPS_GAMES_PATTERN = "^com\\.|^ru\\.|\\.apk$|game|games|vpn|dsp";

export const BUILTIN_TEMPLATES: PlacementTemplate[] = [
  {
    id: "safe",
    title: "Безопасный",
    rules: [{ kind: "costNoConv", minCost: 300 }],
  },
  {
    id: "apps-and-games",
    title: "Приложения и игры",
    rules: [
      { kind: "pattern", match: APPS_GAMES_PATTERN },
      { kind: "highCtr", minCtr: 10, minImpressions: 100 },
    ],
  },
  {
    id: "strict",
    title: "Строгий",
    rules: [
      { kind: "pattern", match: APPS_GAMES_PATTERN },
      { kind: "costNoConv", minCost: 300 },
      { kind: "lowCtr", maxCtr: 0.1, minImpressions: 1000 },
      { kind: "highCtr", minCtr: 10, minImpressions: 100 },
    ],
  },
];

const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function ownDomainMatch(site: string | undefined): string | undefined {
  if (!site) return undefined;
  let host = site.trim();
  try {
    host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    host = host.split("/")[0];
  }
  host = host.replace(/^www\./, "");
  if (!host) return undefined;
  return `(^|\\.)${escapeRe(host)}$`;
}

export function resolveTemplate(
  templateId: PlacementTemplateId | string | undefined,
  profile?: SiteProfile,
): PlacementTemplate {
  const base = BUILTIN_TEMPLATES.find((t) => t.id === templateId) ?? BUILTIN_TEMPLATES[0];
  const rules: PlacementRule[] = [...base.rules];
  const own = ownDomainMatch(profile?.site);
  if (own) rules.push({ kind: "keep", match: own });
  for (const line of profile?.placement_rules ?? []) {
    const trimmed = line.trim();
    const exclude = /^exclude:\s*(.+)$/i.exec(trimmed);
    const keep = /^keep:\s*(.+)$/i.exec(trimmed);
    if (exclude) rules.push({ kind: "pattern", match: exclude[1].trim() });
    else if (keep) rules.push({ kind: "keep", match: keep[1].trim() });
  }
  return { id: base.id, title: base.title, rules };
}

export type PlacementVerdict = "exclude" | "keep" | "watch";

export interface PlacementMetrics {
  impressions: number;
  clicks: number;
  ctr: number;
  cost: number;
  conversions: number;
}

export interface EvaluatedPlacement extends PlacementMetrics {
  campaignId: number;
  campaign: string;
  placement: string;
  verdict: PlacementVerdict;
  rule: string;
}

function ruleLabel(rule: PlacementRule): string {
  switch (rule.kind) {
    case "pattern":
      return `regex /${rule.match}/`;
    case "keep":
      return `keep /${rule.match}/`;
    case "costNoConv":
      return `расход ≥ ${rule.minCost} ₽, конверсий 0`;
    case "lowCtr":
      return `CTR ≤ ${rule.maxCtr} % при ≥ ${rule.minImpressions} показах`;
    case "highCtr":
      return `CTR ≥ ${rule.minCtr} % при ≥ ${rule.minImpressions} показах`;
  }
}

function ruleFires(
  rule: Exclude<PlacementRule, { kind: "keep" }>,
  placement: string,
  re: RegExp | undefined,
  m: PlacementMetrics,
): boolean {
  switch (rule.kind) {
    case "pattern":
      return re?.test(placement) ?? false;
    case "costNoConv":
      return m.cost >= rule.minCost && m.conversions === 0;
    case "lowCtr":
      return m.impressions >= rule.minImpressions && m.ctr <= rule.maxCtr;
    case "highCtr":
      return m.impressions >= rule.minImpressions && m.ctr >= rule.minCtr;
  }
}

export function evaluatePlacements(
  rows: SearchQueryRow[],
  template: PlacementTemplate,
): EvaluatedPlacement[] {
  const compiled = template.rules.map((rule) => ({
    rule,
    re:
      rule.kind === "pattern" || rule.kind === "keep"
        ? new RegExp(rule.match, "i")
        : undefined,
  }));
  const keeps = compiled.filter((c) => c.rule.kind === "keep");
  const denies = compiled.filter((c) => c.rule.kind !== "keep");
  const out: EvaluatedPlacement[] = [];
  for (const row of rows) {
    const placement = String(row.Placement ?? "").trim();
    if (!placement) continue;
    const impressions = num(row.Impressions);
    const clicks = num(row.Clicks);
    const cost = num(row.Cost);
    const conversions = num(row.Conversions);
    const metrics: PlacementMetrics = {
      impressions,
      clicks,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      cost,
      conversions,
    };
    let verdict: PlacementVerdict = "watch";
    let fired = "";
    for (const { rule, re } of keeps) {
      if (re?.test(placement)) {
        verdict = "keep";
        fired = ruleLabel(rule);
        break;
      }
    }
    if (verdict === "watch") {
      for (const { rule, re } of denies) {
        if (ruleFires(rule as Exclude<PlacementRule, { kind: "keep" }>, placement, re, metrics)) {
          verdict = "exclude";
          fired = ruleLabel(rule);
          break;
        }
      }
    }
    out.push({
      campaignId: num(row.CampaignId),
      campaign: String(row.CampaignName ?? ""),
      placement,
      impressions,
      clicks,
      ctr: Math.round(metrics.ctr * 100) / 100,
      cost,
      conversions,
      verdict,
      rule: fired,
    });
  }
  return out;
}

export interface ExclusionCandidate {
  site: string;
  keep?: boolean;
}

export interface ExclusionPlan {
  items: string[];
  added: number;
  overflow: number;
}

const siteKey = (site: string): string => site.trim().toLowerCase();

export function planExclusions(
  current: string[],
  candidates: (string | ExclusionCandidate)[],
): ExclusionPlan {
  const items: string[] = [];
  const seen = new Set<string>();
  const push = (site: string): boolean => {
    const key = siteKey(site);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    items.push(site.trim());
    return true;
  };
  for (const site of current) {
    if (items.length >= EXCLUDED_SITES_LIMIT) break;
    push(site);
  }
  let added = 0;
  let overflow = 0;
  for (const candidate of candidates) {
    const site = typeof candidate === "string" ? candidate : candidate.site;
    const keep = typeof candidate === "string" ? false : candidate.keep === true;
    if (keep || siteKey(site) === "" || seen.has(siteKey(site))) continue;
    if (items.length >= EXCLUDED_SITES_LIMIT) {
      overflow += 1;
      continue;
    }
    if (push(site)) added += 1;
  }
  return { items, added, overflow };
}
