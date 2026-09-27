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
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-plugin-manager'

/** The bundle under test, and the rows its patch is expected to insert. */
const BUNDLE = '@t4r71/dsh-task-tree'
const HOST_ROW = '@t4r71/dsh-task-tree-host'
const UI_ROW = '@t4r71/dsh-ui-task-tree'

/** The shipped bundle package directory, resolved from this test file. */
const BUNDLE_DIR = fileURLToPath(new URL('../', import.meta.url))

it('lists the task-tree bundle with the rows its shipped patch declares', async () => {
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
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai'), { recursive: true })
  cpSync(BUNDLE_DIR, target, { recursive: true })
  // A profile dependency is what makes the manager consider the name at all.
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { [BUNDLE]: '0.1.6-alpha.2' }
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
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })

  const listed = (await ctx.pluginManager.listBundles()).find(row => row.name === BUNDLE)
  // The bundle is VISIBLE. Rows are asserted by their declared ids and module
  // names rather than by entryId: the profile mounts no live row for this
  // bundle here (it is not selected), so no entry exists to name.
  expect(listed).toMatchObject({
    name: BUNDLE,
    version: '0.1.6-alpha.2',
    enabled: false,
    installed: true,
    optional: false,
  })
  expect(listed?.rows).toEqual([
    { rowId: 'task-tree-host', moduleName: HOST_ROW },
    { rowId: 'task-tree-ui', moduleName: UI_ROW },
  ])
})