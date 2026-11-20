# Agent Note: Claiming conversation updates on a declared Chat Completions route

Status: implemented

English | [中文](2026-11-20-configured-conversation-update-claims.zh.md)

## Problem

`llm-pi-ai` derived the two conversation-update modes from pi-ai's installed catalog alone, and it withheld `supportsMidConvoSystemMessages` and `supportsMidConvoToolAdditions` from configuration because that catalog sets them for the vendors that need them: naming the vendor as the route inherits the right values. A route the catalog cannot describe — an aggregator's preset id, a private gateway's own model id — has no such entry, so it could never declare that its endpoint reads a later `system` message as the effective prompt or accepts a further tool declaration mid-conversation. Every prompt or tool-set change then belonged to an incapable route: the agent loop consolidated the prompt at surface node 0 and rewrote the leading declarations, so the request prefix miss from its first token.

## Decision

`llm-pi-ai` offers both switches as `compat` fields on `openai-completions`, per route and per model, beside the other switches a deployment must state because nothing can infer them. Every other catalog-owned field keeps its `withhold` disposition: Anthropic effort and fallback capabilities, Responses additional-tool and tool-search flags, session affinity, and prompt-cache-key modes stay catalog-only, and `anthropic-messages` and the Responses protocols keep their own mid-conversation flags catalog-only.

The switches remain pi-ai's, and so does their meaning. `conversationUpdates()` maps them to `systemPromptUpdate: in-history` and `toolUpdate: addition-only`, and pi-ai's transcript conversion reads the same two fields when it decides whether a later system message survives as `system` or becomes a user-role reminder, and whether an added tool is declared through a tool-carrying system message. Configuration therefore states the wire fact rather than the mode: a harness-level mode with no compat behind it would leave that conversion on the catalog's default and produce two incompatible projections of one claim.

Nothing verifies the claim. An endpoint that rejects a later system message or a further tool declaration fails that request mid-turn; the flags are the deployment's assertion about its own endpoint, and they belong on a model whose upstream is known to accept either form. [Dynamic tool updates](2026-09-20-dynamic-tool-updates.md) owns how additions, removals, and deferred declarations project once the mode is in force.

## Alternatives considered

- **Harness-level `systemPromptUpdate` and `toolUpdate` fields on `PiAiModelProfile`**, mirroring `llm-deepseek`'s catalog entries. Rejected: the modes and the compat flags would be two spellings of one claim, and pi-ai's own conversion reads only the flags. Setting the modes without them appends a system message that pi-ai then folds back into the leading prompt.
- **Offering both switches on every protocol that declares them.** Rejected for `anthropic-messages`, whose mid-conversation tool handling is activation and removal rather than addition-only, and for the Responses protocols, whose tool additions travel as additional-tool items; the catalog entries for those vendors already carry the right flag.
- **Requiring a catalog route.** Insufficient by construction: an aggregator preset or a gateway's own model id has no catalog entry to name, which is exactly the route that needs the claim.

## Testing

`tests/compat-upgrade.spec.ts` offers both switches on `openai-completions` and refuses them on a route whose models speak another protocol. `tests/conversation-updates.spec.ts` resolves a declared route into both modes and pins the serialized order on the wire: the changed prompt follows the cached history as a `system` message, and the added tool travels in a tool-carrying `system` message ahead of the update text.

## Consequences

A route whose model the catalog does not describe keeps its cached prefix through a prompt change and can add tools without rebuilding declarations; the cost is that a wrong claim fails a request mid-turn rather than degrading to reminders, and that the two flags are now part of the package's configurable surface, so a pi-ai upgrade that renames or removes either fails the build at the compat drift gate.
