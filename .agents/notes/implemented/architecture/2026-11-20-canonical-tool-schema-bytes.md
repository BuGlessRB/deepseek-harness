# Agent Note: Canonical tool schema bytes

Status: implemented

English | [中文](2026-11-20-canonical-tool-schema-bytes.zh.md)

## Problem

Tool declarations are part of the provider request prefix, and a provider caches that prefix by exact bytes. DSH projected `ToolDefinition.parameters` as authored: `defineTool` kept the declaration order of its parameter map, and an MCP bridge passed the server's `inputSchema` through unchanged. Two tools describing the same arguments therefore produced different request bytes when a schema source reordered object keys — the same MCP server upgrading its SDK, or a plugin reordering its parameter map — and the request lost the cached prefix from the first reordered property. The Session compared schemas with `JSON.stringify`, so the same reordering also read as a header change and as a changed retained definition: it logged a new `request/header` snapshot and rebuilt the tool declaration series.

## Decision

`canonicalJsonValue()` in `@deepseek-ai/dsh-util-values` validates lossless JSON like `snapshotJsonValue()` and detaches it with every object's keys sorted in `Array.prototype.sort()` order. Arrays keep their element order: `enum` values and `oneOf` branches are model-visible sequences.

`projectToolSchema()` in `@deepseek-ai/dsh-tools` is the only projection from a registered definition to a model-facing schema. It canonicalizes parameters on every call — object keys at every level, and every `required` name list, which is a set in JSON Schema — so `ctx.tools.schemas()`, both executors, the PTC SDK text, and the loop's `request/header` snapshot carry identical bytes for equivalent schemas. It no longer takes `detachParameters`: every projection is a detached canonical copy.

Schema identity is structural. `headerEquals()` and the `toolHistory()` redeclaration check compare with `deepEqualJson()` instead of comparing serialized strings, so a schema that only reordered its object keys neither logs a new header nor restarts the declaration series, including against a log written before this change.

## Alternatives considered

**Canonicalize once at registration.** The registry would have to replace the registered object with a normalized copy. `ctx.tools.get()` returning the exact definition a plugin registered is a tested contract, and the definition also carries execution and presentation callbacks that a copy would have to preserve. Projection is already the single seam every model-facing path passes through.

**Sort every array.** `oneOf` branches and `enum` values are model-visible sequences whose order carries meaning, so only the name-set keyword is sorted. A source that permutes its field declaration usually permutes `properties` and `required` together, which is why the name list belongs in the canonical form rather than staying with the other arrays.

**Keep the serialized comparison in the Session.** A log written by an older writer, or any producer that bypasses `projectToolSchema`, would still read as changed. Structural equality makes the comparison independent of key order instead of depending on every writer having canonicalized first.

**Compare schema hashes.** A hash detects a miss but does not make two equivalent schemas serialize identically, so it cannot preserve the prefix. A durable per-request prefix hash also conflicts with the reconstructable-requests decision, which forbids storing derived request state in the Session log.

## Consequences

Every tool projection is a canonical deep copy, paid once per step per visible tool instead of once per registration. The copy reuses the existing iterative JSON walk, so deeply nested schemas still project without consuming the JavaScript call stack.

Model-visible parameter order is now alphabetical rather than authored, in the property map and in `required`. `bash`, `pwsh`, and the `write`/`edit` file tools had deliberately declared `description` or `file_path` first so the model writes that argument first; the schema now sorts both lists while their descriptions still ask for the argument order. The generated [tool catalog](../../../../docs/tool-catalog.md) was regenerated; the shipped tool schemas themselves did not change.

No persisted field or Session format changes: `request/header.tools` still stores plain JSON schemas, and only their key and `required` order is canonical from now on. `headerEquals()` ignores key order but not `required` order, so resuming a log written before this change logs one changed header — the request bytes changed anyway.

Unit tests pin canonical projection for a raw definition and for a compiled one, key-order-insensitive header equality, and a reordered redeclaration that continues the series. A loop-level test in [request-reconstruction](../../../../packages/core/agent-loop/tests/request-reconstruction.spec.ts) asserts that the wire request, the live header, and the folded header carry the same canonical bytes.

## Related

- [Reconstructable requests](2026-07-05-reconstructable-requests.md) owns the rule that every request is a pure function of the log.
- [Active tool headers and stateful request projection](2026-09-20-dynamic-tool-updates.md) owns the declaration series this note keeps from resetting.
