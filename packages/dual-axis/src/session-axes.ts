/**
 * The write axis's landing place in a session's LOG, and the reason it is the
 * only one.
 *
 * 0.1.6 carried both axes on the \`sandbox/mode\` event (\`readScope\` /
 * \`writeScope\` members) and wrote them through \`setSandboxScopes\`. 0.1.7's
 * \`sandbox/mode\` payload is locked to \`{ mode, source }\` in three independent
 * places — the \`SessionEventMap\` declaration
 * (\`packages/sandbox/sandbox-policy/src/session-mode.ts:33-38\`), the session-format
 * validator
 * (\`packages/session/session-format-v0-to-v1/src/payload-validation.ts:165-168\`),
 * and the generated schema (\`docs/persistence-schema.json:11132-11147\`) — so the
 * path-level axis pair cannot ride on it.
 *
 * A package-declared event type is not an alternative: \`Session.append\`
 * (\`packages/core/session/src/index.ts:722-750\`) builds the envelope as exactly
 * \`{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }\` and takes no envelope
 * option, so a type outside \`KNOWN_SESSION_EVENT_TYPES\` cannot be marked
 * \`ignorable\` (the marker exists only on the READ side,
 * \`packages/session/session-persistence/src/storage-contract.ts:75\`) and a log
 * carrying it is refused whole. That refusal is why the pair now lives in
 * \`./session-store.ts\` instead.
 *
 * What REMAINS here is the write base's mirror onto \`sandbox/mode\`: a known type,
 * carrying the closed three-value mode the operating-system layer enforces. The
 * mirror is the NARROWER of the two axes' bases, never the write axis's own —
 * the effective write range is the write axis intersected with the read axis, so
 * mirroring the wider base would leave the layer below the tool fence granting
 * writes the intersection forbids.
 *
 * @module @t4r71/dsh-dual-axis/session-axes
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { modeOfAxisBase } from './axis.ts'
import type { EffectiveScopes } from './axis.ts'
import { narrowerBase } from './groups.ts'

/**
 * Mirror one session's write base onto 0.1.7's own \`sandbox/mode\` event, so the
 * inherited write fence and the system-prompt policy section agree with the axis
 * pair this package stores.
 *
 * The mirrored TIER is derived from the two axes' bases only, never from a rule
 * group's contents, so editing a group cannot leave this event stale. Path-level
 * narrowing is enforced live, where the group definitions are read.
 *
 * The event is appended even when it repeats the standing mode: \`sandbox/mode\`
 * carries no idempotence contract, and a session that gained axes without a
 * matching mode record would have its write fence read a stale mode.
 * @param session - the session the axes belong to.
 * @param axes - the axis pair in force from this event onward.
 */
export function mirrorWriteMode(session: Session, axes: EffectiveScopes): void {
  setSandboxMode(session, modeOfAxisBase(narrowerBase(axes.write, axes.read)))
}
