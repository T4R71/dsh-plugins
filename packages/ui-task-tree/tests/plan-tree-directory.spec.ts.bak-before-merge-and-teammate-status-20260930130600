/**
 * 任务树目录的跟随测试：共享镜像 → 本地去重快照 → \`useSyncExternalStore\`。
 *
 * 钉住三件事：宿主写文档后镜像换快照，本目录**跟着换**；镜像重读但这份命名空间一字未变时
 * 本目录**不换**（否则每次重读都会把面板整棵重画）；以及三态在目录这一层仍然成立 ——
 * 目录不做自己的判断，它只是把镜像那一份文档交给纯读取。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { PlanTreeDirectory } from '../src/client/plan-tree.ts'

const NS = 'plan-tree-sessions'

/** 一棵最小的树。 */
const TREE = [{ id: 'root', title: '计划', status: 'pending' }]

/**
 * 一个可手动推进的 describe 镜像替身。
 *
 * 只实现本目录用到的三个成员（getSnapshot / subscribe / 外加以 \`publish\` 推动）。
 */
class FakeDescribeFace {
  private snapshot: SettingsMirrorSnapshot
  private readonly listeners = new Set<() => void>()

  /** @param initial - 初始快照。 */
  constructor(initial: SettingsMirrorSnapshot) {
    this.snapshot = initial
  }

  /** @returns 当前快照。 */
  getSnapshot(): SettingsMirrorSnapshot {
    return this.snapshot
  }

  /**
   * @param listener - 订阅者。
   * @returns 摘除函数。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 换一份快照并通知所有订阅者。 */
  publish(next: SettingsMirrorSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  /** 本目录不调用它，留着只是为了形状完整。 */
  ensure(): Promise<void> {
    return Promise.resolve()
  }

  /** 本目录不调用它，留着只是为了形状完整。 */
  acceptView(): void {}
}

/** 一份「已就绪」的快照，命名空间里带着给定的 trees 字段。 */
const ready = (trees: unknown): SettingsMirrorSnapshot => ({
  status: 'ready',
  view: { namespaces: [{ ns: NS, value: { trees } }], writable: true, hasDocument: true },
  error: null,
})

/** 把替身当成本包的镜像面用（形状相同，只多一个 publish）。 */
const faceOf = (fake: FakeDescribeFace): SettingsDescribeFace => fake as unknown as SettingsDescribeFace

test('the directory reads the namespace out of the mirror', () => {
  const fake = new FakeDescribeFace(ready({ s1: TREE }))
  const directory = new PlanTreeDirectory(faceOf(fake))
  assert.deepEqual(directory.treeOf('s1'), { state: 'record', roots: TREE })
  assert.deepEqual(directory.treeOf('s2'), { state: 'empty' })
  directory.dispose()
})

test('a mirror that has no answer yet reads as unreadable, not empty', () => {
  const fake = new FakeDescribeFace({ status: 'idle', view: undefined, error: null })
  const directory = new PlanTreeDirectory(faceOf(fake))
  assert.deepEqual(directory.treeOf('s1'), { state: 'unreadable' })
  directory.dispose()
})

test('a new document reaches the reader, and notifies subscribers once', () => {
  const fake = new FakeDescribeFace(ready({}))
  const directory = new PlanTreeDirectory(faceOf(fake))
  assert.deepEqual(directory.treeOf('s1'), { state: 'empty' })

  let notified = 0
  const off = directory.subscribe(() => { notified += 1 })
  fake.publish(ready({ s1: TREE }))
  assert.equal(notified, 1)
  assert.deepEqual(directory.treeOf('s1'), { state: 'record', roots: TREE })
  off()
  directory.dispose()
})

test('a re-read that changed nothing does NOT replace the snapshot', () => {
  const fake = new FakeDescribeFace(ready({ s1: TREE }))
  const directory = new PlanTreeDirectory(faceOf(fake))
  const held = directory.getSnapshot()

  let notified = 0
  const off = directory.subscribe(() => { notified += 1 })
  // 镜像每次重读都换一个对象，内容一字未变：本目录必须原地不动，否则面板每次重读
  // 都会重画整棵树（折叠状态、滚动位置都跟着抖）。
  fake.publish(ready({ s1: TREE }))
  assert.equal(notified, 0)
  assert.equal(directory.getSnapshot(), held)

  // 真变了才发布。
  fake.publish(ready({ s1: [...TREE, { id: 'b', title: 'B', status: 'pending' }] }))
  assert.equal(notified, 1)
  assert.notEqual(directory.getSnapshot(), held)
  off()
  directory.dispose()
})

test('a mirror that lost its document replaces the snapshot and reads as unreadable', () => {
  const fake = new FakeDescribeFace(ready({ s1: TREE }))
  const directory = new PlanTreeDirectory(faceOf(fake))
  let notified = 0
  const off = directory.subscribe(() => { notified += 1 })
  fake.publish({ status: 'unavailable', view: undefined, error: 'not loopback' })
  assert.equal(notified, 1)
  assert.deepEqual(directory.treeOf('s1'), { state: 'unreadable' })
  off()
  directory.dispose()
})

test('dispose stops the following; later publishes do not enter the directory', () => {
  const fake = new FakeDescribeFace(ready({}))
  const directory = new PlanTreeDirectory(faceOf(fake))
  let notified = 0
  directory.subscribe(() => { notified += 1 })
  directory.dispose()
  fake.publish(ready({ s1: TREE }))
  assert.equal(notified, 0)
  assert.deepEqual(directory.treeOf('s1'), { state: 'empty' })
})
