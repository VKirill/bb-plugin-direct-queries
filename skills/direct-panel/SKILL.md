---
name: direct-panel
description: Use for any Yandex Direct task in BB — accounts, statistics and conversions, change history, project passport, negatives, RSYA placements, bids, keyword growth and schedules of the «Панель Яндекс Директ» plugin (plugin id and CLI name stay `direct-queries`).
---

# Direct panel

«Панель Яндекс Директ» (plugin id `direct-queries`, CLI `bb direct-queries`) runs Yandex Direct account data, analytics, change history, search-query judging, negative keywords, RSYA placements, search bids and keyword growth on a schedule, and writes results to the project's Google Sheet. Everything below is what the merged code actually does — check `server.ts` and `model.ts` when in doubt.

## Accounts

- Two sources. **Yandex OAuth**: the owner connects an account in the panel («Войти через Яндекс»); the plugin stores login, tokens and whether the account is an agency. **OhMySEO**: `ohmyseoAccounts` RPC lists the labels visible to the OhMySEO MCP auth, `ohmyseoImport` registers the chosen ones; their Direct calls go through the OhMySEO transport.
- An agency account exposes client logins: `accounts.clients` RPC lists them, and `clientLogin` scopes reports and writes to one client.
- Secrets resolve from plugin settings first, then Env Catalog (`secrets.status` RPC shows which are set): `yandexClientId`/`yandexClientSecret`, `ohmyseoAuth`, `decisionKey`, `typesafeKey`, `xmlstockUser`/`xmlstockKey`, Google Sheets OAuth trio, `telegramBotToken`.
- There is no CLI to add accounts — sign-in and OhMySEO import live in the panel UI.

## Analytics

- `bb direct-queries stats <account> --from YYYY-MM-DD --to YYYY-MM-DD [--client-login L] [--goals id,id] [--json]` — `<account>` matches an account id or login. Prints spend, clicks, conversions and CPA totals, a per-campaign breakdown and the recommendations (`zeroConversions`, `highCpa`, `lowSearchCtr`, `costShare`). `--json` returns `{summary, recommendations}`; results are cached 30 minutes. `--from`/`--to` must be `YYYY-MM-DD` and `from <= to`.
- The `analytics` RPC is the same data for the panel's Analytics tab: totals, `byDay`, `byCampaign`, `byGoal`, `recommendations`.

## Change history

- Every Direct write the plugin makes (library sync, negatives, placements `ExcludedSites`, bids, keyword growth) is recorded: time, account, client login, source, actor, object, field, before → after.
- `bb direct-queries history [<account>] [--since YYYY-MM-DD] [--json]` — optional positional account id filter and `--since` date; plain output is `at source/actor accountId objectType:objectId field before → after`.
- Sources: `job` (scheduled runs), `rpc` (panel actions), `cli` (`bb direct-queries run` / `pipeline run`), `agent` (the same CLI with `--actor <name>`), `direct` (changes made in the Direct UI, pulled by the hourly `history-sync` background job).
- `history` and `historySync` RPCs back the Change history tab; `historySync` re-reads Direct's own change log per account and client login.

## Projects, passport, import/export

- Projects live in plugin storage. The panel editor and `projects.*` RPCs manage them; there is no CLI to create one.
- `bb direct-queries export` prints `{projects, settings}` as JSON; `bb direct-queries import <file>` merges a file of the same shape — projects upsert by `id`, `settings` is replaced when present.
- Passport = the project profile the judge reads (`project.pipeline.profile` in the project JSON). `bb direct-queries passport get <project> [--json]` prints `passport filled/total (missing: …)` or the JSON view; `passport set <project> --file <path>` validates the full passport against the schema and stamps `updated_at`. `passportGet`/`passportSet` RPCs do the same for the panel. See the `project-passport` skill for how to draft a good passport.

## Pipeline (night export)

