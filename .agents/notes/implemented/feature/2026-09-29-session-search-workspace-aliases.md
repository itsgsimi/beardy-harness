# Agent Note: Session search workspace aliases

Status: implemented

English | [中文](2026-09-29-session-search-workspace-aliases.zh.md)

## Problem

`@deepseek-ai/dsh-tool-session-query` authorizes cross-session access only when the target Session's `cwd` equals the caller's `cwd` exactly. The Beardy deployment is moving its primary workspace from `/home/goran/deepseek-harness` to `/home/goran/.dsh/people/goran`. After the move, `session_search` and the follow-up trace and read tools, including the daily-digest and weekly-skill-review cron prompts, would lose every Session recorded in the old workspace.

## Decision

The plugin adds the validated `workspaceAliases` field, default `{}`. It maps a caller workspace to additional absolute workspaces whose Sessions that workspace may also search and read. `resolveConfig` normalizes every key and entry with `path.resolve`, which removes trailing separators, and throws at load on a relative path, a workspace or entry repeated after normalization, or a workspace that aliases itself. The caller's authorized workspaces are its `cwd` followed by the entries configured for it; a caller without `cwd` still sees only itself.

The same workspace list feeds the `cwd` filter of both `session_search` views, the parent-id and target preauthorization queries, and the header check applied to every observed result, so a hit found through an alias can be traced and read. Grants are one-directional and not transitive: the old workspace gains nothing, and an alias of an alias is not followed. Session listings add a `Workspace:` line only for a Session whose `cwd` differs from the caller's, so output without aliases is unchanged and no tool schema or snapshot changes.

## Alternatives considered

**Rewrite the `cwd` of old Session headers.** Committed Session logs are never rewritten, and the old workspace remains a real checkout with its own Sessions.

**Symmetric or transitive aliases.** A move grants the new workspace access to history it produced; granting the reverse or chaining grants would widen authority beyond what the deployment configured.

**Let the model pass a workspace argument.** Workspace authority derives from the caller, never the model.

## Consequences

Deployments that move a workspace list the old path under the new one in the `tool-session-query` row. Tests cover the default single-workspace scope, search, recent listing, trace, event search, and read through an alias, the denied reverse direction, the non-transitive chain, and each load-time validation error.
