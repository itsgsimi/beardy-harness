# Agent Note: Explicit token-free Web access

Status: implemented

English | [中文](2026-09-09-explicit-token-free-web-access.zh.md)

## Problem

A supervised Web service can run without an attended terminal, while a new browser needs the process launch URL to sign in. Some operators deliberately trust every client on their private network and want a stable URL without distributing browser tokens. Headless startup alone does not express that access policy.

## Decision

The Web CLI exposes `--insecure-no-auth`, which sets Connection's validated `insecureNoAuth` configuration to true and prints an explicit warning. The default remains browser authentication. `--no-open` only suppresses browser launch; it never changes authentication. The CLI accepts `--host 0.0.0.0` only alongside the explicit authentication opt-out.

In insecure mode, Connection serves trusted index requests and the complete Host API without a token or cookie, including WebSocket upgrades. Startup URLs are clean application roots. Connection neither loads nor creates the browser signing record in this mode, and leaves existing credentials intact. The [Connection package](../../../../packages/client/connection/README.md) owns that policy; the [Web bundle](../../../../packages/bundle/web-app/README.md) owns invocation and LAN binding.

Host, Origin, Fetch-Metadata, and request-body checks remain active. An all-interface bind derives trusted LAN IP authorities; `--trusted-host` adds explicit names. These checks reject browser cross-site and rebinding attempts but do not authenticate a network client. Every client that can reach the endpoint and supply accepted request headers has the harness user's full Host authority.

This is an explicit exception to [browser-token authentication](../architecture/2026-08-24-browser-token-authentication.md), retaining that note's credential, lifetime, and default-authentication rationale. The [browser trust decision](../architecture/2026-07-28-api-browser-trust-boundary.md) remains active because its request checks apply in both modes. Neither note is fully superseded.

## Alternatives considered

**Keep browser login as the only policy.** Durable cookies reduce repeat sign-ins but still require a launch URL for each new browser. They do not satisfy an operator's deliberate choice to admit all reachable clients.

**Infer access from headless startup or LAN binding.** Suppressing the browser or choosing a socket address does not express consent to remove authentication. A separate, conspicuous flag makes that policy visible in a service's command line.

**Remove the entire request-trust check.** Token-free access does not require permitting cross-site browser requests or attacker-controlled Host names. The shared check retains those protections for every route.

## Consequences

Token-free service URLs survive restarts without browser setup. The operator gives up caller identity and must control network reachability; the mode adds no TLS, user accounts, or restricted API tier. Removing the flag restores browser authentication and retains its existing signing record.

Focused Connection tests cover explicit opt-out and retained trust rejection. The real CLI scenario checks no-cookie index and RPC access, clean startup URLs, and hostile request rejection while preserving the default token-exchange and restart behavior.
