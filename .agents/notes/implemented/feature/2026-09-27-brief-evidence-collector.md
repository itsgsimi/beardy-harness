# Agent Note: Bounded evidence collection for a cron brief

Status: implemented

English | [中文](2026-09-27-brief-evidence-collector.zh.md)

## Problem

A brief that asks the model to fetch and choose its own headlines spends model time on collection and can turn a failed source into an unmarked omission. Beardy already has a configured RSS/Atom and weather collector in its personal profile, but that file-based plugin cannot be a declared package dependency of the Beardy bundle. Its route also names a provider absent from the current personal configuration.

## Decision

`@deepseek-ai/dsh-brief-collector` runs inside a dedicated agent preset. At `agent/pre-step`, it fetches configured feeds and weather through `ctx.web`, replaces the named cron input with a complete bounded JSON packet, and preserves the input's cron source and identity. It restricts tools to none. Partial failures remain named gaps; if every source fails or the packet is oversized, pre-step throws before the step starts, so the turn ends in error with no model request, and cron records a failed run. The total-failure error names each source's cause. The cron job owns `modelSelection`; the collector only caps response tokens through `agent/request`. Beardy declares the package as a dependency and lists a disabled Host row; only a personal preset mounts it, because tool restriction requires an Agent scope and a Host-level mount fails at load.

## Alternatives considered

A generic cron command prelude was declined. The existing collector is a Cordis plugin, not an executable, and already uses the Harness Web capability. A command prelude would add a process launch and a new command configuration authority for one job. If a second independent job needs arbitrary process collection, that use can establish its own command, sandbox, output, and log rules.

Keeping the prototype's request-level provider and effort override was declined because cron now validates and logs job-level `modelSelection` at Session creation, and local model control checks that route before a fire. The brief plugin still sets `maxTokens`, which that selection does not carry.

Sending a packet with every source unavailable, as the prototype did, was declined: the model would write a brief with no evidence, and delivery would hide the outage as a normal result.

## Consequences

The model sees only the logged evidence packet and no collection tools. Cron history and outcome delivery retain total collection failures as failed runs, while a partial packet tells the model which named sources were unavailable. Deployments must supply all source URLs and positive limits explicitly; the bundle supplies no feed, destination, or model route. Parsing remains RSS/Atom and wttr.in-style forecast JSON, and story choice is a bounded round-robin selection rather than editorial ranking.
