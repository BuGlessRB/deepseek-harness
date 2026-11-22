/** Miss attribution through a real LlmRuntime composition with a scripted provider. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import LlmRuntime, {
  createAssistantMessage, createSystemMessage, createUserMessage, LlmAdapter,
  type GenerateOptions, type StreamChunk, type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import * as PrefixDiagnostics from '../src/index.ts'
import type { Config, PrefixDiagnostic } from '../src/index.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'test-purpose': true
  }
}

const SESSION = brandString<Branded<'SessionId'>>('session-one')

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = () => createAssistantMessage({
  content: [{ type: 'text', text: 'ok' }], source: { provider: 'test-provider', model: 'test-model' },
})

/** One successful call's chunks, carrying the provider's accounting. */
const script = (usage: TokenUsage): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'usage', usage },
  { type: 'finish', reason: { kind: 'stop' } },
]

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly scripts: StreamChunk[][]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.scripts.shift() ?? []
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function call(messages: GenerateOptions['messages'], overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'test-provider', model: 'test-model', messages, sessionId: SESSION, ...overrides }
}

/** One call without a Session identity, which the plugin must pass through untracked. */
function untracked(messages: GenerateOptions['messages']): GenerateOptions {
  return { provider: 'test-provider', model: 'test-model', messages }
}

async function host(scripts: StreamChunk[][], config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test-provider'], new ScriptedAdapter(scripts))
  const reports: PrefixDiagnostic[] = []
  ctx.on('llm/prefix-diagnostics', report => reports.push(report))
  await ctx.plugin(PrefixDiagnostics, config)
  return { ctx, reports }
}

