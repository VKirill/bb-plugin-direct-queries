import { describe, it, expect, beforeEach } from "vitest";
import { en, ru, detectLocale } from "../i18n.ts";

describe("i18n", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.documentElement.removeAttribute("data-pk-lang");
    document.body.innerHTML = "";
  });

  it("en and ru have identical key sets", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("names the analytics tab in both locales", () => {
    expect(en.analyticsTab).toBe("Analytics");
    expect(ru.analyticsTab).toBe("Аналитика");
  });

  it("names the bids controls in both locales", () => {
    expect(en.bidsTitle).toBe("Search bids");
    expect(ru.bidsTitle).toBe("Ставки");
    expect(en.bidsEnable).toBe(
      "Adjust search bids along the traffic ladder every 6 hours",
    );
    expect(ru.bidsEnable).toBe(
      "Двигать ставки поиска по лестнице трафика каждые 6 часов",
    );
    expect(en.bidsApply).toBe("Change bids in Direct");
    expect(ru.bidsApply).toBe("Менять ставки в Директе");
    expect(en.bidsSkipCampaigns).toBe(
      "Skip campaigns (substring, one per line)",
    );
    expect(ru.bidsSkipCampaigns).toBe(
      "Не трогать кампании (подстрока, по одной в строке)",
    );
  });

  it("detects ru from document lang", () => {
    document.documentElement.lang = "ru";
    expect(detectLocale()).toBe("ru");
    document.documentElement.lang = "ru-RU";
    expect(detectLocale()).toBe("ru");
  });

  it("detects ru from data-pk-lang with lang=en", () => {
    document.documentElement.setAttribute("data-pk-lang", "ru");
    expect(detectLocale()).toBe("ru");
  });

  it("detects ru from a Cyrillic sidebar aria-label with lang=en", () => {
    document.body.innerHTML =
      '<div data-sidebar="sidebar"><button aria-label="Проекты"></button></div>';
    expect(detectLocale()).toBe("ru");
  });

  it("defaults to en", () => {
    document.body.innerHTML =
      '<div data-sidebar="sidebar"><button aria-label="Projects"></button></div>';
    expect(detectLocale()).toBe("en");
  });
});
