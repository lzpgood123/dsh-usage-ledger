/**
 * 浏览器端 bundle 的纯函数测试。
 *
 * `src/client.js` 走的是 `__ModuleLoader__` 传统 bundle 通道，不能 `import`，
 * 所以这里通过 {@link loadClient} 的 stub-loader 夹具把它的导出取出来再断言。
 * 只测已经导出的东西（`fmtTokens` / `Heatmap` / `Badge` / `Panel` / `apply`
 * / `inject`）；`fmtMoney` 没有导出，只能经 `Panel` 的「官方价折算」卡片间接
 * 断言——**不为了好测去改 src/client.js**。
 *
 * @module usage-ledger/test/client.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findAll, findAllByClass, loadClient, textOf } from "./client-harness.js";


/**
 * 每个用例已经载入、尚未恢复的夹具。
 *
 * `node:test` 的 `t.after` 是**先进先出**，而一次 `loadClient` 只快照「载入那一刻」
 * 的全局值。若一个用例里载入多次又各挂一个 after，按 FIFO 恢复就会把前一次的桩
 * 重新装回去（后恢复的快照里含有先前的桩），于是桩泄漏到后续用例。所以这里每个
 * 用例只挂一个 after，并按**后进先出**恢复。
 */
const pending = new WeakMap();

/**
 * 载入 bundle 并把全局桩的收尾挂到用例上。
 *
 * 组件测试要留在 Node 里调用组件，所以 `keepStubs: true`，用完由 `t.after` 清理。
 *
 * @param t - `node:test` 的用例上下文。
 * @param options - 透传给 {@link loadClient}。
 * @returns 夹具返回值。
 */
async function load(t, options = {}) {
	const harness = await loadClient({ keepStubs: true, ...options });
	let loaded = pending.get(t);
	if (loaded === undefined) {
		loaded = [];
		pending.set(t, loaded);
		t.after(() => {
			for (const item of [...loaded].reverse()) item.restore();
		});
	}
	loaded.push(harness);
	return harness;
}

/** 造一个永远成功的 fetch 桩，固定返回同一份载荷。 */
function okFetch(payload) {
	return async () => ({ ok: true, status: 200, json: async () => payload });
}

