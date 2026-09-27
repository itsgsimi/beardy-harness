---
description: "Fetch current conditions and a short wttr.in forecast through the configured Harness web provider, with a deployment-selected home location and units."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-weather

English | [中文](README.zh.md)

## Summary

Use `get_weather` for current conditions and a short forecast when a Harness web fetch provider is available. A deployment chooses the home location, units, and number of forecast days. A call can name another location. wttr.in's `j1` response supplies at most three days, so the tool does not promise a five-day forecast.

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

Mount the tool beside `dsh-tools`, `dsh-web`, and a fetch provider. The Beardy bundle supplies the row with Phoenix as its home location; a personal profile can replace its config.

```yaml
- id: tool-weather
  name: '@deepseek-ai/dsh-tool-weather'
  config:
    defaultLocation: Phoenix, AZ
    units: us
    days: 3
```

| Field | Default | Meaning |
|---|---|---|
| `defaultLocation` | Required | Location used when the model omits `city`. |
| `units` | `us` | `us` returns Fahrenheit and mph; `metric` returns Celsius and km/h. |
| `days` | `3` | Number of forecast days, from one to three. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-weather) lists the accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool encodes the requested location, fetches `https://wttr.in/<location>?format=j1` through `ctx.web`, and projects a bounded JSON result. The provider receives the tool cancellation signal. HTTP failures, truncated bodies, invalid JSON, and missing current conditions fail the tool call. The tool does not own a network client, cache, or background task. The tool registry records calls and rendered results in the Session log. No invariant companion is published because this package owns no independent state projection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web capability](../web/README.md) — provider selection and fetch results.
- [Web tools](../tool-web/README.md) — general search and fetch.
- [Beardy bundle](../../bundle/beardy/README.md) — shipped weather row.

-----

<a id="model-experience"></a>
## Model Experience

### Weather request

#### What the model sees

The model sees `get_weather` with an optional `city` argument and the three-day `j1` limit in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-weather). A successful call returns the resolved location, observation time, selected units, current conditions, and up to the configured number of daily forecasts as JSON. Failure is a normal tool error.

#### Token effect

One tool schema is present when mounted. Each call adds one bounded result or error to the Session history.

#### KV Cache effect

The schema is stable for a mounted profile; each distinct result adds new history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- wttr.in `j1` offers at most three forecast days.
- Forecast cells and optional measurements may be absent; the result uses `null` for missing projected fields.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
