/**
 * Synthetic-log coverage for the cache report: one case per attribution
 * bucket, plus the residual, cross-session head reuse, counters the route does
 * not report, the command-line surface, and empty stores.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  EpochHeader,
  RequestHeaderReason,
  SessionEvent,
  SessionHeader,
  SurfaceIntent,
} from '@deepseek-ai/dsh-session'
// Side-effect type imports: the `compaction/*` and `image/offload` SessionEventMap merges.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-compaction-image-offload'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  parseOptions,
  renderText,
  runCacheReport,
  type CacheReport,
  type CacheReportOptions,
} from './cache-report.ts'

const OWNED_ROOTS = new Set<string>()

afterEach(async () => {
  await Promise.all([...OWNED_ROOTS].map(root => rm(root, { recursive: true, force: true })))
  OWNED_ROOTS.clear()
})

/** One header shared by the synthetic logs. */
function header(overrides: Partial<EpochHeader['config']> = {}, tools?: EpochHeader['tools']): EpochHeader {
  return {
    config: { provider: 'mock', model: 'mock', ...overrides },
    ...tools === undefined ? {} : { tools },
  }
}

/** One tool declaration. */
function tool(name: string): NonNullable<EpochHeader['tools']>[number] {
  return { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } }
}

/** Usage with the provider's cache counters. */
function usage(inputTokens: number, cacheReadTokens: number | undefined): TokenUsage {
  return cacheReadTokens === undefined
    ? { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 }
    : { inputTokens, outputTokens: 10, totalTokens: inputTokens + cacheReadTokens + 10, cacheReadTokens }
}

/** Append-only event log builder: assigns contiguous seqs, times, turns, and steps. */
class Log {
  private readonly events: SessionEvent[] = []
  private seq = 0
  private time = Date.parse('2026-11-20T10:00:00.000Z')
  private turn = 0
  private step = 0
  private nextTurn = 1
  private nextStep = 1

  /** The events built so far. */
  get built(): readonly SessionEvent[] {
    return this.events
  }

  /** The next event's envelope. */
  private next(): { seq: SessionSeq; time: number } {
    const seq = SessionSeq(this.seq)
    this.seq += 1
    const time = this.time
    this.time += 1000
    return { seq, time }
  }

  /** Keep one built event. */
  private keep(event: SessionEvent): SessionEvent {
    this.events.push(event)
    return event
  }

  /** Open the next turn. */
  beginTurn(): SessionEvent {
    const event = { type: 'turn/start', ...this.next(), data: { turn: this.nextTurn } } satisfies SessionEvent
    this.turn = this.nextTurn
    this.nextTurn += 1
    this.nextStep = 1
    return this.keep(event)
  }

  /** Close the open turn. */
  endTurn(): SessionEvent {
    const event = { type: 'turn/end', ...this.next(), data: { turn: this.turn, reason: { kind: 'completed' } } } satisfies SessionEvent
    this.turn = 0
    return this.keep(event)
  }

  /** Open the next step of the open turn. */
  beginStep(): SessionEvent {
    const event = { type: 'step/start', ...this.next(), data: { turn: this.turn, step: this.nextStep } } satisfies SessionEvent
    this.step = this.nextStep
    this.nextStep += 1
    return this.keep(event)
  }

  /** Close the open step. */
  endStep(): SessionEvent {
    const event = { type: 'step/end', ...this.next(), data: { turn: this.turn, step: this.step } } satisfies SessionEvent
    this.step = 0
    return this.keep(event)
  }

  /** Append a `request/header` snapshot inside the open turn. */
  header(value: EpochHeader, reason: RequestHeaderReason = 'change'): SessionEvent {
    return this.keep({ type: 'request/header', ...this.next(), data: { header: value, reason } } satisfies SessionEvent)
  }

  /** Append a system prompt node inside the open step. */
  system(text: string, opts?: SurfaceIntent<'system/message'>): SessionEvent {
    return this.keep({
      type: 'system/message',
      ...this.next(),
      data: { turn: this.turn, step: this.step, message: createSystemMessage(text) },
      ...opts === undefined ? { surfaceOp: 'append' as const } : opts,
    } satisfies SessionEvent)
  }

