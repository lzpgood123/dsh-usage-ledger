/**
 * 未定价区块 `UnpricedSection` 的状态机测试（ADR-0008 §5 / 规格 D7）。
 *
 * ## 为什么必须用可重放的状态桩
 *
 * 这块 UI 的全部价值在**交互**上：点「认领」进搜索、选中进确认、确认才发请求。纯函数
 * 断言看不见这些迁移——它只能证明「源码里有某个字符串」。所以这里用 `statefulReact`
 * （见 `test/client.test.js` 的同名夹具）按 hook 顺序重放渲染，让每次点击真的改变下一次
 * 渲染的元素树。
 *
 * ## 一条贯穿全文件的判据
 *
 * **`fetch` 只在按下「确认写入」/「写入 overrides」时发一次，且 body 与服务端 schema
 * 逐字段相符**。UI 上的每一次点击都可能被误解成「已经写好了」，而真正落盘的只有这一个
 * 请求——它的 URL、方法、body 必须精确，否则用户以为认领成功、overrides 里却是别的
 * 东西（或者什么都没有）。
 *
 * @module usage-ledger/test/client-unpriced
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findAll, findAllByClass, loadClient, textOf } from "./client-harness.js";

/** 与 `test/client.test.js` 同一套夹具：每个用例只挂一个 after，按后进先出恢复。 */
const pending = new WeakMap();

/**
 * 载入 bundle 并把全局桩的收尾挂到用例上。
 *
 * @param t - 用例上下文。
 * @param options - 透传给 `loadClient`。
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

/**
 * 可重放的状态桩（与 `test/client.test.js` 的实现同源）。
 *
 * @returns `{stub, begin}`。
 */
function statefulReact() {
	const slots = [];
	let cursor = 0;
	return {
		stub: {
			createElement: (type, props, ...children) => ({
				$$typeof: Symbol.for("react.element"),
				type,
				props: { ...(props ?? {}), children },
			}),
			useState(initial) {
				const index = cursor;
				cursor += 1;
				if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
				const cell = slots[index];
				return [
					cell.value,
					(next) => {
						cell.value = typeof next === "function" ? next(cell.value) : next;
					},
				];
			},
			useRef(initial) {
				const index = cursor;
				cursor += 1;
				if (!(index in slots)) slots[index] = { value: { current: initial } };
				return slots[index].value;
			},
			useEffect(effect) {
				const cleanup = effect();
				if (typeof cleanup === "function") cleanup();
			},
			useCallback(callback) {
				return callback;
			},
		},
		begin() {
			cursor = 0;
		},
	};
}

/**
 * 记录调用的 fetch 桩。
 *
 * @param responder - 可选：`(url, options) => Promise<response>`。
 * @returns `{fetch, calls}`。
 */
function recordingFetch(responder = null) {
	const calls = [];
	return {
		calls,
		fetch: (url, options = {}) => {
			calls.push({ url: String(url), options, body: options.body === undefined ? null : JSON.parse(options.body) });
			if (responder !== null) return responder(url, options);
			return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, op: "setAlias", path: "/home/u/.dsh/usage-ledger-overrides.json", version: 1 }) });
		},
	};
}

/** 一份候选清单：覆盖搜索的四级顺序。 */
const CANDIDATES = [
	{ id: "deepseek", input: 1, output: 2, cacheRead: 0.1, cacheWrite: null, currency: "CNY", vendor: "DeepSeek", modelName: "DeepSeek", context: 1000, source: "file", aliasTarget: null },
	{ id: "deepseek-flash", input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0, currency: "CNY", vendor: "DeepSeek", modelName: "DeepSeek Flash", context: 1000, source: "file", aliasTarget: null },
	{ id: "relay-x/deepseek-flash", input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0, currency: "CNY", vendor: "DeepSeek", modelName: "DeepSeek Flash (relay)", context: 1000, source: "overrides", aliasTarget: "deepseek-flash" },
	// 这一条的 id 里**没有** `deepseek`，只有 modelName 有——用来验第四级「仅名称命中」。
	{ id: "v4-flash", input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0, currency: "CNY", vendor: "DeepSeek", modelName: "DeepSeek V4 Flash", context: 1000, source: "file", aliasTarget: null },
	{ id: "glm-5.3", input: 1, output: 3, cacheRead: null, cacheWrite: null, currency: "CNY", vendor: "Zhipu", modelName: "GLM 5.3", context: 200000, source: "file", aliasTarget: null },
	{ id: "claude-opus-5", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, currency: "USD", vendor: "anthropic", modelName: "Claude Opus 5", context: 1000000, source: "file", aliasTarget: null },
];

