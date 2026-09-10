# Agent Note: Inline visual feedback

Status: implemented

English | [中文](2026-09-10-inline-visual-feedback.zh.md)

## Problem

Browser findings, data comparisons, and interface proposals need visual evidence beside their explanation. Opening a source file elsewhere interrupts reading, while a screenshot or animation that disappears after source cleanup loses its evidential value.

## Decision

The [delivery tool package](../../../../packages/fs/tool-present/README.md) registers `present_visual` for screenshots, charts, GIFs, SVG diagrams, and self-contained HTML mockups. The caller supplies an existing path, meaningful title, and findings. Reads use the Session filesystem and preserve original bytes. A configurable bound covers the entire serialized delivery, including base64 expansion and descriptive text. The successful final tool notification appends the existing delivery event, so native and nested calls share policy, ownership, and replay behavior. Model and programmatic results contain a short receipt, not the file payload.

The [Web deliverables plugin](../../../../packages/client/ui-deliverables/README.md) publishes these snapshots as inline Chat nodes with captions, expansion, and original-file downloads. Node-owned `processDisclosure: 'independent'` keeps user-facing results visible after the completed Turn folds its intermediate process. HTML uses an opaque script-enabled iframe with a restrictive subresource policy; SVG uses an image element, not injected markup. The preview receives no parent callbacks, application origin, or filesystem access. Self-navigation inside an HTML iframe is not a supported workflow; this sandbox does not replace an OS sandbox or impose execution-time limits on JavaScript.

Harness guidance explicitly connects charts to data explanation, screenshots to browser findings, GIFs to interaction, and diagrams or mockups to visual proposals. It asks for supporting prose, accurate labels for illustrative data, and a distinction between observed screenshots and proposals. The schema carries this guidance for non-Web consumers as well.

The [source-file delivery decision](2026-09-08-present-workspace-source-files.md) and [filesystem-access decision](2026-09-09-present-filesystem-access.md) remain active: ordinary `present` still opens editable current sources without copying them. Immutable visual snapshots are a separate requested result, not an alternate editing destination.

## Alternatives considered

Image-model result blocks make user-facing presentation depend on model vision support and can normalize away animation. Tool-result metadata alone misses nested code dispatches. Arbitrary assistant HTML inserted into the parent document inherits application authority. A separate artifact service or blob store adds retention and retrieval APIs before the bounded Session snapshot needs them.

## Consequences

Visual snapshots survive reload, source deletion, and inherited history, at the cost of larger Session logs. The per-call limit is not a Session-wide quota. External mockup assets, server-backed applications, and video remain unsupported; browser image decoding owns malformed-image display errors. Expanded HTML views instantiate the mockup separately. Native source-file actions continue to operate on the current source.

Focused tests cover guarded publication, byte preservation, complete-result bounds, malformed content, inline rendering, downloads, and disposal. The [authored Web replay](../../../../snapshots/web/visual-feedback/snapshot.yml) executes the real tool and Client graph, checks interactive isolation and animation, deletes source files before reload, and exercises phone and desktop layouts. Live-model selection frequency and physical mobile browsers are not established by that replay.
