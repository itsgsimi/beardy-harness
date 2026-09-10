# Agent Note: Picker placement is independent of preset availability

Status: implemented

English | [中文](2026-09-09-compact-mode-picker.zh.md)

## Problem

The new-session picker mixes general-purpose agents, specialist compositions, and presets intended for unattended or Discord runs. Full descriptions make every additional mode increase the menu's height. Removing a preset from discovery to shorten that menu would also remove a composition used by integrations and session restoration.

## Decision

Preset display metadata publishes an optional `picker` placement: `main`, `more`, or `hidden`. The `agent-presets` settings namespace carries per-id overrides over that metadata. The remote roster remains complete and projects the resolved placement; absent placement keeps a custom preset visible. The [preset package](../../../../packages/preset/agent-presets/README.md) owns these display defaults independently of [session composition](../architecture/2026-08-03-per-session-agent-presets.md).

The [Web picker](../../../../packages/client/ui-agent-preset/README.md) renders a main list and one collapsible More modes group, with concise localized descriptions for shipped modes. It promotes the current selection into the main list even when that mode is hidden or grouped. Manage modes changes placement through the existing host settings writer and reports refused saves without changing the shown preference. Hidden presets retain their normal discovery, direct-selection, and session-label behavior.

[Copied presets](../simplification/2026-08-08-copy-only-preset-authoring.md) drop the source's ordering and picker placement, so a copy without its own saved override appears in the main list. Settings retains broken presets for repair; the picker and its placement dialog operate on the healthy roster.

## Alternatives considered

**Keep every row in a scrolling list.** Scrolling bounds the menu but leaves infrequently used and integration-specific choices competing with common modes. A compact primary list gives the everyday choices stable positions.

**Remove hidden presets from the roster.** Discovery also serves integration selection, restoration, and human-readable session labels. Picker visibility cannot decide whether those consumers may resolve a preset.

**Hardcode groups in the browser.** A client-only id list cannot express deployment or custom-preset intent. Metadata supplies deployment defaults, and settings lets users choose placements without editing installed files.

## Consequences

Picker placement is presentation data and adds no session event or session-format change. The complete roster remains available for management, and the selected mode provides a visible escape from an otherwise hidden choice. Newly discovered custom modes remain visible, so users with large custom catalogs must explicitly group or hide them.

Focused host tests cover metadata, saved overrides, copied presets, and direct selection of hidden modes. Client tests cover grouping, refused saves, and stale roster responses. The keyless Web scenario records collapsed and expanded menus and exercises persistence, restoration, and active hidden selections through the assembled application.
