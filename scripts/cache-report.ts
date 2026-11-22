/**
 * Report prompt-cache reuse and unexpected cache misses across stored Sessions.
 *
 * A provider reports, per model call, the prompt tokens served from its prefix
 * cache (`cacheReadTokens`) and those billed uncached (`inputTokens`). The raw
 * ratio is not the metric: every step legitimately appends new messages (tool
 * results, the next user message) and those are uncached by construction. This
 * report measures the loss instead. For each call it reconstructs the request
 * from the Session log, takes the longest prefix byte-identical to the previous
 * request of the same Session, prices the rest with the token-meter heuristic,
 * and attributes the miss:
 *
 * ```
 * expectedUncached     = estimatedTotal - commonPrefix
 * unexpectedMissTokens = max(0, reportedInputTokens - expectedUncached)
 * prefixReuseRate      = commonPrefix / estimatedTotal
 * ```
 *
 * The first divergence between two consecutive requests names the cause:
 * `route-change`, `header-change` (config, adapter defaults, tool declarations),
 * `surface-replacement` (a logged replacement shadowed nodes), `prompt-change`
 * (a system node was appended or rewritten), `image-projection` (an image
 * offload decision), `tool-update` (a developer tool addition/removal), or
 * `append-only`. A step whose logged cause is expected but whose reported input
 * still exceeds the estimate by more than the residual tolerance is
 * reclassified `unexplained`: the residual no log evidence accounts for.
 *
 * Read-only and keyless. Aggregates by default; message text appears only
 * behind `--show-examples`.
 *
 * An `unexplained` miss is the residual the log cannot attribute: the prefix was
 * byte-identical and the provider still billed it uncached. `--attribute-providers`
 * describes such a miss, its preceding call, and its following call through the
 * gateway's generation endpoint, using the response id the log already records,
 * and states whether the miss landed on a provider its neighbours did not use. A
 * different provider means request routing moved the call; the same provider
 * means the endpoint dropped a prefix it had already cached. Only that flag
 * reaches the network, and it needs an API key for the endpoint.
 *
 * @module scripts/cache-report
 */

