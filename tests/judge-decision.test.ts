import { describe, expect, it } from "vitest";
import {
  DECISION_MODEL,
  DECISION_URL,
  TYPESAFE_MODEL,
  TYPESAFE_URL,
  createJudge,
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

const memoryCache = (): CachePort => {
  const map = new Map<string, unknown>();
  return {
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
  },
});

const judge = (
  fetch: any,
  sleep: SleepFn = async () => {},
  now = () => 0,
  cache = memoryCache(),
  extra: object = {},
) => createJudge({ decisionKey: "decision-key", fetch, sleep, now, cache, ...extra });

describe("Google Decision API", () => {
  it("the first request goes to the decisions endpoint with x-goog-api-key and no Authorization", async () => {
    const fetch = fetchOf(() => ({ status: 200, body: JEV_BODY }));
    const j = judge(fetch);
    const out = await j.judgeQueries(PROFILE, [{ campaign: "К", query: "промышленный фильтр цех" }], []);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(DECISION_URL);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(init?.headers?.["x-goog-api-key"]).toBe("decision-key");
    expect(init?.headers?.Authorization).toBeUndefined();
    const payload = JSON.parse(init!.body!);
    expect(payload.model).toBe(DECISION_MODEL);
    expect(payload.model).toBe("gemini-decision-1");
    expect(typeof payload.input).toBe("string");
    const state = JSON.parse(payload.input);
    expect(state.profile).toEqual(PROFILE);
    expect(state.items).toEqual([
      { campaign_name: "К", query: "промышленный фильтр цех", client_examples: [] },
    ]);
    expect(payload.questions.relevance_0.type).toBe("score");
    expect(out[0].backend).toBe("gemini");
    expect(j.lastBackend()).toBe("gemini");
  });

  it("a Google 404 leads to exactly one TypeSafe request", async () => {
    const fetch = fetchOf((url) =>
      url === TYPESAFE_URL
        ? { status: 200, body: JEV_BODY }
        : { status: 404, body: "model_not_found" },
    );
    const j = judge(fetch, async () => {}, () => 0, memoryCache(), { typesafeKey: "ts-key" });
    const out = await j.judgeQueries(PROFILE, [{ campaign: "К", query: "q" }], []);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(DECISION_URL);
    const typesafeCalls = calls.filter((c) => c.url === TYPESAFE_URL);
    expect(typesafeCalls).toHaveLength(1);
    const { init } = typesafeCalls[0];
    expect(init?.headers?.Authorization).toBe("Bearer ts-key");
    expect(init?.headers?.["x-goog-api-key"]).toBeUndefined();
    const payload = JSON.parse(init!.body!);
    expect(payload.model).toBe(TYPESAFE_MODEL);
    expect(payload.model).toBe("jev-1.13.0");
    expect(payload.state.profile).toEqual(PROFILE);
    expect(out[0].backend).toBe("typesafe");
    expect(j.lastBackend()).toBe("typesafe");
  });

  it("a 429 then 200 makes no TypeSafe request", async () => {
    let n = 0;
    const fetch = fetchOf(() =>
      ++n === 1 ? { status: 429, body: "slow down" } : { status: 200, body: JEV_BODY },
    );
    const j = judge(fetch, async () => {}, () => 0, memoryCache(), { typesafeKey: "ts-key" });
    const out = await j.judgeQueries(PROFILE, [{ campaign: "К", query: "q" }], []);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.url === DECISION_URL)).toBe(true);
    expect(out[0].backend).toBe("gemini");
  });

  it("a past decisionDeadline sends no Google request and goes to TypeSafe", async () => {
    const fetch = fetchOf(() => ({ status: 200, body: JEV_BODY }));
    const j = judge(fetch, async () => {}, () => 0, memoryCache(), {
      typesafeKey: "ts-key",
      decisionDeadline: -1,
    });
    const out = await j.judgeQueries(PROFILE, [{ campaign: "К", query: "q" }], []);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TYPESAFE_URL);
    expect(JSON.parse(calls[0].init!.body!).model).toBe(TYPESAFE_MODEL);
    expect(out[0].backend).toBe("typesafe");
  });
});
