# 面板侧改造：PlanTreeDirectory 从 describe 镜像改走 HTTP

## 前置
上游节点 host-route 已在 packages/plan-tree 里注册了只读路由 `GET /t4/plan-tree`，
返回该会话的计划树。先读 docs/briefs/http-bridge.md 了解宿主侧契约，
再读 packages/plan-tree 里上游刚写的实现，确认实际的路由路径与响应 JSON 形状
（**以上游实际代码为准**，简报写的是设计意图）。

## 你的活
把 packages/ui-task-tree 的浏览器半边改成从那个 HTTP 路由取数，而不是从 settings describe 镜像。

## 设计约束（重要）
1. **三态语义必须保住**：`record | empty | unreadable` 是本包的核心契约，不许退化成「有/没有」。
   - 取到树 → record
   - 取到但该会话没有树 → empty
   - 网络失败／解析失败／拿不到 → unreadable（不能装成 empty）
2. **纯函数层不动**：`src/client/plan-tree-data.ts` 里的 `planTreesSectionOf` / `planTreeOf` /
   `mergedTreeOf` / `planTreeView` 与通道无关，**尽量原样保留**，
   它们对应的 14 个用例（tests/plan-tree-data.spec.ts）应当继续通过。
   只有确实依赖「镜像里那个命名空间字典」形状的地方才需要调整。
3. **只改取值层**：`src/client/plan-tree.ts` 的 `PlanTreeDirectory` 是唯一要重写的类。
   它的对外面保持：`getSnapshot` / `subscribe` / `treeOf` / `mergedTreeOf` / `dispose`。
4. **变更通知**：没有服务器推送，用轮询（建议 1500–2000ms）＋ `visibilitychange` 时立刻拉一次。
   仍然用 `createSnapshotStore` 做去重：序列化结果没变就**不**换快照（否则面板会被反复重画）。
5. **只在有会话时才拉**：没有 sessionId 时不发请求，读数与现在一致（empty）。
6. `src/client/index.ts` 里的 `inject` 数组与 package.json 的 `dsh.client.inject`：
   `configForms` 若不再需要就去掉（但注意 `@deepseek-ai/dsh-client-ui-settings` 的 type-only import
   可能还被别处引用）。`PlanTreeDirectory` 的构造参数会从 describeFace 变成路由 URL 之类，一并改。

## 测试
- tests/plan-tree-directory.spec.ts（6 个用例）现在钉的是 describe 镜像替身，**必须重写**为钉 fetch：
  正常取数、404/500 读作 unreadable、空结果读作 empty、轮询去重（内容没变不换对象）、
  dispose 后停止轮询、无 sessionId 时不请求。
- 其余 74 个用例（data 14 + merge/semantics 等）原则上不受影响，要跑通。
- 当前基线：ui-task-tree 80 个用例全绿。改完仍要全绿。

## 硬约束
- 只动 packages/ui-task-tree。不要动 plan-tree（上游已完成）。
- 跑 `pnpm test` 确认，然后 `rebuild-plugins.ps1 ui-task-tree` 重建安装。
- 浏览器侧用**同源相对路径** fetch（如 `/t4/plan-tree?session=...`），不要硬编码 host/port。
- 结语只三段：结论／证据／判不了。不要写状态行。