import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import {
  canonicalHeader,
  deriveEventMessage,
  foldSurface,
  isReplacementSurfaceEvent,
  isSurfaceEvent,
} from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent, SessionHeader, SessionSeq } from '@deepseek-ai/dsh-session'
import type { AssistantMessage, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'

/** One minute in milliseconds. */
const MINUTE_MS = 60_000

/** Default gap under which two calls of a Session count as one rapid series. */
const DEFAULT_RAPID_WINDOW_MS = 30 * MINUTE_MS

/** Absolute slack under which a miss stays inside the estimator's own error. */
const RESIDUAL_FLOOR_TOKENS = 256

/** Relative slack over the estimated appended suffix, on top of {@link RESIDUAL_FLOOR_TOKENS}. */
const DEFAULT_RESIDUAL_RATIO = 0.15

/**
 * Share of the shared prefix a miss must also exceed to count as a real
 * prefix break. A break re-bills everything after the divergent byte, so it
 * costs a large fraction of the prefix; estimator noise costs a few hundred
 * tokens whatever the prefix size.
 */
const PREFIX_BREAK_SHARE = 0.05

/** Characters of divergent text quoted on each side of the first difference. */
const EXAMPLE_CHARS = 160

/** Characters quoted before the first difference, for context. */
const EXAMPLE_LEAD_CHARS = 40

/** Gateway endpoint that describes one generation by the id the log records. */
const DEFAULT_GENERATION_ENDPOINT = 'https://openrouter.ai/api/v1/generation'

/** Environment variable holding the key for {@link DEFAULT_GENERATION_ENDPOINT}. */
const DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY'

/** Deadline for one generation lookup, after which the call counts unresolved. */
const LOOKUP_TIMEOUT_MS = 10_000

/** How many causes the text report names with a reproducible pointer. */
const TOP_CAUSE_COUNT = 3

/** Residual above which a call is quoted as a concentrated loss rather than noise. */
const LARGE_MISS_TOKENS = 5000

/** Skipped Sessions whose reason the report names before it summarizes the rest. */
const SKIPPED_REASON_LIMIT = 10

/**
 * Attribution bucket of one model call.
 *
 * `cold-start`, `append-only`, `surface-replacement`, and `route-change` are
 * expected: no request-building change can avoid them. The rest are candidates;
 * `unexplained` is the residual no log evidence accounts for.
 */
export type CacheBucket =
  | 'cold-start'
  | 'append-only'
  | 'header-change'
  | 'prompt-change'
  | 'tool-update'
  | 'surface-replacement'
  | 'image-projection'
  | 'route-change'
  | 'unexplained'

/** Buckets whose miss the request builder cannot avoid. */
const EXPECTED_BUCKETS: ReadonlySet<CacheBucket> = new Set<CacheBucket>([
  'cold-start',
  'append-only',
  'surface-replacement',
  'route-change',
])

/** Every bucket, in report order. */
const BUCKETS: readonly CacheBucket[] = [
  'cold-start',
  'append-only',
  'surface-replacement',
  'route-change',
  'header-change',
  'prompt-change',
  'tool-update',
  'image-projection',
  'unexplained',
]

/** Replay projections a request reconstruction needs: image offload marks. */
const PROJECTIONS = [imageOffloadProjection]

/** Token and call totals over one set of model calls. */
export interface CacheTotals {
  /** Model calls in the set. */
  calls: number
  /** Prompt tokens billed, cached and uncached. */
  promptTokens: number
  /** Prompt tokens served from the provider prefix cache. */
  cacheReadTokens: number
  /** Prompt tokens billed uncached. */
  inputTokens: number
  /** Miss above the estimated appended suffix. */
  unexpectedMissTokens: number
  /** Estimated appended suffix. */
  expectedUncachedTokens: number
  /** Estimated prompt tokens of the request. */
  estimatedTotalTokens: number
  /** Estimated tokens of the prefix shared with the previous request. */
  commonPrefixTokens: number
  /** Calls whose route reported no cache counters; excluded from the miss figures. */
  unknownCounterCalls: number
  /**
   * Miss inferred for calls without cache counters: their billed input minus
   * the estimated appended suffix. A route that reports nothing about caching
   * yields an inference here, never a reported `0`.
   */
  inferredMissTokens: number
}

/** Quoted bytes on each side of the first difference between two requests. */
export interface DivergenceSnippet {
  /** Character offset of the first difference. */
  readonly offset: number
  /** Quoted bytes of the previous request. */
  readonly previous: string
  /** Quoted bytes of this request. */
  readonly current: string
}

/** One call's attribution. */
interface StepRecord {
  readonly bucket: CacheBucket
  /** Mechanism inside the bucket, for the text and JSON reports. */
  readonly divergence: string
  /** Bucket the logged cause named before the residual escalation. */
  readonly priorBucket?: CacheBucket
  /** Milliseconds since the previous call of the Session; infinite for its head. */
  readonly gapMs: number
  readonly totals: CacheTotals
  /** Index of the first message that differs from the previous request. */
  readonly firstDivergentMessage?: number
  /** First divergent bytes, only when examples were requested. */
  readonly snippet?: DivergenceSnippet
  /** Whether the tool declarations differ from the previous request. */
  readonly toolsDiffer: boolean
  /** Declared tool count of this request. */
  readonly toolCount: number
  /** Provider route of the call, when the Session logged a header. */
  readonly provider?: string
  /** Model id of the call, when the Session logged a header. */
  readonly model?: string
  readonly slug: string
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly step: number
  /** Provider response id recorded for the call, when the log carries one. */
  readonly responseId?: string
}

/** Cross-session head reuse: a new Session's first call against its predecessor's. */
export interface HeadReuseReport {
  /** New Sessions with a predecessor on the same project, origin, preset, and route. */
  readonly compared: number
  /** Sessions whose first request shared the predecessor's config, tools, and system prompt. */
  readonly identicalHeads: number
  /** Identical-head Sessions whose first call reported no cache read at all. */
  readonly identicalUncached: number
  /** Cache-read tokens summed over identical-head first calls. */
  readonly identicalCacheReadTokens: number
  /** Estimated head tokens summed over identical-head first calls. */
  readonly identicalEstimatedTokens: number
}

/** Estimator calibration over `append-only` steps. */
export interface CalibrationReport {
  /** Least-squares slope of reported input on estimated appended tokens, through the origin. */
  readonly slope: number
  /** Steps the slope was fitted on. */
  readonly samples: number
  /** Sum of reported input over those steps. */
  readonly reportedInputTokens: number
  /** Sum of estimated appended tokens over those steps. */
  readonly estimatedAppendedTokens: number
}

/** One reproducible example of a cause. */
export interface CacheExample {
  readonly bucket: CacheBucket
  readonly divergence: string
  readonly slug: string
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly gapMs: number
  readonly estimatedTotalTokens: number
  readonly expectedUncachedTokens: number
  readonly reportedInputTokens: number
  readonly unexpectedMissTokens: number
  readonly firstDivergentMessage?: number
  readonly snippet?: DivergenceSnippet
}

/** One call as the JSON report exposes it, without message text. */
export interface CacheStepRow {
  readonly bucket: CacheBucket
  readonly divergence: string
  readonly priorBucket?: CacheBucket
  readonly slug: string
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly step: number
  /** Provider route of the call, when the Session logged a header. */
  readonly provider?: string
  /** Model id of the call, when the Session logged a header. */
  readonly model?: string
  /** Milliseconds since the previous call; `-1` for a Session head. */
  readonly gapMs: number
  readonly estimatedTotalTokens: number
  readonly expectedUncachedTokens: number
  readonly inputTokens: number
  readonly cacheReadTokens?: number
  readonly unexpectedMissTokens: number
  readonly toolsDiffer: boolean
  readonly toolCount: number
  readonly firstDivergentMessage?: number
}

/** One stored Session the report could not read, and why. */
export interface SkippedSession {
  readonly sessionId: string
  readonly reason: string
}

/** Concentration of the unexplained residual. */
export interface UnexplainedDetail {
  /** Residual calls above {@link LARGE_MISS_TOKENS}. */
  readonly largeCalls: number
  /** Their share of the residual. */
  readonly largeMissTokens: number
}

/** Header-change detail the text report quotes. */
export interface HeaderChangeDetail {
  /** Calls whose tool declarations differ from the previous request. */
  readonly toolsDifferCalls: number
  /** Median declared tool count over those calls. */
  readonly medianToolCount: number
}

/** One unexpected miss described by the provider that served it. */
export interface ProviderMissRow {
  readonly slug: string
  readonly sessionId: string
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly unexpectedMissTokens: number
  /** Provider the gateway reports for the miss itself. */
  readonly provider: string
  /** Provider of the nearest earlier call of the same Session that could be described. */
  readonly previousProvider?: string
  /** Provider of the nearest later call of the same Session that could be described. */
  readonly nextProvider?: string
  /**
   * Whether the miss landed on a provider its neighbours did not use: `true`
   * means routing moved the call, `false` means the endpoint dropped a prefix it
   * had already cached, and absent means no neighbour could be described.
   */
  readonly rerouted?: boolean
}

/** Attribution of the residual misses to the serving provider. */
export interface ProviderAttributionReport {
  /** Calls the endpoint described. */
  readonly resolved: number
  /** Lookups the endpoint could not describe. */
  readonly unresolved: number
  /** First lookup failure, when any lookup failed. */
  readonly failure?: string
  /** Misses whose serving provider is known, largest first. */
  readonly misses: readonly ProviderMissRow[]
  /** Misses that landed on a provider their neighbours did not use. */
  readonly reroutedCalls: number
  /** Their unexpected-miss tokens. */
  readonly reroutedTokens: number
  /** Misses that stayed on the provider that served a neighbour. */
  readonly keptCalls: number
  /** Their unexpected-miss tokens. */
  readonly keptTokens: number
  /** Misses with no describable neighbour, so routing cannot be settled. */
  readonly undecidedCalls: number
}

/** The complete report. */
export interface CacheReport {
  readonly root: string
  readonly generatedAt: string
  readonly rapidWindowMs: number
  readonly residualRatio: number
  /** Sessions read successfully. */
  readonly sessions: number
  /** Stored Sessions skipped because the log could not be read. */
  readonly skippedSessions: number
  /** Up to {@link SKIPPED_REASON_LIMIT} skipped Sessions and the reason each failed. */
  readonly skipped: readonly SkippedSession[]
  /** Stored Sessions skipped because no call reported usage. */
  readonly sessionsWithoutUsage: number
  /** Every call in the read Sessions. */
  readonly all: CacheTotals
  /** Rapid successive calls: not the first of a Session, gap within the window. */
  readonly rapid: CacheTotals
  /** Calls outside the rapid series: Session heads and long gaps. */
  readonly cold: CacheTotals
  /** Rapid calls by attribution bucket. */
  readonly byBucket: Readonly<Record<CacheBucket, CacheTotals>>
  readonly headerChange: HeaderChangeDetail
  /** Concentration of the residual bucket. */
  readonly unexplained: UnexplainedDetail
  readonly headReuse: HeadReuseReport
  readonly calibration: CalibrationReport
  /** The largest-miss example per bucket, without message text. */
  readonly examples: readonly CacheExample[]
  /** Every rapid call, present only when `--steps` asked for them. */
  readonly steps?: readonly CacheStepRow[]
  /** Provider attribution of the residual misses, present only when it was requested. */
  readonly providers?: ProviderAttributionReport
}

/** One generation lookup: the endpoint to ask about a recorded response id. */
export interface GenerationRequest {
  /** Absolute request URL, including the response id. */
  readonly url: string
  /** Bearer token for the endpoint. */
  readonly apiKey: string
}

/**
 * Reads one generation record from the gateway.
 * @param request - the endpoint URL and its credential.
 * @returns the decoded response body, or anything a test stub supplies for
 * {@link generationFacts} to validate.
 */
export type GenerationLookup = (request: GenerationRequest) => Promise<unknown>

/** Resolved provider attribution: where to ask, with what credential, and how. */
export interface ProviderAttribution {
  /** Endpoint describing one generation by its recorded id. */
  readonly endpoint: string
  /** Bearer token for that endpoint. */
  readonly apiKey: string
  /** Transport override; the default performs one HTTPS request per lookup. */
  readonly lookup?: GenerationLookup
}

/** Resolved command-line options. */
export interface CacheReportOptions {
  /** Session store root. */
  readonly root: string
  /** Project slug to restrict the report to. */
  readonly project?: string
  /** Only Sessions created at or after this epoch-millisecond time. */
  readonly since?: number
  /** Gap under which two calls count as one rapid series. */
  readonly rapidWindowMs: number
  /** Relative slack over the estimated appended suffix. */
  readonly residualRatio: number
  /** Quote divergent bytes in examples. */
  readonly includeText: boolean
  /** Include every rapid call in the JSON report. */
  readonly includeSteps: boolean
  /** Origin filter. */
  readonly origin: 'all' | 'user' | 'subagent'
  /** Attribute residual misses through the gateway; absent keeps the report offline. */
  readonly providerAttribution?: ProviderAttribution
}

/** One reconstructed request: the messages, header, and usage of one model call. */
interface RequestSample {
  readonly seq: SessionSeq
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly header: EpochHeader | undefined
  readonly messages: readonly Message[]
  readonly messageKeys: readonly string[]
  readonly messageTokens: readonly number[]
  readonly toolsTokens: number
  readonly usage: TokenUsage
  /** Provider response id the adapter recorded for the call, when it recorded one. */
  readonly responseId?: string
}

/** Canonical bytes of one request header's cache-relevant fields. */
interface HeaderShape {
  readonly config: string
  readonly adapterDefaults: string
  readonly tools: string
}

/** Canonical comparison components of one request. */
interface RequestShape {
  readonly config: string
  readonly adapterDefaults: string
  readonly tools: string
  readonly system: readonly string[]
}

/** The cache-relevant head of a Session's first request. */
interface HeadSignature {
  readonly key: string
  readonly estimatedTokens: number
  readonly cacheReadTokens: number | undefined
}

/** One Session's contribution to the report. */
interface SessionRun {
  readonly slug: string
  readonly header: SessionHeader
  /** Provider route of the first call, for cross-session grouping. */
  readonly route: string
  readonly steps: readonly StepRecord[]
  readonly head: HeadSignature | undefined
}

/** Memoized canonical bytes and heuristic price of one immutable message. */
const MESSAGE_FACTS = new WeakMap<Message, { readonly key: string; readonly tokens: number }>()

/** Memoized canonical components of one immutable request header. */
const HEADER_SHAPES = new WeakMap<EpochHeader, { readonly config: string; readonly adapterDefaults: string; readonly tools: string }>()

/** Serialize a JSON value with sorted object keys, so equal content yields equal bytes. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) record[key] = item
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The bytes one message contributes to a request, and their heuristic price.
 * Host metadata (message id, source) never reaches the provider, so it never
 * reaches the comparison.
 * @param message - immutable session message.
 * @returns the canonical wire bytes and their heuristic token price.
 */
function messageFacts(message: Message): { readonly key: string; readonly tokens: number } {
  const memoized = MESSAGE_FACTS.get(message)
  if (memoized !== undefined) return memoized
  const wire: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.role === 'tool') {
    wire['toolCallId'] = message.toolCallId
    if (message.isError === true) wire['isError'] = true
  }
  const facts = { key: canonicalJson(wire), tokens: estimateMessage(message) }
  MESSAGE_FACTS.set(message, facts)
  return facts
}

