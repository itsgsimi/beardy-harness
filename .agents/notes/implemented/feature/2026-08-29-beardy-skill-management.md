# Agent Note: Beardy skill management

Status: implemented

English | [中文](2026-08-29-beardy-skill-management.zh.md)

## Problem

Beardy can load workspace skills, but it has no model-facing operation for authoring or removing the flat skill documents that its loader consumes. Giving it an ad hoc filesystem path would duplicate filesystem policy and make the capability harder to carry through future harness updates.

## Decision

Add the opt-in `skill_manage` tool to `@deepseek-ai/dsh-tool-skill`. The tool creates, replaces, and removes `<workspace>/.agents/skills/<kebab-name>.md`, validates the Markdown frontmatter fields it owns, and uses the `ctx.fs` capability for every filesystem operation. The filesystem seam therefore owns sandbox checks, atomic writes, stale guards, locking, and regular-file deletion; the tool owns only the skill document format and its flat target restriction.

The tool is enabled by `enableSkillManagement` in the skill-tool configuration and is selected by the Creator and Beardy preset layers. A successful mutation emits the existing filesystem observation events, and the skill-filesystem provider treats `skill_manage` as a catalog mutation so the current session receives the refreshed skill list. The standard profile leaves the option disabled.

## Alternatives considered

### Why not ask the model to use `write` or `shell` directly?

Those tools expose general filesystem operations and leave skill naming, frontmatter, deletion semantics, and catalog refresh coordination to prompt instructions. A dedicated tool keeps the model-visible operation narrow and reuses the existing filesystem policy.

### Why not add a skill-specific storage provider?

The loader already treats workspace Markdown files as the source of truth. A second store would introduce synchronization and precedence rules without improving the skill format, while the existing filesystem seam already supplies the required mutation guarantees.

### Why not implement recursive directory deletion?

The model-facing operation manages one known regular file at a time. Recursive deletion would widen the destructive surface beyond what skill removal requires.

## Consequences

Beardy can author a skill by calling `skill_manage` with `action: "create"`, update its complete Markdown document with `action: "update"`, and remove it with `action: "delete"`. Create and update require a description and content; names must be kebab-case; delete refuses directories and missing files. The manager creates the workspace skill directory through the filesystem capability and rejects escaped or symlinked targets.

The capability is intentionally opt-in, so existing compositions do not gain a new mutation tool. It manages flat workspace skills only; it does not generate multi-file skill directories, edit installed or global skills, or curate skills autonomously without a model-directed call.
