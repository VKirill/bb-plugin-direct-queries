import { describe, expect, it } from "vitest";
import { XmlStockError, createSerp, type SerpAuditRow } from "../serp.ts";
import type { CachePort, SiteProfile } from "../judge.ts";

const PROFILE: SiteProfile = {
  site: "https://example.ru/",
  company: "Завод промышленных фильтров",
  buyer: "Предприятия, которым нужны промышленные фильтры и их монтаж.",
  offers: ["Промышленные фильтры для цехов"],
  advertising_goal: "Привлекать заказчиков на основные промышленные продукты.",
  boundaries: ["Не считать целевыми бытовые очистители."],
};

const SERP_XML = `<?xml version="1.0" encoding="utf-8"?>
<response>
  <results>
    <grouping>
      <group>
        <doc>
          <url>https://example.ru/article/air</url>
          <domain>example.ru</domain>
          <title>Очистка воздуха в <hlword>цехе</hlword> — Пример</title>
          <headline>Фильтры для очистки воздуха от пыли</headline>
          <modtime>20220317T114939</modtime>
          <size>4234</size>
          <charset>utf-8</charset>
          <mime-type>text/html</mime-type>
          <passages>
            <passage>Промышленные <hlword>фильтры</hlword> для цехов</passage>
            <passage>и производств https://yandexwebcache.net/x utf-8 text/html</passage>
          </passages>
          <properties><_PassagesType>0</_PassagesType><lang>ru</lang></properties>
          <savedcopyurl>https://yandexwebcache.net/yandbtm?x=1</savedcopyurl>
        </doc>
        <doc>
          <url>https://other-site.example/x</url>
          <domain>other-site.example</domain>
          <title>Чужой сайт</title>
        </doc>
      </group>
    </grouping>
  </results>
</response>`;

const NO_HIT_XML = `<?xml version="1.0"?>
<response><results><grouping><group>
  <doc><url>https://other.example/x</url><domain>other.example</domain><title>Чужой</title></doc>
</group></grouping></results></response>`;

const memoryCache = (): CachePort & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: (key: string, value: unknown) => void map.set(key, value),
  };
};

// 2026-11-04 02:00 Moscow = 2026-11-03 23:00 UTC (inside 00–06 MSK)
const INSIDE = Date.UTC(2026, 10, 3, 23, 0, 0);
// 2026-11-04 12:00 Moscow = 2026-11-04 09:00 UTC (outside)
const OUTSIDE = Date.UTC(2026, 10, 4, 9, 0, 0);

let fetchCalls: string[];
const fetchOf = (answer: (url: string) => string | Promise<string>) => {
  fetchCalls = [];
  return async (url: string) => {
    fetchCalls.push(url);
    const body = await answer(url);
    return { status: 200, text: async () => body };
  };
};

const row = (query: string, extra: Partial<SerpAuditRow> = {}): SerpAuditRow => ({
  CampaignId: "100",
  CampaignName: "Кампания",
  AdGroupId: "7",
  Query: query,
  Impressions: "50",
  Clicks: "5",
  status: "проверить",
  ...extra,
});

const serp = (fetch: any, now: number, extra: object = {}) =>
  createSerp({ user: "u", key: "k", fetch, cache: memoryCache(), now: () => now, budget: 25, ...extra });

const judgeStub = (pageFit = 0.9, adFit = 0.9) => ({
  judgeSnippet: async () => ({ pageFit, adFit }),
});

