# Agent Note: A changed attachment path starts a request series

Status: implemented

English | [中文](2026-11-22-attachment-access-series-start.zh.md)

## Problem

File and image handle text names the execution-world read path of a durable attachment: the attachment provider's host object location mapped through `ctx.fs.processPathFromHostPath()`. The path is deliberately absent from the Session log, so every request re-derives it from the providers mounted at that moment.

Both facts together make the same logged message reach two requests with different bytes. Remounting the attachment or filesystem provider while a Session runs, or resuming a Session in another execution world — another `DSH_HOME`, a shared mount that moved — re-renders every occurrence of that attachment in history the log has already sent. The provider's prefix cache then misses from the first affected message, and nothing recorded why: `headerEquals()` saw the same config and tools, so no `request/header` was written at all, and `session.surface.contentGeneration` had not changed either. The miss was real, unattributed, and invisible to every log consumer.

## Decision

The loop asks `ctx.llm.attachmentAccessPaths(messages)` for the execution-world read path of every durable attachment occurrence in the request it is about to send, and starts a request series when a path differs from the path the preceding request of the same loop instance resolved for that attachment. An attachment the log has not sent yet contributes only new tail text and never starts a series, and an attachment whose path disappears (compaction removed its message, or the world can no longer read it) changes nothing already sent.

A loop instance's first request over a log that already carries a header starts a series when any attachment resolves to a path. The process that rendered that log may have run in another execution world, and nothing in the log can prove it did not.

The marker is the existing log-only series signal: `reason: 'series'` when the header is otherwise unchanged, and `startsSeries: true` on the `initial`, `resume`, or `change` event when a header is written for another reason. No new durable field, digest, or per-request record is added; paths still never enter the log.

A series started for this reason never consolidates the system prompt. Consolidation re-baselines surface node 0, which costs nothing only when the whole prefix is lost; this invalidation begins at the first affected attachment message, which can follow an appended in-history prompt node, so `SystemPromptProjection` keeps receiving only the pre-step, surface-generation, and incapable-route tool facts. The request still carries the prompt the route already had.

`attachmentAccessPaths()` belongs to `LlmRuntime` because that service already owns the same resolution for `fileRequestText()` and already reads both the attachment and filesystem services; `visitRequestAttachments()` in `dsh-llm` is the one walk over image and file occurrences, so the loop cannot diverge from the adapters that render the text.

## Alternatives considered

**Keep execution-world paths out of model-visible handle text.** The other half of the cache-coherency audit's recommendation, and the only variant that removes the invalidation instead of attributing it. Rejected because the path is the model's only route to an uploaded file and the only recovery route for an image omitted by request limits: dropping it leaves `FileBlock` content unreadable and an offloaded image unrecoverable. A world-independent reference — an attachment id or URI that the file tools resolve at call time — would need a new resolution surface in the filesystem seam and in every file tool, and a remote execution world holds no copy of the attachment object, so it would also change what those tools can promise about reading and editing.

**Move the paths to the runtime-context tail.** The path would leave the cached history, and a remap would append one small entry after it, which is how plan and Team mode state already reaches the model. Rejected for now: runtime-context contributions are assembled from prompt and tool state without the request messages, so the loop would have to derive messages before admission and hand them to a plugin-owned entry, and the entry's access map grows with every attachment in the Session while the model has to correlate an id across two messages.

**Store a per-attachment path digest in the log.** That would detect a remap across processes without re-deriving anything. Rejected because it adds a durable record per attachment and turns a derived fact into Session state; the series marker already carries the observable consequence, and a cache-diagnostics consumer can re-derive the paths itself.

**Detect the remap where the text is rendered.** An adapter knows the exact bytes, but it runs after the header is logged and cannot write one; putting the decision there would give every provider plugin its own request-series state.

## Consequences

A resumed Session whose history carries a mapped attachment now logs `startsSeries: true` on its `resume` header even when the execution world did not change. That is a false positive for cache attribution, accepted because the harness cannot prove the previous process resolved the same paths; the marker changes no model-visible byte, and prompt consolidation is unaffected.

A series start re-baselines the tool-declaration series, so an addition-only route rebuilds its declarations from the current tool list and a tool an earlier addition activated reads as deferred again until it is added again. That reset is what every series start does today, including one a pre-step listener declares without any surface change, and the provider has lost the prefix anyway; making the attachment case an exception would need a distinct durable marker.

`attachmentAccessPaths()` walks the request's content on every request. That walk is a single pass over already-derived messages with no allocation per message, and it replaces no existing work: the same request assembly later projects the same occurrences for the adapter.

Unit tests pin the mapping for image and file occurrences, the no-provider, no-mapping, and malformed-reference degradations, the series marker for a remapped path, its absence for a newly uploaded attachment, and the resume rule with and without a resolvable path. The agent-loop test also asserts that the logged message really reaches the provider with the new world's path, so the marker attributes an invalidation that exists rather than a hypothetical one.

## Related

- [Canonical tool schema bytes](2026-11-20-canonical-tool-schema-bytes.md) keeps schema key order out of the same prefix.
- [Reconstructable requests](2026-07-05-reconstructable-requests.md) owns the rule that a request is a pure function of the log, which a request-time path resolution only satisfies while the log is the sole authority for message bytes.
- [Execution-world image paths in model requests](../../archived/feature/2026-08-21-model-readable-image-paths.md) owns the decision that handle text names a resolved path and that the path stays out of Session events.
- [Policy sections are standing text](../architecture/2026-11-21-policy-sections-static-tail-state.md) and [runtime-context per-entry delivery](2026-11-21-runtime-context-per-entry-delivery.md) own the tail channel that the rejected alternative would have used.
