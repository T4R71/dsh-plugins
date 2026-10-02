/**
 * The dsh-task-tree bundle is discoverable by the real manager: a profile whose
 * manifest holds the package as a dependency lists it as a bundle, and the rows
 * it contributes are exactly the rows its cordis.patch.yml declares.
 *
 * The package is installed in this workspace, so instead of a hand-written
 * fixture package under the profile the test links the REAL package directory
 * into the profile node_modules. What is exercised is therefore the shipped
 * manifest and patch, not a copy of their shape.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { boot, initProfile, readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-plugin-manager'

/** The bundle under test, and the rows its patch is expected to insert. */
const BUNDLE = '@t4r71/dsh-task-tree'
// The host row is @t4r71/dsh-plan-tree: the panel reads the plan tree out of
// plan-tree's OWN settings namespace, which only plan-tree provides. The former
// @t4r71/dsh-task-tree-host package was deleted on 2026-09-29 (its consumer-less
// `taskTree` projection wrote a session event type outside the 0.1.7 whitelist,
// which refuses the whole log on reopen).
const HOST_ROW = '@t4r71/dsh-plan-tree'
const UI_ROW = '@t4r71/dsh-ui-task-tree'
// The collapse row: one first-class `task` tool that replaces the orchestration five
// and the plan-tree four. It is listed AFTER the host rows because the tool reaches the
// tree through the `taskTree` service the host row provides, and row order is load order.
const TASK_ROW = '@t4r71/dsh-task'
// The plan tree's state row: the settings namespace `plan-tree-sessions`, whose id
// IS the Loader entry id. Without it the tools have no document to write and the
// panel has none to read.
const STORE_ROW = '@t4r71/dsh-plan-tree/session-store'

/** The shipped bundle package directory, resolved from this test file. */
const BUNDLE_DIR = fileURLToPath(new URL('../', import.meta.url))

it('lists the task-tree bundle with the rows its shipped patch declares', async (t) => {
  const home = await realpath(mkdtempSync(join(tmpdir(), 'task-tree-bundle-')))
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core'])

  // The profile always starts from a core bundle row (manager.spec.ts builds
  // the same one); the profile root otherwise cannot resolve its own include.
  const core = join(dir, 'node_modules', 'core')
  mkdirSync(core, { recursive: true })
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'core', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  // The manager itself is a row, not an ambient service: the profile config is
  // the only thing that mounts it, and everything below reads it through there.
  writeFileSync(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'manager', name: 'cordis:manager' }] }]))

  // The real package, copied into the profile so resolveBundleDir finds it
  // exactly as an installed dependency would be found. `lib` is not needed:
  // listBundles reads the manifest and the patch without loading JavaScript.
  const target = join(dir, 'node_modules', BUNDLE)
  mkdirSync(join(dir, 'node_modules', '@t4r71'), { recursive: true })
  cpSync(BUNDLE_DIR, target, { recursive: true })
  // A profile dependency is what makes the manager consider the name at all.
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { [BUNDLE]: '0.1.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')

  const profile: ProfileContext = {
    name: 'test',
    startedBundles: ['core'],
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
  })
  // vitest's onTestFinished had no node:test equivalent in this form;
  // the test context's own after() hook carries the same teardown.
  t.after(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })

  const listed = (await ctx.pluginManager.listBundles()).find(row => row.name === BUNDLE)
  // The bundle is VISIBLE. Rows are asserted by their declared ids and module
  // names rather than by entryId: the profile mounts no live row for this
  // bundle here (it is not selected), so no entry exists to name.
  assert.ok(listed !== undefined)
  assert.partialDeepStrictEqual(listed, {
    name: BUNDLE,
    version: '0.1.0',
    enabled: false,
    installed: true,
    optional: false,
  })
  assert.deepStrictEqual(listed.rows, [
    { rowId: 'plan-tree', moduleName: HOST_ROW },
    { rowId: 'plan-tree-sessions', moduleName: STORE_ROW },
    { rowId: 'task', moduleName: TASK_ROW },
    { rowId: 'task-tree-ui', moduleName: UI_ROW },
  ])
})