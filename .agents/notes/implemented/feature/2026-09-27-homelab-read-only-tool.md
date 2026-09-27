# Agent Note: Read-only Beardy home-lab tool

Status: implemented

English | [中文](2026-09-27-homelab-read-only-tool.zh.md)

## Problem

Beardy answered home-network questions by composing `bdy` commands through `bash`. That path lets model text choose verbs and flags, including `--yes`, which Beardy uses to approve mutations. Its output can also carry values from the Beardy secrets file, and a raw shell result has no row projection or size bound.

## Decision

`@deepseek-ai/dsh-tool-homelab` registers one `homelab` tool whose `action` enum maps to nine fixed argv templates: `hosts list --no-probe`, `discover --no-ping`, `dns --resolvers`, `disk`, `docker <host> ps --all` with a five-field JSON template, `fw rules`, `router leases`, `net talkers --window 1h --limit 10`, and `doctor`. Each template was checked against its Beardy command source: none reaches `requireApproval()`, and Beardy classifies `docker ps` as a read. The only model-selected argv value is a Docker host, constrained by a schema enum of configured IDs that must exist in Beardy's inventory at load. The plugin never passes `--yes`, runs through the subprocess service with explicit cwd, deadline, grace period, and stdout cap, and forwards the configured secrets file as `BDY_SECRETS_FILE`.

Every call passes `--json` and Beardy's own `--timeout`, which must be shorter than the tool deadline so a dead resolver or host does not consume it. The result keeps only each action's documented columns, redacts secrets-file values and common credential forms, clips cells, and drops trailing rows to the result cap. Stderr is discarded; failures carry fixed codes. A nonzero exit keeps rows Beardy printed first, because `disk` reports an unreachable host that way. An unreadable secrets file fails closed.

`allowedAgentPresets` is required and is either `any` or a preset list. With a list, the caller's current preset comes from the preset registry's Session projection, falling back to the creation header, and an unlisted caller fails before a process starts. The Beardy bundle row ships disabled. Goran's deployment enables it for `beardy` and `beardy-discord`; Mamabear's lane is excluded both by that list and by her gateway tool allowlist.

## Alternatives considered

**Keep `bdy` behind `bash`.** Shell text can add `--yes`, select mutating verbs, or print arbitrary files, and approval would depend on Beardy's classifier alone.

**Expose `ssh`, `logs`, `scan`, `fw loaded`/`states`/`verify`, or `ct logs`.** Free-form remote commands and log text can carry arbitrary private data. Port scans and state dumps have unbounded output. Each would need its own argument validation and projection.

**Rely only on lane tool filters for preset scoping.** A Host tool is visible to every preset unless a lane restricts it, and presets can be selected after Session creation. A tool-owned allowlist fails closed when a filter is missing.

## Consequences

Adding an observation means a new enum value, argv template, column list, and a source check that the Beardy path is read-only. Beardy and Node 23.6 or newer must exist in the subprocess provider's execution world. Row projection depends on Beardy's JSON column names; a renamed column disappears from results until the list is updated. Tests use a scripted subprocess provider and never run `bdy`; the `homelab-hosts` snapshot replays one `hosts` call against a fixture checkout.
