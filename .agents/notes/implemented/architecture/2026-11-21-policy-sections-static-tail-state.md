# Agent Note: Policy sections are standing text; mode state rides the runtime context

Status: implemented

English | [中文](2026-11-21-policy-sections-static-tail-state.zh.md)

## Problem

`plan:policy` and `team:policy` were prompt sections whose text switched between empty and full with the mode: entering plan mode filled the section and leaving emptied it; enabling Agent Teams filled it and disabling emptied it. The section is part of the provider-visible request prefix, so every toggle either appended a complete new prompt version after the cached history (an `in-history` route) or replaced surface node 0 and lost the whole prefix (a route without prompt updates). Plan mode toggles several times per session on the reviewed-exit path, and Team mode toggles while a turn runs.

The plan-mode package also recorded a `plan-mode`-sourced user notice, "The user switched this session to plan mode.", but only when the last logged `request/header` described the other mode. That condition existed because the section used to change silently; it made the notice depend on when a header happens to be logged rather than on what the model was told.

## Decision

Both sections are standing text once the mode has ever applied in the Session, and the current state is delivered as a required runtime-context contribution at the end of the request.

Plan mode renders `PLAN_GUIDANCE_PREAMBLE` followed by the configured `section` from the first step plan mode applies — a pending selection counts, so the first planning step carries it — and keeps it for the rest of the Session. The preamble states that the guidance applies only while the session information reports plan mode as active. `plan:mode` reports `Plan mode is active.` or `Plan mode is inactive.`; the loop appends a new runtime-context snapshot when that state differs from the snapshot the model already holds, so a later toggle costs one small appended message and no prompt bytes.

Agent Teams uses the same shape. `team:policy` carries `TEAM_GUIDANCE_PREAMBLE`, which takes the place of the removed opening line "Agent Teams is available in this session.", from the first step the caller's tree enables Team mode. The `agentTeam` projection folds an `entered` fact for that, at state version 8; `ctx.agentTeams.mode(caller)` returns `{ enabled, entered }`, and `isEnabled()` reads the same selection. `team:mode` reports `Agent Teams is enabled.` or `Agent Teams is disabled.`

The plan-mode narration is gone with its `activeAtLastHeader` fold fact (plan projection state version 5). The runtime-context state is the single channel that tells the model the mode, so a second user message restating it has no reader: the model already holds the same fact on the tail, and the Web transcript presents the mode through the plan control chip.

## Alternatives considered

**Render both sections unconditionally.** The simplest static text, and the shape Reasonix uses for its core policies. The plan section is roughly 1,900 characters and the Team policy roughly 1,300, and both plugins are composed in the base bundle, so every Session would pay about 800 tokens of guidance for modes it never uses. Gating on "has ever applied" keeps the text static for exactly the Sessions that need it and adds no prompt change beyond the one the first entry already forces by adding `exit_plan_mode` and the Team task tools.

**Freeze the prefix and defer freshness, as Reasonix does.** Already rejected for DSH by [Reconstructable requests](2026-07-05-reconstructable-requests.md): a frozen prefix makes persona and settings edits invisible until a rebuild, which conflicts with "model-visible ⟺ logged", and detect-and-report leaves a violating request constructible.

**Deliver only the state marker and drop the guidance text.** The smallest tail, but then the deployment's plan guidance and the Team rules reach the model only as a runtime-context snapshot, which is not where standing instructions belong: a tail block carries no standing authority and is re-emitted whole whenever any other runtime fact changes.

**Keep the user notice and drop its header condition.** Narrating every logged transition avoids the stale condition, but it adds a second message per toggle that repeats the snapshot the same step delivers, and it narrates switches the model never observes.

## Consequences

The first plan-mode entry still changes the prefix, together with the tool addition it already causes; from then on, toggling plan mode changes neither the prompt nor the tool list. The first Team enable likewise adds the guidance with the task tools; switching Team mode off keeps the guidance and hides only the tools, so a disabled tree still carries the policy text in its prompt until the Session ends.

Transcripts no longer contain the plan-mode switch notice, and the plan projection no longer folds request headers. `plan:mode` and `team:mode` are `required`, so `systemPrompt.suppressRuntimeContext()` and `includeRuntimeContext: false` keep reporting the state on profiles that suppress the rest of the runtime context; without that, a suppressed profile would read standing guidance whose applicability no message states.

The `agentTeam` state version bump discards version-7 checkpoint rows and refolds the key from the unchanged Session log, which costs one full fold per resumed Session until the next checkpoint. Session snapshot fixtures for the plan and Team scenarios were refreshed, including the plan-review prompt sidecar, which now records one prompt change instead of four.

Unit tests pin the static section text and both state lines, assert that a toggle leaves the rendered prompt and tool declarations byte-identical, and assert the actor-less assembly contributes neither. The `plan-review` SDK snapshot asserts one changed prompt for the whole scenario and reads the mode from the last runtime-context message of each request.

## Related

- [Canonical tool schema bytes](2026-11-20-canonical-tool-schema-bytes.md) keeps schema key order out of the same prefix.
- [Reconstructable requests](2026-07-05-reconstructable-requests.md) owns the rule that every request is a pure function of the log, which the runtime-context snapshot satisfies.
- [System prompt as surface node](2026-09-02-system-prompt-as-surface-node.md) owns how a changed prompt reaches the wire.
- [Subagent identity in required runtime context](2026-10-13-team-identity-runtime-context.md) owns the required runtime-context contribution and the Team policy placement this note builds on.
