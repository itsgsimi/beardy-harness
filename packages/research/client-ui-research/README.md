---
description: "Open saved deep-research reports from the Web conversation and choose the research worker in Settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-research

English | [中文](README.zh.md)

## Summary

Open the complete saved report of a `deep_research` or `odysseus_research` call from its conversation row, read it with its numbered sources, and download it as Markdown. Settings → Plugins gains a Deep research tab that chooses the worker for new research jobs in the active profile.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Beardy bundle mounts this plugin as the `ui-research` row. Each research call shows its status and its query, run id, or action. A settled call whose result metadata carries a saved report shows Open research report; the dialog renders the report, links only `http:` and `https:` sources, and offers a Markdown download that ends with the source list. Other calls expand to their result text.

The Deep research Settings tab reads and writes the profile's `odysseus-research` entry: it lists the default worker and any configured `workers`, and saving writes only `selectedWorker`. Existing jobs keep their worker. The tab reports when the profile has no research entry.

There are no plugin configuration fields.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers one keyed `tool.call.toolview` entry per research tool name and one `settings.plugins.tab` entry. The row reads `meta.researchArtifact` from the settled call and rejects malformed metadata. The download URL is created when the dialog opens and revoked when it closes. The Settings tab follows the shared `configForms` entry, so a profile change from another client updates the picker. Dictionaries, slot entries, and the form subscription are released when the plugin unloads.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Research service](../research/README.md)
- [Native research tool](../tool-research/README.md)
- [Tool call views](../../client/ui-tool/README.md)
- [Plugins settings section](../../client/ui-settings-plugins/README.md)

<a id="model-experience"></a>
## Model Experience

### Report dialog

#### What the model sees

Nothing from this plugin. The model receives only the `deep_research` or `odysseus_research` result text; the report dialog and the Settings tab are browser views.

#### Token effect

None. The plugin adds no tool schema, prompt text, or Session event.

#### KV Cache effect

None. The request prefix is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The current research views have these limits.

- The report dialog needs the report in the call's result metadata; a call recorded before the tool saved it shows only the result text.
- The Settings tab edits only the `odysseus-research` entry; native `research-local` model settings stay in the profile file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Package tests cover metadata validation, source link filtering, download URL release, and Settings form writes.