/** 一份未定价清单。 */
const ITEMS = [
	{
		id: "relay-x/relay-x/deepseek-flash",
		provider: "relay-x",
		model: "relay-x/deepseek-flash",
		tokens: 1_234_567,
		requests: 42,
		inputTokens: 100,
		outputTokens: 200,
		cacheReadTokens: 300,
		cacheWriteTokens: 400,
		reasoningTokens: 500,
		cacheHitRate: 75,
		cause: "no-price",
		suggestions: [{ model: "deepseek-flash", score: 0.9, reason: "去掉命名空间前缀后与 deepseek-flash 同名" }],
	},
	{
		id: "relay-y/brand-new",
		provider: "relay-y",
		model: "brand-new",
		tokens: 10,
		requests: 1,
		inputTokens: 10,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		cacheHitRate: 0,
		cause: "no-rate",
		suggestions: [],
	},
];

/**
 * 造一份区块 props。
 *
 * @param overrides - 覆盖默认 props 的字段。
 * @returns props。
 */
function propsOf(overrides = {}) {
	return {
		items: ITEMS,
		candidates: CANDIDATES,
		overrides: { path: "/home/u/.dsh/usage-ledger-overrides.json", exists: true, version: 1, enabled: true },
		currency: "CNY",
		onDone: () => {},
		...overrides,
	};
}

/**
 * 渲染区块并交出「重放一次」的函数。
 *
 * @param t - 用例上下文。
 * @param props - 区块 props。
 * @param options - `{fetch}`。
 * @returns `{render, calls}`。
 */
async function mountSection(t, props, options = {}) {
	const harness = statefulReact();
	const net = options.fetch ?? recordingFetch();
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });
	const render = () => {
		harness.begin();
		return exports.UnpricedSection({ ...props });
	};
	return { render, calls: net.calls, exports };
}

/** 找一个按钮（按可见文本）。 */
function buttonByText(node, label) {
	const found = findAll(node, (element) => element.type === "button" && textOf(element) === label);
	return found;
}

/** 取搜索框（`type="text"` 且带 `ul-uinput` 类名的第一个）。 */
function searchInput(node) {
	return findAll(node, (element) => element.type === "input" && element.props?.className === "ul-uinput")[0];
}

/** 候选列表里的行（`ul-usel` 按钮）。 */
function candidateRows(node) {
	return findAllByClass(node, "ul-usel");
}

/** 提交按钮（`ul-ubtn` 里带 `disabled` 属性语义的那些之一，按文本取）。 */
function submitButton(node, label) {
	return buttonByText(node, label)[0];
}

/** 等一轮宏任务：让 `submit()` 里的整条 promise 链跑完。 */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 走完「推荐 → 搜索 → 选中 → 确认」这条链路。
 *
 * 点行内推荐会把搜索词**预填**成推荐目标，但仍要走一次选中——确认框里展示的价格是从
 * 候选清单里现取的，推荐本身只有模型名与理由。
 *
 * @param render - 重放渲染的函数。
 * @param suggestionModel - 推荐目标（也是搜索词）。
 * @returns 确认态的元素树。
 */
function gotoConfirmViaSuggestion(render, suggestionModel) {
	render();
	buttonByText(render(), `认领为 ${suggestionModel}`)[0].props.onClick();
	const claim = render();
	assert.equal(searchInput(claim).props.value, suggestionModel, "点推荐后搜索词必须预填成推荐目标");
	const row = candidateRows(claim).find((element) => textOf(element).startsWith(`${suggestionModel}　`));
	assert.ok(row !== undefined, `候选清单里找不到 ${suggestionModel}`);
	row.props.onClick();
	return render();
}

