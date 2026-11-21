---
kind: upgrade-guide
description: "plan:policy and team:policy become standing prompt text, and the current mode reaches the model through the plan:mode and team:mode runtime context instead of a rewritten prefix."
---

# Plan and Team guidance stay in the prompt; the mode state rides the tail

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-plan-mode` and `@deepseek-ai/dsh-tool-agent-team` no longer add and remove their prompt sections when a mode toggles, so a toggle no longer rewrites the cached request prefix.

Plan mode renders the configured `section` from the first step plan mode applies, under the fixed sentence "Plan mode guidance. Apply it only while the current session information reports plan mode as active.", and keeps it for the rest of the Session. Team mode renders the Team guidance from the first step the tree enables it, under the equivalent Agent Teams sentence, and keeps it after the mode is switched off. A required `plan:mode` or `team:mode` runtime-context entry reports `Plan mode is active.`/`inactive` and `Agent Teams is enabled.`/`disabled`, and the loop appends a new runtime-context snapshot only when that state changes.

Two visible consequences follow. Plan mode no longer records a "The user switched this session to plan mode." user message; the runtime-context state replaces it, so transcripts and Session logs from this release on contain no plan-mode notice. Turning Team mode off now hides the task tools but keeps the guidance section in the system prompt. The `agentTeam` projection state version moves to 8 to fold the new `entered` fact, so a checkpoint written by an earlier version is discarded and its key refolds from the unchanged Session log.

## Migration

1. Re-read any deployment `section` text configured for `@deepseek-ai/dsh-plan-mode` in `cordis.yml` or an overlay. It now renders in every request from the first plan-mode entry, not only while the mode is active; word it so the fixed framing sentence above makes it true when plan mode is inactive.
2. Replace any check that treated a `user/message` whose source kind is `plan-mode` as the record of a mode switch. Read `plan/mode` session events, the `plan` projection, or the `plan:mode` runtime-context snapshot instead.
3. Regenerate pinned prompt, transcript, and Session fixtures recorded against the previous release; `pnpm run test:snapshot:refresh` does this for a checkout of this repository.
4. Run `pnpm run typecheck` and `pnpm run test:snapshot`. A migration is complete when switching plan mode or Team mode after the first entry leaves the rendered system prompt and the tool declarations unchanged and adds exactly one runtime-context snapshot.
