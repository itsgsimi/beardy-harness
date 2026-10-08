---
description: "The skill_manage tool, the save-it-as-a-skill notice, and pruned-skill reload guidance, mounted beside dsh-tool-skill."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill-manage

English | [中文](README.zh.md)

## Summary

The package lets an agent save reusable procedures as skills. The `skill_manage` tool checks, creates, updates, and deletes flat skill files in the workspace (`.agents/skills`) or, when enabled, in the Harness-home user root (`$DSH_HOME/skills`). An optional per-Session notice suggests saving a procedure after a tool-heavy turn. Skill discovery and loading stay in [`dsh-tool-skill`](../../skill/tool-skill/README.md); mount both rows together.

## Table of Contents

- [Configuration](#configuration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enableSkillManagement` | `false` | Expose the `skill_manage` mutation tool; the tool registers once `ctx.fs` is present |
| `enableUserSkillManagement` | `false` | Let `skill_manage` write the Harness-home user root (`$DSH_HOME/skills`) that every session loads |
| `requireApproval` | `false` | Ask the approval service before any create, update, or delete; without a mounted answerer the write is refused |
| `allowApprovedHomeWrites` | `false` | With approval and user-scope management enabled, grant the exact approved home file or skills directory under `workspace-write` |
| `nudgeAfterToolCalls` | `0` | Completed tool results in one completed turn that trigger the Session's one save-it-as-a-skill notice; `0` disables it |
| `skillBodyMaxBytes` | `32768` | Maximum UTF-8 bytes in a skill body written by `skill_manage`; the final newline counts |

`allowApprovedHomeWrites` without `requireApproval`, `enableSkillManagement`, and `enableUserSkillManagement` fails at load, as do a negative or fractional `nudgeAfterToolCalls` and a `skillBodyMaxBytes` below 1. The nudge needs `ctx.sessionProjections`.

-----

<a id="dev-note"></a>
## Dev Note

`src/manage.ts` owns draft lint, the approval preview, and scoped file mutations through `ctx.fs`; every mutation carries the calling Session's sandbox policy. `src/nudge.ts` owns the `skillNudge` Session projection and the `agent/pre-step` listener that adds the notice. `src/index.ts` declares the `skill-nudge` message source with `@persistenceAttribution`, so readers without this package preserve recorded notices.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`skill_manage` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill-manage). `check` returns `errors`, `warnings`, and the UTF-8 `bytes` of the normalized body without writing or asking for approval. Create and update reject the same hard errors before approval and show lint findings plus a bounded diff in the approval reason. Missing or short `when_to_use`, thin descriptions or bodies, and catalog overlap are warnings. Mutations return the affected path and status; refusals name the cause, including a body over `skillBodyMaxBytes`, disabled user scope, refused or unavailable approval, lifecycle mismatch, an unsafe target, a missing workspace cwd, or a path escape.

#### Token effect

Fixed schema cost per request where the tool is visible; each call and result is logged as tool history.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged.

### System prompt section

#### What the model sees

When management or the nudge is enabled, the `tool:skill-manage` section (order 2360) adds:

##### Pruned-skill reload guidance

```markdown
If a previously loaded skill result contains the marker [... tool result middle pruned ...], its steps are incomplete: reload that skill by name before acting on it.
```

#### Token effect

One fixed sentence per request.

#### KV Cache effect

Static per composition, so it stays inside the reusable prefix.

### Skill nudge

#### What the model sees

After a completed turn with at least `nudgeAfterToolCalls` tool results and no model skill load or user skill invocation, the next request gains one user-role notice with source kind `skill-nudge`: ``The last turn used <n> tool calls. If its procedure is reusable, save it as a skill with `skill_manage`; otherwise ignore this.`` A Session receives at most one notice across resume; subagent Sessions receive none.

#### Token effect

One short retained message, at most once per Session.

#### KV Cache effect

Append-only; the notice follows the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Flat files only** — `skill_manage` writes one `<name>.md` per skill and never manages directory skills or their resources.
- **Mutation tool names are carried in `dsh-skill-filesystem`** — the filesystem provider's mutation actor list names `skill_manage`, so a renamed tool needs that list updated.
- **Invariant companion** — No runtime invariant companion is published because the package's only own Session record is the `skill-nudge` notice, whose projection reads it back from the same log; tool calls are logged by the tool registry, so no independent observation can diverge for `./invariant` to check.
