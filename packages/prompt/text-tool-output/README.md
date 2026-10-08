---
description: "The TEXT_TOOL_OUTPUT defineTool output declaration shared by Beardy tools whose whole result is one text string."
kind: "package-library"
---

# @deepseek-ai/dsh-text-tool-output

English | [中文](README.zh.md)

## Summary

`TEXT_TOOL_OUTPUT` is a `defineTool` output declaration for a tool whose canonical value is `{ text }`, one required string. The model receives that string as a single text part. [tool-fantasy](../../fantasy/tool-fantasy/README.md) and [camera-watch](../../camera/camera-watch/README.md) pass it as their tools' `output`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Entry point

```text
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TEXT_TOOL_OUTPUT } from '@deepseek-ai/dsh-text-tool-output'

ctx.tools.register(defineTool({ name, description, parameters, output: TEXT_TOOL_OUTPUT, execute: async () => ({ text }) }))
```

The tool registry validates the returned value against the declared schema, so a result without a string `text` fails as an invalid tool output.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `TEXT_TOOL_OUTPUT`: the `{ text }` object schema and its one-part renderer |

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through tool-fantasy and camera-watch, which own their tool schemas and the result text this declaration renders as one text part.

#### KV Cache effect

No direct effect; each tool result is append-only history owned by the calling tool.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text only** — the declaration carries no structured fields, so a tool that needs presentation metadata declares its own output schema.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
