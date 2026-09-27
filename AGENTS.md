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
- 目标 DSH 版本写在该包自己的 `peerDependencies` 里，钉精确版本（例如 `"@deepseek-ai/dsh-tools": "0.1.7-rc.2"`），**不要用 `^` 或 `*`**。
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

**不要用仓库级 `-r` 全量构建**去跑 `docs/COMPATIBILITY.md` 里标了「未迁移」的包——它们面向 `0.1.6-alpha.2`，在本仓当前的目标版本下不具备可构建性。

## 运行隔离

任何启动 DSH 实例的动作（桌面端 exe、`dsh web`、构建产物）**必须显式设 `DSH_HOME`** 指向一个隔离目录。不设会落到用户真实 home 并按默认值重写 `settings.yaml`——已经发生过两次，不要再有第三次。

PowerShell 里 `$home` 是只读自动变量，**不要拿它当变量名**。

## 安全

npm 令牌在 `C:\Users\TRI\.npmrc`（本机路径）。**任何文档、提交、日志里都不得回显令牌内容**；引用时只写「令牌在 `.npmrc`」。
