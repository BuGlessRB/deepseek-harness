/**
 * Attachment handle text names an execution-world path, so the loop starts a
 * new request series when the current world resolves one differently than the
 * request that already sent it.
 */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type LlmRuntimeService from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One execution world: the attachment provider's host object and its mapping. */
interface World {
  hostPath: string | undefined
  map: (hostPath: string) => string | undefined
}

const NOTES_DIGEST = `sha256:${'a'.repeat(64)}`

/** The durable attachment id type, derived instead of depending on the attachment package. */
type AttachmentId = Parameters<LlmRuntimeService['fileRequestText']>[0]['attachmentId']

function upload(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text', text },
      { type: 'file', attachment: { attachmentId: brandString<AttachmentId>(NOTES_DIGEST), name: 'notes.txt', bytes: 3 } },
    ],
    source: { kind: 'user' },
  })
}

function prompt(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Mount the loop over one execution world; `fs` is optional so a test can omit the mapping. */
async function mount(adapter: MockAdapter, world: World, mapped = true): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('attachments', { fileHostPath: () => world.hostPath } as never)
  if (mapped) {
    ctx.provide('fs', { processPathFromHostPath: (hostPath: string) => world.map(hostPath) } as never)
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function send(agent: Agent, message: ReturnType<typeof createUserMessage>): Promise<void> {
  agent.followup(message)
  await agent.whenIdle()
}

const headers = (agent: Agent) => agent.session.snapshotEvents()
  .filter(event => event.type === 'request/header')
  .map(event => [event.data.reason, event.data.startsSeries])

/** Collect the headers a live agent appends after its seed. */
function appendedHeaders(ctx: Context, agent: Agent): (readonly [string, true | undefined])[] {
  const seen: (readonly [string, true | undefined])[] = []
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'request/header') return
    seen.push([event.data.reason, event.data.startsSeries])
  })
  return seen
}

/** Seed a Session whose earlier process already sent one mapped attachment. */
function seededSource(ctx: Context, sessionId: string) {
  const source = ctx.sessions.create(brandString<SessionId>(sessionId))
  source.append('turn/start', { turn: 1 })
  source.append('user/message', upload('earlier process'), { surfaceOp: 'append' })
  source.append('request/header', {
    header: { config: { provider: 'mock', model: 'model' } },
    reason: 'initial',
  })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return source
}

describe('attachment access series', () => {
  it('starts a series when a sent attachment resolves to a different path', async () => {
    const world: World = { hostPath: '/host/notes.txt', map: hostPath => `/world-a${hostPath}` }
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await mount(adapter, world)
    const agent = await ctx.agentLoop.create(brandString<SessionId>('remap'), { provider: 'mock', model: 'model' })

    await send(agent, upload('first'))
    await send(agent, prompt('same world'))
    expect(headers(agent)).toEqual([['initial', undefined]])

    world.map = hostPath => `/world-b${hostPath}`
    await send(agent, prompt('remounted world'))

    expect(headers(agent)).toEqual([['initial', undefined], ['series', undefined]])
    // The same logged message reaches the provider with the new world's path:
    // that is the invalidation the marker attributes.
    const before = adapter.requests.at(-2)?.messages ?? []
    const after = adapter.requests.at(-1)?.messages ?? []
    const handle = before.findIndex(message => JSON.stringify(message.content).includes('read-only copy saved at'))
    expect(handle).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(before[handle]?.content)).toContain('/world-a/host/notes.txt')
    expect(JSON.stringify(after[handle]?.content)).toContain('/world-b/host/notes.txt')
  })

  it('does not start a series for an attachment the log has not sent yet', async () => {
    const world: World = { hostPath: '/host/notes.txt', map: hostPath => `/world-a${hostPath}` }
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await mount(adapter, world)
    const agent = await ctx.agentLoop.create(brandString<SessionId>('new-attachment'), { provider: 'mock', model: 'model' })

    await send(agent, prompt('first'))
    await send(agent, upload('uploads now'))
    await send(agent, prompt('unchanged world'))

    expect(headers(agent)).toEqual([['initial', undefined]])
  })

  it('starts a series on the first request over a log that already sent a mapped attachment', async () => {
    const adapter = new MockAdapter([textResponse('continued')])
    const ctx = await mount(adapter, { hostPath: '/host/notes.txt', map: hostPath => `/world${hostPath}` })
    const { agent } = await ctx.agents.create({
      sessionId: brandString<SessionId>('attachment-resumed'),
      seed: seededSource(ctx, 'attachment-source').snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const appended = appendedHeaders(ctx, agent)
    await send(agent, prompt('resumed elsewhere'))

    expect(appended).toEqual([['resume', true]])
  })

  it('keeps the resumed series when the execution world cannot read the attachment', async () => {
    const adapter = new MockAdapter([textResponse('continued')])
    const ctx = await mount(adapter, { hostPath: '/host/notes.txt', map: () => undefined }, false)
    const { agent } = await ctx.agents.create({
      sessionId: brandString<SessionId>('unmapped-resumed'),
      seed: seededSource(ctx, 'unmapped-source').snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'model' },
    })
    const appended = appendedHeaders(ctx, agent)
    await send(agent, prompt('resumed without a mount'))

    // Handle text without a path is world-independent, so nothing was re-derived.
    expect(appended).toEqual([['resume', undefined]])
  })
})
