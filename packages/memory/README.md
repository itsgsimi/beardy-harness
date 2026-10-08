---
description: "The memory group map: the curated USER.md and MEMORY.md editor tool that keeps a small set of cross-session facts in the Harness home, for users wiring persistent agent memory into a profile."
kind: "package-group"
---

# memory/ — Curated cross-session memory

English | [中文](README.zh.md)

## Summary

The memory group gives an agent a durable, human-editable record of facts shared by every session. Its model-facing `memory` tool edits two capped Markdown files under the Harness home: `USER.md` describes the user, and `MEMORY.md` holds the agent's notes. Entries use a strict single-line format, with optional approval for unattended writes. `dsh-agent-instructions` loads both files into each new session's baseline, so memory needs no context plugin and preserves the prompt prefix cache. Procedures the agent should repeat are saved as skills through `skill_manage`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-memory/`](tool-memory/README.md) | Model-facing `memory` tool editing `$DSH_HOME/USER.md` and `$DSH_HOME/MEMORY.md` with caps, format checks, and an approval gate | registers on `ctx.tools`, consumes `ctx.fs` |
| [`tool-skill-manage/`](tool-skill-manage/README.md) | Model-facing `skill_manage` tool for workspace and Harness-home skills, an optional save-it-as-a-skill notice, and pruned-skill reload guidance | registers on `ctx.tools` and `ctx.systemPrompt`, consumes `ctx.fs` and `ctx.skills` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Curated memory Agent Note](../../.agents/notes/implemented/feature/2026-09-05-curated-memory.md) — why two flat files plus one tool instead of a store, embeddings, or a context plugin.
- [`dsh-agent-instructions`](../context/agent-instructions/README.md) — the package that delivers the two files into each new session's baseline as user-global instructions.
