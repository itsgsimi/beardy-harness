# Agent Note: Configured Web fetch hostname blocks

Status: implemented

English | [中文](2026-09-27-web-fetch-blocked-hosts.zh.md)

## Problem

Deployments may need to refuse known external hostnames during anonymous Web fetches. Public-address checks cannot express that choice because the named hosts can resolve to public IP addresses.

## Decision

`web-fetch-http.blockedHosts` accepts bare DNS hostnames. Plugin loading validates each entry and canonicalizes its case and one trailing dot. The fetch provider applies the same canonicalization to request and redirect hostnames, then refuses exact matches and subdomains with `WEB_BLOCKED_URL` before contacting the target. Label boundaries leave lookalike names eligible.

The list is hostname hygiene, not an IP or SSRF policy. Direct connections keep their public-address validation and pinning. Under a configured proxy, the proxy resolves the target and owns destination restrictions; local public-address checks do not run for proxied requests.

## Alternatives considered

**Compare URL hostnames as parsed.** WHATWG URL parsing preserves a trailing DNS dot, so an entry without that dot would miss an equivalent request hostname.

**Block raw string suffixes.** A suffix without a DNS label boundary would also block unrelated lookalike hosts such as `notaliyuncs.com`.

## Consequences

Operators can deny a named host and its subdomains without changing the address policy. Malformed entries fail during plugin loading. The list cannot replace direct address checks or a proxy's own destination policy; redirect targets are checked even when the cross-origin rule would also reject them.
