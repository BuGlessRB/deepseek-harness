import { Fragment, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { AssistantBlock } from '../contract/snapshot.ts'
import type {
  ChatFileMentions, ChatNodeInjected, ChatNodeViewProps, PresentationInjected, TurnTailOwnerProps, UsePresentation,
} from '../contract/slots.ts'
import { BODY_LABELS } from './body-labels.ts'
import { markdownLabels } from '../markdown-labels.ts'
import { AssistantMarkdown, localPathMediaUrl } from './AssistantMarkdown.tsx'
import css from './AssistantMarkdown.module.css'
import { ReasoningRow } from './ReasoningRow.tsx'

/** Business readers owned by the assistant renderer's existing Slot registration. */
export interface AssistantNodeInjected extends PresentationInjected, Pick<ChatNodeInjected, 'renderAssistantBody'> {
  /** Resolve against the live Session directory. @param path - Recorded path. @returns Host path. */
  resolveFilePath: (path: string) => string
  /** Resolve closing-Turn mentions with the supplied ordinary file gesture callback. */
  fileMentions: (owner: TurnTailOwnerProps, getFileTriggerProps: NonNullable<Parameters<ChatFileMentions['forClosing']>[2]>) => ReturnType<ChatFileMentions['forClosing']>
}

type AssistantNodeViewProps = ChatNodeViewProps<'assistant-step'> & InjectFace<AssistantNodeInjected>
  & PropsRenderSlots<
    'conversation.chat.reasoning.body' | 'conversation.chat.message.images' | 'conversation.chat.assistant-row'
  >

/**
 * One reply's body: markdown text, reasoning disclosures, images, and the
 * interrupted marker — everything an assistant Node shows above its action row.
 *
 * Split from the seat's row so a third-party `assistant-step` entry that seats
 * its own row can still render the Host's body through `renderAssistantBody`,
 * keeping the markdown pipeline in this package.
 */
export const AssistantBody = memo(function AssistantBody({
  node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, loadImage, fileMentions,
  usePresentation, renderSlot, t, sessionId, useContextMenu, resolveFilePath,
}: AssistantNodeViewProps) {
  const { getTriggerProps } = useContextMenu()
  const getFileTriggerProps = useCallback((path: string) => getTriggerProps(() => ({
    kind: 'file', value: { sessionId, path: resolveFilePath(path) },
  })), [getTriggerProps, sessionId, resolveFilePath])
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner, getFileTriggerProps),
    [fileMentions, owner, getFileTriggerProps],
  )
  const keepReplies = usePresentation(policy => policy.foldedReplies === 'all')
  // A kept reply row stays visible while the folded Turn hides its inline reasoning.
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && (keepReplies
      ? groupPart !== 'reasoning'
      : turnProcess.spec.answerStep === data.step && turnProcess.spec.inlineReasoning)
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  return (
    <AssistantMarkdown
      blocks={data.blocks}
      groupPart={groupPart}
      useDisclosure={useDisclosure}
      streaming={data.status === 'running'}
      textInteractionSource={data.status === 'settled' && data.finalNode?.messageId !== undefined}
      interrupted={data.status === 'interrupted'}
      loadImage={loadImage}
      reasoningHidden={reasoningHidden}
      useGroupAction={useGroupAction}
      usePresentation={usePresentation}
      renderSlot={renderSlot}
      revealProcess={revealProcess}
      mentions={mentions}
      t={t}
    />
  )
})

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView(props: AssistantNodeViewProps) {
  return (
    <>
      <AssistantBody {...props} />
      {props.renderSlot('conversation.chat.assistant-row', { node: props.node })}
    </>
  )
})

/** The seat-less body's copy for its language, read from the page language. */
let bodyLabels: Record<string, string> = BODY_LABELS.en ?? {}

/** Re-resolve the body copy after the page language changes. */
function syncBodyLabels(): void {
  if (typeof document === 'undefined') return
  const tag = document.documentElement.lang || 'en'
  bodyLabels = BODY_LABELS[tag] ?? BODY_LABELS[tag.split('-')[0] ?? 'en'] ?? BODY_LABELS.en ?? {}
}

