# Agent Note: Session-backed native research runs

Status: implemented

English | [中文](2026-09-27-session-backed-research-runs.zh.md)

## Problem

A research run can outlive its caller's turn or process. A process-local job record cannot tell a restarted harness whether work completed, which sources were retained, or who may read the report. A research engine also needs a durable record of its decisions without treating its orchestration events as model request history.

## Decision

`ctx.research` separates the service definition from a local storage provider. Each run owns a persisted, idle Agent/Session whose ID is the branded run ID. The caller Session records only `research/linked` after the run's `research/started` event is flushed. The run Session stores checkpoints and one terminal result. Listing projects persisted run Sessions rather than trusting a process-local index. The provider checks the stored owner before returning status, report, or cancellation results; the configured profile namespace is suitable only for a single-user deployment.

An exact caller `requestKey` retrieves an existing run after an ambiguous start. A rejected caller flush can leave an unlaunched run record; on first access after restart the provider marks nonterminal records `interrupted`. It does not replay web requests or model calls. Cancellation has one terminal winner. Report and evidence files are saved as immutable attachments before their references enter a terminal event. Readers verify both files before returning a report.

The local engine gives each model call a short-lived child Agent/Session whose `parentSession` points to the run. It bounds model admission and page evidence, records every search, fetch, normalized finding, and draft in the run, and commits exact fetched text before citing its attachment. The child Session reconstructs the model request without treating run orchestration as conversation history. Default Session lists and `session_search` exclude children by the parent's `rp-native-` prefix; explicit ID reads and requested-parent searches retain them. The engine rejects declared model tools and tool execution in its stages. The tool consumer remains a separate addition.

## Alternatives considered

- **Use `jobs-local` as durable authority** — rejected because its records and ownership are process-local and disappear on restart.
- **Persist a separate research database as authority** — rejected because it would duplicate Session ordering and require an atomicity protocol between two stores.
- **Resume interrupted work automatically** — rejected because a model or web request can have happened after the last checkpoint. Recovery would risk repeating external work silently.
- **Store mutable report paths in terminal events** — rejected because later file changes could make a historical completion event describe different bytes.

## Consequences

The run log preserves identity, ownership, progress, and source outcomes across restart, and a failed caller-link step remains discoverable by its owner. A run with an attachment but no referencing event leaves an unreachable object, which is safer than a visible event with missing bytes. The engine stops without automatic replay after an interruption, and citation URL checks establish that a source URL was fetched without verifying claim-level truth. Each stage Session remains available by exact ID even though ordinary history presentation omits it.
