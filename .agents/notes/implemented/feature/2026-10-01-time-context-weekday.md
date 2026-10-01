# Agent Note: Time-context weekday

Status: implemented

English | [中文](2026-10-01-time-context-weekday.zh.md)

## Problem

The Beardy home agent wrote "Tue Sep 30" in a digest on Wednesday 2026-09-30. Its only clock is `dsh-time-context`, whose reading names an ISO-shaped timestamp such as `2026-09-30T20:30:00-07:00[America/Phoenix]` and no weekday, so the model derived the weekday from the date itself and got it wrong.

## Decision

`dsh-time-context` accepts an optional `weekday` Config field, default `false`. When it is `true`, the reading's timestamp is followed by the English weekday of its local date, as `2026-09-30T20:30:00-07:00[America/Phoenix] (Wednesday)`. The weekday comes from the same `Intl.DateTimeFormat` parts and zone that format the timestamp, so it cannot disagree with the displayed date. The invariant companion accepts readings with and without the suffix, because released sessions carry none, and rejects a suffix whose weekday differs from the timestamp's local date. The Beardy bundle enables it; the Web bundle keeps the default.

## Alternatives considered

- **Always render the weekday** — rejected because it changes every existing reading, recorded snapshot, and model request for deployments that did not ask for it.
- **Render a full date phrase such as `Wednesday, September 30`** — rejected because the ISO timestamp already carries the date unambiguously; only the weekday requires calendar arithmetic from the model.

## Consequences

Beardy readings grow by one word per injection. Default deployments keep byte-identical readings. Released sessions without a weekday continue to replay, and any reading that names a weekday is checked against its own local date.
