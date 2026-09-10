---
description: "Model-facing curated memory over the Harness home: one tool that edits USER.md and MEMORY.md under character caps with a round-trip format guard and an optional approval gate, for profiles that must remember facts across sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

## Summary

The package gives an agent a durable record of cross-session facts in exactly two files: `$DSH_HOME/USER.md` (who the user is — name, role, environment, standing preferences) and `$DSH_HOME/MEMORY.md` (the agent's own notes — conventions with no task home, environment facts, things learned that apply everywhere). The `memory` tool adds, replaces, or removes one single-line entry per call, refuses anything that would not round-trip through its strict bullet-list format, and reports the remaining character budget after every write. Later sessions receive both files through `dsh-agent-instructions` as user-global instruction candidates; this package never injects them itself, so a memory write changes no running session's prompt prefix. With `requireApproval: true` every write first asks the approval service, which lets an unattended preset stage memory changes for a human answerer — or refuse them when none is mounted.

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
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Directory holding `USER.md` and `MEMORY.md` |
| `userMaxChars` | 1375 | Character cap for `USER.md` |
| `memoryMaxChars` | 2200 | Character cap for `MEMORY.md` |
| `entryMaxChars` | 400 | Character cap for one entry; must fit inside both file caps |
| `requireApproval` | false | Ask the approval service before every write |

The instruction loader must name `USER.md` and `MEMORY.md` in both `userGlobalInstructionCandidates` and `frozenUserGlobalInstructionCandidates`, using the same Harness home as this tool. Beardy supplies this configuration. The first request captures both files or their absence; existing sessions retain that snapshot through resume and compaction, while new sessions receive later writes.

-----

<a id="dev-note"></a>
## Dev Note

The document rules (parse, serialize, entry validation, cap arithmetic) live in `src/store.ts` as pure functions; `src/tool.ts` owns the filesystem transaction over `ctx.fs` — `lstat` symlink refusal, `fs.stat` version, `fs.writeText` with `replaceIfVersion`, and the `fs/observed` emissions around the write — plus the approval gate that reads `ctx.approval` at call time. The plugin waits for a filesystem provider through a nested `ctx.inject(['fs'], …)`, so mounting it never forces an fs provider into a composition that lacks one.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`memory` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory): a required `target` of `user` or `memory`, a required `action` of `add`, `replace`, or `remove`, an optional `content` entry line, and an optional `old_text` substring that must name exactly one existing entry. The result reports `entries`, `characters`, and `limit`, so the model always knows the remaining budget. Rejections are actionable text: a cap error names the overage and suggests `replace`; an ambiguous `old_text` names how many entries matched; a drifted file is named with its first bad line.

#### Token effect

Fixed schema cost per request where the tool is visible, plus one registered prompt section of roughly 120 tokens from `ctx.systemPrompt.section()`. Each write adds one tool-call and one tool-result message to the session log. The memory files themselves enter later sessions as baseline instruction text bounded by the caps (1375 plus 2200 characters by default).

#### KV Cache effect

The prompt section is static per composition. With the required frozen-candidate configuration, memory writes leave existing sessions' instruction snapshots unchanged. Later sessions capture new baseline text; compaction restores the captured memory from the session log.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Writes are single-operation** — one entry per call; multi-entry edits rely on the version-checked write failing and the model retrying, not on a batch transaction.
- **No live refresh of the current session** — a memory write is visible to later sessions only; the current session sees it through the tool result. A live re-probe would belong to `dsh-agent-instructions`, not here.
- **No invariant companion** — this package appends no event of its own and owns no durable record beyond the two files; every call is already logged as a `tool/call` and `tool/result` pair by the tool registry, so there is no diverging observation for `./invariant` to check.
- **No recall or search** — anything not in the two files belongs to `session_search`; this package only curates the files.
