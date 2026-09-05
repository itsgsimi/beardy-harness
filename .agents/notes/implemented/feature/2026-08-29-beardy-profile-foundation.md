# Agent Note: Beardy profile foundation

Status: implemented

English | [中文](2026-08-29-beardy-profile-foundation.zh.md)

## Problem

DeepSeek Harness already supplied the plugin seams needed for a Hermes-like coding and research agent, but its shipped profiles did not compose those seams into one named product surface. Session history search, model-facing history tools, Web fetching, and a product identity were available as separate rows or optional layers. Enabling them in the base profile would change every application, while adding a second launcher would bypass the profile and bundle architecture.

## Decision

Ship Beardy as the `beardy` profile and `@deepseek-ai/dsh-beardy` bundle. The profile composes `dsh-base`, `dsh-web-app`, and the Beardy patch layer with live patch reload. The Beardy patch selects a shipped Beardy preset, selects SearXNG for `web_search`, disables the base DeepSeek search row, enables Web fetching, inserts the five session-history tools, and configures a durable derived SQLite search index at `$DSH_HOME/session-search.sqlite` that opens on first search. The search database remains separate from session persistence.

The bundle is a patch carrier with no runtime service or mutable state. Its package manifest declares the packages named by its patch, including the SearXNG provider, and the launcher owns the `beardy` template so upstream changes to the harness continue to flow through the normal bundle/profile stack. The SearXNG provider uses a configured `GET /search?format=json` endpoint and does not require a vendor API key. The Beardy preset uses a read-only composition include to inherit Creator mode, while Creator mode inherits the complete `standard` capability roster and adds the live Cordis authoring tools and composition skill. Beardy patches only its scoped persona and user-global instruction candidates. The existing base-provided skills, goals, workflows, subagents, shell, filesystem, and approval behavior remain owned by their existing packages.

## Alternatives considered

#### Why not enable the history and Web rows in `dsh-base`?

That would make the Beardy-specific search index, history tools, and fetch behavior part of every shipped application, including one-shot, SDK, and ACP profiles. A named profile keeps the product surface opt-in and preserves the existing base composition.

#### Why not create a separate Beardy launcher?

The launcher would duplicate profile resolution, patch precedence, package discovery, and application-entrypoint policy. A bundle and profile use the existing extension path and leave upstream launcher changes isolated from Beardy behavior.

#### Why not modify `agent-loop` for Beardy?

The first Beardy slice needs composition and durable history access, not a second loop implementation. Keeping behavior in system-prompt, capability, and tool rows preserves the harness loop as the shared execution spine.

## Consequences

Users can start the shipped agent with `dsh --profile beardy` or add the bundle to another profile. Beardy retains the standard agent's tools and prompt capabilities, can inspect and temporarily extend its live Cordis runtime, can search persisted session history and the configured SearXNG instance, and can fetch Web pages, while all model-visible inputs continue to be produced by existing logged capabilities. Durable harness or user-preset changes still use the shell and filesystem tools and follow the composition-authoring skill's ownership rules. `$DSH_HOME/SOUL.md` supplies editable personality guidance for Beardy sessions without changing other profiles. The profile does not yet provide a separate personal-memory store, automatic skill curator, cross-session scheduler, or messaging gateway; those remain distinct capabilities rather than implicit Beardy behavior.

The dedicated search index is durable derived state and must not be pointed at the session-persistence database. SearXNG is an external prerequisite for Web search: its endpoint must expose `GET /search?format=json`, and Beardy defaults to `http://127.0.0.1:8080`. The global Soul file consumes the normal durable workspace-instruction path and remains subordinate to higher-authority instructions. Because Creator mode inherits the standard roster and Beardy inherits Creator mode, future harness updates can be merged by updating the underlying bundles and reconciling only explicit Beardy overrides when their row ids or configuration change.
