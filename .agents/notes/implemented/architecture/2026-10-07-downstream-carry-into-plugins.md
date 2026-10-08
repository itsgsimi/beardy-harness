# Agent Note: Downstream code lives in downstream packages

Status: implemented

English | [中文](2026-10-07-downstream-carry-into-plugins.zh.md)

## Problem

This fork syncs `origin/master` into a tree that adds Beardy packages. The 0.2.1 sync conflicted in 99 paths. Nearly every hand-resolved conflict sat in an upstream-owned package that Beardy work had edited, not in a Beardy package. Each such edit is re-merged on every sync, and an edit that hides in an upstream bundle row can be dropped silently by a merge.

## Decision

Beardy code lives in Beardy-owned packages and in the `dsh-beardy` bundle. An upstream-owned file changes only where no public extension point can carry the behavior, and each remaining change is listed in the carry ledger below with the upstream change that would remove it.

These moves apply the rule:

| Behavior | Upstream file it left | Beardy owner and extension point |
|---|---|---|
| Disabled `speech-whisper` row and `ui-voice` dictation row | `bundle/base`, `bundle/web-app` patches and manifests | `bundle/beardy` patch, inserted with the same row ids so profile layers still replace `speech-whisper` by id |
| `installDedicatedPrompt` for single-purpose Agent scopes | `core/agent` | New [`dsh-dedicated-prompt`](../../../../packages/prompt/dedicated-prompt/README.md) in the `prompt/` group; uses `systemPrompt.section({ complete })`, `suppressRuntimeContext()`, and the `system-prompt/assemble` and `agent/request` waterfalls |
| Memory prompt-section order | `TOOL_MEMORY` in `core/system-prompt` | `MEMORY_SECTION_ORDER = 2350` exported by `dsh-tool-memory` and passed as `order` |
| `LOCAL_MODEL_UNLOADED` check | `checkRoute` closure and import in `llm/llm-pi-ai` | A prepended Host `agent/request` listener in [`dsh-local-model-control`](../../../../packages/health/local-model-control/README.md) that reads the final provider route |
| Unattended open in webhook ingress | `webhook/webhook` import of `dsh-unattended-session` | Removed; webhook keeps upstream's inline open, and cron and Discord keep the shared library |
| `beardy` profile template | `boot/app-boot` `PROFILE_TEMPLATES` | The profile's own `package.json` names its three bundle layers |
| `encodeSegment` subpath export | `session/session-persistence-jsonl` | A copy in `experimental/training-export`, tested against the JSONL encoder |
| `TEXT_TOOL_OUTPUT` output declaration | `core/tools` | New [`dsh-text-tool-output`](../../../../packages/prompt/text-tool-output/README.md) in the `prompt/` group; `tool-fantasy` and `camera-watch` import it beside `defineTool` |
| `skill_manage`, the skill nudge, their six config fields, and pruned-skill reload guidance | `skill/tool-skill` | New [`dsh-tool-skill-manage`](../../../../packages/memory/tool-skill-manage/README.md) row beside `tool-skill`; the guidance moves from the catalog message to its own `tool:skill-manage` prompt section |

The `skill-nudge` message source moves to `dsh-tool-skill-manage` with the same `@persistenceAttribution` declaration. Its digest is unchanged, so the persistence catalog records only the new source location and no persistence-change record applies.

### Carry ledger

| Upstream change kept | Size | Upstream change that removes it |
|---|---|---|
| `session-query`: recent view, origin filter, workspace aliases, stable searches | ~930 lines | Recall features; the origin filter reads the header instead of `cron-`/`discord-` id prefixes |
| `llm-pi-ai` per-provider admission queue | ~550 lines | `maxConcurrentRequests` and `queueTimeoutMs` per provider |
| `agent-instructions` configurable user-global candidates and per-Session freeze | ~490 lines | Configurable user-global files with a frozen list; persona and memory depend on it |
| `sandbox-policy`/`fs-sandbox` approved one-use home writes; `fs.makeDirectory`/`removeFile` | ~440 lines | A per-call mutation allowance |
| `tool-present` visuals, `ui-chat.processDisclosure`, `ui-deliverables` node | ~600 lines | Inline visual deliveries |
| `ui-tool` research card and `ui-settings-plugins` research settings | ~445 lines | None needed; moves to a Beardy client package |
| `ui-conversation.appendDraft` for `ui-voice` dictation | ~60 lines | A composer append operation |
| Research stage hiding (`rp-native-` prefix) and 7 names in `known-event-types.ts` | ~30 lines | A hidden-Session header flag and plugin-contributed known event types |
| `skill-filesystem` mutation actor list | 2 lines | Configurable mutation tool names |
| `tool-web/conversion` export | ~240 lines | An exported HTML-to-Markdown converter |
| `--insecure-no-auth` in `bundle/web-app` (`webStartup` injection and `insecureNoAuth` on the connection row, `src/startup.ts`) and `client/connection` | ~190 lines | Kept by Goran's choice; the alternative is upstream's persisted browser-session cookie with a long lifetime |
| Small fixes: `user-approval.activeApprovalRequestId`, `commands.listForScope`, repeat-dispose, gateway heartbeat and no-cache headers, session-controller page bound, web-fetch blocked hosts, attachment delete, time-context weekday | ~1.2K lines | One small upstream change each |
| Client: phone layout, Mermaid/Graphviz previews, picker placement, settings persistence off loopback | ~2.8K lines | Client UI changes upstream |
| Test adaptations in upstream packages to the carries above (`FileSystem` mutation methods, `HostConnectionService` auth argument, layout operations), V3-to-V4 coverage of Beardy message sources, and the Beardy tool names in `core/tools` `gen-tool-catalog.spec.ts` | small | Removed with the carry each one adapts to; the tool names leave when `scripts/gen-tool-catalog.ts` lists Beardy tool packages apart from the upstream manifest |

## Alternatives considered

**Keep the edits in place and resolve them on each sync.** Rejected: the 0.2.1 sync shows the cost recurs on every merge, and an upstream rewrite of a bundle row can drop a Beardy row without a conflict.

**Move Beardy packages to a separate repository now.** Rejected for now: the remaining ledger entries edit upstream code with no extension point, and the `research/*` events need plugin-contributed known event types before a published build can read their logs.

**Keep the local-model check inside `llm-pi-ai`.** Rejected: an upstream adapter imported a Beardy package. The `agent/request` waterfall covers every Agent turn, including research stages and camera classification.

## Consequences

The listed upstream packages now match `origin/master`, so later syncs merge them without conflict. The cost is behavior that depends on Beardy wiring:

- Direct `ctx.llm` callers outside an Agent turn, such as compaction summaries and session titles, reach the adapter on an unloaded local route instead of failing with `LOCAL_MODEL_UNLOADED`.
- An unload no longer rejects a request already waiting in the `llm-pi-ai` admission queue.
- A new Beardy profile needs a `package.json` that names its bundles; `dsh --profile beardy` no longer creates one.
- The pruned-skill reload sentence sits in the system prompt whenever skill management or the nudge is enabled, including Sessions whose skill catalog is empty, instead of inside each published catalog message.
- Two copies keep the same algorithm: webhook's inline open matches `openUnattendedSession`, and training-export's `encodeSegment` matches the JSONL encoder (a test pins the second).
