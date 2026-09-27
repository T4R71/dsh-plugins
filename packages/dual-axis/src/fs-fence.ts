/**
 * The READ-AXIS FENCE: the filesystem backend that enforces the session's read
 * axis in addition to 0.1.7's write fence.
 *
 * NOT MOUNTED, AND NOT WIRED TO THE SESSION AXIS STORE.
 *
 * Both facts are deliberate and both are load-bearing for anyone reading this
 * file, so they are stated here rather than left to the composition:
 *
 * - NOT MOUNTED. No profile composes the `dual-axis-fs` row; this package's own
 *   `cordis.patch.yml` carries it commented out, because installing this backend
 *   means taking the `fs` service away from the composition's own
 *   `fs-sandbox` row (`packages/fs/fs-sandbox/src/index.ts`), and two live rows
 *   registering one service fail startup outright.
 * - NOT WIRED. {@link ReadAxes} is a TRAILING PARAMETER on each override, the
 *   0.1.6 way of threading a policy. Nothing produces it: the session-qualified
 *   read fence actually in force is `./read-guard.ts`, which takes its session
 *   from `tools/pre-execute` because 0.1.7's filesystem read path carries no
 *   session at all. A caller that supplies no axes gets
 *   {@link DualAxisFileSystem.defaultAxes}, i.e. the deployment policy — never
 *   this package's per-session axis store (`./session-store.ts`). Mounting this
 *   backend WITHOUT wiring it therefore enforces the deployment default read
 *   axis for every session, which is not what the two composer dropdowns say.
 *
 * What it is still worth keeping for: {@link readAxisRefusal} and
 * {@link readAxisRefusalAsync} are the canonical containment predicates for a
 * read axis (sync lexical, async identity-resolving), and `tests/axis.spec.ts`
 * exercises every branch of them with no filesystem, session, or service.
 * Retiring the subclass means retiring that coverage with it.
 *
 * 0.1.7 deleted the read fence outright. Its `@deepseek-ai/dsh-fs-sandbox`
 * (147 lines) states the removal in its own header: "Reads pass through
 * untouched: every mode permits reading", and it overrides only
 * `writeText` / `editText`. 0.1.6's 358-line version fenced eight read
 * entry points. This subclass restores that fence on 0.1.7's own interface.
 *
 * It extends 0.1.7's `SandboxedFileSystem` rather than `LocalFileSystem`, so
 * the write fence is inherited unchanged and this class adds exactly one
 * thing: the read-path check. Every read override delegates to `super`,
 * which is the sandboxed write class's own inherited implementation — no
 * storage mechanic is re-implemented here.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary: canonicalize-then-contain is the complete answer to
 * this surface.
 *
 * @module @t4r71/dsh-dual-axis/fs-fence
 */
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'
import { effectiveScopes, type AxisScope, type EffectiveScopes } from './axis.ts'
import { resolveScope, scopeContains } from './scope.ts'

/** The axis pair a read carries; omitted members fall back to the deployment default. */
export type ReadAxes = Partial<Pick<EffectiveScopes, 'read'>>

/**
 * Decide whether one read axis permits one canonical target key. This is the
 * fence's entire decision, as a pure function: it takes the evaluated range and
 * the containment predicate, so a test can exercise every branch with no
 * filesystem, no session, and no service.
 *
 * The error message names the READ axis's kind, never the mode that would
 * spell it: a read axis of `workspace` would otherwise be reported as
 * "workspace-write", a WRITE mode name this axis has no concept of.
 * @param read - the read axis in force.
 * @param policy - the workspace root a `workspace` read axis derives from.
 * @param targetKey - the target's canonical identity key.
 * @param contains - the containment predicate.
 * @returns `undefined` when permitted, or the refusal message.
 */
export function readAxisRefusal(
  read: AxisScope,
  policy: { workspaceRoot: string },
  targetKey: string,
  contains: (path: string, root: string) => boolean,
): string | undefined {
  const scope = resolveScope(read, policy)
  if (scopeContains(scope, targetKey, contains)) return undefined
  return refuse(read)
}

/**
 * The async twin of {@link readAxisRefusal}: production containment
 * (`isPathUnder`) walks the filesystem identity chain for alias-equivalent
 * roots, so the fence cannot use the lexical predicate alone.
 * @param read - the read axis in force.
 * @param policy - the workspace root a `workspace` read axis derives from.
 * @param targetKey - the target's canonical identity key.
 * @param contains - the async containment predicate.
 * @returns `undefined` when permitted, or the refusal message.
 */
export async function readAxisRefusalAsync(
  read: AxisScope,
  policy: { workspaceRoot: string },
  targetKey: string,
  contains: (path: string, root: string) => Promise<boolean>,
): Promise<string | undefined> {
  const scope = resolveScope(read, policy)
  for (const root of scope.deny) {
    if (await contains(targetKey, root)) return refuse(read)
  }
  if (scope.unbounded) return undefined
  for (const root of scope.allow) {
    if (await contains(targetKey, root)) return undefined
  }
  return refuse(read)
}

/**
 * The single refusal message both predicates return, naming the READ axis's
 * kind rather than the write mode that would spell it.
 * @param read - the refused read axis.
 * @returns the refusal message.
 */
function refuse(read: AxisScope): string {
  return `file access denied under the ${read.kind} read axis`
}