/** 等一轮宏任务：让 `useUsage` 里的 promise 链落进模块级缓存。 */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** 把日期格式化成 `YYYY-MM-DD`，与 bundle 内部的 `keyOf` 口径一致。 */
function dayKey(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 热力图的日期格：带 `title` 的 `<i>`；图例色块没有 `title`。 */
function heatCells(node) {
	return findAll(node, (element) => element.type === "i" && typeof element.props?.title === "string");
}

/** 取汇总卡片里某一项的数值文本。 */
function cardValue(root, label) {
	const card = findAllByClass(root, "ul-card").find((element) => textOf(element.props.children[0]) === label);
	assert.ok(card !== undefined, `找不到卡片：${label}`);
	return textOf(card.props.children[1]);
}

/** 一份能让 `Panel` 渲染出汇总卡片的最小载荷。 */
function payloadWith(cost) {
	return {
		range: { label: "本月" },
		totals: {
			tokens: 12_345_678,
			requests: 42,
			inputTokens: 100,
			outputTokens: 200,
			cacheReadTokens: 300,
			cacheWriteTokens: 400,
			reasoningTokens: 500,
			cacheHitRate: 88,
		},
		cost,
		activity: [],
		activityDays: 7,
		timeZone: { name: "UTC+8", offset: 8 },
		providers: [],
		models: [],
		diagnostics: { files: 3, scanned: 2, cached: 1, failed: 0 },
	};
}

/**
 * 渲染面板并等数据落进缓存。
 *
 * 第一次调用触发预取（此时渲染的是加载态），等一轮宏任务后模块级缓存已填好，
 * 第二次调用就能拿到真实数据。
 *
 * @param t - 用例上下文。
 * @param payload - fetch 桩返回的载荷。
 * @returns 面板元素树。
 */
async function renderPanelWithData(t, payload) {
	const { exports } = await load(t, { fetch: okFetch(payload) });
	exports.Panel({ onClose: () => {} });
	await flush();
	return exports.Panel({ onClose: () => {} });
}

//#region fmtTokens

test("fmtTokens 按万/亿分档，万以下取整并加千分位", async () => {
	const { exports } = await loadClient();

	assert.equal(exports.fmtTokens(0), "0");
	assert.equal(exports.fmtTokens(999), "999");
	assert.equal(exports.fmtTokens(1234.7), "1,235", "小数四舍五入后加千分位");
	assert.equal(exports.fmtTokens(9999), "9,999", "9999 仍在千分位档，不提前进位到万");
	assert.equal(exports.fmtTokens(10_000), "1.0 万", "恰好 1 万进入万档");
	assert.equal(exports.fmtTokens(12_345_678), "1234.6 万");
	assert.equal(exports.fmtTokens(99_999_999), "10000.0 万", "亿档以下一律用万，不跳档");
	assert.equal(exports.fmtTokens(100_000_000), "1.00 亿", "恰好 1 亿进入亿档");
	assert.equal(exports.fmtTokens(150_000_000), "1.50 亿");
	assert.equal(exports.fmtTokens(-5), "-5", "负数按最低档取整");
});

test("fmtTokens 对非有限数值返回破折号，而不是 NaN", async () => {
	const { exports } = await loadClient();

	assert.equal(exports.fmtTokens(Number.NaN), "—");
	assert.equal(exports.fmtTokens(Number.POSITIVE_INFINITY), "—");
	assert.equal(exports.fmtTokens(Number.NEGATIVE_INFINITY), "—");
	assert.equal(exports.fmtTokens("123"), "—", "字符串不做隐式转换");
	assert.equal(exports.fmtTokens(null), "—");
	assert.equal(exports.fmtTokens(undefined), "—");
	assert.equal(exports.fmtTokens({}), "—");
});

//#endregion

//#region Heatmap

test("Heatmap 用 React 桩调用即可返回元素，不需要渲染", async (t) => {
	const { exports } = await load(t);

	assert.equal(typeof exports.Heatmap, "function");
	const node = exports.Heatmap({ activity: [], activityDays: 371, timeZone: { offset: 8 } });

	assert.equal(node.type, "div", "最外层是容器 div");
	assert.equal(node.props.children.length, 1);
	assert.equal(findAllByClass(node, "ul-heat").length, 1);
	assert.equal(findAllByClass(node, "ul-monthrow").length, 1);
	assert.equal(findAllByClass(node, "ul-legend").length, 1);
	assert.equal(findAllByClass(node, "ul-heatdays").length, 1);
});

test("Heatmap 固定 371 天、整周对齐，且每一格落在它该在的星期行", async (t) => {
	const { exports } = await load(t);

	const node = exports.Heatmap({ activity: [], activityDays: 371, timeZone: { offset: 0 } });
	const cells = heatCells(node);
	const visible = cells.filter((element) => element.props.style.visibility !== "hidden");

	assert.equal(cells.length % 7, 0, "总格数必须是 7 的倍数（整周）");
	assert.equal(visible.length, 371, "可见格恰好 371 天");
	assert.equal(cells.length - visible.length, cells.length - 371, "其余是补齐用的隐藏格");

	const grid = findAllByClass(node, "ul-heat")[0];
	const weeks = Number(/repeat\((\d+),/.exec(grid.props.style.gridTemplateColumns)[1]);
	assert.equal(weeks, cells.length / 7, "列数等于周数");

	// 网格是 column 流向 + 7 行，所以行号就是「周几」：第 0 行必须是周一。
	const dates = [];
	for (const element of visible) {
		const day = element.props.title.slice(0, 10);
		const date = new Date(`${day}T00:00:00`);
		dates.push(date);
		const index = cells.indexOf(element);
		assert.equal((date.getDay() + 6) % 7, index % 7, `${day} 落在了错误的星期行`);
	}
	// 连续无缺口，终点是本地今天。
	assert.equal(dayKey(dates.at(-1)), dayKey(new Date()), "最后一格是今天");
	for (let index = 1; index < dates.length; index += 1) {
		const gap = (dates[index] - dates[index - 1]) / 86_400_000;
		assert.equal(gap, 1, `${dayKey(dates[index])} 与前一天之间有缺口`);
	}
});

test("Heatmap 按当日峰值分五档，并把 token 数与请求数写进 title", async (t) => {
	const { exports } = await load(t);

	const today = dayKey(new Date());
	const node = exports.Heatmap({
		activity: [
			{ day: today, tokens: 100, requests: 3 },
			{ day: "2020-01-01", tokens: 50, requests: 1 },
		],
		activityDays: 7,
		timeZone: { offset: 8 },
	});
	const cells = heatCells(node);
	const peak = cells.find((element) => element.props.title.startsWith(today));

	assert.ok(peak !== undefined, "今天的格子必须存在");
	assert.match(peak.props.title, /100 tokens/, "title 里要有 token 数");
	assert.match(peak.props.title, /3 次请求/, "title 里要有请求数");
	// 100/100 = 1 > 0.66 → 最高档，色阶 alpha 为 1。
	assert.match(peak.props.style.background, /100%/, "峰值当天应落在最高档");

	// 图例色块没有 title，日期格有——用这一点把两者分开。
	const legend = findAllByClass(node, "ul-legend")[0];
	const swatches = findAll(legend, (element) => element.type === "i" && element.props.title === undefined);
	assert.equal(swatches.length, 5, "图例固定五档");
	assert.match(swatches[0].props.style.background, /var\(--dsw-alias-bg-layer-2/, "0 档用底色，不用 brand 混色");
	assert.match(swatches[4].props.style.background, /100%/, "4 档是最深的 brand 混色");
});

test("Heatmap 的档位边界：0.1 / 0.33 / 0.66 恰好落在阈值下方时降档", async (t) => {
	const { exports } = await load(t);

	// 峰值取 1000，各档比例就正好是 token/1000，边界一眼可查。
	// 等级 → 色阶：[0]=底色、1=28%、2=48%、3=70%、4=100%。
	const now = new Date();
	const cases = [
		{ daysAgo: 0, tokens: 1000, percent: "100%", why: "峰值当天是最高档" },
		{ daysAgo: 1, tokens: 670, percent: "100%", why: "0.67 > 0.66 仍是最高档" },
		{ daysAgo: 2, tokens: 660, percent: "70%", why: "0.66 不 > 0.66，降一档" },
		{ daysAgo: 3, tokens: 340, percent: "70%", why: "0.34 > 0.33" },
		{ daysAgo: 4, tokens: 330, percent: "48%", why: "0.33 不 > 0.33，降一档" },
		{ daysAgo: 5, tokens: 110, percent: "48%", why: "0.11 > 0.1" },
		{ daysAgo: 6, tokens: 100, percent: "28%", why: "0.1 不 > 0.1，降一档" },
		{ daysAgo: 7, tokens: 1, percent: "28%", why: "有量但极低仍是 1 档" },
	];
	const rows = cases.map(({ daysAgo, tokens }) => ({
		day: dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)),
		tokens,
		requests: 1,
	}));

	const node = exports.Heatmap({ activity: rows, activityDays: 8, timeZone: { offset: 0 } });
	const cells = heatCells(node);

	for (const [index, { tokens, percent, why }] of cases.entries()) {
		const cell = cells.find((element) => element.props.title.startsWith(rows[index].day));
		assert.ok(cell !== undefined, `找不到 ${rows[index].day}（${tokens} tokens）的格子`);
		assert.match(cell.props.style.background, new RegExp(percent), `${tokens} tokens：${why}，应为 ${percent}`);
	}

	// 窗口内完全没记录的日子落在 0 档：用宿主底色，不掺 brand。
	const sparse = exports.Heatmap({
		activity: [{ day: dayKey(now), tokens: 5, requests: 1 }],
		activityDays: 14,
		timeZone: { offset: 0 },
	});
	const quietDay = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10));
	const quiet = heatCells(sparse).find((element) => element.props.title.startsWith(quietDay));
	assert.ok(quiet !== undefined, `找不到无记录的 ${quietDay}`);
	assert.match(quiet.props.style.background, /var\(--dsw-alias-bg-layer-2/, "无记录的日子用底色");
});