test("未定价区块：items 为空时整块返回 null", async (t) => {
	const { render } = await mountSection(t, propsOf({ items: [] }));
	assert.equal(render(), null, "没有未定价模型时不该渲染一个空区块——那只会占位置");
});

test("未定价区块：按清单渲染，每行含 id、tokens、请求数，缺汇率的行标注", async (t) => {
	const { render } = await mountSection(t, propsOf());
	const node = render();
	const text = textOf(node);

	assert.match(text, /未定价/, "区块标题");
	assert.match(text, /2 个模型/, "标题里给出条数");
	for (const item of ITEMS) {
		assert.ok(text.includes(item.id), `清单里必须有 ${item.id}`);
	}
	assert.match(text, /123\.5 万/, "tokens 用 fmtTokens 的万档格式");
	assert.match(text, /42 次/, "请求数");
	assert.match(text, /缺汇率/, "cause 为 no-rate 的行必须标注「缺汇率」——认领成已有模型修不好它");
});

test("未定价区块：每行给出「认领为已有模型」与「自定义价格」两个入口，推荐直接给按钮", async (t) => {
	const { render } = await mountSection(t, propsOf());
	const node = render();

	assert.equal(buttonByText(node, "认领为已有模型").length, ITEMS.length, "每一行都要有「认领为已有模型」");
	assert.equal(buttonByText(node, "自定义价格").length, ITEMS.length, "每一行都要有「自定义价格」");

	// 带推荐的行直接给一个带理由的按钮（title 是 reason，鼠标悬停能看到依据）。
	const recommended = findAll(node, (element) => element.type === "button" && textOf(element) === "认领为 deepseek-flash");
	assert.equal(recommended.length, 1, "有推荐的行走快捷入口");
	assert.equal(recommended[0].props.title, "去掉命名空间前缀后与 deepseek-flash 同名", "快捷入口必须把 reason 带在 title 上——推荐不能只有一个模型名");
});

test("未定价区块：overridesFile 关闭写入时只读，不渲染任何动作按钮", async (t) => {
	const { render } = await mountSection(t, propsOf({ overrides: { path: "", exists: false, version: null, enabled: false } }));
	const node = render();
	const text = textOf(node);

	assert.match(text, /写入已在配置里关闭/, "必须说清为什么不能写");
	assert.equal(buttonByText(node, "认领为已有模型").length, 0, "关闭写入时不得渲染动作按钮");
	assert.equal(buttonByText(node, "自定义价格").length, 0);
	assert.equal(findAll(node, (element) => element.type === "button").length, 0, "整块不该有任何按钮");
	// 清单本身仍然要看得见——「只读」不等于「什么都不显示」。
	for (const item of ITEMS) assert.ok(text.includes(item.id), `只读模式下清单仍要显示 ${item.id}`);
});

test("未定价区块：点「认领为已有模型」进入搜索态，空查询时提示而不是铺出全部候选", async (t) => {
	const { render } = await mountSection(t, propsOf());
	const node = render();

	buttonByText(node, "认领为已有模型")[0].props.onClick();
	const claim = render();

	assert.notEqual(searchInput(claim), undefined, "进入 claim 态必须出现搜索框");
	assert.match(textOf(claim), /输入模型 id 或名称搜索/, "空查询要给提示，而不是把 147 行全铺出来");
	assert.equal(candidateRows(claim).length, 0, "空查询不渲染候选行");
	assert.equal(buttonByText(claim, "返回").length, 1, "claim 态必须有返回入口");
});