/** A locale seat for Markdown chrome outside the Chat view. */
function browserText(key: string): string {
  return bodyLabels[key] ?? key
}

/** The reply's text blocks as Markdown, for a body rendered outside the Chat seat. */
function BodyMarkdown({ blocks, streaming, usePresentation }: {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  usePresentation: UsePresentation
}) {
  const labels = useMemo(() => markdownLabels(browserText), [])
  const pathImages = useMemo<MarkdownPathImages>(() => ({
    resolve: value => localPathMediaUrl(document.baseURI, value),
  }), [])
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'text') {
          return (
            <MarkdownText key={index} text={block.text} streaming={streaming} labels={labels} pathImages={pathImages} />
          )
        }
        if (block.kind === 'reasoning') {
          if (block.text.trim() === '') return null
          return (
            <ReasoningRow
              key={index}
              text={block.text}
              running={streaming && index === blocks.length - 1}
              usePresentation={usePresentation}
              useDisclosure={useLocalDisclosure}
              renderSlot={renderBodyReasoning}
              t={browserText}
            />
          )
        }
        if (block.kind === 'image') {
          const start = index
          const group = [block]
          while (index + 1 < blocks.length && blocks[index + 1]?.kind === 'image') {
            group.push(blocks[index + 1] as typeof block)
            index += 1
          }
          return (
            <Fragment key={start}>
              {group.map(({ attachment }) => (
                // The seat-less body has no attachment loader, so an image block
                // keeps its place as its alt text instead of a broken source.
                <span key={attachment.attachmentId} className="dsh-chat-body-image">{attachment.name ?? ''}</span>
              ))}
            </Fragment>
          )
        }
        // Tool calls render as their own rows; other blocks belong to the seat.
        return null
      })}
    </>
  )
}

/** Reasoning body for a seat-less reply: Chat's compact Markdown without its Factory. */
function BodyReasoningBody({ text, running }: { text: string; running: boolean }) {
  const labels = useMemo(() => markdownLabels(browserText), [])
  return <MarkdownText text={text} streaming={running} labels={labels} variant="compact" />
}

/** The reasoning Body Slot call a seat-less reply makes, in place of the Chat view's dispatcher. */
const renderBodyReasoning = ((
  _key: 'conversation.chat.reasoning.body',
  owner: { readonly rawText: string; readonly text: string; readonly running: boolean },
): ReactNode => <BodyReasoningBody text={owner.text} running={owner.running} />) as unknown as
  PropsRenderSlots<'conversation.chat.reasoning.body'>['renderSlot']

/** One reasoning row's local open state, in the Chat view's disclosure shape. */
function useLocalDisclosure(): { readonly expanded: boolean; readonly setExpanded: (open: boolean) => void; readonly toggle: () => void } {
  const [expanded, setExpanded] = useState(false)
  return { expanded, setExpanded, toggle: () => { setExpanded(value => !value) } }
}

/**
 * A reply body for an entry that owns the `assistant-step` seat without the
 * Chat view's inputs: Markdown text, reasoning disclosures and images, with no
 * file mentions, selection sources or Turn-level folding.
 * @param props - the Node and the live presentation policy.
 * @returns the reply body.
 */
export const AssistantBodyOnly = memo(function AssistantBodyOnly({
  node, usePresentation,
}: { node: ChatNode<'assistant-step'>; usePresentation: UsePresentation }) {
  useEffect(() => { syncBodyLabels() })
  const data = node.data
  const streaming = data.status === 'running'
  return (
    <div className={css.bodyOnly}>
      <BodyMarkdown blocks={data.blocks} streaming={streaming} usePresentation={usePresentation} />
      {data.status === 'interrupted' && <span className={css.stopped}>{bodyLabels['message.stopped'] ?? ''}</span>}
    </div>
  )
})
