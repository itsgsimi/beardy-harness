# Agent Note: Discord attachments remain available to the agent

Status: implemented

English | [中文](2026-09-16-discord-attachment-references.zh.md)

## Problem

Weekly score uploads can contain only screenshots. Discarding attachment metadata makes those messages empty and leaves the agent unable to inspect or archive the evidence.

## Decision

The [Discord gateway](../../../../packages/discord/discord-gateway/README.md) appends JSON-encoded attachment references to admitted message text. A reference carries the filename, URL, media type, and byte count, with an explicit untrusted-data label. Attachment-only messages use the ordinary conversation path and retain their Discord channel and author identity. The existing input limit bounds the resulting model text.

The gateway does not retrieve files. Tools selected by the agent own download restrictions, file validation, retention, and image interpretation. Signed attachment URLs may expire, so durable workflows archive files promptly.

## Alternatives considered

**Gateway-owned downloads:** add network, filesystem, cleanup, and image-decoding responsibilities to the transport. References keep those responsibilities with the tools that consume the file.

**Ignoring image-only posts:** loses a valid user request and prevents screenshot-based workflows.

## Consequences

JSON encoding preserves filenames as data rather than Markdown structure. Metadata is not proof of file contents or a trusted instruction. Tests cover malformed entries, captions, attachment-only routing through a real Loader, and a keyless [recorded-session scenario](../../../../snapshots/session/discord-attachments/snapshot.yml) of the model-visible references. The existing channel and author allowlists still control admission.
