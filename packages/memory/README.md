---
description: "The memory group map: the curated USER.md and MEMORY.md editor tool that keeps a small set of cross-session facts in the Harness home, for users wiring persistent agent memory into a profile."
kind: "package-group"
---

# memory/ — Curated cross-session memory

English | [中文](README.zh.md)

## Summary

The memory group gives an agent a durable, human-editable record of facts that apply to every session. One package owns it: a model-facing `memory` tool that edits two small Markdown files under the Harness home — `USER.md` for who the user is and `MEMORY.md` for the agent's own notes — with strict caps, a single-line entry format, and an optional approval gate for unattended writes. Delivery into future sessions is not this group's job: the files are ordinary user-global instruction candidates that `dsh-agent-instructions` loads into each new session's baseline, so memory needs no context plugin of its own and keeps the prompt prefix cache intact.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-memory/`](tool-memory/README.md) | Model-facing `memory` tool editing `$DSH_HOME/USER.md` and `$DSH_HOME/MEMORY.md` with caps, format checks, and an approval gate | registers on `ctx.tools`, consumes `ctx.fs` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Curated memory Agent Note](../../.agents/notes/implemented/feature/2026-09-05-curated-memory.md) — why two flat files plus one tool instead of a store, embeddings, or a context plugin.
- [`dsh-agent-instructions`](../context/agent-instructions/README.md) — the package that delivers the two files into each new session's baseline as user-global instructions.
