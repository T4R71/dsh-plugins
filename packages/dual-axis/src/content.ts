/**
 * Whether a session has been USED yet — the one predicate that decides when its
 * axis pair freezes.
 *
 * A session the workspace picker reopens in the same workspace is the same
 * session id with the same stored record, so the axes it was seeded with at
 * creation are what its two dropdowns show for the rest of its life. That is
 * correct for a session someone has actually worked in; for one nobody has ever
 * exchanged a turn with it is wrong, because the settings row is a live default
 * and the person changing it expects the next conversation to follow.
 *
 * So the record is written when the session is used, not when it is created:
 *
 * - nothing appended beyond the loop's runtime-context snapshot → no record; the
 *   seed recomputed from the CURRENT settings row answers every read, so the
 *   dropdown follows the settings page in real time;
 * - one real user turn, or an assistant reply → the record is written and the
 *   pair freezes;
 * - `/axis` → {@link SessionAxesStore.set} writes unconditionally, so a manual
 *   pick always freezes, on an empty session too.
 *
 * ## What counts as "content"
 *
 * Everything except a message whose source is the loop's own runtime-context
 * snapshot. That snapshot is appended by the agent loop on EVERY turn
 * (`packages/core/agent-loop/src/runtime-context.ts`), including the very first
 * one, and it is present before any human input exists — the four events a
 * freshly created session carries are the header, the preset, the mode, and the
 * approval policy. Counting it would make every session look used the moment
 * anything rendered its prompt, which is exactly the state this predicate has to
 * tell apart.
 *
 * The snapshot is identified by its `source.kind`, the discriminant the loop
 * writes and reads back (`isOwned` in that module requires `kind === 'plugin'`;
 * the system-prompt renderer stamps `kind: 'runtime-context'`). Matching on the
 * kind is cheaper and more robust than matching the rendered text, which is
 * localized prose that changes with every contribution.
 *
 * Every other message counts, the skill catalogue and the compaction markers
 * included: each of them means the session has entered a turn, and a session
 * that has entered a turn is one somebody is using.
 *
 * @module @t4r71/dsh-dual-axis/content
 */

import type { Session } from '@deepseek-ai/dsh-session'

/**
 * The `source.kind` of the loop's per-turn runtime-context snapshot.
 *
 * @see `packages/core/agent-loop/src/runtime-context.ts` — `RuntimeContextProjection.project`
 *   builds the message, and the renderer in
 *   `packages/core/system-prompt/src/index.ts` stamps this kind on it.
 */
const RUNTIME_CONTEXT_KIND = 'runtime-context'

/**
 * The event types that can carry content, so a listener can skip the rest without
 * building the session's whole event list.
 *
 * A `system/message` is in here because it only exists once a turn has started,
 * and a started turn is a used session. The prompt is assembled and that event
 * appended BEFORE the human message reaches the log (measured: `system/message`
 * at seq 7, the user turn at seq 8), so a rule that waited for the user message
 * alone would let a tool-less turn finish without freezing anything.
 */
export const CONTENT_EVENT_TYPES: ReadonlySet<string> = new Set(['user/message', 'assistant/message', 'system/message'])

/**
 * Whether a session has content beyond the loop's own runtime-context snapshots.
 *
 * Cheap by construction: it walks the session's existing event array, which is
 * already materialized and cached, without copying, parsing, or allocating per
 * event. It is called on every `ensure` for a session that has no record, and
 * that set is exactly the sessions nobody has used — so the scan is short.
 * @param session - the session to judge.
 * @returns whether this session has been used.
 */
export function hasContent(session: Session): boolean {
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message') {
      // The one message a fresh session acquires, and the one that must not count.
      // A message carrying no source is treated as content: freezing is the safe
      // direction, so an unrecognized event must not be read as "still empty".
      const source = event.data.source as { kind?: unknown } | undefined
      if (source?.kind === RUNTIME_CONTEXT_KIND) continue
      return true
    }
    if (event.type === 'assistant/message' || event.type === 'system/message') return true
  }
  return false
}
