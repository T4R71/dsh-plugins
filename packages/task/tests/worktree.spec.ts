/**
 * 隔离检出（git worktree）那一半的单测：起线 / 同名接回 / 按功能提交 / 合回 / 收线。
 *
 * 这一支跑在**真的临时 git 仓**里，不用假件：要钉住的恰恰是「git 到底做了什么」——
 * 分支有没有真的建出来、合回之后主线是不是真的只前进了一个提交、整体验证没过时
 * 主线是不是**一个字节都没动**。换成内存假件，这些断言就只剩自说自话。
 *
 * 与 `task.spec.ts` 的分工：那支测**工具面**（参数、动作、简报、账本），
 * 这支测**模块语义**（一个函数被调用之后盘上发生了什么）。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  assertWorktreeName,
  commitFeature,
  createWorktree,
  detectLeak,
  dropWorktree,
  finalizeReport,
  git,
  gitWithIdentity,
  isolationPreamble,
  mergeWorktree,
  statusPorcelain,
  worktreeMatches,
  worktreePathFor,
  worktreeWorkflowNote,
} from '../src/worktree.ts'

/**
 * 造一个**干净的**临时 git 仓：一个初始提交，工作区干净。
 *
 * 干净是刻意的 —— `createWorktree` 对脏检出是**拒绝**而不是提示，
 * 所以每一条起线用例的起点都必须是它认的那一种。
 * @returns 仓库根目录的绝对路径。
 */
async function freshRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'task-wt-repo-'))
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'user.name', 'spec'])
  await git(repo, ['config', 'user.email', 'spec@local'])
  writeFileSync(join(repo, 'README.md'), '# seed\n', 'utf8')
  await git(repo, ['add', '-A'])
  await gitWithIdentity(repo, ['commit', '--no-verify', '-m', 'seed'])
  return repo
}

/**
 * 在工作区里造一个**未提交**的改动 —— `task commit` 之前工作区就长这样。
 * @param path - 工作区路径。
 * @param file - 文件名（相对工作区根）。
 * @param text - 内容。
 */
function dirty(path: string, file: string, text: string): void {
  writeFileSync(join(path, file), text, 'utf8')
}

/**
 * 在某个工作区里造一个文件并**提交**（带钉死的提交身份）。
 *
 * 只有「这条线上已经有一个提交」这类用例需要它；要测 `commitFeature` 时用
 * {@link dirty} —— 提交过了的改动在那儿的结局是「无改动，不造空提交」。
 * @param path - 工作区路径。
 * @param file - 文件名（相对工作区根）。
 * @param text - 内容。
 * @param message - 提交信息。
 */
async function commitFile(path: string, file: string, text: string, message: string): Promise<void> {
  dirty(path, file, text)
  await git(path, ['add', '-A'])
  const committed = await gitWithIdentity(path, ['commit', '--no-verify', '-m', message])
  assert.equal(committed.code, 0, '测试自身的提交必须成功：' + committed.stderr)
}

/**
 * 一段范围里的提交数。
 * @param cwd - 仓库或工作区。
 * @param range - `git rev-list` 的范围表达式。
 * @returns 提交数。
 */
async function revCount(cwd: string, range: string): Promise<number> {
  const counted = await git(cwd, ['rev-list', '--count', range])
  return counted.code === 0 ? Number.parseInt(counted.stdout.trim(), 10) || 0 : -1
}

/**
 * 某个路径当前 HEAD 的完整 hash。
 * @param cwd - 仓库或工作区。
 * @returns 40 位 hash。
 */
async function headOf(cwd: string): Promise<string> {
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  assert.equal(head.code, 0, '读 HEAD 必须成功：' + head.stderr)
  return head.stdout.trim()
}

/**
 * 最近一次提交的信息正文。
 * @param cwd - 仓库或工作区。
 * @returns 提交信息。
 */
async function lastMessage(cwd: string): Promise<string> {
  const log = await git(cwd, ['log', '-1', '--format=%B'])
  assert.equal(log.code, 0, '读提交信息必须成功：' + log.stderr)
  return log.stdout
}

