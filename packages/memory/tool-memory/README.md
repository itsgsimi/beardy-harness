---
description: "One model-facing memory tool for bounded core facts and on-demand, versioned topic documents in the Harness home."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

## Summary

The package stores small cross-session facts in `$DSH_HOME/USER.md` and `$DSH_HOME/MEMORY.md`, and larger on-demand documents in `$DSH_HOME/memories/<slug>.md`. Core entries remain single-line bullets; topics retain frontmatter and Rule, Why, and History sections. `dsh-agent-instructions` loads only the core files into later sessions. Topic text enters a Session only after `memory` reads it. With `requireApproval: true`, every write requires an approval answerer.

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
| `topicMaxChars` | 16384 | Character cap for a complete topic document |
| `topicMaxFiles` | 64 | Maximum topic files, including retired files |
| `topicReadMaxChars` | 16384 | Maximum topic body returned by `read`; cannot exceed `topicMaxChars` |
| `requireApproval` | false | Ask the approval service before every write |
| `allowApprovedHomeWrites` | false | With `requireApproval`, permit the approved exact home target in `workspace-write` |

The instruction loader must name `USER.md` and `MEMORY.md` in both `userGlobalInstructionCandidates` and `frozenUserGlobalInstructionCandidates`, using the same Harness home as this tool. Beardy supplies this configuration. The first request captures both files or their absence; existing sessions retain that snapshot through resume and compaction, while new sessions receive later writes.

-----

<a id="dev-note"></a>
## Dev Note

Core bullet rules live in `src/store.ts`; topic validation and content versions live in `src/topic.ts`. `src/tool.ts` owns exact targets, approval, and version-guarded writes through `ctx.fs`. With `allowApprovedHomeWrites`, only the approved file and, when needed, its `memories` directory receive a one-use filesystem allowance; shell and subprocess policy do not receive it. The plugin waits for a filesystem provider through `ctx.inject(['fs'], …)`.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`memory` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) keeps `user` and `memory` add, replace, and remove calls. `target: topic` adds list and read; add and replace take a complete Markdown document, while remove changes `status` to `retired` and appends History. Replace and remove require `expected_version` from read. Core cap and ambiguous-match errors return the current entries and remaining budget. Topic errors bound excerpts, and list omits retired topics unless requested.

#### Token effect

The tool schema and registered prompt section add fixed request cost. Each call and result is logged. Only the two core files enter later sessions as baseline instructions (1375 plus 2200 characters by default); topic bodies enter only as bounded tool results when read.

#### KV Cache effect

The prompt section is static per composition. With the required frozen-candidate configuration, memory writes leave existing sessions' instruction snapshots unchanged. Later sessions capture new baseline text; compaction restores the captured memory from the session log.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Writes are single-operation** — one entry per call; multi-entry edits rely on the version-checked write failing and the model retrying, not on a batch transaction.
- **No live refresh of the current session** — a memory write is visible to later sessions only; the current session sees it through the tool result. A live re-probe would belong to `dsh-agent-instructions`, not here.
- **Invariant companion** — No runtime invariant companion is published because this package appends no event of its own and owns no durable record beyond the two files; every call is already logged as a `tool/call` and `tool/result` pair by the tool registry, so there is no diverging observation for `./invariant` to check.
- **No semantic search** — topic list returns slug, status, and update date, while `session_search` owns conversation recall. Core pointers to topics are separate versioned writes and are not atomic with topic edits.
