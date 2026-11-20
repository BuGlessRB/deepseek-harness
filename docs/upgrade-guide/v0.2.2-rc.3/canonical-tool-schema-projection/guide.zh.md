---
kind: upgrade-guide
description: "projectToolSchema() 移除 detachParameters 参数，并始终返回规范化且分离的参数。"
---

# `projectToolSchema()` 返回规范化参数

[English](guide.md) | 中文

## 变更

来自 `@deepseek-ai/dsh-tools` 的 `projectToolSchema(definition, detachParameters)` 现在只接受定义。每次投影都返回分离副本，其参数对象的键在每一层都已排序，因此等价 schema 会序列化为相同字节，提供方得以保留已缓存的请求前缀。过去传 `false` 以共享已注册参数对象的自定义工具执行器现在会收到副本。每个 `required` 名称列表也会被排序，因为它在 JSON Schema 中是集合；`enum` 值与 `oneOf` 分支保留元素顺序。

## 迁移

1. 将 `projectToolSchema(definition, true)` 与 `projectToolSchema(definition, false)` 改为 `projectToolSchema(definition)`。
2. 如果执行器曾用引用相等把投影参数与已注册定义比较，请改为按结构比较；投影始终是新对象。
3. 运行 `pnpm run typecheck`。仍保留双参数调用会报 “Expected 1 arguments, but got 2”，而对非无损 JSON schema 的投影仍会抛出错误。