  /** Append a user prompt. */
  user(text: string, opts?: SurfaceIntent<'user/message'>): SessionEvent {
    return this.keep({
      type: 'user/message',
      ...this.next(),
      data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      ...opts === undefined ? { surfaceOp: 'append' as const } : opts,
    } satisfies SessionEvent)
  }

  /** Append an image-bearing user prompt. */
  image(text: string): SessionEvent {
    return this.keep({
      type: 'user/message',
      ...this.next(),
      data: createUserMessage({
        content: [
          { type: 'text', text },
          {
            type: 'image',
            attachment: {
              attachmentId: brandString<AttachmentId>('attachment-1'),
              mediaType: 'image/png',
              bytes: 128,
              width: 16,
              height: 16,
            },
          },
        ],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    } satisfies SessionEvent)
  }

  /** Append a developer tool-change message inside the open step. */
  developer(block: { type: 'tool-addition' | 'tool-removal'; toolName: string }, headerSeq?: SessionSeq): SessionEvent {
    return this.keep({
      type: 'developer/message',
      ...this.next(),
      data: {
        turn: this.turn,
        step: this.step,
        message: createDeveloperMessage({ content: [block], source: { kind: 'user' } }),
        ...headerSeq === undefined ? {} : { headerSeq },
      },
      surfaceOp: 'append',
    } satisfies SessionEvent)
  }

  /** Append a model call with its reported usage inside the open step. */
  assistant(value: TokenUsage, text = 'answer'): SessionEvent {
    return this.keep({
      type: 'assistant/message',
      ...this.next(),
      data: {
        turn: this.turn,
        step: this.step,
        message: createAssistantMessage({
          content: [{ type: 'text', text }],
          source: { provider: 'mock', model: 'mock' },
        }),
        stream: [],
        usage: value,
      },
      surfaceOp: 'append',
    } satisfies SessionEvent)
  }

  /** Append the shadow price of a model-free prune replacement. */
  prune(range: { start: SessionSeq; end: SessionSeq }, shadowedSeqs: readonly SessionSeq[]): SessionEvent {
    return this.keep({
      type: 'compaction/prune',
      ...this.next(),
      data: {
        shadowedRange: range,
        shadowedSeqs: [...shadowedSeqs],
        shadowedTokenCount: 40,
      },
    } satisfies SessionEvent)
  }

  /** Append a replacement user message shadowing an earlier surface range. */
  summary(text: string, range: { start: SessionSeq; end: SessionSeq }, shadowedSeqs: readonly SessionSeq[]): SessionEvent {
    return this.keep({
      type: 'user/message',
      ...this.next(),
      data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      surfaceOp: { op: 'replace' as const, startSeq: range.start, endSeq: range.end },
      sourceEventSeqs: [...shadowedSeqs],
    } satisfies SessionEvent)
  }

  /** Append an image offload decision for one image occurrence. */
  offload(targetSeq: SessionSeq): SessionEvent {
    return this.keep({
      type: 'image/offload',
      ...this.next(),
      data: { targets: [{ seq: targetSeq, imageIndexes: [0] }] },
    } satisfies SessionEvent)
  }
}

/** A fresh temporary session-store root. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cache-report-'))
  OWNED_ROOTS.add(root)
  return root
}

/** The stored header for one synthetic Session. */
function sessionHeader(id: string, createdAt: number, origin?: 'subagent'): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: brandString<SessionHeader['id']>(id),
    createdAt,
    isSeeded: false,
    cwd: '/workspace/demo',
    ...origin === undefined ? {} : { origin },
  }
}

