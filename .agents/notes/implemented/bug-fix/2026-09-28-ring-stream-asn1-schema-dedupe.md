# Agent Note: Ring live streams need one asn1-schema copy

Status: implemented

English | [中文](2026-09-28-ring-stream-asn1-schema-dedupe.zh.md)

## Problem

Every Ring live-stream fallback failed with `camera-ring: ring-client-api: Cannot get schema for 'SubjectPublicKeyInfo' target`, followed by `stream capture … failed at ended-short: the call ended with 0 of 2 frame(s) written`. Before each WebRTC call, `ring-client-api` 14.3.0 lets `werift` 0.22.4 create a self-signed DTLS certificate through `@peculiar/x509` 1.14.3. The lockfile resolved `@peculiar/asn1-schema` to 2.9.4 for `@peculiar/x509`, `@peculiar/webcrypto`, and `webcrypto-core`, and to 2.9.5 for the `@peculiar/asn1-*` 2.9.5 packages. `asn1-schema` keeps its schema registry per module copy, so `SubjectPublicKeyInfo`, registered through the 2.9.5 copy by `@peculiar/asn1-x509`, was unknown to the 2.9.4 copy that `@peculiar/x509` serialized with. Certificate creation threw, and no call ever started.

## Decision

The root `pnpm-workspace.yaml` overrides `@peculiar/asn1-schema` to 2.9.5 for every consumer, the version the `@peculiar/asn1-*` packages require. The lockfile then carries one `@peculiar/asn1-schema` entry.

`camera-ring/tests/dtls-certificate.spec.ts` loads the `werift` build that `ring-client-api` imports, resolved from `ring-client-api`'s real package directory through werift's ESM `import` export, and calls werift's `createSelfSignedCertificate` with the ECDSA P-256 and SHA-256 arguments its DTLS transport uses. The test uses no network and fails with the `SubjectPublicKeyInfo` error when the lockfile splits `asn1-schema` again.

## Alternatives considered

**Scoped `parent>child` overrides.** `@peculiar/x509>@peculiar/asn1-schema` alone fixes certificate creation but leaves `@peculiar/webcrypto` and `webcrypto-core` on a second copy. Listing every parent keeps one copy only until a new consumer arrives, while the invariant is one registry per process.

**`pnpm dedupe`.** It collapses the copies today but rewrites unrelated lockfile entries, and a later resolution can split them again without a failing install.

**A direct `werift` dependency in `camera-ring`.** It would let the test import `werift` by name but could resolve a different version from the one `ring-client-api` runs.

## Consequences

Upgrading the `@peculiar/asn1-*` packages to a version that requires a newer `asn1-schema` needs the override raised in the same change; the regression test fails if the override forces an incompatible copy that breaks certificate creation. An existing `node_modules/.pnpm` can keep an orphaned `@peculiar+asn1-schema@2.9.4` directory after the reinstall; nothing links to it, and a clean install does not create it.
