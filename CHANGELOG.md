# Changelog

包版本独立于所面向的 DeepSeek Harness 版本：包从 `0.1.0` 起走自己的 semver，面向的 DSH 版本写在各自的 `peerDependencies` 里。条目按日期倒序。

## 2026-09-28 — 仓库重组

`T4R71/dsh-dual-axis` 拆成独立插件开发仓 `T4R71/dsh-plugins`（**新仓，不带旧仓的 git 历史**）：

- 已发布的 `@t4r71/dsh-dual-axis` 与 `@t4r71/dsh-dual-axis-ui`（0.1.0）源码整体迁入。
- 另外 7 个自研插件从 `0.1.6-alpha.2` 检出搬入并改到 `@t4r71` 作用域，统一为 `0.1.0`，**标记为「未迁移」**：
  `dsh-task-tree`、`dsh-task-tree-host`、`dsh-plan-tree`、`dsh-ui-plan-tree`、`dsh-ui-task-tree`、
  `dsh-stream-guard`、`dsh-idle-guard`。依赖从 `workspace:^` 解析为各自的 npm 版本。
- 被取代的 `@deepseek-ai/dsh-client-ui-sandbox-axis`（`dual-axis-ui` 的前身）**未收录**，只作归档。

旧仓的 0.1.0 历史条目保留在下节。

## 2026-09-27 — 0.1.0（首版）

首次公开发布：`@t4r71/dsh-dual-axis`（宿主半边）与 `@t4r71/dsh-dual-axis-ui`（客户端半边）。

### 功能

- **按会话的双轴**：读轴与写轴各自取 `deny | workspace | all | custom`；`custom` 在某个底座上叠加绝对路径的 `allow` / `deny` 条目。
- **可复用规则组**：设置行维护命名规则片段库（`groups`），`defaultGroups` 决定新会话开局引用哪几条；组定义改动作用到引用它的会话。
- **每会话轴对存储**：设置命名空间 `dual-axis-sessions`（会话 id → 轴对），整份 `axes` 一次 `replace`，按 revision 重试；四次都冲突则抛 `DUAL_AXIS_AXES_CONFLICT`。轴对不写进会话日志。
- **读轴围栏**：`read-guard` 在工具派发层拦 `read` / `read_image` / `grep` / `glob` 四个入口。
- **模型可见的取值段落**：会话组装时按已解析的范围渲染（段落名 `sandbox:dual-axis`），中途改轴在下一次请求生效。
- **`/axis <轴>:<值>` 命令**：按会话改轴，并冻结该会话的轴对。
- **客户端半边**：插件页配置行（两轴 + 规则组，一次原子保存）与输入框上方的读/写两个下拉；行键 `@t4r71/dsh-dual-axis#dual-axis`。
- **安装即取代官方权限行**：补丁禁用上游 `ui-permission` 行（单占槽与 locale 命名空间两处冲突，技术不可行共存）。想拿回官方界面必须卸载本组合包。
- **bundle 补丁**：`dsh.bundle.patch` 声明的补丁插入四个 Loader 行并关掉上游那一行，profile 无需手写 Loader 条目。

### 兼容性

面向 DeepSeek Harness `0.1.7-rc.2`（两个包的 `peerDependencies` 全部钉在该版本）。
