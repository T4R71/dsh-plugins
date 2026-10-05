/**
 * ask-panel-fix 的浏览器半边（源码；由 build.mjs 原样内联进 loader 工厂）。
 *
 * ⚠️ 本文件是**经典脚本**，不是 ES 模块：它会连同下面的注释被逐字塞进
 * `<script>` 里。所以这里不出现 `import` / `export` 语法、也不用 TS 注解；
 * 导出走模块体自己声明的 `module.exports`（官方 loader 的物化实现是
 * `factory(require)`，返回值即模块 exports —— 见 build.mjs 顶部）。
 *
 * 解决什么
 * --------
 * 官方问答面板（`@deepseek-ai/dsh-client-ui-user-questions`）的卡片是
 * `max-height:min(60vh,520px) + overflow:hidden` 的纵向 flex，滚动容器**只有**
 * `.body` 那一块，而问题正文所在的 header 是 `flex-shrink:0` 且标题没有任何
 * 行数/高度上限。正文一长 → header 撑满卡片 → body 被压到 0 高 → 选项被卡片
 * 的 `overflow:hidden` 裁掉，正文与选项都看不见。
 *
 * 怎么修
 * ------
 * 把滚动容器从 `.body` 提级到**卡片整体**：卡片自己滚，body 恢复自然高度。
 * 这样正文和选项一起滚，标题也不再撑爆，且**不依赖任何内层类名**
 * （`.mAtvLq_` 是 CSS Module 的编译哈希，官方下次发版就会变）。
 *
 * 为什么是 DOM 后处理而不是纯 CSS
 * ------------------------------
 * 需要打补丁的两个元素是**祖父与孙子的关系**（frame 里的 `section.card`，与
 * card 里的 `div[data-question-scroll]`），跨层父子关系 CSS 表达不了 ——
 * frame 与 card 之间没有任何稳定数据属性。所以先用 JS 把卡片自己标上一个
 * 自带属性，再用 CSS 按这个属性打补丁。
 *
 * 契约（官方改版时只需要复核这三条）
 * ----------------------------------
 *   1. `[data-question-key]` 仍然存在，且它的**直接** `section` 子元素就是卡片；
 *   2. 卡片内的滚动容器仍带 `[data-question-scroll]`；
 *   3. 官方卡片仍自带 `max-height`（本插件**不声明** max-height，直接继承
 *      官方的值；官方把这条上限调大调小都不需要改本插件）。
 */
