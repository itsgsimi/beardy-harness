# Agent Note: Notices without raw model text

Status: implemented

English | [中文](2026-09-30-notices-without-model-text.zh.md)

## Problem

A camera classification whose answer held no JSON object read as `unparsed`, and its notice posted the answer's first line to the user's Signal or Discord target. Models that ignore the JSON template reply with prose such as `Based on the three images provided, here is a breakdown…` or with malformed JSON, so the user received raw model output in a home alert. The `camera` model tool returned the same line as the event's description, which let the assistant relay it.

## Decision

A notice for an `unparsed` reading states the fixed line `The camera check could not describe this event.` in place of a description, like the other readings without a verdict. History keeps the model's first line for debugging. The `camera` tool describes such an event as `Not described: the vision answer could not be read.` and leaves the raw line out entirely, because any text the tool returns can reach the user through the assistant, and the `checked` field already says `unparsed`.

The fantasy report parser for stage output threw the JSON parser's own message when an extracted object failed to parse, and that message quotes the stage output; it now throws `the response JSON object does not parse`, so a run's failure reason never carries model text.

The other notice paths already compose only bounded fixed text: camera failure notices quote a route resolution error's first line, at most 200 characters, or a run length; health probe notices name a fixed cause or an HTTP status; and `cronDeliveryContent` states only a validated failure code, the job name, the Session id, and the next fire, never `failure.message`, which is how fantasy report failure notices reach the user.

## Alternatives considered

- **Show the raw line as labeled debugging detail in the `camera` tool** — rejected because the assistant can still quote a labeled field to the user, which is the failure this fix removes.
- **Truncate or sanitize the raw line in the notice** — rejected because a shortened prose essay or JSON fragment is still model output, not a statement the user can act on.

## Consequences

A camera notice, a failure notice, and a scheduled-run failure notice never contain a model's answer. Diagnosing an `unparsed` event needs its history record or classification Session rather than the notice.
