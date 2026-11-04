import type { Job, Project, Settings, Stage } from "../../model.ts";

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

const A = ".bb/chats/thr_tg5k5pegz2/artifacts";
const T = ".bb/chats/thr_tg5k5pegz2/tmp";

const stage = (
  id: string,
  title: string,
  command: string,
  opts: { required?: boolean; outputs?: string[]; reuse?: boolean; emptyStops?: boolean } = {},
): Stage => ({
  id,
  title,
  command,
  required: opts.required ?? true,
  outputs: opts.outputs ?? [],
  reuse: opts.reuse ?? false,
  emptyStops: opts.emptyStops ?? false,
});

const NIGHT_PRELUDE = `. ./night_lock.sh
night_lock_acquire $$ || { echo "night export already running" >&2; exit 1; }
trap 'rm -rf "$NIGHT_LOCK"' EXIT
JEV_OPENLUX_DEADLINE=$(( $(date +%s) + 3 * 3600 ))
JEV_TYPESAFE_FLAG="$PWD/$NIGHT_LOCK/jev_typesafe"
export JEV_OPENLUX_DEADLINE JEV_TYPESAFE_FLAG PYTHONDONTWRITEBYTECODE=1`;

const SYNC_PRELUDE = `. ./night_lock.sh
if night_run_held; then echo "night export running, skipped"; exit 0; fi
export PYTHONDONTWRITEBYTECODE=1`;

const job = (j: Job): Job => j;

export function fixtureProjects(): Project[] {
  const alphaJobs: Job[] = [
    job({
      id: "night-export",
      title: "Ночная выгрузка",
      hours: [3],
      minute: 0,
      weekdays: ALL_DAYS,
      reportDay: "yesterday",
      prelude: NIGHT_PRELUDE,
      stages: [
        stage("review-sync", "Синхронизация библиотек", `[ ! -f data/google_sheet.json ] || ./run_review_sync.sh`, { required: false }),
        stage("snapshot", "Снимок Директа", `python3 snapshot_window.py --date {date} --days 2`, {
          outputs: [`${T}/search_window_{date}.tsv`],
          reuse: true,
          emptyStops: true,
        }),
        stage("audit", "Оценка запросов", `python3 direct_query_audit.py --date {date} --input-tsv ${T}/search_window_{date}.tsv --output ${A}/search_queries_{date}.csv`, {
          outputs: [`${A}/search_queries_{date}.csv`],
          reuse: true,
          emptyStops: true,
        }),
        stage("serp-review", "Проверка выдачи", `python3 serp_review.py --input ${A}/search_queries_{date}.csv --max-new 25`, {
          required: false,
          outputs: [`${A}/serp_review_{date}.csv`],
        }),
        stage("candidates", "Кандидаты в минус", `python3 negative_candidates.py --input ${A}/search_queries_{date}.csv`, {
          required: false,
          outputs: [`${A}/negative_candidates_{date}.csv`],
        }),
        stage("export", "Выгрузка клиенту", `python3 review_export.py --input ${A}/search_queries_{date}.csv`, {
          outputs: [`${A}/client_review_{date}.csv`],
        }),
        stage("upload", "Загрузка в таблицу", `[ ! -f data/google_sheet.json ] || python3 google_sheet_sync.py --input ${A}/client_review_{date}.csv`),
      ],
      catchUpHours: [4, 6, 9, 12],
      timeoutMin: 300,
      enabled: true,
    }),
    job({
      id: "library-sync",
      title: "Синхронизация минусов",
      hours: [0, 4, 8, 12, 16, 20],
      minute: 0,
      weekdays: ALL_DAYS,
      reportDay: "today",
      prelude: SYNC_PRELUDE,
      stages: [stage("sync", "Синхронизация", `./run_review_sync.sh`)],
      catchUpHours: [],
      timeoutMin: 60,
      enabled: true,
    }),
    job({
      id: "weekly-tree",
      title: "Расходы по неделям",
      hours: [0, 4, 8, 12, 16, 18, 20],
      minute: 0,
      weekdays: ALL_DAYS,
      reportDay: "today",
      prelude: SYNC_PRELUDE,
      stages: [stage("tree", "Лист расходов", `python3 weekly_tree.py`)],
      catchUpHours: [],
      timeoutMin: 30,
      enabled: true,
    }),
    job({
      id: "bids",
      title: "Ставки",
      hours: [0, 6, 12, 18],
      minute: 3,
      weekdays: ALL_DAYS,
      reportDay: "today",
      prelude: "",
      stages: [stage("bids", "Ставки", `./run_bids.sh >> data/bids.log 2>&1`)],
      catchUpHours: [],
      timeoutMin: 60,
      enabled: true,
    }),
  ];

  const betaJobs: Job[] = [
    job({
      id: "autominus",
      title: "Автоминусовка",
      hours: [0, 12],
      minute: 0,
      weekdays: ALL_DAYS,
      reportDay: "today",
      prelude: "",
      stages: [stage("run", "Прогон", `./run.sh >> cron.log 2>&1`)],
      catchUpHours: [],
      timeoutMin: 120,
      enabled: true,
    }),
    job({
      id: "bids",
      title: "Ставки",
      hours: [0, 6, 12, 18],
      minute: 30,
      weekdays: ALL_DAYS,
      reportDay: "today",
      prelude: "",
      stages: [stage("bids", "Ставки", `./run_bids.sh >> bids.log 2>&1`)],
      catchUpHours: [],
      timeoutMin: 60,
      enabled: true,
    }),
  ];

  return [
    {
      id: "alpha",
      title: "alpha.example",
      site: "alpha.example",
      hostId: "host_alpha",
      cwd: "/srv/alpha",
      direct: { account: "alpha-account" },
      enabled: true,
      jobs: alphaJobs,
    },
    {
      id: "beta",
      title: "beta.example",
      site: "beta.example",
      hostId: "host_beta",
      cwd: "/srv/beta",
      direct: { account: "beta-account" },
      enabled: false,
      jobs: betaJobs,
    },
  ];
}

export function fixtureSettings(): Settings {
  return {
    morningLine: {
      enabled: true,
      hostId: "host_alpha",
      command: "notify-send {file}",
      hour: 9,
    },
    telegram: { enabled: false, chatId: "" },
    timeZone: "Europe/Moscow",
  };
}

export function fixturePipelineProject(): Project {
  return {
    id: "gamma",
    title: "gamma.example",
    site: "gamma.example",
    enabled: true,
    jobs: [],
    pipeline: {
      accountId: "acc-gamma",
      sheetId: "sheet-gamma",
      profile: {
        site: "https://gamma.example/",
        company: "Gamma",
        buyer: "Buyers",
        offers: ["Offer"],
        advertising_goal: "Orders",
        boundaries: ["Off-topic"],
      },
      serp: { enabled: true, budget: 25, lr: 225, device: "desktop" },
      library: { enabled: true, apply: true },
      schedule: { hour: 3, catchUpHours: [4, 6, 9, 12], syncHours: [0, 4, 8, 12, 16, 20] },
    },
  };
}
