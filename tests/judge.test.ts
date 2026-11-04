import { describe, expect, it } from "vitest";
import {
  JEV_MODEL,
  OPENLUX_URL,
  TYPESAFE_MODEL,
  TYPESAFE_URL,
  createJudge,
  similarFeedback,
  type CachePort,
  type SiteProfile,
  type SleepFn,
} from "../judge.ts";

const PROFILE: SiteProfile = {
  site: "https://example.ru/",
  company: "Завод промышленных фильтров",
  buyer: "Предприятия, которым нужны промышленные фильтры и их монтаж.",
  offers: ["Промышленные фильтры для цехов", "Проектирование и монтаж"],
  advertising_goal: "Привлекать заказчиков на основные промышленные продукты, а не любой товар с сайта.",
  boundaries: ["Не считать целевыми бытовые очистители и автомобильные фильтры."],
};

const memoryCache = (): CachePort & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: (key: string, value: unknown) => void map.set(key, value),
  };
};

const calls: { url: string; init?: { headers?: Record<string, string>; body?: string } }[] = [];

const fetchOf = (
  answer: (url: string, init?: { headers?: Record<string, string>; body?: string }) => { status: number; body: string },
) => {
  calls.length = 0;
  return async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, init });
    const a = answer(url, init);
    return { status: a.status, text: async () => a.body };
  };
};

const JEV_BODY = JSON.stringify({
  answers: {
    relevance_0: { score: 1.2, confidence: 0.0, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 } },
    intent_0: { choice: "commercial" },
    precedent_0: {
      choice: "same_target",
      confidence: 0.38,
      probabilities: { same_target: 0.69, different_or_unclear: 0.31 },
    },
  },
});

const judge = (fetch: any, sleep: SleepFn = async () => {}, now = () => 0, cache = memoryCache(), extra: object = {}) =>
  createJudge({ openluxKey: "openlux-key", fetch, sleep, now, cache, ...extra });

describe("judgeQueries", () => {
  it("builds the Jev payload with state.profile, state.items and questions as in the reference", async () => {
    const fetch = fetchOf(() => ({ status: 200, body: JEV_BODY }));
    const j = judge(fetch);
    const out = await j.judgeQueries(
      PROFILE,
      [{ campaign: "Фильтры [Поиск]", query: "промышленный фильтр цех" }],
      [{ query: "промышленный фильтр для цеха", decision: "relevant" }],
    );
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(OPENLUX_URL);
    expect(init?.headers?.Authorization).toBe("Bearer openlux-key");
    const payload = JSON.parse(init!.body!);
    expect(payload.model).toBe(JEV_MODEL);
    expect(payload.state.profile).toEqual(PROFILE);
    expect(payload.state.items).toEqual([
      {
        campaign_name: "Фильтры [Поиск]",
        query: "промышленный фильтр цех",
        client_examples: [
          { query: "промышленный фильтр для цеха", decision: "Оставить", similarity: 0.933 },
        ],
      },
    ]);
    expect(payload.questions.relevance_0.type).toBe("score");
    expect(payload.questions.relevance_0.criteria).toHaveLength(3);
    expect(payload.questions.intent_0.type).toBe("choice");
    expect(Object.keys(payload.questions.intent_0.criteria)).toEqual([
      "commercial", "informational", "navigational", "unclear",
    ]);
    // a positive client example triggers the precedent question
    expect(payload.questions.precedent_0.type).toBe("choice");
    expect(Object.keys(payload.questions.precedent_0.criteria)).toEqual([
      "same_target", "different_or_unclear",
    ]);
    // and its answer promotes the row through client analogy
    expect(out[0]).toMatchObject({
      query: "промышленный фильтр цех",
      campaign: "Фильтры [Поиск]",
      status: "релевантен",
      score: 75,
      intent: "commercial",
      decisionSource: "client_analogy",
    });
  });

  it("manual feedback overrides the judge without any request", async () => {
    const fetch = fetchOf(() => ({ status: 200, body: JEV_BODY }));
    const j = judge(fetch);
    const out = await j.judgeQueries(
      PROFILE,
      [{ campaign: "К", query: "купить фильтр" }],
      [{ query: "Купить Фильтр", decision: "irrelevant" }],
    );
    expect(calls).toHaveLength(0);
    expect(out[0]).toMatchObject({
      status: "нерелевантен",
      decisionSource: "user_feedback",
      score: null,
    });
  });

  it("status mapping: unrelated>=0.8 minus, direct>=0.65 relevant, else check", async () => {
    const body = JSON.stringify({
      answers: {
        relevance_0: { score: 0.4, confidence: 0.5, probabilities: { "0": 0.9, "1": 0.05, "2": 0.05 } },
        intent_0: { choice: "informational" },
        relevance_1: { score: 1.8, confidence: 0.9, probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 } },
        intent_1: { choice: "commercial" },
        relevance_2: { score: 1.0, confidence: 0.3, probabilities: { "0": 0.3, "1": 0.4, "2": 0.3 } },
        intent_2: { choice: "unclear" },
      },
    });
    const fetch = fetchOf(() => ({ status: 200, body }));
    const j = judge(fetch);
    const out = await j.judgeQueries(
      PROFILE,
      [
        { campaign: "К", query: "минус запрос" },
        { campaign: "К", query: "плюс запрос" },
        { campaign: "К", query: "спорный запрос" },
      ],
      [],
    );
    expect(out.map((r) => r.status)).toEqual(["нерелевантен", "релевантен", "проверить"]);
    expect(out.map((r) => r.score)).toEqual([20, 90, 50]);
    expect(out.map((r) => r.decisionSource)).toEqual(["jev", "jev", "jev"]);
  });

  it("a second call for the same query+campaign is served from cache", async () => {
    const fetch = fetchOf(() => ({ status: 200, body: JEV_BODY }));
    const j = judge(fetch);
    const items = [{ campaign: "К", query: "запрос" }];
    await j.judgeQueries(PROFILE, items, []);
    await j.judgeQueries(PROFILE, items, []);
    expect(calls).toHaveLength(1);
  });
});

