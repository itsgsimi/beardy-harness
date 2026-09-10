# Agent Note: Downstream re-land of chat visual previews

Status: implemented

English | [中文](2026-09-10-downstream-chat-visual-previews.zh.md)

## Problem

Two visual-delivery capabilities were unavailable to fork users. Upstream reverted [static Markdown fence previews](../feature/2026-09-09-markdown-static-previews.md) on `origin/master` without recording a reason, so Mermaid, Graphviz, SVG, and HTML fences render as code again. [Inline visual findings](../feature/2026-09-10-inline-visual-feedback.md) existed only on a private working branch, so no fork profile shipped `present_visual`.

## Decision

`fork/downstream/main` carries both capabilities. The fence-preview revert is reverted on the fork, and the `present_visual` work is cherry-picked onto the same integration branch. Both capabilities keep the feature notes they shipped with; this note owns only the fork-divergence decision.

`CodeBlock` merges the two lines of work rather than choosing one: the `contentRef` scrollport wrapper introduced downstream now wraps the source arm, which mounts only when the preview is hidden. The document-preview sidebar passes no `preview` prop, so its scrollport stays mounted unchanged.

The booted tool-catalog expectation records the fork's full shipped set — `discord_send`, `memory`, `odysseus_research`, and `skill_manage` beside `present_visual` — because that gate had already drifted red on `downstream/main`.

## Alternatives considered

**Wait for upstream to re-land the fence previews.** Upstream left no stated reason and no replacement, so the wait is unbounded while fork users see no diagrams.

**Ship `present_visual` only.** The two capabilities answer the same user expectation — visual results inside the conversation — and both touch `ui-primitives`, so landing them apart doubles the merge work without reducing risk.

**Fold the tool-catalog drift into the feature commit.** The four downstream tool names predate this work; a separate test commit keeps the feature commit's claim accurate.

## Consequences

Every `origin/master` merge-forward must re-resolve the fence-preview revert: an upstream merge reintroduces the deletion unless the fork's re-land wins. The [upstream-sync procedure](../../../skills/dsh-upstream-sync/SKILL.md) owns that resolution.

Evidence: `typecheck`, `lint`, `build`, `doc-sync`, `test:snapshot`, and the keyless browser scenarios for [Mermaid previews](../../../../apps/web/tests/markdown-mermaid.e2e.ts) and [visual feedback](../../../../apps/web/tests/visual-feedback.e2e.ts) pass. The full unit suite leaves eleven files failing that already fail on `downstream/main`; among them `transform-corpus` pins ui-dockkit's tolerated failure to its own `lib` stylesheet, while the built bundle now reaches `ui-primitives` source CSS first. That gate is untouched here and needs its own repair.
