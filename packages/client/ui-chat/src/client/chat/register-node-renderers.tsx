import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { compactionRows } from './compaction-preview.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PerformanceUsageMode } from '../../chat-settings.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import { NS } from '../locale.ts'
import type { ChatNodeBodyProps, UsePresentation } from '../contract/slots.ts'
import { AssistantBodyOnly, AssistantNodeView, type AssistantNodeInjected } from './AssistantNodeView.tsx'
import { sessionFilePath } from '../file-path.ts'
import { CommandNodeView, ManualCompactionNodeView } from './CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, InheritedHistoryNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from './MessageItem.tsx'
import { DefaultReasoningBody, ReasoningContent } from './ReasoningContent.tsx'
import { SystemPromptNodeView } from './SystemPromptRow.tsx'
import { TurnProcessNodeView } from './TurnProcessNodeView.tsx'
import { TurnTailNodeView } from './TurnTailNodeView.tsx'
import { TurnTriggerNodeView } from './TurnTriggerNodeView.tsx'

/**
 * The reply-body renderer handed to a third-party `assistant-step` entry.
 *
 * Chat's own body renders through Hooks the seat supplies (its Turn data, the
 * disclosure and process-fold state, the Chat view's file opener, image loader,
 * locale and slot renderer). A foreign entry owns the seat but not those
 * inputs, so the answer is a second renderer built for a body-only call: the
 * reply's markdown, reasoning disclosures and images, with the shared
 * presentation policy, and without the per-Turn process folding, file mentions
 * or text-selection sources that depend on the seat.
 * @param props - the Node occurrence to render.
 * @param presentation - live presentation policy.
 * @returns the reply body element.
 */
function renderAssistantBody(
  props: ChatNodeBodyProps,
  presentation: ObservableSnapshot<ChatPresentationPolicy>,
): ReactNode {
  // The observable snapshot source is the selector-hook seat: its snapshot IS
  // the selector's input, which is what `usePresentation` receives.
  const usePresentation = presentation.getSnapshot as unknown as UsePresentation
  return <AssistantBodyOnly {...props} usePresentation={usePresentation} />
}

/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * Renderers whose output depends on the work-details mode receive the policy
 * through their own registration; the seat and the other renderers do not.
 * @param ctx - owning UI Conversation context.
 * @param performanceUsage - live statistics detail preference.
 * @param presentation - live presentation policy.
 */
export function registerChatNodeRenderers(
  ctx: Context,
  performanceUsage: ObservableSnapshot<PerformanceUsageMode>,
  presentation: ObservableSnapshot<ChatPresentationPolicy>,
): void {
  const injectCompaction = compactionRows(ctx)
  ctx.effect(() => ctx.slots.registerFactory({
    name: 'conversation.chat.reasoning.content',
    scope: 'root',
    locale: NS,
  }, ReasoningContent))
  ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register({
    name: 'conversation.chat.reasoning.body',
    priority: 100,
  }, DefaultReasoningBody))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'user', locale: NS,
    children: { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } },
  }, UserMessageNodeView))
  // Steering rows share the renderer without owning the message-source seat.
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'steering', locale: NS,
    inject: () => ({ renderSlotChain: () => null }),
  }, UserMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'context', locale: NS }, ContextMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-trigger', locale: NS }, TurnTriggerNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'system-prompt', locale: NS }, SystemPromptNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    locale: NS,
    children: {
      'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
      'conversation.chat.message.images': { kind: 'single', scope: 'session' },
      'conversation.chat.assistant-row': { kind: 'list', scope: 'session' },
    },
    inject: (sessionId): AssistantNodeInjected => ({
      hooks: { presentation },
      resolveFilePath: sessionFilePath(ctx, sessionId),
      fileMentions: (owner, getFileTriggerProps) => ctx.get('chatFileMentions')?.forClosing(owner, sessionId, getFileTriggerProps),
      renderAssistantBody: props => renderAssistantBody(props, presentation),
    }),
  }, AssistantNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command',
    locale: NS,
    children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
  }, CommandNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'manual-compaction', locale: NS, inject: injectCompaction }, ManualCompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction', locale: NS, inject: injectCompaction }, CompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'inherited-history', locale: NS }, InheritedHistoryNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'model-retry', locale: NS }, RetryNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-error', locale: NS }, TurnErrorNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-max-tokens', locale: NS }, TurnMaxTokensNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-process', locale: NS }, TurnProcessNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-tail',
    locale: NS,
    inject: () => ({ hooks: { performanceUsage } }),
    children: {
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    },
  }, TurnTailNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'unknown', locale: NS }, UnknownNodeView))
}
