---
description: "The prompt package group: Beardy-owned helpers that shape what Beardy Agent scopes and tools send to the model, for readers navigating packages under packages/prompt/."
kind: "package-group"
---

# prompt/ — Model-facing helpers for Beardy Agents and tools

English | [中文](README.zh.md)

## Summary

The prompt group holds helpers that control what a single-purpose Agent scope sends to the model. [`dedicated-prompt`](dedicated-prompt/README.md) replaces the scope's assembled prompt with one complete caller-owned prompt and a fixed temperature. [`text-tool-output`](text-tool-output/README.md) declares the `{ text }` output that Beardy tools render as one text part. The group builds on the existing [system prompt subsystem](../../docs/subsystems/system-prompt.md) and adds no service.

## Packages

| Package | Role |
|---|---|
| [`dedicated-prompt`](dedicated-prompt/README.md) | One complete system prompt with no tools or runtime context for an Agent scope |
| [`text-tool-output`](text-tool-output/README.md) | `TEXT_TOOL_OUTPUT`, the `defineTool` output declaration for a one-string tool result |

## Dev Note

None.
