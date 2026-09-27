---
description: "The health package group: explicit endpoint probes and Host status for operators."
kind: "package-group"
---

# health/ — endpoint status

English | [中文](README.zh.md)

## Summary

The health group checks only configured HTTP endpoints and keeps their current state in the Host process. The Discord gateway delivers transition notices through its existing outbox and includes probe state in `/status`. [The health plugin](health/README.md) owns configuration and threshold behavior; [the subsystem reference](../../docs/subsystems/health.md) defines status and event types.

## Packages

| Package | Role |
|---|---|
| [`health`](health/README.md) | Probe polling, threshold transitions, and bounded status facts |

## Dev Note

None.
