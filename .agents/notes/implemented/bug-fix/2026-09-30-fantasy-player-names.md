# Agent Note: Fantasy report player names and repair row format

Status: implemented

English | [中文](2026-09-30-fantasy-player-names.zh.md)

## Problem

On 2026-09-30 between 23:12 and 23:16 a Googies report was withheld. The writer stage returned rows such as `{"player":"Trevor Lawrence","recommendation":"START","confidence":"high","facts":[...]}`, naming players although its prompt shows roster ids (`{"player":"P1",...}`), and the code check rejected every row with `Trevor Lawrence: not a roster id; Jahmyr Gibbs: not a roster id; ...`. Because no error named a `P` id, the structural repair received no affected rows. Both repairs then answered `"player":"P1"` with invented fields, `{"player":"P1","recommendation":"START","confidence":"High","rationale":"...","sources":[2]}` and `{"player":"P1","recommendation":"START","reasoning":"..."}`, since the repair prompts asked for complete rows without restating the row format. The same writer used ids correctly in the 18:00 run, so the names were sampling drift, not a prompt regression.

## Decision

Before the code checks, every `player` value in draft players and lineup rows, and in repair patch rows and lineup rows, resolves to a roster id when it is not one: an id written in another case or with whitespace becomes the id, and a name equal to exactly one roster player's name, ignoring case and surrounding or repeated whitespace, becomes that player's id. An unknown or ambiguous name is left unchanged and fails as `not a roster id`. Confidence case was already normalized by the parser, so `High` becomes `high`.

Repair patch rows accept `rationale` and then `reasoning` as the reason when `reason` is absent, next to the existing `id` alias for `player`. No alias supplies `facts` from `sources`, because facts need quotes copied verbatim from a cited page; a patch row without facts keeps failing its parse or the facts check. Writer drafts accept none of these aliases.

Both repair prompts now restate the players row exactly as the writer prompt shows it, including `"player":"P1"`, say that `player` holds the roster id and never a name, and show the lineup entry `{"slot":"QB","player":"P1"}`. The prompt version becomes `fantasy-weekly-v5`.

## Alternatives considered

- **Reword the writer prompt to forbid names** — rejected as the only fix because the writer already shows ids and followed them in the earlier run; a stronger instruction does not remove sampling drift, while mapping a unique exact name is lossless.
- **Fuzzy or last-name matching** — rejected because a partial name can match the wrong player, and a wrong row key would silently move advice between players.
- **Build facts from `sources`** — rejected because a source number carries no verbatim quote, and the quote check is what keeps facts tied to admitted text.

## Consequences

A draft whose writer names roster players exactly is checked and published like an id-keyed draft, and structural errors name `P` ids, so repairs see the affected rows. Repair patches that write `rationale` or `reasoning` apply; patches that omit facts or other writer fields still fail.
