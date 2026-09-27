---
description: "Select Cordis logger messages for a process journal, normalize lifecycle lines, and redact and bound output before writing it."
kind: "package-reference"
---

# @deepseek-ai/dsh-log-exporter

English | [中文](README.zh.md)

## Summary

Export selected Cordis logs as one line per journal entry. A deployment can include severity levels, exact logger names, message prefixes, and stable replacements for lifecycle messages. Ordered redaction patterns and a line-length limit apply before writing to stdout. Beardy uses this package for gateway lifecycle lines, cron outcomes, and every warning and error.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount a Host row after the log-producing plugins. The exporter registers on the Cordis logger and unwinds with its plugin fiber. The [Beardy bundle](../../bundle/beardy/README.md) supplies the gateway; deployment-specific patterns belong in the personal patch.

```yaml
- id: journal
  name: '@deepseek-ai/dsh-log-exporter'
  config:
    levels: [error, warn, info]
    messagePrefixes: ['dsh-cron:']
    maxLineLength: 2000
```

| Field | Default | Meaning |
|---|---|---|
| `levels` | `[error, warn, info]` | Eligible severity categories. Warnings and errors pass regardless of the other filters when enabled. |
| `loggerNames` | `[]` | Exact logger names included at info or debug level. |
| `messagePrefixes` | `[]` | String prefixes included at info or debug level. |
| `lifecycleLines` | `[]` | Exact or prefix and optional suffix matches mapped to stable output. |
| `redactionPatterns` | `[]` | Ordered global regular-expression replacements. |
| `maxLineLength` | `2000` | Maximum written characters per line, including an ellipsis when cut. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-log-exporter) lists each field. Invalid regexes, empty filters, ambiguous lifecycle matchers, and non-integral limits fail at activation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The exporter receives structured Cordis logger messages. It writes all selected warnings and errors with severity and logger name. For info and debug, it first selects mapped lifecycle strings and message-prefix strings; when neither matches, an exact logger name exports the whole record. Every candidate becomes one line; newlines are replaced with spaces, redaction patterns run in order, then the length cap applies. The package adds no Session event or model input. No invariant companion is published because exporter registration has no independent state projection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [App boot](../app-boot/README.md) — Host startup and logger lifecycle.
- [Beardy bundle](../../bundle/beardy/README.md) — profile layer that supplies the gateway.

-----

<a id="model-experience"></a>
## Model Experience

None, as the exporter changes only the process journal.

#### KV Cache effect

The exporter adds no model input or cache change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Redaction depends on the configured patterns; deployments must match their own credential formats.
- Journal lines are process-local stdout and are not Session events.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
