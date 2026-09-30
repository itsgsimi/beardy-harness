# Agent Note: Discord resume after a workspace move

Status: implemented

English | [中文](2026-09-29-discord-resume-after-workspace-move.zh.md)

## Problem

On 2026-09-29 the deployment moved the Discord default lane's `workspacePath` from `/home/goran/deepseek-harness` to `/home/goran/.dsh/people/goran`. The next message resumed the channel's durable conversation record, and `Workspace.attachSession` rejected it: `cannot attach session 'discord-…' to workspace '/home/goran/.dsh/people/goran': its cwd resolves to '/home/goran/deepseek-harness'`. A Session's header cwd never changes, so every later message failed the same way with "Request failed", and only the New conversation button recovered the channel.

Separately, every Discord and camera Agent disposal logged `agent/disposed listener threw: TypeError: Cannot read properties of undefined (reading 'catch')` twice. `@deepseek-ai/dsh-file-reference-local` and `@deepseek-ai/dsh-tool-subagent` each install one fiber through `agent.ctx.inject` and dispose it from their `agent/disposed` listener with `fiber.dispose().catch(…)`. By the time `agent/disposed` fires, the Agent's own scope has already disposed that child fiber, and the Cordis effect disposer is single-shot: its repeat call returns `undefined` although `Fiber.dispose` is typed `() => Promise<void>`.

## Decision

`@deepseek-ai/dsh-discord-gateway` compares the recorded Session's stored header cwd with the lane's `workspacePath` before it resumes, both canonicalized with `realpathNormalize` from `@deepseek-ai/dsh-workspace`, the canon `attachSession` applies. A stored cwd that no longer resolves counts as a different workspace; a header without a cwd and a lane path that does not resolve keep their existing failures. On a mismatch, `resumeConversation` rejects with an internal `ConversationWorkspaceMovedError` before any Agent resume. `ensureConversation` then logs the move, deletes the channel's record, opens a fresh conversation in the lane's workspace, and posts `WORKSPACE_CHANGED_NOTICE` ("Started a new conversation because my workspace changed; earlier conversations stay searchable.") through the ordinary `notice` path before the message's turn runs. The earlier Session is only read. A due reminder whose Session belongs to the previous workspace stays dormant with a warning, the same outcome a removed lane has, instead of retrying every `wakeRetryMs` forever.

`@deepseek-ai/dsh-fantasy-reports` `openCaller` keeps `fantasy-reports-<team>` while that Session's stored cwd equals `workspacePath` after `path.resolve`. After a move it creates or resumes `fantasy-reports-<team>-<hash>`, where `<hash>` is the first 8 hex digits of the resolved path's SHA-256. Report history is profile-owned, so it spans both callers.

Both `agent/disposed` listeners wrap the disposer result in `Promise.resolve`, the form Cordis itself uses for a possibly repeated fiber disposal, so an already-disposed fiber settles without a listener failure and a rejected disposal still reaches the listener's warning.

## Alternatives considered

**Match the attach error text.** Parsing `its cwd resolves to` would couple the gateway to another package's diagnostic wording and could only react after an Agent was resumed and rolled back.

**Compare the record's `workspacePath` field.** The record stores the configured path, not the canonical Session cwd, so a symlinked or re-spelled path would diverge from the check `attachSession` applies.

**Guard the listeners with the fiber's state.** Reading Cordis fiber internals to skip disposal would duplicate what the single-shot disposer already decides.

## Consequences

Other durable-Session owners do not resume across a workspace change: cron runs, webhook deliveries, and camera classifications open a new Session id per run, research reconciliation and the goal driver never attach a workspace, and Web, ACP, and headless resumes act on a Session a client names, so they are unchanged. Tests cover the default lane and a user lane on the first message after a restart, an unresolvable stored cwd, a matching cwd, an unrelated attach failure, an unresolvable lane path, a dormant reminder, the fantasy caller switch, and both disposal listeners through real Agent teardown. The notice is posted only to Discord and is not model-visible, so no snapshot changes.
