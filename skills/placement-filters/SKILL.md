---
name: placement-filters
description: Read the RSYA placements tab, tune the filter template and passport placement rules, and dry-run the placements stage of a Direct Queries project.
---

# Placement filters

Network (RSYA) campaigns spend on third-party sites and apps. The nightly `placements` stage pulls Direct's ad-network report for the project's campaigns, scores every placement with a filter template and writes the result to the `Площадки` tab of the project's Google Sheet. When the project has `placements.apply` on, the sites the rules (or the client's «Решение») mark for exclusion are merged into each campaign's ExcludedSites — capped at Direct's 1000 items per campaign.

## Built-in templates

| id | catches |
| --- | --- |
| `safe` | `costNoConv` — placements with cost ≥ 300 ₽ and 0 conversions over the report window. |
| `apps-and-games` | `pattern` — mobile app ids and game/vpn/dsp domains (`^com.`, `^ru.`, `.apk`, `game`, `games`, `vpn`, `dsp`); `highCtr` — CTR ≥ 10 % at ≥ 100 impressions (accidental clicks in apps). |
| `strict` | both of the above plus `costNoConv` 300 ₽ and `lowCtr` — CTR ≤ 0.1 % at ≥ 1000 impressions (dead traffic). |

Every template also keeps the passport's own site domain, and the passport's `placement_rules` lines are appended to whichever template runs: `exclude: <regex>` acts like a pattern rule, `keep: <regex>` whitelists and always wins over exclude rules.

## Reading the Площадки tab

Columns: `Кампания | Площадка | Показы | Клики | CTR | Расход | Конверсии | Вердикт | Правило | Решение`.

- `Вердикт` is the rule's call: `Исключить`, `Оставить` or `Наблюдать`.
- `Решение` is the client's override, preserved between runs: `Исключить` excludes a placement even when the verdict was `Наблюдать`; `Оставить` keeps it even when a rule fired. A site matched by a keep rule is never sent to ExcludedSites.
- Sort is exclude-verdict first, then cost — the top rows are where the money goes.

## Tuning

1. `bb direct-queries passport get <project> --json`, then add lines to `placement_rules` in the passport JSON: `exclude: example\.spam$` for a domain pattern to drop, `keep: trusted\.partner$` for one to protect. Write the full passport back with `bb direct-queries passport set <project> --file <path>`.
2. `bb direct-queries pipeline run <project> --dry-run` — the run writes nothing but the ledger shows the `placements` stage; check the Площадки tab is absent or unchanged and the stage row for errors.
3. Turn `placements.apply` on in the project editor («Исключать в Директе») only after a dry run looks right — apply merges into ExcludedSites for real.
