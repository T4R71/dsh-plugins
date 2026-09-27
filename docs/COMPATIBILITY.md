# 兼容矩阵

一张表回答「这个包对着哪个 DeepSeek Harness」。**权威来源永远是该包自己的 `package.json` 的 `peerDependencies`**；本表是它的索引，改了 peer 锚必须同步改这里。

## 矩阵

| 包 | 目录 | 面向 DSH | 依赖解析 | 构建 | 单测 | 真机冷装 | 首次发布 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@t4r71/dsh-dual-axis` | `packages/dual-axis` | `0.1.7-rc.2` | 通过 | 通过 | **117 / 117** | 未重做 | 0.1.0 |
| `@t4r71/dsh-dual-axis-ui` | `packages/dual-axis-ui` | `0.1.7-rc.2` | 通过 | 通过 | **54 / 54** | 未重做 | 0.1.0 |
| `@t4r71/dsh-task-tree` | `packages/task-tree` | `0.1.6-alpha.2` | 通过 | **未验证** | 未跑 | 未做 | — |
| `@t4r71/dsh-task-tree-host` | `packages/task-tree-host` | `0.1.6-alpha.2` | 通过 | **未验证** | 未跑 | 未做 | — |
| `@t4r71/dsh-plan-tree` | `packages/plan-tree` | `0.1.6-alpha.2` | 通过 | **未验证** | 未跑 | 未做 | — |
| `@t4r71/dsh-ui-plan-tree` | `packages/ui-plan-tree` | `0.1.6-alpha.2` | 通过 | **未验证** | 未跑 | 未做 | — |
| `@t4r71/dsh-ui-task-tree` | `packages/ui-task-tree` | `0.1.6-alpha.2` | 通过 | **未验证** | 未跑 | 未做 | — |
| `@t4r71/dsh-stream-guard` | `packages/stream-guard` | `0.1.6-alpha.2` | 通过 | **未验证** | 未跑 | 未做 | — |
| `@t4r71/dsh-idle-guard` | `packages/idle-guard` | `0.1.6-alpha.2` | 通过 | **未验证** | 未跑 | 未做 | — |

「依赖解析通过」= `pnpm install` 在 9 包工作区里退出码 0。

## 两条必须知道的构建事实

### 1. CSS Module 的类名哈希由源码**绝对路径**派生

`dual-axis-ui` 打包时，CSS Module 的类名后缀是路径派生哈希。同一份源码放在不同目录下构建，产物**不是逐字节相同的**：

| 构建位置 | 类名后缀 | `lib/client.js` sha256 前 12 |
| --- | --- | --- |
| `M:\T4\out\release\dsh-dual-axis` | `_9vJ8OG_` | `C3D0AD138103`（= 已发布的 0.1.0 产物） |
| `M:\dsh-plugins` | `_3QVNGW_` | `E5922A8998E3` |

两者除这些不透明类名外**内容一致**（3401 行全部对齐，差异仅出现在 `//#region \0t4-css:<路径>` 与类名表）。含义：**搬家之后不能再声称产物与已冒烟的那份逐字节相同**，升级版本前要重做一次真机冷装。

### 2. 宿主包的单测需要 `TSX_TSCONFIG_PATH`

`@deepseek-ai/dsh-settings` 发行了 `lib/types/schema.js`，但 exports map 里**没有** `./schema` 子路径。`packages/dual-axis/tests/settings.spec.ts` 与 `tests/session-store.spec.ts` 依赖它，靠 `tsconfig.runtime.json` 里的映射绕开。`test` 脚本必须带 `cross-env TSX_TSCONFIG_PATH=tsconfig.runtime.json`——**本仓重组前这个脚本是漏的，两个 spec 因此跑不起来**（旧仓同样跑不起来，不是搬家造成的）。

## 「未迁移」是什么意思

源码从 `0.1.6-alpha.2` 的检出搬来，做了四件事：

1. 作用域从 `@deepseek-ai` 改到 `@t4r71`（含 `cordis.patch.yml` 与源码里的交叉引用）；
2. `workspace:^` 依赖改写成各自在 npm 上的具体版本（`@deepseek-ai/dsh-*` → `0.1.6-alpha.2`，`cordis` → `^4.0.4`，`schemastery` → `^3.18.4`）；兄弟包之间保留 `workspace:^`；
3. 通配的 peer 锚（`*`）钉成精确版本 —— 不钉的话会拉到 latest 的传递依赖 `@deepseek-ai/dsh-type-meta`，而那个包在 npm 上不存在（404）；
4. 版本统一为 `0.1.0`，补 `publishConfig.access=public` 与带 `directory` 的 `repository`。

**没有做的**：没有针对 `0.1.7-rc.2` 做接口适配，没有跑过构建，没有在真机上装过。

## 迁移到 0.1.7-rc.2 的已知障碍

来自 0.1.6 检出与 0.1.7-rc.2 干净检出的对拍（词边界 grep 计数）。**「0 命中」是必要不充分证据**——符号可能只是改了名，仍需逐个源码确认：

| 被砍掉的接缝 | 0.1.6 侧命中 | 0.1.7 侧命中 |
| --- | --- | --- |
| `AxisScope` | 105 | 0 |
| `settingsScope` | 80 | 0 |
| `DEFAULT_READ_SCOPE` / `axisValues` / `readKind` / `parseCustomScope` | 非 0 | 0 |

另外两条搬迁前就存在的未声明跨包 import，迁移时要一起处理：

- `packages/plan-tree` 的源码 import 了 `@deepseek-ai/dsh-interaction-user-questions`，但**未在 `package.json` 里声明**，且该包在 npm 上不存在。
- `packages/idle-guard` 的源码引用了 `@t4r71/dsh-stream-guard`，同样**未声明**。

## 维护义务

- 新增包：同步本表 + 根 `README.md` 的包索引。
- 改 peer 锚：同步本表。
- 状态变化（未迁移 → 已验证）：同时更新本表的「构建 / 单测 / 真机冷装」三列。
