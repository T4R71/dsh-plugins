# @t4r71/dsh-ask-panel-fix

修掉 DSH Web GUI 里**官方问答面板**的一个挤压缺陷：**问题正文一长，选项就被挤出可见区**。
纯客户端插件，用 DOM 后处理 + 注入 CSS 打补丁 —— **不 fork 官方、不改 asar、不接管任何 slot**。

## 症状

问答面板弹出后，若 `question` 正文很长（长标题或长 `detail`），面板只显示正文，
下面的选项完全看不见，而且**只有选项那一小块区域能滚** —— 正文与选项都摸不着。

## 根因（一手，读官方实现所得）

`@deepseek-ai/dsh-client-ui-user-questions/lib/client.js` 的 `QuestionComposer.module.css`：

```css
.card   { max-height: min(60vh, 520px); overflow: hidden; flex-direction: column; display: flex }
.header { flex-shrink: 0; padding: 20px 16px 0 24px; display: flex }   /* 这里装着问题正文 h2 */
.body   { flex: auto; min-height: 0; overflow-y: auto }                /* 唯一的滚动容器 */
.footer { flex-shrink: 0 }
.title  { font-size: 16px; line-height: 22px }                         /* 没有任何行数/高度上限 */
```

`.header` 是 `flex-shrink: 0`（不许压缩），`.title` 又没有行数上限。正文一长 → header 撑满
卡片 → `.body` 被压到 0 高 → 选项被卡片自己的 `overflow: hidden` 裁掉。

对照组：同一个包里 `PlanReviewPanel` 的标题反倒有单行截断（`nowrap` + `ellipsis` +
`-webkit-line-clamp: 2`）。所以这是官方**没做**这个保护，不是坏了 —— 我们不去改它，
只在自己的插件里补上。

## 做法

把滚动容器从 `.body` **提级到卡片整体**：卡片自己滚，正文与选项一起滚，标题也不再撑爆。

```
[data-question-key]                                   ← 官方 frame（稳定数据属性）
└── section  ← 本插件给它加 data-ask-panel-fix="card"，CSS 命中它
    ├── header（正文）
    ├── div[data-question-scroll]（官方原来的滚动容器，被中和成自然高度）
    └── footer（选项按钮）
```

注入的两条规则（**只用数据属性，不出现任何类名**）：

```css
[data-question-key] > [data-ask-panel-fix="card"] {
  overflow-y: auto;          /* 官方是 overflow:hidden */
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
[data-question-key] > [data-ask-panel-fix="card"] > [data-question-scroll] {
  flex: 0 0 auto;            /* 官方是 flex: auto（参与分配后被压成 0 高） */
  overflow-y: visible;       /* 官方是 overflow-y: auto（滚动已经提走了） */
}
```

几个刻意的选择：

- **不声明 `max-height`**：卡片的上限继续由官方那条 `min(60vh,520px)` 决定。官方哪天调大调小，
  本插件不用跟着改。
- **不用 `!important`**：本插件规则的选择器特异度是 (0,2,0)，官方的 `.card{overflow:hidden}`
  是 (0,1,0)，稳赢 —— 与两张样式表的注入顺序无关。
- **不用类名**：`mAtvLq_` 是 CSS Module 的编译哈希前缀（`QuestionComposer.module.css` 编出来的），
  官方下次发版重新编译就会变。
- **为什么必须有 JS**：要打补丁的两个元素一个在 frame 里、一个在 card 里，是**祖父与孙子**的
  关系，中间那层没有任何稳定数据属性，跨层父子关系 CSS 表达不了。所以先用 JS 把卡片自己
  标上 `data-ask-panel-fix="card"`，再用 CSS 按这个属性打补丁。
  （同类先例：`@t4r71/dsh-mermaid-ui` 也是用 DOM 后处理接管官方渲染。）

DOM 侧只有一个 `MutationObserver`，观察 `document.documentElement` 的 `childList + subtree`：
新卡片出现时补上标记，React 重建卡片后标记丢了也会自动补回来。**只观察 `childList`、只写
属性** —— 写属性不会产生 `childList` 变动，所以不存在「自己的写动作喂自己」的死循环。
防抖 100ms。

`ctx.effect` 返回的清理函数是完整的：断开观察者、摘掉所有标记、删掉样式表、删掉自检入口。
卸载之后页面立刻退回官方行为。

