---
description: "Show visual snapshots delivered by present_visual inline in the Web conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-visuals

English | [中文](README.zh.md)

## Summary

See each chart, image, or HTML mockup that the agent delivers with `present_visual` inline in the conversation, with its title and findings. Expand a visual into a larger dialog or download the original file. HTML mockups run in an isolated frame that cannot reach the network or the page.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Beardy bundle mounts this plugin as the `ui-visuals` row beside `ui-deliverables`. Each `deliverables/presented` event whose files carry a saved `visual` renders one card per visual at the event's position, during the turn and on replay. A card shows the title, the optional description, the image or mockup, Expand view, and Download original. A visual that fails to decode shows an alert and keeps its caption and download.

PNG, JPEG, WebP, GIF, and SVG render as images from the saved bytes. HTML renders in a `sandbox="allow-scripts"` frame whose content policy blocks network requests, nested frames, forms, and external resources.

There are no plugin configuration fields.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers a `presented-visual` Conversation Definition through `ctx.uiConversation.events` and its view through the keyed `conversation.chat.node` slot. The Definition validates the event's file declarations and base64 payloads before it builds a node, and marks the node `processDisclosure: 'independent'` so ui-chat keeps it out of the turn's folded process group. Dictionaries, the Definition, and the slot entry are released when the plugin unloads.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Present tool](../../deliverables/tool-present/README.md)
- [Deliverables views](../../client/ui-deliverables/README.md)
- [Chat view](../../client/ui-chat/README.md)

<a id="model-experience"></a>
## Model Experience

### Visual cards

#### What the model sees

Nothing from this plugin. The model sees only the `present_visual` call and its result; the cards are browser views of the recorded `deliverables/presented` event.

#### Token effect

None. The plugin adds no tool schema, prompt text, or Session event.

#### KV Cache effect

None. The request prefix is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The current visual cards have these limits.

- The cards depend on the `visual` field and `processDisclosure` value that Beardy carries in `tool-present` and `ui-chat`.
- Mockups cannot load external fonts, images, or scripts; a mockup must inline everything it needs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Package tests cover payload validation, frame isolation, decode failures, and node placement.
