# Agent Note: Beardy composition split into machine-neutral bundle, role presets, and personal layer

Status: implemented

English | [中文](2026-09-05-beardy-composition-layers.zh.md)

## Problem

The Beardy profile mixed three kinds of values in one patch file. Deployment data (`channelId`, `dmUserIds`, gateway `allowedUserIds` and `workspacePath`, the morning-brief job) named one person's Discord, one machine's paths, and one owner's schedule inside a published bundle, so any other user inherited or deleted them. Role behavior (how Beardy should talk when nobody is watching versus answering a direct message) had no home at all: every session — interactive Web, gateway conversation, 07:00 cron fire — ran the same persona with the same authoring tools enabled. And the `memory` tool sat at bundle level with one global approval stance, although the correct stance differs by role: an interactive session answers approvals in the Web UI, while an unattended job must refuse writes rather than block or silently persist them.

## Decision

Three layers, each carrying exactly one kind of value. The bundle patch (`packages/bundle/beardy/cordis.patch.yml`) keeps machine-neutral composition only: provider selections, the search index path under `$DSH_HOME`, `time-context` with an hourly injection throttle, and the three Discord-capable rows gated on `DISCORD_BOT_TOKEN` presence — carrying no destination, allowlist, timezone, workspace, or job data. Enabled rows without profile configuration fail their schemas at load naming the missing field (`$.channelId missing required value`), which is deliberate: a half-configured deployment stops at load instead of running on defaults that belong to nobody.

Role behavior lives in a preset family. `beardy` stays the interactive default and gained the `memory` row (moved out of the bundle); `beardy-unattended` derives from it through the include seam with one persona sentence — decide alone, deliver via `discord_send`, stay under 2000 characters — plus `tool-cordis` and `skill_manage` disabled and `memory` set to `requireApproval: true`; `beardy-discord` adds concise Markdown reply instructions and the same approval stance while keeping the full standard roster; its message presentation follows the [Discord interaction decision](2026-09-07-discord-native-interactions-and-presentation.md). Because a `- id:` patch row replaces an entry's fields wholesale, derivation patches carry complete replacement text for `persona` and `tool-memory` config; display copy follows the existing built-in-preset route (`display.ts` keys plus both client locale dictionaries).

Personal data moved to `$DSH_HOME/profiles/beardy/cordis.patch.yml`: the tool-discord destination row, the gateway's allowlist and workspace with `agentPreset: beardy-discord`, and the morning-brief job now running `beardy-unattended` under `workspace-write`. The repository copy of the bundle patch is deployment-free; the private home file carries what this machine needs.

The standard capability roster is included exactly once. Creator and Beardy disable inherited persona, instruction, and authoring rows before supplying their own direct replacements. Include patches traverse groups in the selected file, not another file include; direct role rows let Discord and unattended presets replace persona and approval configuration and disable authoring without duplicating the coding tools. The shipped Web composition tests mount all three Beardy roles, and the browser startup test opens and reloads a Beardy workspace session.

## Alternatives considered

Keeping personal rows in the bundle behind `!!js process.env.* ?? fallback` was rejected: it looked configurable but encoded one deployment's semantics (space-separated id lists, channel-vs-DM precedence) as shipped defaults, and a wrong-but-valid value fails silently at send time rather than loudly at load. Parsing them into `undefined` and hoping for profile overrides was the same failure in disguise — schema-required fields exist precisely so enabled-and-misconfigured is a load error.

One preset with persona conditionals inside the persona plugin was rejected: the persona has no session-role input, role selection is already the preset seam, and duplicating the include chain per role is exactly what `agent-presets/include` with patches exists for.

Mounting `memory` at bundle level and shadowing it with a preset-scoped second registration was rejected: two registrations of one tool name across planes makes resolution order load-bearing, while moving the row into the preset keeps a single owner per plane and lets each derived preset patch its own config.

## Consequences

Every Beardy deployment now supplies its Discord destinations and authority from its own profile patch; upgrading readers must add those rows once or their token-enabled compositions fail at load naming the field — intended, and covered by the bundle README's deployment section with an environment file and systemd unit. The roster grows to seven built-in presets, so display copy for two more ids ships in both locale dictionaries and the shipped-root roster test pins the new list. Bundle tests now boot a real Loader composition (`tests/composition.spec.ts`) to prove the fail-loud paths, including the lesson that `dsh-tools` injects `systemPrompt`, so any minimal boot tree must mount it first. The gateway keeps `permissionPreset: danger-full-access` in this machine's home file until an approval answerer over Discord exists; at that point unattended and Discord sessions get narrower presets, and `memory`'s `requireApproval` becomes a real staged write instead of a refusal.
