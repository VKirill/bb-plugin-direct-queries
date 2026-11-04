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
