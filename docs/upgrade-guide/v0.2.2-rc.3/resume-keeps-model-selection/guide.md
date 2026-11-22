---
kind: upgrade-guide
description: "A resumed Session keeps the model and reasoning effort it recorded; a configured route or changed default now seeds only a Session that records no selection."
---

# Resuming keeps the Session model selection

English | [中文](guide.zh.md)

## Change

A resumed conversation now keeps the provider, model, and reasoning effort it recorded. `AgentLoop`'s declarative `agents:` entries and the `dsh --profile headless --session-id` adoption record their configured route only when the resumed Session records no selection of its own. The same rule already governed ordinary programmatic resume and the Web and ACP pickers, and the `agent-default-model` service already promised it for saved Sessions; the entry points that forced their route are the change.

Two consequences are visible. Changing the deployment default model or effort now affects only new Sessions: resuming an older conversation continues on its own route. And a resume whose recorded route is no longer registered fails its first request with the adapter's route error instead of being silently re-routed, so a deployment that removed a provider must migrate those conversations deliberately.

`Model.recorded()` is new: it returns only the choice the Session recorded, without the live-options fallback, and is the read an entry point uses to decide whether it may seed a Session.

## Migration

1. To move an existing conversation to another model or effort, select it in that Session — the Web or ACP model picker, or `agent.model.select()` in an explicit setup. A configuration change alone no longer moves a resumed conversation.
2. To apply a new default, start a new Session, or change the default before the conversation records its first request.
3. If a deployment relied on the configured route to rescue Sessions whose provider or model was removed from the profile, add a setup that resolves availability and calls `agent.model.select()` for those Sessions; the loop no longer re-routes them implicitly.
4. Verify: resume a Session whose header records a different model or effort than the configured default, then run one turn. The request keeps the recorded values and the Session log gains no `model/selection` event.
