# Agent Note：下游合并 0.1.6-alpha.1 主干时协调的契约

Status: implemented

[English](2026-09-16-downstream-upstream-sync-contracts.md) | 中文

## 问题

下游集成分支在一个落后 800 个提交的上游基线上携带了 41 个本地提交。有四处契约在两侧同时演进，因此都不能简单地由某一侧胜出：preset 选择设置 namespace、输入框 facade、随产品发布的 creator preset，以及 `FileSystem` 基类。另有两份已提交的格式 v2 Session 日志携带了冻结的 v2 校验器不接受的成员，而能力 seam 生成器新增的完整性守卫也未被下游 `speech` 服务满足。

## 决策

preset 选择设置 namespace 同时承载两侧演进：上游的 `modeSelectionEnabled` 策略及其必填的已保存 `default`，以及下游的按 preset 的 `picker` 摆放。`remoteExportList` 在发现流程让出执行权之前，从同一份设置快照中取得选择策略与摆放覆盖，因此设置热重载不会在一次 roster 中混入两代数据。

creator preset 继续通过只读 include 继承 standard 名册，而不是重述上游的行。随产品发布的 preset 断言会解析这一层 include 并按 id 应用其 `patches`，从而审计 preset 实际挂载的行，而不只是它自己文件里写出的行。

`makeDirectory` 与 `removeFile` 以 `fs.mkdir` 和 `fs.remove` 加入 SSH 远端文件系统，像其他所有修改操作一样派发给远端文件系统。这两个抽象成员是下游在 `FileSystem` 上的契约，因此由每个后端满足，而不是让基类为迁就某一种传输而放宽。

那两份被冻结 v2 校验器拒绝的格式 v2 日志，连同其确切消息一起登记进语料清单，作为预期的拒绝。它们不会被改写：已提交的世代保持录制时的原样，且[搜索已经跳过拒绝迁移的日志](../bug-fix/2026-09-12-search-skips-format-refusing-session-logs.zh.md)。

## 考虑过的替代方案

**每处契约只取一侧。** 上游的 preset 设置会丢掉摆放分组，下游的会丢掉模式选择策略。两者都是已发布且有测试的行为，替换任一侧都会删除正在工作的产品界面。

**在 creator preset 中重述上游名册。** 这样原有断言无需改动即可通过，但此后每次同步都要重新合并一个仅用于复制 standard preset 的文件。

**让 SSH 文件系统拒绝这两个操作。** 错误词汇表中没有表示“不支持该操作”的代码，拒绝只能借用一个具有误导性的代码，而通过 SSH 进行的 skill 管理会以指向错误层次的诊断失败。

**改写或删除这两份拒绝迁移的 v2 fixture。** 两种做法都会销毁真实部署中确实存在的日志证据，而这正是拒绝路径存在的意义。

## 后果

上游 Loader 不再是事务性的：`apply` 抛错的条目会被记录日志并保持未激活，而不是让整次加载失败。断言“大声拒绝”的组合测试现在会在 `loader.await()` 之后 join 每个条目自己的 fiber。任何启动真实 `cordis.yml` 并期待 rejection 的测试都必须这样做，否则它只会静默地观察到一个已 resolve 的值。

上游新增的持久化变更 gate 把下游三处 source 联合类型的新增（`user/message`、`agent/inbox/spliced`、`session/title-llm-request`）判定为需要提升 `SESSION_FORMAT_VERSION`，因此在记录之前 `verify-persistence-changes` 会失败。这里刻意不做这次提升：它需要一个 v3 到 v4 的迁移，并改变每个既有部署读取日志的方式，属于比一次同步更大的决定。上文两份 v2 日志拒绝迁移，正是源于同样未被记录的新增。

本主干上其余无关的失败在干净的上游检出上同样复现：spill-local 的启动清扫、`subprocess-local` 中 Windows 可执行文件解析用例，以及实验性 webworker-packer 的清单用例。它们属于上游，而非本次合并。