/**
 * The canonical components of one request header.
 * @param header - canonical request header in force, when one was logged.
 * @returns its config, adapter-default, and tool-declaration bytes.
 */
function headerShape(header: EpochHeader | undefined): HeaderShape {
  if (header === undefined) return { config: 'null', adapterDefaults: 'null', tools: '[]' }
  const memoized = HEADER_SHAPES.get(header)
  if (memoized !== undefined) return memoized
  const shape = {
    config: canonicalJson(header.config),
    adapterDefaults: canonicalJson(header.adapterDefaults ?? null),
    tools: canonicalJson(header.tools ?? []),
  }
  HEADER_SHAPES.set(header, shape)
  return shape
}

/** Whether an event type carries a message projection. */
function isProjectionEvent(event: SessionEvent): boolean {
  return PROJECTIONS.some(projection => projection.type === event.type)
}

/**
 * Reconstruct the model-visible message list in force at a log offset.
 * @param events - the Session log, contiguous from seq 0.
 * @param endSeq - first seq excluded from the reconstruction.
 * @returns the surface messages in model-visible order.
 */
function foldMessages(events: readonly SessionEvent[], endSeq: SessionSeq): Message[] {
  const folded = foldSurface(events.slice(0, endSeq), PROJECTIONS)
  const messages: Message[] = []
  for (const seq of folded.nodes) {
    const event = events[seq]
    if (event === undefined) throw new Error(`cache-report: surface node ${seq} has no event`)
    const message = deriveEventMessage(event, folded.projectedMessages)
    if (message !== null) messages.push(message)
  }
  return messages
}

/**
 * Whether a decoded JSON value is a plain object.
 * @param value - any decoded value.
 * @returns whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The provider response id recorded for one assistant message. The replay
 * envelope is adapter-private (`unknown`) by design, so the stored value is
 * validated here rather than asserted.
 * @param message - the assistant message as the log stores it.
 * @returns the recorded response id, or `undefined` when the adapter recorded none.
 */
function recordedResponseId(message: AssistantMessage): string | undefined {
  const envelope = message.source.replayState
  if (!isRecord(envelope)) return undefined
  const response = envelope['response']
  if (!isRecord(response)) return undefined
  const id = response['responseId']
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Fold one Session log into its request timeline: one sample per model call
 * that reported usage.
 * @param events - the Session log, contiguous from seq 0.
 * @returns samples in log order.
 */
function reconstructSamples(events: readonly SessionEvent[]): RequestSample[] {
  const samples: RequestSample[] = []
  let header: EpochHeader | undefined
  let surface: Message[] | undefined
  let stale = true
  for (const event of events) {
    if (event.type === 'request/header') {
      header = canonicalHeader(event.data.header)
      continue
    }
    if (event.type === 'request/context') continue
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      if (stale || surface === undefined) {
        surface = foldMessages(events, event.seq)
        stale = false
      }
      const facts = surface.map(messageFacts)
      const responseId = recordedResponseId(event.data.message)
      samples.push({
        seq: event.seq,
        turn: event.data.turn,
        step: event.data.step,
        time: event.time,
        header,
        messages: surface,
        messageKeys: facts.map(fact => fact.key),
        messageTokens: facts.map(fact => fact.tokens),
        toolsTokens: estimateToolsTokens(header),
        usage: event.data.usage,
        ...responseId === undefined ? {} : { responseId },
      })
    }
    if (isSurfaceEvent(event) || isProjectionEvent(event)) stale = true
  }
  return samples
}

/** Canonical comparison components of one sample. */
function shapeOf(sample: RequestSample): RequestShape {
  const header = headerShape(sample.header)
  const system: string[] = []
  for (const message of sample.messages) {
    if (message.role === 'system') system.push(messageFacts(message).key)
  }
  return { ...header, system }
}

/** Estimated prompt tokens of one request. */
function estimatedTotal(sample: RequestSample): number {
  return sample.toolsTokens + sample.messageTokens.reduce((sum, tokens) => sum + tokens, 0)
}

/** Whether the two samples name the same provider route. */
function sameRoute(previous: RequestSample, current: RequestSample): boolean {
  const a = previous.header?.config
  const b = current.header?.config
  return a?.provider === b?.provider && a?.model === b?.model
}

/** The longest prefix of the current request that is byte-identical to the previous one. */
interface PrefixComparison {
  /** Estimated tokens of the shared prefix. */
  readonly commonPrefixTokens: number
  /** Estimated tokens of the whole current request. */
  readonly estimatedTotalTokens: number
  /** Index of the first message that differs. */
  readonly firstDivergentMessage?: number
}

/**
 * Compare two consecutive requests of one Session.
 * @param previous - the earlier sample.
 * @param current - the later sample.
 * @param previousShape - canonical components of the earlier sample.
 * @param currentShape - canonical components of the later sample.
 * @returns shared-prefix tokens and the first divergent message.
 */
function comparePrefix(
  previous: RequestSample,
  current: RequestSample,
  previousShape: RequestShape,
  currentShape: RequestShape,
): PrefixComparison {
  const estimatedTotalTokens = estimatedTotal(current)
  if (!sameRoute(previous, current) || previousShape.tools !== currentShape.tools) {
    return { commonPrefixTokens: 0, estimatedTotalTokens }
  }
  let commonPrefixTokens = current.toolsTokens
  const shared = Math.min(previous.messages.length, current.messages.length)
  for (let index = 0; index < shared; index += 1) {
    if (previous.messages[index] !== current.messages[index]
      && previous.messageKeys[index] !== current.messageKeys[index]) {
      return { commonPrefixTokens, estimatedTotalTokens, firstDivergentMessage: index }
    }
    commonPrefixTokens += current.messageTokens[index] ?? 0
  }
  return { commonPrefixTokens, estimatedTotalTokens }
}

/** Whether a message records a tool addition or removal. */
function hasToolChange(message: Message): boolean {
  if (message.role !== 'developer') return false
  return message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')
}

/** Events observed between two consecutive calls, reduced to classification facts. */
interface IntervalFacts {
  readonly replacedSurface: boolean
  readonly offloadedImages: boolean
  readonly toolChanged: boolean
}

/**
 * Summarize the log between two calls.
 * @param events - Session log.
 * @param from - last seq of the earlier call.
 * @param to - seq of the later call.
 * @returns the classification facts of the interval.
 */
function intervalFacts(events: readonly SessionEvent[], from: SessionSeq, to: SessionSeq): IntervalFacts {
  let replacedSurface = false
  let offloadedImages = false
  let toolChanged = false
  for (let seq = from + 1; seq < to; seq += 1) {
    const event = events[seq]
    if (event === undefined) break
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') replacedSurface = true
    if (isReplacementSurfaceEvent(event)) replacedSurface = true
    if (event.type === 'image/offload') offloadedImages = true
    if (event.type === 'developer/message' && hasToolChange(event.data.message)) toolChanged = true
  }
  return { replacedSurface, offloadedImages, toolChanged }
}