test("未定价区块：搜索按四级顺序过滤（相等 → 前缀 → 包含 → 仅名称命中）", async (t) => {
	const { render } = await mountSection(t, propsOf());
	render();
	buttonByText(render(), "认领为已有模型")[0].props.onClick();
	render();

	// 输入 "deepseek"：四个候选都命中，顺序必须是 ①id 完全相等 ②id 前缀 ③id 包含 ④仅名称命中。
	// 构造一个四级全命中的 fixture 才验得出顺序。
	searchInput(render()).props.onChange({ target: { value: "deepseek" } });
	const rows = candidateRows(render()).map((row) => textOf(row));

	assert.equal(rows.length, 4, "四个候选都该命中");
	assert.ok(rows[0].startsWith("deepseek　"), `① id 完全相等排第一，实得 ${rows[0]}`);
	assert.ok(rows[1].startsWith("deepseek-flash　"), `② id 前缀排第二，实得 ${rows[1]}`);
	assert.ok(rows[2].startsWith("relay-x/deepseek-flash　"), `③ id 包含排第三，实得 ${rows[2]}`);
	assert.ok(rows[3].startsWith("v4-flash　"), `④ 仅 modelName 命中排最后，实得 ${rows[3]}`);

	// 同级按 id 的 localeCompare 升序：这里 `deepseek-flash` 与 `relay-x/deepseek-flash`
	// 分属②③两级，换一个只靠③命中的词就能看出同级内部也是有序的。
	searchInput(render()).props.onChange({ target: { value: "flash" } });
	assert.deepEqual(
		candidateRows(render()).map((row) => textOf(row).split("　")[0]),
		["deepseek-flash", "relay-x/deepseek-flash", "v4-flash"],
		"同级内部按 id 升序",
	);

	// 大小写不敏感。
	searchInput(render()).props.onChange({ target: { value: "glm 5.3" } });
	assert.equal(candidateRows(render()).length, 1, "搜索必须大小写不敏感（「glm 5.3」只出现在 modelName 里）");

	// 查无结果时明确说「没有匹配」，不能静默给一个空框。
	searchInput(render()).props.onChange({ target: { value: "no-such-model-at-all" } });
	assert.match(textOf(render()), /没有匹配的模型/);
});

test("未定价区块：候选行显示 id、名称、厂商与四项价格，缺失显示破折号而不是 0", async (t) => {
	const { render } = await mountSection(t, propsOf());
	render();
	buttonByText(render(), "认领为已有模型")[0].props.onClick();
	render();
	searchInput(render()).props.onChange({ target: { value: "glm" } });
	const row = textOf(candidateRows(render())[0]);

	assert.match(row, /glm-5\.3/);
	assert.match(row, /GLM 5\.3/, "显示 modelName");
	assert.match(row, /Zhipu/, "显示 vendor");
	assert.match(row, /入 1/, "显示输入价");
	assert.match(row, /读 —/, "cacheRead 缺失必须显示破折号，不能显示 0——0 是「真的免费」");
	assert.match(row, /写 —/, "cacheWrite 缺失同理");
});

test("未定价区块：选中候选进入确认态，确认框展示价格、写入路径与一跳提示", async (t) => {
	const { render } = await mountSection(t, propsOf());
	const confirm = gotoConfirmViaSuggestion(render, "deepseek-flash");
	const text = textOf(confirm);

	assert.match(text, /确认写入/, "进入 confirm 态");
	assert.ok(text.includes("relay-x/relay-x/deepseek-flash"), "必须展示待认领的 item.id");
	assert.match(text, /认领为：deepseek-flash/, "必须展示选中的 candidate.id");
	assert.match(text, /每百万 token：输入 2 \/ 输出 8/, "必须展示该模型的价格（ADR §5「必须展示价格并要求确认」）");
	assert.match(text, /缓存读 0\.04 \/ 缓存写 0/, "四项价格都要在");
	assert.ok(text.includes("/home/u/.dsh/usage-ledger-overrides.json"), "必须展示写入路径（写入范围可见）");
	assert.match(text, /去掉命名空间前缀后与 deepseek-flash 同名/, "推荐的理由要原样展示给用户");
	assert.equal(buttonByText(confirm, "确认写入").length, 1);
	assert.equal(buttonByText(confirm, "取消").length, 1);

	// 一跳提示：选中一个**同时是别名键、且指向别处**的候选时必须出现。
	const viaSearch = await mountSection(t, propsOf());
	viaSearch.render();
	buttonByText(viaSearch.render(), "认领为已有模型")[0].props.onClick();
	viaSearch.render();
	searchInput(viaSearch.render()).props.onChange({ target: { value: "relay-x/deepseek" } });
	candidateRows(viaSearch.render())[0].props.onClick();
	const oneHop = textOf(viaSearch.render());
	assert.match(oneHop, /插件只做一跳解析/, "目标是别名键且指向别处时必须提示「不会跟随过去」");
	assert.match(oneHop, /不会跟随到 deepseek-flash/, "提示里要点名它不会跟随到哪个目标");
});

