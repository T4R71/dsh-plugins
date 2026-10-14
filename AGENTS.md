# AGENTS.md — dsh-plugins

面向 DeepSeek Harness 的插件开发仓。**人和代理都读这份**；与 `README.md` 冲突时以本文件为准。

## 职责边界（硬规则）

本仓只管三件事：

1. **插件源码**（`packages/<plugin>/`）
2. **仓库级脚手架**（`scripts/`、根 `tsconfig` 基座）
3. **发布流程**（`docs/PUBLISHING.md`）

本仓**不做**这些：

- **不 fork、不镜像、不 track 上游 `deepseek-ai/deepseek-harness`**。上游只以 `peerDependencies` 里的版本号形式被消费。
- **不存放对上游源码的补丁**。补丁的实体留在本机检出里，本仓只在 `docs/UPSTREAM-PATCHES.md` 记台账。
- **不设仓级版本号，不打仓级 tag**。版本属于包，不属于仓。
- **不提交构建产物与锁文件**（见下「提交禁忌」）。

## 目录与成对规则

```
packages/<plugin>/        宿主半边
packages/<plugin>-ui/     客户端半边（可选）
```

- 目录名 = npm 包名去掉 `@t4r71/dsh-` 前缀。**一个目录一个包，不嵌套分组**（上游那种 `bundle/`、`client/`、`guard/` 分组是上游内部的组织方式，本仓不沿用）。
- 宿主半边与客户端半边成对时用 `-ui` 后缀，且 `-ui` 依赖宿主半边的 Loader 行——**改一半必须改另一半**（客户端那一行的键错了会静默不渲染，没有任何报错）。
- **目录名一旦发布就不能改**：已发布包的 `repository.directory` 指向它。

## 版本与 peer 锚

- 每个包**独立 semver**，从 `0.1.0` 起。
- 目标 DSH 版本写在该包自己的 `peerDependencies` 里，`@deepseek-ai/dsh-*` 必须写成**范围**（例如 `"^0.1.6-alpha.2"`），**不要钉精确版本**，也不要用 `*`。
- 理由（0.1.7 新增的装载闸门，实测于 runtime `0.1.7-rc.2`）：`dsh-app-boot` 在把 profile 行交给 Loader 之前逐行做兼容性预检，判定是 `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`，只对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 生效；判 false 的行被**静默 `disabled`**，只在 stderr 留一行，插件不报错也不加载。**闸门按 profile 行触发，与包是否声明 `dsh.bundle.patch` 无关**（预检对每一行读 `package.json` 的 `peerDependencies`），所以「纯插件不受影响」这个旧假设不成立——精确版本号也是合法 semver range，但它只对那一个版本为真，别的运行版本一律判 false。实测（semver 7.8.5）：`0.1.7-rc.2` vs `0.1.6-alpha.2` → false；vs `^0.1.6-alpha.2` → true；vs `^0.1.7-rc.2` → true。
  唯一豁免是 profile 目录下的 `compatibility.json`（`{ "<包名>@<精确版本>": ["<精确 runtime 版本>"] }`），它按**精确版本对**授权，不能表达范围，因此不能替代范围写法。
- 范围下界取**该包实际适配过的 API 表面**，不是目标运行时版本：源码还是 0.1.6 的接口就先写 `^0.1.6-alpha.2`，等接口适配做完再抬到 `^0.1.7-rc.2`。写高了下界等于谎报适配完成。
- 本仓当前的适配基准是 `0.1.7-rc.2`：接口适配完成、且 `build` + `typecheck` 对 0.1.7-rc.2 目标 0 的包，`@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` 三条下界写 `^0.1.7-rc.2`。**只声明实际验证过的版本**——没适配到 0.1.7 的包保留原下界，不得跟着抬（抬了就是谎报）。`packages/{stream-guard,idle-guard}` 已按此抬到 `^0.1.7-rc.2`。
- 例外：`@deepseek-ai/cordis` 用 `^4.0.4`、`@deepseek-ai/schemastery` 用 `^3.18.4`——它们的版本线独立于 DSH。
- **兄弟包之间用 `workspace:^`**，不要写死版本号。
- `package.json` 必须有 `publishConfig: { access: "public" }` 与带 `directory` 的 `repository`。

## 兼容矩阵的更新义务

`docs/COMPATIBILITY.md` 是「这个包对着哪个 DSH」的索引。以下三种改动**必须在同一个提交里**同步它：

1. 改 `peerDependencies` 的 DSH 锚；
2. 新增包（同时改根 `README.md` 的包索引）；
3. 一个包的验证状态变化（未迁移 → 已验证）。

## 发布前必须做的冷装冒烟

**构建通过不等于能用。** 本仓已有两次教训：全部静态可编译、运行期才炸的缺陷，纯函数单测测不到。发布闸门是真机装载，见 [`docs/PUBLISHING.md`](docs/PUBLISHING.md)。未通过冷装冒烟的包**不得发布**。

## 明确禁止（提交禁忌）

以下路径**不得**出现在 `git ls-files` 里（`.gitignore` 已覆盖，但改动 `.gitignore` 时要自己复核）：

- `node_modules/`
- `lib/`、`dist/`、`*.tsbuildinfo`
- `*.tgz`
- `pnpm-lock.yaml`

提交前自查：

```sh
git ls-files | grep -E '(^|/)(node_modules|lib|dist)/|\.tgz$|^pnpm-lock\.yaml$'   # 期望无输出
```

## 构建与测试

每个包在自己的目录里定义 `build` / `test` / `typecheck`；用 `pnpm --filter <包名> <script>` 调用。

**改了 `src/` 必须 build，否则不生效。** profile 里的包是 `link:` 安装，运行期读的是包目录下的 `lib/index.js`（经 `package.json` 的 `exports`），**不是 `src/`**。而 `typecheck` 里的 `tsc -b` 只写 `lib/types/`（`tsdown` 的 entry），**不产出 `lib/index.js`** —— 那个只有 `build` 里的 `tsdown` 会写。所以「typecheck 过了、测试全绿、提交完成」全都不等于**运行中的实例会用上新代码**。

2026-10-14 实测踩过一次：三处改动、212/212 全绿、提交 `c5bbf4f` 完成，用户重启后旧行为原样 —— 因为 `lib/index.js` 的 mtime 还停在改动之前。判据只有一条：

```sh
ls -la packages/<pkg>/lib/index.js packages/<pkg>/src/*.ts   # lib 必须更晚
```

多个包一起改就逐个 build（`pnpm --filter <包名> build`），**不要**用仓库级 `-r`（见下）。

**不要用仓库级 `-r` 全量构建**去跑 `docs/COMPATIBILITY.md` 里标了「未迁移」的包——它们面向 `0.1.6-alpha.2`，在本仓当前的目标版本下不具备可构建性。

## 运行隔离

任何启动 DSH 实例的动作（桌面端 exe、`dsh web`、构建产物）**必须显式设 `DSH_HOME`** 指向一个隔离目录。不设会落到用户真实 home 并按默认值重写 `settings.yaml`——已经发生过两次，不要再有第三次。

PowerShell 里 `$home` 是只读自动变量，**不要拿它当变量名**。

## 安全

npm 令牌在 `C:\Users\TRI\.npmrc`（本机路径）。**任何文档、提交、日志里都不得回显令牌内容**；引用时只写「令牌在 `.npmrc`」。