(function () {
	'use strict';

	/** 包名。与 package.json、cordis.patch.yml 的行 id 同源，改动必须三处一起改。 */
	var PACKAGE_ID = '@t4r71/dsh-ask-panel-fix';

	/** 浏览器半边自己的版本号（不读 package.json，免得把它打进 bundle）。 */
	var VERSION = '0.1.0';

	/**
	 * 定位问答面板的**唯一**稳定锚点。
	 * 官方 client.js 里它写作 `"data-question-key": pending.key`（frame 那个 div），
	 * 是 JSX 字面量、不进任何哈希，实测全包只出现 1 次。
	 */
	var FRAME_SELECTOR = '[data-question-key]';

	/**
	 * 官方内层滚动容器的数据属性。本插件只用它做自检标记，补丁本身不依赖它 ——
	 * 卡片一旦整体可滚，那个内层容器是死是活都不再影响可见性。
	 */
	var SCROLL_SELECTOR = '[data-question-scroll]';

	/** 打补丁时写在卡片上的自带属性；CSS 靠它命中，不写类名。 */
	var GUARD_ATTR = 'data-ask-panel-fix';

	/** 给内层滚动容器的自检标记（只读观察点，不参与样式）。 */
	var SCROLL_MARK_ATTR = 'data-ask-panel-fix-scroll';

	/** 注入的 `<style>` 的标记，卸载时按它精确删除。 */
	var STYLE_MARKER = '@t4r71/dsh-ask-panel-fix/style';

	/** 控制台前缀。 */
	var LOG = '[ask-panel-fix]';

	/** DOM 变动到这个时长没有新的，才做一次扫描。 */
	var SCAN_DEBOUNCE_MS = 100;

	/**
	 * 注入的样式。两条规则，都只用数据属性定位：
	 *
	 *  ① 卡片：保留官方自带的 `max-height`（这里**不声明**，直接继承），只把
	 *     `overflow` 从 `hidden` 换成 `auto`。官方 `.card{overflow:hidden}` 的
	 *     单类选择器特异度是 (0,1,0)，本规则 (0,2,0) 稳赢 —— 与官方样式表的
	 *     注入顺序无关。
	 *  ② 那个原本的滚动容器：退出 flex 分配（`flex:0 0 auto`）、两轴都回到
	 *     `visible`（不写成 `visible hidden`，免得被 CSS 那条「visible 与非
	 *     visible 合成成 auto」的规则又把滚动条变出来）。
	 *
	 * `overscroll-behavior: contain` 防止在卡片滚到底时把滚动传给对话列表；
	 * `scrollbar-gutter: stable` 避免内容长度跨过阈值时整块横移。
	 */
	var CSS_TEXT = [
		'/* @t4r71/dsh-ask-panel-fix — 问答面板整体可滚（数据属性定位，不依赖编译哈希类名） */',
		FRAME_SELECTOR + ' > [' + GUARD_ATTR + '="card"] {',
		'  overflow-y: auto;',
		'  overflow-x: hidden;',
		'  overscroll-behavior: contain;',
		'  scrollbar-gutter: stable;',
		'}',
		FRAME_SELECTOR + ' > [' + GUARD_ATTR + '="card"] > ' + SCROLL_SELECTOR + ' {',
		'  flex: 0 0 auto;',
		'  overflow-y: visible;',
		'}',
		'',
	].join('\n');

	/**
	 * 建一个打补丁器。**不碰 DOM 直到 `start()`** —— 构建期会在一个只有
	 * `window.__ModuleLoader__` 的沙箱里按真实 loader 约定物化本产物，那时
	 * `document` 不存在。
	 * @returns {{start: Function, stop: Function, stats: Function, rescan: Function}}
	 */
	function createPatcher() {
		var observer = null;
		var timer = undefined;
		var running = false;
		var styled = 0;

		/** 注入一次性样式表；已存在就什么都不做。 */
		function ensureStyle() {
			if (document.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]') !== null) return;
			var style = document.createElement('style');
			style.setAttribute('data-plugin', PACKAGE_ID);
			style.setAttribute('data-plugin-css', STYLE_MARKER);
			style.textContent = CSS_TEXT;
			document.head.append(style);
		}

		/**
		 * 扫一遍全文档，把还没打标的卡片补上。每张卡片只做两件事，且都幂等：
		 *   · 卡片自己 `data-ask-panel-fix="card"` —— CSS 的命中点；
		 *   · 卡片内的滚动容器 `data-ask-panel-fix-scroll` —— 自检观察点。
		 * React 重建卡片时两处标记都会丢，下一轮扫描重新补上。
		 */
		function sweep() {
			if (!running) return;
			var frames = document.querySelectorAll(FRAME_SELECTOR);
			for (var i = 0; i < frames.length; i += 1) {
				// 卡片 = frame 的**直接** section 子元素。`:scope >` 是硬约束：
				// 官方将来在 frame 里加装饰层也不会被误标。
				var card = frames[i].querySelector(':scope > section');
				if (card === null) continue;
				if (card.getAttribute(GUARD_ATTR) !== 'card') {
					card.setAttribute(GUARD_ATTR, 'card');
					styled += 1;
					if (styled === 1) {
						console.info(LOG + ' 首个问答卡片已接管滚动（锚点 ' + FRAME_SELECTOR + '）');
					}
				}
				var scroll = card.querySelector(':scope > ' + SCROLL_SELECTOR);
				if (scroll !== null && !scroll.hasAttribute(SCROLL_MARK_ATTR)) {
					scroll.setAttribute(SCROLL_MARK_ATTR, '');
				}
			}
		}

		/** 防抖调度。 */
		function schedule(delay) {
			if (!running) return;
			if (timer !== undefined) window.clearTimeout(timer);
			timer = window.setTimeout(function () {
				timer = undefined;
				sweep();
			}, delay);
		}

		/** 自检读数：打过多少张卡 / 当前文档里有几张卡 / 样式表在不在。 */
		function stats() {
			return {
				styled: styled,
				frames: document.querySelectorAll(FRAME_SELECTOR).length,
				patched: document.querySelectorAll('[' + GUARD_ATTR + '="card"]').length,
				styleTag: document.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]') !== null,
			};
		}

		function start() {
			if (running) return;
			running = true;
			ensureStyle();
			// 只观察 childList：本插件写的是**属性**，不会自我触发（不会与 React 打成死循环）。
			// 卡片被 React 整个换掉、或 body/footer 被重新挂上，都是 childList 变动，看得见。
			observer = new MutationObserver(function () {
				schedule(SCAN_DEBOUNCE_MS);
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
			schedule(0);
			// 首屏可能在插件挂载前就画好了；脚本若在 loading 期执行，再补一次。
			if (document.readyState === 'loading') {
				document.addEventListener('DOMContentLoaded', function () { schedule(0); }, { once: true });
			}
			console.info(LOG + ' 就绪 v' + VERSION + '：监视 ' + FRAME_SELECTOR + '，把滚动提级到卡片整体');
		}

		function stop() {
			if (!running) return;
			running = false;
			if (observer !== null) {
				observer.disconnect();
				observer = null;
			}
			if (timer !== undefined) {
				window.clearTimeout(timer);
				timer = undefined;
			}
			// 卸载即还原：标记全摘掉（卡片立刻退回官方行为），样式表删掉。
			var marked = document.querySelectorAll('[' + GUARD_ATTR + '], [' + SCROLL_MARK_ATTR + ']');
			for (var i = 0; i < marked.length; i += 1) {
				marked[i].removeAttribute(GUARD_ATTR);
				marked[i].removeAttribute(SCROLL_MARK_ATTR);
			}
			var style = document.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]');
			if (style !== null) style.remove();
			delete window.__DSH_ASK_PANEL_FIX__;
		}

		return { start: start, stop: stop, stats: stats, rescan: sweep };
	}

	/** 本插件不需要任何客户端服务：它只读文档、只写文档。 */
	var inject = [];

	/**
	 * 挂载：观察整篇文档，给每张问答卡片打上自带属性，并把样式表挂上去。
	 * @param ctx - 浏览器插件上下文。
	 */
	function apply(ctx) {
		ctx.effect(function () {
			// 非浏览器环境（构建期的物化沙箱）没有 document：安静地什么都不做。
			if (typeof document === 'undefined' || typeof window === 'undefined') return function () {};
			var patcher = createPatcher();
			patcher.start();
			window.__DSH_ASK_PANEL_FIX__ = {
				version: VERSION,
				stats: function () { return patcher.stats(); },
				rescan: function () { patcher.rescan(); },
			};
			return function () {
				patcher.stop();
			};
		}, 'ask-panel-fix: question panel scroll');
	}

	/* 导出通道：loader 只做一次 factory(require)，返回值就是模块 exports。 */
	module.exports = { apply: apply, inject: inject };
})();