test("Heatmap 的 activityDays 缺省或非法时回落到 371 天", async (t) => {
	const { exports } = await load(t);

	for (const activityDays of [undefined, Number.NaN, "371"]) {
		const node = exports.Heatmap({ activity: [], activityDays, timeZone: null });
		const visible = heatCells(node).filter((element) => element.props.style.visibility !== "hidden");
		assert.equal(visible.length, 371, `activityDays=${String(activityDays)} 应回落到 371 天`);
	}
});

//#endregion

//#region 模块契约

test("factory 显式返回 module.exports，并暴露 apply / inject / Badge / Panel", async () => {
	const { exports, registration } = await loadClient();

	assert.equal(registration.id, "dsh-usage-ledger");
	assert.deepEqual(exports.inject, ["slots"]);
	assert.equal(typeof exports.apply, "function");
	assert.equal(typeof exports.Badge, "function");
	assert.equal(typeof exports.Panel, "function");
	assert.equal(Object.prototype.toString.call(exports), "[object Module]", "带上 Symbol.toStringTag");
});

test("apply 把徽章注册进 sidebar.footer.action 插槽", async () => {
	const { exports } = await loadClient();
	const injected = [];
	const registered = [];
	const ctx = {
		slots: {
			inject(name, callback) {
				injected.push(name);
				callback();
			},
			register(options, component) {
				registered.push({ options, component });
				return options;
			},
		},
	};

	exports.apply(ctx);

	assert.deepEqual(injected, ["sidebar.footer.action"]);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].component, exports.Badge, "插槽里注册的是 Badge");
	assert.equal(registered[0].options.id, "usage-ledger");
	assert.equal(registered[0].options.order, 20);
});

