/** Request metadata exposed to pi-ai transport-header contributors. */

import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Model-hidden routing metadata from the exact prepared adapter call. */
export interface PiAiRequestHeaderContext extends Readonly<Pick<GenerateOptions<string>,
  'provider' | 'model' | 'sessionId' | 'purpose'>> {
  /** Resolved endpoint of the model selected for this call. */
  readonly baseURL: string
}

/** The provider's terminal pi-ai message for one stream call, tagged with its route. */
export interface PiAiTerminalMessage {
  /** Harness provider route that made the call. */
  readonly provider: string
  /** Harness model id requested on that route. */
  readonly model: string
  /**
   * The pi-ai message the provider ended the stream with: the finished
   * response for a completion, or the failed one for an in-stream error. It
   * carries everything pi-ai retained from the wire, including provider usage
   * statistics that the Harness `TokenUsage` vocabulary drops.
   */
  readonly message: AssistantMessage
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Observe the provider's terminal pi-ai message for one stream call,
     * dispatched by `llm-pi-ai` after the provider's final event and before
     * the terminal `usage` chunk leaves the adapter. A completion calls it
     * once with pi-ai's finished message; an in-stream failure calls it with
     * the failed one.
     *
     * Model-hidden observation, never model input: a listener must not alter
     * the message, must be synchronous, and must never throw on provider data,
     * because a throw fails the model request it observes.
     * @mode emit
     * @param detail - the route that made the call and the native message it ended with.
     */
    'llm-pi-ai/terminal-message'(detail: PiAiTerminalMessage): void
  }
}
