# Agent Note: Settings persistence follows the authenticated session, not the page authority

Status: implemented

English | [中文](2026-09-13-settings-follow-the-authenticated-session.zh.md)

## Problem

The browser half of the settings domain selected its persistence from the page's own hostname: `ui-settings` resolved `ctx.remote.$host.isLoopback` into `'host' | 'memory'`, and a non-loopback page took `'memory'`. In that mode the describe mirror never called `settings/describe`, every bound namespace scope opened at `unavailable`, and queued writes were dropped.

The visible result was a settings surface that failed without saying why. The Models page reported `settings are unavailable in this browser` — a fallback message reached because memory mode leaves the mirror's view undefined and its error null — and the Plugins tab rendered nothing at all, because it waits for the Host to answer once before drawing its empty line and that answer never came. Appearance, language, busy-Enter, the permission-preset row, and the welcome notice silently kept their provisional defaults. A deployment serving a LAN or Tailscale authority lost its whole configuration surface while every other part of the Web application worked.

The gate predated uniform authentication. [Browser launch-token authentication](2026-08-24-browser-token-authentication.md) later moved identity to one application credential checked before dispatch, with `Host` granting no method tier; the same decision records that determining privileged callers from request routing facts was the defect it fixed. `settings/describe` and `settings/mutate` are ordinary authenticated methods, so a page-authority gate in front of them asserted a boundary the Host no longer recognized.

## Decision

The browser reads and writes the Host settings document whenever it holds a connection. `SettingsDescribeMirror` and `SettingsScopeController` lose their `persistence` parameter, `SettingsScopeSnapshot` loses its `mode` field, and the mirror's status union loses `unavailable`. The scope's own `unavailable` status stays: it now names exactly one condition, a namespace the composition does not serve.

Who may call remains entirely a Host question, unchanged by this note: the media-type and authority fences from the [carrier-level browser trust decision](2026-07-28-api-browser-trust-boundary.md) admit a request, then Connection authenticates it unless [explicit token-free access](../feature/2026-09-09-explicit-token-free-web-access.md) is enabled. `trustedHosts` still grants no identity, and this decision adds no path by which it could — a client that reaches the settings methods at all has already satisfied whichever policy the deployment configured.

`ui-settings-general` keeps its `isLoopback` branch. The Host document action opens a file on the Host's own screen, so the page authority is the right question for that one action, and `ctx.connection.isLoopback` remains its source.

The welcome notice loses its process-local acknowledgement path, which existed only to give memory mode an answer. An unserved namespace now leaves the step in error rather than silently forgetting the acknowledgement.

## Alternatives considered

**Key the privileged surface on `trustedHosts`.** The configured authority list is the obvious lever for "let my LAN in", and it is the wrong one: the browser-trust decision states that `--trusted-host` extends the Host and Origin fence and grants no identity. Reading it as identity would rebuild the routing-facts authority model that token authentication removed, and would do it in the client, where the list is not even known.

**Declare the fact on the Host and keep memory mode.** A field on `RemoteEventHostInfo` would put the decision where the facts live, and preserves a process-local mode for a genuinely untrusted viewer. No such viewer exists: the Host rejects a caller that fails its fences or its authentication before any frame is sent, so the field would be true for every client that could read it. The wire field and its plumbing would carry a distinction the system cannot express.

**Make the choice a validated `Config` field.** Deployment-varying choices belong in `cordis.yml`, but this one is not deployment-varying — it is a question the Host has already answered by admitting the connection. A knob would let a composition claim a restriction the Host does not enforce.

## Consequences

A browser on any authority the deployment admits gets the Settings, Models, and Plugins surfaces its loopback counterpart gets.

Preferences become shared across devices rather than per-device. Appearance, font size, and language chosen on a phone write `settings.yaml` and reach every other browser on the same Harness home; the previous per-page fallback is gone. The welcome notice acknowledged on one device stays acknowledged on all of them.

A caller admitted to the API can write the settings document. This adds no authority: the same caller already reaches `session/prompt`, which runs an agent with the operator's shell. A deployment that serves a non-loopback authority under `--insecure-no-auth` extends both capabilities to everyone who can reach the socket, and that reachability decision stays where it was, in the webserver binding and the authentication opt-out.

Focused unit coverage pins the new behavior where the old gate was pinned: a non-loopback page loads the durable theme section and writes through it, and reads the durable welcome acknowledgement. `ui-settings-general` keeps a case proving the Host document action stays withheld off-loopback while the settings read proceeds.
