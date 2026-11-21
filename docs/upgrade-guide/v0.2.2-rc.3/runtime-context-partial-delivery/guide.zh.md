---
kind: upgrade-guide
description: "runtime-context 消息记录可选的 `partial` 标记并且只陈述发生变化的条目，忽略该标记的读取方会以为更多上下文被覆盖。"
---

# runtime context 只陈述发生变化的条目

[English](guide.md) | 中文

## 变更

当某条贡献发生变化时，agent loop 不再重述整份 runtime context。只陈述变化条目的消息在其 `runtime-context` 来源上记录 `partial: true`；没有该字段的消息仍是完整上下文，并使其不再命名的条目退役。首次投递、条目退役，以及压缩后的第一步仍会陈述全部内容。

只有读取 `user/message` 来源的代码受影响，以及内嵌该来源的 `developer/message`、`agent/inbox/spliced` 与 `session/title-llm-request` 事件。忽略该字段的读取方仍可工作，但会认为模型持有的条目少于实际数量，从而高估覆盖范围；它绝不会凭空造出状态。[持久化记录](../../../persistence-changes/2026-11-21-runtime-context-partial.zh.md)从两个方向陈述读取方行为。Session 头部版本不变。

## 迁移

1. 在折叠 runtime-context 消息的地方，把 `source.partial` 与 `source.sections` 一起读取：把带 `partial: true` 的消息并入你已持有的条目，并用不带该字段的消息整体替换它们。
2. 不要用消息的 `sections` 与当前组装结果比较来判断模型是否最新；应比较合并后的条目。
3. 运行 `pnpm run test:snapshot` 与 `pnpm exec vitest run packages/core/agent-loop`。当一次单条目变化只记录一个条目，且历史中混有完整与部分消息的恢复会话在上下文未变化时仍不发送任何消息时，迁移完成。