/**
 * The read-axis-enforcing filesystem backend. Mount it in place of
 * `@deepseek-ai/dsh-fs-sandbox`: it registers the same `fs` service and
 * inherits that backend's write fence verbatim.
 */
export class DualAxisFileSystem extends SandboxedFileSystem {
  constructor(ctx: Context, config: ConstructorParameters<typeof SandboxedFileSystem>[1]) {
    super(ctx, config)
  }

  /**
   * The read axis pair of the session a read belongs to. Reads carry no
   * session, so the fence resolves the DEPLOYMENT default axes here; a caller
   * that knows the calling session passes them per call instead.
   * @returns the deployment default axis pair.
   */
  protected defaultAxes(): EffectiveScopes {
    return effectiveScopes(this.ctx.sandboxPolicy.resolve())
  }

  /**
   * Fence the caller's read path against the READ axis, then return the target
   * for the inherited read. The check happens BEFORE any disk access.
   * @param target - the target the caller already resolved.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the same target, once the read axis permits it.
   * @throws {FsError} `FS_SANDBOX_DENIED` when the read axis refuses the target.
   */
  protected async checkedRead(target: FsTarget, axes?: ReadAxes): Promise<FsTarget> {
    const policy = this.ctx.sandboxPolicy.resolve()
    const read = axes?.read ?? this.defaultAxes().read
    const refusal = await readAxisRefusalAsync(read, policy, target.targetKey, isPathUnder)
    if (refusal !== undefined) {
      throw new FsError(`cannot read "${target.displayPath}": ${refusal}`, 'FS_SANDBOX_DENIED')
    }
    return target
  }

  /**
   * Fence `lstat`'s string path by resolving the same target the inherited
   * implementation will inspect, then applying the read axis. The resolution
   * happens BEFORE the metadata read, so a refusal never touches the disk, and
   * the inherited call still receives the original arguments verbatim.
   * @param path - the requested path, relative to `opts.cwd` or the backend cwd.
   * @param opts - optional cwd for the resolution.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the target the inherited `lstat` will inspect.
   */
  protected async checkedReadPath(
    path: string,
    opts?: { cwd?: string },
    axes?: ReadAxes,
  ): Promise<FsTarget> {
    return this.checkedRead(await this.resolve(path, opts), axes)
  }

  /**
   * Fence the read by the per-call read axis, then delegate to the inherited
   * UTF-8 read.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the file content from the inherited backend.
   */
  override async readText(target: FsTarget, signal?: AbortSignal, axes?: ReadAxes): Promise<string> {
    return super.readText(await this.checkedRead(target, axes), signal)
  }

  /**
   * Fence the read by the per-call read axis, then delegate to the inherited
   * streaming read. The fence runs BEFORE the iterable is handed out: a refused
   * stream never produces a chunk.
   * @param target - the resolved target to stream.
   * @param signal - aborts the read.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the inherited chunk iterable.
   */
  override async streamText(target: FsTarget, signal?: AbortSignal, axes?: ReadAxes): Promise<AsyncIterable<string>> {
    return super.streamText(await this.checkedRead(target, axes), signal)
  }

  /**
   * Fence the read by the per-call read axis, then delegate to the inherited
   * bounded byte read.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @param maxBytes - inclusive byte cap on the complete content.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the file bytes from the inherited backend.
   */
  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
    axes?: ReadAxes,
  ): Promise<Uint8Array> {
    return super.readBytes(await this.checkedRead(target, axes), signal, maxBytes)
  }

  /**
   * Fence the read by the per-call read axis, then delegate to the inherited
   * byte-window read.
   * @param target - the resolved target to read.
   * @param range - `offset` and `length` of the window.
   * @param signal - aborts the read.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the byte window from the inherited backend.
   */
  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
    axes?: ReadAxes,
  ): Promise<Uint8Array> {
    return super.readByteRange(await this.checkedRead(target, axes), range, signal)
  }

  /**
   * Fence the listing by the per-call read axis, then delegate to the inherited
   * directory listing.
   * @param target - the resolved directory to list.
   * @param signal - aborts the listing.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the directory entries from the inherited backend.
   */
  override async listDir(target: FsTarget, signal?: AbortSignal, axes?: ReadAxes): Promise<FsDirEntry[]> {
    return super.listDir(await this.checkedRead(target, axes), signal)
  }

  /**
   * Fence the metadata read by the per-call read axis, then delegate to the
   * inherited stat.
   * @param target - the resolved target to inspect.
   * @param signal - aborts the metadata read.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the metadata, or `undefined` when the target is absent.
   */
  override async stat(target: FsTarget, signal?: AbortSignal, axes?: ReadAxes): Promise<FsInfo | undefined> {
    return super.stat(await this.checkedRead(target, axes), signal)
  }

  /**
   * Fence the no-follow metadata read by the per-call read axis, then delegate
   * to the inherited lstat with the caller's arguments unchanged.
   * @param path - the requested path, relative to `opts.cwd` or the backend cwd.
   * @param opts - optional cwd for the resolution.
   * @param signal - aborts the metadata read.
   * @param axes - the calling session's axis pair; omit for the deployment default.
   * @returns the path-entry metadata, or `undefined` when the entry is absent.
   */
  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
    axes?: ReadAxes,
  ): Promise<FsPathInfo | undefined> {
    await this.checkedReadPath(path, opts, axes)
    return super.lstat(path, opts, signal)
  }
}

export default DualAxisFileSystem
