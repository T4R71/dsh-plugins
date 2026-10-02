# @t4r71/dsh-mermaid-ui

把 DSH Web GUI 里的 ```mermaid 围栏块渲染成 SVG 的**客户端插件**。

## 为什么是 DOM 后处理

核心 markdown 渲染器（`@deepseek-ai/dsh-client-ui-primitives` 的已打包 `lib/index.js`）
里有 shiki 与 katex，但**没有 mermaid**；客户端模块系统只有 load/resolve，没有 override/alias；
86 个 slot 里也没有代码块相关的。KaTeX 靠 `renderCode` 里「特判 lang === 'math'`」接进来，
而那个文件是 530 KB 的单文件产物，塞不进 500 KB 级的 mermaid 运行体。

所以本包自带 mermaid（打进 `lib/client.js`），挂载后观察 DOM，把
`div.md-code-block`（横幅 infostring 为 `mermaid`）的内容块换成渲染出的 SVG。

## 四条硬要求

- **流式安全**：内容两次扫描之间不变才渲染；渲染失败保留原始 code 块。
- **重渲染安全**：MutationObserver 持续修复被 React 抹掉的图，且**不碰**被抹掉的原文；
  自激由「扫描幂等 + 每目标最多 3 次重画」两道闸挡住。
- **主题感知**：跟随 `document.documentElement` 的 `color-scheme`/class，主题变化重画。
- **错误可见**：语法错时显示一行错误提示 + 原始代码块。

## 只碰 mermaid

其余语言的代码块（shiki 高亮）一个字节都不动。

## 构建

```sh
npm install
npm run build   # tsc -b tsconfig.json && tsdown -> lib/index.js + lib/client.js
```