/** Persist one synthetic Session under a root. */
async function writeSession(root: string, id: string, events: readonly SessionEvent[], createdAt = 1_000, origin?: 'subagent'): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root })
    const handle = await ctx.sessionPersistence.create(sessionHeader(id, createdAt, origin))
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Run the report over one root with test defaults. */
function report(root: string, overrides: Partial<CacheReportOptions> = {}): Promise<CacheReport> {
  return runCacheReport({
    root,
    rapidWindowMs: 30 * 60_000,
    residualRatio: 0.15,
    includeText: false,
    includeSteps: true,
    origin: 'all',
    ...overrides,
  })
}

/** The single rapid step of a two-call Session. */
function rapidStep(value: CacheReport): CacheReport['steps'] extends readonly (infer Row)[] | undefined ? Row : never {
  const [step] = value.steps ?? []
  expect(value.skippedSessions).toBe(0)
  expect(value.steps).toHaveLength(1)
  if (step === undefined) throw new Error('the report has no rapid step')
  return step
}

/** Open a turn with a header, a system prompt, and the first prompt. */
function opened(log: Log, value: EpochHeader = header()): SessionEvent {
  log.beginTurn()
  log.header(value, 'initial')
  log.beginStep()
  log.system('stable base')
  log.endStep()
  return log.user('go')
}

/** One turn whose second request redeclares the tool set. */
function toolChange(log: Log, value: TokenUsage = usage(12, 60)): void {
  opened(log, header({}, [tool('echo')]))
  call(log, usage(40, 0))
  log.header(header({}, [tool('echo'), tool('read')]), 'change')
  log.user('again')
  call(log, value)
  log.endTurn()
}

/** One turn with a first call, a second prompt, and a second call. */
function twoCalls(log: Log, value: EpochHeader = header()): void {
  opened(log, value)
  call(log, usage(40, 0))
  log.user('again')
  call(log, usage(12, 60))
  log.endTurn()
}

/** Record one model call as its own step. */
function call(log: Log, value: TokenUsage): SessionEvent {
  log.beginStep()
  const event = log.assistant(value)
  log.endStep()
  return event
}