/** Whether every message of the earlier request leads the later one unchanged. */
function isAppendOnly(previous: RequestSample, current: RequestSample): boolean {
  if (current.messages.length < previous.messages.length) return false
  for (let index = 0; index < previous.messages.length; index += 1) {
    if (previous.messages[index] !== current.messages[index]
      && previous.messageKeys[index] !== current.messageKeys[index]) return false
  }
  return true
}

/** Whether the system prompts differ. */
function systemChanged(previous: RequestShape, current: RequestShape): boolean {
  if (previous.system.length !== current.system.length) return true
  return previous.system.some((key, index) => key !== current.system[index])
}

/** Quote the bytes around the first difference of two canonical strings. */
function snippetAround(previous: string, current: string): DivergenceSnippet {
  let offset = 0
  while (offset < previous.length && offset < current.length && previous[offset] === current[offset]) offset += 1
  const start = Math.max(0, offset - EXAMPLE_LEAD_CHARS)
  return {
    offset,
    previous: previous.slice(start, offset + EXAMPLE_CHARS),
    current: current.slice(start, offset + EXAMPLE_CHARS),
  }
}

/** Fresh zero totals. */
function zeroTotals(): CacheTotals {
  return {
    calls: 0,
    promptTokens: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    unexpectedMissTokens: 0,
    expectedUncachedTokens: 0,
    estimatedTotalTokens: 0,
    commonPrefixTokens: 0,
    unknownCounterCalls: 0,
    inferredMissTokens: 0,
  }
}

/** Add one step's figures into a totals record. */
function addStep(totals: CacheTotals, step: CacheTotals): CacheTotals {
  return {
    calls: totals.calls + step.calls,
    promptTokens: totals.promptTokens + step.promptTokens,
    cacheReadTokens: totals.cacheReadTokens + step.cacheReadTokens,
    inputTokens: totals.inputTokens + step.inputTokens,
    unexpectedMissTokens: totals.unexpectedMissTokens + step.unexpectedMissTokens,
    expectedUncachedTokens: totals.expectedUncachedTokens + step.expectedUncachedTokens,
    estimatedTotalTokens: totals.estimatedTotalTokens + step.estimatedTotalTokens,
    commonPrefixTokens: totals.commonPrefixTokens + step.commonPrefixTokens,
    unknownCounterCalls: totals.unknownCounterCalls + step.unknownCounterCalls,
    inferredMissTokens: totals.inferredMissTokens + step.inferredMissTokens,
  }
}

/** One step's token figures, excluding the route's cache counters when absent. */
function stepTotals(usage: TokenUsage, comparison: PrefixComparison, unexpectedMissTokens: number): CacheTotals {
  const cacheRead = usage.cacheReadTokens
  const expectedUncached = Math.max(0, comparison.estimatedTotalTokens - comparison.commonPrefixTokens)
  if (cacheRead === undefined) {
    return {
      ...zeroTotals(),
      calls: 1,
      inputTokens: usage.inputTokens,
      expectedUncachedTokens: expectedUncached,
      estimatedTotalTokens: comparison.estimatedTotalTokens,
      commonPrefixTokens: comparison.commonPrefixTokens,
      unknownCounterCalls: 1,
      inferredMissTokens: Math.max(0, usage.inputTokens - expectedUncached),
    }
  }
  return {
    calls: 1,
    promptTokens: cacheRead + usage.inputTokens,
    cacheReadTokens: cacheRead,
    inputTokens: usage.inputTokens,
    unexpectedMissTokens,
    expectedUncachedTokens: expectedUncached,
    estimatedTotalTokens: comparison.estimatedTotalTokens,
    commonPrefixTokens: comparison.commonPrefixTokens,
    unknownCounterCalls: 0,
    inferredMissTokens: 0,
  }
}

/** One call's bucket, mechanism, and token figures. */
interface Attribution {
  readonly bucket: CacheBucket
  readonly divergence: string
  readonly priorBucket?: CacheBucket
  readonly totals: CacheTotals
  readonly firstDivergentMessage?: number
  readonly snippet?: DivergenceSnippet
  readonly toolsDiffer: boolean
}

/**
 * Attribute one call's miss to the first request component that broke the
 * previous prefix, then escalate an expected cause whose miss the estimate
 * cannot explain.
 * @param previous - the earlier sample, absent for a Session's first call.
 * @param current - the later sample.
 * @param events - the Session log, for the interval facts.
 * @param residualRatio - relative slack over the estimated appended suffix.
 * @param includeText - quote the first divergent bytes.
 * @returns the call's bucket, mechanism, and token figures.
 */
function attribute(
  previous: RequestSample | undefined,
  current: RequestSample,
  events: readonly SessionEvent[],
  residualRatio: number,
  includeText: boolean,
): Attribution {
  if (previous === undefined) {
    const comparison = { commonPrefixTokens: 0, estimatedTotalTokens: estimatedTotal(current) }
    const unexpectedMissTokens = Math.max(0, current.usage.inputTokens - comparison.estimatedTotalTokens)
    return {
      bucket: 'cold-start',
      divergence: 'first call of the session',
      totals: stepTotals(current.usage, comparison, unexpectedMissTokens),
      toolsDiffer: false,
    }
  }
  const previousShape = shapeOf(previous)
  const currentShape = shapeOf(current)
  const comparison = comparePrefix(previous, current, previousShape, currentShape)
  const expectedUncached = Math.max(0, comparison.estimatedTotalTokens - comparison.commonPrefixTokens)
  const tolerance = Math.max(RESIDUAL_FLOOR_TOKENS, residualRatio * expectedUncached)
  const unexpectedMissTokens = Math.max(0, current.usage.inputTokens - expectedUncached)
  const facts = intervalFacts(events, previous.seq, current.seq)
  const toolsDiffer = previousShape.tools !== currentShape.tools
  const configDiffer = previousShape.config !== currentShape.config
    || previousShape.adapterDefaults !== currentShape.adapterDefaults
  let bucket: CacheBucket
  let divergence: string
  let snippet: DivergenceSnippet | undefined
  if (!sameRoute(previous, current)) {
    bucket = 'route-change'
    divergence = 'provider or model changed'
    if (includeText) snippet = snippetAround(previousShape.config, currentShape.config)
  } else if (configDiffer || toolsDiffer) {
    bucket = 'header-change'
    divergence = toolsDiffer ? 'tool declarations changed' : 'call configuration changed'
    if (includeText) {
      snippet = snippetAround(
        toolsDiffer ? previousShape.tools : previousShape.config,
        toolsDiffer ? currentShape.tools : currentShape.config,
      )
    }
  } else if (facts.replacedSurface) {
    bucket = 'surface-replacement'
    divergence = 'a logged replacement shadowed surface nodes'
  } else if (systemChanged(previousShape, currentShape)) {
    bucket = 'prompt-change'
    divergence = 'a system node was appended or rewritten'
  } else if (facts.offloadedImages) {
    bucket = 'image-projection'
    divergence = 'an image offload decision changed the request bytes'
  } else if (facts.toolChanged) {
    bucket = 'tool-update'
    divergence = 'a developer tool addition or removal was appended'
  } else if (isAppendOnly(previous, current)) {
    bucket = 'append-only'
    divergence = 'the request extends the previous prefix'
  } else {
    bucket = 'unexplained'
    divergence = 'no logged component explains the divergence'
  }
  const index = comparison.firstDivergentMessage
  if (snippet === undefined && includeText && index !== undefined) {
    const previousKey = previous.messageKeys[index]
    const currentKey = current.messageKeys[index]
    if (previousKey !== undefined && currentKey !== undefined) snippet = snippetAround(previousKey, currentKey)
  }
  const priorBucket = bucket
  if (EXPECTED_BUCKETS.has(bucket) && unexpectedMissTokens > tolerance
    && unexpectedMissTokens > PREFIX_BREAK_SHARE * comparison.commonPrefixTokens) {
    bucket = 'unexplained'
    divergence = `${divergence}, but the miss exceeds the estimated suffix`
  }
  return {
    bucket,
    divergence,
    ...bucket === priorBucket ? {} : { priorBucket },
    totals: stepTotals(current.usage, comparison, unexpectedMissTokens),
    ...index === undefined ? {} : { firstDivergentMessage: index },
    ...snippet === undefined ? {} : { snippet },
    toolsDiffer,
  }
}

