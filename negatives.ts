// Group-level negative-phrase candidates and Jev-chosen compact phrases.
// Port of negative_candidates.py and negative_phrase_jev.suggest_many:
// same grouping, overlap rules, candidate options and the cache version key.

import type { CachePort, JevAnswer, JevAsk } from "./judge.ts";

export const NEGATIVE_PHRASE_VERSION = "2026-09-23-v1";

const STOP = new Set([
  "для", "или", "это", "как", "что", "где", "при", "под", "над", "без", "его", "она", "они",
  "купить", "цена", "заказать",
]);

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

const isDecimal = (term: string): boolean => /^\p{Nd}+$/u.test(term);
const isAlpha = (term: string): boolean => /^\p{L}+$/u.test(term);
const hasDigit = (term: string): boolean => /\p{N}/u.test(term);

function overlaps(candidate: string, query: string): boolean {
  const left = new Set(words(candidate));
  const right = new Set(words(query));
  for (const w of left) if (!right.has(w)) return false;
  return true;
}

const cmpString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface AuditRow {
  CampaignId: string;
  AdGroupId: string;
  Query: string;
  Impressions: string | number;
  Clicks: string | number;
  status: string;
  decision_source?: string;
}

export interface SerpReviewRow {
  CampaignId: string;
  AdGroupId: string;
  Query: string;
  review_status: string;
}

export interface NegativeCandidate {
  CampaignId: string;
  AdGroupId: string;
  query: string;
  negative_phrase: string;
  impressions: number;
  clicks: number;
  decision_source: string;
  review_status: string;
  overlap_examples: string;
}

const toInt = (v: string | number): number => {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
};

