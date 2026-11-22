/** Host plugin: attribute each model call's cache miss to the request component that caused it. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  cacheHitRate,
  comparePrefix,
  requestShape,
  unexpectedMiss,
  type PrefixComparison,
  type PrefixDivergence,
  type PrefixShape,
} from './shape.ts'

export const name = 'prefix-diagnostics'
export const inject = ['llm']

/** A request whose purpose is any producer-declared label; this plugin never narrows it. */
type RequestOptions = GenerateOptions<string>

/** Console tag of miss diagnostics; product profiles mount no console exporter for `ctx.logger`. */
const LOG_TAG = '[llm-prefix-diagnostics]'

/** One model call's cache attribution. */
export interface PrefixDiagnostic {
  /** Session whose request series this call belongs to. */
  readonly sessionId: string
  /** Cache-relevant prefix of this call's request. */
  readonly request: PrefixShape
  /** Which request component first broke the preceding prefix in this series. */
  readonly divergence: PrefixDivergence
  /** One-line label of that component, for logs and telemetry. */
  readonly cause: string
  /** The leading system prompt and tool schemas were unchanged. */
  readonly headReused: boolean
  /** Count of leading messages whose bytes are unchanged. */
  readonly reusedMessages: number
  /** Provider-reported accounting for this call. */
  readonly usage: TokenUsage
  /** Cached share of this call's input, or undefined when the provider reports no cache counters. */
  readonly hitRate?: number
  /** The unchanged prefix should have been cached but the provider billed it uncached. */
  readonly unexpectedMiss: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One model call's cache attribution, emitted after its usage arrives. Live
     * only: nothing reaches the Session log.
     * @param report - the call's prefix comparison and provider accounting
     * @mode emit
     */
    'llm/prefix-diagnostics'(report: PrefixDiagnostic): void
  }
}

/** Loader configuration: every field falls back to its documented default. */
export interface Config {
  /** Report an unexpected miss when the cache covered less than this share of the call's input (default 0.5). */
  readonly minHitRate?: number
  /** Maximum Session request series whose preceding prefix stays in memory (default 256). */
  readonly maxSeries?: number
}

/** Loader schema for the miss-reporting choices. */
export const Config: z<Config> = z.object({
  minHitRate: z.number().min(0).max(1),
  maxSeries: z.number().step(1).min(1),
})

/** Cached share below which a predicted-reusable prefix counts as missed. */
const DEFAULT_MIN_HIT_RATE = 0.5

/** Request series retained in memory before the least recently used is dropped. */
const DEFAULT_MAX_SERIES = 256

/** Validated immutable reporting policy. */
interface ResolvedConfig {
  readonly minHitRate: number
  readonly maxSeries: number
}

/**
 * Apply the documented defaults to one loader configuration.
 * @param config - untrusted plugin configuration.
 * @returns the reporting policy this instance runs with.
 */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    minHitRate: config.minHitRate ?? DEFAULT_MIN_HIT_RATE,
    maxSeries: config.maxSeries ?? DEFAULT_MAX_SERIES,
  }
}

/** Request series identity: one Session and purpose pair shares a cacheable prefix. */
function seriesKey(options: RequestOptions): string {
  return `${String(options.sessionId)}\u0000${options.purpose ?? ''}`
}

/** One unexpected miss, in the fields the diagnostic line reports. */
interface MissLine {
  readonly provider: string
  readonly model: string
  readonly sessionId: string
  readonly purpose?: string
  readonly cause: string
  readonly reusedMessages: number
  readonly cached: number
  readonly written: number
  readonly uncached: number
}

/** One-line account of an unexpected miss, for the process's diagnostic output. */
function describe(miss: MissLine): string {
  const input = miss.cached + miss.written + miss.uncached
  return [
    'unexpected cache miss:',
    `${miss.provider}/${miss.model}`,
    `session=${miss.sessionId}`,
    ...miss.purpose === undefined ? [] : [`purpose=${miss.purpose}`],
    `cause=${miss.cause}`,
    `reused=${miss.reusedMessages}`,
    `hit=${(miss.cached / input * 100).toFixed(2)}%`,
    `cacheRead=${miss.cached}`,
    `cacheWrite=${miss.written}`,
    `uncached=${miss.uncached}`,
  ].join(' ')
}

