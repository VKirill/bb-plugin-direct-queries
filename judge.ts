// Jev (System One) relevance judge for search queries against a site profile.
// Port of the OpenLux→TypeSafe judge from the reference direct-query audit:
// same payload shape, batch size, retry waits, deadline fallback and feedback memory.

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export type SleepFn = (ms: number) => void | Promise<void>;

export interface CachePort {
  get<T>(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: unknown): void | Promise<void>;
}

export interface SiteProfile {
  site: string;
  company: string;
  buyer: string;
  offers: string[];
  advertising_goal: string;
  boundaries: string[];
  evidence?: string[];
}

export type Feedback = { query: string; decision: "relevant" | "irrelevant" }[];

export interface JudgeItem {
  campaign: string;
  query: string;
}

export interface ClientExample {
  query: string;
  decision: "Оставить" | "В минус";
  similarity: number;
}

export interface JudgeResult {
  query: string;
  campaign: string;
  status: "релевантен" | "нерелевантен" | "проверить";
  score: number | null;
  reason: string;
  intent: string;
  confidence: number | null;
  decisionSource: "jev" | "jev_with_feedback" | "client_analogy" | "user_feedback";
}

export type JevAnswer = Record<string, any>;
export type JevAnswers = Record<string, JevAnswer>;
export interface JevRequest {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}
export type JevAsk = (req: JevRequest) => Promise<JevAnswers>;

export const OPENLUX_URL = "https://api.openlux.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0:stable";
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-1.13.0";
const JEV_WAITS_S = [30, 60, 120, 240, 300];
const NIGHT_WAIT_CAP_S = 600;

export class JevUnavailable extends Error {
  constructor(message = "Jev unavailable") {
    super(message);
    this.name = "JevUnavailable";
  }
}

const FEEDBACK_GENERIC = new Set([
  "купить", "цена", "заказать", "для", "и", "в", "на", "по", "с", "со", "от", "до", "из", "про",
  "оборудование", "установка", "система",
]);

export function feedbackTokens(text: string): string[] {
  return text.toLowerCase().match(/[0-9a-zа-яё]+/g) ?? [];
}

// difflib.SequenceMatcher.ratio(): 2*M/T over recursive longest matches.
function longestMatch(
  a: string, alo: number, ahi: number,
  b2j: Map<string, number[]>, b: string, blo: number, bhi: number,
): [number, number, number] {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = next;
  }
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--; bestj--; bestsize++;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi &&
         a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize++;
  }
  return [besti, bestj, bestsize];
}

function matchCount(
  a: string, b: string, b2j: Map<string, number[]>,
  alo: number, ahi: number, blo: number, bhi: number,
): number {
  const [i, j, size] = longestMatch(a, alo, ahi, b2j, b, blo, bhi);
  if (size === 0) return 0;
  return size + matchCount(a, b, b2j, alo, i, blo, j) + matchCount(a, b, b2j, i + size, ahi, j + size, bhi);
}

function sequenceRatio(a: string, b: string): number {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const idxs = b2j.get(b[j]);
    if (idxs) idxs.push(j);
    else b2j.set(b[j], [j]);
  }
  const matched = matchCount(a, b, b2j, 0, a.length, 0, b.length);
  const total = a.length + b.length;
  return total ? (2 * matched) / total : 1;
}

export function feedbackSimilarity(query: string, example: string): number {
  const queryWords = feedbackTokens(query);
  const exampleWords = feedbackTokens(example);
  const coverage = (left: string[], right: string[]): number => {
    let total = 0;
    let matched = 0;
    for (const word of left) {
      const weight = FEEDBACK_GENERIC.has(word) ? 0.35 : 1;
      total += weight;
      let best = 0;
      for (const candidate of right) best = Math.max(best, sequenceRatio(word, candidate));
      matched += weight * best;
    }
    return total ? matched / total : 0;
  };
  return 0.75 * coverage(queryWords, exampleWords) + 0.25 * coverage(exampleWords, queryWords);
}

const bySimilarity = (a: ClientExample, b: ClientExample): number =>
  b.similarity - a.similarity || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0);

export function similarFeedback(
  query: string,
  feedback: Feedback,
  limitPerDecision = 2,
  minSimilarity = 0.58,
): ClientExample[] {
  const normalized = query.toLowerCase().trim();
  const matches: Record<"Оставить" | "В минус", ClientExample[]> = { "Оставить": [], "В минус": [] };
  for (const entry of feedback) {
    const example = entry.query;
    if (example.toLowerCase().trim() === normalized) continue;
    const status = entry.decision === "relevant" ? "релевантен" : "нерелевантен";
    const similarity = feedbackSimilarity(query, example);
    if (similarity < minSimilarity) continue;
    const decision = status === "релевантен" ? "Оставить" : "В минус";
    matches[decision].push({ query: example, decision, similarity: Math.round(similarity * 1000) / 1000 });
  }
  const selected: ClientExample[] = [];
  for (const decision of ["Оставить", "В минус"] as const) {
    selected.push(...matches[decision].slice().sort(bySimilarity).slice(0, limitPerDecision));
  }
  return selected.sort(bySimilarity);
}