describe('cache report attribution', () => {
  it('classifies a step that only appends to the previous request as append-only', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    twoCalls(log)
    await writeSession(root, 'append-only', log.built)

    const value = await report(root)
    const step = rapidStep(value)
    expect(step.bucket).toBe('append-only')
    expect(step.unexpectedMissTokens).toBe(0)
    expect(value.calibration.samples).toBe(1)
    expect(value.calibration.slope).toBeGreaterThan(0)
  })

  it('classifies a changed call configuration as header-change', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    opened(log)
    call(log, usage(40, 0))
    log.header(header({ reasoningEffort: brandString<ReasoningEffortId>('max') }), 'resume')
    log.user('again')
    call(log, usage(12, 60))
    log.endTurn()
    await writeSession(root, 'header-change', log.built)

    const step = rapidStep(await report(root))
    expect(step.bucket).toBe('header-change')
    expect(step.divergence).toBe('call configuration changed')
  })

  it('classifies changed tool declarations as header-change and counts them', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    toolChange(log)
    await writeSession(root, 'tool-change', log.built)

    const value = await report(root)
    const step = rapidStep(value)
    expect(step.bucket).toBe('header-change')
    expect(step.toolsDiffer).toBe(true)
    expect(value.headerChange.toolsDifferCalls).toBe(1)
    expect(value.headerChange.medianToolCount).toBe(2)
  })

  it('classifies an appended system node as prompt-change', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    opened(log)
    call(log, usage(40, 0))
    log.beginStep()
    log.system('an added in-history instruction')
    log.endStep()
    log.user('again')
    call(log, usage(12, 60))
    log.endTurn()
    await writeSession(root, 'prompt-change', log.built)

    const step = rapidStep(await report(root))
    expect(step.bucket).toBe('prompt-change')
  })

  it('classifies an appended developer tool change as tool-update', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    opened(log, header({}, [tool('echo')]))
    call(log, usage(40, 0))
    log.beginStep()
    log.developer({ type: 'tool-removal', toolName: 'echo' })
    log.endStep()
    log.user('again')
    call(log, usage(12, 60))
    log.endTurn()
    await writeSession(root, 'tool-update', log.built)

    const step = rapidStep(await report(root))
    expect(step.bucket).toBe('tool-update')
  })

  it('classifies a hand-built compaction reset as surface-replacement, not unexplained', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    const first = opened(log)
    const answer = call(log, usage(40, 0))
    const range = { start: first.seq, end: answer.seq }
    log.prune(range, [first.seq, answer.seq])
    log.summary('compacted summary of the turn', range, [first.seq, answer.seq])
    log.user('continue')
    call(log, usage(30, 20))
    log.endTurn()
    await writeSession(root, 'compaction', log.built)

    const value = await report(root)
    const step = rapidStep(value)
    expect(step.bucket).toBe('surface-replacement')
    expect(step.priorBucket).toBeUndefined()
    expect(value.byBucket.unexplained.calls).toBe(0)
  })

  it('classifies an image offload decision as image-projection', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    log.beginTurn()
    log.header(header(), 'initial')
    log.beginStep()
    log.system('stable base')
    log.endStep()
    const prompt = log.image('look at this')
    call(log, usage(40, 0))
    log.offload(prompt.seq)
    log.user('again')
    call(log, usage(12, 60))
    log.endTurn()
    await writeSession(root, 'image', log.built)

    const step = rapidStep(await report(root))
    expect(step.bucket).toBe('image-projection')
    expect(step.firstDivergentMessage).toBe(1)
  })

  it('classifies an identical prefix whose miss far exceeds the estimate as unexplained', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    log.beginTurn()
    log.header(header(), 'initial')
    log.beginStep()
    log.system('stable base '.repeat(300))
    log.endStep()
    log.user('go')
    call(log, usage(40, 0))
    log.user('tiny')
    call(log, usage(6000, 0))
    log.endTurn()
    await writeSession(root, 'residual', log.built)

    const value = await report(root)
    const step = rapidStep(value)
    expect(step.bucket).toBe('unexplained')
    expect(step.priorBucket).toBe('append-only')
    expect(value.unexplained.largeCalls).toBe(1)
  })

  it('classifies a provider or model change as route-change', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    opened(log)
    call(log, usage(40, 0))
    log.header(header({ model: 'other' }), 'change')
    log.user('again')
    call(log, usage(12, 60))
    log.endTurn()
    await writeSession(root, 'route', log.built)

    const step = rapidStep(await report(root))
    expect(step.bucket).toBe('route-change')
  })

  it('reports calls without cache counters as unknown and infers their miss', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    opened(log)
    call(log, usage(40, 0))
    log.user('again')
    call(log, usage(5000, undefined))
    log.endTurn()
    await writeSession(root, 'unknown-counters', log.built)

    const value = await report(root)
    const step = rapidStep(value)
    expect(step.cacheReadTokens).toBeUndefined()
    expect(step.unexpectedMissTokens).toBe(0)
    expect(value.rapid.unknownCounterCalls).toBe(1)
    expect(value.rapid.inferredMissTokens).toBeGreaterThan(0)
  })

  it('keeps a Session head out of the rapid series and counts its gap as cold', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    twoCalls(log)
    await writeSession(root, 'cold', log.built)

    const value = await report(root, { rapidWindowMs: 0 })
    expect(value.rapid.calls).toBe(0)
    expect(value.cold.calls).toBe(2)
  })

  it('compares the first call of a new Session with its predecessor on the same route', async () => {
    const root = await temporaryRoot()
    const first = new Log()
    opened(first)
    call(first, usage(40, 0))
    first.endTurn()
    await writeSession(root, 'head-a', first.built, 1_000)

    const second = new Log()
    opened(second)
    call(second, usage(30, 0))
    second.endTurn()
    await writeSession(root, 'head-b', second.built, 2_000)

    const value = await report(root)
    expect(value.headReuse.compared).toBe(1)
    expect(value.headReuse.identicalHeads).toBe(1)
    expect(value.headReuse.identicalUncached).toBe(1)
    expect(value.headReuse.identicalEstimatedTokens).toBeGreaterThan(0)
  })

  it('filters by project, origin, and creation time', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    twoCalls(log)
    await writeSession(root, 'filters', log.built, 5_000, 'subagent')

    expect((await report(root)).sessions).toBe(1)
    expect((await report(root, { project: 'no-such-project' })).sessions).toBe(0)
    expect((await report(root, { origin: 'user' })).sessions).toBe(0)
    expect((await report(root, { origin: 'subagent' })).sessions).toBe(1)
    expect((await report(root, { since: 6_000 })).sessions).toBe(0)
    expect((await report(root, { since: 4_000 })).sessions).toBe(1)
  })

  it('handles an empty root without sessions', async () => {
    const root = await temporaryRoot()
    const value = await report(root)
    expect(value.sessions).toBe(0)
    expect(value.all.calls).toBe(0)
    expect(renderText(value)).toContain('Prompt-cache report for')
  })

  it('quotes the first divergent bytes only when examples are requested', async () => {
    const root = await temporaryRoot()
    const log = new Log()
    toolChange(log, usage(5000, 0))
    await writeSession(root, 'examples', log.built)

    const withoutText = await report(root)
    expect(withoutText.examples[0]?.snippet).toBeUndefined()
    const withText = await report(root, { includeText: true })
    expect(withText.examples[0]?.snippet?.current).toContain('read')
    expect(renderText(withText)).toContain('first difference at offset')
  })
})

