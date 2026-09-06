# Agent Note: Curated cross-session memory as two files and one tool

Status: implemented

English | [中文](2026-09-05-curated-memory.zh.md)

## Problem

A persistent agent accumulates facts that belong to no single session: who the user is, which shell they run, conventions with no task home. Session logs already hold everything but are recall-only — re-deriving "the user prefers terse answers" from hundreds of turns at every request costs retrieval and cannot be curated or hand-edited. The harness needed a small, human-readable record that enters every new session's prompt cheaply, survives restarts, and can be written by the model itself, including during unattended runs where no human is present to confirm.

## Decision

Two flat Markdown files and one tool. `@deepseek-ai/dsh-tool-memory` (`packages/memory/tool-memory/`) registers a single `memory` tool that edits `$DSH_HOME/USER.md` (facts about the user) and `$DSH_HOME/MEMORY.md` (the agent's own notes) with add, replace, and remove over one entry per call. Each file is a strict bullet list — every non-empty line must parse as `- text` with no control characters — so any content the tool wrote reads back identically, and a hand-edited file that drifted is refused by name and line rather than silently rewritten. Character caps (1375 for USER.md, 2200 for MEMORY.md, 400 per entry, all configurable) are enforced before the write, and every result reports the remaining budget so the model curates instead of appending forever. Writes go through `ctx.fs` with a symlink refusal, a version-checked replace, and `fs/observed` emissions around the transaction.

Delivery into future sessions reuses an existing seam: the beardy preset adds both file names to `dsh-agent-instructions`' `userGlobalInstructionCandidates`, so they load once at session start as user-global instructions. The memory package never injects them itself, which keeps a running session's prompt prefix — and its KV cache — untouched by a write. A static `TOOL_MEMORY` prompt section states the declarative facts: what the files are for, that writes apply to later sessions, and that replace is the move when full. With `requireApproval: true`, each write first asks the `approval` service and refuses when none is mounted, so an unattended preset can stage memory changes for a human answerer rather than letting a 07:00 job silently rewrite the user's profile.

## Alternatives considered

A vector store or embedding recall was rejected: the value here is a small curated set that fits in every prompt, and embeddings would add infrastructure whose retrieval quality cannot be hand-audited. `session_search` already covers recall of everything else and stays the documented answer for anything not worth curating.

A dedicated context plugin that injects the files each request was rejected because user-global instruction candidates already deliver exactly that text at session start; a second injector would either duplicate it or create two sources of truth, and injection at re-render time would churn the prompt prefix every write.

One combined file was rejected over the two-file split: user facts and agent notes have different authors in practice — the user edits `USER.md` and expects nothing of theirs to be interleaved with the agent's scratch notes — and separate caps keep one population from starving the other. The fixed two-name target list also removes path selection from the tool schema, so there is nothing for a prompt injection to aim at.

## Consequences

Every composition that mounts the package carries one more tool schema per request and, in the beardy profile, up to 3575 characters of baseline instruction text (the two file caps) in each new session; running sessions pay neither change because delivery is load-once at session start. Memory writes are reconstructable from the session log through the existing `tool/call` and `tool/result` pair, so no new session event was needed. A hand-edited file that drifts from the bullet format stops the tool until a person fixes the named line — refusal without repair is deliberate, because silent normalization would overwrite human intent. Unattended presets must decide their own stance: with `requireApproval: true` and no answerer mounted, memory simply never changes during unattended runs.
