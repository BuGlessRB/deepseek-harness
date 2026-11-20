---
kind: upgrade-guide
description: "projectToolSchema() drops its detachParameters argument and always returns canonical, detached parameters."
---

# `projectToolSchema()` returns canonical parameters

English | [中文](guide.zh.md)

## Change

`projectToolSchema(definition, detachParameters)` from `@deepseek-ai/dsh-tools` now takes only the definition. Every projection returns a detached copy whose parameter object keys are sorted at every level, so equivalent schemas serialize to identical bytes and a provider keeps its cached request prefix. A custom tool executor that passed `false` to share the registered parameters object now receives a copy. Every `required` name list is sorted as well, because it is a set in JSON Schema; `enum` values and `oneOf` branches keep their element order.

## Migration

1. Replace `projectToolSchema(definition, true)` and `projectToolSchema(definition, false)` with `projectToolSchema(definition)`.
2. If an executor compared projected parameters by identity with the registered definition, compare them structurally instead; the projection is always a new object.
3. Run `pnpm run typecheck`. A remaining two-argument call fails with "Expected 1 arguments, but got 2", and a projection of a schema that is not lossless JSON still throws.
