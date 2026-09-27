# Agent Note: 会话搜索容忍并发追加

Status: implemented

[English](2026-09-27-session-search-tolerates-concurrent-appends.md) | 中文

## Problem

每次 SQLite 会话搜索都会列出持久化、读取新增或已更改的日志，再列出一次持久化。观察只在两次列出携带完全相同的修订时才被接受，并且只允许重试一次。因此只要有 Session 在这段窗口内写入，本次尝试就会失败；两次尝试都失败时抛出 `SESSION_QUERY_PERSISTENCE_FAILED`，`session_search` 将其报告为 `session history storage is unavailable`。

JSONL 后端让这个窗口很常见。每个历史格式 Session 的修订都包含一个覆盖全部已存储日志 stat 身份的哈希，因此任何地方的一次追加都会改变所有这些修订。带有 V4 之前历史的部署会在任何写入之后的每次搜索中重新读取这些历史，而重新读取期间追加的并发 Discord、cron、subagent 或 Web Session 又会让比较失败。一个包含一个 V3 Session 与一个追加写入方的真实后端测试可以复现该错误。

## Decision

`session-query-sqlite` 中的 `_observeStable` 要求两次列出命名相同的 Session 且不可变 header 相同，并忽略两次之间的修订变化。观察中读取的每条日志都以第一次列出的修订存储。该标签绝不会比它之后读取的内容更新，因此窗口内被追加的日志在下一次搜索时修订不相等，会在那时被重新读取。会话集合或 header 变化、live 所有者变化以及持久化绑定变化仍然重试一次后失败。

已列出但打开时缺失的 Session（例如在首次追加前关闭的已创建 Session）被视为已删除。只有第二次列出再次列出该 Session 时才会重试。

持久化依赖仍是可选 peer：引擎动态导入 `SessionPersistenceNotFoundError`，与它已有的 `SessionFormatUnsupportedError` 导入方式相同。

## Alternatives considered

**增加重试次数。** 繁忙的部署会持续追加，而每次尝试都会重新读取同样的历史日志，因此更多尝试只会拉长搜索，却不能限定失败。

**只对 live Session 忽略修订变化。** 调用方自己的 Session 是 live 的，但只要任何日志变化，历史格式修订就会变化，因此只要存在 V4 之前的历史，这种做法仍会失败。

**缩小 JSONL 历史修订的范围。** 只对历史迁移实际读取的日志做哈希，也能结束重复读取。但该修订约定属于 `session-persistence-jsonl`，并保护读取相关子日志的迁移；它需要单独的变更。

## Consequences

一次搜索可能基于第一次列出之后最多一个观察窗口内读取的日志作答。下一次搜索会读取每条已变化的日志，因此不会留下陈旧内容。`session history storage is unavailable` 现在表示某次列出或读取失败，或者存储的会话集合或 live 所有者在重试期间持续变化。带有历史格式 Session 的部署在任何写入之后的每次搜索中仍会重新读取这些历史；搜索可以完成，但要承担这些读取的开销。

`session-query-sqlite/tests/sqlite.spec.ts` 覆盖修订变化、打开时缺失的 Session、读取缺失后再次被列出的 Session、会话集合变化，以及带有一个 V3 Session 和一个并发写入方的真实 JSONL 后端。最后一个测试在旧的修订比较下会失败。
