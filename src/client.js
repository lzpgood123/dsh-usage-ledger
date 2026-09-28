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
		 * 把 `YYYY-MM-DD` 折算成 `M/D`。
		 *
		 * @param day - 日期键。
		 * @returns 短日期。
		 */
		function shortDay(day) {
			const parts = String(day).split("-");
			return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : day;
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
.ul-root{--ul-gap:10px;--ul-radius:10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-text-primary,#e6e6e6)}
.ul-backdrop{position:fixed;inset:0;z-index:60}
.ul-panel{position:fixed;z-index:61;left:12px;bottom:64px;width:min(760px,calc(100vw - 24px));max-height:min(78vh,820px);overflow:auto;
  background:var(--dsw-alias-bg-layer-1,#1b1b1b);border:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.12));border-radius:var(--ul-radius);
  box-shadow:0 18px 48px rgba(0,0,0,.45);padding:14px 16px 16px}
.ul-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ul-title{font-size:13px;font-weight:600;flex:1}
.ul-iconbtn{background:transparent;border:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.14));color:inherit;border-radius:6px;
  width:26px;height:26px;line-height:1;cursor:pointer;font-size:13px;padding:0}
.ul-iconbtn:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06))}
.ul-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.ul-tab{background:transparent;border:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.14));color:inherit;border-radius:999px;
  padding:3px 11px;cursor:pointer;font-size:12px}
.ul-tab[data-on="1"]{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));border-color:transparent;font-weight:600}
.ul-date{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.14));
  color:inherit;border-radius:6px;padding:3px 6px;font-size:11px}
.ul-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin-bottom:12px}
.ul-card{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));border:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.08));
  border-radius:8px;padding:8px 10px}
.ul-card .k{font-size:11px;opacity:.66;margin-bottom:2px}
.ul-card .v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.ul-sec{margin-top:14px}
.ul-sec>h4{margin:0 0 7px;font-size:12px;font-weight:600;opacity:.85;display:flex;gap:8px;align-items:baseline}
.ul-sec>h4 .hint{font-size:11px;opacity:.5;font-weight:400}
.ul-heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,minmax(0,1fr));gap:2px;align-content:start;flex:1 1 auto;min-width:0}
.ul-heat i{width:100%;aspect-ratio:1;border-radius:2px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));display:block}
.ul-heatwrap{display:flex;gap:6px;align-items:flex-start;padding-bottom:4px}
.ul-heatdays{display:grid;grid-template-rows:repeat(7,minmax(0,1fr));gap:2px;font-size:9px;opacity:.5;line-height:1;text-align:right;flex:0 0 auto;padding-top:15px}
.ul-monthrow{display:grid;gap:2px;font-size:9px;opacity:.55;margin-bottom:3px;flex:1 1 auto;min-width:0;overflow:hidden}
.ul-legend{display:flex;align-items:center;gap:4px;font-size:10px;opacity:.55;margin-top:5px}
.ul-legend i{width:10px;height:10px;border-radius:2px;display:block}
.ul-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.ul-table th{text-align:right;font-weight:500;opacity:.6;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.1));
  cursor:pointer;white-space:nowrap;user-select:none}