## 依赖的官方契约（官方改版时照这三条复核）

| # | 契约 | 怎么复核（在 `resources/app.asar` 里读官方实码） |
|---|------|--------------------------------------------------|
| 1 | `[data-question-key]` 仍然存在，且它的**直接** `section` 子元素就是卡片 | `dsh-client-ui-user-questions/lib/client.js` 里搜 `data-question-key`：应出现在 frame 那个 `div` 上，它的 `children` 是一个 `section`（frame 与 card 之间**不能**多出包装层） |
| 2 | 卡片内的滚动容器仍带 `[data-question-scroll]` | 同一文件里搜 `data-question-scroll`：应仍是 `.body` 那个 `div` |
| 3 | 官方卡片仍自带 `max-height` | 同一文件里搜 `css$1`，看 `.card{…}` 那段里有没有 `max-height` |

**复核命令**（一行；只读，不改任何东西）。注意 `app.asar` **不是目录**，`Select-String` /
`rg` / 普通 `node -e` 读它都会报「路径不存在」。两条可用路径，任选其一：

```powershell
# ① 用发行版自带的 Electron 当 Node 跑（最省事；ELECTRON_RUN_AS_NODE 只影响本次进程）
$env:ELECTRON_RUN_AS_NODE=1
& 'M:\DSH-T4\DeepSeek Harness.exe' -e "const fs=require('fs');const p='M:/DSH-T4/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js';fs.readFileSync(p,'utf8').split('\n').forEach((l,i)=>{if(/data-question-(key|scroll)|max-height:min\(/.test(l))console.log((i+1)+': '+l.trim())})"
```

```text
② 走 harness 自己的读写工具（read / grep）—— 它们认 asar 虚拟路径，
   直接对上面那个 lib/client.js 搜 `data-question-(key|scroll)` 即可。
```

三条全中 → 不用改。第 1 条不中（多出包装层）→ 改 `src/client.js` 里 `querySelector(':scope > section')`
这条查找。第 3 条不中（官方自己删了 `max-height`）→ 卡片会变成无限高、跟着整页滚，此时本插件
需要自己声明一个上限（这正是当前**刻意不做**的事）。

## 装配（本机）

1. 源码在本仓 `packages/ask-panel-fix/`，与其它 T4 插件同仓。
2. 建产物：`node build.mjs` → `lib/client.js`（`lib/` 被 `.gitignore` 覆盖，**不进版本库**）。
   本包的 `test` 脚本就是 `node build.mjs`——脚本自带的断言够格当测试用，所以没有单独的用例文件。
3. 本包在 `M:\dsh-plugins\pnpm-workspace.yaml`（`packages/*`）里，工作区根 `pnpm-lock.yaml`
   已有 `packages/ask-panel-fix` 这条 importer。**别删 `package.json` 里那条 `devDependencies`**：
   只有 `peerDependencies` 的零依赖包，pnpm 12.5.1 **不写 importer**，于是干净检出上的
   `pnpm install --frozen-lockfile` 会以 `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER` 退出 1。
   （`rebuild-plugins.ps1` 自己走的是 `pnpm add`，不受这条影响。）详见 `docs/COMPATIBILITY.md` 的同名一节。
