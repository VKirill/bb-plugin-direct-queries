// XMLStock SERP review: fetch the Yandex top-20 for a query, find the client site,
// and judge the found page on its search title and snippet.
// Port of the reference serp_review: same request, text cleaning, decisions and
// "cache only outside 00–06 Moscow" rule. Cache replaces SQLite.

import type { CachePort, FetchLike, SiteProfile, SleepFn } from "./judge.ts";

export class XmlStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlStockError";
  }
}

export interface SerpDoc {
  url: string;
  domain: string;
  title: string;
  snippet: string;
}

export interface SerpEntry {
  position: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  snippet: string | null;
  resultCount: number;
}

export interface SerpAuditRow {
  CampaignId: string;
  CampaignName: string;
  AdGroupId: string;
  Query: string;
  Impressions: string | number;
  Clicks: string | number;
  status: string;
}

export interface SerpReview {
  CampaignId: string;
  CampaignName: string;
  AdGroupId: string;
  Query: string;
  Impressions: string | number;
  Clicks: string | number;
  old_status: string;
  lr: number;
  position: number | "";
  page_url: string;
  page_title: string;
  page_fit: number | "";
  ad_fit: number | "";
  review_status: string;
  reason: string;
  cached_serp: "yes" | "no";
}

export interface SnippetJudge {
  judgeSnippet(
    profile: SiteProfile,
    query: string,
    campaign: string,
    title: string,
    snippet: string,
  ): Promise<{ pageFit: number; adFit: number }>;
}

const MSK_OFFSET_MS = 3 * 3600 * 1000;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const normalized = (query: string): string => query.toLowerCase().trim().split(/\s+/).join(" ");

const decodeEntities = (s: string): string =>
  s.replace(/&#(\d+);|&#x([0-9a-fA-F]+);|&(\w+);/g, (m, dec, hex, name) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec));
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[name] ?? m;
  });

// itertext(): element text without tags, entities decoded
const innerText = (fragment: string | undefined): string =>
  fragment === undefined
    ? ""
    : decodeEntities(
        fragment
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .replace(/<[^>]+>/g, ""),
      );

const blocks = (xml: string, tag: string): string[] => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]);
};
const block = (xml: string, tag: string): string | undefined => blocks(xml, tag)[0];

// Collapse whitespace, drop URLs and XMLStock service tokens (clean_serp_text).
export function cleanSerpText(text: string): string {
  let s = (text ?? "").replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/\S*yandexwebcache\S*/g, " ");
  s = s.replace(/\b\d{8}T\d{6}\b( +\d+)?/g, " ");
  s = s.replace(/\b(?:utf-8|windows-1251|text\/html)\b/g, " ");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

const docTitle = (doc: string): string => innerText(block(doc, "title")).split(/\s+/).filter(Boolean).join(" ");

const docSnippet = (doc: string): string => {
  const parts: string[] = [];
  const headline = block(doc, "headline");
  if (headline !== undefined) parts.push(innerText(headline));
  for (const passage of blocks(doc, "passage")) parts.push(innerText(passage));
  return cleanSerpText(parts.join(" ")).slice(0, 1000);
};

const hostnameOf = (url: string): string | null => {
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/:?#]+)/);
  return m ? m[1].toLowerCase() : null;
};

const siteHosts = (siteHost: string): Set<string> => {
  const host = siteHost.toLowerCase();
  return new Set(host.startsWith("www.") ? [host, host.slice(4)] : [host, `www.${host}`]);
};

// sha256(PROFILE)[:16] in the reference; a stable 64-bit FNV-1a of the sorted JSON
// plays the same role here: it only has to change when the profile changes.
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );

const profileHash = (profile: SiteProfile): string => {
  let h = 0xcbf29ce484222325n;
  for (const ch of stableStringify(profile)) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
};

