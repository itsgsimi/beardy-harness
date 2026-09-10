# Agent Note: Odysseus research jobs with explicit worker selection

Status: implemented

English | [中文](2026-09-07-odysseus-research-bridge.zh.md)

## Problem

Beardy needs multi-round research through the installed Odysseus service and a selected local worker. The installed research CLI cannot launch work, and browser-only research routes reject bearer starts.

## Decision

The [research tool](../../../../packages/web/tool-odysseus-research/README.md) sends bounded HTTP requests with deployment-selected endpoint, model, credential reference, and research budget. Beardy provides a disabled row for personal configuration to enable. Redirects and automatic retries are refused.

Odysseus owns job lifetime and saved reports. Harness records remote ids, status, report pages, and source URLs through ordinary tool results. Non-consuming `result-peek` reads preserve reports. HTTP cancellation leaves accepted remote work alive; callers recover uncertain starts with `list` and stop jobs explicitly with `cancel`. The companion Odysseus change grants `research:read` to active/status/library/peek and `research:run` to start/cancel, resolves the token owner, and preserves ownership and research-privilege checks. Other browser operations remain unavailable to these tokens.

## Alternatives considered

**CLI integration:** the installed CLI cannot start research, and direct file access bypasses HTTP owner filtering.

**Harness-owned background jobs:** duplicating the remote registry requires durable adoption, completion delivery, and cancellation reconciliation. Explicit status reads preserve remote ownership without promising automatic notifications.

**Interactive credentials:** a research-scoped token limits lasting API authority without retaining a browser cookie or password in the bridge configuration.

## Consequences

The bridge uses existing tool registration and Session events. Tests cover worker selection, Loader activation and disposal, request bounds, redirects, cancellation, malformed responses, and report paging. A keyless [recorded-session scenario](../../../../snapshots/session/odysseus-research/snapshot.yml) exercises the real tool against an HTTP fixture. Live 4B report quality requires a separate operational check. Existing Beardy composition and MCP decisions remain active because their responsibilities are not replaced.