test("未定价区块：确认写入发出唯一一个 POST，URL / 方法 / body 精确相符", async (t) => {
	const net = recordingFetch();
	const { render, calls } = await mountSection(t, propsOf(), { fetch: net });
	buttonByText(gotoConfirmViaSuggestion(render, "deepseek-flash"), "确认写入")[0].props.onClick();
	await flush();

	assert.equal(calls.length, 1, "点一次「确认写入」只允许发一个请求");
	assert.equal(calls[0].url, "/api/usage-ledger/overrides", "URL 必须由 API 常量拼出");
	assert.equal(calls[0].options.method, "POST");
	assert.deepEqual(
		calls[0].body,
		{ op: "setAlias", alias: "relay-x/deepseek-flash", model: "deepseek-flash", reason: "去掉命名空间前缀后与 deepseek-flash 同名" },
		"body 必须与服务端 schema 逐字段相符（alias 是**日志里的** model，不是复合 id）",
	);
});

test("未定价区块：POST 成功时提示已写入（含响应里的 path）并调用 onDone 一次", async (t) => {
	const done = [];
	const net = recordingFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, op: "setAlias", path: "/written/path.json", version: 1 }) }));
	const { render } = await mountSection(t, propsOf({ onDone: () => done.push("done") }), { fetch: net });
	buttonByText(gotoConfirmViaSuggestion(render, "deepseek-flash"), "确认写入")[0].props.onClick();
	await flush();
	const after = render();

	assert.match(textOf(after), /已写入 overrides/, "成功后必须有可见反馈");
	assert.ok(textOf(after).includes("/written/path.json"), "反馈里必须带**响应里的** path（服务端说了写到哪）");
	assert.equal(done.length, 1, "成功后必须触发一次刷新（onDone），否则面板还显示旧数字");
});

test("未定价区块：POST 失败时留在确认态、表单不丢、不调 onDone，且把服务端错误码翻成中文", async (t) => {
	const done = [];
	const net = recordingFetch(() => Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, error: "bad-request", detail: "unknown-model" }) }));
	const { render } = await mountSection(t, propsOf({ onDone: () => done.push("done") }), { fetch: net });
	buttonByText(gotoConfirmViaSuggestion(render, "deepseek-flash"), "确认写入")[0].props.onClick();
	await flush();
	const after = render();

	assert.equal(buttonByText(after, "确认写入").length, 1, "失败后必须**留在**确认态——把用户丢回清单等于让他重选一遍");
	assert.match(textOf(after), /目标模型不在合并后的定价表里/, "必须把稳定错误码翻成中文");
	assert.match(textOf(after), /unknown-model/, "原始错误码要附在括号里，便于报障");
	assert.match(textOf(after), /每百万 token：输入 2/, "失败后确认框里的价格仍在——用户要能对着它重试");
	assert.equal(done.length, 0, "失败时绝不能触发刷新——那会让用户以为写成功了");
});

test("未定价区块：网络异常时给出可见失败文案，不抛到渲染里", async (t) => {
	const net = recordingFetch(() => Promise.reject(new Error("Failed to fetch")));
	const { render } = await mountSection(t, propsOf(), { fetch: net });
	buttonByText(gotoConfirmViaSuggestion(render, "deepseek-flash"), "确认写入")[0].props.onClick();
	await flush();

	assert.match(textOf(render()), /写入失败：Failed to fetch/, "沿用既有「刷新失败：…」的口径，不另造一套文案");
});

test("未定价区块：pending 期间所有提交类按钮 disabled（一次只允许一个 POST 在飞）", async (t) => {
	// 让 POST 永久悬停：断言的是**在飞期间**的元素树。
	const net = { calls: [], fetch: () => new Promise(() => {}) };
	const { render } = await mountSection(t, propsOf(), { fetch: net });
	buttonByText(gotoConfirmViaSuggestion(render, "deepseek-flash"), "确认写入")[0].props.onClick();
	const during = render();

	assert.equal(buttonByText(during, "确认写入")[0].props.disabled, true, "有请求在飞时提交按钮必须禁用");
	assert.equal(buttonByText(during, "取消")[0].props.disabled, true, "取消也要禁用——否则用户会在写入中途离开");
});