const head = createSystemMessage('prompt')
const first = [head, user('first')]
const second = [...first, assistant(), user('second')]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('prefix diagnostics', () => {
  it('reports a new series, then an unchanged prefix with its hit rate', async () => {
    const { ctx, reports } = await host([
      script({ inputTokens: 1_000, outputTokens: 5 }),
      script({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 990 }),
    ])
    await collect(ctx.llm.stream(call(first)))
    await collect(ctx.llm.stream(call(second)))
    expect(reports.map(report => [report.divergence.kind, report.reusedMessages, report.unexpectedMiss]))
      .toEqual([['first-request', 0, false], ['none', 1, false]])
    expect(reports[1]?.hitRate).toBeCloseTo(0.99)
    expect(reports[1]?.request.messages).toHaveLength(3)
  })

  it('logs an unexpected miss and still yields every chunk', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const miss = script({ inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 0 })
    const { ctx, reports } = await host([script({ inputTokens: 1_000, outputTokens: 5 }), miss])
    await collect(ctx.llm.stream(call(first)))
    const chunks = await collect(ctx.llm.stream(call(second)))
    expect(chunks).toEqual(miss)
    expect(reports[1]?.unexpectedMiss).toBe(true)
    expect(reports[1]?.hitRate).toBe(0)
    expect(logged).toHaveBeenCalledOnce()
    expect(logged.mock.calls[0]?.[0]).toBe('[llm-prefix-diagnostics]')
    expect(String(logged.mock.calls[0]?.[1])).toContain('unexpected cache miss')
  })

  it('attributes a tool change to the declarations and expects the miss', async () => {
    const tools = [{ name: 'search', description: 'Search', parameters: {} }]
    const { ctx, reports } = await host([
      script({ inputTokens: 1_000, outputTokens: 5 }),
      script({ inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 0 }),
    ])
    await collect(ctx.llm.stream(call(first)))
    await collect(ctx.llm.stream(call(second, { tools })))
    expect(reports[1]?.divergence).toEqual({ kind: 'tools' })
    expect(reports[1]?.cause).toBe('tools')
    expect(reports[1]?.headReused).toBe(false)
    expect(reports[1]?.unexpectedMiss).toBe(false)
  })

  it('reports nothing when the stream carries no usage', async () => {
    const noUsage: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]
    const { ctx, reports } = await host([noUsage])
    expect(await collect(ctx.llm.stream(call(first)))).toEqual(noUsage)
    expect(reports).toEqual([])
  })

  it('reports the comparison without a hit rate when the provider sends no cache counters', async () => {
    const { ctx, reports } = await host([
      script({ inputTokens: 10, outputTokens: 5 }),
      script({ inputTokens: 20, outputTokens: 5 }),
    ])
    await collect(ctx.llm.stream(call(first)))
    await collect(ctx.llm.stream(call(second)))
    expect(reports[1]?.hitRate).toBeUndefined()
    expect(reports[1]?.unexpectedMiss).toBe(false)
    expect(reports[1]?.reusedMessages).toBe(1)
  })

  it('names the purpose and the cache write in the log line', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctx, reports } = await host([
      script({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }),
      script({ inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 2_000 }),
    ])
    await collect(ctx.llm.stream(call(first, { purpose: 'test-purpose' })))
    await collect(ctx.llm.stream(call(second, { purpose: 'test-purpose' })))
    expect(reports[1]?.unexpectedMiss).toBe(true)
    expect(logged).toHaveBeenCalledOnce()
    expect(String(logged.mock.calls[0]?.[1])).toContain('purpose=test-purpose')
    expect(String(logged.mock.calls[0]?.[1])).toContain('cacheWrite=2000')
  })

  it.each([
    { label: 'route', before: first, after: call(second, { model: 'other-model' }), cause: 'route(test-provider/test-model)' },
    { label: 'system', before: first, after: call([createSystemMessage('other'), user('first')]), cause: 'system' },
    { label: 'message', before: second, after: call([head, user('changed'), ...second.slice(2)]), cause: 'message[0](user)' },
    { label: 'shortened', before: second, after: call(first), cause: 'shortened[1]' },
    { label: 'none', before: first, after: call(second), cause: 'none(+2)' },
  ])('labels the $label divergence', async ({ before, after, cause }) => {
    const { ctx, reports } = await host([
      script({ inputTokens: 10, outputTokens: 5 }),
      script({ inputTokens: 10, outputTokens: 5 }),
    ])
    await collect(ctx.llm.stream(call(before)))
    await collect(ctx.llm.stream(after))
    expect(reports[1]?.cause).toBe(cause)
  })

  it('keeps the call alive when a report listener throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const only = script({ inputTokens: 10, outputTokens: 5 })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['test-provider'], new ScriptedAdapter([only]))
    ctx.on('llm/prefix-diagnostics', () => {
      throw new Error('listener failure')
    })
    await ctx.plugin(PrefixDiagnostics, {})
    expect(await collect(ctx.llm.stream(call(first)))).toEqual(only)
    expect(logged).toHaveBeenCalledOnce()
    expect(String(logged.mock.calls[0]?.[1])).toContain('could not report one call')
  })

  it('leaves calls without a Session identity untracked', async () => {
    const only = script({ inputTokens: 10, outputTokens: 5 })
    const { ctx, reports } = await host([only, only])
    expect(await collect(ctx.llm.stream(untracked(first)))).toEqual(only)
    expect(await collect(ctx.llm.stream(untracked(first)))).toEqual(only)
    expect(reports).toEqual([])
  })

  it('drops the least recently used series beyond the bound', async () => {
    const other = brandString<Branded<'SessionId'>>('session-two')
    const { ctx, reports } = await host([
      script({ inputTokens: 10, outputTokens: 5 }),
      script({ inputTokens: 10, outputTokens: 5 }),
      script({ inputTokens: 10, outputTokens: 5 }),
    ], { maxSeries: 1 })
    await collect(ctx.llm.stream(call(first)))
    await collect(ctx.llm.stream(call(first, { sessionId: other })))
    await collect(ctx.llm.stream(call(second)))
    expect(reports.map(report => report.divergence.kind)).toEqual(['first-request', 'first-request', 'first-request'])
  })

  it('rejects a hit-rate threshold outside zero through one', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(PrefixDiagnostics, { minHitRate: 1.5 })).rejects.toThrow()
  })
})