/** Median of a list of numbers, or 0 when empty. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? 0) + upper) / 2
}

/** Resolve a project slug from a stored artifact path. */
function slugOf(locationPath: string | undefined, root: string): string {
  if (locationPath === undefined) return 'unknown'
  const inside = isAbsolute(locationPath) && isAbsolute(root) ? relative(root, locationPath) : locationPath
  const [first] = inside.split(sep)
  return first === undefined || first.length === 0 || first.startsWith('..') ? 'unknown' : first
}

/** The Session header's origin, defaulting to `user`. */
function originOf(header: SessionHeader): 'user' | 'subagent' {
  return header.origin === 'subagent' ? 'subagent' : 'user'
}

/** Cache-relevant head of a Session's first request. */
function headSignature(sample: RequestSample): HeadSignature {
  const header = headerShape(sample.header)
  const system: string[] = []
  let systemTokens = 0
  for (const message of sample.messages) {
    if (message.role !== 'system') continue
    const facts = messageFacts(message)
    system.push(facts.key)
    systemTokens += facts.tokens
  }
  return {
    key: canonicalJson({ ...header, system }),
    estimatedTokens: sample.toolsTokens + systemTokens,
    cacheReadTokens: sample.usage.cacheReadTokens,
  }
}

/**
 * Read and attribute one stored Session.
 * @param events - the Session log.
 * @param header - the stored header.
 * @param slug - the project slug.
 * @param residualRatio - relative slack over the estimated appended suffix.
 * @param includeText - quote divergent bytes in the returned records.
 * @returns the Session's attributed steps and head signature.
 */
function attributeSession(
  events: readonly SessionEvent[],
  header: SessionHeader,
  slug: string,
  residualRatio: number,
  includeText: boolean,
): SessionRun {
  const samples = reconstructSamples(events)
  const steps: StepRecord[] = []
  let head: HeadSignature | undefined
  let route = ''
  for (const [index, sample] of samples.entries()) {
    const previous = index === 0 ? undefined : samples[index - 1]
    const attribution = attribute(previous, sample, events, residualRatio, includeText)
    const gapMs = previous === undefined ? Number.POSITIVE_INFINITY : sample.time - previous.time
    steps.push({
      bucket: attribution.bucket,
      divergence: attribution.divergence,
      ...attribution.priorBucket === undefined ? {} : { priorBucket: attribution.priorBucket },
      gapMs,
      totals: attribution.totals,
      ...attribution.firstDivergentMessage === undefined
        ? {}
        : { firstDivergentMessage: attribution.firstDivergentMessage },
      ...attribution.snippet === undefined ? {} : { snippet: attribution.snippet },
      toolsDiffer: attribution.toolsDiffer,
      toolCount: sample.header?.tools?.length ?? 0,
      ...sample.header === undefined
        ? {}
        : { provider: sample.header.config.provider, model: sample.header.config.model },
      slug,
      sessionId: header.id,
      seq: sample.seq,
      turn: sample.turn,
      step: sample.step,
      ...sample.responseId === undefined ? {} : { responseId: sample.responseId },
    })
    if (index === 0) {
      head = headSignature(sample)
      route = `${sample.header?.config.provider ?? ''}/${sample.header?.config.model ?? ''}`
    }
  }
  return { slug, header, route, steps, head }
}

/** What one generation record states about the call that produced it. */
interface GenerationFacts {
  /** Provider the gateway routed the call to. */
  readonly provider: string
  /** Native prompt tokens the provider reported as cached. */
  readonly cachedTokens?: number
}

/**
 * Reduce one decoded generation record to the fields the report shows.
 * @param value - decoded endpoint body.
 * @returns the serving provider and its cached-token count, or `undefined` when
 * the body does not carry a provider.
 */
function generationFacts(value: unknown): GenerationFacts | undefined {
  if (!isRecord(value)) return undefined
  const data = value['data']
  if (!isRecord(data)) return undefined
  const provider = data['provider_name']
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  const cached = data['native_tokens_cached']
  return {
    provider,
    ...typeof cached === 'number' && Number.isFinite(cached) ? { cachedTokens: cached } : {},
  }
}

/**
 * Ask the gateway about one recorded response id.
 * @param request - the endpoint URL and its credential.
 * @returns the decoded response body.
 * @throws when the endpoint rejects the request or exceeds {@link LOOKUP_TIMEOUT_MS}.
 */
async function httpGenerationLookup(request: GenerationRequest): Promise<unknown> {
  const response = await fetch(request.url, {
    headers: { authorization: `Bearer ${request.apiKey}` },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`generation lookup failed: HTTP ${response.status}`)
  return response.json()
}

/** One call a miss is compared with. */
interface ProviderNeighbour {
  readonly responseId: string | undefined
}

/**
 * The nearest earlier or later call of the same Session that recorded a
 * response id.
 * @param steps - the Session's calls in log order.
 * @param from - index of the miss.
 * @param direction - `-1` for the preceding calls, `1` for the following ones.
 * @returns the nearest describable neighbour, or `undefined` when none recorded an id.
 */
function nearestNeighbour(
  steps: readonly StepRecord[],
  from: number,
  direction: -1 | 1,
): ProviderNeighbour | undefined {
  for (let index = from + direction; index >= 0 && index < steps.length; index += direction) {
    const responseId = steps[index]?.responseId
    if (responseId !== undefined) return { responseId }
  }
  return undefined
}

/**
 * Describe every residual miss through the gateway and decide whether request
 * routing moved it, by comparing its serving provider with the nearest
 * describable call on either side.
 * @param attribution - resolved endpoint, credential, and transport.
 * @param runs - attributed Sessions, in read order.
 * @returns the attribution, or one with no misses when none is large enough.
 */
async function attributeProviders(
  attribution: ProviderAttribution,
  runs: readonly SessionRun[],
): Promise<ProviderAttributionReport> {
  const lookup = attribution.lookup ?? httpGenerationLookup
  const described = new Map<string, GenerationFacts | undefined>()
  let resolved = 0
  let unresolved = 0
  let failure: string | undefined
  const describe = async (responseId: string | undefined): Promise<GenerationFacts | undefined> => {
    if (responseId === undefined) return undefined
    if (described.has(responseId)) return described.get(responseId)
    try {
      const facts = generationFacts(await lookup({
        url: `${attribution.endpoint}?id=${encodeURIComponent(responseId)}`,
        apiKey: attribution.apiKey,
      }))
      described.set(responseId, facts)
      if (facts === undefined) unresolved += 1
      else resolved += 1
      return facts
    } catch (error: unknown) {
      described.set(responseId, undefined)
      unresolved += 1
      failure ??= error instanceof Error ? error.message : String(error)
      return undefined
    }
  }
  const misses: ProviderMissRow[] = []
  let reroutedCalls = 0
  let reroutedTokens = 0
  let keptCalls = 0
  let keptTokens = 0
  let undecidedCalls = 0
  for (const run of runs) {
    for (const [index, step] of run.steps.entries()) {
      if (step.bucket !== 'unexplained' || step.totals.unexpectedMissTokens <= LARGE_MISS_TOKENS) continue
      const itself = await describe(step.responseId)
      if (itself === undefined) {
        undecidedCalls += 1
        continue
      }
      const previous = nearestNeighbour(run.steps, index, -1)
      const next = nearestNeighbour(run.steps, index, 1)
      const previousProvider = (await describe(previous?.responseId))?.provider
      const nextProvider = (await describe(next?.responseId))?.provider
      // The prefix a call reuses comes from the call before it, so a provider
      // change there is the routing evidence; the following call only speaks
      // when nothing precedes the miss.
      const rerouted = previousProvider !== undefined
        ? previousProvider !== itself.provider
        : nextProvider === undefined ? undefined : nextProvider !== itself.provider
      if (rerouted === true) {
        reroutedCalls += 1
        reroutedTokens += step.totals.unexpectedMissTokens
      } else if (rerouted === false) {
        keptCalls += 1
        keptTokens += step.totals.unexpectedMissTokens
      } else {
        undecidedCalls += 1
      }
      misses.push({
        slug: step.slug,
        sessionId: step.sessionId,
        seq: step.seq,
        turn: step.turn,
        step: step.step,
        unexpectedMissTokens: step.totals.unexpectedMissTokens,
        provider: itself.provider,
        ...previousProvider === undefined ? {} : { previousProvider },
        ...nextProvider === undefined ? {} : { nextProvider },
        ...rerouted === undefined ? {} : { rerouted },
      })
    }
  }
  misses.sort((a, b) => b.unexpectedMissTokens - a.unexpectedMissTokens)
  return {
    resolved,
    unresolved,
    ...failure === undefined ? {} : { failure },
    misses,
    reroutedCalls,
    reroutedTokens,
    keptCalls,
    keptTokens,
    undecidedCalls,
  }
}

/**
 * Read every stored Session under a root and build the report.
 * @param options - resolved report options.
 * @returns the aggregate report.
 */
export async function runCacheReport(options: CacheReportOptions): Promise<CacheReport> {
  const ctx = new Context()
  const runs: SessionRun[] = []
  const skipped: SkippedSession[] = []
  let skippedSessions = 0
  let sessionsWithoutUsage = 0
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: options.root })
    const snapshots = await ctx.sessionPersistence.list()
    for (const snapshot of snapshots) {
      const header = snapshot.header
      if (options.since !== undefined && header.createdAt < options.since) continue
      if (options.origin !== 'all' && originOf(header) !== options.origin) continue
      const slug = slugOf(snapshot.location?.path, options.root)
      if (options.project !== undefined && slug !== options.project) continue
      let events: readonly SessionEvent[]
      try {
        const handle = await ctx.sessionPersistence.open(header.id, 'read')
        try {
          events = (await handle.read()).events
        } finally {
          await handle.close()
        }
      } catch (error: unknown) {
        skippedSessions += 1
        if (skipped.length < SKIPPED_REASON_LIMIT) {
          skipped.push({ sessionId: header.id, reason: error instanceof Error ? error.message : String(error) })
        }
        continue
      }
      const run = attributeSession(events, header, slug, options.residualRatio, options.includeText)
      if (run.steps.length === 0) {
        sessionsWithoutUsage += 1
        continue
      }
      runs.push(run)
    }
  } finally {
    await ctx.fiber.dispose()
  }
  const report = buildReport(options, runs, skippedSessions, skipped, sessionsWithoutUsage)
  const attribution = options.providerAttribution
  if (attribution === undefined) return report
  return { ...report, providers: await attributeProviders(attribution, runs) }
}

