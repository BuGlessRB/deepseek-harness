---
kind: upgrade-guide
description: "Runtime-context messages record an optional `partial` flag and state only the entries that changed, so a reader that ignores it believes more of the context was superseded."
---

# Runtime context states only the entries that changed

English | [中文](guide.zh.md)

## Change

The agent loop no longer re-states the whole runtime context when one contribution changes. A message that states only the changed entries records `partial: true` on its `runtime-context` source, and a message without that field remains the complete context, retiring the entries it does not name. First delivery, a retired entry, and the first step after compaction still state everything.

Only code that reads `user/message` sources — and the `developer/message`, `agent/inbox/spliced`, and `session/title-llm-request` events that embed one — is affected. A reader that ignores the field keeps working but believes the model holds fewer entries than it does, so it over-states supersession; it never invents state. [The persistence record](../../../persistence-changes/2026-11-21-runtime-context-partial.md) states the reader behavior in both directions. The Session header version does not move.

## Migration

1. Read `source.partial` beside `source.sections` wherever you fold runtime-context messages: merge a `partial: true` message into the entries you already hold, and replace them from a message without it.
2. Do not compare a message's `sections` with the current assembly to decide whether the model is up to date; compare the merged entries instead.
3. Run `pnpm run test:snapshot` and `pnpm exec vitest run packages/core/agent-loop`. A migration is complete when a step that changes one contribution logs one entry, and a resumed session whose history mixes complete and partial messages still emits nothing for an unchanged context.
