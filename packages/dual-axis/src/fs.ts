/**
 * The filesystem backend half of the dual-axis bundle, as its own entry point.
 *
 * It lives behind the `@t4r71/dsh-dual-axis/fs` subpath so the bundle's
 * default entry stays free of a `dsh-fs-sandbox` runtime import: a deployment
 * that only wants the axes and the settings page mounts the `dual-axis` row,
 * and a deployment replacing the sandboxed filesystem mounts
 * `dual-axis-fs` (both rows are in this package's `cordis.patch.yml`).
 *
 * @module @t4r71/dsh-dual-axis/fs
 */

export { DualAxisFileSystem, readAxisRefusal, readAxisRefusalAsync } from './fs-fence.ts'
export type { ReadAxes } from './fs-fence.ts'

export { DualAxisFileSystem as default } from './fs-fence.ts'
