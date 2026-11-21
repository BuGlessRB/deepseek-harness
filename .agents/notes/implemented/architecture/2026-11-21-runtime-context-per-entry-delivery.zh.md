# Agent Note: 逐条目投递 runtime context

Status: implemented

[English](2026-11-21-runtime-context-per-entry-delivery.md) | 中文

## Problem

循环把 runtime context 记录成一份快照：任一贡献发生变化时，它会重述全部贡献，并包在「The following information describes your current session. It replaces earlier versions of this context…」这句引导之下。因此一次计划模式或 Team 模式切换会重发工作目录、文件策略、审批策略、subagent 身份以及两条模式状态——约 690 个字符——只为投递一行 22 个字符的内容。工作目录变化、沙箱模式变化以及其他任何单事实更新同样如此，而这些更新恰恰是尾部机制本应廉价处理的。

快照还混淆了两个问题：模型持有哪些条目，以及其中哪些发生了变化。只有后者需要一条消息。

## Decision

投影按名称折叠模型所持有的条目，来源是按表层顺序排列的已提交 runtime-context 消息。来源带 `partial: true` 的消息把其 sections 并入这些条目；其他消息则整体替换它们，因此其 sections 即完整上下文，并使其不再命名的条目退役。

于是每一步只陈述文本发生变化的条目，引导语为「The following session information changed. Each entry below replaces its earlier value, including any retained in conversation summaries.」。条目退役、模型尚未持有任何内容、以及保留消息被替换移除的上下文，都会以既有的覆盖措辞完整陈述，因为只有完整陈述才能使条目退役。有效集合为空时仍发送清空标记。`project()` 仍然是对已提交状态的纯读取：候选消息不推进任何状态，事件监听器按同一规则折叠每条追加的消息。

三种状态而非两种：从未投递（首次措辞）、条目已知（逐条目投递）、条目未知——保留消息没有结构化 sections，或其保留消息已被替换移除。未知状态会完整陈述上下文而不是猜测，这也保留了旧记录刷新行为：无结构的快照或清空标记会被重述一次。

## Alternatives considered

**保留单份快照并接受整份重述。** 最简单，也是此前的实现。单事实变化约需十倍的尾部 token，而这一代价正好落在本 harness 刻意做廉价的计划模式与 Team 模式切换上。

**在每条消息上记录完整条目集，但只渲染变化的条目。** `sections` 会始终是完整状态，读取方可以继续把最新消息视为权威。但这破坏了「快照的 sections 就是该消息中模型读到的字节」这一性质——客户端正是把这些 sections 渲染为模型被告知的内容——而且日志会因重复的条目列表而增长。

**不加字段，始终合并。** 每条消息都会合并，因此移除必须以带撤回文本的独立条目陈述，把宿主词汇（「no longer applies」）塞进条目正文，并且更早写入方的隐式移除将无法应用。可选的 `partial` 字段让完整性保持显式，并向后兼容：缺失即为此前所有写入方产出的完整上下文。

**从轮次而非循环投递。** Reasonix 把一次性投递的块附在 user 轮次上，并从模型可见历史回答「是否欠投」。DSH 的 runtime context 是由循环拥有的、追加在保留历史之后的消息，其保留逻辑已经回答压缩与恢复问题；再加一条投递通道会重复这份所有权。

## Consequences

单事实变化现在只需支付一个条目加一行引导语。该引导语比原先的覆盖声明略长，因此两条目变化大致持平，而完整上下文变化与以前相同。

持久化记录在 `runtime-context` 消息来源上新增了可选的 `partial` 字段；[持久化记录](../../../../docs/persistence-changes/2026-11-21-runtime-context-partial.zh.md)从两个方向陈述读取方行为。忽略该字段的读取方会看到更少的条目，从而认为被覆盖的内容更多，绝不会更少。

顺序不再参与比较：文本相同但顺序不同的贡献列表不再投递任何内容，而此前的数组比较会重发。

[必需 runtime context](2026-10-13-team-identity-runtime-context.zh.md) 拥有身份与模式状态为何留在必需上下文中；本笔记只改变每条消息重述多少内容。

## Related

- [策略段落是常驻文本](2026-11-21-policy-sections-static-tail-state.zh.md) 是本次投递优化的模式状态变更。
- [必需的 runtime context 中的 subagent 身份](2026-10-13-team-identity-runtime-context.zh.md) 拥有必需 runtime context 与压缩后的重新接纳。
