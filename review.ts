export const REVIEW_COLUMNS = [
  "Дата сбора",
  "Поисковый запрос",
  "Кандидат в минус",
  "Решение клиента",
  "Релевантность выдачи",
  "Позиция сайта",
  "Есть конкуренты",
  "Ср. позиция показа",
  "Ср. позиция клика",
  "Предлагаемый минус",
  "Источник предложения",
  "В библиотеке",
  "Показы",
  "Клики",
  "Расход, ₽",
  "Цена клика, ₽",
  "Кампании",
  "Оценка модели",
  "Проверка сайта",
  "Страница сайта",
  "Комментарий клиента",
] as const;

export type ReviewColumn = (typeof REVIEW_COLUMNS)[number];
export type ReviewRow = Record<ReviewColumn, string | number>;

export type ReviewAuditRow = {
  campaign: string;
  campaignId?: string;
  group?: string;
  query: string;
  impressions: number;
  clicks: number;
  cost: number;
  avgImpressionPosition?: number | string;
  avgClickPosition?: number | string;
  conversions?: number;
  status: string;
  score?: number;
  reason?: string;
};

export type ReviewSerpRow = {
  campaignId?: string;
  query: string;
  reviewStatus?: string;
  position?: string | number;
  pageUrl?: string;
  rivals?: string[];
  topic?: number;
  commercial?: number;
};

export type ReviewSuggestion = {
  phrase: string;
  source?: string;
  probability?: number;
};

export type BuildReviewRowsInput = {
  date: string;
  audit: ReviewAuditRow[];
  serp?: ReviewSerpRow[];
  inLibrary?: Set<string>;
  suggestedNegatives?: Record<string, ReviewSuggestion | string>;
};

const PRIORITY: Record<string, number> = { Да: 0, Проверить: 1, Нет: 2 };

export const normalizeQuery = (query: string): string => query.trim().toLowerCase();

const missing = (value: number | string | undefined): boolean =>
  value === undefined || value === "" || value === "--";

export const averagePosition = (
  rows: ReviewAuditRow[],
  field: "avgImpressionPosition" | "avgClickPosition",
  weight: "impressions" | "clicks",
): string => {
  const pairs: [number, number][] = [];
  for (const row of rows) {
    const raw = row[field];
    const count = row[weight];
    if (missing(raw) || !count) continue;
    const value = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
    if (!Number.isFinite(value)) continue;
    pairs.push([value, count]);
  }
  const total = pairs.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return "";
  const avg = pairs.reduce((sum, [value, count]) => sum + value * count, 0) / total;
  return avg.toFixed(2).replace(".", ",");
};

const money = (value: number): string => value.toFixed(2);

const lookupSerp = (
  reviews: Map<string, ReviewSerpRow>,
  row: ReviewAuditRow,
  query: string,
): ReviewSerpRow | undefined => {
  if (row.campaignId) {
    const hit = reviews.get(`${row.campaignId}\t${query}`);
    if (hit) return hit;
  }
  return reviews.get(query);
};

const suggestionFor = (
  suggested: Record<string, ReviewSuggestion | string> | undefined,
  query: string,
  original: string,
): ReviewSuggestion | undefined => {
  if (!suggested) return undefined;
  const raw = suggested[original] ?? suggested[query];
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? { phrase: raw } : raw;
};

const candidateFor = (status: string, reviewStatus: string | undefined): string => {
  if (status === "релевантен" || reviewStatus === "оставить") return "Нет";
  if (status === "нерелевантен" || reviewStatus === "кандидат в минуса") return "Да";
  return "Проверить";
};

