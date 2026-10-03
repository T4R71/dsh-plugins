# A 方案实现简报：面板改走 HTTP 读 plan_tree.db

## 背景（已实证）
- 宿主 plan-tree 0.3.0 把计划树写进 SQLite：`M:\DSH-T4\home\storages\plan-tree.db`，表 `plan_tree_sessions(session_id TEXT PK, tree TEXT, updated_at INTEGER)`。
- 面板 @t4r71/dsh-ui-task-tree 0.1.0 跑在**浏览器**里（`window.__ModuleLoader__.load`，platform: web），
  它现在从 settings describe 镜像读命名空间 `plan-tree-sessions` 的 `trees` 字段 —— 该命名空间已不存在，
  于是永久显示 `unreadable`（"读不到计划存储：这份 profile 里没有装宿主的计划行。"）。
- 目标：改成走 HTTP。配置文件保持瘦（不再随会话增长）。

## 已验证的技术事实（读 shipped 0.2.0-rc.2 asar 得出，非推测）
1. `webServer` 服务挂在 `dsh-web-app/cordis.patch.yml` 的 `- id: webserver` 行，宿主实际监听 127.0.0.1:19387。
2. 服务名就是 `webServer`（`super(ctx, "webServer")`）。
3. 取服务是通用机制，**没有包白名单**：`ctx.inject(["webServer"], cb)`；
   cordis 的 `inject(inject, callback)` 就是 `this.plugin({inject, apply: callback})`。
   官方样例：`dsh-api-gateway` 里 `ctx.inject(["connection", "webServer"], (webCtx) => { ... })`。
4. `webServer.register(route)` 公开，route 形如 `{kind: "exact"|"prefix", path, handler(req,res)}`，
   重复 (kind,path) 抛错，返回 disposer。
5. **webServer 自身不做鉴权**：源码里 401 出现 0 次、auth 0 次。
   鉴权（`admit/requestRejection` → 403/401）属于 `connection` 服务，只作用于 connection 自己的
   `fetchRoutes` 表，与 webServer 的 exact/prefixes 表**是两套**。webServer 源码里根本没有 "connection" 字样。
   ⇒ 我们自己 register 的路由不会被 401 拦。
6. 浏览器侧：页面用 `?token=` 换 cookie（`dsh-auth-*`，HttpOnly SameSite=Strict，Path=/）。
   面板用**同源相对路径** fetch，cookie 自动带上。但按 5，即使不带也不会被 webServer 拦。

## 要做的改动

### 宿主侧：packages/plan-tree
- 新增 `src/http-route.ts`（或并入现有文件）：导出 `PLAN_TREE_ROUTE = "/t4/plan-tree"` 与
  `registerPlanTreeRoute(ctx, store)`，内部 `ctx.inject(["webServer"], ...)`。
- 路由语义（只读，GET）：
  - `GET /t4/plan-tree?session=<id>` → `{tree: PlanNode[] | null}`
  - `GET /t4/plan-tree`（无 session）→ `{trees: {sessionId: PlanNode[]}}`（可选，便于一次取全）
  - 失败 → 500 + `{error}`；非法 session → 400。
  - 只允许 GET/HEAD，其它 405。
- 挂载点在 `apply()` 里，**必须在 `exposeTools` 门之外**（理由同 taskTree 端口：面板取数与工具开关无关）。
- 注意：`ctx.inject` 是异步就绪的；webServer 可能晚于 plan-tree 加载，不能同步假设它在。

### 面板侧：packages/ui-task-tree
- `src/client/plan-tree.ts` 的 `PlanTreeDirectory` 改为 HTTP 取数：
  - 保留三态语义 `record | empty | unreadable`（这是本包的核心契约，**不要改**）。
  - 从 fetch 拉 `/t4/plan-tree?session=`，成功 → record/empty；网络或解析失败 → unreadable。
  - 变更通知：用轮询（例如 1.5–2s）或 visibilitychange 时立即拉。**不要**假设有服务器推送。
  - 仍然是 `SnapshotStore` + `useSyncExternalStore` 的稳定快照，序列化没变就不换对象。
  - `treeOf` / `mergedTreeOf` 签名保持不变，**合并逻辑（mergedTreeOf）原样复用**。
  - 面板没有 sessionId 时的行为要与现在一致。
- `PLAN_TREE_NAMESPACE` / `PLAN_TREE_FIELD` 若不再使用，一并清理（但注意 lib/types 的导出面与测试）。

### 测试
- plan-tree 新增：路由注册、GET 取树、不存在会话、非法参数、非 GET 方法。
- ui-task-tree 现有 80 个测试里钉 describe 镜像的那部分**必须改成钉 fetch**，
  但三态语义的用例要保留（改注入方式，不改断言意义）。
- 全仓 660 个测试最终要全绿。

## 硬约束
- 源码仓在 `M:\dsh-plugins`，**不要碰** `M:\DSH-T4`（那是运行目录）。
- 改完用 `M:\dsh-plugins\rebuild-plugins.ps1 <包名>` 重建安装（它会自动加版本号，这是必需的：
  pnpm 按版本缓存 file: tarball）。
- `plan-tree` 内部对 `ui-task-tree` 之类的仓库内引用必须是 `workspace:^`（打包 fase 才换 peerDependencies）。
- 参考当前 store 的根 ctx WeakMap 教训：缓存一律 key by `(ctx as any).root ?? ctx`。
- 结语只回三段：结论／证据／判不了。不要写状态行。