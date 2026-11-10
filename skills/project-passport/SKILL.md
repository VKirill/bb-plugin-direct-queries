---
name: project-passport
description: Draft or update the Direct Queries project passport — the site profile the nightly judge uses to decide whether a search query is target or non-target demand.
---

# Project passport

Every Direct Queries project with a built-in pipeline keeps a passport: the structured description of the site, its offers and its boundaries that the Jev judge reads on every nightly run (`pipeline.profile` in the project JSON). A good passport is what makes the `релевантен / нерелевантен / проверить` verdicts match the owner's intent instead of generic relevance.

## Fields

| field | meaning | good | bad |
| --- | --- | --- | --- |
| `site` | site URL | `https://example.ru/` | `example` |
| `company` | trade or legal name | `ООО «Ромашка», производство клапанов` | `company` |
| `buyer` | who buys | `заводы, которым нужны запчасти для насосов` | `everyone` |
| `offers` | what is sold, one per line | `Клапаны DN 50–200` | `stuff` |
| `advertising_goal` | the goal of the ads | `заявки на поставку клапанов для юрлиц` | `sales` |
| `boundaries` | needs and topics never wanted, one per line | `бытовые клапаны, сантехника для дома` | `irrelevant` |
| `geo` | regions served, one per line | `Москва, Московская область` | `worldwide` when untrue |
| `target_segments` | who and what we sell to, one per line | `проектные институты, ЖКХ` | `clients` |
| `non_target` | demand we never attract, one per line | `бесплатно, своими руками, вакансии, опт для перепродажи` | `spam` |
| `brand_policy` | own and competitor brands | `свой бренд — целевой; бренды конкурентов — нет` | `brands ok` |
| `target_examples` | real target query strings, one per line | `купить клапан dn 100 цена` | `buy stuff` |
| `non_target_examples` | real non-target query strings, one per line | `клапан dn 100 бесплатно скачать` | `bad query` |
| `placement_rules` | free-text hints for future RSYA placements, one per line | `только поиск, без сетей` | — |
| `evidence` | links that prove the profile | `https://example.ru/price` | — |

`updated_at` is stamped by `passport set`; never edit it by hand.

## Procedure

1. `bb direct-queries passport get <project> --json` — `<project>` is the project `id` (see `bb direct-queries export`). `passport: null` means the project has no built-in pipeline and no passport can be stored.
2. Read the site: main page, services, prices, contacts/geo. When the project has an account, also look at recent search queries — in the linked Google Sheet or via `bb direct-queries status`.
3. Draft each empty field. Ask the owner only about what the site does not answer: geo, brands, what counts as non-target.
4. Write the full passport JSON to a temp file and run `bb direct-queries passport set <project> --file <path>`. The file must contain the complete passport (all required fields), not a patch — start from the `passport` object returned by `get`.
5. Report the completeness line the command prints (`filled` of `total`, plus `missing` fields) and close the gaps with the owner if any judged field is empty.

## Rules

- `boundaries` and `non_target` describe concrete needs ("бесплатно", "вакансии", "опт для перепродажи"), not single generic words.
- `target_examples` and `non_target_examples` are real query strings a user would type, not descriptions.
- Never invent prices, regions or offers that are not on the site; leave the field empty and ask instead.
- `updated_at` is managed by the CLI — do not set it by hand.