describe("fetchSerp", () => {
  it("returns the full title of a doc with <hlword> parts and a clean snippet", async () => {
    const s = serp(fetchOf(() => SERP_XML), INSIDE);
    const out = await s.fetchSerp("очистка воздуха в цехе", {}, "example.ru");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("https://xmlstock.com/yandex/xml/?");
    expect(fetchCalls[0]).toContain("query=%D0%BE%D1%87%D0%B8%D1%81%D1%82%D0%BA%D0%B0");
    expect(out).toMatchObject({
      position: 1,
      pageUrl: "https://example.ru/article/air",
      pageTitle: "Очистка воздуха в цехе — Пример",
      resultCount: 2,
      cached: false,
    });
    expect(out!.snippet).toContain("Фильтры для очистки воздуха от пыли");
    expect(out!.snippet).toContain("Промышленные фильтры для цехов");
    expect(out!.snippet).toContain("и производств");
    expect(out!.snippet).not.toMatch(/http|yandexwebcache|utf-8|text\/html/);
  });

  it("a socket timeout is an XmlStockError, not an unhandled crash", async () => {
    const s = serp(
      (() => {
        fetchCalls = [];
        return async (url: string) => {
          fetchCalls.push(url);
          throw new Error("read timed out");
        };
      })(),
      INSIDE,
    );
    await expect(s.fetchSerp("q", {}, "example.ru")).rejects.toBeInstanceOf(XmlStockError);
  });

  it("outside 00–06 MSK no request is made", async () => {
    const s = serp(fetchOf(() => SERP_XML), OUTSIDE);
    expect(await s.fetchSerp("q", {}, "example.ru")).toBeNull();
    expect(fetchCalls).toHaveLength(0);
    // but a cached entry is still served outside the window
    const cache = memoryCache();
    cache.map.set("serp\tq\t225\tdesktop\texample.ru", {
      position: 1, pageUrl: "u", pageTitle: "t", snippet: "s", resultCount: 20,
    });
    const s2 = createSerp({ user: "u", key: "k", fetch: fetchOf(() => SERP_XML), cache, now: () => OUTSIDE, budget: 25 });
    const out = await s2.fetchSerp("q", {}, "example.ru");
    expect(out).toMatchObject({ position: 1, cached: true });
    expect(fetchCalls).toHaveLength(0);
  });

  it("counts paid requests against the budget; cache hits are free", async () => {
    const s = serp(fetchOf(() => SERP_XML), INSIDE, { budget: 2 });
    expect(await s.fetchSerp("q1", {}, "example.ru")).not.toBeNull();
    expect(await s.fetchSerp("q2", {}, "example.ru")).not.toBeNull();
    expect(await s.fetchSerp("q3", {}, "example.ru")).toBeNull();
    expect(fetchCalls).toHaveLength(2);
    // a repeat of q1 hits the cache even with the budget spent
    expect(await s.fetchSerp("q1", {}, "example.ru")).toMatchObject({ cached: true });
    expect(fetchCalls).toHaveLength(2);
  });
});

describe("reviewItem", () => {
  it("site in top-20 is judged on title+snippet and marked «оставить»", async () => {
    const s = serp(fetchOf(() => SERP_XML), INSIDE, { judge: judgeStub() });
    const out = await s.reviewItem(PROFILE, row("Очистка воздуха"), "example.ru");
    expect(fetchCalls).toHaveLength(1);
    expect(out).toMatchObject({
      review_status: "оставить",
      reason: "страница и рекламное направление соответствуют запросу",
      position: 1,
      page_url: "https://example.ru/article/air",
      page_title: "Очистка воздуха в цехе — Пример",
      page_fit: 0.9,
      ad_fit: 0.9,
      old_status: "проверить",
      cached_serp: "no",
    });
  });

  it("site not found in top-20 is a «кандидат в минуса»", async () => {
    const s = serp(fetchOf(() => NO_HIT_XML), INSIDE, { judge: judgeStub() });
    const out = await s.reviewItem(PROFILE, row("запрос без сайта"), "example.ru");
    expect(out).toMatchObject({
      review_status: "кандидат в минуса",
      reason: "сайт не найден в топ-20; проверьте релевантность вручную",
      position: "",
      page_fit: "",
    });
  });

  it("a timeout on one row gives that row «проверить» without throwing", async () => {
    const failing = async (url: string) => {
      fetchCalls.push(url);
      throw new Error("read timed out");
    };
    fetchCalls = [];
    const s = serp(failing, INSIDE, { judge: judgeStub() });
    const out = await s.reviewItem(PROFILE, row("падающий запрос"), "example.ru");
    expect(out).toMatchObject({
      review_status: "проверить",
      cached_serp: "no",
    });
    expect(out!.reason).toMatch(/^ошибка проверки: XmlStockError: /);
  });

  it("a second review of the same row is served from cache", async () => {
    const cache = memoryCache();
    const fetch = fetchOf(() => SERP_XML);
    const s = createSerp({ user: "u", key: "k", fetch, cache, now: () => INSIDE, budget: 25, judge: judgeStub() });
    await s.reviewItem(PROFILE, row("Очистка воздуха"), "example.ru");
    const out = await s.reviewItem(PROFILE, row("Очистка воздуха"), "example.ru");
    expect(fetchCalls).toHaveLength(1);
    expect(out).toMatchObject({ review_status: "оставить", cached_serp: "yes" });
  });
});