it('起线：干净的主检出上真的建出检出与分支，且新检出自己是干净的', async () => {
  const repo = await freshRepo()
  const base = await headOf(repo)
  const line = await createWorktree({ repo, name: 'l1' })
  assert.equal(line.path, worktreePathFor(repo, 'l1'))
  assert.equal(line.branch, 'wt/l1')
  assert.equal(line.reused, false)
  // 分叉点必须**已经是一个 commit hash**：存一个 HEAD 下去，同一个字符串在线的检出
  // 与主检出里指的不是同一个提交（账本会跟着线跑，两处都要用这个值）。
  assert.equal(line.base, base)
  assert.ok(existsSync(join(line.path, 'README.md')), '分支的已提交内容必须在检出里')
  assert.equal(await statusPorcelain(line.path), '', '刚起好的线必须是干净的')
  assert.equal(await statusPorcelain(repo), '', '起线不该在主检出上留下任何东西')
  // 被 gitignore 的那几个文件是**复制**过去的：临时仓里没有它们，如实报成缺席。
  assert.deepStrictEqual([...line.copied], [])
  assert.deepStrictEqual([...line.missing], ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'])
})

it('脏主检出拒绝起线——绝不把在飞的改动当成已提交状态分叉出去', async () => {
  const repo = await freshRepo()
  dirty(repo, 'README.md', '# dirty\n')
  await assert.rejects(() => createWorktree({ repo, name: 'l1' }), /uncommitted changes/)
  assert.equal(existsSync(worktreePathFor(repo, 'l1')), false, '拒绝之后不许留下半个检出')
})

it('线名非法当场拒：它同时要当目录名与分支名', () => {
  assert.throws(() => assertWorktreeName('bad name'), /invalid worktree name/)
  assert.throws(() => assertWorktreeName('../escape'), /invalid worktree name/)
  assert.throws(() => assertWorktreeName(''), /invalid worktree name/)
  assert.doesNotThrow(() => assertWorktreeName('l1.beta-2'))
})

it('同名接回：检出被删掉而分支还在时接回原分支，已经提交的成果一个都不丢', async () => {
  const repo = await freshRepo()
  const first = await createWorktree({ repo, name: 'l1' })
  await commitFile(first.path, 'feat.txt', 'one\n', 'feat: A')
  // 模拟「检出被人手动删掉 / 收线收了一半」：目录没了，分支还在。
  await git(repo, ['worktree', 'remove', '--force', first.path])
  assert.equal(existsSync(first.path), false)
  const again = await createWorktree({ repo, name: 'l1' })
  assert.equal(again.reused, true, '同名必须接回，不许报「分支已存在」了事')
  assert.equal(again.path, first.path)
  assert.equal(again.branch, first.branch)
  assert.equal(await revCount(repo, again.base + '..' + again.branch), 1, '分支上那个提交还在')
  assert.equal(readFileSync(join(again.path, 'feat.txt'), 'utf8').trim(), 'one', '而且已经落到新检出里')
})

it('worktreeMatches：路径在、但那儿不是这条线时不许当成同一条线', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  assert.equal(await worktreeMatches(line.path, line.branch), true)
  assert.equal(await worktreeMatches(repo, line.branch), false, '主检出不是这条线的检出')
  assert.equal(await worktreeMatches(join(dirname(repo), 'nowhere-at-all'), line.branch), false)
})

it('commit：一档验证都没有 ⇒ 拒绝提交，一个字节都不动', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  dirty(line.path, 'a.txt', 'a\n')
  const outcome = await commitFeature({ name: 'l1', path: line.path, node: 'A', units: [{ name: 'unit-a' }] })
  assert.equal(outcome.committed, false)
  assert.equal(outcome.verification, 'none')
  assert.match(outcome.note, /没有任何一档验证/)
  assert.equal(await revCount(line.path, line.base + '..HEAD'), 0, '拒绝 = 一个提交都不产生')
})

it('commit：工作区无改动 ⇒ 不造空提交', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  const outcome = await commitFeature({ name: 'l1', path: line.path, node: 'A', units: [{ name: 'unit-a' }], verify: 'git status --porcelain' })
  assert.equal(outcome.committed, false)
  assert.equal(outcome.files, 0)
  assert.match(outcome.note, /no changes|无改动/)
  assert.equal(await revCount(line.path, line.base + '..HEAD'), 0)
})

it('commit：机械验证真跑、退出码进提交信息；一个提交可以汇总多个工作单元', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  dirty(line.path, 'a.txt', 'a\n')
  dirty(line.path, 'b.txt', 'b\n')
  const outcome = await commitFeature({
    name: 'l1',
    path: line.path,
    node: 'A',
    units: [{ name: 'unit-a' }, { name: 'unit-b' }],
    verify: 'git rev-parse --short HEAD',
  })
  assert.equal(outcome.committed, true, outcome.note)
  assert.equal(outcome.verification, 'machine')
  assert.equal(outcome.machine?.passed, true)
  assert.equal(outcome.machine?.code, 0)
  assert.equal(outcome.uncommitted, 0, '提交之后工作区是干净的')
  const message = await lastMessage(line.path)
  assert.match(message, /^A: unit-a \+ unit-b/m, '抬头要点名这次汇总了哪些单元：' + message)
  assert.match(message, /- unit-a/)
  assert.match(message, /- unit-b/)
  assert.match(message, /verify: "git rev-parse --short HEAD" \(exit 0, passed\)/)
  assert.equal(await revCount(line.path, line.base + '..HEAD'), 1, '两个单元 ⇒ 一个提交')
})