describe("Jev retries", () => {
  it("503 twice then 200 keeps OpenLux and waits 30s, 60s", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const fetch = fetchOf(() => (++n <= 2 ? { status: 503, body: "bad gateway" } : { status: 200, body: JEV_BODY }));
    const j = judge(fetch, async (ms) => void sleeps.push(ms));
    await j.judgeQueries(PROFILE, [{ campaign: "К", query: "q" }], []);
    expect(n).toBe(3);
    expect(sleeps).toEqual([30000, 60000]);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set([OPENLUX_URL]));
  });

  it("a non-retryable status raises at once", async () => {
    const fetch = fetchOf(() => ({ status: 400, body: "bad question" }));
    const j = judge(fetch);
    await expect(j.judgeQueries(PROFILE, [{ campaign: "К", query: "q" }], [])).rejects.toThrow(
      /^Jev HTTP 400: /,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("OpenLux deadline", () => {
  it("past the deadline the request goes to api.typesafe.ai with model jev-1.13.0", async () => {
    let now = 1_000_000;
    const deadline = now + 3 * 3600 * 1000;
    const fetch = fetchOf((url) =>
      url === TYPESAFE_URL
        ? { status: 200, body: JEV_BODY }
        : { status: 503, body: "saturated" },
    );
    const j = judge(
      fetch,
      async (ms) => {
        now += ms;
      },
      () => now,
      memoryCache(),
      { typesafeKey: "ts-key", openluxDeadline: deadline },
    );
    await j.judgeQueries(PROFILE, [{ campaign: "К", query: "q" }], []);
    expect(now).toBeGreaterThanOrEqual(deadline);
    const last = calls[calls.length - 1];
    expect(last.url).toBe(TYPESAFE_URL);
    expect(JSON.parse(last.init!.body!).model).toBe(TYPESAFE_MODEL);
    expect(last.init?.headers?.Authorization).toBe("Bearer ts-key");
    // and the next call of the same judge goes to TypeSafe at once, without touching OpenLux
    calls.length = 0;
    await j.judgeQueries(PROFILE, [{ campaign: "К", query: "q2" }], []);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TYPESAFE_URL);
  });
});

describe("similarFeedback", () => {
  it("finds a shortened query with a typo above the 0.58 threshold", async () => {
    const examples = similarFeedback("купить фильт dn", [
      { query: "купить фильтр dn 17 для цеха no 1", decision: "relevant" },
      { query: "аспирационный извещатель", decision: "irrelevant" },
    ]);
    expect(examples[0]).toEqual({
      query: "купить фильтр dn 17 для цеха no 1",
      decision: "Оставить",
      similarity: 0.827,
    });
  });

  it("returns nothing for an unrelated query", () => {
    expect(
      similarFeedback("детский очиститель воздуха", [
        { query: "купить фильтр dn 17 для цеха no 1", decision: "relevant" },
      ]),
    ).toEqual([]);
  });

  it("keeps positive and negative examples sorted by similarity", () => {
    const examples = similarFeedback("купить фильтр dn", [
      { query: "купить фильтр dn 17", decision: "relevant" },
      { query: "фильтр dn для авто", decision: "irrelevant" },
    ]);
    expect(examples.map((e) => e.decision)).toEqual(["Оставить", "В минус"]);
    expect(examples.map((e) => e.similarity)).toEqual([0.925, 0.846]);
  });
});