/**
 * Aggregate attributed Sessions into the report.
 * @param options - resolved report options.
 * @param runs - attributed Sessions in read order.
 * @param skippedSessions - Sessions whose log could not be read.
 * @param skipped - the first {@link SKIPPED_REASON_LIMIT} of them, with the reason.
 * @param sessionsWithoutUsage - Sessions with no call that reported usage.
 * @returns the aggregate report.
 */
export function buildReport(
  options: CacheReportOptions,
  runs: readonly SessionRun[],
  skippedSessions: number,
  skipped: readonly SkippedSession[],
  sessionsWithoutUsage: number,
): CacheReport {
  let all = zeroTotals()
  let rapid = zeroTotals()
  let cold = zeroTotals()
  const byBucket = new Map<CacheBucket, CacheTotals>(BUCKETS.map(bucket => [bucket, zeroTotals()]))
  const headerChangeTools: number[] = []
  const examples = new Map<CacheBucket, StepRecord>()
  let calibrationX = 0
  let calibrationY = 0
  let calibrationN = 0
  let largeResidualCalls = 0
  let largeResidualTokens = 0
  const rows: CacheStepRow[] = []
  for (const run of runs) {
    for (const step of run.steps) {
      all = addStep(all, step.totals)
      if (!Number.isFinite(step.gapMs) || step.gapMs > options.rapidWindowMs) {
        cold = addStep(cold, step.totals)
        continue
      }
      rapid = addStep(rapid, step.totals)
      if (options.includeSteps) rows.push(stepRow(step))
      const bucketTotals = byBucket.get(step.bucket)
      if (bucketTotals !== undefined) byBucket.set(step.bucket, addStep(bucketTotals, step.totals))
      if (step.bucket === 'header-change' && step.toolsDiffer) headerChangeTools.push(step.toolCount)
      if (step.bucket === 'unexplained' && step.totals.unexpectedMissTokens > LARGE_MISS_TOKENS) {
        largeResidualCalls += 1
        largeResidualTokens += step.totals.unexpectedMissTokens
      }
      if (step.bucket === 'append-only') {
        calibrationX += step.totals.expectedUncachedTokens
        calibrationY += step.totals.inputTokens
        calibrationN += 1
      }
      const known = examples.get(step.bucket)
      if (known === undefined || step.totals.unexpectedMissTokens > known.totals.unexpectedMissTokens) {
        examples.set(step.bucket, step)
      }
    }
  }
  const buckets = {} as Record<CacheBucket, CacheTotals>
  for (const bucket of BUCKETS) buckets[bucket] = byBucket.get(bucket) ?? zeroTotals()
  return {
    root: options.root,
    generatedAt: new Date().toISOString(),
    rapidWindowMs: options.rapidWindowMs,
    residualRatio: options.residualRatio,
    sessions: runs.length,
    skippedSessions,
    skipped,
    sessionsWithoutUsage,
    all,
    rapid,
    cold,
    byBucket: buckets,
    headerChange: {
      toolsDifferCalls: headerChangeTools.length,
      medianToolCount: median(headerChangeTools),
    },
    unexplained: { largeCalls: largeResidualCalls, largeMissTokens: largeResidualTokens },
    headReuse: headReuse(runs),
    calibration: {
      slope: calibrationX === 0 ? 0 : calibrationY / calibrationX,
      samples: calibrationN,
      reportedInputTokens: calibrationY,
      estimatedAppendedTokens: calibrationX,
    },
    examples: topExamples(examples),
    ...options.includeSteps ? { steps: rows } : {},
  }
}

/**
 * One step in its JSON form.
 * @param step - attributed call.
 * @returns the call's row, without message text.
 */
function stepRow(step: StepRecord): CacheStepRow {
  const cacheRead = step.totals.unknownCounterCalls === 0 ? step.totals.cacheReadTokens : undefined
  return {
    bucket: step.bucket,
    divergence: step.divergence,
    ...step.priorBucket === undefined ? {} : { priorBucket: step.priorBucket },
    slug: step.slug,
    sessionId: step.sessionId,
    seq: step.seq,
    turn: step.turn,
    step: step.step,
    ...step.provider === undefined ? {} : { provider: step.provider },
    ...step.model === undefined ? {} : { model: step.model },
    gapMs: Number.isFinite(step.gapMs) ? step.gapMs : -1,
    estimatedTotalTokens: step.totals.estimatedTotalTokens,
    expectedUncachedTokens: step.totals.expectedUncachedTokens,
    inputTokens: step.totals.inputTokens,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    unexpectedMissTokens: step.totals.unexpectedMissTokens,
    toolsDiffer: step.toolsDiffer,
    toolCount: step.toolCount,
    ...step.firstDivergentMessage === undefined
      ? {}
      : { firstDivergentMessage: step.firstDivergentMessage },
  }
}

/**
 * Compare each new Session's first call against the previous Session of the
 * same project, origin, preset, and route.
 * @param runs - attributed Sessions.
 * @returns the cross-session head-reuse figures.
 */
