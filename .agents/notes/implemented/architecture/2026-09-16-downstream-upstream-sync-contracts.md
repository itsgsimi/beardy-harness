# Agent Note: Contracts reconciled when downstream merged the 0.1.6-alpha.1 spine

Status: implemented

English | [中文](2026-09-16-downstream-upstream-sync-contracts.zh.md)

## Problem

The downstream integration branch carried 41 local commits over an upstream base 800 commits old. Four contracts had evolved on both sides at once, so neither side's version could simply win: the preset-selection settings namespace, the composer input facade, the shipped creator preset, and the `FileSystem` base class. Two committed format v2 Session logs also carried a member the frozen v2 validator refuses, and the capability-seam generator had grown a completeness guard that the downstream `speech` service did not satisfy.

## Decision

The preset-selection settings namespace carries both evolutions: upstream's `modeSelectionEnabled` policy with its required saved `default`, and downstream's per-preset `picker` placements. `remoteExportList` samples the selection policy and the placement overrides from one settings snapshot before discovery yields, so a hot settings reload cannot mix generations within one roster.

The creator preset keeps inheriting the standard roster through its read-only include rather than restating upstream's rows. Shipped-preset assertions resolve that one include level and apply its `patches` by id, so they audit the rows a preset actually mounts instead of only the rows its own file spells out.

`makeDirectory` and `removeFile` join the SSH remote filesystem as `fs.mkdir` and `fs.remove`, dispatched to the far-side filesystem like every other mutation. The abstract members are a downstream contract on `FileSystem`, so every backend satisfies them rather than the base class weakening to accommodate one transport.

The two format v2 logs that the frozen v2 validator refuses are registered in the corpus inventory as expected refusals, with their exact messages. They are not rewritten: a committed generation stays as recorded, and [search already skips format-refusing logs](../bug-fix/2026-09-12-search-skips-format-refusing-session-logs.md).

## Alternatives considered

**Take one side of each contract.** Upstream's preset settings drop placement grouping; downstream's drop the mode-selection policy. Both are shipped behavior with tests, so replacing either would have deleted working product surface.

**Restate upstream's roster in the creator preset.** It would pass the original assertions unchanged, but every later sync would have to re-merge a file that exists only to duplicate the standard preset.

**Refuse the two operations on the SSH filesystem.** The error vocabulary has no code for an unsupported operation, so the refusal would have had to borrow a misleading one, and skill management over SSH would fail with a diagnosis that pointed at the wrong layer.

**Rewrite or delete the refusing v2 fixtures.** Both would destroy evidence of logs that real deployments hold, which is exactly what the refusal path exists to handle.

## Consequences

The upstream Loader is non-transactional: an entry whose `apply` threw is logged and left inactive rather than rejecting the whole load. Composition tests that assert a loud refusal now join each entry's own fiber after `loader.await()`. A test that boots a real `cordis.yml` and expects rejection must do this, or it silently observes a resolved value.

Upstream's new persistence-change gate classifies three downstream source-union additions (`user/message`, `agent/inbox/spliced`, `session/title-llm-request`) as requiring a `SESSION_FORMAT_VERSION` bump, so `verify-persistence-changes` fails until one is recorded. The bump is deliberately not taken here: it needs a v3-to-v4 migration and changes how every existing deployment's logs are read, which is a larger decision than a sync. Those same unrecorded additions are why the two v2 logs above refuse migration.

Remaining unrelated failures on this spine reproduce on a clean upstream checkout: the spill-local startup sweep, the Windows executable-resolution case in `subprocess-local`, and the experimental webworker-packer inventory case. They are upstream's, not this merge's.