const normQuery = (text: string): string => text.toLowerCase().trim();
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export function createJudge(args: {
  openluxKey: string;
  typesafeKey?: string;
  fetch: FetchLike;
  sleep: SleepFn;
  now: () => number;
  cache: CachePort;
  openluxDeadline?: number;
}) {
  const { openluxKey, typesafeKey, fetch, sleep, now, cache, openluxDeadline } = args;
  let openluxGivenUp = false;

  const post = async (
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.text() };
  };

  const retryable = (status: number): boolean => status === 429 || status >= 500;

  const attempts = async (
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    limit: number,
  ): Promise<string> => {
    for (const wait of [...JEV_WAITS_S, null] as (number | null)[]) {
      let status: number;
      let body: string;
      try {
        ({ status, body } = await post(url, payload, headers));
      } catch (e) {
        if (wait === null) throw e;
        await sleep(wait * 1000);
        continue;
      }
      if (status === 200) return body;
      if (!retryable(status) || wait === null)
        throw new Error(`Jev HTTP ${status}: ${body.slice(0, limit)}`);
      await sleep(wait * 1000);
    }
    throw new Error("unreachable");
  };

  const openluxUntil = async (
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    limit: number,
  ): Promise<string> => {
    const waits = JEV_WAITS_S[Symbol.iterator]();
    while (true) {
      let status: number | undefined;
      let body = "";
      try {
        ({ status, body } = await post(OPENLUX_URL, payload, headers));
      } catch {
        // dropped connection or timeout: keep asking until the deadline
      }
      if (status === 200) return body;
      if (status !== undefined && !retryable(status))
        throw new Error(`Jev HTTP ${status}: ${body.slice(0, limit)}`);
      const leftMs = (openluxDeadline as number) - now();
      if (leftMs <= 0) throw new JevUnavailable();
      const waitS = waits.next().value ?? NIGHT_WAIT_CAP_S;
      await sleep(Math.min(waitS * 1000, NIGHT_WAIT_CAP_S * 1000, leftMs));
    }
  };

  const jevPost = async (
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    limit = 300,
  ): Promise<string> => {
    if (openluxDeadline === undefined) return attempts(OPENLUX_URL, payload, headers, limit);
    if (!openluxGivenUp) {
      try {
        return await openluxUntil(payload, headers, limit);
      } catch (e) {
        if (!(e instanceof JevUnavailable)) throw e;
        openluxGivenUp = true;
      }
    }
    if (!typesafeKey) throw new JevUnavailable("OpenLux deadline passed and no TypeSafe key");
    return attempts(
      TYPESAFE_URL,
      { ...payload, model: TYPESAFE_MODEL },
      { ...headers, Authorization: `Bearer ${typesafeKey}` },
      limit,
    );
  };

  const openluxHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${openluxKey}`,
    "Content-Type": "application/json",
  });

  const ask: JevAsk = async (req) => {
    const body = await jevPost({ model: JEV_MODEL, state: req.state, questions: req.questions }, openluxHeaders());
    return JSON.parse(body).answers;
  };

  const buildQuestions = (items: { campaign_name: string; query: string; client_examples: ClientExample[] }[]) => {
    const questions: Record<string, unknown> = {};
    items.forEach((item, index) => {
      const ref = `items[${index}]`;
      questions[`relevance_${index}`] = {
        type: "score",
        instructions:
          `Соответствует ли запрос \`${ref}.query\` рекламной цели \`profile.company\` и кампании \`${ref}.campaign_name\`? ` +
          `Учитывай \`profile.advertising_goal\`, \`profile.boundaries\` и прошлые решения клиента в \`${ref}.client_examples\`. ` +
          "Близкий пример с тем же товаром, моделью и намерением — сильный сигнал; не переноси решение по одному общему слову " +
          "и всегда учитывай текущую кампанию. Наличие товара в статье сайта или совпадение отдельных слов недостаточно. " +
          "Если смысл неясен, выбери средний уровень.",
        criteria: [
          "Запрос о другом товаре или задаче, которую эта реклама не должна привлекать.",
          "Смежный или неоднозначный запрос: без уточнения непонятно, является ли это потенциальным заказом по рекламируемому направлению.",
          "Прямой запрос на основной продукт или проект, соответствующий рекламируемому направлению.",
        ],
      };
      questions[`intent_${index}`] = {
        type: "choice",
        instructions: `Какой основной тип поискового запроса \`${ref}.query\`?`,
        criteria: {
          commercial: "Ищет товар, поставщика, цену, заказ или услугу.",
          informational: "Ищет объяснение, инструкцию или справку.",
          navigational: "Ищет конкретную компанию, сайт или бренд.",
          unclear: "Намерение нельзя определить по тексту.",
        },
      };
      if (item.client_examples.some((e) => e.decision === "Оставить")) {
        questions[`precedent_${index}`] = {
          type: "choice",
          instructions:
            `Сопоставь новый запрос \`${ref}.query\` с прошлыми решениями клиента \`${ref}.client_examples\`. ` +
            "Определи, сохраняет ли новый запрос тот же товар или класс продукта, модель и покупательское намерение, " +
            "что пример «Оставить». Опечатки и сокращение модели допустимы. Совпадение одного общего слова недостаточно. " +
            `Учитывай кампанию \`${ref}.campaign_name\`.`,
          criteria: {
            same_target: "Это тот же целевой спрос, что в примере «Оставить».",
            different_or_unclear: "Смысл отличается либо данных недостаточно для переноса решения.",
          },
        };
      }
    });
    return questions;
  };

  const judgeQueries = async (
    profile: SiteProfile,
    items: JudgeItem[],
    feedback: Feedback,
  ): Promise<JudgeResult[]> => {
    const manual = new Map<string, "релевантен" | "нерелевантен">();
    for (const f of feedback)
      manual.set(normQuery(f.query), f.decision === "relevant" ? "релевантен" : "нерелевантен");

    const byKey = new Map<string, JudgeResult>();
    const pending: { item: JudgeItem; key: string; examples: ClientExample[] }[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${normQuery(item.query)}\t${normQuery(item.campaign)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const labelled = manual.get(normQuery(item.query));
      if (labelled !== undefined) {
        byKey.set(key, {
          query: item.query, campaign: item.campaign, status: labelled, score: null,
          reason: "решение клиента", intent: "", confidence: null, decisionSource: "user_feedback",
        });
        continue;
      }
      const cached = await cache.get<JudgeResult>(`judge\t${key}`);
      if (cached !== undefined) {
        byKey.set(key, cached);
        continue;
      }
      pending.push({ item, key, examples: similarFeedback(item.query, feedback) });
    }

    for (let start = 0; start < pending.length; start += 10) {
      const batch = pending.slice(start, start + 10);
      const stateItems = batch.map((b) => ({
        campaign_name: b.item.campaign,
        query: b.item.query,
        client_examples: b.examples,
      }));
      const answers = await ask({
        state: { profile, items: stateItems },
        questions: buildQuestions(stateItems),
      });
      for (let index = 0; index < batch.length; index++) {
        const result = readBatchResult(batch[index], index, answers);
        byKey.set(batch[index].key, result);
        await cache.set(`judge\t${batch[index].key}`, result);
      }
    }

    return items.map(
      (item) => byKey.get(`${normQuery(item.query)}\t${normQuery(item.campaign)}`)!,
    );
  };

  const readBatchResult = (
    b: { item: JudgeItem; key: string; examples: ClientExample[] },
    index: number,
    answers: JevAnswers,
  ): JudgeResult => {
    const relevance = answers[`relevance_${index}`];
    const unrelated = Number(relevance.probabilities["0"]);
    const direct = Number(relevance.probabilities["2"]);
    let score = Math.round(Number(relevance.score) * 50);
    let status: JudgeResult["status"] =
      unrelated >= 0.8 ? "нерелевантен" : direct >= 0.65 ? "релевантен" : "проверить";
    let source: JudgeResult["decisionSource"] = b.examples.length ? "jev_with_feedback" : "jev";
    let confidence = round3(Number(relevance.confidence));
    let reason = "";
    const precedent = answers[`precedent_${index}`];
    const positiveSimilarity = Math.max(
      0,
      ...b.examples.filter((e) => e.decision === "Оставить").map((e) => e.similarity),
    );
    if (
      precedent && positiveSimilarity >= 0.8 &&
      Number(precedent.probabilities?.same_target ?? 0) >= 0.65
    ) {
      status = "релевантен";
      score = Math.max(score, 75);
      confidence = round3(Number(precedent.confidence));
      source = "client_analogy";
      reason = "перенос решения клиента по близкому примеру";
    }
    return {
      query: b.item.query, campaign: b.item.campaign, status, score, reason,
      intent: answers[`intent_${index}`].choice, confidence, decisionSource: source,
    };
  };

  const judgeSnippet = async (
    profile: SiteProfile,
    query: string,
    campaign: string,
    title: string,
    snippet: string,
  ): Promise<{ pageFit: number; adFit: number }> => {
    const answers = await ask({
      state: { profile, query, campaign, page_title: title, snippet },
      questions: {
        page_fit: {
          type: "noul",
          instructions:
            "`page_title` и `snippet` — заголовок и сниппет из поисковой выдачи Яндекса для найденной страницы сайта клиента, " +
            "а не полный текст страницы. Отвечает ли найденная страница, судя по заголовку и сниппету, на конкретный `query`?",
        },
        ad_fit: {
          type: "noul",
          instructions:
            "Соответствует ли потребность в `query` рекламной цели `profile.advertising_goal` и направлению `campaign`? " +
            "Оцени конкретный товар или проект; одного совпадения терминов мало.",
        },
      },
    });
    return { pageFit: Number(answers.page_fit.noul), adFit: Number(answers.ad_fit.noul) };
  };

  return { judgeQueries, judgeSnippet, ask };
}

export type Judge = ReturnType<typeof createJudge>;
