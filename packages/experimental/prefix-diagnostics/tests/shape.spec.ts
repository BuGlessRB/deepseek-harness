/** Prefix hashing and miss attribution without a running harness. */
import { expect, it } from 'vitest'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { cacheHitRate, comparePrefix, requestShape, unexpectedMiss } from '../src/shape.ts'

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

const request = (messages: GenerateOptions['messages'], overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'deepseek-official', model: 'deepseek-flash', messages, ...overrides,
})

it('hashes the leading system prompt separately from the conversation', () => {
  const shape = requestShape(request([createSystemMessage('prompt'), user('first')]))
  expect(shape.messages).toHaveLength(1)
  expect(shape.messages[0]?.role).toBe('user')
  expect(shape.system).not.toBe(requestShape(request([user('first')])).system)
})

it('hashes one-shot system text and keeps every message', () => {
  const withSystem = requestShape(request([user('first')], { system: 'prompt' }))
  const withoutSystem = requestShape(request([user('first')]))
  expect(withSystem.messages).toHaveLength(1)
  expect(withSystem.system).not.toBe(withoutSystem.system)
})

it('ignores host metadata that never reaches the wire', () => {
  const first = requestShape(request([user('same')]))
  const second = requestShape(request([user('same')]))
  expect(first.messages[0]?.hash).toBe(second.messages[0]?.hash)
  expect(requestShape(request([user('same')])).messages[0]?.hash)
    .not.toBe(requestShape(request([user('other')])).messages[0]?.hash)
})

it('includes the call id and error flag of a tool result in its identity', () => {
  const result = (callId: string, isError = false) => createToolResultMessage({
    callId: brandString<Branded<'ToolCallId'>>(callId), content: [{ type: 'text', text: 'ok' }], isError,
  })
  const hash = (message: ReturnType<typeof createToolResultMessage>) => requestShape(request([message])).messages[0]?.hash
  expect(hash(result('call-1'))).not.toBe(hash(result('call-2')))
  expect(hash(result('call-1'))).not.toBe(hash(result('call-1', true)))
})

it('reports an appended tail as an unchanged prefix', () => {
  const previous = requestShape(request([createSystemMessage('prompt'), user('first')]))
  const current = requestShape(request([createSystemMessage('prompt'), user('first'), user('second')]))
  expect(comparePrefix(previous, current)).toEqual({
    divergence: { kind: 'none', appended: 1 }, headReused: true, reusedMessages: 1,
  })
})

it.each([
  ['system', request([createSystemMessage('other'), user('first')])],
  ['tools', request([createSystemMessage('prompt'), user('first')], { tools: [{ name: 'search', description: 'Search', parameters: {} }] })],
  ['route', request([createSystemMessage('prompt'), user('first')], { model: 'deepseek-v4-pro' })],
] as const)('attributes a broken %s head', (kind, changed) => {
  const previous = requestShape(request([createSystemMessage('prompt'), user('first')]))
  const comparison = comparePrefix(previous, requestShape(changed))
  expect(comparison.divergence.kind).toBe(kind)
  expect(comparison.headReused).toBe(false)
  expect(comparison.reusedMessages).toBe(0)
})

it('attributes a changed message and keeps the messages before it reusable', () => {
  const previous = requestShape(request([createSystemMessage('prompt'), user('first'), user('second')]))
  const current = requestShape(request([createSystemMessage('prompt'), user('first'), user('changed')]))
  expect(comparePrefix(previous, current)).toEqual({
    divergence: { kind: 'message', index: 1, role: 'user' }, headReused: true, reusedMessages: 1,
  })
})

it('attributes a shorter request to the first dropped message', () => {
  const previous = requestShape(request([createSystemMessage('prompt'), user('first'), user('second')]))
  const current = requestShape(request([createSystemMessage('prompt'), user('first')]))
  expect(comparePrefix(previous, current)).toEqual({
    divergence: { kind: 'shortened', index: 1 }, headReused: true, reusedMessages: 1,
  })
})

it('reads the cached share of input and refuses to guess without cache counters', () => {
  expect(cacheHitRate({ inputTokens: 10, outputTokens: 1 })).toBeUndefined()
  expect(cacheHitRate({ inputTokens: 0, outputTokens: 1 })).toBeUndefined()
  expect(cacheHitRate({ inputTokens: 0, outputTokens: 1, cacheReadTokens: 0 })).toBeUndefined()
  expect(cacheHitRate({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 })).toBe(0)
  expect(cacheHitRate({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 10 })).toBe(0.6)
})

it('calls a miss unexpected only when an unchanged prefix should have been cached', () => {
  const reusable = { divergence: { kind: 'none', appended: 1 }, headReused: true, reusedMessages: 4 } as const
  const miss: TokenUsage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 0 }
  expect(unexpectedMiss(reusable, miss, 0.5)).toBe(true)
  expect(unexpectedMiss(reusable, { ...miss, cacheReadTokens: 5_000 }, 0.5)).toBe(false)
  expect(unexpectedMiss({ ...reusable, reusedMessages: 0 }, miss, 0.5)).toBe(false)
  expect(unexpectedMiss({ ...reusable, headReused: false }, miss, 0.5)).toBe(false)
  expect(unexpectedMiss(reusable, { inputTokens: 5_000, outputTokens: 5 }, 0.5)).toBe(false)
})