- `bb direct-queries pipeline run <project> [--date YYYY-MM-DD] [--dry-run] [--actor <name>]` starts the `night-export` job for a project: token → Direct search-query report → client decisions from the sheet («Решения клиента») → query judging → optional SERP check → negative candidates → review sheet → upload to the Google Sheet → negative-library sync → RSYA placements. `--dry-run` runs the whole thing without Direct writes; `--actor` records the run in history as source `agent`.
- The judge calls Google `gemini-decision-1` and falls back to TypeSafe Jev (`api.typesafe.ai`) when the decision deadline has passed; without a typesafe key that path throws `JevUnavailable`.
- The SERP stage is an optional check (XMLStock) capped by `serp.budget` (default 25 calls per night).
- The review/upload stages write the client's Google Sheet tab; the «Решения клиента» feedback stage reads the client's decisions back on the next run.
- `pipeline.run` and `pipeline.preview` RPCs are the panel equivalents (`pipeline.preview` is always a dry run).

## Negatives

- `negatives.level` picks where approved negative phrases land: `library` (shared negative sets synced onto campaigns by the `library-sync` job), `campaign`, `adgroup` or `keyword` (written directly by the night-export's apply step). Default `library`; `negatives.apply` defaults to `library.apply`.
- `library.apply` is a required project field — there is no safe default; it gates the library-sync writes.
- Campaigns that Direct rejects during apply are skipped and listed as `rejected`, not fatal.
- Detail lives in `apply-negatives.ts`, `library.ts` and the project editor («Минусовка», «Синхронизировать минусы», «Писать в Директ»).

## Placements, weekly tree, stats sheet, bids, keyword growth

- **Placements (RSYA)**: scores ad-network placements against a template (`safe`, `apps-and-games`, `strict`) plus the passport's `placement_rules`, writes the `Площадки` tab, and when `placements.apply` is on merges exclusions into each campaign's ExcludedSites (Direct caps at 1000 per campaign). See the `placement-filters` skill for reading and tuning.
- **Weekly tree** (`weeklyTree.enabled`): writes the weekly spend tree tab of the sheet.
- **Stats sheet** (`stats.enabled` + `stats.sheetId`): writes the `Статистика ключевых фраз`, `Динамика`, `Статистика по дням` and `Ставки` tabs from keyword reports.
- **Bids** (`bids.enabled`): every 6 hours adjusts search keyword bids along a traffic ladder (levels 85–120 %, step 10 %, max cut 30 %), judged by the same judge; `bids.skipCampaigns` (default `["По минималке"]`) are left alone.
- **Keyword growth** (`keywordGrowth.enabled`): at 06:20 MSK turns kept queries with ≥ `minImpressions` (default 10) over `days` (default 5) into keywords.
- All four write to Direct only when their `apply` flag is on — all default to `false`. For these jobs there is no `--dry-run`: the preview is a manual `bb direct-queries run <project> <job>` while the apply switch stays off.

## Schedules and run control

- All hours are MSK (`Europe/Moscow`), minute-level precision. Job ids and defaults from `model.ts`:
  - `night-export` — schedule `hour` (default 3; `mode` `daily` | `twice` = hour and hour+12 | `custom` = `hours`), catch-up at `catchUpHours` (default `[4,6,9,12]`), timeout 300 min.
  - `library-sync` — only exists when `library.enabled` and negatives level is `library`; `syncHours` default `[0,4,8,12,16,20]`.
  - `weekly-tree` — `[0,4,8,12,16,18,20]` when enabled.
  - `stats-sheet` — `[6]`, report day `yesterday`, when enabled.
  - `bids` — `[0,6,12,18]` at minute 3, when enabled.
  - `keyword-growth` — `[6]` at minute 20, when enabled.
- A minute `tick` background job starts due and catch-up runs; `history-sync` runs hourly.
- `bb direct-queries status [--json]` — 7-day per-job grid plus running jobs. `bb direct-queries run <project> <job> [--date D] [--actor name]` — start one job now; always a real run (no dry-run), `--actor` marks history source `agent`. `bb direct-queries enable <project> [job]` and `bb direct-queries disable <project> [job]` — toggle a project or one job. `bb direct-queries morning [--dry-run|--send]` — prints the morning line; only `--send` delivers it (Telegram when enabled, else the configured host command).
- Matching RPCs: `overview`, `projects.list/save/setEnabled`, `ledger.list`, `run`, `stage.tail`, `settings.get/save`, `morning.preview`.

## Rules

- The plugin never changes campaign budgets — bids only move keyword bids along the traffic ladder.
- Turn an `apply` switch on only after a dry run (`pipeline run --dry-run`) or a manual run with apply off looks right.
- After any write — CLI, RPC or scheduled — read `bb direct-queries history` (or the Change history tab) to confirm exactly what changed.
