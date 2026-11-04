import { describe, it, expect } from "vitest";
import { REVIEW_COLUMNS, averagePosition, buildReviewRows, type ReviewAuditRow } from "../review.ts";

const PYTHON_FIELDS = [
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
];

const audit = (overrides: Partial<ReviewAuditRow> = {}): ReviewAuditRow => ({
  campaign: "Camp A",
  campaignId: "1",
  query: "sample query",
  impressions: 10,
  clicks: 2,
  cost: 1.5,
  avgImpressionPosition: 2,
  avgClickPosition: 1,
  status: "нерелевантен",
  ...overrides,
});

describe("REVIEW_COLUMNS", () => {
  it("equals the review_export.py header list in order", () => {
    expect([...REVIEW_COLUMNS]).toEqual(PYTHON_FIELDS);
  });
});

describe("buildReviewRows", () => {
  it("leaves SERP and library cells empty when that data is missing", () => {
    const rows = buildReviewRows({
      date: "2026-11-03",
      audit: [audit()],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]["Релевантность выдачи"]).toBe("");
    expect(rows[0]["Позиция сайта"]).toBe("");
    expect(rows[0]["Есть конкуренты"]).toBe("");
    expect(rows[0]["В библиотеке"]).toBe("");
    expect(rows[0]["Проверка сайта"]).toBe("");
    expect(rows[0]["Страница сайта"]).toBe("");
    expect(rows[0]["Решение клиента"]).toBe("");
    expect(rows[0]["Комментарий клиента"]).toBe("");
  });

  it("fills weighted positions from a hand-computed mix of campaigns", () => {
    const rows = buildReviewRows({
      date: "2026-11-03",
      audit: [
        audit({ campaign: "Camp A", impressions: 10, clicks: 2, avgImpressionPosition: 2, avgClickPosition: 1 }),
        audit({ campaign: "Camp B", campaignId: "2", impressions: 30, clicks: 6, avgImpressionPosition: 4, avgClickPosition: 2 }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]["Ср. позиция показа"]).toBe("3,50");
    expect(rows[0]["Ср. позиция клика"]).toBe("1,75");
    expect(averagePosition(
      [
        audit({ impressions: 10, clicks: 2, avgImpressionPosition: 2, avgClickPosition: 1 }),
        audit({ impressions: 30, clicks: 6, avgImpressionPosition: 4, avgClickPosition: 2 }),
      ],
      "avgImpressionPosition",
      "impressions",
    )).toBe("3,50");
  });

  it("skips blank and placeholder positions in the weighted average", () => {
    expect(
      averagePosition(
        [
          audit({ impressions: 10, avgImpressionPosition: "--" }),
          audit({ impressions: 10, avgImpressionPosition: "" }),
          audit({ impressions: 20, avgImpressionPosition: 5 }),
        ],
        "avgImpressionPosition",
        "impressions",
      ),
    ).toBe("5,00");
  });
});
