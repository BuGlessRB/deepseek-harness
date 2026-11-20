# Agent Note: 在自行声明的 Chat Completions 路由上声明对话更新

Status: implemented

[English](2026-11-20-configured-conversation-update-claims.md) | 中文

## 问题

`llm-pi-ai` 此前只依据已安装的 pi-ai 目录推导两种对话更新模式，并把 `supportsMidConvoSystemMessages` 与 `supportsMidConvoToolAdditions` 排除在配置之外，因为该目录会为需要的厂商设置它们：把该厂商命名为路由即可继承正确的值。目录无法描述的路由——聚合器的 preset id、私有网关自有的模型 id——没有这样的条目，因此永远无法声明其端点会把后续的 `system` 消息读作有效提示词，或接受对话中的后续工具声明。此后每次提示词或工具集变化都落在不具备该能力的路由上：Agent loop 在 surface 第 0 号节点合并提示词并重写开头的声明，请求前缀从第一个 token 起就无法命中缓存。

## 决策

`llm-pi-ai` 在 `openai-completions` 上把这两个开关作为 `compat` 字段提供，可按路由和按模型设置，与其他必须由部署声明、无法推断的开关并列。其余目录拥有的字段维持 `withhold` 处置：Anthropic effort 与回退能力、Responses 的附加工具与工具搜索标志、会话亲和性以及提示词缓存键模式仍只能来自目录，`anthropic-messages` 与 Responses 协议各自的对话中标志同样只能来自目录。

这些开关仍属于 pi-ai，其含义亦然。`conversationUpdates()` 把它们映射为 `systemPromptUpdate: in-history` 与 `toolUpdate: addition-only`；pi-ai 的对话记录转换读取同样的两个字段，用来决定后续系统消息是保留为 `system` 角色还是转换为用户角色提醒，以及新增工具是否通过携带工具的 system 消息声明。因此配置声明的是线协议事实而不是模式本身：没有 compat 支撑的 harness 级模式会让该转换停留在目录默认值上，对同一项声明产生两种互不兼容的投影。

没有任何环节验证该声明。拒绝后续系统消息或后续工具声明的端点会在该请求中途失败；这些标志是部署方对自身端点的断言，只能用在已知接受其中任一形式的上游模型上。模式生效后，新增、移除与延迟声明的投影由[动态工具更新](2026-09-20-dynamic-tool-updates.zh.md)负责。

## 考虑过的替代方案

- **在 `PiAiModelProfile` 上增加 harness 级的 `systemPromptUpdate` 与 `toolUpdate` 字段**，仿照 `llm-deepseek` 的目录条目。已否决：模式与 compat 标志会是同一项声明的两种拼写，而 pi-ai 自身的转换只读取标志；只设置模式而不设置标志，追加的系统消息会被 pi-ai 折回开头的提示词。
- **在声明这两个开关的每个协议上都提供它们。** 对 `anthropic-messages` 已否决，其对话中工具处理是激活与移除而非仅添加；对 Responses 协议同样否决，其工具添加以附加工具条目传递；这些厂商的目录条目已携带正确的标志。
- **要求使用目录路由。** 从构造上就不成立：聚合器 preset 或网关自有模型 id 没有可命名的目录条目，而这正是需要该声明的路由。

## 测试

`tests/compat-upgrade.spec.ts` 在 `openai-completions` 上提供这两个开关，并拒绝使用其他协议的路由。`tests/conversation-updates.spec.ts` 把一条自行声明的路由解析为两种模式，并固定线协议上的序列化顺序：变化后的提示词作为 `system` 消息跟在已缓存历史之后，新增工具放在携带工具的 `system` 消息中，位于更新文本之前。

## 后果

目录未描述的模型所在路由在提示词变化时得以保留已缓存前缀，并可在不重建声明的情况下新增工具；代价是错误声明会让请求中途失败，而不是退化为提醒，且这两个标志已成为包可配置表面的一部分，pi-ai 升级若重命名或移除它们，会在 compat 漂移检查处使构建失败。
