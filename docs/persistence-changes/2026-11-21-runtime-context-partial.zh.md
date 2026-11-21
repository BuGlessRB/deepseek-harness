---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-21-runtime-context-partial

[English](2026-11-21-runtime-context-partial.md) | 中文

## 概述

在 runtime-context 消息上记录它只陈述了发生变化的条目，而不是完整上下文。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-21-runtime-context-partial
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "3b7ff66f97ff649eb6328e253f99e5a908c25fba05fc3d8aba5a7d833c145c66"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "05e200ac6c8c7b11378a7373e9517a06cba28440639e31dd76d62fc70f5fcf4e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "bb321a4e038cbe03b1c256e5b6eaa26ac95ab1ba46e4402090078177e27dd27e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "b202139bfbc45153d6b25c734cca77ed82cea9be3491126cb38cc92fec13189a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个方向的读取方都能继续工作。缺少该字段的记录就是完整上下文，这正是此前所有写入方的产出，因此旧日志与新读取方一致；忽略该字段的读取方会把部分消息当成完整上下文，从而认为适用的条目更少，这会高估覆盖范围但绝不会凭空造出覆盖。写入方只对 sections 是模型已持有条目子集的消息添加该字段，循环的投影对完整消息整体替换、对部分消息合并，因此恢复与回放都会重建出同一状态。该字段不改变顺序或身份，头部版本不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-loop：511 个测试通过，覆盖首次投递、单条目变化、条目退役、清空上下文、移除保留消息的压缩、折叠部分历史的恢复投影，以及旧的无结构快照刷新。

<a id="dev-note"></a>
## 开发备注

无。