/** Name the component that broke the prefix. */
function cause(divergence: PrefixDivergence): string {
  switch (divergence.kind) {
    case 'first-request': return 'first-request'
    case 'route': return `route(${divergence.previousProvider}/${divergence.previousModel})`
    case 'system': return 'system'
    case 'tools': return 'tools'
    case 'message': return `message[${divergence.index}](${divergence.role})`
    case 'shortened': return `shortened[${divergence.index}]`
    case 'none': return `none(+${divergence.appended})`
    /* v8 ignore next 2 -- the divergence union is closed in this package */
    default: return assertNever(divergence, 'prefix divergence')
  }
}

/** Compare one call with its predecessor and build the report. */
function diagnose(
  options: RequestOptions, previous: PrefixShape | undefined, shape: PrefixShape, usage: TokenUsage, minHitRate: number,
): PrefixDiagnostic {
  const comparison: PrefixComparison = previous === undefined
    ? { divergence: { kind: 'first-request' }, headReused: false, reusedMessages: 0 }
    : comparePrefix(previous, shape)
  const hitRate = cacheHitRate(usage)
  return {
    sessionId: String(options.sessionId),
    request: shape,
    divergence: comparison.divergence,
    cause: cause(comparison.divergence),
    headReused: comparison.headReused,
    reusedMessages: comparison.reusedMessages,
    usage,
    ...hitRate === undefined ? {} : { hitRate },
    unexpectedMiss: unexpectedMiss(comparison, usage, minHitRate),
  }
}

/** Yield one call's chunks unchanged, then report its attribution. */
async function* observe(
  ctx: Context,
  options: RequestOptions,
  previous: PrefixShape | undefined,
  shape: PrefixShape,
  minHitRate: number,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  let usage: TokenUsage | undefined
  for await (const chunk of next()) {
    if (chunk.type === 'usage') usage = chunk.usage
    yield chunk
  }
  if (usage === undefined) return
  try {
    const report = diagnose(options, previous, shape, usage, minHitRate)
    ctx.emit('llm/prefix-diagnostics', report)
    const cached = report.usage.cacheReadTokens
    if (cached !== undefined && report.unexpectedMiss) {
      console.error(LOG_TAG, describe({
        provider: report.request.provider,
        model: report.request.model,
        sessionId: report.sessionId,
        ...report.request.purpose === undefined ? {} : { purpose: report.request.purpose },
        cause: report.cause,
        reusedMessages: report.reusedMessages,
        cached,
        written: report.usage.cacheWriteTokens ?? 0,
        uncached: report.usage.inputTokens,
      }))
    }
  } catch (error) {
    // A diagnostic failure must never fail the model call it observes.
    console.error(LOG_TAG, 'could not report one call:', error)
  }
}

/**
 * Mount the attribution plugin: every Session-scoped model call is compared with
 * the preceding call of the same purpose, and its usage is reported as a live
 * event. Calls without a Session identity are passed through untracked.
 * @param ctx - plugin context; the `llm` service must be present.
 * @param config - validated miss-reporting choices.
 */
export function apply(ctx: Context, config: Config): void {
  const { minHitRate, maxSeries } = resolveConfig(config)
  const series = new Map<string, PrefixShape>()
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined) return next()
    const key = seriesKey(options)
    const previous = series.get(key)
    const shape = requestShape(options)
    series.delete(key)
    series.set(key, shape)
    let excess = series.size - maxSeries
    if (excess > 0) {
      for (const key of series.keys()) {
        if (excess-- <= 0) break
        series.delete(key)
      }
    }
    return observe(ctx, options, previous, shape, minHitRate, next)
  })
}