it('commit：机械验证没过时默认照样提交，把「未通过」如实记进提交信息（记录员不是守门员）', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  dirty(line.path, 'a.txt', 'a\n')
  const outcome = await commitFeature({ name: 'l1', path: line.path, node: 'A', units: [{ name: 'unit-a' }], verify: 'exit 3' })
  assert.equal(outcome.committed, true, outcome.note)
  assert.equal(outcome.machine?.passed, false)
  assert.equal(outcome.machine?.code, 3)
  assert.match(await lastMessage(line.path), /verify: "exit 3" \(exit 3, NOT passed\)/)
})

it('commit：onFail=block 时一个字节都不提交，真实输出交回调用方', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  dirty(line.path, 'a.txt', 'a\n')
  const outcome = await commitFeature({ name: 'l1', path: line.path, node: 'A', units: [{ name: 'unit-a' }], verify: 'exit 3', onFail: 'block' })
  assert.equal(outcome.committed, false)
  assert.equal(outcome.machine?.code, 3, '命令真跑了，退出码如实交回：' + JSON.stringify(outcome))
  assert.equal(await revCount(line.path, line.base + '..HEAD'), 0, '拦住 = 这条线的分支上没有新提交')
  assert.notEqual(await statusPorcelain(line.path), '', '未验证的改动留在工作区，不是被丢掉')
})

it('commit：判断档（verifiedBy + note）同样作数，并原样进提交信息', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  dirty(line.path, 'a.txt', 'a\n')
  const outcome = await commitFeature({ name: 'l1', path: line.path, node: 'A', units: [{ name: 'unit-a' }], verifiedBy: 'hub', note: 'read the diff' })
  assert.equal(outcome.committed, true, outcome.note)
  assert.equal(outcome.verification, 'judgement')
  assert.match(await lastMessage(line.path), /verified by: hub — read the diff/)
})

it('合回：这条线没声明整套检查 ⇒ 拒绝合回（fail-closed）', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  await commitFile(line.path, 'a.txt', 'a\n', 'feat: A')
  const before = await headOf(repo)
  const outcome = await mergeWorktree({ repo, path: line.path, branch: line.branch, base: line.base, name: 'l1', prepare: '' })
  assert.equal(outcome.merged, false)
  assert.match(outcome.note, /whole-suite check/)
  assert.equal(await headOf(repo), before, '拒绝 = 主线一个字节都没动')
})

it('合回：整体验证没过 ⇒ 主线一个字节没动、分支留着、临时集成检出被清掉', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  await commitFile(line.path, 'a.txt', 'a\n', 'feat: A')
  const before = await headOf(repo)
  const outcome = await mergeWorktree({ repo, path: line.path, branch: line.branch, base: line.base, name: 'l1', verify: 'exit 4', prepare: '' })
  assert.equal(outcome.merged, false)
  assert.match(outcome.note, /整体验证没过/)
  assert.equal(await headOf(repo), before, '主线必须原封不动')
  assert.equal(await statusPorcelain(repo), '', '而且没有留下冲突或未提交的烂摊子')
  assert.equal(existsSync(join(repo, 'a.txt')), false, '没验证过的东西不许出现在主线上')
  assert.equal(existsSync(join(dirname(repo), basename(repo) + '-wt-l1-merge')), false, '临时集成检出必须清掉')
  const branch = await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/wt/l1'])
  assert.equal(branch.code, 0, '分支留着，成果一个都不丢')
})

it('合回：整套检查过了 ⇒ 分支上多个提交合成主线上的一个整合提交', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  dirty(line.path, 'a.txt', 'a\n')
  const one = await commitFeature({ name: 'l1', path: line.path, node: 'A', units: [{ name: 'unit-a' }], verify: 'git rev-parse --short HEAD' })
  dirty(line.path, 'b.txt', 'b\n')
  const two = await commitFeature({ name: 'l1', path: line.path, node: 'B', units: [{ name: 'unit-b' }], verify: 'git rev-parse --short HEAD' })
  assert.equal(one.committed, true, one.note)
  assert.equal(two.committed, true, two.note)
  assert.equal(await revCount(line.path, line.base + '..HEAD'), 2, '分支上是两个按功能的提交')
  const outcome = await mergeWorktree({ repo, path: line.path, branch: line.branch, base: line.base, name: 'l1', verify: 'git rev-parse --short HEAD', prepare: '', title: 'merge l1: two units' })
  assert.equal(outcome.merged, true, outcome.note)
  assert.deepStrictEqual([...(outcome.features ?? [])], ['A: unit-a', 'B: unit-b'])
  const short = await git(repo, ['rev-parse', '--short=12', 'HEAD'])
  assert.equal(short.stdout.trim(), outcome.hash)
  assert.equal(await revCount(repo, 'HEAD'), 2, '主线只前进了一个提交（seed + 整合提交）')
  const message = await lastMessage(repo)
  assert.match(message, /merge l1: two units/)
  assert.match(message, /- A: unit-a/)
  assert.equal(existsSync(join(repo, 'a.txt')), true)
  assert.equal(existsSync(join(repo, 'b.txt')), true)
  assert.equal(existsSync(join(dirname(repo), basename(repo) + '-wt-l1-merge')), false, '临时集成检出清掉了')
})