export function createSerp(args: {
  user: string;
  key: string;
  fetch: FetchLike;
  cache: CachePort;
  now: () => number;
  budget: number;
  sleep?: SleepFn;
  judge?: SnippetJudge;
}) {
  const { user, key, fetch, cache, now, judge } = args;
  const sleep = args.sleep ?? realSleep;
  let remaining = args.budget;

  const inWindow = (): boolean => new Date(now() + MSK_OFFSET_MS).getUTCHours() < 6;

  const serpKey = (norm: string, lr: number, device: string, siteHost: string): string =>
    `serp\t${norm}\t${lr}\t${device}\t${siteHost.toLowerCase()}`;

  const fetchXml = async (query: string, lr: number, device: string): Promise<string> => {
    const params = new URLSearchParams({
      user, key, query, lr: String(lr), domain: "ru", device, groupby: "20", page: "0",
    });
    const url = `https://xmlstock.com/yandex/xml/?${params}`;
    for (let attempt = 0; attempt < 10; attempt++) {
      let xml: string;
      try {
        const res = await fetch(url);
        xml = await res.text();
      } catch (e) {
        throw new XmlStockError(
          `XMLStock request failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const err = xml.match(/<error([^>]*)>([\s\S]*?)<\/error>/);
      if (!err) {
        if (/<doc[\s>]|<results[\s>]/.test(xml)) return xml;
        throw new XmlStockError("XMLStock request failed: unexpected response");
      }
      const code = err[1].match(/\bcode\s*=\s*["']?([^"'\s>]+)/)?.[1] ?? "";
      if ((code === "202" || code === "210") && attempt < 9) {
        await sleep(25000);
        continue;
      }
      throw new XmlStockError(`XMLStock code ${code}: ${innerText(err[2]).slice(0, 160)}`);
    }
    throw new XmlStockError("XMLStock report did not finish");
  };

  const parseDocs = (xml: string): SerpDoc[] =>
    blocks(xml, "doc").map((doc) => ({
      url: innerText(block(doc, "url")).trim(),
      domain: innerText(block(doc, "domain")).trim(),
      title: docTitle(doc),
      snippet: docSnippet(doc),
    }));

  const fetchSerp = async (
    query: string,
    opts: { lr?: number; device?: string } = {},
    siteHost = "",
  ): Promise<(SerpEntry & { cached: boolean }) | null> => {
    const lr = opts.lr ?? 225;
    const device = opts.device ?? "desktop";
    const ck = serpKey(normalized(query), lr, device, siteHost);
    const cached = await cache.get<SerpEntry>(ck);
    if (cached !== undefined) return { ...cached, cached: true };
    if (!inWindow() || remaining <= 0) return null;
    const xml = await fetchXml(query, lr, device);
    const docs = parseDocs(xml);
    const hosts = siteHosts(siteHost);
    const hit = siteHost ? docs.findIndex((d) => hosts.has(hostnameOf(d.url) ?? "")) : -1;
    const entry: SerpEntry = {
      position: hit >= 0 ? hit + 1 : null,
      pageUrl: hit >= 0 ? docs[hit].url : null,
      pageTitle: hit >= 0 ? docs[hit].title : null,
      snippet: hit >= 0 ? docs[hit].snippet : null,
      resultCount: docs.length,
    };
    await cache.set(ck, entry);
    remaining -= 1;
    return { ...entry, cached: false };
  };

  const reviewItem = async (
    profile: SiteProfile,
    row: SerpAuditRow,
    siteHost: string,
    opts: { lr?: number; device?: string; judge?: SnippetJudge } = {},
  ): Promise<SerpReview | null> => {
    const lr = opts.lr ?? 225;
    const device = opts.device ?? "desktop";
    const norm = normalized(row.Query);
    const sKey = serpKey(norm, lr, device, siteHost);
    try {
      const serp = await fetchSerp(row.Query, { lr, device }, siteHost);
      if (serp === null) return null;
      const dKey = `decision\t${norm}\t${row.CampaignId}\t${lr}\t${device}\t${profileHash(profile)}\t${siteHost.toLowerCase()}`;
      let decision = await cache.get<{
        page_fit: number | null; ad_fit: number | null; review_status: string; reason: string;
      }>(dKey);
      if (decision === undefined) {
        let pageFit: number | null = null;
        let adFit: number | null = null;
        if (serp.position === null) {
          decision = {
            page_fit: null, ad_fit: null,
            review_status: "кандидат в минуса",
            reason: "сайт не найден в топ-20; проверьте релевантность вручную",
          };
        } else {
          const useJudge = opts.judge ?? judge;
          if (!useJudge) throw new Error("judge is required to review a found page");
          ({ pageFit, adFit } = await useJudge.judgeSnippet(
            profile, row.Query, row.CampaignName, serp.pageTitle ?? "", serp.snippet ?? "",
          ));
          decision = {
            page_fit: pageFit,
            ad_fit: adFit,
            review_status:
              pageFit >= 0.75 && adFit >= 0.75
                ? "оставить"
                : pageFit <= 0.25 && adFit <= 0.25
                  ? "кандидат в минуса"
                  : "проверить",
            reason:
              pageFit >= 0.75 && adFit >= 0.75
                ? "страница и рекламное направление соответствуют запросу"
                : pageFit <= 0.25 && adFit <= 0.25
                  ? "страница и рекламное направление не соответствуют запросу"
                  : "страница найдена, но соответствие неоднозначно",
          };
        }
        await cache.set(dKey, decision);
      }
      return {
        CampaignId: row.CampaignId, CampaignName: row.CampaignName,
        AdGroupId: row.AdGroupId, Query: row.Query,
        Impressions: row.Impressions, Clicks: row.Clicks,
        old_status: row.status, lr,
        position: serp.position ?? "",
        page_url: serp.pageUrl ?? "",
        page_title: serp.pageTitle ?? "",
        page_fit: decision.page_fit ?? "",
        ad_fit: decision.ad_fit ?? "",
        review_status: decision.review_status,
        reason: decision.reason,
        cached_serp: serp.cached ? "yes" : "no",
      };
    } catch (e) {
      const serp = await Promise.resolve(cache.get<SerpEntry>(sKey)).catch(() => undefined);
      const name = e instanceof Error ? e.name : "Error";
      const message = e instanceof Error ? e.message : String(e);
      return {
        CampaignId: row.CampaignId, CampaignName: row.CampaignName,
        AdGroupId: row.AdGroupId, Query: row.Query,
        Impressions: row.Impressions, Clicks: row.Clicks,
        old_status: row.status, lr,
        position: serp?.position ?? "",
        page_url: serp?.pageUrl ?? "",
        page_title: serp?.pageTitle ?? "",
        page_fit: "", ad_fit: "",
        review_status: "проверить",
        reason: `ошибка проверки: ${name}: ${message.slice(0, 120)}`,
        cached_serp: serp ? "yes" : "no",
      };
    }
  };

  return { fetchSerp, reviewItem };
}

export type Serp = ReturnType<typeof createSerp>;