.ul-table th:first-child,.ul-table td:first-child{text-align:left}
.ul-table td{text-align:right;padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.05));white-space:nowrap}
.ul-table tr:hover td{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}
.ul-name{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom}
.ul-bar{position:relative;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));min-width:44px}
.ul-bar>span{position:absolute;inset:0 auto 0 0;border-radius:2px;background:var(--dsw-alias-brand-primary,#5b8def)}
.ul-muted{opacity:.55}
.ul-warn{background:rgba(224,160,0,.12);border:1px solid rgba(224,160,0,.35);border-radius:8px;padding:7px 9px;font-size:11px;margin-top:10px}
.ul-err{color:#e46a6a}
.ul-load{opacity:.6;padding:18px 0;text-align:center}
.ul-foot{display:flex;gap:10px;align-items:center;margin-top:12px;font-size:11px;opacity:.5}
.ul-badge{display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:0;color:inherit;cursor:pointer;
  padding:5px 8px;border-radius:7px;font-size:12px;text-align:left}
.ul-badge:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07))}
.ul-badge .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#5b8def);flex:0 0 auto}
.ul-badge .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-badge .n{font-variant-numeric:tabular-nums;opacity:.75}
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
		 * 3. 刷新期间保留旧数据（`stale` 标志），避免画面闪回骨架屏。
		 *
		 * @param range - `{kind, from, to}`。
		 * @returns `{data, error, loading, stale, reload}`。
		 */
		const usageCache = new Map();

		/** 当前范围键，供定时器判断是否需要刷新。 */
		function keyOfRange(range) {
			return range.kind === "custom" ? `custom:${range.from ?? ""}:${range.to ?? ""}` : range.kind;
		}

		function useUsage(range) {
			const query = (() => {
				const params = new URLSearchParams({ range: range.kind });
				if (range.kind === "custom") {
					if (range.from) params.set("from", range.from);
					if (range.to) params.set("to", range.to);
				}
				return params.toString();
			})();
			const cached = usageCache.get(query);
			const [state, setState] = useState({
				data: cached ?? null,
				error: null,
				loading: cached === undefined,
				stale: cached !== undefined,
			});
			const [nonce, setNonce] = useState(0);

			useEffect(() => {
				const controller = new AbortController();
				const hit = usageCache.get(query);
				// 有缓存就先把画面放出来，同时后台刷新；没缓存才显示加载态。
				setState((prev) => ({
					data: hit ?? prev.data,
					error: null,
					loading: hit === undefined,
					stale: hit !== undefined,
				}));
				fetchUsage(query, controller.signal)
					.then((data) => {
						usageCache.set(query, data);
						setState({ data, error: null, loading: false, stale: false });
					})
					.catch((error) => {
						if (error?.name === "AbortError") return;
						// 刷新失败时，有旧数据就继续用，别把已有画面换成错误。
						setState((prev) => (prev.data !== null ? { ...prev, loading: false, stale: true } : { data: null, error: error?.message ?? String(error), loading: false, stale: false }));
					});
				return () => controller.abort();
			}, [query, nonce]);

			return {
				...state,
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

			const max = Math.max(1, ...(activity ?? []).map((row) => row.tokens ?? 0));
			const level = (tokens) => {
				if (!tokens) return 0;
				const ratio = tokens / max;
				if (ratio > 0.66) return 4;
				if (ratio > 0.33) return 3;
				if (ratio > 0.1) return 2;
				return 1;
			};
			const shade = (value) => {
				if (value === 0) return "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))";
				const alpha = [0, 0.28, 0.48, 0.7, 1][value];
				return `color-mix(in srgb, var(--dsw-alias-brand-primary,#4ea1ff) ${Math.round(alpha * 100)}%, transparent)`;
			};

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
								return h("i", { key: index, title: tip, style: day === null ? { visibility: "hidden" } : { background: shade(level(tokens)) } });
							}),
						),
						h(
							"div",
							{ className: "ul-legend" },
							h("span", null, "少"),
							[0, 1, 2, 3, 4].map((value) => h("i", { key: value, style: { background: shade(value) } })),
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
		 * @param props - `{rows, columns, nameOf, currency, sortKey, onSort}`。
		 * @returns 表格节点。
		 */
		function DetailTable({ rows, columns, nameOf, currency, sortKey, onSort }) {
			const max = Math.max(1, ...rows.map((row) => row.tokens ?? 0));
			return h(
				"table",
				{ className: "ul-table" },
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						columns.map((column) =>
							h(
								"th",
								{ key: column.key, onClick: () => onSort(column.key), title: "点击排序" },
								column.label + (sortKey === column.key ? " ↓" : ""),
							),
						),
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
		 * @returns 面板节点。
		 */
		function Panel({ onClose }) {
			useStyles();
			// 初值取自上次选择，这样「上次看的是累计，这次打开还是累计」。
			const initial = useRef(loadRange());
			const [kind, setKind] = useState(initial.current.kind);
			const [from, setFrom] = useState(initial.current.from);
			const [to, setTo] = useState(initial.current.to);
			const [sort, setSort] = useState({ models: "tokens", providers: "tokens" });
			const { data, error, loading, stale, reload } = useUsage({ kind, from, to });

			// 每次范围变化都记下来。
			useEffect(() => {
				saveRange({ kind, from, to });
			}, [kind, from, to]);

			// 面板开着的时候让数字自己跟上，不用手动点刷新。
			useAutoRefresh(`${kind}:${from}:${to}`, useCallback(() => reload(), [reload]));

			const sortRows = (rows, key) => [...rows].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
			const providerRows = data === null ? [] : sortRows(data.providers ?? [], sort.providers);
			const modelRows = data === null ? [] : sortRows(data.models ?? [], sort.models);

			const tabs = [
				["today", "今日"],
				["week", "近 7 天"],
				["month", "本月"],
				["all", "累计"],
				["custom", "自定义"],
			];

			const columns = [
				{ key: "name", label: "名称" },
				{ key: "tokens", label: "tokens", render: (row, max) =>
					h("div", { style: { display: "flex", gap: "6px", alignItems: "center", justifyContent: "flex-end" } },
						h("div", { className: "ul-bar", style: { flex: "1 1 auto", maxWidth: "90px" } },
							h("span", { style: { width: `${Math.max(2, Math.round(((row.tokens ?? 0) / max) * 100))}%` } })),
						h("span", { style: { minWidth: "76px", textAlign: "right" } }, fmtTokens(row.tokens))) },
				{ key: "requests", label: "请求", render: (row) => fmtCount(row.requests) },
				{ key: "inputTokens", label: "输入", render: (row) => fmtTokens(row.inputTokens) },
				{ key: "outputTokens", label: "输出", render: (row) => fmtTokens(row.outputTokens) },
				{ key: "cacheReadTokens", label: "缓存读", render: (row) => fmtTokens(row.cacheReadTokens) },
				{ key: "reasoningTokens", label: "推理", render: (row) => fmtTokens(row.reasoningTokens) },
				{ key: "cacheHitRate", label: "命中", render: (row) => `${row.cacheHitRate ?? 0}%` },
				{ key: "cost", label: "官方价折算", render: (row, _max, currency) => (row.cost === null || row.cost === undefined ? h("span", { className: "ul-muted" }, "—") : fmtMoney(row.cost, currency)) },
			];

			return h(
				"div",
				{ className: "ul-root" },
				h("div", { className: "ul-backdrop", onClick: onClose }),
				h(
					"div",
					{ className: "ul-panel" },
					h(
						"div",
						{ className: "ul-head" },
						h("div", { className: "ul-title" }, "用量账本"),
						data !== null ? h("div", { className: "ul-muted", style: { fontSize: "11px" } }, data.range?.label ?? "") : null,
						// 刷新状态可见，但不遮挡内容：刷新时画面仍是旧数据，只是标题旁转一下。
						stale || loading ? h("div", { className: "ul-muted", style: { fontSize: "11px" } }, "更新中…") : null,
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
											sortKey: sort.providers,
											onSort: (key) => setSort((prev) => ({ ...prev, providers: key })),
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
											sortKey: sort.models,
											onSort: (key) => setSort((prev) => ({ ...prev, models: key })),
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
			const mounted = useRef(true);

			/**
			 * 取今日用量，并把用户上次选择的范围也一并预热。
			 *
			 * 预热上次范围才是「打开要等」的正解：实测徽章出现后用户往往在几百毫秒内
			 * 就点开，而那时若目标范围的缓存是空的，面板就得干等一次请求（实测 831ms）。
			 * 提前把它填好，点开就只剩渲染（实测 26ms）。
			 *
			 * 两个请求并发发出，谁先回来都不影响另一个。
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
						if (mounted.current) setToday(data);
					})
					.catch(() => undefined);
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

			return h(
				"div",
				{ className: "ul-root" },
				h(
					"button",
					{ className: "ul-badge", onClick: () => setOpen((value) => !value), title: "用量账本（本地会话日志统计）" },
					h("span", { className: "dot" }),
					h("span", { className: "t" }, "用量账本"),
					h("span", { className: "n" }, today === null ? "…" : fmtTokens(today.totals?.tokens ?? 0)),
				),
				open ? h(Panel, { onClose: () => setOpen(false) }) : null,
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