4. profile `M:\DSH-T4\home\profiles\desktop\`：
   - `package.json` 的 `dsh.profile.bundles` 加一项 `@t4r71/dsh-ask-panel-fix`；
   - 同文件 `dependencies` 加 `"@t4r71/dsh-ask-panel-fix": "link:M:/dsh-plugins/packages/ask-panel-fix"`；
   - 在 profile 目录里跑 `pnpm install --ignore-scripts`，让 `node_modules\@t4r71\dsh-ask-panel-fix`
     这个链接由 pnpm 自己建出来（`dsh-effort-slider` 与 `dsh-boot-animation` 在盘上就是这个形态：
     Junction → `M:\DSH-T4\home\plugins\<名>`）。
5. 这个包的 `cordis.patch.yml` **自己贡献那一行**（`insert: {id: ask-panel-fix, name: '@t4r71/dsh-ask-panel-fix'}`），
   所以**不要**再手写一份到 profile 的 `cordis.patch.yml` —— 同 id 两份会按「后者覆盖前者」互相顶掉
   （profile 里 mermaid-ui 那段注释记的就是这个坑）。
6. 生效方式：**刷新页面**，不需要重启宿主进程（profile 的 `hmr` 行 watch 那份 patch 文件，落盘即重组合）。

撤下：把 `bundles` 里那一项删掉、按需再跑一次 profile 的 `pnpm install` 即可。
宿主半边是空插件，页面上会立刻退回官方行为。

> **验证到哪一档**（2026-10-06，一手）：产物被**装进本机正在运行的 GUI 页面**（真
> `window.__ModuleLoader__`、真 React 渲染出来的待答卡片）跑通了，包括对同一张卡片做
> 开/关本插件样式的 A/B——缺陷复现与修复都在真卡上量到（数值见下「实测」一节）。
> **还没做**的是「加进 profile 的 `bundles` 后由宿主自然加载」那一档：本包在 profile 里
> 尚未装配（`/plugins/??@t4r71/dsh-ask-panel-fix/client.js` 实测 **404**），所以「冷装
> 冒烟」仍是**未做**。装完后最省事的验收：页面控制台看有没有 `[ask-panel-fix] 就绪` 与
> `[ask-panel-fix] 首个问答卡片已接管滚动`，再触发一个正文很长的问答、确认选项没被挤掉。

## 实测

在真页面上对**同一张**待答卡片做的（先注入插件、再整段替换 `h2` 正文把卡片撑爆，然后
只切 `style.disabled` 这一个变量）：

| 量 | 本插件样式 关 | 本插件样式 开 |
| --- | --- | --- |
| 卡片 `overflow-y` | `hidden`（官方 `.card`） | `auto` |
| 卡片 `scrollHeight / clientHeight` | 473 / 432 | 712 / 432 |
| 内层 `[data-question-scroll]` `clientHeight` | **0**（被 flex 压没） | 239 |
| 内层 `overflow-y` | `auto` | `visible` |
| 最后一个选项底边 vs 卡片底边 | 885 vs 710，**超出 175px** | 超出 175px |
| 卡片能滚到的最大距离 | 0（`overflow:hidden`） | 280px |
| 滚到底后最后一个选项落在卡片内 | **否 —— 够不到** | **是** |

关掉时 `body.clientHeight` 塌成 **0** 就是症状的机制：官方把 `body` 设成 `flex:auto;
min-height:0` 的自滚动区，正文一长，flex 先把 `body` 压到零高、由它内部滚动，而
`footer`（选项就在里面）被 `flex-shrink:0` 顶出卡片，`overflow:hidden` 把多出来的裁掉
——选项既看不见、也滚不到。

同轮另测：连跑三次 `rescan()` 不产生重复（`style`/标记计数不变）；`apply()` 拿到的
disposer 执行后 `style` 归 0、全局 `__DSH_ASK_PANEL_FIX__` 消失、卡片回到 `hidden`；
`MutationObserver` 路径在一个临时合成节点上验过（挂上去 ~100ms 后自动打标）；全程没
改动那张真卡的问题正文与选中项（收尾时逐项核对过）。

## 自检

页面控制台里：

```js
window.__DSH_ASK_PANEL_FIX__.stats()
// → { styled: 3, frames: 3, patched: 3, styleTag: true }
```

- `frames`：当前文档里的问答面板数；
- `patched`：已经打上标记的卡片数（应当等于 `frames`）；
- `styleTag`：注入的样式表在不在。

问答面板出现时控制台还会打一行 `[ask-panel-fix] 首个问答卡片已接管滚动（锚点 [data-question-key]）`。

> 本插件**不注册任何 slot、不接管应答通道**：只加 CSS 与两个自带属性，选项的点击/提交
> 仍走官方实现。

## 构建期校验（`node build.mjs` 自带）

产物落盘前会跑完这些断言，任何一条不过就整轮作废、**不覆盖**已有产物：

- 产物能被 JS 引擎解析（`vm.Script`）；
- 产物能按真实 loader 约定物化 —— 在**没有 `module` / `exports` / `document`** 的沙箱里
  `factory(require)` 调一次，检查返回的 `exports.apply` 是真身、`exports.inject` 是空表；
- 内嵌的 CSS 与 `src/client.js` 里那份**逐字一致**（两边都交给 VM 真实求值，不在构建期重写
  一遍拼接逻辑）；
- CSS 里没有带哈希前缀的类名、没有 `max-height`、没有 `!important`；
- 三个选择器常量与契约表逐字相符。

## 许可

MIT。
