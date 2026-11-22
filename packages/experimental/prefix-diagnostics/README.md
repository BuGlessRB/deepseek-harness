---
description: "Attribute each model call's prompt-cache miss to the request component that caused it, with the provider's cache counters, without changing the request or the Session log."
kind: "package-reference"
---

# @deepseek-ai/dsh-prefix-diagnostics

English | [中文](README.zh.md)

## Summary

`dsh-prefix-diagnostics` explains why a model call's prompt cache missed. It hashes the leading system prompt, the tool declarations, and every conversation message as the adapter receives them, compares each Session-scoped call with the preceding call of the same purpose, and reports the first component that changed together with the provider's cache counters. Choose it when a step billed a large uncached prompt and you need to know whether the harness changed the prefix or the provider missed a prefix it should have kept; it observes requests and never changes them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside the LLM runtime. Every model call that carries a Session identity is compared with the preceding call of the same Session and purpose; a call without a Session identity passes through untracked.

Each call emits `llm/prefix-diagnostics` after its usage arrives. The report names the request's prefix identity, the component that first broke the preceding prefix, how much of that prefix stayed reusable, the provider's token accounting, the cached share of input, and whether an unchanged prefix was billed uncached. Nothing is written to the Session log, so replay and Session format are unaffected.

When an unchanged prefix is billed below `minHitRate`, the plugin writes one line to stderr with the `[llm-prefix-diagnostics]` tag. Product profiles mount no console exporter for `ctx.logger`, so this line is the process's diagnostic output; forward the event to your own collector for aggregation.

### When to choose it

Choose it to attribute cache misses during development, capacity work, or an incident where a step reported far more uncached input than its neighbours. Skip it when you only need the aggregate hit rate a Session already records: the Web Statistics view reads that from `assistant/message` usage, while this plugin adds the request-side comparison the Session does not keep.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-prefix-diagnostics'
  config:
    minHitRate: 0.5
    maxSeries: 256
```

| Field | Default | Meaning |
|---|---|---|
| `minHitRate` | `0.5` | Cached share of input below which an unchanged, reusable prefix counts as an unexpected miss |
| `maxSeries` | `256` | Session and purpose pairs whose preceding prefix stays in memory; the least recently used is dropped |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-prefix-diagnostics) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin listens on the `llm/stream` waterfall, reads each request without rewriting it, and yields the adapter's chunks unchanged. After the final chunk it compares the request with the preceding request of the same series and emits the report.

**What is hashed.** The leading system prompt is hashed separately: the `system` text of a one-shot call, or the leading system-role message of a loop-built request. Tool declarations are hashed as one list. Every remaining message is hashed on role, content, and — for tool results — the call id and error flag. Message ids and sources never reach the wire and are excluded, so a re-derived message with identical bytes keeps the prefix.

**How a miss is attributed.** The comparison reports one of: `first-request` (nothing to compare), `route` (provider or model changed), `system`, `tools`, `message` at an index and role (including an appended system update), `shortened` (the request dropped messages, as compaction does), or `none` with the count of appended messages. `headReused` and `reusedMessages` state how much of the preceding prefix survived.

**What counts as an unexpected miss.** The cached share is `cacheRead / (cacheRead + input + cacheWrite)`. A call is an unexpected miss only when the head survived, at least one message was reusable, the adapter reported cache counters, and the share stayed below `minHitRate`. A miss caused by the harness's own prefix change is expected and is reported without a log line.

**State.** The preceding shape per Session and purpose lives in the plugin instance, least recently used first out at `maxSeries`. It is process-local by design: the audit that motivated the plugin rejected a durable per-request prefix hash in the Session log, because it would double log growth and conflict with reconstructable requests.

</details>

## Model Experience

None, as diagnostics observes model requests without adding context or Session events.

#### KV Cache effect

None; the plugin reads the request prefix and reports provider counters without changing either.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the plugin cannot attribute yet. They are current package constraints, not a task backlog.

- **The neutral request is hashed, not the wire body** — adapters project images, file ids, execution-world paths, and tool updates after this seam, so a wire-level change those projections introduce is invisible and can be reported as `none`. Attributing wire bytes would need a provider-side hook.
- **State is process-local** — a restart or a resumed Session reports its first call as `first-request`; nothing survives in the Session log by design.
- **Providers that report no cache counters are never attributed** — without `cacheReadTokens` the cached share is unknown, so the plugin reports the comparison and no unexpected miss.
- **Concurrent calls of one Session and purpose compare with each other** — the loop issues one call at a time, but a hand-built parallel caller can make the second call compare with the first before it settles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: wire-level attribution

The comparison stops at the adapter-neutral request. Attributing a miss to a refreshed image file id or a changed execution-world path would need a provider-side hook that observes the serialized body, which no current seam exposes; the neutral-request limitation above records that gap.
</details>
