/** Cache-relevant request identity and the comparison that attributes a cache miss to one component. */
import { createHash } from 'node:crypto'
import type { GenerateOptions, RequestMessage, TokenUsage } from '@deepseek-ai/dsh-llm'

/** A request whose purpose is any producer-declared label; this plugin never narrows it. */
type RequestOptions = GenerateOptions<string>

/** One conversation message's model-visible identity: role and content, never host metadata. */
export interface MessageHash {
  /** Role the provider reads. */
  readonly role: RequestMessage['role']
  /** Hex digest of this message's role and content. */
  readonly hash: string
}

/** The cache-relevant prefix of one request, as the adapter receives it. */
export interface PrefixShape {
  /** Registered provider route. */
  readonly provider: string
  /** Wire model id. */
  readonly model: string
  /** Provider-neutral purpose of the call; an ordinary conversation request omits it. */
  readonly purpose?: string
  /** Digest of the effective leading system prompt, or of the empty prompt when none is sent. */
  readonly system: string
  /** Digest of the declared tool schemas, or of an empty list when none are declared. */
  readonly tools: string
  /** One entry per conversation message after the leading system prompt, in request order. */
  readonly messages: readonly MessageHash[]
}

/** Which request component first broke the prefix of the preceding request in the same series. */
export type PrefixDivergence =
  | { readonly kind: 'first-request' }
  | { readonly kind: 'route'; readonly previousProvider: string; readonly previousModel: string }
  | { readonly kind: 'system' }
  | { readonly kind: 'tools' }
  | { readonly kind: 'message'; readonly index: number; readonly role: RequestMessage['role'] }
  | { readonly kind: 'shortened'; readonly index: number }
  | { readonly kind: 'none'; readonly appended: number }

/** How one request's prefix relates to the preceding request of the same session and purpose. */
export interface PrefixComparison {
  /** Component that first broke the preceding prefix. */
  readonly divergence: PrefixDivergence
  /** The leading system prompt and tool schemas were unchanged. */
  readonly headReused: boolean
  /** Count of leading messages whose bytes are unchanged. */
  readonly reusedMessages: number
}

/** Short digest of one canonical JSON value; collisions only mislabel a diagnostic. */
function digest(value: object | string): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/** One message's wire identity: role and content, plus the tool fields the provider reads. */
function messageIdentity(message: RequestMessage): string {
  return digest({
    role: message.role,
    content: message.content,
    ...message.role === 'tool' ? { toolCallId: message.toolCallId, isError: message.isError === true } : {},
  })
}

/**
 * Hash the cache-relevant prefix of one request. A loop-built request carries its
 * system prompt as the leading message; a one-shot caller may pass `system` instead.
 * @param options - the request as the adapter receives it.
 * @returns digests of the leading prompt, tool declarations, and remaining messages.
 */
export function requestShape(options: RequestOptions): PrefixShape {
  const [first, ...rest] = options.messages
  const leadingPrompt = options.system !== undefined
    ? digest(options.system)
    : first?.role === 'system' ? messageIdentity(first) : digest('')
  const messages = options.system === undefined && first?.role === 'system' ? rest : options.messages
  return {
    provider: options.provider,
    model: options.model,
    ...options.purpose === undefined ? {} : { purpose: options.purpose },
    system: leadingPrompt,
    tools: digest(options.tools ?? []),
    messages: messages.map(message => ({ role: message.role, hash: messageIdentity(message) })),
  }
}

/**
 * Compare one request's prefix with the preceding request of the same series.
 * @param previous - shape of the preceding request.
 * @param current - shape of this request.
 * @returns the first broken component and how much of the prefix it leaves reusable.
 */
export function comparePrefix(previous: PrefixShape, current: PrefixShape): PrefixComparison {
  if (previous.provider !== current.provider || previous.model !== current.model) {
    return {
      divergence: { kind: 'route', previousProvider: previous.provider, previousModel: previous.model },
      headReused: false,
      reusedMessages: 0,
    }
  }
  if (previous.system !== current.system) return { divergence: { kind: 'system' }, headReused: false, reusedMessages: 0 }
  if (previous.tools !== current.tools) return { divergence: { kind: 'tools' }, headReused: false, reusedMessages: 0 }
  const shared = Math.min(previous.messages.length, current.messages.length)
  for (let index = 0; index < shared; index++) {
    const message = current.messages[index]
    /* v8 ignore next 2 -- both lists hold an entry at every index below the shared length */
    if (message === undefined) continue
    if (previous.messages[index]?.hash === message.hash) continue
    return { divergence: { kind: 'message', index, role: message.role }, headReused: true, reusedMessages: index }
  }
  if (current.messages.length < previous.messages.length) {
    return {
      divergence: { kind: 'shortened', index: current.messages.length },
      headReused: true,
      reusedMessages: current.messages.length,
    }
  }
  return {
    divergence: { kind: 'none', appended: current.messages.length - previous.messages.length },
    headReused: true,
    reusedMessages: previous.messages.length,
  }
}

/**
 * Read the cached share of one call's input.
 * @param usage - provider-reported token accounting.
 * @returns cached tokens over all input tokens, or undefined without cache counters or input.
 */
export function cacheHitRate(usage: TokenUsage): number | undefined {
  const cached = usage.cacheReadTokens
  if (cached === undefined) return undefined
  const total = cached + usage.inputTokens + (usage.cacheWriteTokens ?? 0)
  return total === 0 ? undefined : cached / total
}

/**
 * Decide whether a call missed a prefix the provider should have cached.
 * @param comparison - this request's prefix comparison.
 * @param usage - provider-reported token accounting.
 * @param minHitRate - cached share below which a predicted-reusable prefix counts as missed.
 * @returns true when some prefix was reusable but the reported hit rate stayed below `minHitRate`.
 */
export function unexpectedMiss(comparison: PrefixComparison, usage: TokenUsage, minHitRate: number): boolean {
  if (!comparison.headReused || comparison.reusedMessages === 0) return false
  const hitRate = cacheHitRate(usage)
  return hitRate !== undefined && hitRate < minHitRate
}
