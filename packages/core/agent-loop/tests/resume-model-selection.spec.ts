/**
 * Resuming keeps the model and reasoning effort the Session has been using;
 * configuration seeds new Sessions only. Both the plain resume path and the
 * declarative `agents:` resume path must follow that rule.
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const ROOTS: string[] = []
afterEach(async () => { for (const root of ROOTS.splice(0)) await rm(root, { recursive: true, force: true }) })

const HIGH = brandString<ReasoningEffortId>('high')
const LOW = brandString<ReasoningEffortId>('low')
const MAX = brandString<ReasoningEffortId>('max')

/** A route that offers every effort this spec uses. */
const REASONING = {
  efforts: [
    { id: LOW, name: 'Low' },
    { id: HIGH, name: 'High' },
    { id: MAX, name: 'Max' },
  ],
  defaultEffort: HIGH,
}

/** Mount one persistent composition over a shared root. */
async function harness(root: string, adapter: MockAdapter, agents: AgentLoop['config']['agents'] = []): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  // The backend mounts before the loop so root teardown unwinds the loop first.
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** A fresh persistent root shared by two compositions. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-resume-selection-'))
  ROOTS.push(root)
  return root
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function say(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

/** Model selection fields of one request. */
function selectionOf(request: GenerateOptions | undefined): { model: string; reasoningEffort?: string } {
  if (request === undefined) throw new Error('the adapter recorded no request')
  return {
    model: request.model,
    ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
  }
}

describe('resuming keeps the Session model selection', () => {
  it('keeps the stored effort on resume while a new Session takes the configured default', async () => {
    const root = await temporaryRoot()
    const first = new MockAdapter([textResponse('one')], REASONING)
    const firstCtx = await harness(root, first)
    const sessionId = brandString<SessionId>('keeps-its-effort')
    const created = await firstCtx.agentLoop.create(sessionId, {
      provider: 'mock', model: 'mock', reasoningEffort: MAX,
    })
    await say(firstCtx, created, 'first')
    expect(selectionOf(first.requests[0])).toEqual({ model: 'mock', reasoningEffort: MAX })
    await firstCtx.fiber.dispose()

    const second = new MockAdapter([textResponse('two'), textResponse('three')], REASONING)
    const secondCtx = await harness(root, second)
    // A different configured default — the kind a profile or global setting now names.
    const resumed = await secondCtx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock', reasoningEffort: LOW },
    })
    await say(secondCtx, resumed.agent, 'second')
    expect(selectionOf(second.requests[0])).toEqual({ model: 'mock', reasoningEffort: MAX })

    const fresh = await secondCtx.agentLoop.create(brandString<SessionId>('fresh-takes-default'), {
      provider: 'mock', model: 'mock', reasoningEffort: LOW,
    })
    await say(secondCtx, fresh, 'third')
    expect(selectionOf(second.requests[1])).toEqual({ model: 'mock', reasoningEffort: LOW })
    await secondCtx.fiber.dispose()
  })

  it('keeps the stored effort when a declarative agents: entry resumes the Session', async () => {
    const root = await temporaryRoot()
    const first = new MockAdapter([textResponse('one')], REASONING)
    const firstCtx = await harness(root, first)
    const sessionId = brandString<SessionId>('configured-keeps-its-effort')
    const created = await firstCtx.agentLoop.create(sessionId, {
      provider: 'mock', model: 'mock', reasoningEffort: MAX,
    })
    await say(firstCtx, created, 'first')
    await firstCtx.fiber.dispose()

    const second = new MockAdapter([textResponse('two')], REASONING)
    const secondCtx = await harness(root, second, [{
      id: 'configured', resumeSessionId: sessionId, provider: 'mock', model: 'mock', reasoningEffort: LOW,
    }])
    await vi.waitFor(() => { expect(secondCtx.agents.get(sessionId)).toBeDefined() })
    const resumed = secondCtx.agents.get(sessionId)
    if (resumed === undefined) throw new Error('the configured agent did not resume')
    await say(secondCtx, resumed, 'second')

    expect(selectionOf(second.requests[0])).toEqual({ model: 'mock', reasoningEffort: MAX })
    // The configuration must not have recorded a replacement selection on the Session.
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([])
    await secondCtx.fiber.dispose()
  })

  it('applies the configured route to a declarative resume of a Session that records no selection', async () => {
    const root = await temporaryRoot()
    const first = new MockAdapter([], REASONING)
    const firstCtx = await harness(root, first)
    const sessionId = brandString<SessionId>('configured-empty-session')
    // A stored Session with a completed turn but no request, so it records no selection.
    const handle = await firstCtx.sessionPersistence.create(firstCtx.sessions.prepare(sessionId).header)
    await handle.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    await handle.flush()
    await handle.close()
    await firstCtx.fiber.dispose()

    const second = new MockAdapter([textResponse('one')], REASONING)
    const secondCtx = await harness(root, second, [{
      id: 'configured-blank', resumeSessionId: sessionId, provider: 'mock', model: 'mock', reasoningEffort: LOW,
    }])
    await vi.waitFor(() => { expect(secondCtx.agents.get(sessionId)).toBeDefined() })
    const resumed = secondCtx.agents.get(sessionId)
    if (resumed === undefined) throw new Error('the configured agent did not resume')
    await say(secondCtx, resumed, 'first')

    expect(selectionOf(second.requests[0])).toEqual({ model: 'mock', reasoningEffort: LOW })
    await secondCtx.fiber.dispose()
  })
})
