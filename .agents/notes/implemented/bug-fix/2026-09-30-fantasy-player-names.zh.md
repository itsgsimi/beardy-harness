# Agent Note: Fantasy 报告的球员姓名与修复行格式

Status: implemented

[English](2026-09-30-fantasy-player-names.md) | 中文

## 问题

2026-09-30 23:12 至 23:16 之间，一份 Googies 报告被扣留。撰写阶段返回了 `{"player":"Trevor Lawrence","recommendation":"START","confidence":"high","facts":[...]}` 这样的行，写的是球员姓名，而其提示词展示的是在册 ID（`{"player":"P1",...}`）；代码检查以 `Trevor Lawrence: not a roster id; Jahmyr Gibbs: not a roster id; ...` 拒绝了每一行。由于没有错误提到 `P` ID，结构修复没有收到受影响的行。随后两次修复都回答了 `"player":"P1"`，但编造了字段：`{"player":"P1","recommendation":"START","confidence":"High","rationale":"...","sources":[2]}` 和 `{"player":"P1","recommendation":"START","reasoning":"..."}`，因为修复提示词只要求完整的行，却没有重述行格式。同一撰写模型在 18:00 的运行中正确使用了 ID，因此姓名属于采样漂移，而不是提示词回归。

## 决策

代码检查之前，草稿球员行和阵容行、以及修复补丁行和阵容行中的每个 `player` 值，在不是在册 ID 时都会解析为在册 ID：大小写不同或带空白的 ID 变为该 ID；在忽略大小写以及首尾或重复空白后恰好等于一名在册球员姓名的值，变为该球员的 ID。未知或有歧义的姓名保持不变，并以 `not a roster id` 失败。解析器原本就规范化置信度大小写，因此 `High` 会变为 `high`。

修复补丁行在缺少 `reason` 时，先接受 `rationale`、再接受 `reasoning` 作为理由，与现有的 `id` 代替 `player` 的别名并列。没有别名会用 `sources` 生成 `facts`，因为事实需要从所引页面逐字复制的引文；缺少事实的补丁行仍会在解析或事实检查中失败。撰写阶段的草稿不接受这些别名。

两份修复提示词现在都按撰写提示词的原样重述球员行，包括 `"player":"P1"`，说明 `player` 填写在册 ID、绝不填写姓名，并展示阵容条目 `{"slot":"QB","player":"P1"}`。提示词版本改为 `fantasy-weekly-v5`。

## 考虑过的替代方案

- **改写撰写提示词以禁止姓名** —— 作为唯一修复被拒绝，因为撰写提示词已经展示 ID，且在更早的运行中被遵守；更强的指令不能消除采样漂移，而映射唯一且完全一致的姓名不会丢失信息。
- **模糊匹配或仅按姓氏匹配** —— 被拒绝，因为部分姓名可能匹配到错误的球员，而错误的行键会悄悄把建议挪到另一名球员身上。
- **用 `sources` 构造事实** —— 被拒绝，因为来源编号不带逐字引文，而引文检查正是让事实与已采纳文本保持关联的手段。

## 影响

撰写阶段完全按姓名写出在册球员的草稿，会像以 ID 为键的草稿一样接受检查并发布；结构错误会提到 `P` ID，因此修复能看到受影响的行。写出 `rationale` 或 `reasoning` 的修复补丁会被应用；省略事实或其他撰写字段的补丁仍会失败。