function headReuse(runs: readonly SessionRun[]): HeadReuseReport {
  const ordered = runs
    .filter((run): run is SessionRun & { head: HeadSignature } => run.head !== undefined)
    .sort((a, b) => a.header.createdAt - b.header.createdAt)
  const seen = new Map<string, HeadSignature>()
  let compared = 0
  let identicalHeads = 0
  let identicalUncached = 0
  let identicalCacheReadTokens = 0
  let identicalEstimatedTokens = 0
  for (const run of ordered) {
    const key = canonicalJson({
      slug: run.slug,
      origin: originOf(run.header),
      preset: run.header.agentPreset ?? '',
      route: run.route,
    })
    const predecessor = seen.get(key)
    seen.set(key, run.head)
    if (predecessor === undefined) continue
    compared += 1
    if (predecessor.key !== run.head.key) continue
    identicalHeads += 1
    identicalEstimatedTokens += run.head.estimatedTokens
    const cacheRead = run.head.cacheReadTokens
    if (cacheRead === undefined) continue
    identicalCacheReadTokens += cacheRead
    if (cacheRead === 0) identicalUncached += 1
  }
  return { compared, identicalHeads, identicalUncached, identicalCacheReadTokens, identicalEstimatedTokens }
}

/** The largest-miss example of every bucket that has one, without message text. */
function topExamples(examples: ReadonlyMap<CacheBucket, StepRecord>): CacheExample[] {
  const ordered = [...examples.values()].sort((a, b) => b.totals.unexpectedMissTokens - a.totals.unexpectedMissTokens)
  return ordered.map(step => ({
    bucket: step.bucket,
    divergence: step.divergence,
    slug: step.slug,
    sessionId: step.sessionId,
    seq: step.seq,
    turn: step.turn,
    step: step.step,
    gapMs: Number.isFinite(step.gapMs) ? step.gapMs : -1,
    estimatedTotalTokens: step.totals.estimatedTotalTokens,
    expectedUncachedTokens: step.totals.expectedUncachedTokens,
    reportedInputTokens: step.totals.inputTokens,
    unexpectedMissTokens: step.totals.unexpectedMissTokens,
    ...step.firstDivergentMessage === undefined ? {} : { firstDivergentMessage: step.firstDivergentMessage },
    ...step.snippet === undefined ? {} : { snippet: step.snippet },
  }))
}

/** Format one integer with thousands separators. */
function count(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** Format one share as a percentage with one decimal. */
function share(value: number, total: number): string {
  return total === 0 ? '0.0%' : `${(100 * value / total).toFixed(1)}%`
}

/** Pad a label to the report's first column. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`
}

/** Format a duration in the report's compact units. */
function formatDuration(ms: number): string {
  if (ms % (24 * 60 * MINUTE_MS) === 0) return `${ms / (24 * 60 * MINUTE_MS)}d`
  if (ms % (60 * MINUTE_MS) === 0) return `${ms / (60 * MINUTE_MS)}h`
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

/** The per-bucket detail the text report appends. */
function bucketDetail(report: CacheReport, bucket: CacheBucket): string {
  if (bucket === 'header-change') {
    return `tools differ on ${count(report.headerChange.toolsDifferCalls)} calls`
      + `; median ${report.headerChange.medianToolCount} tools`
  }
  if (bucket === 'unexplained' && report.unexplained.largeCalls > 0) {
    return `${count(report.unexplained.largeCalls)} calls above ${count(LARGE_MISS_TOKENS)} tokens`
      + ` carry ${share(report.unexplained.largeMissTokens, report.byBucket.unexplained.unexpectedMissTokens)}`
  }
  const example = report.examples.find(item => item.bucket === bucket)
  return example === undefined ? '' : example.divergence
}

/**
 * Render the report as the text table.
 * @param report - the aggregate report.
 * @returns the text report, without a trailing newline.
 */
export function renderText(report: CacheReport): string {
  const lines: string[] = []
  const prompt = report.rapid.promptTokens
  lines.push(`Prompt-cache report for ${report.root}`)
  lines.push(
    `sessions: ${count(report.sessions)} read, ${count(report.skippedSessions)} skipped`
    + ` (${count(report.sessionsWithoutUsage)} without usage)`
    + `   calls: ${count(report.all.calls)}`,
  )
  const [firstSkip] = report.skipped
  if (firstSkip !== undefined) lines.push(`  skipped ${firstSkip.sessionId}: ${firstSkip.reason}`)
  lines.push('')
  lines.push(
    `Rapid successive calls (gap <= ${formatDuration(report.rapidWindowMs)}):`
    + ` ${count(report.rapid.calls)} calls,`
    + ` ${count(report.rapid.unknownCounterCalls)} without cache counters`,
  )
  lines.push(`  prompt tokens     ${count(prompt).padStart(12)}   (cache read ${count(report.rapid.cacheReadTokens)})`)
  lines.push(
    `  unexpected miss   ${count(report.rapid.unexpectedMissTokens).padStart(12)}`
    + ` tokens (${share(report.rapid.unexpectedMissTokens, prompt)} of prompt tokens)`,
  )
  lines.push(
    `  inferred miss     ${count(report.rapid.inferredMissTokens).padStart(12)}`
    + ` tokens (${count(report.rapid.unknownCounterCalls)} calls whose route reported no cache counters)`,
  )
  lines.push('  by cause:')
  const width = Math.max(...BUCKETS.map(bucket => bucket.length)) + 2
  const missOf = (bucket: CacheBucket): number =>
    report.byBucket[bucket].unexpectedMissTokens + report.byBucket[bucket].inferredMissTokens
  // Candidate causes first: they are what a later change can act on.
  const ordered = [...BUCKETS].sort((a, b) => {
    const candidateOrder = Number(EXPECTED_BUCKETS.has(a)) - Number(EXPECTED_BUCKETS.has(b))
    return candidateOrder === 0 ? missOf(b) - missOf(a) : candidateOrder
  })
  for (const bucket of ordered) {
    const totals = report.byBucket[bucket]
    if (totals.calls === 0) continue
    const detail = bucketDetail(report, bucket)
    lines.push(
      `    ${pad(bucket, width)}${count(totals.unexpectedMissTokens).padStart(10)}`
      + `   ${share(totals.unexpectedMissTokens, report.rapid.unexpectedMissTokens).padStart(6)}`
      + `   ${count(totals.inferredMissTokens).padStart(10)} inferred`
      + `   ${count(totals.calls).padStart(6)} calls${detail.length === 0 ? '' : `   (${detail})`}`,
    )
  }
  const top = [...report.examples]
    .filter(example => !EXPECTED_BUCKETS.has(example.bucket) && missOf(example.bucket) > 0)
    .sort((a, b) => missOf(b.bucket) - missOf(a.bucket))
    .slice(0, TOP_CAUSE_COUNT)
  if (top.length > 0) {
    lines.push('')
    lines.push('Top candidate causes (reproduce with --project <slug> --show-examples):')
    for (const example of top) {
      lines.push(
        `  ${example.bucket}: ${example.slug} / ${example.sessionId} seq ${example.seq}`
        + ` (turn ${example.turn} step ${example.step}, ${count(example.unexpectedMissTokens)} unexpected tokens)`,
      )
      if (example.snippet !== undefined) {
        lines.push(`    first difference at offset ${example.snippet.offset}:`)
        lines.push(`      previous: ${JSON.stringify(example.snippet.previous)}`)
        lines.push(`      current:  ${JSON.stringify(example.snippet.current)}`)
      }
    }
  }
  const providers = report.providers
  if (providers !== undefined) {
    lines.push('')
    lines.push(
      `provider attribution (${count(providers.misses.length)} misses above ${count(LARGE_MISS_TOKENS)}`
      + ` tokens; ${count(providers.resolved)} lookups, ${count(providers.unresolved)} unresolved):`,
    )
    lines.push(
      `  rerouted   ${count(providers.reroutedCalls).padStart(6)} misses`
      + ` ${count(providers.reroutedTokens).padStart(10)} tokens`
      + '   the provider changed from the preceding call',
    )
    lines.push(
      `  kept       ${count(providers.keptCalls).padStart(6)} misses`
      + ` ${count(providers.keptTokens).padStart(10)} tokens`
      + '   the preceding call used the same provider',
    )
    if (providers.undecidedCalls > 0) {
      lines.push(`  undecided  ${count(providers.undecidedCalls).padStart(6)} misses (no response id, or no lookup succeeded)`)
    }
    if (providers.failure !== undefined) lines.push(`  first lookup failure: ${providers.failure}`)
    for (const miss of providers.misses) {
      const neighbours = [
        ...miss.previousProvider === undefined ? [] : [`previous ${miss.previousProvider}`],
        ...miss.nextProvider === undefined ? [] : [`next ${miss.nextProvider}`],
      ]
      const suffix = neighbours.length === 0 ? '' : ` (${neighbours.join(', ')})`
      lines.push(
        `  ${miss.sessionId} seq ${miss.seq}: ${count(miss.unexpectedMissTokens)} tokens,`
        + ` served by ${miss.provider}${suffix}`,
      )
    }
  }
  lines.push('')
  const heads = report.headReuse
  lines.push(
    `cross-session head reuse: ${count(heads.identicalHeads)} of ${count(heads.compared)} new sessions had an identical head;`,
  )
  lines.push(
    `  cacheRead on their first call: 0 tokens in ${count(heads.identicalUncached)} of ${count(heads.identicalHeads)}`
    + ` (${count(heads.identicalCacheReadTokens)} cached of ${count(heads.identicalEstimatedTokens)} estimated head tokens)`,
  )
  lines.push(
    `estimator calibration: slope ${report.calibration.slope.toFixed(2)}`
    + ` (append-only steps, n=${count(report.calibration.samples)})`,
  )
  lines.push('')
  lines.push(
    `cold calls (session heads and gaps beyond the window): ${count(report.cold.calls)}`
    + `, ${count(report.cold.unexpectedMissTokens)} unexpected tokens`,
  )
  return lines.join('\n')
}

/** Parse a duration such as `30m`, `2h`, or `90s`. */
function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text)
  if (match === null) throw new Error(`cache-report: invalid duration "${text}" (use e.g. 30m, 2h, 90s)`)
  const amount = Number(match[1])
  switch (match[2]) {
    case 'ms': return amount
    case 's': return amount * 1000
    case 'm': return amount * MINUTE_MS
    case 'h': return amount * 60 * MINUTE_MS
    case 'd': return amount * 24 * 60 * MINUTE_MS
    /* v8 ignore next 2 -- the regular expression admits only these units */
    default: throw new Error(`cache-report: invalid duration "${text}"`)
  }
}

