---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-21-runtime-context-partial

English | [中文](2026-11-21-runtime-context-partial.zh.md)

## Summary

Records on a runtime-context message whether it states only the entries that changed, instead of the complete context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-21-runtime-context-partial
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "3b7ff66f97ff649eb6328e253f99e5a908c25fba05fc3d8aba5a7d833c145c66"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "05e200ac6c8c7b11378a7373e9517a06cba28440639e31dd76d62fc70f5fcf4e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "bb321a4e038cbe03b1c256e5b6eaa26ac95ab1ba46e4402090078177e27dd27e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "b202139bfbc45153d6b25c734cca77ed82cea9be3491126cb38cc92fec13189a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Readers keep working in both directions. A record without the field is the complete context, which is exactly what every earlier writer produced, so older logs and newer readers agree; a reader that ignores the field treats a partial message as the complete context and therefore believes fewer entries apply, which over-states a supersession but never invents one. Writers add the field only to a message whose sections are a subset of what the model already holds, and the loop's projection folds a complete message by replacing its entries and a partial one by merging them, so resume and replay reconstruct the same state either way. The field carries no ordering or identity change and no header version moves.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-loop: 511 tests passed, covering first delivery, a one-entry change, a retired entry, a cleared context, compaction that removed the retained messages, a resumed projection that folds a partial history, and the legacy unframed snapshot refresh.

<a id="dev-note"></a>
## Dev Note

None.
