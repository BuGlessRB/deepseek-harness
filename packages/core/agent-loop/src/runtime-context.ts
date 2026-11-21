/**
 * Durable admission state for the dynamic runtime-context snapshot.
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': {
      kind: 'runtime-context'
      /**
       * Whether the recorded sections state only the entries that changed,
       * leaving every other retained entry in force. Absent means they are the
       * complete current context, which also retires entries they no longer
       * name.
       */
      partial?: true
    } & ContextFormed
  }
}

const SOURCE = 'runtime-context'
const CLEARED = '<system-reminder>\nCurrent runtime context: none. Earlier runtime-context snapshots no longer apply.\n</system-reminder>'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === SOURCE
}

/** Older runtime-context messages may omit the structured snapshot contributions. */
function sectionsOf(message: UserMessage): readonly ContextSnapshotSection[] | undefined {
  return message.source.kind === SOURCE && message.source.form === 'snapshot' ? message.source.sections : undefined
}

/** Committed events from the newest backward; the restore scans stop at the first match. */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().toReversed()
}

/** The framing a runtime-context message states about the entries it carries. */
type ContextFraming = 'initial' | 'replacement' | 'changed'

const CONTEXT_INTRO: Readonly<Record<ContextFraming, string>> = {
  initial: 'The following information describes your current session:',
  replacement: 'The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.',
  changed: 'The following session information changed. Each entry below replaces its earlier value, including any retained in conversation summaries.',
}

/**
 * What the model holds of the runtime context. `unknown` covers a retained
 * message whose entries cannot be read back — one written before structured
 * sections, or one a replacement removed — and states the complete context
 * again rather than guessing.
 */
type RetainedContext =
  | { readonly known: false }
  | { readonly known: true; readonly values: ReadonlyMap<string, string> }

const UNKNOWN_CONTEXT: RetainedContext = { known: false }

/**
 * Tracks the runtime-context entries the model currently holds without owning
 * the commit. Entries are tracked one name at a time, so a step that changes one
 * contribution re-sends that contribution instead of the whole snapshot.
 */
export class RuntimeContextProjection {
  /** `undefined` means no snapshot was ever delivered. */
  private retained: RetainedContext | undefined
  /** Surface seqs of the retained runtime-context messages that built {@link retained}. */
  private readonly retainedSeqs = new Set<SessionSeq>()

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving projected messages.
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    const retained: UserMessage[] = []
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= UNKNOWN_CONTEXT
      if (surface.has(event.seq)) {
        retained.push(event.data)
        this.retainedSeqs.add(event.seq)
      }
    }
    for (const message of retained.toReversed()) this.retained = this.fold(this.retained ?? UNKNOWN_CONTEXT, message)

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = this.fold(this.retained ?? UNKNOWN_CONTEXT, event.data)
        this.retainedSeqs.add(event.seq)
        return
      }
      // A replacement (compaction) removed some retained messages, so the entries
      // they stated are no longer the model's current state — the summary may
      // still mention them — and the next step states the complete context.
      if (this.retainedSeqs.size > 0
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.some(seq => this.retainedSeqs.has(seq)) === true) {
        this.retained = UNKNOWN_CONTEXT
        this.retainedSeqs.clear()
      }
    })
  }

  /** Fold one delivered message into the entries the model holds. */
  private fold(retained: RetainedContext, message: UserMessage): RetainedContext {
    const sections = sectionsOf(message)
    // A message without structured sections predates the current writer: its
    // entries cannot be read back, so the next step states the complete context.
    if (sections === undefined) return UNKNOWN_CONTEXT
    const source = message.source
    const partial = source.kind === SOURCE && source.form === 'snapshot' && source.partial === true
    const values = new Map(partial && retained.known ? retained.values : undefined)
    for (const section of sections) values.set(section.name, section.text)
    return { known: true, values }
  }

  /**
   * Create an uncommitted reminder only when an entry changed, adding to the
   * retained entries instead of restating them. The first snapshot omits
   * supersession, and every later one also overrides facts retained in
   * compaction summaries. A retired entry, a cleared context, and a context the
   * model holds nothing of are stated completely. Proposals do not advance
   * committed state.
   * @param sections - named contributions that formed the current snapshot.
   * @returns a candidate user message, or `undefined` when no update is needed.
   */
  project(sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    const retained = this.retained
    if (retained === undefined) {
      return sections.length === 0 ? undefined : this.reminder(sections, 'initial')
    }
    if (sections.length === 0) {
      if (retained.known && retained.values.size === 0) return undefined
      return createUserMessage({
        content: [{ type: 'text', text: CLEARED }],
        source: { kind: SOURCE, form: 'snapshot', sections: [] },
      })
    }
    // An unreadable retained context and one the model holds nothing of are both
    // stated completely; so is a context that retired an entry.
    if (!retained.known || retained.values.size === 0) return this.reminder(sections, 'replacement')
    const changed = sections.filter(section => retained.values.get(section.name) !== section.text)
    const names = new Set(sections.map(section => section.name))
    if ([...retained.values.keys()].some(name => !names.has(name))) return this.reminder(sections, 'replacement')
    if (changed.length === 0) return undefined
    return this.reminder(changed, 'changed')
  }

  /** Frame one reminder over exactly the entries it states. */
  private reminder(sections: readonly ContextSnapshotSection[], framing: ContextFraming): UserMessage {
    const body = sections.map(section => section.text).join('\n\n')
      .replace(/<\/system-reminder\s*>/gi, tag => `<\\${tag.slice(1)}`)
    return createUserMessage({
      content: [{ type: 'text', text: `<system-reminder>\n${CONTEXT_INTRO[framing]}\n\n${body}\n</system-reminder>` }],
      source: {
        kind: SOURCE,
        form: 'snapshot',
        sections,
        ...framing === 'changed' ? { partial: true as const } : {},
      },
    })
  }
}
