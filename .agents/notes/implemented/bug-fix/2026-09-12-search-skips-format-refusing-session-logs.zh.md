# Agent Note: 搜索跳过格式拒绝读取的会话日志

Status: implemented

[English](2026-09-12-search-skips-format-refusing-session-logs.md) | 中文

## Problem

持久化的 Session 日志可能被列出却无法读取：`session-persistence-jsonl` 中的 `listArtifacts` 会跳过其格式链拒绝的 header，而其存储正文可能因各自的原因拒绝迁移。因此携带 V3 之前历史记录的部署中，存在任何读取者都无法解析的日志——被 `cannot safely transform unclassified message source` 拒绝的 v2 时期日志，以及其 user-message source 携带冻结的 v2 校验器不容许的成员（例如 `frozenUserGlobalInstructions`）的日志。

SQLite 索引协调会为构建以 live 优先的语料而冷读取每一个已列出的持久化 Session。它把该读取抛出的任何错误都当作存储故障，于是一条无法解析的日志便浮出为 `SESSION_QUERY_PERSISTENCE_FAILED`，使 `session_search`、`session_event_search` 与 `session_event_read` 工具报告 `session history storage is unavailable`。这条消息描述错了对象：存储是健康的，索引能打开，而该进程中的每一个其它 Session——覆盖这一个共享索引所辖的全部 workspace——都完全可读。由于被拒绝的日志永远无法被索引，之后每次搜索都会重新尝试它并再次失败，使中断成为永久状态而非瞬时状态。

## Decision

`session-query-sqlite` 中的 `_observeStable` 在每次冷读取周围捕获 `SessionFormatUnsupportedError`，让该条目保持未加载状态而不再向上抛出。协调本就只为索引挑选已加载的条目，于是一条被拒绝的日志只是不出现在索引中，而其它每一个 Session 都正常索引；任何其它读取失败仍然成为 `SESSION_QUERY_PERSISTENCE_FAILED`。针对已知 live Session 的读取从不查询持久化，因此该路径保持不变。

搜索语料与列表就此达成一致：后端拒绝解析的内容对两者都不可见，而不再对其中之一致命。

## Alternatives considered

**把出问题的目录移出持久化根目录。** 这能立即恢复一台机器的搜索，并且作为运维操作始终可行，但它以手工方式从所有查询视图中删除历史记录，并让下一个携带 V3 之前日志的部署同样损坏。

**让 `frozenUserGlobalInstructions` 进入 v2→v3 校验器。** 迁移包是其所迁移格式的冻结历史快照，这一语义由 [已发布 Session 格式经有状态流式阶段迁移](../architecture/2026-08-31-released-session-format-migrations.zh.md) 拥有，而该成员是否合法地出现在 v2 日志中是另一个格式版本问题。它也只覆盖所观察到的一部分拒绝：多数是 `cannot safely transform unclassified message source`，没有任何成员容许名单能容纳它。

**把该拒绝翻译为 `SESSION_QUERY_SEARCH_DISABLED` 或一个专用 code。** 这对模型更诚实地命名了原因，却仍然什么都不返回，把一个可读的语料藏在一份不可读的日志之后。

**把每个 Session 的拒绝记录为索引状态。** 一个有界的拒绝备忘可以避免在后续协调中重读被拒绝的日志，但在存在 27 条被拒绝日志的存储上重复搜索的热路径实测已经是 0.16 秒，因此当前没有消费者需要这份额外状态及其失效规则。

## Consequences

搜索降级为可读语料而不再整体失败：携带 V3 之前历史的运维者仍能继续使用搜索，而 `session history storage is unavailable` 重新意味着后端本身不可达。被拒绝的日志会永久缺席结果，这在设计上是无声的——没有任何东西报告某一索引无法读取多少历史。在日志变得不可读之前已写入的索引行不会因该拒绝而被删除，因此这样的 Session 可能继续以其最后一次成功索引的 generation 命中。

`session-query-sqlite/tests/sqlite.spec.ts` 把一个可读与一个格式拒绝的存储 Session 挂载到引擎之上，断言搜索页返回可读的命中、后续搜索仍然成功，以及被拒绝的 Session 不匹配任何结果。此路径的记录会话快照需要一个携带不可迁移日志的 fixture，而快照框架目前无法表达；这一覆盖缺口被明确说明而非掩饰。