/** Parse a `--since` date or timestamp into epoch milliseconds. */
function parseSince(text: string): number {
  const value = Date.parse(text)
  if (Number.isNaN(value)) throw new Error(`cache-report: invalid --since date "${text}"`)
  return value
}

const USAGE = `Usage: pnpm cache-report [options]

Report prompt-cache reuse and unexpected misses across stored Sessions.

Options:
  --root <path>             Session store root (default: $DSH_HOME/sessions)
  --project <slug>          Restrict to one project directory; the value is taken
                            literally, so a slug beginning with "--" works
  --since <date>            Only Sessions created at or after this date
  --rapid-window <span>     Gap under which calls form one rapid series (default: 30m)
  --residual-ratio <ratio>  Slack over the estimated suffix before a miss is
                            reclassified unexplained (default: ${DEFAULT_RESIDUAL_RATIO})
  --origin <kind>           all, user, or subagent (default: all)
  --show-examples           Quote the first divergent bytes per cause
  --steps                   Include every rapid call in the JSON report
  --attribute-providers     Describe each large residual miss, and the calls on
                            either side of it, through the gateway generation
                            endpoint; states whether routing moved the call
  --generation-endpoint <url>  Generation lookup endpoint
                            (default: ${DEFAULT_GENERATION_ENDPOINT})
  --api-key-env <name>      Environment variable holding that endpoint's key
                            (default: ${DEFAULT_API_KEY_ENV})
  --json                    Print the report as JSON
  --help                    Print this message
`

/** Resolved command line. */
export interface ParsedCommandLine {
  /** Report options. */
  readonly options: CacheReportOptions
  /** Print JSON instead of the text table. */
  readonly json: boolean
  /** Print usage instead of running. */
  readonly help: boolean
}

/**
 * Take the `--project` value out of the argument list before strict parsing:
 * stored project slugs begin with `--`, which the parser would read as options.
 * @param argv - arguments after the script name.
 * @returns the remaining arguments and the project slug when one was named.
 * @throws when `--project` has no value.
 */
function extractProject(argv: readonly string[]): { readonly args: string[]; readonly project?: string } {
  const args: string[] = []
  let project: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--project') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('cache-report: --project requires a value')
      project = value
      index += 1
      continue
    }
    if (argument !== undefined && argument.startsWith('--project=')) {
      project = argument.slice('--project='.length)
      continue
    }
    if (argument !== undefined) args.push(argument)
  }
  return project === undefined ? { args } : { args, project }
}

/**
 * Resolve the provider lookup from the command line.
 * @param endpoint - generation endpoint to ask.
 * @param apiKeyEnv - environment variable holding the endpoint's key.
 * @returns the resolved attribution.
 * @throws when that variable is unset or empty, because a report that silently
 * skipped attribution would read like one that found nothing to attribute.
 */
function resolveProviderAttribution(endpoint: string, apiKeyEnv: string): ProviderAttribution {
  const apiKey = process.env[apiKeyEnv]
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`cache-report: --attribute-providers needs an API key in $${apiKeyEnv}`)
  }
  return { endpoint, apiKey }
}

/**
 * Resolve command-line arguments into report options.
 * @param argv - arguments after the script name.
 * @returns the resolved command line.
 * @throws when an argument is unknown or malformed.
 */
export function parseOptions(argv: readonly string[]): ParsedCommandLine {
  const { args, project } = extractProject(argv)
  const parsed = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      since: { type: 'string' },
      'rapid-window': { type: 'string' },
      'residual-ratio': { type: 'string' },
      origin: { type: 'string' },
      'show-examples': { type: 'boolean' },
      steps: { type: 'boolean' },
      'attribute-providers': { type: 'boolean' },
      'generation-endpoint': { type: 'string' },
      'api-key-env': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  })
  const origin = parsed.values.origin ?? 'all'
  if (origin !== 'all' && origin !== 'user' && origin !== 'subagent') {
    throw new Error(`cache-report: invalid --origin "${origin}" (use all, user, or subagent)`)
  }
  const residualText = parsed.values['residual-ratio']
  const residualRatio = residualText === undefined ? DEFAULT_RESIDUAL_RATIO : Number(residualText)
  if (!Number.isFinite(residualRatio) || residualRatio < 0) {
    throw new Error(`cache-report: invalid --residual-ratio "${String(residualText)}"`)
  }
  const providerAttribution = parsed.values['attribute-providers'] === true
    ? resolveProviderAttribution(
      parsed.values['generation-endpoint'] ?? DEFAULT_GENERATION_ENDPOINT,
      parsed.values['api-key-env'] ?? DEFAULT_API_KEY_ENV,
    )
    : undefined
  return {
    options: {
      root: parsed.values.root ?? dshHomePath('sessions'),
      ...project === undefined ? {} : { project },
      ...parsed.values.since === undefined ? {} : { since: parseSince(parsed.values.since) },
      rapidWindowMs: parsed.values['rapid-window'] === undefined
        ? DEFAULT_RAPID_WINDOW_MS
        : parseDuration(parsed.values['rapid-window']),
      residualRatio,
      includeText: parsed.values['show-examples'] === true,
      includeSteps: parsed.values.steps === true,
      origin,
      ...providerAttribution === undefined ? {} : { providerAttribution },
    },
    json: parsed.values.json === true,
    help: parsed.values.help === true,
  }
}

/**
 * Parse arguments, run the report, and print it.
 * @param argv - arguments after the script name.
 */
async function main(argv: readonly string[]): Promise<void> {
  const { options, json, help } = parseOptions(argv)
  if (help) {
    process.stdout.write(USAGE)
    return
  }
  const report = await runCacheReport(options)
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  process.stdout.write(`${renderText(report)}\n`)
  if (report.sessions === 0) {
    process.stdout.write(`no Sessions under ${basename(options.root)} matched the filters\n`)
  }
}

/* v8 ignore next 2 -- module entry: exercised through the CLI, not a unit test */
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main(process.argv.slice(2))
