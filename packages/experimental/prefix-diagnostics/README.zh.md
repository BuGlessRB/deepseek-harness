---
description: "把每次模型调用的提示词缓存未命中归因到导致它的请求组成部分，并给出提供方的缓存计数，不改变请求或 Session 日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-prefix-diagnostics

[English](README.md) | 中文

## 概述

`dsh-prefix-diagnostics` 解释一次模型调用的提示词缓存为何未命中。它按适配器收到的原样，对开头的 system 提示词、工具声明和每条对话消息做哈希，把每次带 Session 身份的调用与同一用途的上一次调用比较，并报告最先变化的组成部分以及提供方的缓存计数。当你看到某一步为大量未缓存提示词计费、需要判断是 harness 改变了前缀还是提供方漏掉了本应保留的前缀时，选择它；它只观察请求，绝不改变请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它挂在 LLM 运行时旁边。每次带 Session 身份的模型调用都会与同一 Session、同一用途的上一次调用比较；不带 Session 身份的调用原样通过，不被跟踪。

每次调用在用量到达后发出 `llm/prefix-diagnostics`。报告给出请求的前缀标识、最先打断上一次前缀的组成部分、该前缀仍可复用的部分、提供方的 token 计数、输入中被缓存的比例，以及未变化的前缀是否被按未缓存计费。不会写入 Session 日志，因此回放与 Session 格式不受影响。

当未变化的前缀的缓存比例低于 `minHitRate` 时，插件向 stderr 写一行带 `[llm-prefix-diagnostics]` 标签的文本。产品 profile 不为 `ctx.logger` 挂载控制台导出器，因此这一行就是进程的诊断输出；需要聚合时请把该事件转发到你自己的收集器。

### 何时选择

在开发、容量工作或事故排查中，需要为缓存未命中归因时选择它，尤其是某一步报告的未缓存输入远多于相邻步骤时。若只需要 Session 已经记录的总体命中率，则不必选择：Web 的统计视图从 `assistant/message` 的用量中读取该数值，而本插件补充的是 Session 不保留的请求侧比较。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-prefix-diagnostics'
  config:
    minHitRate: 0.5
    maxSeries: 256
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `minHitRate` | `0.5` | 未变化且可复用的前缀被按未缓存计费、且缓存比例低于该值时，计为意外未命中 |
| `maxSeries` | `256` | 在内存中保留上一次前缀的 Session 与用途组合数量；超出时丢弃最久未使用的一项 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-prefix-diagnostics)是全部可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件监听 `llm/stream` 瀑布事件，只读取请求而不改写，并原样产出适配器的数据块。在最后一个数据块之后，它把该请求与同一序列的上一次请求比较并发出报告。

**哈希的对象。** 开头的 system 提示词单独哈希：一次性调用的 `system` 文本，或循环构建请求中开头的 system 角色消息。工具声明作为一个列表哈希。其余每条消息按角色、内容哈希，工具结果还包括调用 ID 与错误标记。消息 ID 和来源从不进入协议，因此被排除；内容字节相同的重新推导消息仍保持前缀。

**未命中的归因方式。** 比较结果之一是：`first-request`（无可比较对象）、`route`（提供方或模型变化）、`system`、`tools`、位于某下标与角色的 `message`（包括追加的 system 更新）、`shortened`（请求丢弃了消息，如压缩）、或带追加数量的 `none`。`headReused` 与 `reusedMessages` 说明上一次前缀有多少存活下来。

**意外未命中的判定。** 缓存比例为 `cacheRead / (cacheRead + input + cacheWrite)`。只有当头部存活、至少一条消息可复用、适配器报告了缓存计数、且比例低于 `minHitRate` 时，该调用才算意外未命中。由 harness 自身改变前缀造成的未命中属于预期，只报告而不写日志行。

**状态。** 每个 Session 与用途的上一次形态保存在插件实例中，超过 `maxSeries` 时按最久未使用淘汰。它按设计只存在于进程内：促成该插件的审计否决了在 Session 日志中持久化每请求前缀哈希，因为那会使日志翻倍并与可重建请求的决策冲突。

</details>

<a id="model-experience"></a>
## 模型体验

None，诊断只观察模型请求，不添加上下文或 Session 事件。

#### KV Cache 影响

None；插件读取请求前缀并报告提供方计数，不改变两者。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些限制说明插件目前无法归因的情形。它们是当前包的约束，不是任务清单。

- **哈希的是中立请求，而非协议正文**——适配器在此接缝之后才投影图片、文件 ID、执行世界路径和工具更新，因此这些投影带来的协议层变化不可见，可能被报告为 `none`。要归因协议字节需要提供方侧的钩子。
- **状态只存在于进程内**——重启或恢复 Session 后，首次调用报告为 `first-request`；按设计不向 Session 日志持久化任何内容。
- **不报告缓存计数的提供方永远无法归因**——缺少 `cacheReadTokens` 时缓存比例未知，插件只报告比较结果，不判定意外未命中。
- **同一 Session 与用途的并发调用会相互比较**——循环一次只发起一次调用，但手工构建的并行调用可能让第二次调用在第一次结算前就与其比较。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：协议层归因

比较止于适配器中立请求。要把未命中归因到刷新的图片文件 ID 或变化的执行世界路径，需要能观察序列化请求体的提供方侧钩子，而当前没有这样的接缝；上文的中立请求限制记录了该缺口。
</details>
