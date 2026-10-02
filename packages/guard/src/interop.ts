/**
 * The three hooks this package adds that the guard's own dependency set does
 * not declare.
 *
 * ## Why a declaration lives here
 *
 * Cordis's \`Events\` interface is merge-extensible, and each producer declares
 * its own hooks in its own module. The guard's \`package.json\` deliberately
 * depends on only the packages it reads at runtime, and \`tools/post-execute\`,
 * \`tools/ptc-dispatch-log\`, and \`session/event\` are declared by
 * \`@deepseek-ai/dsh-tools\` and \`@deepseek-ai/dsh-session\` — two packages this
 * one has no other reason to import. Adding them to \`dependencies\` to satisfy
 * the compiler would put two packages in the published dependency graph for
 * types alone.
 *
 * A local declaration has a cost worth naming: it can drift from the shipped
 * one. It is therefore written to match the published catalogue exactly —
 * \`dsh-tool-cordis/lib/types/api-catalog.js:4132-4137\` (\`session/event\`),
 * \`:4228-4233\` (\`tools/post-execute\`), \`:4244-4249\`
 * (\`tools/ptc-dispatch-log\`) — and each field below cites the declaration it
 * was copied from. The build fails if a signature stops matching, because a
 * listener registered against the wrong payload type will not typecheck against
 * this interface either.
 *
 * All of it is types: nothing in this block exists at runtime.
 *
 * @module @t4r71/dsh-guard/interop
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
/**
 * The `this` type of every listener in this file.
 *
 * Left structural rather than the real `Scoped<...>` carrier: nothing in this
 * package reads from the listener's `this`, and naming the concrete carrier
 * would add a dependency on `@deepseek-ai/dsh-scope` for a value that is never
 * used.
 */
type ListenerThis = unknown

/** Lossless JSON, as the tool-result union types it. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * One post-commit session event, as \`session/event\` delivers it.
 *
 * The real \`SessionEvent\` is a mapped union over \`SessionEventMap\`
 * (\`api-catalog.js:6436\`). This build reads exactly two fields of exactly one
 * member of that union — a \`compaction/summary\` event's \`type\` and its
 * \`data\` — and reads everything inside \`data\` through a type guard, so a
 * narrow structural type is both sufficient and more honest than a copy of the
 * whole union would be: it cannot claim to know members it never inspects.
 */
export interface ObservedSessionEvent {
  /** The event's discriminator, e.g. \`'compaction/summary'\`. */
  readonly type: string
  /** The event's payload, unread unless \`type\` is one this module handles. */
  readonly data: unknown
  /** Monotonic session seq, used only for the ledger's ordering. */
  readonly seq?: number
}

/**
 * The tools the guard's \`tools/post-execute\` listener reads.
 *
 * \`ToolExecution\` is \`api-catalog.js:7543\`; the three fields below are the
 * ones this package actually touches. \`agent\` is optional because a call made
 * outside any agent has no session to keep per-session state on.
 */
export interface ObservedToolExecution {
  /** The tool's registered name. */
  readonly name: string
  /** Parsed arguments; read through a type guard by every consumer. */
  readonly arguments: unknown
  /** The calling agent, when there is one. */
  readonly agent?: {
    readonly session: { readonly id: string }
  }
}

/**
 * The result \`tools/post-execute\` hands its listeners, narrowed to what is read.
 *
 * \`ToolExecutionResult\` is \`api-catalog.js:7559-7563\`. Only \`isError\` and
 * \`content\` are inspected here; \`value\` is never touched, which is what keeps
 * this listener independent of the tool's output schema.
 */
export interface ObservedToolResult {
  /** Whether the dispatch failed. */
  readonly isError: boolean
  /** The blocks the model would otherwise receive. */
  readonly content: readonly ContentBlock[]
}

/** The \`tools/post-execute\` decision, per \`api-catalog.js:5911-5912\`. */
export type ObservedPostToolDecision =
  | { readonly kind: 'accept', readonly content?: ContentBlock[], readonly value?: never }
  | { readonly kind: 'accept', readonly value: JsonValue, readonly content?: never }
  | { readonly kind: 'block', readonly feedback: ContentBlock[] }

/**
 * The \`tools/ptc-dispatch-log\` payload, per \`api-catalog.js:6043-6044\`.
 *
 * Deliberately the whole interface and not a narrowing: this listener returns
 * the blocks that get logged, so it receives the complete dispatch description
 * and must not appear to accept less than the seam hands over.
 */
export interface ObservedPtcDispatchLog {
  /** The parent execution. */
  readonly exec: ObservedToolExecution
  /** The parent agent, when the dispatch belongs to one. */
  readonly agent?: { readonly id?: string }
  /** The sub-call's identity. */
  readonly subCallId: string
  /** The sub-call's tool name. */
  readonly name: string
  /** Whether the sub-call failed. */
  readonly isError: boolean
  /** The settled content the bridge is about to log. */
  readonly content: ContentBlock[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Post-commit, fire-and-forget append feed
     * (\`api-catalog.js:4132-4137\`).
     *
     * \`@mode emit\`, and read-only by construction: the callback runs after the
     * log push and has no return value, so this seam can observe a committed
     * event and can never veto or alter it.
     */
    'session/event'(this: ListenerThis, session: Session, event: ObservedSessionEvent): void

    /**
     * Accept, replace, enrich, or block a normalized dispatch result
     * (\`api-catalog.js:4228-4233\`).
     *
     * \`@mode waterfall\`; the returned decision is what the runtime accepts.
     */
    'tools/post-execute'(this: ListenerThis, exec: ObservedToolExecution, result: Readonly<ObservedToolResult>, next: () => Promise<ObservedPostToolDecision>): Promise<ObservedPostToolDecision>

    /**
     * Replace content in the durable log copy of one \`run_code\` sub-dispatch
     * outcome (\`api-catalog.js:4244-4249\`).
     *
     * \`@mode waterfall\`; \`next()\` keeps the content unchanged, and the returned
     * blocks are what the bridge appends. Only the logged copy is affected — the
     * program already received the complete value.
     */
    'tools/ptc-dispatch-log'(this: ListenerThis, dispatch: ObservedPtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
  }
}

/** Re-exported so a listener can name these without a second import. */
export type { UserMessage }
