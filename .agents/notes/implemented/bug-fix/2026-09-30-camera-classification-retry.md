# Agent Note: Camera classification retry

Status: implemented

English | [中文](2026-09-30-camera-classification-retry.zh.md)

## Problem

On 2026-09-30, 26 full camera classifications on the Flash Next route with thinking off read 17 answers as `parsed`, 5 as `partial`, 2 as `EMPTY_ANSWER` because the model echoed the instruction's template, and 2 as `unparsed` because the model wrote prose such as "Based on the three images provided, here is a breakdown…" instead of the JSON object. An offline replay of 32 events with the same model and prompt answered all 32 correctly, so the bad answers came from sampling at the route's default temperature of 0.7, not from the prompt.

## Decision

`@deepseek-ai/dsh-camera-watch` sets a validated `temperature`, 0.2 by default and bounded from 0 to 2, on every classification request through an `agent/request` listener in the classification Agent's scope. `AgentOptions` has no temperature field, and the listener is the documented way to change the call config; the logged `request/header` carries the value like `maxTokens`. One field covers full classifications and first-frame checks, because both read the same JSON object.

With `retryOnBadAnswer`, on by default, a full classification whose first answer reads `unparsed`, `empty`, or `partial` with an asked question left out sends one more `user/message` in the same Session: "Your reply was not the JSON object. Reply with only the JSON object from the instructions, filled in." The watch keeps the more usable of the two readings, ranked `parsed` above `partial`, a `partial` answering more asked questions above one answering fewer, `partial` above `unparsed`, and `unparsed` above `empty`; on a tie the corrective reading wins. A corrective turn that fails outright (`TIMEOUT`, `TURN_FAILED`, `NO_ANSWER`, or `NOT_PERSISTED`) falls back to a first `partial` reading. The watch logs which reading it kept. The `llm/stream` guard in `classify.ts` allows one model request per sent prompt, so a classification makes at most two requests and a turn that asks the model again still fails. The failure code and the failure-notice run apply only when the kept reading is a failure: a corrective turn that times out after an `unparsed` or `empty` first answer records `TIMEOUT`, and two empty answers record `EMPTY_ANSWER`. A `partial` answer that answers every asked question stands, because its gaps lie in labels, counts, the description, or evidence frames, which the rules tolerate.

First-frame checks never retry. Their only purpose is an early notice, a corrective turn would double their latency, and the full classification of the same event follows anyway.

## Alternatives considered

**A temperature field on `AgentOptions`.** It would change the core Agent API for one consumer while the `agent/request` waterfall already owns call-config proposals.

**A separate `earlyTemperature`.** Both routes answer the same JSON format, and no evidence shows that the first-frame route needs a different sampling setting.

**Always keeping the corrective answer.** A retry that samples worse, such as an empty object after a `partial` answer, would turn a usable verdict into a failure, which is the drift the retry exists to absorb.

**Retrying in a new Session.** A new Session would resend the frames and lose the model's own bad answer, which the corrective message refers to.

## Consequences

A corrective turn costs one more request on the same Session, without images in the new message but with the first turn's history, and waits up to `turnTimeoutMs` again. Tests cover the retry for prose, an empty object, and a missing question; no retry for a parsed answer or a partial answer that answers every question; the ranking, with a first `partial` kept over an empty retry, an `unparsed` first answer replaced by a `partial` retry, and two empty answers failing as `EMPTY_ANSWER`; a first `partial` kept when the corrective turn fails or times out, and the corrective turn's failure code after an `unparsed` first answer; the temperature in the request and the logged header; the failure-notice run counting final answers only; and config validation. The `camera-watch` session snapshot records the temperature in its request headers.