export const buildReviewRows = (input: BuildReviewRowsInput): ReviewRow[] => {
  const reviews = new Map<string, ReviewSerpRow>();
  for (const row of input.serp ?? []) {
    const query = normalizeQuery(row.query);
    if (row.campaignId) reviews.set(`${row.campaignId}\t${query}`, row);
    if (!reviews.has(query)) reviews.set(query, row);
  }
  const grouped = new Map<string, ReviewAuditRow[]>();
  for (const row of input.audit) {
    const key = normalizeQuery(row.query);
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  const result: ReviewRow[] = [];
  for (const [query, rows] of grouped) {
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    const cost = rows.reduce((sum, row) => sum + row.cost, 0);
    const statuses = [...new Set(rows.map((row) => row.status))];
    const queryReviews = rows.map((row) => lookupSerp(reviews, row, query));
    const decisions = rows.map((row, index) =>
      candidateFor(row.status, queryReviews[index]?.reviewStatus),
    );
    const candidate =
      decisions.includes("Нет") ? "Нет" : decisions.every((value) => value === "Да") ? "Да" : "Проверить";
    const positions = queryReviews
      .map((review) => (review ? String(review.position ?? "") : ""))
      .filter((value) => /^\d+$/.test(value))
      .map(Number);
    const hasReviewStatus = queryReviews.some((review) => review?.reviewStatus);
    const position =
      positions.length > 0 ? Math.min(...positions) : hasReviewStatus ? "Нет в топ-20" : "";
    const reviewStatuses = [
      ...new Set(queryReviews.flatMap((review) => (review?.reviewStatus ? [review.reviewStatus] : []))),
    ].sort();
    const pages = [
      ...new Set(queryReviews.flatMap((review) => (review?.pageUrl ? [review.pageUrl] : []))),
    ].sort();
    const rivals = [
      ...new Set(queryReviews.flatMap((review) => review?.rivals ?? [])),
    ];
    const fit = queryReviews.find((review) => review?.topic !== undefined || review?.commercial !== undefined);
    let relevancy = "";
    try {
      if (fit && (fit.topic !== undefined || fit.commercial !== undefined)) {
        relevancy = `тема ${fit.topic ?? 0}% · коммерция ${fit.commercial ?? 0}%`;
      }
    } catch {
      relevancy = "";
    }
    let library = "";
    try {
      if (input.inLibrary) library = input.inLibrary.has(query) ? "да" : "нет";
    } catch {
      library = "";
    }
    const suggestion = suggestionFor(input.suggestedNegatives, query, rows[0].query);
    const minus = candidate === "Нет" ? "" : (suggestion?.phrase ?? "");
    let source = "";
    if (suggestion && minus) {
      if (suggestion.source) source = suggestion.source;
      else if (suggestion.probability !== undefined) {
        source = `Jev · ${Math.round(suggestion.probability * 100)}%`;
        if (suggestion.probability < 0.5) source += " · проверить";
      }
    }
    let candidateOut = candidate;
    let rivalsOut = "";
    if (rivals.length > 0) {
      rivalsOut = "Да: " + rivals.join(", ");
      candidateOut = { Да: "Проверить", Проверить: "Нет", Нет: "Нет" }[candidate] ?? candidate;
    } else if (queryReviews.some((review) => review?.rivals)) {
      rivalsOut = "Нет";
    }
    const minusOut = candidateOut === "Нет" ? "" : minus;
    result.push({
      "Дата сбора": input.date,
      "Поисковый запрос": rows[0].query,
      "Кандидат в минус": candidateOut,
      "Решение клиента": "",
      "Релевантность выдачи": relevancy,
      "Позиция сайта": position,
      "Есть конкуренты": rivalsOut,
      "Ср. позиция показа": averagePosition(rows, "avgImpressionPosition", "impressions"),
      "Ср. позиция клика": averagePosition(rows, "avgClickPosition", "clicks"),
      "Предлагаемый минус": minusOut,
      "Источник предложения": candidateOut === "Нет" ? "" : source,
      "В библиотеке": library,
      Показы: impressions,
      Клики: clicks,
      "Расход, ₽": money(cost),
      "Цена клика, ₽": clicks ? money(cost / clicks) : "",
      Кампании: [...new Set(rows.map((row) => row.campaign))].sort().join(" | "),
      "Оценка модели": statuses.sort().join(", "),
      "Проверка сайта": reviewStatuses.join(", "),
      "Страница сайта": pages.join(" | "),
      "Комментарий клиента": "",
    });
  }
  return result.sort(
    (a, b) =>
      (PRIORITY[String(a["Кандидат в минус"])] ?? 9) - (PRIORITY[String(b["Кандидат в минус"])] ?? 9) ||
      Number(b.Клики) - Number(a.Клики) ||
      Number(b.Показы) - Number(a.Показы) ||
      String(a["Поисковый запрос"]).localeCompare(String(b["Поисковый запрос"]), "ru"),
  );
};
