/** Real Loader composition: the diagnostics plugin mounted from a cordis.yml row beside the shipped LLM runtime. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { createSystemMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import * as PrefixDiagnostics from '../src/index.ts'
import type { PrefixDiagnostic } from '../src/index.ts'

const SESSION = brandString<Branded<'SessionId'>>('composed-session')

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

/** One successful call's chunks, carrying the provider's accounting. */
function script(usage: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'ok' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Provider scripted per call, in order. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly scripts: StreamChunk[][]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.scripts.shift() ?? []
  }
}

/** Import mapped source modules without claiming support for Node's HMR internals. */
function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

/** Consume a stream so the plugin's post-settle report runs. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) continue
}

it('mounts from cordis.yml and attributes two Session calls through the real waterfall', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-prefix-diagnostics-loader-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-prefix-diagnostics'",
    '  config:',
    '    minHitRate: 0.5',
    '',
  ].join('\n'))

  const context = ctx = new Context()
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-prefix-diagnostics', PrefixDiagnostics],
  ])
  context.loader.internal = sourceModuleLoader(async (specifier) => {
    if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  })
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()

  const reports: PrefixDiagnostic[] = []
  context.on('llm/prefix-diagnostics', report => reports.push(report))
  context.llm.registerAdapter(['test-provider'], new ScriptedAdapter([
    script({ inputTokens: 40, outputTokens: 5 }),
    script({ inputTokens: 900, outputTokens: 5, cacheReadTokens: 100 }),
  ]))
  const messages = [
    createSystemMessage('prompt'),
    createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
  ]
  const call = (): GenerateOptions => ({ provider: 'test-provider', model: 'test-model', messages, sessionId: SESSION })

  await drain(context.llm.stream(call()))
  await drain(context.llm.stream(call()))

  expect(reports.map(report => report.divergence.kind)).toEqual(['first-request', 'none'])
  expect(reports[1]).toMatchObject({
    sessionId: SESSION,
    cause: 'none(+0)',
    headReused: true,
    reusedMessages: 1,
    hitRate: 0.1,
    unexpectedMiss: true,
  })
})
