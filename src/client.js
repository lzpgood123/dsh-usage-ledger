/**
 * usage-ledger 浏览器端。
 *
 * 这是一个手写的 `__ModuleLoader__` bundle：模块系统把注册好的 factory 物化
 * 并交给它同步的 `require`，React 由宿主提供。**刻意没有构建步骤，也没有 JSX**
 * ——用运行时的 `createElement` 直接调用，少一条工具链就少一处会与宿主版本漂移
 * 的地方。
 *
 * ## 刻意不 require @deepseek-ai/dsh-client-ui-primitives
 *
 * 上一个同类插件正是死在这里：它 require 了 primitives 的图标组件，而图标名在
 * 宿主版本间从 `IconCloseOutline16`（尺寸后缀）改成了 `IconCloseOutlineRegular`
 * （描边后缀），拿到 `undefined` 后 React 抛 error #130，整个插槽静默崩溃。
 *
 * 所以这里只用 React 原生元素 + 宿主 CSS 变量 + 文字符号（↻ × 等），
 * 一个第三方组件都不依赖。面板的视觉靠 token 对齐，不靠组件库。
 *
 * @module usage-ledger/client
 */

window.__ModuleLoader__.load({
	id: "dsh-usage-ledger",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback } = React;

		const API = "/api/usage-ledger";

		//#region 工具

		/**
		 * 把 token 数压成可读单位。
		 *
		 * 中文习惯用万/亿，而不是 K/M——同一屏里混用两套数量级最容易看错。
		 *
		 * @param value - 原始计数。
		 * @returns 展示字符串。
		 */
		function fmtTokens(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			if (value >= 1e8) return (value / 1e8).toFixed(2) + " 亿";
			if (value >= 1e4) return (value / 1e4).toFixed(1) + " 万";
			return Math.round(value).toLocaleString("zh-CN");
		}

		/**
		 * 千分位整数。
		 *
		 * @param value - 原始计数。
		 * @returns 展示字符串。
		 */
		function fmtCount(value) {
			return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("zh-CN") : "—";
		}

		/**
		 * 金额展示；无定价时显示破折号而不是 0。
		 *
		 * @param value - 金额或 null。
		 * @param currency - 币种符号。
		 * @returns 展示字符串。
		 */
		function fmtMoney(value, currency) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
			return symbol + value.toFixed(value < 1 ? 4 : 2);
		}

		/**
		 * 取本地日期键。
		 *
		 * @param date - 日期对象。
		 * @returns `YYYY-MM-DD`。
		 */
		function keyOf(date) {
			const pad = (value) => String(value).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
		}

		//#endregion

		//#region 样式

		/**
		 * 面板样式。
		 *
		 * 全部颜色取自宿主 token，这样跟随主题；少量 `--ul-*` 是本面板专有、且
		 * 定义在面板根节点上，不会外泄到宿主。
		 */
		const CSS = `
.ul-root{--ul-radius:10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary,currentColor)}
.ul-backdrop{position:fixed;inset:0;z-index:999}
/* box-sizing:border-box 是这里的承重墙，不是排版偏好：面板同时有 width 与 padding，
   默认的 content-box 会把 padding（32px）与 border（2px）**加到** width 之外，
   于是 min(760px, calc(100vw - 24px)) 实际占掉「100vw - 24px + 34px」。面板又是
   fixed 定位，多出来的 34px 既不会撑出 body 滚动条、也不进 document.scrollWidth
   ——它只是被视口切掉，页面看起来"没坏"，而右侧内容用户根本看不到。
   （注意：本样式表在模板字符串里，注释中不可出现反引号。） */
.ul-panel{position:fixed;z-index:1000;left:12px;bottom:64px;width:min(760px,calc(100vw - 24px));max-height:min(78vh,820px);overflow:auto;
  box-sizing:border-box;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3,currentColor);border-radius:var(--ul-radius);
  box-shadow:var(--dsw-elevation-panel);padding:14px 16px 16px}
/* 窄视口：面板占满宽度。left/right 必须一起归零——只把 width 改成 auto、right 仍
   不设的话，面板会收缩成「内容宽」（fixed 元素 left 有值 + right:auto + width:auto
   → shrink-to-fit），实测 480px 下 computed width 是 544px、右边缘跑到 556px
   （越界 76px）。注意这与「完全没修」时的 502px 是两个不同状态，别混：
   - 502px = 连 box-sizing 都没有的修复前基线（left:12 + calc(100vw - 24px)，
     再加 34px 的 padding/border）；
   - 556px = 已加 box-sizing、但只改了 width:auto、没设 right 的半修状态
     （此时 left 仍是 12px 也照样越界，因为 544px 是内容撑出来的）。
   box-sizing 单独就能消掉 502，却消不掉 556——后者只有这里的 right:0 能治。
   （left:0 另有一用：right:0 已经能防越界，但残留的 left:12px 会让窄屏白白少
   12px 宽度，所以两者一起归零。）
   同时把 bottom 从 64px 收到 8px：64px 是对徽章高度的硬编码耦合，窄屏上
   徽章往往不在原位，那 64px 只会白白吃掉可视高度。 */
@media (max-width:760px){
  .ul-panel{left:0;right:0;width:auto;bottom:8px}
}
.ul-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ul-title{font-size:13px;font-weight:600;flex:1}
.ul-iconbtn{background:transparent;border:1px solid var(--dsw-alias-border-l2,currentColor);color:inherit;border-radius:6px;
  width:26px;height:26px;line-height:1;cursor:pointer;font-size:13px;padding:0}
.ul-iconbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.ul-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.ul-tab{background:transparent;border:1px solid var(--dsw-alias-border-l2,currentColor);color:inherit;border-radius:999px;
  padding:3px 11px;cursor:pointer;font-size:12px}
/* 选中态做成实心药丸：浅色下近黑底白字，深色下近白底深字，两个主题都成立，
   也不再依赖浅色里与 bg-layer-1 同为 #fff 的 bg-layer-3。 */
.ul-tab[data-on="1"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;font-weight:600}
.ul-date{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2,currentColor);
  color:inherit;border-radius:6px;padding:3px 6px;font-size:11px}
.ul-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin-bottom:12px}
/* 浅色下 bg-layer-1/2/3 都是 #fff，层次只能靠边框承担，所以卡片必须带 border-l2。 */
.ul-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2,currentColor);
  border-radius:8px;padding:8px 10px}
.ul-card .k{font-size:11px;color:var(--dsw-alias-label-secondary,currentColor);margin-bottom:2px}
.ul-card .v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.ul-sec{margin-top:14px}
.ul-sec>h4{margin:0 0 7px;font-size:12px;font-weight:600;display:flex;gap:8px;align-items:baseline}
.ul-sec>h4 .hint{font-size:11px;color:var(--dsw-alias-label-secondary,currentColor);font-weight:400}
.ul-heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,minmax(0,1fr));gap:2px;align-content:start;flex:1 1 auto;min-width:0}
.ul-heat i{width:100%;aspect-ratio:1;border-radius:2px;background:var(--dsw-alias-bg-layer-2);display:block}
/* 热力图五档：静态色 + 宿主深色选择器分主题给出。
   刻意不用 CSS 混色函数——它没有 @supports 回退，且色相会随主题反转。
   真实格子与图例色块**共用同一条规则**（同一声明里的两个选择器），
   每个色值在全文件只出现一次：改档位时不可能只改到其中一处。 */
.ul-heat i[data-l="0"],.ul-legend i[data-l="0"]{background:var(--dsw-alias-bg-layer-2)}
.ul-heat i[data-l="1"],.ul-legend i[data-l="1"]{background:#cfe0fd}
.ul-heat i[data-l="2"],.ul-legend i[data-l="2"]{background:#93c5fd}
.ul-heat i[data-l="3"],.ul-legend i[data-l="3"]{background:#3b82f6}
.ul-heat i[data-l="4"],.ul-legend i[data-l="4"]{background:#1e40af}
body[data-ds-dark-theme] .ul-heat i[data-l="1"],body[data-ds-dark-theme] .ul-legend i[data-l="1"]{background:#1e3a8a}
body[data-ds-dark-theme] .ul-heat i[data-l="2"],body[data-ds-dark-theme] .ul-legend i[data-l="2"]{background:#2563eb}
body[data-ds-dark-theme] .ul-heat i[data-l="3"],body[data-ds-dark-theme] .ul-legend i[data-l="3"]{background:#60a5fa}
body[data-ds-dark-theme] .ul-heat i[data-l="4"],body[data-ds-dark-theme] .ul-legend i[data-l="4"]{background:#c7ddff}
.ul-heatwrap{display:flex;gap:6px;align-items:flex-start;padding-bottom:4px}
.ul-heatdays{display:grid;grid-template-rows:repeat(7,minmax(0,1fr));gap:2px;font-size:9px;color:var(--dsw-alias-label-secondary,currentColor);line-height:1;text-align:right;flex:0 0 auto;padding-top:15px}
.ul-monthrow{display:grid;gap:2px;font-size:9px;color:var(--dsw-alias-label-secondary,currentColor);margin-bottom:3px;flex:1 1 auto;min-width:0;overflow:hidden}
.ul-legend{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--dsw-alias-label-secondary,currentColor);margin-top:5px}
.ul-legend i{width:10px;height:10px;border-radius:2px;display:block}
.ul-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.ul-table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-secondary,currentColor);font-size:11px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,currentColor);
  cursor:pointer;white-space:nowrap;user-select:none}
.ul-table th:first-child,.ul-table td:first-child{text-align:left}
.ul-table td{text-align:right;padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,currentColor);white-space:nowrap}
.ul-table tr:hover td{background:var(--dsw-alias-bg-layer-2)}
.ul-name{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
.ul-bar{position:relative;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,currentColor);min-width:44px}
.ul-bar>span{position:absolute;inset:0 auto 0 0;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.ul-muted{color:var(--dsw-alias-label-secondary,currentColor)}
/* 琥珀色只用来表达「这是警告」——底、边、图标。文字仍用正文墨色：
   --dsw-alias-state-warn-label 是给**普通底色**上的琥珀文字用的，铺在 warn-tertiary
   上只有 2.58:1（实测），反而比不改更难读。宿主自己也是这么分的。 */
.ul-warn{background:var(--dsw-alias-state-warn-tertiary);border:1px solid var(--dsw-alias-state-warn-secondary);
  color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 9px;font-size:11px;margin-top:10px}
/* 警告块里的次要文字不能沿用全局 .ul-muted 的低不透明度，否则又掉回低对比度。 */
.ul-warn .ul-muted{color:var(--dsw-alias-label-secondary);opacity:1}
/* 与 .ul-warn 同款：红色只表达「这是错误」（底），文字回到正文墨色。
   state-error-primary 是宿主给**错误文字**用的 token（宿主自己用了 76 处），
   但它的浅色值 red-600 在白底上只有 4.4976:1，比 WCAG AA 的 4.5 差 0.0024——
   卡在线上，不值得为它破例。用墨色文字 + 淡红底，两种主题都有充足余量
   （浅 15.80:1 / 深 14.31:1）。 */
.ul-err{background:var(--dsw-alias-file-diff-deleted-bg);color:var(--dsw-alias-label-primary);
  border-radius:8px;padding:7px 9px;margin-top:10px}
.ul-load{color:var(--dsw-alias-label-secondary,currentColor);padding:18px 0;text-align:center}
.ul-foot{display:flex;gap:10px;align-items:center;margin-top:12px;font-size:11px;color:var(--dsw-alias-label-secondary,currentColor)}
.ul-badge{display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:0;color:inherit;cursor:pointer;
  padding:5px 8px;border-radius:7px;font-size:12px;text-align:left}
.ul-badge:hover{background:var(--dsw-alias-bg-layer-2)}
/* 强调色用 business 蓝，而不是 brand-primary——后者在宿主里是墨色/对比色，不是色相。 */
.ul-badge .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary);flex:0 0 auto}
.ul-badge .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-badge .n{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,currentColor)}
/* 表格自己横向滚动，纵向仍由 .ul-panel 承担。以前 overflow 在面板上，表格一超宽
   就把表头、范围标签、卡片一起推走——整块面板都在滑。 */
.ul-tablewrap{overflow-x:auto}
/* tokens 列的数值不换行：列被挤窄时它是最后一个该让步的东西。 */
.ul-num{white-space:nowrap}
.ul-table{width:100%;min-width:0}
/* 名称列吸收余量，数值列按内容定宽：表格因此不再有固定的 min-content 下限。 */
.ul-table th:first-child,.ul-table td:first-child{width:100%;max-width:0}
.ul-table td:first-child .ul-name{max-width:none;width:100%}
/* 可排序表头是按钮：外层 th 不再假装可点，指针样式只给真正能点的按钮。 */
.ul-table th{cursor:default}
/* 名称列弹性：覆盖掉上面的 260px 硬上限。它与 tokens 列的 76px 下限一起把表格
   撑到 min-content ≈837px，而面板内宽只有 728px。溢出仍用 ellipsis，title 保留全名。 */
.ul-name{max-width:none}
.ul-sort{display:inline-flex;align-items:baseline;gap:2px;background:transparent;border:0;color:inherit;font:inherit;
  padding:2px 4px;margin:-2px -4px;border-radius:4px;cursor:pointer;white-space:nowrap}
.ul-sort:hover{background:var(--dsw-alias-bg-layer-2)}
.ul-arrow{font-size:10px;opacity:.9}
/* 键盘焦点必须看得见：用宿主 token 描边，两个主题都成立。 */
.ul-sort:focus-visible,.ul-tab:focus-visible,.ul-iconbtn:focus-visible,.ul-badge:focus-visible,.ul-date:focus-visible{
  outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.ul-panel:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
`;

		/** 样式只注入一次。 */
		function useStyles() {
			useEffect(() => {
				const id = "usage-ledger-style";
				if (document.getElementById(id) !== null) return;
				const tag = document.createElement("style");
				tag.id = id;
				tag.textContent = CSS;
				document.head.append(tag);
			}, []);
		}

		//#endregion

		//#region 数据

		/**
		 * 拉取用量载荷。
		 *
		 * @param query - 查询串，如 `range=month`。
		 * @param signal - 中止信号。
		 * @returns 载荷。
		 */
		async function fetchUsage(query, signal) {
			const response = await fetch(`${API}?${query}`, { signal, headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		}

		/**
		 * 按范围订阅用量数据。
		 *
		 * 三个体验问题的共同根因都在这里，逐个解决：
		 *
		 * 1. **打开面板要等**——原来只有面板挂载后才发请求，数据到达前什么都不渲染。
		 *    现在改为**模块级缓存 + 徽章挂载时预热**：打开面板时缓存已有数据，立即出画面，
		 *    后台再刷新一次。缓存按查询串存，切回看过的范围同样瞬时。
		 * 2. **数字不更新**——原来只在挂载时取一次，之后永不刷新。现在每 30 秒静默刷新
		 *    当前范围，并在窗口重新获得焦点时立即刷新。
		 * 3. 刷新期间保留旧数据，避免画面闪回骨架屏。
		 *
		 * ## 三态收敛：加载中 / 有数据 / 失败
		 *
		 * 状态里记着**它属于哪个 query**（`state.query`），这是本函数的核心不变量：
		 *
		 * - 范围一变，上一个 query 的载荷**立即作废**。载荷里带着它自己的
		 *   `range.label`，把它留给新范围就会让标签与数字「自洽地错」——用户点的是
		 *   「近 7 天」，看到的却是「本月」的标签配本月的数字。
		 * - 只有**同一 query** 的刷新才保留旧数据。旧数据的正当用途仅此一处：静默刷新
		 *   时画面不闪回骨架屏。
		 * - 失败分两种：**刷新失败**（`refreshError`，已有数据仍在画面上，只加一条提示）
		 *   与**致命错误**（`error`，没有任何数据可用，整块换成错误页）。混为一谈会让
		 *   一次后台刷新失败把好数据换成错误页。
		 *
		 * `refreshing` 只在**确实有请求在飞**时为真。刷新失败后它必须回到 false，
		 * 否则标题旁会永远挂着「更新中…」——那是一句假话，而且永不消失。
		 *
		 * @param range - `{kind, from, to}`。
		 * @returns `{data, error, loading, refreshing, refreshError, reload}`。
		 */
		const usageCache = new Map();

		function useUsage(range) {
			const query = (() => {
				const params = new URLSearchParams({ range: range.kind });
				if (range.kind === "custom") {
					if (range.from) params.set("from", range.from);
					if (range.to) params.set("to", range.to);
				}
				return params.toString();
			})();
			const [state, setState] = useState(() => {
				const hit = usageCache.get(query);
				return {
					query,
					data: hit ?? null,
					error: null,
					loading: hit === undefined,
					refreshing: hit !== undefined,
					refreshError: null,
				};
			});
			const [nonce, setNonce] = useState(0);

			useEffect(() => {
				const controller = new AbortController();
				const hit = usageCache.get(query);
				// 有缓存就先把画面放出来，同时后台刷新；没缓存才显示加载态。
				setState((prev) => {
					// 同一 query 的刷新保留旧数据；范围一变，旧载荷立即作废。
					const kept = prev.query === query ? prev.data : null;
					const data = hit ?? kept;
					return { query, data, error: null, loading: data === null, refreshing: data !== null, refreshError: null };
				});
				fetchUsage(query, controller.signal)
					.then((payload) => {
						usageCache.set(query, payload);
						// 迟到的成功属于已经切走的范围：缓存照填，但不许它把画面改回去。
						setState((prev) =>
							prev.query === query ? { query, data: payload, error: null, loading: false, refreshing: false, refreshError: null } : prev,
						);
					})
					.catch((error) => {
						if (error?.name === "AbortError") return;
						const message = error?.message ?? String(error);
						setState((prev) => {
							if (prev.query !== query) return prev;
							if (prev.data !== null) {
								// 刷新失败：旧数据继续显示，但必须说出来——否则用户以为它是最新的。
								return { ...prev, loading: false, refreshing: false, refreshError: message };
							}
							// 没有任何数据可用：这是致命错误，必须可见。
							return { ...prev, loading: false, refreshing: false, error: message };
						});
					});
				return () => controller.abort();
			}, [query, nonce]);

			// 这一帧能用的数据，只属于**当前** query。
			//
			// effect 在真实 React 里是渲染**之后**才跑的，所以「范围刚变」的那一帧里
			// `state.query` 还是旧值。若直接把它交出去，用户看到的就是上一个范围的
			// 标签与数字——正是「自洽地错」的来源。所以这里按 query 归属过滤一遍：
			// 不属于当前 query 的载荷一律作废，只有缓存里确实有的才拿来用。
			const owned = state.query === query;
			const hit = usageCache.get(query);
			const data = owned ? state.data : (hit ?? null);
			const error = owned ? state.error : null;
			const loading = owned ? state.loading : data === null;
			const refreshing = owned ? state.refreshing : data !== null;
			const refreshError = owned ? state.refreshError : null;

			return {
				data,
				error,
				loading,
				refreshing,
				refreshError,
				reload: useCallback(() => {
					usageCache.delete(query);
					setNonce((value) => value + 1);
				}, [query]),
			};
		}

		/** 所有已挂载面板共享的自动刷新。 */
		function useAutoRefresh(query, onRefresh) {
			useEffect(() => {
				const timer = setInterval(onRefresh, 30_000);
				const onFocus = () => onRefresh();
				window.addEventListener("focus", onFocus);
				return () => {
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, [query, onRefresh]);
		}

		/** 范围选择的持久化键。 */
		const RANGE_KEY = "usage-ledger.range";

		/**
		 * 读取上次选择的范围。
		 *
		 * 存 `localStorage` 而不是内存：用户期望的是「关掉浏览器再打开也还是上次那个范围」。
		 * 解析失败时退回默认值，不让一条坏记录把面板卡住。
		 *
		 * @returns `{kind, from, to}`。
		 */
		function loadRange() {
			try {
				const raw = window.localStorage.getItem(RANGE_KEY);
				if (raw !== null) {
					const parsed = JSON.parse(raw);
					if (parsed !== null && typeof parsed === "object" && typeof parsed.kind === "string") {
						return { kind: parsed.kind, from: parsed.from ?? "", to: parsed.to ?? "" };
					}
				}
			} catch {
				// 隐私模式或配额满：退回默认范围即可。
			}
			return { kind: "month", from: "", to: "" };
		}

		/**
		 * 记住当前范围。
		 *
		 * @param range - `{kind, from, to}`。
		 */
		function saveRange(range) {
			try {
				window.localStorage.setItem(RANGE_KEY, JSON.stringify(range));
			} catch {
				// 存不了不影响本次使用。
			}
		}

		//#endregion

		//#region 分档与排序

		/**
		 * 线性插值取分位点。
		 *
		 * 不用「取第 k 个」：活跃日往往只有十几个，取整下标会让相邻边界落到同一个
		 * 值上，四档随即塌成一两档。
		 *
		 * @param sorted - 已升序排好的数值数组。
		 * @param p - 分位，0..1。
		 * @returns 分位点。
		 */
		function quantile(sorted, p) {
			if (sorted.length === 0) return 0;
			const position = (sorted.length - 1) * p;
			const lower = Math.floor(position);
			const upper = Math.ceil(position);
			if (lower === upper) return sorted[lower];
			return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
		}

		/**
		 * 造一个分档函数：按**活跃日**的分位数把热力图切成 L1..L4。
		 *
		 * 线性分档（当日 token / 全窗口峰值）在这里是错的：本机 13 个活跃日里最高日
		 * 是中位数的 18.6 倍，一个峰值就把其余 12 天全压进最低档——实测 L1=10、L2=1、
		 * L3=0、L4=2，整年看起来像只有两天在干活。分位数只看排序后的**位置**，峰值
		 * 再高也只占最高那一档。
		 *
		 * 只有三个边界 P25/P50/P75，对应 L1..L4：四档需要三个切点。若再切一个 P90，
		 * (P75, P90] 与 (P90, max] 会落进同一档——那是死代码，不是更细的分辨率。
		 *
		 * `v === max` 的短路是**尺度保证**，不是优化：最高的活跃日必须是 L4。否则只有
		 * 一天有记录的用户会看到那一格是最浅档（P75 恰好等于该值，落进 L1），明显是
		 * 错的。有了它，n=1/2/3 不需要任何「小样本退化」特例，也不会除零。
		 *
		 * 边界用「小于等于」比较：分位点相等（大量重复值，例如每天都是 100）时全部
		 * 落进最高档，既不崩也不塌成随机色，且仍满足「最忙的一天是 L4」。
		 *
		 * @param activity - `[{tokens}]`；0 token 的日子不参与分位。
		 * @returns `(tokens) => 0..4` 的纯函数。
		 */
		function makeLevelScale(activity) {
			const active = (activity ?? [])
				.map((row) => row?.tokens ?? 0)
				.filter((tokens) => typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)
				.sort((a, b) => a - b);
			const max = active.length === 0 ? 0 : active[active.length - 1];
			const cuts = active.length === 0 ? [] : [quantile(active, 0.25), quantile(active, 0.5), quantile(active, 0.75)];
			return (tokens) => {
				if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return 0;
				if (tokens >= max) return 4;
				let level = 1;
				for (const cut of cuts) {
					if (tokens > cut) level += 1;
				}
				return Math.min(4, level);
			};
		}

		/**
		 * 取一行里某一列的数值，非数值一律算缺失（null）。
		 *
		 * @param row - 数据行。
		 * @param key - 列键。
		 * @returns 数值或 null。
		 */
		function valueOf(row, key) {
			const value = row?.[key];
			return typeof value === "number" && Number.isFinite(value) ? value : null;
		}

		/**
		 * 按列与方向排序，缺失值恒排最后。
		 *
		 * 「缺失」不能当成 0：未定价的模型 cost 是 null，当成 0 会让它随升降序在
		 * 沉底与顶头之间跳——它根本不该参与数值比较，任何方向都排最后。
		 *
		 * @param rows - 数据行数组。
		 * @param key - 排序键。
		 * @param direction - `"asc" | "desc"`。
		 * @returns 排好序的新数组（不改原数组）。
		 */
		function sortRows(rows, key, direction) {
			const sign = direction === "asc" ? 1 : -1;
			return [...rows].sort((a, b) => {
				const left = valueOf(a, key);
				const right = valueOf(b, key);
				if (left === null && right === null) return 0;
				if (left === null) return 1;
				if (right === null) return -1;
				if (left === right) return 0;
				return left < right ? -sign : sign;
			});
		}

		//#endregion

		//#region 组件

		/**
		 * 全年活跃度热力图。
		 *
		 * 固定 371 天（整周对齐）的窗口，与所选范围无关——它表达的是「作息」，
		 * 不是「本次筛选结果」。
		 *
		 * @param props - `{activity, activityDays, timeZone}`。
		 * @returns 热力图节点。
		 */
		function Heatmap({ activity, activityDays, timeZone }) {
			const byDay = new Map((activity ?? []).map((row) => [row.day, row]));
			const days = Number.isFinite(activityDays) ? activityDays : 371;

			// 以本地「今天」为终点向前推，保证最后一列是本周。
			const end = new Date();
			const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
			// 对齐到周一，避免首列只有半截。
			const lead = (start.getDay() + 6) % 7;
			const cells = [];
			for (let index = 0; index < lead; index += 1) cells.push(null);
			for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
				cells.push(keyOf(cursor));
			}
			while (cells.length % 7 !== 0) cells.push(null);

			// 档位边界只由活跃日的分位数决定，与全窗口峰值无关：一个峰值压不平一整年。
			const level = makeLevelScale(activity);

			const weeks = cells.length / 7;
			const monthLabels = [];
			for (let week = 0; week < weeks; week += 1) {
				const first = cells[week * 7];
				if (week === 0 || (first !== null && first.slice(8, 10) <= "07")) {
					const anchor = first ?? cells.slice(week * 7, week * 7 + 7).find((day) => day !== null);
					monthLabels.push(anchor === undefined || anchor === null ? "" : `${Number(anchor.slice(5, 7))}月`);
				} else monthLabels.push("");
			}

			const columns = [];
			const dayLabels = ["一", "二", "三", "四", "五", "六", "日"];
			// 列宽自适应：53 周铺满面板宽度，不再固定 12px 而被迫横向滚动。
			// `minmax(0, 1fr)` 是关键——没有它，网格项的固有宽度会把容器撑破。
			const gridTemplate = `repeat(${weeks}, minmax(0, 1fr))`;
			return h(
				"div",
				null,
				h(
					"div",
					{ className: "ul-heatwrap" },
					h("div", { className: "ul-heatdays" }, dayLabels.map((label, index) => h("span", { key: index }, label))),
					h(
						"div",
						{ style: { flex: "1 1 auto", minWidth: 0 } },
						h(
							"div",
							{ className: "ul-monthrow", style: { gridTemplateColumns: gridTemplate } },
							monthLabels.map((label, index) => h("span", { key: index }, label)),
						),
						h(
							"div",
							{ className: "ul-heat", style: { gridTemplateColumns: gridTemplate } },
							cells.map((day, index) => {
								const row = day === null ? undefined : byDay.get(day);
								const tokens = row?.tokens ?? 0;
								const tip = day === null ? "" : `${day}　${fmtTokens(tokens)} tokens　${fmtCount(row?.requests ?? 0)} 次请求`;
								// 档位只写进 `data-l`，颜色交给 CSS 按主题给——单元格不再自己算色值。
								return h("i", { key: index, title: tip, "data-l": String(level(tokens)), style: day === null ? { visibility: "hidden" } : {} });
							}),
						),
						h(
							"div",
							{ className: "ul-legend" },
							h("span", null, "少"),
							// 图例色块与真实格子走同一套 `data-l`，保证两者颜色永远一致。
							[0, 1, 2, 3, 4].map((value) => h("i", { key: value, "data-l": String(value) })),
							h("span", null, "多"),
							h("span", { className: "ul-muted", style: { marginLeft: "8px" } }, `UTC${(timeZone?.offset ?? 0) >= 0 ? "+" : ""}${timeZone?.offset ?? 0}`),
						),
					),
				),
			);
		}

		/**
		 * 未定价提示。
		 *
		 * 只说「有哪些模型没定价」是不够的——真正要回答的是「这个官方价折算能信几成」。
		 * 所以这里算出未定价 token 占总量多少：占比高时，官方价折算就是个偏低的残缺值，
		 * 面板必须说清楚，否则用户会把「估算 ¥8」当成实际账单。
		 *
		 * @param props - `{cost, models, currency}`。
		 * @returns 提示节点或 null。
		 */
		function UnpricedNotice({ cost, models, currency }) {
			const unpriced = cost?.unpriced ?? [];
			if (unpriced.length === 0) return null;
			const totalTokens = (models ?? []).reduce((sum, row) => sum + (row.tokens ?? 0), 0);
			const missingTokens = (models ?? [])
				.filter((row) => row.cost === null || row.cost === undefined)
				.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
			const share = totalTokens === 0 ? 0 : Math.round((missingTokens / totalTokens) * 100);
			// 按 token 占比排序：谁最值得先补价格，一目了然。
			const ranked = [...(models ?? [])]
				.filter((row) => row.cost === null || row.cost === undefined)
				.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
				.slice(0, 6);
			return h(
				"div",
				{ className: "ul-warn" },
				h(
					"div",
					null,
					`未定价：${unpriced.length} 个模型，占 ${share}% 的 token 量`,
					share >= 20 ? "　—— 官方价折算偏低，仅供参考" : "",
				),
				h(
					"div",
					{ style: { marginTop: "4px" } },
					ranked.map((row) => h("div", { key: row.model, className: "ul-muted" }, `· ${row.provider}/${row.model}　${fmtTokens(row.tokens)}`)),
				),
				h(
					"div",
					{ className: "ul-muted", style: { marginTop: "4px" } },
					"在 $DSH_HOME/usage-ledger-pricing.json 里按每百万 token 填价格即可（改完自动生效，无需重启）。",
				),
			);
		}

		/**
		 * 可排序明细表。
		 *
		 * @param props - `{rows, columns, nameOf, currency, sort, onSort}`；`sort` 是
		 *   `{key, direction}`，`onSort(key)` 由面板决定「切方向还是换列」。
		 * @returns 表格节点。
		 */
		function DetailTable({ rows, columns, nameOf, currency, sort, onSort }) {
			const max = Math.max(1, ...rows.map((row) => row.tokens ?? 0));
			const table = h(
				"table",
				{ className: "ul-table" },
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						columns.map((column) => {
							// 「名称」列不可排序：它既不是数值、也不该装成能排。
							// 一个点了不改变行序的表头就是在说谎，所以这里连箭头都不给。
							if (column.sortable === false) return h("th", { key: column.key, scope: "col" }, column.label);
							const active = sort.key === column.key;
							return h(
								"th",
								{
									key: column.key,
									scope: "col",
									// aria-sort 只描述**这一列当前**的排序方向；未激活的列一律 none。
									"aria-sort": active ? (sort.direction === "asc" ? "ascending" : "descending") : "none",
								},
								h(
									"button",
									{
										type: "button",
										className: "ul-sort",
										title: "点击排序",
										onClick: () => onSort(column.key),
									},
									column.label,
									// 箭头必须反映真实方向，不能无条件拼 ↓。
									active ? h("span", { className: "ul-arrow" }, sort.direction === "asc" ? " ↑" : " ↓") : null,
								),
							);
						}),
					),
				),
				h(
					"tbody",
					null,
					rows.map((row, index) =>
						h(
							"tr",
							{ key: index },
							h(
								"td",
								null,
								h("span", { className: "ul-name", title: nameOf(row) }, nameOf(row)),
							),
							columns.slice(1).map((column) =>
								h("td", { key: column.key }, column.render(row, max, currency)),
							),
						),
					),
				),
			);
			// 表格自己横向滚动。以前 `overflow:auto` 在 `.ul-panel` 上，表格一超宽就把
			// 表头、范围标签、卡片一起推走——整块面板都在滑。现在只有表格内部滑。
			return h("div", { className: "ul-tablewrap" }, table);
		}

		/**
		 * 汇总卡片。
		 *
		 * @param props - `{totals, cost, currency}`。
		 * @returns 卡片区节点。
		 */
		function SummaryCards({ totals, cost, currency }) {
			const cards = [
				["消耗总量", fmtTokens(totals.tokens)],
				["请求", fmtCount(totals.requests)],
				["输入", fmtTokens(totals.inputTokens)],
				["输出", fmtTokens(totals.outputTokens)],
				["缓存读", fmtTokens(totals.cacheReadTokens)],
				["缓存写", fmtTokens(totals.cacheWriteTokens)],
				["推理", fmtTokens(totals.reasoningTokens)],
				["缓存命中率", `${totals.cacheHitRate ?? 0}%`],
				// 标签刻意写「官方价折算」而不是「费用」：这个数字与真实账单无关，
				// 它是把 token 量按各家官方挂牌价折算出来的**消耗程度**。用户实际
				// 走的是中转站（有折扣、积分、免费额度），真实扣款通常低于此值。
				// 把它叫「费用」会让人当成账单，那是错的。
				["官方价折算", cost?.priced ? fmtMoney(cost.total, currency) : "—"],
			];
			return h(
				"div",
				{ className: "ul-cards" },
				cards.map(([key, value]) => h("div", { className: "ul-card", key }, h("div", { className: "k" }, key), h("div", { className: "v" }, value))),
			);
		}

		/**
		 * 面板主体。
		 *
		 * @param props - `{onClose}`。
		 * @returns 面板节点。
		 */
		function Panel({ onClose }) {
			useStyles();
			// 初值取自上次选择，这样「上次看的是累计，这次打开还是累计」。
			const initial = useRef(loadRange());
			const [kind, setKind] = useState(initial.current.kind);
			const [from, setFrom] = useState(initial.current.from);
			const [to, setTo] = useState(initial.current.to);
			// 排序状态是 `{key, direction}` 而不是单个 key：没有方向就没有升降序，
			// 箭头也就无从谈起。两张表各存一份，互不影响。
			const [sort, setSort] = useState({
				models: { key: "tokens", direction: "desc" },
				providers: { key: "tokens", direction: "desc" },
			});
			const { data, error, loading, refreshing, refreshError, reload } = useUsage({ kind, from, to });
			// 打开面板时焦点必须进得来，否则键盘用户根本到不了里面。
			const panelRef = useRef(null);

			// 每次范围变化都记下来。
			useEffect(() => {
				saveRange({ kind, from, to });
			}, [kind, from, to]);

			// 面板开着的时候让数字自己跟上，不用手动点刷新。
			useAutoRefresh(`${kind}:${from}:${to}`, useCallback(() => reload(), [reload]));

			useEffect(() => {
				panelRef.current?.focus();
			}, []);

			/**
			 * 点表头：同一列切换方向，换一列则从 desc 重新开始。
			 *
			 * 数值列默认降序是刻意的——「谁最多」才是打开表格时最想问的问题；
			 * 但一旦用户已经点过某一列，就不该再替他改方向。
			 *
			 * @param which - `"models" | "providers"`。
			 * @param key - 被点击的列键。
			 */
			const toggleSort = (which, key) => {
				setSort((prev) => {
					const current = prev[which];
					if (current.key === key) return { ...prev, [which]: { key, direction: current.direction === "desc" ? "asc" : "desc" } };
					return { ...prev, [which]: { key, direction: "desc" } };
				});
			};

			const providerRows = data === null ? [] : sortRows(data.providers ?? [], sort.providers.key, sort.providers.direction);
			const modelRows = data === null ? [] : sortRows(data.models ?? [], sort.models.key, sort.models.direction);

			const tabs = [
				["today", "今日"],
				["week", "近 7 天"],
				["month", "本月"],
				["all", "累计"],
				["custom", "自定义"],
			];

			const columns = [
				// 名称列 sortable:false —— 见 DetailTable：不渲染成按钮、无箭头、无 title。
				{ key: "name", label: "名称", sortable: false },
				{ key: "tokens", label: "tokens", render: (row, max) =>
					h("div", { style: { display: "flex", gap: "6px", alignItems: "center", justifyContent: "flex-end" } },
						// 进度条允许收缩：它是纯装饰，撑宽列只会把表格挤出面板。
						h("div", { className: "ul-bar", style: { flex: "1 1 44px", minWidth: 0, maxWidth: "90px" } },
							h("span", { style: { width: `${Math.max(2, Math.round(((row.tokens ?? 0) / max) * 100))}%` } })),
						// 这里原本有个 76px 的硬下限，正是表格 min-content ≈837px 超出面板内宽
						// 728px 的主因；数值列按内容定宽即可。
						h("span", { className: "ul-num" }, fmtTokens(row.tokens))) },
				{ key: "requests", label: "请求", render: (row) => fmtCount(row.requests) },
				{ key: "inputTokens", label: "输入", render: (row) => fmtTokens(row.inputTokens) },
				{ key: "outputTokens", label: "输出", render: (row) => fmtTokens(row.outputTokens) },
				{ key: "cacheReadTokens", label: "缓存读", render: (row) => fmtTokens(row.cacheReadTokens) },
				// 「缓存写」紧跟「缓存读」，与汇总卡片（SummaryCards）的口径和顺序一致：
				// 同一个数字在卡片里有、在明细表里却找不到，会让人以为表格漏算了。
				{ key: "cacheWriteTokens", label: "缓存写", render: (row) => fmtTokens(row.cacheWriteTokens) },
				{ key: "reasoningTokens", label: "推理", render: (row) => fmtTokens(row.reasoningTokens) },
				{ key: "cacheHitRate", label: "命中", render: (row) => `${row.cacheHitRate ?? 0}%` },
				{ key: "cost", label: "官方价折算", render: (row, _max, currency) => (row.cost === null || row.cost === undefined ? h("span", { className: "ul-muted" }, "—") : fmtMoney(row.cost, currency)) },
			];

			// Esc 的监听器挂在面板上而不是 window 上：面板外的按键不该被这里吃掉。
			// 日期输入框也在面板内，Esc 在输入框里同样关闭——这与宿主其它对话框一致。
			const onKeyDown = (event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onClose();
				}
			};

			return h(
				"div",
				{ className: "ul-root" },
				// 遮罩只负责视觉与点击关闭，对辅助技术隐藏——它不是内容，× 与 Esc 才是
				// 正经的关闭途径，遮罩不再是唯一出口。
				h("div", { className: "ul-backdrop", "aria-hidden": "true", onClick: onClose }),
				h(
					"div",
					{
						className: "ul-panel",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": "用量账本",
						// tabIndex:-1 让容器可被程序化聚焦，但不进入 Tab 顺序。
						tabIndex: -1,
						ref: panelRef,
						onKeyDown,
					},
					h(
						"div",
						{ className: "ul-head" },
						h("div", { className: "ul-title" }, "用量账本"),
						data !== null ? h("div", { className: "ul-muted", style: { fontSize: "11px" } }, data.range?.label ?? "") : null,
						// 刷新状态可见，但不遮挡内容：刷新时画面仍是旧数据，只是标题旁转一下。
						// 只在**确实有请求在飞**时出现——刷新失败后它必须消失，否则这句话是假的。
						refreshing ? h("div", { className: "ul-muted", style: { fontSize: "11px" } }, "更新中…") : null,
						h("button", { className: "ul-iconbtn", onClick: reload, title: "刷新" }, "↻"),
						h("button", { className: "ul-iconbtn", onClick: onClose, title: "关闭" }, "×"),
					),
					h(
						"div",
						{ className: "ul-tabs" },
						tabs.map(([value, label]) =>
							h("button", { key: value, className: "ul-tab", "data-on": kind === value ? "1" : "0", onClick: () => setKind(value) }, label),
						),
						kind === "custom"
							? [
									h("input", { key: "f", className: "ul-date", type: "date", value: from, onChange: (event) => setFrom(event.target.value), title: "起始" }),
									h("span", { key: "s", className: "ul-muted" }, "→"),
									h("input", { key: "t", className: "ul-date", type: "date", value: to, onChange: (event) => setTo(event.target.value), title: "结束" }),
								]
							: null,
					),

					error !== null
						? h("div", { className: "ul-err" }, `读取失败：${error}`)
						: data === null
							? h("div", { className: "ul-load" }, loading ? "正在读取本地会话日志…" : "暂无数据")
							: h(
									"div",
									null,
									// 刷新失败与致命错误是两回事：这里**有**数据，所以只加一条提示，
									// 绝不把已经画出来的好数据换成错误页。不说出来的话，用户会把
									// 旧数字当成刚拉到的，那比看到一条错误更糟。
									refreshError !== null
										? h("div", { className: "ul-warn" }, `刷新失败：${refreshError}　—— 以下仍是上一次成功读取的数据。`)
										: null,
									h(SummaryCards, { totals: data.totals, cost: data.cost, currency: data.cost?.currency }),
									h(
										"div",
										{ className: "ul-sec" },
										h("h4", null, "活跃度", h("span", { className: "hint" }, `近一年，共 ${fmtCount((data.activity ?? []).length)} 天有记录`)),
										h(Heatmap, { activity: data.activity, activityDays: data.activityDays, timeZone: data.timeZone }),
									),
									h(
										"div",
										{ className: "ul-sec" },
										h("h4", null, "分渠道", h("span", { className: "hint" }, `${providerRows.length} 个`)),
										h(DetailTable, {
											rows: providerRows,
											columns,
											nameOf: (row) => row.provider,
											currency: data.cost?.currency,
											sort: sort.providers,
											onSort: (key) => toggleSort("providers", key),
										}),
									),
									h(
										"div",
										{ className: "ul-sec" },
										h("h4", null, "分模型", h("span", { className: "hint" }, `${modelRows.length} 个`)),
										h(DetailTable, {
											rows: modelRows,
											columns,
											nameOf: (row) => row.model,
											currency: data.cost?.currency,
											sort: sort.models,
											onSort: (key) => toggleSort("models", key),
										}),
									),
									data.cost?.priced !== true || (data.cost?.unpriced ?? []).length > 0
										? h(UnpricedNotice, { cost: data.cost, models: modelRows, currency: data.cost?.currency })
										: null,
									h(
										"div",
										{ className: "ul-foot" },
										h("span", null, `扫描 ${fmtCount(data.diagnostics?.files ?? 0)} 个会话文件`),
										h("span", null, `用时 ${fmtCount(data.diagnostics?.scanned ?? 0)} 新 / ${fmtCount(data.diagnostics?.cached ?? 0)} 缓存`),
										h("span", null, data.timeZone?.name ?? ""),
									),
									// 读不出来的文件必须说出来。正常时这行不占位置；一旦出现，
									// 它解释的是「为什么面板上的总量比预期少」——这正是
									// 「静默失败」最不该发生的地方。
									(data.diagnostics?.failed ?? 0) > 0
										? h(
												"div",
												{ className: "ul-warn", style: { marginTop: "8px" } },
												`${fmtCount(data.diagnostics.failed)} 个会话文件无法读取，未计入下面的数字。`,
											)
										: null,
									// 口径说明。这句话必须显眼：数字容易被当成账单，而它衡量的是消耗程度。
									h(
										"div",
										{ className: "ul-muted", style: { fontSize: "11px", marginTop: "8px", lineHeight: 1.5 } },
										"「官方价折算」= 把 token 量按各厂商官方挂牌价折算，用于横向比较消耗程度；",
										"与你实际走的渠道、真实扣款无关（中转站常有折扣、积分或免费额度）。",
									),
								),
				),
			);
		}

		/**
		 * 侧边栏底部的入口徽章。
		 *
		 * @returns 徽章节点。
		 */
		function Badge() {
			useStyles();
			const [open, setOpen] = useState(false);
			const [today, setToday] = useState(() => usageCache.get("range=today") ?? null);
			// 加载中与失败必须可区分：两者都还没有数字，但「正在拉」与「拉不到」对用户
			// 是两件事。原来两个 `.catch(() => undefined)` 让失败永远停在「…」上。
			const [todayError, setTodayError] = useState(null);
			const mounted = useRef(true);
			// 关闭后焦点要归还给徽章，否则键盘用户会被扔回页面顶部。
			const badgeRef = useRef(null);

			/**
			 * 取今日用量，并把用户上次选择的范围也一并预热。
			 *
			 * 预热上次范围才是「打开要等」的正解：实测徽章出现后用户往往在几百毫秒内
			 * 就点开，而那时若目标范围的缓存是空的，面板就得干等一次请求（实测 831ms）。
			 * 提前把它填好，点开就只剩渲染（实测 26ms）。
			 *
			 * 两个请求并发发出，谁先回来都不影响另一个。
			 *
			 * 预热请求失败**不**影响徽章：它只是替面板省一次等待，失败了面板自己会重取。
			 * 今日请求失败才要说话——而且只在**没有**可用数字时才把「…」换成失败态；
			 * 已经有数字时保留数字，失败通过 title 表达，免得把已知的信息抹掉。
			 */
			const load = useCallback(() => {
				const remembered = loadRange();
				const warmQuery = remembered.kind === "custom" && remembered.from
					? `range=custom&from=${encodeURIComponent(remembered.from)}${remembered.to ? `&to=${encodeURIComponent(remembered.to)}` : ""}`
					: `range=${remembered.kind}`;
				fetchUsage(warmQuery)
					.then((data) => usageCache.set(warmQuery, data))
					.catch(() => undefined);
				fetchUsage("range=today")
					.then((data) => {
						usageCache.set("range=today", data);
						if (!mounted.current) return;
						setToday(data);
						setTodayError(null);
					})
					.catch((error) => {
						if (error?.name === "AbortError") return;
						if (mounted.current) setTodayError(error?.message ?? String(error));
					});
			}, []);

			useEffect(() => {
				mounted.current = true;
				load();
				// 徽章上的数字也要自己走，否则它会一直停在打开页面那一刻的值。
				const timer = setInterval(load, 30_000);
				const onFocus = () => load();
				window.addEventListener("focus", onFocus);
				return () => {
					mounted.current = false;
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, [load]);

			// 有数字就显示数字；没有数字时，「…」表示还在拉，「读取失败」表示拉不到——
			// 三者互不混同。数字缺位是唯一能把失败画成文字的地方，所以只在缺位时替换；
			// 但**无论有没有数字**，失败都要在 title 上说出来：否则用户会把上一次的
			// 数字当成刚拉到的。
			const badgeTitle = todayError !== null ? "用量账本（今日数据读取失败）" : "用量账本（本地会话日志统计）";

			return h(
				"div",
				{ className: "ul-root" },
				h(
					"button",
					{ className: "ul-badge", ref: badgeRef, onClick: () => setOpen((value) => !value), title: badgeTitle },
					h("span", { className: "dot" }),
					h("span", { className: "t" }, "用量账本"),
					h(
						"span",
						{ className: "n" },
						today !== null ? fmtTokens(today.totals?.tokens ?? 0) : todayError !== null ? "读取失败" : "…",
					),
				),
				// 关闭路径统一走这里：归还焦点。徽章按钮上再点一次会关闭面板，而那时
				// 焦点本来就在徽章上，再 focus 一次是幂等的，所以两条路径共用一个函数。
				open
					? h(Panel, {
							onClose: () => {
								setOpen(false);
								// 面板因整个组件卸载而关闭时 `current` 是 null，可选链挡住它。
								badgeRef.current?.focus();
							},
						})
					: null,
			);
		}

		//#endregion

		/** 客户端半边需要宿主先提供插槽服务。 */
		const inject = ["slots"];

		/**
		 * 注册入口。
		 *
		 * 用 `slots.inject` 而不是裸 `register`：侧边栏可能晚于本 bundle 声明该插槽，
		 * 等它出现比假设它已在更稳。
		 *
		 * @param ctx - 客户端上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => {
				return ctx.slots.register({ name: "sidebar.footer.action", id: "usage-ledger", order: 20 }, Badge);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.Badge = Badge;
		exports.Panel = Panel;
		exports.Heatmap = Heatmap;
		exports.fmtTokens = fmtTokens;

		// 必须显式返回 module.exports。
		//
		// 模块系统把 factory 的**返回值**当作本模块的导出
		// （`exports: registered.factory(require)`）。只往 `exports` 上挂属性却不
		// 返回，导出就是 undefined，宿主随即抛
		// `invalid plugin, expect function or object with an "apply" method,
		// received undefined`——整个 Web 界面因此起不来。官方 bundle 与
		// TokenLedger 结尾都写着 `return module.exports;`：这不是风格，是契约。
		return module.exports;
	},
});