test("未定价区块：必填栏是纯空白时禁用提交、显示中文错误、且**不发任何请求**", async (t) => {
	// 这条守的是 `Number()` 与 `parseFloat()` 的分歧，代价是**静默错价**。
	//
	// `Number("   ") === 0`，而服务端 V10 的判据是 `Number.isFinite(p) && p >= 0`
	// ——**0 是合法价格**。所以只输入两个空格就会通过前端校验、发出 `input: 0`，
	// 该行随即从「—」变成 ¥0.00 并**离开未定价清单**。那正是 ADR-0001 明令禁止的
	// 「拿 0 冒充免费」，而前端是这条防线上的唯一一关（服务端收到 0 会照收）。
	//
	// `parseFloat("   ")` 是 NaN，所以规格 §8.5 冻结的是 parseFloat。
	const net = recordingFetch();
	const { render, calls } = await mountSection(t, propsOf(), { fetch: net });
	render();
	buttonByText(render(), "自定义价格")[0].props.onClick();
	render();

	const set = (id, value) => findAll(render(), (element) => element.type === "input" && element.props?.id === id)[0].props.onChange({ target: { value } });

	// 两个必填栏都只填空格。
	set("ul-f-input", "   ");
	set("ul-f-output", "   ");
	const blank = render();

	assert.equal(submitButton(blank, "写入 overrides").props.disabled, true, "纯空白必须被当成「没填」：按钮禁用");
	assert.match(textOf(blank), /价格必须是有限数且 ≥ 0/, "必须显示中文错误，而不是静默当成 0");
	assert.equal(calls.length, 0, "校验未通过时**不得**发出任何请求——发出去了就等于写了 input: 0（0 冒充免费）");

	// 反向对照 1：`0x10` 这类 `parseFloat` 会**前缀解析**成 0 的写法也必须被拒。
	// `parseFloat("0x10") === 0`（不是 16），只靠 isFinite 会把它静默当成**免费**。
	set("ul-f-input", "0x10");
	set("ul-f-output", "6");
	assert.equal(submitButton(render(), "写入 overrides").props.disabled, true, "`0x10` 必须被拒：parseFloat 会把它前缀解析成 0");
	assert.equal(calls.length, 0, "仍不得发请求");

	// 反向对照 2：`12abc` 同理（parseFloat 会得到 12）。
	set("ul-f-input", "12abc");
	assert.equal(submitButton(render(), "写入 overrides").props.disabled, true, "`12abc` 必须被拒：前缀解析会得到 12");
	assert.equal(calls.length, 0, "仍不得发请求");

	// 正向对照：合法的十进制写法必须能提交，且**值真的以数字发出**。
	// `1e3` 与 `1.50` 都是合法写法，不能被「整串等于数字本身」那类过严的判据误杀。
	for (const [input, output] of [["1.5", "6"], ["1e3", "2"], ["1.50", "0"]]) {
		set("ul-f-input", input);
		set("ul-f-output", output);
		const ok = render();
		assert.equal(submitButton(ok, "写入 overrides").props.disabled, false, `${input} / ${output} 是合法十进制写法，不该被拒`);
		submitButton(ok, "写入 overrides").props.onClick();
		await flush();
	}
	assert.equal(calls.length, 3, "三次合法提交各发一个请求");
	assert.deepEqual(calls[0].body, { op: "setModel", model: "relay-x/deepseek-flash", input: 1.5, output: 6, currency: "CNY" });
	assert.deepEqual(calls[1].body, { op: "setModel", model: "relay-x/deepseek-flash", input: 1000, output: 2, currency: "CNY" }, "`1e3` 必须解析成数字 1000");
	assert.deepEqual(calls[2].body, { op: "setModel", model: "relay-x/deepseek-flash", input: 1.5, output: 0, currency: "CNY" }, "`1.50` → 1.5，且 output 显式的 0 要照发（0 是「真的免费」）");
});