//#endregion

//#region Badge / Panel 渲染

test("Badge 未取到数据时显示省略号，而不是 0", async (t) => {
	const { exports } = await load(t, { fetch: okFetch(payloadWith({ priced: false })) });

	const node = exports.Badge({});
	const text = textOf(node);

	assert.match(text, /用量账本/);
	assert.match(text, /…/, "数据未回来时用省略号占位");
	assert.equal(findAllByClass(node, "ul-badge").length, 1);
	assert.equal(findAllByClass(node, "ul-panel").length, 0, "未点击时面板不渲染");
});

test("Panel 无数据时先出加载态，标题、范围标签与关闭/刷新按钮齐备", async (t) => {
	const { exports } = await load(t, { fetch: okFetch(payloadWith({ priced: false })) });

	const node = exports.Panel({ onClose: () => {} });
	const text = textOf(node);

	assert.equal(findAllByClass(node, "ul-root").length, 1);
	assert.match(text, /用量账本/);
	assert.match(text, /正在读取本地会话日志/, "首屏是加载态");
	for (const label of ["今日", "近 7 天", "本月", "累计", "自定义"]) {
		assert.match(text, new RegExp(label), `缺少范围标签 ${label}`);
	}
	// 加载中也要能关掉、能刷新。
	assert.equal(findAll(node, (element) => element.type === "button" && element.props.title === "关闭").length, 1);
	assert.equal(findAll(node, (element) => element.type === "button" && element.props.title === "刷新").length, 1);
});

test("Panel 的「官方价折算」卡片按币种加符号、按金额定小数位（fmtMoney 未导出，只能这样触达）", async (t) => {
	const cny = await renderPanelWithData(t, payloadWith({ priced: true, total: 12.5, currency: "CNY", unpriced: [] }));
	assert.equal(cardValue(cny, "官方价折算"), "¥12.50");

	const small = await renderPanelWithData(t, payloadWith({ priced: true, total: 0.5, currency: "CNY", unpriced: [] }));
	assert.equal(cardValue(small, "官方价折算"), "¥0.5000", "小于 1 元的金额不能被抹成 ¥0.50");

	const usd = await renderPanelWithData(t, payloadWith({ priced: true, total: 3, currency: "USD", unpriced: [] }));
	assert.equal(cardValue(usd, "官方价折算"), "$3.00");

	const unknown = await renderPanelWithData(t, payloadWith({ priced: true, total: 7.25, currency: "EUR", unpriced: [] }));
	assert.equal(cardValue(unknown, "官方价折算"), "7.25", "未知币种不加符号，但仍给数值");
});

