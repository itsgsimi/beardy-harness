# Agent Note: Cron 运行保存自己的连续性笔记

Status: implemented

[English](2026-09-30-cron-self-notes.md) | 中文

## 问题

2026-09-30，daily-digest 与 morning-brief 的 cron 运行按连续性指示调用 `cron_manage` 的 `note` 操作，每次调用都以 `cron job note "<name>" was not approved (unavailable); nothing changed` 失败。`requireApproval` 开启时，每个受审批的 `cron_manage` 操作都会询问审批服务，而无人值守的 cron Session 没有审批者，因此请求结果为 `unavailable`。这些任务丢失了让下一次运行接续而非重复的笔记。

## 决策

`launch.ts` 维护一个模块私有的 `WeakMap<Agent, string>`，把每个活动运行的 Agent 映射到触发它的任务。任务运行器在运行的 Session 打开时用 `registerCronRunJob` 登记条目，并在轮次结束时移除，与现有的审批路由并列；`cronRunJobName(agent)` 读取它。包入口不导出这两个函数，因此只有运行器能授予这种关联，且它依赖 Agent 对象身份，而非任何模型提供的文本。

当 `cronRunJobName(exec.agent)` 等于所请求的任务名时，`cron_manage` 的 `note` 操作跳过审批。注册表在写入前仍执行 `notesMaxChars` 上限，保存的自身笔记会以 info 级别记录 `dsh-cron: job "<name>" updated its continuity notes (<n> chars)`。其他任务的笔记、运行结束后的笔记、运行的子代理以及其他所有操作仍需审批。工具描述现在说明任务可在自身运行期间替换自己的笔记。

## 考虑过的替代方案

**匹配 Session id 前缀。** 运行的 Session id 形如 `cron-<name>-<uuid>`，但前缀判断是字符串匹配，名称包含另一任务前缀的任务也可能满足它，而且运行结束后被恢复或复制的 Session 也会通过。

**在审批路由中携带任务名。** 审批路由是其他包在测试中登记的公开接缝；把自身笔记权限放在那里，会让该接缝的任何调用方都能授予它。

**为 cron 部署关闭 `requireApproval`。** 这也会解除 create、update、delete、resume 与 run_now 的审批。

## 影响

无人值守的运行只能改写自己任务的笔记，并受 `notesMaxChars` 约束。测试覆盖关联在一次运行中的生命周期、无需审批的自身任务笔记在上限内与超出上限的情况、运行结束后被拒绝的笔记、运行中对其他任务的笔记与其他操作仍需审批，以及 `unavailable` 结果。工具描述的变化刷新了包内的 `cron-manage.schema.json` 与录制的工具 schema 快照。
