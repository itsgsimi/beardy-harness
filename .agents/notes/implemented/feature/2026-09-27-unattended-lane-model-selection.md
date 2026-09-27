# Agent Note: Unattended lane model selection

Status: implemented

English | [中文](2026-09-27-unattended-lane-model-selection.zh.md)

## Problem

Discord conversations, scheduled runs, and Web Sessions have different latency and cost needs. The shared default model previously selected every new ingress Session, and the unattended open path dropped its reasoning effort. A preset-wide model choice would also affect Web Sessions that use the same composition.

## Decision

Discord gateway and cron configuration may each select an exact provider, model, and optional reasoning effort. A configured cron job may override the cron-wide choice; stored jobs inherit it without changing their durable record. In the absence of an explicit choice, each new Session samples the full current `agentDefaultModel` selection. Explicit choices resolve against the registered adapter when a conversation or cron run opens its Session, after provider rows have mounted. An unsupported route or effort fails with the owning configuration field named.

Discord resume reads the last full `request/header` from its Session log and hands that choice to Agent resume. A headerless Session falls back to the current gateway choice. New configuration therefore affects future conversations and fires without changing an established conversation or the Web model selector. The ordinary `request/header` records each generated request's effective selection; no Session event or cron storage migration is needed.

## Alternatives considered

**Put model selection on the preset registry.** The registry owns composition and picker metadata, while Web can use the same preset with a user-selected model. A registry field would couple unrelated entry points.

**Persist a model override in every cron job.** Stored jobs do not need an independent choice. Keeping the override on configured jobs and the cron row avoids changing the durable job format or exposing model selection through `cron_manage`.

**Apply the current lane choice on resume.** This would silently change a conversation after a config edit. Its logged request header already identifies the route and effective effort to keep.

## Verification

Unit tests exercise default inheritance, configured precedence, unsupported effort rejection before Agent creation, stored-job inheritance, and logged Discord resume. The keyless cron-guidance Session snapshot pins an effective effort in `request/header`; the Web default-model suite exercises its separate selection path.

## Consequences

Operators must choose an adapter-supported effort for each explicit route. The official DeepSeek route does not support `medium`; a local adapter can expose it through exact model metadata. Validation runs at each new conversation or cron fire, so adapter catalog changes cannot silently route an unsupported job.