test("Panel 未定价时不把缺失的金额显示成 ¥0.00", async (t) => {
	const node = await renderPanelWithData(t, payloadWith({ priced: false, total: null, currency: "CNY", unpriced: [] }));

	assert.equal(cardValue(node, "官方价折算"), "—");
	// 面板同时要能看到真实总量，别让一个「—」遮住其余数字。
	assert.equal(cardValue(node, "消耗总量"), "1234.6 万");
	assert.equal(cardValue(node, "请求"), "42");
	assert.equal(cardValue(node, "缓存命中率"), "88%");
});

test("Panel 把读不出来的文件数说出来，并标注「官方价折算」的口径", async (t) => {
	const payload = payloadWith({ priced: true, total: 1, currency: "CNY", unpriced: [] });
	payload.diagnostics = { files: 10, scanned: 9, cached: 0, failed: 1 };
	const node = await renderPanelWithData(t, payload);
	const text = textOf(node);

	assert.match(text, /1 个会话文件无法读取/, "失败计数必须可见，不能静默");
	assert.match(text, /官方价折算/, "口径说明必须在");
	assert.match(text, /真实扣款无关/);
});

test("Panel 在 failed 为 0 时不出现失败警告", async (t) => {
	const node = await renderPanelWithData(t, payloadWith({ priced: true, total: 1, currency: "CNY", unpriced: [] }));

	assert.doesNotMatch(textOf(node), /无法读取/);
});

//#endregion

//#region 夹具自身

test("载入后恢复全局桩，不把 window / document / fetch 留在进程里", async (t) => {
	const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
	const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, "document");
	const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, "fetch");
	const originalFetch = globalThis.fetch;
	const sentinel = () => "sentinel";
	globalThis.fetch = sentinel;

	const harness = await loadClient();
	assert.equal(globalThis.window, undefined, "window 桩必须被删掉");
	assert.equal(globalThis.document, undefined, "document 桩必须被删掉");
	assert.equal(globalThis.fetch, sentinel, "没有传 fetch 时不能动原来的 fetch");

	harness.restore();
	assert.equal(globalThis.fetch, sentinel, "重复 restore 不应有副作用");

	t.after(() => {
		if (hadFetch) globalThis.fetch = originalFetch;
		else delete globalThis.fetch;
		if (!hadWindow) delete globalThis.window;
		if (!hadDocument) delete globalThis.document;
	});
});

test("keepStubs 时保留全局桩，restore 后清干净", async () => {
	const harness = await loadClient({ keepStubs: true });
	assert.equal(typeof globalThis.window.__ModuleLoader__.load, "function", "组件测试期间 window 桩必须还在");
	assert.equal(typeof globalThis.document.getElementById, "function");

	harness.restore();
	assert.equal(globalThis.window, undefined);
	assert.equal(globalThis.document, undefined);
});

test("require 桩只认 react：多 require 一个包会立刻报错，而不是拿到 undefined", async () => {
	// 用一段假 bundle 复现宿主契约：factory 的 require 不认相对路径，
	// 夹具必须把意外 require 变成显式错误，而不是让它悄悄变成 undefined。
	const fake = `window.__ModuleLoader__.load({ id: "fake", factory: (require) => {
		require("./view");
		return { apply() {} };
	} });`;
	await assert.rejects(loadClient({ source: fake }), /require 桩不认识 "\.\/view"/);
});

test("bundle 没注册、或 factory 没返回导出时，夹具显式报错", async () => {
	await assert.rejects(loadClient({ source: "/* 什么都不做 */" }), /没有调用 window\.__ModuleLoader__\.load/);
	await assert.rejects(
		loadClient({ source: `window.__ModuleLoader__.load({ id: "fake", factory: () => { const exports = {}; exports.apply = () => {}; } });` }),
		/factory 返回 undefined/,
		"这正是「整个 Web 界面起不来」的失败模式，必须被夹具挡住",
	);
});

//#endregion
