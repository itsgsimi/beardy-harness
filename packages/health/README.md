---
description: "The health package group: explicit endpoint probes and Host status for operators."
kind: "package-group"
---

# health/ — endpoint status

English | [中文](README.zh.md)

## Summary

The health group checks configured HTTP endpoints and controls intentional unloading of fixed local model backends. The Discord gateway delivers probe transitions through its existing outbox and includes probe state in `/status`. [The health plugin](health/README.md) owns polling and threshold behavior; [local model control](local-model-control/README.md) owns human commands and durable unload intent. [The subsystem reference](../../docs/subsystems/health.md) defines status and event types.

## Packages

| Package | Role |
|---|---|
| [`health`](health/README.md) | Probe polling, threshold transitions, and bounded status facts |
| [`local-model-control`](local-model-control/README.md) | Human load/unload commands and durable intentional pause for local providers |

## Dev Note

None.