export function negativeCandidates(auditRows: AuditRow[], serpRows: SerpReviewRow[] = []): NegativeCandidate[] {
  const serpReviews = new Map<string, SerpReviewRow>();
  for (const review of serpRows)
    serpReviews.set(`${review.CampaignId}\t${review.AdGroupId}\t${review.Query.toLowerCase()}`, review);

  const grouped = new Map<string, { campaignId: string; groupId: string; rows: AuditRow[] }>();
  for (const row of auditRows) {
    const key = `${row.CampaignId}\t${row.AdGroupId}`;
    let group = grouped.get(key);
    if (!group) {
      group = { campaignId: row.CampaignId, groupId: row.AdGroupId, rows: [] };
      grouped.set(key, group);
    }
    group.rows.push(row);
  }

  const candidates: NegativeCandidate[] = [];
  for (const { campaignId, groupId, rows } of grouped.values()) {
    const serpStatus = (row: AuditRow): string =>
      serpReviews.get(`${campaignId}\t${groupId}\t${row.Query.toLowerCase()}`)?.review_status ?? "";
    const protectedQueries = new Set(
      rows
        .filter(
          (row) =>
            row.status === "релевантен" ||
            (row.status === "проверить" && serpStatus(row) !== "кандидат в минуса"),
        )
        .map((row) => row.Query),
    );
    const negative = new Map<string, AuditRow[]>();
    for (const row of rows) {
      if (row.status === "нерелевантен" || serpStatus(row) === "кандидат в минуса") {
        const list = negative.get(row.Query) ?? [];
        list.push(row);
        negative.set(row.Query, list);
      }
    }
    for (const [query, matchedRows] of negative) {
      const collisions = [...protectedQueries].filter((good) => overlaps(query, good));
      const tooLong = words(query).length > 7;
      candidates.push({
        CampaignId: campaignId,
        AdGroupId: groupId,
        query,
        negative_phrase: tooLong ? "" : query,
        impressions: matchedRows.reduce((sum, r) => sum + toInt(r.Impressions), 0),
        clicks: matchedRows.reduce((sum, r) => sum + toInt(r.Clicks), 0),
        decision_source:
          matchedRows[0].status === "проверить"
            ? "xmlstock_top20"
            : (matchedRows[0].decision_source ?? "jev"),
        review_status: collisions.length
          ? "не предлагать: пересечение"
          : tooLong
            ? "не предлагать: более 7 слов"
            : "проверить перед добавлением",
        overlap_examples: collisions.sort(cmpString).slice(0, 5).join(" | "),
      });
    }
  }
  return candidates.sort(
    (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || cmpString(a.query, b.query),
  );
}

// direct_safe: Direct rejects article-like numbers (>2 digits after a period)
// and any character except letters, digits, spaces and - + ! [ ] " plus the decimal point.
export function directSafe(text: string): string {
  let s = text.replace(/(?<=\p{L})(\p{Nd}+)\.(?=\p{Nd})/gu, "$1 ");
  s = s.replace(/(?<![\p{L}\p{N}_])-|-(?![\p{L}\p{N}_])/gu, " ");
  s = s.replace(/\p{Nd}+(?:\.\p{Nd}+)+/gu, (m) =>
    /^\p{Nd}+\.\p{Nd}{1,2}$/u.test(m) ? m : m.replace(/\./g, " "),
  );
  return s
    .replace(/[^\p{L}\p{N}\s\-+!\[\]".]|_|\.(?!\p{N})/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

// Rule-based phrase fallback (the reference library_sync.phrase, minus client terms).
export function rulePhrase(query: string, generic: Set<string>): string {
  const terms = words(query);
  if (!terms.length || terms.length > 7 || terms.some((t) => t.length > 35)) return "";
  const digitTerms = terms.filter(hasDigit);
  const numbers = terms.filter((t) => isDecimal(t) && t.length >= 6 && t.length <= 9);
  if (numbers.length === 1 && terms.some(isAlpha) && digitTerms.length === 1) return numbers[0];
  const shortNumbers = terms
    .map((t, i) => [t, i] as const)
    .filter(([t]) => isDecimal(t) && t.length >= 3 && t.length <= 5)
    .map(([, i]) => i);
  if (shortNumbers.length === 1 && digitTerms.length === 1) {
    const index = shortNumbers[0];
    for (const neighbor of [index - 1, index + 1]) {
      if (
        neighbor >= 0 && neighbor < terms.length &&
        isAlpha(terms[neighbor]) && terms[neighbor].length >= 2 && terms[neighbor].length <= 8 &&
        !generic.has(terms[neighbor])
      ) {
        return terms.slice(Math.min(index, neighbor), Math.max(index, neighbor) + 1).join(" ");
      }
    }
  }
  return directSafe(query);
}

export function phraseCandidates(
  query: string,
  fallback: (q: string) => string,
  generic: Set<string>,
): string[] {
  const terms = words(query);
  const full = query;
  const skip = new Set([...generic, ...STOP]);
  const options: string[] = [fallback(query)];
  terms.forEach((term, index) => {
    if (isDecimal(term) && term.length >= 6 && term.length <= 9) options.push(term);
    if (isDecimal(term) && term.length >= 3 && term.length <= 5) {
      for (const neighbor of [index - 1, index + 1]) {
        if (
          neighbor >= 0 && neighbor < terms.length &&
          isAlpha(terms[neighbor]) && !skip.has(terms[neighbor]) && terms[neighbor].length >= 2
        ) {
          options.push(terms.slice(Math.min(index, neighbor), Math.max(index, neighbor) + 1).join(" "));
        }
      }
    }
  });
  for (const term of terms)
    if (isAlpha(term) && term.length >= 3 && !skip.has(term)) options.push(term);
  for (let i = 0; i + 1 < terms.length; i++) {
    const left = terms[i];
    const right = terms[i + 1];
    if (!STOP.has(left) && !STOP.has(right) && (!generic.has(left) || !generic.has(right)))
      options.push(`${left} ${right}`);
  }
  options.push(full);
  const unique = [
    ...new Set(
      options.filter(
        (o) => o && words(o).length <= 7 && words(o).every((t) => t.length <= 35),
      ),
    ),
  ];
  const top = unique.slice(0, 11);
  return unique.includes(full) && !top.includes(full) ? [...top, full] : top;
}

export interface PhraseSuggestion {
  phrase: string;
  probability: number;
  confidence: number;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export async function suggestPhrases(
  queries: string[],
  fallback: (q: string) => string,
  generic: Iterable<string>,
  judge: JevAsk | { ask: JevAsk },
  cache?: CachePort,
): Promise<Record<string, PhraseSuggestion>> {
  const genericSet = generic instanceof Set ? generic : new Set(generic);
  const ask: JevAsk = typeof judge === "function" ? judge : judge.ask;
  const toFlush = new Map<string, PhraseSuggestion>();
  const result: Record<string, PhraseSuggestion> = {};
  const pending: { query: string; key: string; options: string[] }[] = [];

  for (const query of new Set(queries)) {
    const key = `${NEGATIVE_PHRASE_VERSION}\t${query.toLowerCase().trim()}`;
    const hit = await cache?.get<PhraseSuggestion>(key);
    if (hit && phraseCandidates(query, fallback, genericSet).includes(hit.phrase)) {
      result[query] = hit;
      continue;
    }
    const options = phraseCandidates(query, fallback, genericSet);
    if (options.length) {
      pending.push({ query, key, options });
    } else {
      const empty = { phrase: "", probability: 0, confidence: 0 };
      toFlush.set(key, empty);
      result[query] = empty;
    }
  }

  for (let start = 0; start < pending.length; start += 10) {
    const batch = pending.slice(start, start + 10);
    const questions: Record<string, unknown> = {};
    batch.forEach(({ options }, index) => {
      questions[`negative_${index}`] = {
        type: "choice",
        instructions:
          `Клиент решает, исключать ли поисковый запрос items[${index}].query. ` +
          "Выбери самый короткий достаточный фрагмент для минус-фразы, который указывает на " +
          "нецелевую модель, товар или задачу. Не выбирай общие названия рекламируемого оборудования. " +
          "Если короткий фрагмент может отсечь целевой спрос, выбери полную фразу.",
        criteria: Object.fromEntries(
          options.map((option, position) => [`c${position}`, `Добавить в минуса: ${option}`]),
        ),
      };
    });
    let answers: Record<string, JevAnswer>;
    try {
      answers = await ask({
        state: { items: batch.map(({ query, options }) => ({ query, fragments: options })) },
        questions,
      });
      batch.forEach(({ query, key, options }, index) => {
        const answer = answers[`negative_${index}`];
        const choice = String(answer?.choice ?? "");
        const m = choice.match(/^c(\d+)$/);
        if (!m || Number(m[1]) >= options.length) throw new Error(`Jev вернул неизвестный вариант для ${query}`);
        const selection = {
          phrase: options[Number(m[1])],
          probability: round3(Number(answer.probabilities[choice])),
          confidence: round3(Number(answer.confidence)),
        };
        toFlush.set(key, selection);
        result[query] = selection;
      });
      for (const [key, value] of toFlush) {
        await cache?.set(key, value);
        toFlush.delete(key);
      }
    } catch {
      // Jev failed: rule-based phrase keeps the suggestion column filled
      for (const { query, options } of batch) {
        result[query] = { phrase: options[0] ?? "", probability: 0, confidence: 0 };
      }
    }
  }
  return result;
}
