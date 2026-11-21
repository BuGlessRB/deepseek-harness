# Agent Note: Per-entry runtime-context delivery

Status: implemented

English | [中文](2026-11-21-runtime-context-per-entry-delivery.zh.md)

## Problem

The loop logged runtime context as one snapshot: when any contribution changed it re-stated every contribution, wrapped in "The following information describes your current session. It replaces earlier versions of this context…". A plan-mode or Team-mode toggle therefore re-sent the working directory, file policy, approval policy, subagent identity, and both mode states — around 690 characters — to deliver a 22-character line. The same held for a working-directory change, a sandbox-mode change, and every other single-fact update, and those updates are exactly the ones the tail exists to make cheap.

The snapshot also conflated two questions: which entries the model holds, and which of them changed. Only the second needs a message.

## Decision

The projection folds the entries the model holds, one name at a time, from the committed runtime-context messages in surface order. A message whose source carries `partial: true` merges its sections into those entries; every other message replaces them, so its sections are the complete context and retire the entries it no longer names.

A step then states only the entries whose text differs, under "The following session information changed. Each entry below replaces its earlier value, including any retained in conversation summaries." A retired entry, a context the model holds nothing of, and a context whose retained messages a replacement removed are stated completely under the existing replacement wording, because only a complete statement can retire an entry. An empty active set still emits the cleared marker. `project()` stays a pure read of committed state: proposals advance nothing, and the event listener folds each appended message by the same rule.

Three states, not two: nothing ever delivered (first-time wording), entries known (per-entry delivery), and entries unknown — a retained message without structured sections, or one a replacement removed. Unknown states the complete context rather than guessing, which also keeps the legacy-refresh behavior: an unframed snapshot or clear marker is restated once.

## Alternatives considered

**Keep one snapshot and accept the whole-context restatement.** Simplest, and what shipped until now. It costs roughly ten times the tail tokens per single-fact change, and the cost lands on the plan and Team toggles this harness deliberately made cheap.

**Record the complete entry set on every message and render only the changed entries.** `sections` would stay the full state, so readers could keep treating the newest message as authoritative. It breaks the property that a snapshot's sections are the bytes the model read in that message — the client renders those sections as what the model was told — and it grows the log with a repeated entry list.

**No flag; always merge.** Every message would merge, so a removal would have to be stated as its own entry with retraction text, putting host vocabulary ("no longer applies") into a section body and leaving an older writer's implicit removals unapplied. The optional `partial` field keeps completeness explicit and is backward compatible: absence is the complete context every earlier writer produced.

**Deliver from the turn rather than the loop.** Reasonix attaches once-delivered blocks to the user turn and answers "is this owed" from model-visible history. DSH's runtime context is a loop-owned message appended after retained history, and its retention already answers compaction and resume; adding a second delivery channel would duplicate that ownership.

## Consequences

A single-fact change now pays one entry plus one intro line. The intro is slightly longer than the previous supersession sentence, so a two-entry change is roughly break-even and a full-context change is unchanged.

The durable record gained an optional `partial` field on the `runtime-context` message source; [the persistence record](../../../../docs/persistence-changes/2026-11-21-runtime-context-partial.md) states the reader behavior in both directions. A reader that ignores the field sees fewer entries and believes more was superseded, never less.

Order is no longer part of the comparison: a reordered contribution list with identical text delivers nothing, where the previous array comparison re-sent it.

[Required runtime context](2026-10-13-team-identity-runtime-context.md) owns why identity and the mode states stay in required context; this note changes only how much of that context each message restates.

## Related

- [Policy sections are standing text](2026-11-21-policy-sections-static-tail-state.md) is the mode-state change this delivery makes cheap.
- [Subagent identity in required runtime context](2026-10-13-team-identity-runtime-context.md) owns required runtime context and compaction re-admission.