describe('cache report command line', () => {
  it('resolves documented defaults', () => {
    const parsed = parseOptions([])
    expect(parsed.json).toBe(false)
    expect(parsed.help).toBe(false)
    expect(parsed.options.rapidWindowMs).toBe(30 * 60_000)
    expect(parsed.options.residualRatio).toBe(0.15)
    expect(parsed.options.includeText).toBe(false)
    expect(parsed.options.includeSteps).toBe(false)
    expect(parsed.options.origin).toBe('all')
    expect(parsed.options.root.endsWith('sessions')).toBe(true)
  })

  it('parses spans, dates, and report switches', () => {
    const parsed = parseOptions([
      '--root', '/tmp/example',
      '--project', 'demo',
      '--since', '2026-11-15',
      '--rapid-window', '2h',
      '--residual-ratio', '0.5',
      '--origin', 'subagent',
      '--show-examples',
      '--steps',
      '--json',
    ])
    expect(parsed.options.root).toBe('/tmp/example')
    expect(parsed.options.project).toBe('demo')
    expect(parsed.options.since).toBe(Date.parse('2026-11-15'))
    expect(parsed.options.rapidWindowMs).toBe(2 * 60 * 60_000)
    expect(parsed.options.residualRatio).toBe(0.5)
    expect(parsed.options.origin).toBe('subagent')
    expect(parsed.options.includeText).toBe(true)
    expect(parsed.options.includeSteps).toBe(true)
    expect(parsed.json).toBe(true)
  })

  it('takes a project slug that begins with a dash literally', () => {
    expect(parseOptions(['--project', '--var-src-deepseek-harness--']).options.project)
      .toBe('--var-src-deepseek-harness--')
    expect(parseOptions(['--project=--var-src-deepseek-harness--']).options.project)
      .toBe('--var-src-deepseek-harness--')
    expect(parseOptions(['--project', 'demo', '--json']).options.project).toBe('demo')
    expect(() => parseOptions(['--project'])).toThrow(/requires a value/)
  })

  it('rejects malformed arguments', () => {
    expect(() => parseOptions(['--rapid-window', 'soon'])).toThrow(/invalid duration/)
    expect(() => parseOptions(['--origin', 'robot'])).toThrow(/invalid --origin/)
    expect(() => parseOptions(['--since', 'not-a-date'])).toThrow(/invalid --since/)
    expect(() => parseOptions(['--residual-ratio=-1'])).toThrow(/invalid --residual-ratio/)
    expect(() => parseOptions(['--unknown'])).toThrow()
  })
})
