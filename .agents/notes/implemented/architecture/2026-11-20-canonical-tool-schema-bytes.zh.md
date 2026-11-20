# Agent Note: 规范化的工具 schema 字节

Status: implemented

[English](2026-11-20-canonical-tool-schema-bytes.md) | 中文

## 问题

工具声明是提供方请求前缀的一部分，而提供方按确切字节缓存该前缀。DSH 过去按作者书写的原样投影 `ToolDefinition.parameters`：`defineTool` 保留参数映射的声明顺序，MCP 桥接则原样传递服务器的 `inputSchema`。因此，当某个 schema 来源重排对象键时——同一个 MCP 服务器升级 SDK，或插件重排自己的参数映射——描述相同参数的两个工具会产生不同的请求字节，请求从第一个被重排的属性起失去已缓存前缀。Session 用 `JSON.stringify` 比较 schema，于是同样的重排还会被读作请求头变化和保留定义变化：它记录新的 `request/header` 快照并重建工具声明序列。

## 决定

`@deepseek-ai/dsh-util-values` 中的 `canonicalJsonValue()` 像 `snapshotJsonValue()` 一样校验无损 JSON，并按 `Array.prototype.sort()` 的顺序对每一层对象的键排序后分离副本。数组保留元素顺序：`enum` 值与 `oneOf` 分支都是面向模型的序列。

`@deepseek-ai/dsh-tools` 中的 `projectToolSchema()` 是从已注册定义到面向模型 schema 的唯一投影。它在每次调用时规范化参数——每一层对象的键，以及每个 `required` 名称列表（它在 JSON Schema 中是集合）——因此 `ctx.tools.schemas()`、两种执行器、PTC SDK 文本以及循环的 `request/header` 快照对等价 schema 携带相同字节。它不再接受 `detachParameters`：每次投影都是分离的规范化副本。

schema 身份按结构判定。`headerEquals()` 与 `toolHistory()` 的重新声明检查改用 `deepEqualJson()`，不再比较序列化字符串，因此仅重排对象键的 schema 既不会记录新请求头，也不会重建声明序列——对本改动之前写入的日志同样如此。

## 考虑过的替代方案

**在注册时规范化一次。** 注册表将不得不用规范化副本替换已注册对象。`ctx.tools.get()` 返回插件注册的确切定义是有测试约束的契约，而该定义还携带复制时必须保留的执行与展示回调。投影本来就是每条面向模型路径都经过的唯一接缝。

**连所有数组都排序。** `oneOf` 分支与 `enum` 值是面向模型的序列，其顺序带有含义，因此只排序集合语义的关键字。置换字段声明顺序的来源通常会同时置换 `properties` 与 `required`，这正是名称列表属于规范化形式、而不与其他数组并列的原因。

**在 Session 中保留序列化比较。** 由较旧写入器记录的日志，或任何绕过 `projectToolSchema` 的生产者，仍会被读作已变化。结构相等让比较不依赖键顺序，而不是依赖每个写入器先行规范化。

**比较 schema 哈希。** 哈希能发现未命中，却不能让两个等价 schema 序列化为相同字节，因此无法保住前缀。持久化每次请求的前缀哈希还与可重建请求的决定冲突，后者禁止在 Session 日志中存放派生的请求状态。

## 后果

每次工具投影都是一次规范化的深拷贝，成本按每个可见工具每步支付一次，而不是按注册支付一次。该拷贝复用既有的迭代式 JSON 遍历，因此深层嵌套的 schema 仍可在不消耗 JavaScript 调用栈的情况下完成投影。

面向模型的参数顺序现在是字母序，而非作者书写顺序，属性映射与 `required` 皆然。`bash`、`pwsh` 以及 `write`/`edit` 文件工具过去刻意把 `description` 或 `file_path` 声明在最前，让模型先写该参数；现在 schema 对两个列表都排序，其描述仍要求该参数顺序。生成的[工具目录](../../../../docs/tool-catalog.zh.md)已重新生成；已交付工具 schema 本身并未改变。

没有持久化字段或 Session 格式变化：`request/header.tools` 仍存储普通 JSON schema，只是从现在起其键顺序与 `required` 顺序是规范化的。`headerEquals()` 忽略键顺序，但不忽略 `required` 顺序，因此恢复本改动之前写入的日志会记录一次变更请求头——请求字节本就已改变。

单元测试固定了原始定义与编译后定义的规范化投影、对键顺序不敏感的请求头相等性，以及继续序列的重排重新声明。位于[请求重建](../../../../packages/core/agent-loop/tests/request-reconstruction.spec.ts)的循环级测试断言：线上请求、实时请求头与折叠后的请求头携带相同的规范化字节。

## 相关

- [可重建请求](2026-07-05-reconstructable-requests.zh.md)负责“每个请求都是日志的纯函数”这一规则。
- [活动工具请求头与有状态请求投影](2026-09-20-dynamic-tool-updates.zh.md)负责本记录所保护的声明序列。
