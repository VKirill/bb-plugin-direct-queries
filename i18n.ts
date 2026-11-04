import { useEffect, useState } from "react";

export const en = {
  title: "Direct queries",
  description: "Yandex Direct search-query analysis and negatives",
  dashboardTab: "Dashboard",
  projectsTab: "Projects",
  settingsTab: "Settings",
  lastTick: "Last tick",
  morningAt: "morning line",
  sent: "sent",
  notSent: "not sent",
  rerun: "Rerun",
  showLog: "Show log",
  stage: "Stage",
  status: "Status",
  rowsInOut: "Rows in → out",
  paid: "Paid",
  judge: "Judge",
  duration: "Duration",
  firstError: "First error",
  emptyTitle: "No projects yet",
  emptyBody: "Register a project to run its query pipeline on schedule.",
  openProjects: "Open projects",
  project: "Project",
  job: "Job",
  enabled: "Enabled",
  save: "Save",
  saved: "Saved",
  json: "JSON",
  invalidJson: "Invalid JSON",
  off: "off",
  morningLine: "Morning line",
  morningHost: "Host",
  morningCommand: "Command",
  morningHour: "Hour (MSK)",
  preview: "Preview",
  close: "Close",
  loading: "Loading…",
  error: "Something went wrong",
  green: "ok",
  amber: "ok with gaps",
  red: "failed",
  grey: "no shows",
  empty: "not run",
  running: "running",
};

export const ru: typeof en = {
  title: "Запросы Директа",
  description: "Анализ поисковых запросов Яндекс Директа и минус-фразы",
  dashboardTab: "Дашборд",
  projectsTab: "Проекты",
  settingsTab: "Настройки",
  lastTick: "Тик",
  morningAt: "утренняя сводка",
  sent: "отправлена",
  notSent: "не отправлена",
  rerun: "Перезапуск",
  showLog: "Показать лог",
  stage: "Этап",
  status: "Статус",
  rowsInOut: "Строк в → из",
  paid: "Оплачено",
  judge: "Судья",
  duration: "Длительность",
  firstError: "Первая ошибка",
  emptyTitle: "Проектов нет",
  emptyBody: "Добавьте проект, чтобы запускать его конвейер по расписанию.",
  openProjects: "К проектам",
  project: "Проект",
  job: "Задача",
  enabled: "Включено",
  save: "Сохранить",
  saved: "Сохранено",
  json: "JSON",
  invalidJson: "Неверный JSON",
  off: "выкл",
  morningLine: "Утренняя сводка",
  morningHost: "Хост",
  morningCommand: "Команда",
  morningHour: "Час (МСК)",
  preview: "Предпросмотр",
  close: "Закрыть",
  loading: "Загрузка…",
  error: "Что-то пошло не так",
  green: "ок",
  amber: "ок с пропусками",
  red: "упало",
  grey: "показов не было",
  empty: "не запускался",
  running: "идёт",
};

export type Locale = "en" | "ru";

export function detectLocale(): Locale {
  if (typeof document === "undefined") return "en";
  if (document.documentElement.lang.toLowerCase().startsWith("ru")) return "ru";
  if (document.documentElement.getAttribute("data-pk-lang") === "ru") return "ru";
  const labels = [
    ...document.querySelectorAll(
      '[data-sidebar="sidebar"] button[aria-label],header button[aria-label]',
    ),
  ]
    .slice(0, 30)
    .map((x) => x.getAttribute("aria-label") ?? "");
  return labels.some((l) => /[\u0400-\u04FF]/.test(l)) ? "ru" : "en";
}

export function observeLocale(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["lang", "data-pk-lang", "aria-label"],
  });
  window.addEventListener("storage", listener);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", listener);
  };
}

export function strings(): typeof en {
  return detectLocale() === "ru" ? ru : en;
}

export function useStrings(): typeof en {
  const [value, setValue] = useState(strings);
  useEffect(() => {
    const sync = () => setValue(strings());
    return observeLocale(sync);
  }, []);
  return value;
}