test("未定价区块：认领掉最后一个模型后，反馈与写入路径仍然可见", async (t) => {
	// `items` 变成 `[]` 之后组件不该把反馈一起带走。
	//
	// 认领**最后一个**未定价模型是最常见的路径，而那一刻正是「已写入」最该被看见的
	// 时候。若 `items.length === 0` 就直接 `return null`，用户点了确认、面板什么都没说、
	// 清单也空了——看起来像操作没生效，很可能再点一次。
	const net = recordingFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, op: "setAlias", path: "/home/u/.dsh/usage-ledger-overrides.json", version: 1 }) }));
	const harness = statefulReact();
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });
	let items = ITEMS;
	const render = () => {
		harness.begin();
		return exports.UnpricedSection({ ...propsOf({ items }) });
	};

	buttonByText(gotoConfirmViaSuggestion(render, "deepseek-flash"), "确认写入")[0].props.onClick();
	await flush();
	assert.match(textOf(render()), /已写入 overrides/, "前置条件：写入成功且反馈可见");

	// 模拟刷新：**所有**未定价行都被定价了，清单变成空数组。
	items = [];
	const after = render();

	assert.notEqual(after, null, "items 为空但还有反馈时，区块**不能**整个返回 null——反馈会随组件一起消失");
	assert.match(textOf(after), /已写入 overrides/, "「已写入」必须仍然可见（用户刚做完操作，这是他唯一的结果确认）");
	assert.ok(textOf(after).includes("/home/u/.dsh/usage-ledger-overrides.json"), "写入路径也必须仍然可见（写入范围可见是 ADR-0008 的要求）");
	assert.equal(buttonByText(after, "确认写入").length, 0, "确认框不该还在（那一行已经不存在了）");

	// 反向对照：没有反馈时，空清单仍然整块不渲染——不能为了保反馈而永远画一个空壳。
	const clean = statefulReact();
	const cleanLoad = await load(t, { fetch: recordingFetch().fetch, react: clean.stub });
	clean.begin();
	assert.equal(cleanLoad.exports.UnpricedSection({ ...propsOf({ items: [] }) }), null, "没有反馈时空清单不该渲染任何东西");
});

test("未定价区块：自定义价格表单——model 只读、必填校验、cacheRead 留空则不发该键", async (t) => {
	const net = recordingFetch();
	const { render, calls } = await mountSection(t, propsOf(), { fetch: net });
	render();
	buttonByText(render(), "自定义价格")[0].props.onClick();
	const form = render();
	const text = textOf(form);

	assert.match(text, /自定义价格/);
	// model 字段是只读的：模型名不可编辑，否则「给另一个模型定价」会静默发生。
	const modelField = findAll(form, (element) => element.type === "input" && element.props?.id === "ul-f-model")[0];
	assert.ok(modelField !== undefined, "找不到只读的模型名输入框");
	assert.equal(modelField.props.readOnly, true, "model 字段必须只读");
	assert.equal(modelField.props.value, "relay-x/deepseek-flash", "只读字段的值必须是 item.model");

	// 空必填 → 提交禁用。
	assert.equal(submitButton(form, "写入 overrides").props.disabled, true, "必填为空时提交必须禁用");

	// 非法价格 → 禁用 + 中文错误。
	const inputField = findAll(form, (element) => element.type === "input" && element.props?.id === "ul-f-input")[0];
	inputField.props.onChange({ target: { value: "-1" } });
	const negative = render();
	assert.equal(submitButton(negative, "写入 overrides").props.disabled, true, "-1 不是合法价格");
	assert.match(textOf(negative), /价格必须是有限数且 ≥ 0/, "非法字段旁必须有中文错误，且不能用原生 alert");

	findAll(negative, (element) => element.type === "input" && element.props?.id === "ul-f-input")[0].props.onChange({ target: { value: "abc" } });
	assert.equal(submitButton(render(), "写入 overrides").props.disabled, true, "abc 不是合法价格");

	// 填合法值：cacheRead 留空 → body 里不含这个键。
	findAll(render(), (element) => element.type === "input" && element.props?.id === "ul-f-input")[0].props.onChange({ target: { value: "1.5" } });
	findAll(render(), (element) => element.type === "input" && element.props?.id === "ul-f-output")[0].props.onChange({ target: { value: "6" } });
	const valid = render();
	assert.equal(submitButton(valid, "写入 overrides").props.disabled, false, "两个必填合法后应当可以提交");

	submitButton(valid, "写入 overrides").props.onClick();
	await flush();

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].body, { op: "setModel", model: "relay-x/deepseek-flash", input: 1.5, output: 6, currency: "CNY" }, "cacheRead 留空时不发这个键（不伪造 0），且价格必须是**数字**");
});

