---
kind: upgrade-guide
description: "恢复的 Session 会保留自身记录的模型与推理强度；配置路由或变更后的默认值现在只为尚未记录选择的 Session 播种。"
---

# 恢复会话时保留 Session 的模型选择

[English](guide.md) | 中文

## 变更

恢复的会话现在会保留自身记录的 provider、model 与推理强度。`AgentLoop` 的声明式 `agents:` 条目与 `dsh --profile headless --session-id` 的接管，仅在恢复的 Session 自身没有记录选择时才会记录其配置路由。普通程序化恢复以及 Web 与 ACP 选择器此前已遵循该规则，`agent-default-model` 服务也已对已保存的 Session 作出同样承诺；发生变化的是那些强制应用自身路由的入口。

由此产生两项可见结果。修改部署默认模型或强度现在只影响新 Session：恢复旧会话会继续使用它自己的路由。而记录的路由已不再注册时，恢复后的第一个请求会以适配器的路由错误失败，而不再被静默改道，因此移除过某个 provider 的部署必须显式迁移这些会话。

新增 `Model.recorded()`：它只返回 Session 记录的选择，不包含实时 options 回退，是入口判断能否为该 Session 播种时读取的接口。

## 迁移

1. 要把已有会话切换到其他模型或强度，请在该 Session 内选择：Web 或 ACP 的模型选择器，或在显式 setup 中调用 `agent.model.select()`。仅修改配置不再改变已恢复会话的路由。
2. 要让新默认值生效，请新建 Session，或在会话记录第一次请求之前修改默认值。
3. 若某部署曾依赖配置路由来接管其 provider 或模型已从 profile 移除的 Session，请新增一个先解析可用性、再对这些 Session 调用 `agent.model.select()` 的 setup；循环不再隐式改道。
4. 验证方式：恢复一个其请求头记录的模型或强度与配置默认值不同的 Session，然后运行一轮。请求沿用记录值，且 Session 日志不会新增 `model/selection` 事件。
