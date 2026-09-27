# 发布流程

**发布闸门是真机冷装，不是构建通过。** 本仓已经有过「静态全绿、运行期炸」的缺陷，纯函数单测测不到；未通过冷装冒烟的包不得发布。

## 0. 前置

- `docs/COMPATIBILITY.md` 里该包的「构建 / 真机冷装」两列已是最新。
- `peerDependencies` 的 DSH 锚是精确版本，不是 `^`。
- npm 令牌在 `C:\Users\TRI\.npmrc`（本机路径）；**不要在文档或日志里回显它的内容**。

## 1. 打包

```sh
pnpm install --ignore-scripts
pnpm --filter @t4r71/<plugin> build
pnpm --filter @t4r71/<plugin> test
```

打包后逐条校验 tarball：

- 每个 `exports` 目标都在 tarball 内（`present=true`）；
- 不含 `src/`、不含 `*.js.map`；
- 包内 `package.json` 与仓库 HEAD 对应 blob 逐字节相同。

## 2. 冷装冒烟（强制）

**2.1 全新 home** —— 不要复用任何既有 home；那是别人的测试现场。

**2.2 显式设 `DSH_HOME`** —— 变量名不要用 `$home`（PowerShell 只读自动变量）。置值后断言：

```powershell
$smokeHome = '<新目录>'
$env:DSH_HOME = $smokeHome
if ($env:DSH_HOME -ne $smokeHome) { exit 9 }
```

**2.3 在 profile 目录里装包** —— 两个包的 `file:` 依赖直指新打的 tgz：

```sh
cd "$smokeHome/profiles/desktop"
pnpm install --ignore-scripts          # 期望退出码 0
```

注意：`file:` 依赖按路径哈希识别，**覆盖同名 tgz 不会重新解包**；必须先把 `node_modules` 删掉再装。

**2.4 启动隔离实例**

```powershell
$env:DSH_HOME = $smokeHome
& '<桌面端 exe>' --remote-debugging-port=9333
```

**2.5 行为证据**（留原始回显，不要只写「通过」）

- 客户端能起：DOM 里 `hasLoadingPlugins=false`、composer 存在、控制台 0 条错误；
- 插件提供的界面元素真的渲染出来；
- 改一次配置**在同一个会话里立即生效**；
- 插件页那一行 + 详情页配置表单存在；
- 配置跨进程重启存活（改值 → 杀掉应用 → 再拉起 → 值仍在）。

**2.6 副作用断言** —— 启动前后，冒烟 home 与其它 home 的 `(路径, 大小, mtime)` 指纹、以及用户 `settings.yaml` 的哈希必须不变。

## 3. 发布

```sh
pnpm --filter @t4r71/<plugin> publish --access public --no-git-checks
```

## 4. 发布后核对（只读）

```sh
curl -sS https://registry.npmjs.org/@t4r71%2F<plugin> | grep -E '"gitHead"|"version"'
```

期望：出现新版本号，`gitHead` 指向本次提交。

## 5. 收尾

- 更新 `CHANGELOG.md`；
- 更新 `docs/COMPATIBILITY.md` 的状态列；
- 新插件首发布时同步根 `README.md` 的包索引。

## 顺序建议

按迁移工作量升序发布：`stream-guard` → `idle-guard` → `plan-tree` → `task-tree-host` → `task-tree` → `ui-plan-tree` / `ui-task-tree`，双轴系最后（它已经发布过，只在需要时升版）。
