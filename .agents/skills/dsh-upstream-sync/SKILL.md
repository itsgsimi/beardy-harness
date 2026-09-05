---
name: dsh-upstream-sync
description: Use when bringing a local deepseek-harness branch that carries private packages or profile work onto a newer origin/master, when a stale branch must be rebased after hundreds of upstream commits, or when deciding whether to rebase by cherry-pick versus merge-forward; resolves generated-artifact and hand-written conflicts, then proves the carried work still runs on the new spine.
---

# DSH Upstream Sync

Use this skill to move local work onto a newer `origin/master` without losing either side. The rule that governs everything below: **the branch moves to upstream, and local commits are re-applied on top** — never merge an ancient branch into fresh code with a squash, because a squash from a stale base silently reverts upstream fixes it did not see.

## Prepare without touching the working checkout

Work in a separate worktree so the running app and the old branch stay intact.

```sh
git remote -v                       # expect one remote: origin = deepseek-ai/deepseek-harness
git fetch origin master
git worktree add ../dsh-upstream -b feat/<name>-upstream origin/master
cd ../dsh-upstream && pnpm install --prefer-offline
```

Record the local commits to carry, oldest first (`git log --oneline master..feat/<name>`). Each becomes one `cherry-pick -x` so the upstream SHA stays in the message and authorship survives.

## Re-apply each commit and classify its conflicts

```sh
git cherry-pick -x <sha>
git diff --name-only --diff-filter=U > /tmp/conflicts.txt
```

Split the list before editing anything:

- **Generated or derived** — `docs/config-catalog*`, `docs/module-graph*`, `docs/tool-catalog*`, `docs/event-producer-consumer*`, `docs/capability-seams*`, `pnpm-lock.yaml`, `tsconfig.base.json`, and any `*.i18n.yaml` sidecar. Take upstream (`git checkout --ours -- <file> && git add -- <file>`), then regenerate after the last cherry-pick. Never hand-merge a generated file: it reverts on the next generation.
- **Hand-written** — read both sides per hunk and merge intent. `git show <sha> -- <file>` shows what the local commit actually added, which is usually one small block inside a much larger upstream rewrite.

Two conflict shapes recur:

- Upstream deleted a file the local commit edited (`DU`, e.g. a tooling config removed by an upstream cleanup). Keep the deletion with `git rm <file>`; re-adding it revives retired tooling.
- A helper moved to a shared home (e.g. preset display copy folded into `@deepseek-ai/dsh-agent-presets/display`). Take the upstream re-export and register the local value in the new home's table instead of restoring the local definition, which would fork the logic.

Finish with `git -c core.editor=true cherry-pick --continue --no-edit`.

## Regenerate, then adapt to API drift

```sh
pnpm install --prefer-offline
pnpm run gen-tsconfig-paths
# plus the generators for whichever derived docs were taken from upstream
pnpm exec tsc -b <each carried package> --pretty false
pnpm exec vitest run <each carried group dir> --reporter=dot
```

Compile and test failures here are drift, not breakage of the carried feature. Fix them in one commit of their own, separate from the re-applied commits, so a reviewer sees exactly what the new spine demanded. Also run the tests of packages whose hand-written conflicts you resolved — a conflict resolution that compiles can still fail an assertion.

Drift seen on the 0.1.3 spine, for pattern recognition:

- The live `Session` object exposes `ownEvents()` (child-owned events after any fork-inherited prefix), not `.events`. Test doubles need the same accessor.
- A skill written under `.agents/skills` is discovered only below a detected project root, so a temp workspace in a test needs a `.git` marker.
- Promise-typed guards over runs that may resolve to a value need `Promise<unknown>`, not `Promise<void>`.

## Verify before calling the branch good

```sh
git log --oneline origin/master..HEAD                 # expected commits, order preserved
git diff --diff-filter=D --name-only origin/master..HEAD   # must be empty unless deletion is intended
git diff --stat origin/master..HEAD | tail -1
```

A deletion list that is not empty means a conflict resolution dropped upstream content. Also confirm the carried feature still composes: boot the profile that mounts it, or run its loader-composition test.

Do not push with `--force` and do not reuse the stale branch name for the rebased one; keep both until the new branch passes review, and use `--force-with-lease` if the rebased branch itself gets rewritten.
