# Agent Note: Discord user lanes

Status: implemented

English | [中文](2026-09-23-discord-user-lanes.zh.md)

## Problem

A single Discord gateway can serve people who need different workspaces, presets, and tool access. A channel record alone cannot authorize a command: it may name a Session opened before the current actor acquired a restricted lane. Discord's global command menu also has no per-user visibility rule.

## Decision

The gateway keeps a default lane for shared guild channels and optional user lanes for allowlisted direct-message users. Each user lane selects its workspace, agent preset, permission preset, tool filter, and additional preset-command exclusions. A user with an own lane is not admitted in guild channels. Durable records, live Agents, and in-flight openings retain their lane identity.

Every admitted message, text command, native command, and prompt control derives the current lane from its actor. Before a command reads status or executes on an Agent, the router cancels an old-lane opening and releases a record and Agent from another lane. `/help` reads the actor's preset catalog without opening a Session. A preset command with no current-lane Agent asks for a message to open one. Pending answers require the actor's lane to match the record and live Agent. Admitted default-lane users in a shared guild channel retain shared prompt authority.

Discord's global native menu contains the union of configured lane commands. Native dispatch checks the actor's lane catalog before delegating to the same executor as text commands. The global menu can therefore display a command that a particular actor cannot run; `/help` shows that actor's available commands.

## Alternatives considered

**Trust the channel record for commands.** That preserves an old Agent's authority after a lane restriction until an ordinary message arrives, so the actor must be checked for every command.

**Open a new Session for every command after a lane change.** A gateway command needs no Session, while a preset command may start a model turn. Releasing the old Session and requiring a message makes the transition explicit without creating a Session solely to answer `/help` or `/status`.

**Publish only the default lane's native commands.** Users of other presets would need undocumented text commands. The union keeps commands discoverable, while native dispatch enforces the actor's lane.

## Consequences

An own-lane user loses guild-channel participation through this gateway. A lane change closes the channel's old conversation on its next admitted message or command; it does not migrate that Session's history. Native menu visibility is broader than command authority. Default-lane users sharing a guild channel can answer each other's pending prompts, so deployments requiring separate approval authority must place users in separate channels or lanes. Lane tests cover stale live and durable records, text and native commands, first-message help, pending answers, and shared guild behavior.