it('收线：未合回时拒绝；合回（squash）之后照样收得掉', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  await commitFile(line.path, 'a.txt', 'a\n', 'feat: A')
  const refused = await dropWorktree({ repo, name: 'l1', path: line.path, branch: line.branch, base: line.base })
  assert.equal(refused.dropped, false)
  assert.match(refused.note, /拒绝收线/)
  assert.equal(existsSync(line.path), true, '拒绝 = 检出一个都不删')
  const merged = await mergeWorktree({ repo, path: line.path, branch: line.branch, base: line.base, name: 'l1', verify: 'git rev-parse --short HEAD', prepare: '' })
  assert.equal(merged.merged, true, merged.note)
  // 合回走的是 merge --squash：分支上那个提交**永远**不是主线 HEAD 的祖先，
  // 只看提交图的话这里会永远要求 force —— 而 force 正是最该被守住的那一次删除。
  const dropped = await dropWorktree({ repo, name: 'l1', path: line.path, branch: line.branch, base: line.base })
  assert.equal(dropped.dropped, true, dropped.note)
  assert.equal(existsSync(line.path), false)
  const branch = await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/wt/l1'])
  assert.notEqual(branch.code, 0, '分支也一起去掉')
})

it('收线：明确放弃（force）时删得掉，但那是显式的', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  await commitFile(line.path, 'a.txt', 'a\n', 'feat: A')
  const dropped = await dropWorktree({ repo, name: 'l1', path: line.path, branch: line.branch, base: line.base, force: true })
  assert.equal(dropped.dropped, true)
  assert.equal(existsSync(line.path), false)
})

it('写穿检测：主检出被动过时点名列出被动的路径（未暂存那一行的状态位不许吃掉路径首字符）', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  assert.deepStrictEqual(await detectLeak(repo, line.mainPorcelain), { leaked: false, paths: [] })
  dirty(repo, 'README.md', '# 子代理跑到主检出上改了东西\n')
  const leak = await detectLeak(repo, line.mainPorcelain)
  assert.equal(leak.leaked, true)
  assert.deepStrictEqual([...leak.paths], ['README.md'])
})

it('简报前言带上线名、检出路径、分支、主检出；收工方式点名 line=', () => {
  const preamble = isolationPreamble({ name: 'l1', path: 'P:/wt-l1', branch: 'wt/l1', repo: 'P:/repo' })
  assert.match(preamble, /【隔离检出（重要）】/)
  assert.ok(preamble.includes('线名：') && preamble.includes('l1'), '线名必须逐字给出：' + preamble)
  assert.ok(preamble.includes('task commit line=l1'), '提交时要点名这条线：' + preamble)
  assert.ok(preamble.includes('P:/wt-l1'), '检出绝对路径必须逐字给出')
  assert.ok(preamble.includes('禁止碰主检出') && preamble.includes('P:/repo'), '主检出的禁令要写出来：' + preamble)
  assert.ok(preamble.includes('本次会话的 cwd 仍然是主检出'), '隔离是**指示 + 事后检测**，前言必须如实这么说')
  const note = worktreeWorkflowNote('l1', 'pnpm test', 'pnpm test && pnpm typecheck')
  assert.ok(note.includes('task commit line=l1 node=<你的节点 id> units=<单元1>,<单元2>'), note)
  assert.ok(note.includes('pnpm test'), '线上存下来的验证命令要在这里点名')
  assert.ok(note.includes('不要自己合回主线'), '合回由中枢决定，这条必须写死')
})

it('收尾报告：如实数出提交数与未验证的改动，绝不自动提交', async () => {
  const repo = await freshRepo()
  const line = await createWorktree({ repo, name: 'l1' })
  dirty(line.path, 'a.txt', 'a\n')
  const committed = await commitFeature({ name: 'l1', path: line.path, node: 'A', units: [{ name: 'unit-a' }], verify: 'git rev-parse --short HEAD' })
  assert.equal(committed.committed, true, committed.note)
  dirty(line.path, 'b.txt', 'b\n')
  const report = await finalizeReport(line.path, line.base)
  assert.equal(report.commits, 1)
  assert.equal(report.uncommitted, 1)
  assert.match(report.note, /未验证的改动/)
  assert.equal(await revCount(line.path, line.base + '..HEAD'), 1, '收尾报告不提交任何东西')
})
