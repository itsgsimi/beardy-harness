---
description: "The prompt package group: Beardy-owned helpers that shape the system prompt of single-purpose Agent scopes, for readers navigating packages under packages/prompt/."
kind: "package-group"
---

# prompt/ — Dedicated prompts for single-purpose Agents

English | [中文](README.zh.md)

## Summary

The prompt group holds helpers that control what a single-purpose Agent scope sends to the model. [`dedicated-prompt`](dedicated-prompt/README.md) replaces the scope's assembled prompt with one complete caller-owned prompt and a fixed temperature. The group builds on the existing [system prompt subsystem](../../docs/subsystems/system-prompt.md) and adds no service.

## Packages

| Package | Role |
|---|---|
| [`dedicated-prompt`](dedicated-prompt/README.md) | One complete system prompt with no tools or runtime context for an Agent scope |

## Dev Note

None.
