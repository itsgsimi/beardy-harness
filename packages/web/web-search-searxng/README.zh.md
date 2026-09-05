---
description: "ctx.web 的 SearXNG 搜索提供方：部署方如何使用自托管元搜索实例，且无需厂商 API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-searxng`，harness 可以通过 SearXNG 实例搜索，而无需厂商 API 密钥，同时保持面向模型的 `web_search` 约定不变。当部署方控制 SearXNG 服务，或可以访问启用了 JSON 搜索格式的可信实例时，选择它。SearXNG 返回来源记录而非生成式回答，因此结果包含可引用的 URL、标题、snippet 与可选发布日期，但不包含 `content`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `searxng` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: searxng` 固定。

### 何时选择

当部署希望在自托管或独立运营的搜索上工作，且不使用 `DEEPSEEK_API_KEY`、`EXA_API_KEY` 或其他厂商凭证时，选择此后端。端点缺失，或不是绝对 HTTP(S) URL 时，提供方不可用；连接失败则在搜索时明确呈现为 `WEB_PROVIDER_ERROR`。

### 最小配置

加载 web 服务与本提供方；端点会从启动环境的 `$SEARXNG_BASE_URL` 回退。提供方不会发送 API 密钥或授权 header。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: !!js process.env.SEARXNG_BASE_URL
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL` | SearXNG 实例基址；请求 `/search?format=json`。缺失、带凭证、带查询／片段或非 HTTP(S) 的值会使提供方不可用 |

SearXNG 实例必须在 `settings.yml` 中启用 JSON 响应格式，例如在 `search.formats` 下将 `json` 与 `html` 并列；[SearXNG Search API](https://docs.searxng.org/dev/search_api.html) 记录了此要求与端点参数。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每项 SearXNG 结果映射为 `WebSearchSource`：`url` 必须存在，`title` 映射为 `title`，`content` 映射为 `snippet`，`publishedDate` 映射为 `publishedAt`。空白可选字段会被省略，空白 URL 会被丢弃，SearXNG 的结果记录不会生成提供方 `content`。共享 web 服务会在提供方返回后强制执行请求的 `maxResults` 上限。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、无法解析的 JSON 或字段结构错误——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方按 code 路由；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器的可观察设计；包级约定已在[使用本包](#use-this-package)中完整说明。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `SearxngSearchProvider`：请求分发、JSON 校验、中止分类与结果映射 |
| [`src/types.ts`](src/types.ts) | SearXNG 协议类型：`SearxngSearchResponse`、`SearxngResult` 与 `SearxngError` |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；约定在服务处强制执行） |

### 请求与映射流程

`search()` 将一个编码后的查询发送到 `{baseURL}/search`，并附带 `format=json`、`redirect: 'error'` 与 `Accept: application/json` header。适配器校验响应封套与所消费字段，映射来源元数据，并将最终结果截断交给 `ctx.web`。它不发送凭证，因此 SearXNG 部署在本提供方之外负责访问控制。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与 SearXNG API。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——七包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)——上游 JSON 端点与响应参数。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-searxng)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把本提供方经 `maxResults` 限制的 URL、标题、snippet 与发布日期，或将确切的错误消息 `SearXNG search aborted`、`SearXNG search request failed: <error>` 和 `SearXNG returned an unprocessable response body: <error>` 保留在消费方的错误包装层内。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **实例运营方必须启用 SearXNG JSON 格式**——只公开 HTML 的实例会返回 HTTP 错误，通常为 `403`。
- **不返回提供方生成的回答**——SearXNG 提供来源记录，因此 `web_search` 从此后端收不到 `content` 字段。
- **SearXNG 自己控制上游引擎与结果排序**——适配器只公开提供方无关的查询与结果上限；引擎选择与排序仍由实例配置负责。
- **提供方不验证请求身份**——使用可信的本地或受访问控制的 SearXNG 端点，不要把凭证放进基址 URL。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付行为与限制以上文和相关 Agent Note 为准。

无。

</details>
