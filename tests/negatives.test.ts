import { describe, expect, it } from "vitest";
import {
  NEGATIVE_PHRASE_VERSION,
  directSafe,
  negativeCandidates,
  phraseCandidates,
  rulePhrase,
  suggestPhrases,
  type AuditRow,
} from "../negatives.ts";
import type { CachePort } from "../judge.ts";

const GENERIC = new Set(["фильтр", "фильтры", "система", "установка", "очистка"]);

const auditRow = (query: string, extra: Partial<AuditRow> = {}): AuditRow => ({
  CampaignId: "1",
  AdGroupId: "7",
  Query: query,
  Impressions: "10",
  Clicks: "1",
  status: "нерелевантен",
  decision_source: "jev",
  ...extra,
});

describe("negativeCandidates", () => {
  const audit: AuditRow[] = [
    auditRow("детский очиститель воздуха", { Impressions: "40", Clicks: "3" }),
    auditRow("детский очиститель воздуха"),
    auditRow("детский очиститель воздуха для спальни", { status: "релевантен", Impressions: "50", Clicks: "4" }),
    auditRow("промышленный фильтр", { status: "релевантен", Impressions: "90", Clicks: "8" }),
    auditRow("очень длинный запрос из восьми разных слов вообще", { Impressions: "20", Clicks: "2" }),
    auditRow("вибратор для бетона", { status: "проверить", Impressions: "30", Clicks: "2" }),
  ];

  it("matches a hand-computed list for a small audit fixture", () => {
    const serp = [
      { CampaignId: "1", AdGroupId: "7", Query: "вибратор для бетона", review_status: "кандидат в минуса" },
    ];
    const out = negativeCandidates(audit, serp);
    expect(out).toEqual([
      {
        CampaignId: "1", AdGroupId: "7",
        query: "детский очиститель воздуха",
        negative_phrase: "детский очиститель воздуха",
        impressions: 50, clicks: 4,
        decision_source: "jev",
        review_status: "не предлагать: пересечение",
        overlap_examples: "детский очиститель воздуха для спальни",
      },
      {
        CampaignId: "1", AdGroupId: "7",
        query: "вибратор для бетона",
        negative_phrase: "вибратор для бетона",
        impressions: 30, clicks: 2,
        decision_source: "xmlstock_top20",
        review_status: "проверить перед добавлением",
        overlap_examples: "",
      },
      {
        CampaignId: "1", AdGroupId: "7",
        query: "очень длинный запрос из восьми разных слов вообще",
        negative_phrase: "",
        impressions: 20, clicks: 2,
        decision_source: "jev",
        review_status: "не предлагать: более 7 слов",
        overlap_examples: "",
      },
    ]);
  });

  it("keeps a проверить row without a minus serp verdict out of negatives", () => {
    const out = negativeCandidates([
      auditRow("спорный запрос", { status: "проверить" }),
      auditRow("нужный запрос", { status: "релевантен" }),
    ]);
    expect(out).toEqual([]);
  });
});

describe("rulePhrase / directSafe", () => {
  it("picks a number plus a short non-generic neighbour for a model-like query", () => {
    expect(rulePhrase("фильтр пластина 12345 для цеха", GENERIC)).toBe("пластина 12345");
    expect(phraseCandidates("фильтр пластина 12345 для цеха", (q) => rulePhrase(q, GENERIC), GENERIC)).toEqual([
      "пластина 12345",
      "пластина",
      "цеха",
      "фильтр пластина",
      "фильтр пластина 12345 для цеха",
    ]);
  });

  it("returns the whole query when nothing better applies", () => {
    expect(rulePhrase("Детский Очиститель купить", GENERIC)).toBe("Детский Очиститель купить");
    expect(rulePhrase("детский очиститель", GENERIC)).toBe("детский очиститель");
  });

  it("empty for over seven words", () => {
    expect(rulePhrase("очень длинный запрос из восьми разных слов вообще", GENERIC)).toBe("");
  });

  it("directSafe strips article-like numbers and stray punctuation", () => {
    expect(directSafe("фильтр л4.5 купить 1587.03.06.00.00")).toBe("фильтр л4 5 купить 1587 03 06 00 00");
  });
});

const memoryCache = (): CachePort & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: (key: string, value: unknown) => void map.set(key, value),
  };
};

describe("suggestPhrases", () => {
  const fallback = (q: string) => rulePhrase(q, GENERIC);
  const query = "фильтр пластина 12345 для цеха";

  it("asks Jev with fragments and returns the chosen option", async () => {
    let seen: any;
    const ask = async (req: any) => {
      seen = req;
      return {
        negative_0: { choice: "c1", probabilities: { c1: 0.82 }, confidence: 0.9 },
      };
    };
    const out = await suggestPhrases([query], fallback, GENERIC, ask, memoryCache());
    expect(seen.state.items).toEqual([
      { query, fragments: ["пластина 12345", "пластина", "цеха", "фильтр пластина", query] },
    ]);
    expect(seen.questions.negative_0.criteria.c1).toBe("Добавить в минуса: пластина");
    expect(out[query]).toEqual({ phrase: "пластина", probability: 0.82, confidence: 0.9 });
  });

  it("falls back to the rule phrase when the judge throws", async () => {
    const ask = async () => {
      throw new Error("jev down");
    };
    const out = await suggestPhrases([query, "детский очиститель"], fallback, GENERIC, ask, memoryCache());
    expect(out[query]).toEqual({ phrase: "пластина 12345", probability: 0, confidence: 0 });
    expect(out["детский очиститель"]).toEqual({ phrase: "детский очиститель", probability: 0, confidence: 0 });
  });

  it("serves a cached suggestion under the version key without asking Jev", async () => {
    const cache = memoryCache();
    cache.map.set(`${NEGATIVE_PHRASE_VERSION}\t${query}`, {
      phrase: "цеха", probability: 0.7, confidence: 0.8,
    });
    let asked = false;
    const ask = async () => {
      asked = true;
      throw new Error("must not be called");
    };
    const out = await suggestPhrases([query], fallback, GENERIC, ask, cache);
    expect(asked).toBe(false);
    expect(out[query]).toEqual({ phrase: "цеха", probability: 0.7, confidence: 0.8 });
  });
});
