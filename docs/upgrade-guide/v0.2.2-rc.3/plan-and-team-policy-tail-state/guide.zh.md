---
kind: upgrade-guide
description: "plan:policy 与 team:policy 变为常驻提示词文本，当前模式改为通过 plan:mode 与 team:mode runtime context 送达模型，而不再重写前缀。"
---

# 计划与 Team 指引常驻提示词；模式状态走尾部

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-plan-mode` 与 `@deepseek-ai/dsh-tool-agent-team` 不再在模式切换时加入或移除各自的提示词段落，因此切换不再重写已缓存的请求前缀。

计划模式从生效的第一步起渲染已配置的 `section`，其上方是一句固定说明 "Plan mode guidance. Apply it only while the current session information reports plan mode as active."，并在会话余下时间里保留。Team 模式从该树首次启用的第一步起渲染 Team 指引，其上方是对应的 Agent Teams 说明句，关闭模式后仍然保留。一条必需的 `plan:mode` 或 `team:mode` runtime-context 条目报告 `Plan mode is active.`/`inactive` 与 `Agent Teams is enabled.`/`disabled`，循环仅在该状态变化时追加新的 runtime-context 快照。

由此产生两项可见结果。计划模式不再记录一条 "The user switched this session to plan mode." 用户消息；runtime-context 状态取而代之，因此自本版本起的 transcript 与 Session 日志不再包含计划模式通知。关闭 Team 模式后任务工具不再提供，但指引段落仍留在 system prompt 中。`agentTeam` 投影状态版本升至 8，以折叠新增的 `entered` 事实，因此更早版本写入的检查点会被丢弃，该 key 从未改写的 Session 日志重新折叠。

## 迁移

1. 重新阅读 `cordis.yml` 或 overlay 中为 `@deepseek-ai/dsh-plan-mode` 配置的 `section` 文本。它现在从首次进入计划模式起出现在每个请求中，而不再只在模式激活期间出现；请调整措辞，使上述固定说明句在计划模式未激活时也成立。
2. 替换任何把 `plan-mode` 来源的 `user/message` 当作模式切换记录的检查。改为读取 `plan/mode` 会话事件、`plan` 投影或 `plan:mode` runtime-context 快照。
3. 重新生成针对上一版本记录的提示词、transcript 与 Session 夹具；在本仓库检出中运行 `pnpm run test:snapshot:refresh` 即可。
4. 运行 `pnpm run typecheck` 与 `pnpm run test:snapshot`。当首次进入之后切换计划模式或 Team 模式使渲染出的 system prompt 与工具声明保持不变、并且只新增一条 runtime-context 快照时，迁移完成。
