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
pnpm run gen-tool-catalog
pnpm run gen-config-catalog
pnpm run gen-module-graph
pnpm run gen-doc-graphs
pnpm exec vitest run <each carried group dir> --reporter=dot
```

Generators rebuild their English output only. A translated catalog such as `docs/tool-catalog.zh.md` or `docs/config-catalog.zh.md` has no generator, so after taking upstream's English file the new package sections are absent on the Chinese side and `verify-translation-pairing` reports divergent headings, code blocks, link targets, and table widths. Insert the missing sections into the Chinese file at the mirrored position: copy each fenced block verbatim, translate only prose (`Requires:` becomes `需要：` for injected service keys, `Source:` becomes `来源：`), then re-record with `pnpm run verify-translation-pairing --write <english file>`.

Typecheck with the host project, not a per-package one:

```sh
node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json --pretty false
```

A scoped `tsc -b <package>` reads that package's `src` only, so it passes while test files still violate tightened contracts. Run `pnpm run test:docs` when documentation moved, and read per-file coverage for the carried packages out of `coverage/coverage-summary.json` after a scoped `vitest run --coverage`; the repo-wide 100% gate needs the whole suite and reports unrelated files at zero otherwise.

Compile and test failures here are drift, not breakage of the carried feature. Fix them in one commit of their own, separate from the re-applied commits, so a reviewer sees exactly what the new spine demanded. Also run the tests of packages whose hand-written conflicts you resolved — a conflict resolution that compiles can still fail an assertion.

Drift seen on the 0.1.3 spine, for pattern recognition:

- The live `Session` object exposes `ownEvents()` (child-owned events after any fork-inherited prefix), not `.events`. Test doubles need the same accessor.
- A skill written under `.agents/skills` is discovered only below a detected project root, so a temp workspace in a test needs a `.git` marker.
- Promise-typed guards over runs that may resolve to a value need `Promise<unknown>`, not `Promise<void>`.
- Loader entries expose the plugin name as `entry.options.name`; `entry.name` is gone and lint rejects a conversion that papers over it.
- A tool's `execute()` result arrives `unknown`, so a spec that asserts on result fields declares that result type and narrows once per call site.
- A test stub that records a `RequestInit` field assigns `undefined` when the field is absent, which `exactOptionalPropertyTypes` rejects unless the recording type admits `undefined`.
- Built-in preset display copy lives in one table in `@deepseek-ai/dsh-agent-presets/display`; a local preset needs its copy keys registered there or the localized-name assertion fails.

## Confirm a live effect with the right evidence

Booting without an error is not proof that an integration works, and a missing log line is not proof that it failed: plugin output may be routed away from the launcher's stdout. Confirm the external effect itself — for a network client, an established connection to the peer's address range after it has had time to connect, resolved against the peer's real DNS answers rather than assumed ranges. Sample late enough to cover connect and identify; an early sample is how a working configuration gets reported as broken. Before concluding that configuration is at fault, reproduce once with nothing else holding the same credential, since a second process on one bot token or lock makes the first look dead.

## Cadence, and shrinking what you carry

Sync at the start of a session on the carried work and immediately before anything from it is shared — not continuously. Conflict count tracks drift, and upstream releases move in hundreds of commits, so a branch older than about a week costs real attention. Fast-forwarding a stale local `master` is optional tidiness; `origin/master` is the only sync target.

The cheapest future sync is one with less to re-apply: propose the self-contained packages and their docs upstream as soon as they are gate-clean, keeping only profile or bundle wiring local. Carried commits that landed upstream need no cherry-pick at all.

Once the rebased branch is what you actually run, retire the stale one (`git branch -d` after its content is confirmed present in the new history) so a single line of development remains. Keep both only while the rebased branch still needs review, and delete neither before the empty-deletion check has been read.

## Verify before calling the branch good

```sh
git log --oneline origin/master..HEAD                 # expected commits, order preserved
git diff --diff-filter=D --name-only origin/master..HEAD   # must be empty unless deletion is intended
git diff --stat origin/master..HEAD | tail -1
```

A deletion list that is not empty means a conflict resolution dropped upstream content. Also confirm the carried feature still composes: boot the profile that mounts it, or run its loader-composition test.

Do not push with `--force` and do not reuse the stale branch name for the rebased one; keep both until the new branch passes review, and use `--force-with-lease` if the rebased branch itself gets rewritten.
