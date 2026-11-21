# Agent Note: 策略段落是常驻文本，模式状态走 runtime context

Status: implemented

[English](2026-11-21-policy-sections-static-tail-state.md) | 中文

## Problem

`plan:policy` 与 `team:policy` 曾是随模式在「空」与「满」之间切换的提示词段落：进入计划模式填入该段落，离开则清空；启用 Agent Teams 填入，禁用则清空。该段落属于提供方可见的请求前缀的一部分，因此每次切换要么在已缓存历史之后追加一份完整的提示词版本（`in-history` 路由），要么替换 surface 第 0 号节点并失去整个前缀（不支持提示词更新的路由）。在经评审退出的路径上，计划模式在一个会话中会切换多次；Team 模式则在轮次运行期间切换。

plan-mode 包还会记录一条来源为 `plan-mode` 的用户通知「The user switched this session to plan mode.」，但仅当最后记录的 `request/header` 描述的是另一种模式时才记录。该条件之所以存在，是因为段落过去是静默变化的；它让通知取决于请求头何时被记录，而不是取决于模型被告知了什么。

## Decision

一旦模式在会话中曾经生效，两个段落都成为常驻文本，当前状态则作为一条必需的 runtime-context 条目在请求末尾送达。

计划模式从生效的第一步起渲染 `PLAN_GUIDANCE_PREAMBLE` 加上已配置的 `section`——待生效的选择也算生效，因此第一步规划就携带它——并在会话余下时间里保留。该说明句声明：仅当会话信息报告计划模式处于激活状态时指引才适用。`plan:mode` 报告 `Plan mode is active.` 或 `Plan mode is inactive.`；当该状态与模型已持有的快照不同时，循环追加新的 runtime-context 快照，因此之后的切换只花费一条小型追加消息，不改变任何提示词字节。

Agent Teams 采用同样的形态。`team:policy` 从调用者所在的树首次启用 Team 模式的那一步起携带 `TEAM_GUIDANCE_PREAMBLE`，它取代了被移除的首行「Agent Teams is available in this session.」。`agentTeam` 投影为此折叠一个 `entered` 事实，状态版本为 8；`ctx.agentTeams.mode(caller)` 返回 `{ enabled, entered }`，`isEnabled()` 读取同一份选择。`team:mode` 报告 `Agent Teams is enabled.` 或 `Agent Teams is disabled.`。

plan-mode 的通知与其 `activeAtLastHeader` 折叠事实一并移除（plan 投影状态版本 5）。runtime-context 状态是告知模型模式的唯一通道，因此再来一条复述该状态的用户消息没有读者：模型已在尾部持有同一事实，而 Web transcript 通过计划控制 chip 呈现该模式。

## Alternatives considered

**无条件渲染两个段落。** 这是最简单的常驻文本，也是 Reasonix 处理其核心策略的方式。计划段落约 1,900 字符、Team 策略约 1,300 字符，而两个插件都在 base bundle 中组合，因此每个会话都要为它从不使用的模式付出约 800 个 token 的指引开销。以「曾经生效」为门槛，只在真正需要的会话中保持文本常驻，且除了首次生效本就因加入 `exit_plan_mode` 与 Team 任务工具而付出的那一次提示词变化之外，不引入新的变化。

**像 Reasonix 那样冻结前缀并推迟新鲜度。** DSH 已由[可重建请求](2026-07-05-reconstructable-requests.zh.md)否决：冻结前缀会让 persona 与设置修改在重建之前不可见，这与「模型可见 ⟺ 记录在案」冲突；而「检测并报告」会让违规请求仍然可被构造。

**只投递状态标记并去掉指引文本。** 这是最小的尾部，但这样一来部署方的计划指引与 Team 规则只能通过 runtime-context 快照到达模型，而常驻指令不属于那里：尾部块不携带常驻权威，并且只要任何其他运行时事实变化就会被整份重发。

**保留用户通知但去掉其请求头条件。** 为每次已记录的切换都发通知可以避开过时的条件，但它在同一步为快照再追加一条复述消息，而且还会叙述模型从未观测到的切换。

## Consequences

首次进入计划模式仍会改变前缀，并与它本就引起的工具新增同步发生；此后切换计划模式既不改变提示词也不改变工具列表。首次启用 Team 同样随任务工具一起加入指引；关闭 Team 模式后指引仍保留、只隐藏工具，因此被禁用的树在会话结束前仍会在提示词中携带策略文本。

transcript 不再包含计划模式切换通知，plan 投影也不再折叠请求头。`plan:mode` 与 `team:mode` 是 `required` 的，因此 `systemPrompt.suppressRuntimeContext()` 与 `includeRuntimeContext: false` 在这些抑制了其余 runtime context 的 profile 上仍会报告状态；否则被抑制的 profile 会读到一段常驻指引，却没有任何消息说明它是否适用。

`agentTeam` 的状态版本升级会丢弃版本 7 的检查点行，并从未改写的 Session 日志重新折叠该 key；在下一个检查点之前，每次恢复会话都要付一次完整折叠。计划与 Team 场景的 Session 快照夹具已重新生成，包括计划评审的提示词 sidecar——它现在只记录一次提示词变化，而不是四次。

单元测试固定常驻段落文本与两条状态行，断言一次切换使渲染出的提示词与工具声明逐字节不变，并断言无 actor 的装配两者都不贡献。`plan-review` SDK 快照断言整个场景只有一次提示词变化，并从每个请求的最后一条 runtime-context 消息读取模式。

## Related

- [Canonical tool schema bytes](2026-11-20-canonical-tool-schema-bytes.zh.md) 让 schema 键序不进入同一个前缀。
- [可重建请求](2026-07-05-reconstructable-requests.zh.md) 拥有「每个请求都是日志的纯函数」这一规则，runtime-context 快照满足它。
- [系统提示词作为 surface 节点](2026-09-02-system-prompt-as-surface-node.zh.md) 拥有变化后的提示词如何到达线上。
- [必需的 runtime context 中的 subagent 身份](2026-10-13-team-identity-runtime-context.zh.md) 拥有本笔记所依据的必需 runtime-context 贡献与 Team 策略位置。
