# Agent Note: Session-scoped skill nudges and draft lint

Status: implemented

English | [中文](2026-09-27-skill-nudge-quality.zh.md)

## Problem

Beardy produced 104 skill nudges and 55 creates, yet only 30 skill loads in a month. Frequent prompts encouraged narrow files that were rarely reused, while user skills of 6–30 KB could be submitted without a size limit or a draft check before approval.

## Decision

`tool-skill` projects completed tool results, successful model `skill` loads, user `skill-invocation` messages, and prior `skill-nudge` messages from the Session log. A completed turn with at least `nudgeAfterToolCalls` results and no skill load can place one nudge in the next admitted request. The projection rebuilds on resume and limits a Session to one nudge; delegated children remain excluded by their durable origin. Beardy Web and Discord use a threshold of 20, while unattended authoring remains disabled. This timing and lifetime supersede the per-turn listener in [the original skill-management decision](2026-09-05-skill-nudge-and-user-scope.md).

`skill_manage check` runs the create/update validator without mutation or approval. The structured result reports errors, warnings, and normalized body bytes. Invalid names, missing required fields, duplicate frontmatter, and bodies above the validated `skillBodyMaxBytes` cap are hard errors; weak routing text, thin drafts, and catalog overlap are advisory warnings. Create and update reject hard errors before approval, then show the warnings and a bounded changed span in the approval reason. The default cap is 32768 UTF-8 bytes, including the final newline. Existing skills are not rewritten or rejected on load.

## Alternatives considered

**Keep a process-local per-turn tally.** It cannot establish that the turn completed or that a previous lifecycle already nudged the same Session. A Session projection derives both facts from the durable record.

**Require perfect routing prose before a write.** A short `whenToUse` or catalog similarity can be legitimate; warnings let the author judge while keeping malformed documents and oversized bodies out of approval.

**Show the whole skill in approval.** User skills can be tens of kilobytes. The reason shows a bounded changed span and lint summary so approval remains readable.

## Consequences

The nudge adds at most one retained message per Session and appears only after a completed turn. `check` and mutation tool results retain model-visible lint facts in ordinary tool history. The body cap applies to new writes, not to existing provider loads. A weekly review still needs a bounded Session inventory to count loads across Sessions; this change adds no counter store or autonomous curation.
