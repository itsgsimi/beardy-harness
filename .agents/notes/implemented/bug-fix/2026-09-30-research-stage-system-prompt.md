# Agent Note: Dedicated system prompt, temperature, and corrective JSON turn for research stages

Status: implemented

English | [中文](2026-09-30-research-stage-system-prompt.zh.md)

## Problem

On 2026-09-30, four of the last four fantasy reviewer stages answered with prose followed by a tool call written as text, such as `<tool_call><function=session_search>…`, a `web_search` call, or a shell command, so the workflow withheld the reports with `the reviewer returned no usable findings JSON: Error: issues must be an array` or `the response contains no JSON object`. Each research stage Session had no tools, but it still received the deployment's generic 3157-character agent system prompt, which introduces a coding agent and tells it to use `session_search`, together with the runtime context. The model followed that prompt instead of the stage message. Camera classification had the same failure and already answered from a dedicated complete system prompt.

## Decision

`installDedicatedPrompt` in `@deepseek-ai/dsh-dedicated-prompt` holds the mechanism camera classification used: a complete section that shadows the deployment persona prefix, suppressed runtime context, a `system-prompt/assemble` listener that drops every tool schema, and an `agent/request` listener that sets the temperature. Camera classification and research stages both call it; each keeps its own tool guard and refusal text. It lives in a Beardy-owned package because it needs only the public system-prompt service and `agent/request` event, so no upstream package carries it ([carry rule](../architecture/2026-10-07-downstream-carry-into-plugins.md)).

Every research stage Session now answers from `You are one stage of a research workflow. You have no tools and cannot search, browse, or run commands; work only from the text in the user message. Follow the output format the message asks for exactly.` A `ResearchWorkflow` may supply its own `stageSystemPrompt` of 1 to 4000 characters; the fantasy workflow states that it is a writer, reviewer, or repair stage of a fantasy report, that it has no tools, and that every answer is one JSON object. Each stage request carries research-local's `stageTemperature`, 0.2 by default and validated from 0 through 2, unless the workflow passes a per-stage `temperature`. The general prompt version becomes `odysseus-general-v2` and the fantasy prompt version `fantasy-weekly-v4`.

`ResearchWorkflowRun.stage` takes an optional `expectJson` check. When the check rejects the first answer, the same stage Session receives `Your reply was not the requested JSON. Reply with only the JSON object in the requested format.`, and the stage returns the corrective answer only when it passes the check; an unsettled, empty, or failing corrective answer leaves the first answer as the result. The one-model-request guard now counts per turn, so a stage makes at most two requests. The fantasy writer, reviewer, and both repair stages build their check from the same parser that later reads the answer, so the check admits exactly what the workflow accepts. The workflow's own rewrite, structural repair, and second-attempt policies still apply after a failed corrective turn.

## Alternatives considered

- **Retry inside the fantasy workflow** — rejected because a workflow can only open a new stage Session; the corrective turn must see the bad answer in its own Session to correct it.
- **A fixed JSON shape check in research-local** — rejected because only the workflow knows its shape; a predicate keeps research-local free of fantasy types.
- **Keep the request-time tool-schema check in the stage `llm/stream` guard** — rejected because the assembly listener now removes every tool schema before the request exists, so the check could no longer fail.
- **Put the helper in `dsh-unattended-session`** — rejected because research-local would inherit that package's preset, permission, and title dependencies for four listeners.

## Consequences

Stage logs show the stage system prompt as the Session's system message and the temperature in the request header, so every model-visible input stays reconstructable. A stage that answered in prose or with a pseudo tool call gets one cheap correction in the same Session before the workflow spends a rewrite, repair, or second review. The general research engine passes no JSON checks yet, so its stages are not corrected.
