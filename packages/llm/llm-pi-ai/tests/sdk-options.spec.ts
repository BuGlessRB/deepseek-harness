import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })
})

describe('pi-ai terminal message observer', () => {
  it('observes the finished native message before the terminal usage chunk', async () => {
    const usage = {
      input: 3,
      output: 1,
      cacheRead: 2,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    const terminal = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'local-gateway',
      model: 'local-model',
      content: [{ type: 'text', text: 'hello' }],
      usage,
      stopReason: 'stop',
      timestamp: 1,
    }
    streamSimple.mockImplementation(() => (async function* () {
      yield { type: 'start', partial: terminal }
      yield { type: 'text_start', contentIndex: 0, partial: terminal }
      yield { type: 'text_end', contentIndex: 0, content: 'hello', partial: terminal }
      yield { type: 'done', reason: 'stop', message: terminal }
    })())
    const seen: { provider: string; model: string; message: unknown }[] = []
    const chunks: StreamChunk[] = []
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        'local-gateway': {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
        },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
      onTerminalMessage: (detail) => { seen.push({ ...detail }) },
    })

    for await (const chunk of adapter.stream({ provider: 'local-gateway', model: 'local-model', messages: [] })) {
      chunks.push(chunk)
    }

    expect(seen).toEqual([{ provider: 'local-gateway', model: 'local-model', message: terminal }])
    // The Harness usage vocabulary keeps pi-ai's buckets; the native message is
    // the only place a provider's own billing record survives.
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 6, cacheReadTokens: 2 },
    })
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('observes the failed native message for an in-stream error', async () => {
    const failed = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'local-gateway',
      model: 'local-model',
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error',
      errorMessage: 'provider exploded',
      timestamp: 1,
    }
    streamSimple.mockImplementation(() => (async function* () {
      yield { type: 'start', partial: failed }
      yield { type: 'error', reason: 'error', error: failed }
    })())
    const seen: unknown[] = []
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        'local-gateway': {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
        },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
      onTerminalMessage: (detail) => { seen.push(detail.message) },
    })

    for await (const _chunk of adapter.stream({ provider: 'local-gateway', model: 'local-model', messages: [] })) {
      // drain
    }

    expect(seen).toEqual([failed])
  })
})