test("未定价区块：自定义价格表单——cacheRead 填了就发出去，note 超长则禁用", async (t) => {
	const net = recordingFetch();
	const { render, calls } = await mountSection(t, propsOf(), { fetch: net });
	render();
	buttonByText(render(), "自定义价格")[0].props.onClick();
	render();

	const set = (id, value) => findAll(render(), (element) => element.type === "input" && element.props?.id === id)[0].props.onChange({ target: { value } });
	set("ul-f-input", "1");
	set("ul-f-output", "2");
	set("ul-f-cacheRead", "0.1");
	set("ul-f-cacheWrite", "0");
	set("ul-f-note", "面板手工录入");

	submitButton(render(), "写入 overrides").props.onClick();
	await flush();

	assert.deepEqual(calls[0].body, { op: "setModel", model: "relay-x/deepseek-flash", input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, currency: "CNY", note: "面板手工录入" }, "显式给出的 0 必须发出去（0 是「真的免费」）");

	// note 超长 → 禁用 + 中文错误。
	set("ul-f-note", "x".repeat(201));
	const tooLong = render();
	assert.equal(submitButton(tooLong, "写入 overrides").props.disabled, true, "超长备注必须禁用提交");
	assert.match(textOf(tooLong), /备注最长 200 个字符/);
});

test("未定价区块：Escape 回到清单并 stopPropagation，不冒泡到面板的 Esc", async (t) => {
	const { render } = await mountSection(t, propsOf());

	for (const [open, label] of [
		[() => buttonByText(render(), "认领为已有模型")[0].props.onClick(), "claim"],
		[() => buttonByText(render(), "自定义价格")[0].props.onClick(), "custom"],
	]) {
		render();
		open();
		const opened = render();
		const container = findAll(opened, (element) => typeof element.props?.onKeyDown === "function")[0];
		assert.ok(container !== undefined, `${label} 态必须监听键盘事件，否则 Esc 分支是死代码`);

		let stopped = false;
		container.props.onKeyDown({ key: "Escape", stopPropagation: () => { stopped = true; } });
		assert.equal(stopped, true, `${label} 态的 Escape 必须 stopPropagation：不这样做的话，一次 Esc 会同时关掉区块与整个面板`);
		assert.match(textOf(render()), /未定价/, `${label} 态按 Escape 后必须回到清单`);
	}

	// 普通按键不得触发返回。
	buttonByText(render(), "认领为已有模型")[0].props.onClick();
	const claim = render();
	findAll(claim, (element) => typeof element.props?.onKeyDown === "function")[0].props.onKeyDown({ key: "a", stopPropagation() {} });
	assert.notEqual(searchInput(render()), undefined, "非 Escape 的按键不该离开 claim 态");
});

test("未定价区块：刷新后 item 消失则回到清单，feedback 保留", async (t) => {
	const net = recordingFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, op: "setAlias", path: "/p.json", version: 1 }) }));
	const harness = statefulReact();
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });
	let items = ITEMS;
	const render = () => {
		harness.begin();
		return exports.UnpricedSection({ ...propsOf({ items }) });
	};

	buttonByText(gotoConfirmViaSuggestion(render, "deepseek-flash"), "确认写入")[0].props.onClick();
	await flush();
	assert.match(textOf(render()), /已写入 overrides/, "前置条件：写入成功且 feedback 可见");

	// 模拟刷新：那一行已经被定价，从清单里消失了。
	items = ITEMS.filter((item) => item.id !== "relay-x/relay-x/deepseek-flash");
	const after = render();

	assert.equal(buttonByText(after, "确认写入").length, 0, "指向已不存在行的确认框必须消失");
	assert.match(textOf(after), /已写入 overrides/, "feedback 必须保留——「已写入」这句话在刷新后仍要看得见");
	assert.match(textOf(after), /relay-y\/brand-new/, "剩下的行照常渲染");
});
