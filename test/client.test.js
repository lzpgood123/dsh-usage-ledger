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

/**
 * 可重放的状态桩：`useState` / `useRef` 按 **hook 顺序**落进同一个槽位数组。
 *
 * 默认的 React 桩把 `setState` 写成空函数，于是「点一下表头，方向有没有翻」
 * 这类**行为**根本测不到——`src/client.js` 里排序状态就活在 `useState` 里，
 * 而本轮验证者正是靠这一点让「点同一列永远回到 desc」的变异体活了下来。
 *
 * 每次渲染前调用 {@link statefulReact.begin} 把游标归零；hook 顺序在多次渲染间
 * 稳定，所以同一个下标永远对应同一个状态槽。`useEffect` 与默认桩一致：
 * 立刻执行、立刻清理（`useUsage` 的预取挂在副作用里，不执行就拿不到数据）。
 *
 * `deferCleanup` 为 true 时把清理函数推迟到**下一次 `begin()`**（以及
 * {@link statefulReact.dispose}）执行，而不是立刻执行。徽章这类组件用
 * `mounted` ref 挡住「卸载后 setState」，而默认桩的「立刻清理」会在请求回来之前
 * 就把 `mounted` 置 false，于是那条路径永远测不到。
 *
 * @param options - `{deferCleanup}`，默认 `false`（与既有用例的行为一致）。
 * @returns `{stub, begin, dispose, slots}`；`stub` 传给 {@link loadClient} 的 `react` 选项。
 */
function statefulReact({ deferCleanup = false } = {}) {
	const slots = [];
	let cursor = 0;
	const pendingCleanups = [];
	/** 依次执行尚未执行的清理函数。 */
	const runCleanups = () => {
		while (pendingCleanups.length > 0) pendingCleanups.shift()();
	};
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
				if (typeof cleanup !== "function") return;
				if (deferCleanup) pendingCleanups.push(cleanup);
				else cleanup();
			},
			useCallback(callback) {
				return callback;
			},
		},
		/** 下一次渲染前调用：把 hook 游标归零，并结算上一次渲染欠下的清理。 */
		begin() {
			cursor = 0;
			runCleanups();
		},
		/** 用例收尾：结算仍未执行的清理（例如卸载徽章）。 */
		dispose() {
			runCleanups();
		},
		slots,
	};
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

/**
 * 渲染一个**带真实状态**的可交互组件。
 *
 * 与 {@link renderPanelWithData} 的区别：这里的状态桩记得 `setState`（见
 * {@link statefulReact}），所以「点一下表头」能真的改变下一次渲染的结果。
 * 纯函数断言看不到这条路径——而排序方向切换、遮罩点击关闭都活在这条路径上。
 *
 * @param t - 用例上下文。
 * @param payload - fetch 桩返回的载荷。
 * @param name - `exports` 上的组件名（`"Panel"` / `"Badge"`）。
 * @param props - 组件 props。
 * @returns `{render}`；每次调用重放一次渲染并返回元素树。
 */
async function renderInteractive(t, payload, name, props) {
	const harness = statefulReact();
	const { exports } = await load(t, { fetch: okFetch(payload), react: harness.stub });
	const render = () => {
		harness.begin();
		return exports[name]({ ...props });
	};
	render();
	await flush();
	return { render };
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

test("Heatmap 按活跃日分位数分档，并把 token 数与请求数写进 title", async (t) => {
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
	// 分档早已不是「占峰值多少比例」，而是活跃日的分位数。今天是最忙的活跃日，
	// 按尺度保证恒为最高档。颜色不再内联，由 `data-l` 交给 CSS 按主题给。
	assert.equal(peak.props["data-l"], "4", "最忙的活跃日应落在最高档");

	// 小样本保证：整个窗口只有一天有记录时，那一天必须仍是最忙的一天 → L4。
	// 分位点会等于它自身，若没有「最忙的一天恒为 L4」这条短路，它会被压成最浅档——
	// 这是分位分档最容易回归的一处。
	const single = exports.Heatmap({
		activity: [{ day: today, tokens: 7, requests: 1 }],
		activityDays: 7,
		timeZone: { offset: 0 },
	});
	const only = heatCells(single).find((element) => element.props.title.startsWith(today));
	assert.ok(only !== undefined, "唯一活跃日的格子必须存在");
	assert.equal(only.props["data-l"], "4", "唯一活跃日是最忙的一天，必须是 L4 而不是 L1");

	// 图例色块没有 title，日期格有——用这一点把两者分开。
	const legend = findAllByClass(node, "ul-legend")[0];
	const swatches = findAll(legend, (element) => element.type === "i" && element.props.title === undefined);
	assert.equal(swatches.length, 5, "图例固定五档");
	assert.equal(swatches[0].props["data-l"], "0", "0 档用底色，不用 brand 混色");
	assert.equal(swatches[4].props["data-l"], "4", "4 档是最深档");
	// 图例与真实格子必须走同一套 data-l，否则两者颜色会漂移。
	assert.deepEqual(swatches.map((element) => element.props["data-l"]), ["0", "1", "2", "3", "4"]);
});

test("Heatmap 的档位边界：0.1 / 0.33 / 0.66 恰好落在阈值下方时降档", async (t) => {
	const { exports } = await load(t);

	// 峰值取 1000，各档比例就正好是 token/1000，边界一眼可查。
	// 等级 → 档位：0 无记录、1 最低、2、3、4 最高；颜色由 CSS 的 `data-l` 决定。
	const now = new Date();
	const cases = [
		{ daysAgo: 0, tokens: 1000, level: "4", why: "峰值当天是最高档" },
		{ daysAgo: 1, tokens: 670, level: "4", why: "0.67 > 0.66 仍是最高档" },
		{ daysAgo: 2, tokens: 660, level: "3", why: "0.66 不 > 0.66，降一档" },
		{ daysAgo: 3, tokens: 340, level: "3", why: "0.34 > 0.33" },
		{ daysAgo: 4, tokens: 330, level: "2", why: "0.33 不 > 0.33，降一档" },
		{ daysAgo: 5, tokens: 110, level: "2", why: "0.11 > 0.1" },
		{ daysAgo: 6, tokens: 100, level: "1", why: "0.1 不 > 0.1，降一档" },
		{ daysAgo: 7, tokens: 1, level: "1", why: "有量但极低仍是 1 档" },
	];
	const rows = cases.map(({ daysAgo, tokens }) => ({
		day: dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)),
		tokens,
		requests: 1,
	}));

	const node = exports.Heatmap({ activity: rows, activityDays: 8, timeZone: { offset: 0 } });
	const cells = heatCells(node);

	for (const [index, { tokens, level, why }] of cases.entries()) {
		const cell = cells.find((element) => element.props.title.startsWith(rows[index].day));
		assert.ok(cell !== undefined, `找不到 ${rows[index].day}（${tokens} tokens）的格子`);
		assert.equal(cell.props["data-l"], level, `${tokens} tokens：${why}，应为 ${level} 档`);
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
	assert.equal(quiet.props["data-l"], "0", "无记录的日子用底色档");
});

test("Heatmap 按活跃日分位数分档：单日峰值不得把其余活跃日压平（线性分档的回归护栏）", async (t) => {
	const { exports } = await load(t);

	// 这条用例专门区分**分位数分档**与旧的**线性分档**（当日 token / 全窗口峰值）。
	// 旧线性方案把阈值定在峰值的 0.66 / 0.33 / 0.1：只要有一天特别忙，其余所有
	// 活跃日都会掉进 L1，整张热力图看起来像只有一天在干活——这正是本轮要修的
	// 「单日峰值压平」。所以输入必须「一个极高值 + 一组互相接近的中低值」。
	//
	// 八天边界用例 [1000,670,660,340,330,110,100,1] 在**两种方案下输出完全相同**
	// （都是 4,4,3,3,2,2,1,1），拿它当护栏等于没护栏：整条分位数实现可以被换回
	// 线性而测试全绿。下面的构造在两种方案下差异极大，才是真正承重的断言。
	const now = new Date();
	const activity = [10_000, 100, 90, 80, 70, 60, 50, 40].map((tokens, index) => ({
		day: dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - index)),
		tokens,
		requests: 1,
	}));

	const node = exports.Heatmap({ activity, activityDays: 8, timeZone: { offset: 0 } });
	const levelOf = (index) => {
		const cell = heatCells(node).find((element) => element.props.title.startsWith(activity[index].day));
		assert.ok(cell !== undefined, `找不到第 ${index} 天（${activity[index].tokens} tokens）的格子`);
		return Number(cell.props["data-l"]);
	};
	const levels = activity.map((_, index) => levelOf(index));

	// 峰值那天是 L4——两种方案都成立，所以它不是区分点，只用来确认数据接对了。
	assert.equal(levels[0], 4, "峰值当天必须是最忙的一天 → L4");

	// 区分点一：旧线性下这 7 个中低值全是 L1（ratio 最大才 0.01），分位数下它们
	// 铺满 L1..L4。断言「至少有一半非峰值活跃日落在 L2 以上」。
	const elevated = levels.slice(1).filter((level) => level >= 2).length;
	assert.ok(
		elevated >= 4,
		`8 个活跃日里有 1 个峰值 + 7 个中低值，但只有 ${elevated} 个非峰值日落在 L2 以上（levels=${levels.join(",")}）。` +
			"这正是「单日峰值压平整年」的形态：阈值按全窗口峰值取比例时，峰值是次高值的 100 倍，其余日子全被压进 L1，" +
			"热力图看起来像只有一天在干活。分位数只看排序后的位置，峰值再高也只占最高那一档。",
	);

	// 区分点二：分位数方案下相邻活跃日（100/90/80/70/60/50/40）应当落在不同档，
	// 而不是七格同色。旧线性下这七格全部相等（L1），色阶等于消失。
	assert.ok(
		new Set(levels.slice(1)).size >= 3,
		`非峰值活跃日只用到 ${new Set(levels.slice(1)).size} 个档位（levels=${levels.join(",")}）：` +
			"线性分档会把它们全部压成同一档，热力图无法表达「哪天比哪天更忙」。",
	);

	// 区分点三：直接钉住「线性方案下的输出」不能出现。这是最直白的一条——
	// 若 makeLevelScale 被换回 ratio>0.66/0.33/0.1，levels 会精确等于 [4,1,1,1,1,1,1,1]。
	assert.notDeepEqual(
		levels,
		[4, 1, 1, 1, 1, 1, 1, 1],
		"分档结果与旧的线性方案（token/全窗口峰值 的 0.66/0.33/0.1 阈值）逐日相同：分位数分档已被还原，" +
			"「单日峰值压平」的缺陷会原样回来，而这条测试是唯一能发现它的地方。",
	);

	// 区分点四：换一个**形状完全不同**的输入再验一次，避免整条护栏只靠一个构造
	// （上面那条 notDeepEqual 一旦被删，就只剩「构造相关」的两条）。
	//
	// 均匀递增的 8 天里，分位数按位置切：L1..L4 各占两格，四档全部出现；
	// 线性按比例切：峰值档吃掉 3 格、最低档 0 格（levels=2,2,3,3,3,4,4,4）。
	// 断言「四档都出现、且最低档至少两格」——这是**分位数按位置切**的直接后果，
	// 线性方案在任何「有峰值」的输入上都做不到。
	const ramp = [1, 2, 3, 4, 5, 6, 7, 8].map((tokens, index) => ({
		day: dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - index)),
		tokens,
		requests: 1,
	}));
	const rampNode = exports.Heatmap({ activity: ramp, activityDays: 8, timeZone: { offset: 0 } });
	const rampLevels = ramp.map((row) => {
		const cell = heatCells(rampNode).find((element) => element.props.title.startsWith(row.day));
		assert.ok(cell !== undefined, `均匀递增用例里找不到 ${row.day} 的格子`);
		return Number(cell.props["data-l"]);
	});
	const counts = new Map();
	for (const level of rampLevels) counts.set(level, (counts.get(level) ?? 0) + 1);
	assert.equal(
		counts.size,
		4,
		`均匀递增的 8 个活跃日只落到 ${counts.size} 个档位（levels=${rampLevels.join(",")}）：` +
			"分位数按排序位置均分，四档应当全部出现；只出现少数几档说明阈值又变成「占峰值的比例」了。",
	);
	assert.ok(
		(counts.get(1) ?? 0) >= 2,
		`均匀递增用例里最低档只有 ${counts.get(1) ?? 0} 格（levels=${rampLevels.join(",")}）：` +
			"线性分档下最低档会被峰值挤掉（最低值也超过峰值的 10%），整张热力图因此缺少「用量最少」这一档。",
	);

	// 尺度保证：最忙的一天恒为 L4（n=1 的小样本也不能被压成最浅档）。
	// 这条是分位数实现里 `tokens >= max` 短路的护栏。
	const single = exports.Heatmap({
		activity: [{ day: dayKey(now), tokens: 40, requests: 1 }],
		activityDays: 7,
		timeZone: { offset: 0 },
	});
	const only = heatCells(single).find((element) => element.props.title.startsWith(dayKey(now)));
	assert.equal(only.props["data-l"], "4", "唯一活跃日是最忙的一天，必须是 L4");
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

test("factory 显式返回 module.exports，并暴露 apply / inject / Badge / Panel / UnpricedSection", async () => {
	const { exports, registration } = await loadClient();

	assert.equal(registration.id, "dsh-usage-ledger");
	assert.deepEqual(exports.inject, ["slots"]);
	assert.equal(typeof exports.apply, "function");
	assert.equal(typeof exports.Badge, "function");
	assert.equal(typeof exports.Panel, "function");
	assert.equal(typeof exports.UnpricedSection, "function", "未定价区块必须导出，否则它的状态机只能用真实浏览器测");
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

//#region 表格排序与遮罩（行为断言：状态真的会变，不是源码里有字符串）

/** 带明细行的载荷：两张表各两行，用来驱动表头点击。 */
function payloadWithRows() {
	const payload = payloadWith({ priced: true, total: 1, currency: "CNY", unpriced: [] });
	payload.providers = [
		{ provider: "alpha", tokens: 300, requests: 3, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 50, cost: 1 },
		{ provider: "beta", tokens: 100, requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 25, cost: 2 },
	];
	payload.models = [
		{ model: "m-one", tokens: 200, requests: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 10, cost: 1 },
		{ model: "m-two", tokens: 400, requests: 4, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 20, cost: 2 },
	];
	return payload;
}

/** 按表头文字找 `th`（文字里可能带排序箭头，所以用前缀匹配）。 */
function headerFor(table, label) {
	const found = findAll(table, (element) => element.type === "th" && textOf(element).startsWith(label));
	assert.equal(found.length, 1, `表里找不到（或找到多个）表头「${label}」`);
	return found[0];
}

/**
 * 一份「一个 null 价 + 若干有价」的载荷，用来钉住未定价行的排序位置。
 *
 * 刻意包含 `cost: 0`：它是**有效的**数值 0，与 `cost: null`（缺失）是两回事。
 * 若实现把 null 当成 0（`?? 0`），这两行会互相纠缠——这正是要区分的第二个变异体。
 * 数值本身错开（5 / 1 / 0），这样升序与降序的行序完全不同，方向反了也会被抓到。
 *
 * @returns 载荷。
 */
function payloadWithMixedCosts() {
	const payload = payloadWith({ priced: true, total: 6, currency: "CNY", unpriced: [] });
	payload.providers = [
		{ provider: "p-mid", tokens: 500, requests: 1, cost: 5 },
		{ provider: "p-none", tokens: 400, requests: 1, cost: null },
		{ provider: "p-low", tokens: 300, requests: 1, cost: 1 },
		{ provider: "p-zero", tokens: 200, requests: 1, cost: 0 },
	];
	payload.models = [
		{ model: "m-mid", tokens: 500, requests: 1, cost: 5 },
		{ model: "m-none", tokens: 400, requests: 1, cost: null },
		{ model: "m-low", tokens: 300, requests: 1, cost: 1 },
		{ model: "m-zero", tokens: 200, requests: 1, cost: 0 },
	];
	return payload;
}

/**
 * 取一张表**按渲染顺序**的行名（`tbody > tr` 的第一个单元格）。
 *
 * 排序缺陷只体现在行序上：断言 `aria-sort` 只能证明「表头说自己是什么方向」，
 * 证明不了行真的按这个方向排了、也没法发现某一类行被塞到了不该在的位置。
 *
 * @param table - `table` 元素。
 * @returns 行名数组。
 */
function renderedRowNames(table) {
	const tbody = findAll(table, (element) => element.type === "tbody")[0];
	assert.ok(tbody !== undefined, "表里找不到 tbody");
	return findAll(tbody, (element) => element.type === "tr").map((row) => textOf(findAllByClass(row, "ul-name")[0]));
}

/** 找某张表里某个可排序表头的按钮。 */
function sortButtonFor(table, label) {
	const found = findAll(headerFor(table, label), (element) => element.props?.className === "ul-sort");
	assert.equal(found.length, 1, `表头「${label}」里找不到排序按钮`);
	return found[0];
}

test("名称列不装成可排序：不是按钮、没有 aria-sort、没有箭头（D7）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithRows(), "Panel", { onClose: () => {} });
	const node = render();
	const tables = findAllByClass(node, "ul-table");
	assert.equal(tables.length, 2, "分渠道与分模型各一张表");

	for (const table of tables) {
		const name = headerFor(table, "名称");
		// 名称列既不是数值也不该装成能排：一个点了不改变行序的表头就是在说谎。
		// 这里断言**渲染出来的语义**，而不是源码里有没有 `sortable: false` 这几个字。
		assert.equal(
			findAll(name, (element) => element.type === "button").length,
			0,
			"名称列表头渲染成了按钮：它会被 Tab 到、被点击，但点了不会改变行序——这是对键盘用户说谎。",
		);
		assert.equal(name.props["aria-sort"], undefined, "名称列不该有 aria-sort：读屏会以为这一列可以排序。");
		assert.equal(findAllByClass(name, "ul-arrow").length, 0, "名称列不该有排序箭头：箭头承诺了一个不存在的排序。");

		// 反向核对：同表里的数值列**必须**是按钮且带 aria-sort，否则上面三条可能
		// 只是因为整张表退化成了纯文本而碰巧成立。
		const tokens = headerFor(table, "tokens");
		assert.equal(findAllByClass(tokens, "ul-sort").length, 1, "数值列表头必须是可点的排序按钮");
		assert.ok(
			["ascending", "descending", "none"].includes(tokens.props["aria-sort"]),
			`数值列表头的 aria-sort 是 \`${tokens.props["aria-sort"]}\`，不是三态之一`,
		);
	}
});

test("明细表有「缓存写」列且紧跟「缓存读」，单元格取自行数据（#3）", async (t) => {
	const payload = payloadWithRows();
	// 行内数值刻意与合计（400）错开，且每行不同：这样「列读了 row.cacheWriteTokens
	// 还是误读了 totals.cacheWriteTokens」以及「列错位读了相邻行」都会被抓到。
	payload.providers[0].cacheWriteTokens = 4321;
	payload.providers[1].cacheWriteTokens = 765;
	payload.models[0].cacheWriteTokens = 4321;
	payload.models[1].cacheWriteTokens = 765;
	/** 行名 → 该行「缓存写」应显示的文本。行序按 tokens 降序，与这里无关。 */
	const expectedByRow = new Map([
		["alpha", "4,321"],
		["beta", "765"],
		["m-one", "4,321"],
		["m-two", "765"],
	]);
	const { render } = await renderInteractive(t, payload, "Panel", { onClose: () => {} });
	const node = render();

	const tables = findAllByClass(node, "ul-table");
	assert.equal(tables.length, 2, "分渠道与分模型各一张表");

	for (const table of tables) {
		const headers = findAll(table, (element) => element.type === "th").map((element) => textOf(element));
		const read = headers.indexOf("缓存读");
		assert.ok(read >= 0, `表头里没有「缓存读」：${headers.join(" / ")}`);
		// 位置而不是「有没有」：插到表尾虽然也在，但和汇总卡片的顺序就对不上了。
		assert.equal(headers[read + 1], "缓存写", `「缓存写」必须紧跟「缓存读」，实际表头顺序：${headers.join(" / ")}`);

		// 表头只是承诺。列头在、单元格却没渲染（或渲染错列）同样是坏的，所以逐行钉住
		// 该列文本：单元格与表头一一对应，下标可直接复用。
		const rows = findAll(table, (element) => element.type === "tr").slice(1);
		assert.equal(rows.length, 2, "每张表两行明细");
		for (const row of rows) {
			const cells = findAll(row, (element) => element.type === "td").map((element) => textOf(element));
			const name = cells[0];
			assert.equal(cells[read + 1], expectedByRow.get(name), `行「${name}」的缓存写单元格应取自行数据，实际整行：${cells.join(" / ")}`);
		}
	}
});

test("点同一列表头切换升降序，换一列则从降序重新开始（排序状态真的会变）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithRows(), "Panel", { onClose: () => {} });

	const table = () => findAllByClass(render(), "ul-table")[0];
	// 初值：tokens 降序（「谁最多」是打开表格时最想问的问题）。
	assert.equal(headerFor(table(), "tokens").props["aria-sort"], "descending", "初始应按 tokens 降序");
	assert.equal(headerFor(table(), "请求").props["aria-sort"], "none", "未激活的列必须是 none");

	// 第一次点 tokens：同一列 → 翻成升序。
	sortButtonFor(table(), "tokens").props.onClick();
	assert.equal(headerFor(table(), "tokens").props["aria-sort"], "ascending", "再点一次同一列必须翻成升序");

	// 第二次点 tokens：再翻回降序。少了这条，「永远 desc」的变异体也能过。
	sortButtonFor(table(), "tokens").props.onClick();
	assert.equal(headerFor(table(), "tokens").props["aria-sort"], "descending", "第三次点击必须翻回降序");

	// 换一列：从 desc 重新开始，且旧列回到 none。
	sortButtonFor(table(), "请求").props.onClick();
	assert.equal(headerFor(table(), "请求").props["aria-sort"], "descending", "换列后必须从降序开始");
	assert.equal(headerFor(table(), "tokens").props["aria-sort"], "none", "旧列必须回到 none，否则读屏会听到两列同时在排序");

	// 箭头必须跟着真实方向走，不能无条件拼 ↓。
	assert.match(textOf(headerFor(table(), "请求")), /↓/, "降序列应显示 ↓");
	sortButtonFor(table(), "请求").props.onClick();
	assert.match(textOf(headerFor(table(), "请求")), /↑/, "翻成升序后箭头必须是 ↑，不能固定为 ↓");
});

test("未定价行在 cost 列两个方向上都恒排最后，且不与有效的 cost:0 混同", async (t) => {
	const { render } = await renderInteractive(t, payloadWithMixedCosts(), "Panel", { onClose: () => {} });

	// 这条是本轮验证者抓到的存活变异体（M9）：`sortRows` 里那两行 null 分支被删掉后，
	// null 会参与数值比较——升序时 `null < 5` 为真，未定价行会**跳到表头**。这与
	// `src/client.js:425-426` 的注释「它根本不该参与数值比较，任何方向都排最后」直接矛盾。
	//
	// 断言的是**渲染出来的行序**，不是 aria-sort：缺陷在排序结果里，方向标签完全可能
	// 是正确的同时行序是错的（M9 变异后 aria-sort 依然是 ascending/descending）。
	//
	// 断言两处都做，因为两张表各有一份排序状态、也各自调用 sortRows：
	// 只测分渠道表时，分模型表那条路径上的同类变异会漏网。
	const tables = findAllByClass(render(), "ul-table");
	assert.equal(tables.length, 2, "分渠道与分模型各一张表");
	const cases = [
		["分渠道表", 0, { mid: "p-mid", none: "p-none", low: "p-low", zero: "p-zero" }],
		["分模型表", 1, { mid: "m-mid", none: "m-none", low: "m-low", zero: "m-zero" }],
	];

	for (const [label, index, name] of cases) {
		const table = () => findAllByClass(render(), "ul-table")[index];
		const order = () => renderedRowNames(table());

		// 初始按 tokens 降序，与 cost 无关；先确认四个名字都在，避免后面拿空数组比较。
		assert.deepEqual(
			[...order()].sort(),
			[name.mid, name.none, name.low, name.zero].sort(),
			`${label}的初始行序与载荷对不上，后面的断言不可信`,
		);

		// 点一次 cost 表头：tokens 列是激活列，换到 cost 列 → 从 desc 开始。
		sortButtonFor(table(), "官方价折算").props.onClick();
		assert.equal(headerFor(table(), "官方价折算").props["aria-sort"], "descending", `${label}换到 cost 列后应从降序开始`);
		assert.deepEqual(
			order(),
			[name.mid, name.low, name.zero, name.none],
			`${label}按 cost 降序：未定价行（cost=null）必须排在最后。` +
				"null 一旦参与数值比较，它会被当成最小值或 0，未定价行就会随方向跳到表头或与 cost:0 的行混在一起——" +
				"用户会把「没有定价」误读成「最便宜」。",
		);

		// 再点一次：翻成升序。未定价行**仍然**必须在最后——这是「任何方向都排最后」的关键。
		sortButtonFor(table(), "官方价折算").props.onClick();
		assert.equal(headerFor(table(), "官方价折算").props["aria-sort"], "ascending", `${label}再点一次应翻成升序`);
		assert.deepEqual(
			order(),
			[name.zero, name.low, name.mid, name.none],
			`${label}按 cost 升序：未定价行必须仍在最后，不能跳到表头。` +
				"「缺失值恒排最后」是方向无关的不变量；只在降序下成立等于让用户切一次方向就看到一张顺序错乱的表。",
		);

		// cost:0 是**有效**数值，必须按 0 参与比较：升序时它排最前（而不是被当成缺失沉底）。
		// 这条把「null 缺失」与「数值 0」区分开——`valueOf(...) ?? 0` 那个变异体会让两者纠缠。
		assert.equal(order()[0], name.zero, `${label}升序时 cost:0 的有效行必须排最前：0 是有效值，不该被当成缺失`);
		assert.equal(order().at(-1), name.none, `${label}升序时最后一行必须是未定价行`);
	}
});

//#region 分模型表的分组（#9 / ADR-0007）

/**
 * 一份「两个跨渠道模型 + 一个单渠道模型」的载荷（#9）。
 *
 * 数值刻意让**加权缓存命中率与各行缓存命中率的平均分得很开**——这是这条口径唯一能被证伪的
 * 方式。注意小计把比率按 `Math.round(… × 1000) / 10` 只保留**一位**小数，所以加权值
 * 若落在 0.05% 这种量级就会被舍成 0%，与「平均值」不再可区分；下面两组都避开了那个坑
 * （第二组落在 1%）。
 *
 * - `m-shared`：合计缓存读 1_300_000、提示词 1_300_000 + 167 + 1 = 1_300_168
 *   → 加权 **100%**；两行各自的缓存命中率是 100% 与 99% → 平均 **99.5%**。
 * - `m-alt`：合计缓存读 300、提示词 (30_000 + 0) + (0 + 300) = 30_300
 *   → 加权 0.990…% → **1%**；两行是 0% 与 100% → 平均 **50%**。这一组是决定性的
 *   （相差 49 个百分点），`m-shared` 那组只差 0.5 个百分点。
 * - `m-solo` 只有一条渠道，用来钉住「单渠道不给小计」。
 *
 * 行数据里的 `cacheHitRate` 是**展示用**的，宿主端给什么就是什么；小计不读它，
 * 只读四列 token 现算——这正是不变量（合计比率 ≠ 比率平均）的落点。
 *
 * @returns 载荷。
 */
function payloadWithGroupedModels() {
	const payload = payloadWith({ priced: true, total: 9, currency: "CNY", unpriced: [] });
	payload.providers = [
		{ provider: "relay-a", tokens: 1_300_000, requests: 10, inputTokens: 167, outputTokens: 0, cacheReadTokens: 1_300_000, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 100, cost: 1 },
		{ provider: "relay-b", tokens: 100, requests: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 0, cost: 2 },
	];
	payload.models = [
		{ provider: "relay-a", model: "m-shared", tokens: 1_300_000, requests: 10, inputTokens: 167, outputTokens: 0, cacheReadTokens: 1_300_000, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 100, cost: 1 },
		{ provider: "relay-b", model: "m-shared", tokens: 100, requests: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 99, cost: 2 },
		{ provider: "relay-a", model: "m-alt", tokens: 30_000, requests: 2, inputTokens: 30_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 0, cost: 3 },
		{ provider: "relay-b", model: "m-alt", tokens: 100, requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 100, cost: 3 },
		{ provider: "relay-a", model: "m-solo", tokens: 50_000, requests: 1, inputTokens: 50_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 0, cost: 0 },
	];
	return payload;
}

/** 分模型表的小计行（`tr.ul-rollup`）。 */
function rollupRows(table) {
	return findAll(table, (element) => element.type === "tr" && element.props?.className === "ul-rollup");
}

/** 小计行组名的前缀；与 `src/client.js` 的 `ROLLUP_PROVIDER` 对应。 */
const ROLLUP_PREFIX = "〔全部渠道〕";

/** 小计行的组名（去掉前缀）。 */
function rollupModel(row) {
	return cellsOf(row)[0].replace(ROLLUP_PREFIX, "");
}

/**
 * 分模型表的**渲染顺序**：明细行给 `provider/model`，小计行给 `＝模型`。
 *
 * 分组是否被打散只能从渲染顺序看出来——断言 `aria-sort` 只能证明表头说自己是什么
 * 方向，证明不了小计行还紧挨着它的成员。用 `＝` 标出小计，顺序一眼可读。
 *
 * @param table - `table` 元素。
 * @returns 行序数组。
 */
function renderedModelOrder(table) {
	return findAll(table, (element) => element.type === "tr")
		.filter((row) => findAll(row, (element) => element.type === "td").length > 0)
		.map((row) => (row.props?.className === "ul-rollup" ? `＝${rollupModel(row)}` : textOf(findAllByClass(row, "ul-name")[0])));
}

/** 取第 `index` 张表的某一格文本（0 起）。 */
function cellsOf(row) {
	return findAll(row, (element) => element.type === "td").map((element) => textOf(element));
}

/**
 * 找某一格所在列的下标，按表头文字（与 `headerFor` 同一套前缀匹配）。
 *
 * 找不到就抛：返回 -1 会让 `cells[columnIndex(...)]` 静默变成 undefined，
 * 断言可能因为「两边都是 undefined」而通过——比直接报错糟糕得多。
 *
 * @param table - `table` 元素。
 * @param label - 表头文字（可带排序箭头）。
 * @returns 列下标。
 */
function columnIndex(table, label) {
	const index = findAll(table, (element) => element.type === "th")
		.map((element) => textOf(element))
		.findIndex((text) => text.startsWith(label));
	assert.ok(index >= 0, `表里找不到表头「${label}」`);
	return index;
}

test("分模型表名称列写 provider/model，同一模型的多条渠道因此可区分（#9）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithGroupedModels(), "Panel", { onClose: () => {} });
	const tables = findAllByClass(render(), "ul-table");
	assert.equal(tables.length, 2, "分渠道与分模型各一张表");

	const names = renderedModelOrder(tables[1]).filter((name) => !name.startsWith("＝"));
	assert.deepEqual(
		names.includes("relay-a/m-shared") && names.includes("relay-b/m-shared"),
		true,
		`跨渠道模型的两行必须分别写成 provider/model，否则两行同名、用户无从区分。实际行名：${names.join(" / ")}`,
	);
	// 反向对照：分渠道表的名字**不能**跟着变成 provider/xxx——那里一行就是一条渠道。
	assert.deepEqual(renderedRowNames(tables[0]).sort(), ["relay-a", "relay-b"], "分渠道表的名字仍是裸渠道名");
});

test("只有跨渠道的模型才有小计行，单渠道模型一行都不多给（#9）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithGroupedModels(), "Panel", { onClose: () => {} });
	const table = findAllByClass(render(), "ul-table")[1];

	const rollups = rollupRows(table);
	assert.equal(rollups.length, 2, `三个模型里只有 m-shared 与 m-alt 跨渠道，必须恰好两行小计。实际：${rollups.map((row) => cellsOf(row)[0]).join(" / ")}`);
	assert.deepEqual(
		rollups.map((row) => cellsOf(row)[0]).sort(),
		["〔全部渠道〕m-alt", "〔全部渠道〕m-shared"],
		"小计的组名必须点明是哪一行的合计，且不能与明细行同名（否则读屏听到两组一模一样的名字）",
	);

	// 单渠道模型（m-solo）绝对不许有小计：它的小计与下面那行数字完全相同，
	// 给了只是噪音与双倍行高（18/21 的模型是单渠道）。
	assert.equal(
		rollups.some((row) => cellsOf(row)[0].includes("m-solo")),
		false,
		"单渠道模型出现了小计行：本机 18/21 的模型如此，等于凭空把表格高度翻倍。",
	);
	assert.equal(renderedModelOrder(table).filter((name) => name.endsWith("m-solo")).length, 1, "m-solo 应当恰好一行明细");
});

test("小计的缓存命中率 = 合计缓存读 ÷ 合计提示词，不是各行缓存命中率的平均（#9）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithGroupedModels(), "Panel", { onClose: () => {} });
	const table = findAllByClass(render(), "ul-table")[1];
	const hit = columnIndex(table, "命中");
	assert.ok(hit >= 0, "分模型表里没有「命中」列");

	const byName = new Map(rollupRows(table).map((row) => [cellsOf(row)[0], cellsOf(row)]));

	// m-alt：合计缓存读 300 / 合计提示词 (30_000 + 0) + (0 + 300) = 30_300 → 0.990…% → **1%**。
	// 若改成「各行缓存命中率的平均」，这里会是 (0 + 100) / 2 = **50%**——相差 49 个百分点，
	// 正是实测里 deepseek-v4.1-flash「加权 98.4% 对平均 49.2%」那类错误的缩小版。
	assert.equal(
		byName.get("〔全部渠道〕m-alt")[hit],
		"1%",
		"小计的缓存命中率必须先把组内各行 token 求和再相除（Σ缓存读 ÷ Σ提示词）。" +
			"写成各行缓存命中率的平均会得到 50%，把一条几乎不用缓存的渠道粉饰成一半命中——" +
			"CONTEXT.md 的「缓存命中率」条目已把这条写成不变量。",
	);

	// m-shared：合计缓存读 1_300_000 / 合计提示词 1_300_000 + 167 + 1 = 1_300_168 → 99.987…% → 100%。
	// 它同样能证伪「平均」（两行是 100% 与 99% → 99.5%），只是差距只有 0.5 个百分点，
	// 不如上面那条决定性——两条都留着，省得将来有人「顺手」删掉其中一条。
	assert.equal(byName.get("〔全部渠道〕m-shared")[hit], "100%", "m-shared 的小计的缓存命中率应为 100%（平均则是 99.5%）");
});

test("小计的其余数值列是组内各行之和，cost 用已舍入值直接相加（#9）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithGroupedModels(), "Panel", { onClose: () => {} });
	const table = findAllByClass(render(), "ul-table")[1];
	const cells = cellsOf(rollupRows(table).find((row) => cellsOf(row)[0] === "〔全部渠道〕m-shared"));

	// tokens 列走 `fmtTokens` 的万/亿分档：1_300_100 显示成「130.0 万」，
	// 与组内最大的那一行（也是 130.0 万）形成了对比陷阱——单看小计像是抄了第一行，
	// 所以下面的断言必须挑一个**只有合计才对**的数字（请求 11、输入 168）。
	assert.equal(cells[columnIndex(table, "tokens")], "130.0 万", "tokens 之和（1,300,100 按万档显示）");
	assert.equal(cells[columnIndex(table, "请求")], "11", "请求数之和：10 + 1 = 11，任何单行都给不出这个数");
	assert.equal(cells[columnIndex(table, "输入")], "168", "输入之和：167 + 1 = 168");
	assert.equal(cells[columnIndex(table, "缓存读")], "130.0 万", "缓存读之和");
	// cost：1 + 2 = 3。两行都已按 4 位小数舍入，直接相加最多 n×5e-5 的漂移，
	// 2 位小数显示下不可见（issue #9 明确接受，且不许为此改 payload）。
	assert.equal(cells[columnIndex(table, "官方价折算")], "¥3.00", "cost 用各行已舍入值直接相加");
});

test("小计行不是可聚焦元素、不带排序按钮，与名称列同一套处理（#9）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithGroupedModels(), "Panel", { onClose: () => {} });
	const table = findAllByClass(render(), "ul-table")[1];

	// 先钉住「确实有小计行」：没有这一条，下面的循环会在空数组上转一圈然后全绿——
	// 那不是「小计行不可交互」，而是「小计行不存在」。
	const rollups = rollupRows(table);
	assert.equal(rollups.length, 2, "先要真的有跨渠道小计行，下面的可交互性断言才有意义");

	for (const row of rollups) {
		assert.equal(
			findAll(row, (element) => element.type === "button").length,
			0,
			"小计行里出现了按钮：它会被 Tab 到、被点击，但点了不改变任何东西——这是对键盘用户说谎（与名称列 sortable:false 同理）。",
		);
		assert.equal(
			findAll(row, (element) => element.type === "th").length,
			0,
			"小计行里出现了 th：它会被读屏当成表头，而它只是一行合计。",
		);
		assert.equal(findAll(row, (element) => element.props?.tabIndex !== undefined).length, 0, "小计行不该有可聚焦元素");
	}

	// 反向核对：明细行里确实有可点的排序按钮之外的链接/按钮吗？没有——这条只是
	// 证明上面的「找不到按钮」不是因为整张表都退化成了纯文本。
	assert.ok(findAll(table, (element) => element.props?.className === "ul-sort").length >= 9, "表头仍应有排序按钮");
});

test("排序作用于分组：先按组合计排，组内按同一列排，分组不被打散（#9）", async (t) => {
	const { render } = await renderInteractive(t, payloadWithGroupedModels(), "Panel", { onClose: () => {} });
	const table = () => findAllByClass(render(), "ul-table")[1];

	// 各组的 tokens 合计：m-shared 1_300_100 ＞ m-solo 50_000 ＞ m-alt 30_100。
	// 单渠道的 m-solo 没有小计行，所以它只出现在行序里，不进 groupOrder。
	const groupOrder = () => rollupRows(table()).map((row) => rollupModel(row));
	assert.deepEqual(groupOrder(), ["m-shared", "m-alt"], "初始 tokens 降序：跨渠道组按各组合计排");

	// 表里明细行的顺序：跨渠道组的两个成员必须紧挨在小计行下面，不许被拆开。
	assert.deepEqual(
		renderedModelOrder(table()),
		["＝m-shared", "relay-a/m-shared", "relay-b/m-shared", "m-solo", "＝m-alt", "relay-a/m-alt", "relay-b/m-alt"],
		"小计与它的成员必须连在一起，且单渠道的 m-solo 不带任何前缀",
	);

	// 换成「缓存读」列：组按各组合计排——m-shared 1_300_000 ＞ m-alt 300 ＞ m-solo 0。
	// 单渠道组照样参与排序（它只是没有小计行），所以 m-solo 会整组挪到最后。
	sortButtonFor(table(), "缓存读").props.onClick();
	assert.deepEqual(groupOrder(), ["m-shared", "m-alt"], "按缓存读降序，组序必须按组**合计**（1_300_000 ＞ 300），不是按某一行");

	assert.deepEqual(
		renderedModelOrder(table()),
		["＝m-shared", "relay-a/m-shared", "relay-b/m-shared", "＝m-alt", "relay-b/m-alt", "relay-a/m-alt", "m-solo"],
		"换列后组内按同一列排（relay-b 的 300 在 relay-a 的 0 前面），单渠道组按自己的合计沉到最后，分组仍不被打散",
	);

	// 升序：组序整个翻过来，组内也翻过来——「排序作用于分组」是两个方向都成立的。
	sortButtonFor(table(), "缓存读").props.onClick();
	assert.deepEqual(groupOrder(), ["m-alt", "m-shared"], "升序时组序必须翻转");
	assert.deepEqual(
		renderedModelOrder(table()),
		["m-solo", "＝m-alt", "relay-a/m-alt", "relay-b/m-alt", "＝m-shared", "relay-b/m-shared", "relay-a/m-shared"],
		"升序时组内也要按同一列排，单渠道组按合计升到最前",
	);
});

test("小计行不计进「未定价」提示的 token 占比（否则总量凭空翻倍）（#9）", async (t) => {
	const payload = payloadWithGroupedModels();
	// 让一个**单渠道**模型未定价，并让提示显形。
	payload.models.find((row) => row.model === "m-solo").cost = null;
	payload.cost = { priced: true, total: 3, currency: "CNY", unpriced: ["m-solo"] };

	const { render } = await renderInteractive(t, payload, "Panel", { onClose: () => {} });
	const node = render();
	assert.equal(rollupRows(findAllByClass(node, "ul-table")[1]).length, 2, "先确认分组小计确实渲染出来了，这条断言才有对象");
	const notice = textOf(findAllByClass(node, "ul-warn")[0]);

	// 期望值从载荷现算，不写死——改了上面 fixture 的数值，这两条断言自己跟着对。
	const detailTokens = payload.models.reduce((sum, row) => sum + row.tokens, 0);
	const unpricedTokens = payload.models.filter((row) => row.cost === null).reduce((sum, row) => sum + row.tokens, 0);
	const share = Math.round((unpricedTokens / detailTokens) * 100);
	const inflated = Math.round((unpricedTokens / (detailTokens + unpricedTokens * 2)) * 100);

	// 分母若混进小计行（两行分别等于各自组的合计），总量会凭空涨一大截，占比随之下滑
	// ——而那个占比正是用户决定先补哪个价格的依据。
	assert.match(notice, new RegExp(`占 ${share}% 的 token 量`), `未定价占比必须只按明细行算。实际提示：${notice}`);
	if (inflated !== share) {
		assert.equal(new RegExp(`占 ${inflated}% `).test(notice), false, "小计行被算进了未定价占比：分组行是合计，不是数据行，不该参与统计");
	}
});

test("按「命中」列排序时，组的次序取小计的加权值，不是各行比率的和（#9）", async (t) => {
	// 比率列不能把组内各行相加：一行 100% + 一行 0% 会得到 100，比任何单行的 90% 都
	// 「大」。这里造一个正好踩中这个陷阱的载荷：
	//   m-two：两行，合计缓存读 200 / 合计提示词 400 → 加权 50%；各行比率之和 = 100。
	//   m-one：单行 90%。
	// 正确的降序是 m-one(90) → m-two(50)；若按「各行之和」排，m-two 会跑到最前面，
	// 而它自己显示的小计是 50%——组的次序与组显示的数字自相矛盾。
	const payload = payloadWith({ priced: true, total: 0, currency: "CNY", unpriced: [] });
	payload.models = [
		{ provider: "relay-a", model: "m-two", tokens: 100, requests: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 50, cost: 0 },
		{ provider: "relay-b", model: "m-two", tokens: 100, requests: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 50, cost: 0 },
		{ provider: "relay-a", model: "m-one", tokens: 100, requests: 1, inputTokens: 10, outputTokens: 0, cacheReadTokens: 90, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate: 90, cost: 0 },
	];

	const { render } = await renderInteractive(t, payload, "Panel", { onClose: () => {} });
	const table = () => findAllByClass(render(), "ul-table")[1];

	sortButtonFor(table(), "命中").props.onClick();

	// m-one 是单渠道组（没有小计行），所以只能从整表的渲染顺序看：它必须排在
	// m-two 的小计行与两行明细之前。若组的次序取「各行比率之和」，m-two 的 100
	// 会压过 m-one 的 90，整组跳到表头。
	assert.deepEqual(
		renderedModelOrder(table()),
		["m-one", "＝m-two", "relay-a/m-two", "relay-b/m-two"],
		"按缓存命中率降序时，组的次序必须与各组小计显示的加权值一致（90% ＞ 50%）",
	);
	assert.equal(cellsOf(rollupRows(table())[0])[columnIndex(table(), "命中")], "50%", "m-two 的小计显示的加权命中率是 50%");
});

//#endregion

test("遮罩对辅助技术隐藏、点击可关闭，且不是唯一出口（× 与 Esc 都在）", async (t) => {
	const closed = [];
	const { render } = await renderInteractive(t, payloadWithRows(), "Panel", { onClose: () => closed.push("closed") });
	const node = render();

	const backdrops = findAllByClass(node, "ul-backdrop");
	assert.equal(backdrops.length, 1, "面板应有一个遮罩");
	const backdrop = backdrops[0];

	// 遮罩只是视觉与点击目标，不是内容：读屏不该把它当成一块可读区域。
	assert.equal(backdrop.props["aria-hidden"], "true", "遮罩没有对辅助技术隐藏：读屏会读到一块没有意义的空区域");
	// 但它仍然要能点击关闭。
	backdrop.props.onClick();
	assert.equal(closed.length, 1, "点击遮罩必须关闭面板");

	// 之所以敢把遮罩标成 aria-hidden，是因为它不是唯一出口——× 与 Esc 都得在。
	const closeButton = findAll(node, (element) => element.type === "button" && element.props.title === "关闭");
	assert.equal(closeButton.length, 1, "面板必须有「关闭」按钮，否则遮罩被隐藏后键盘用户没有正经出口");
	closeButton[0].props.onClick();
	assert.equal(closed.length, 2, "「关闭」按钮必须真的调用 onClose");

	// Esc 也走同一条回调：直接调用挂在面板上的 keydown 处理器，而不是去源码里找字符串。
	const panel = findAllByClass(node, "ul-panel")[0];
	assert.equal(typeof panel.props.onKeyDown, "function", "面板必须监听键盘事件，否则 Esc 分支是死代码");
	panel.props.onKeyDown({ key: "Escape", stopPropagation() {} });
	assert.equal(closed.length, 3, "Esc 必须真的调用 onClose，而不只是识别了按键");

	// 反向核对：非 Escape 的按键不能误关面板。
	panel.props.onKeyDown({ key: "a", stopPropagation() {} });
	assert.equal(closed.length, 3, "普通按键不该关闭面板");
});

//#endregion

//#region 三态：加载中 / 有数据 / 失败（A8 回归）

/**
 * 手动控制的 fetch 桩：每个查询串各挂一条**可以稍后结算**的 promise。
 *
 * 用有状态 React 桩渲染组件时，`useEffect` 立刻执行、立刻清理，而 promise 要等到
 * 下一次 `await` 才结算。所以「已缓存范围 A」必须先让它的请求结算完（此时组件已
 * 卸载，state 不再更新，但模块级 `usageCache` 已经填好），再渲染切到范围 B 的
 * 那一帧——这正是真实浏览器里「打开面板时缓存已预热」的时序。
 *
 * @returns `{fetch, requests, resolve}`；`requests` 按调用顺序记录查询串，
 *   `resolve(query, payload)` 结算该查询的**最新**一个未决请求。
 */
function deferredFetch() {
	const requests = [];
	const waiting = new Map();

	/** 结算某个查询串最新的未决请求。 */
	const resolve = (query, payload) => {
		const queue = waiting.get(query);
		assert.ok(queue !== undefined && queue.length > 0, `没有等待中的请求：${query}`);
		queue.shift()({ ok: true, status: 200, json: async () => payload });
	};

	/** 让某个查询串最新的未决请求失败（HTTP 500，不是 AbortError）。 */
	const reject = (query, message = "HTTP 500") => {
		const queue = waiting.get(query);
		assert.ok(queue !== undefined && queue.length > 0, `没有等待中的请求：${query}`);
		queue.shift()(Promise.reject(new Error(message)));
	};

	return {
		fetch: (url) => {
			const query = String(url).split("?")[1] ?? "";
			requests.push(query);
			return new Promise((settle) => {
				if (!waiting.has(query)) waiting.set(query, []);
				waiting.get(query).push(settle);
			});
		},
		requests,
		resolve,
		reject,
	};
}

/**
 * 面板范围标签：`.ul-head` 里那行 `font-size:11px` 的次要文字，**排除**刷新提示。
 *
 * 标签与「更新中…」共用同一个样式对象，所以只能按文案区分；找不到标签时返回空串
 * ——「没有标签」本身就是要断言的语义（新范围还没有数据，标签必须为空）。
 *
 * @param node - 面板元素树。
 * @returns 范围标签文本，或空串。
 */
function rangeLabel(node) {
	const head = findAllByClass(node, "ul-head")[0];
	assert.ok(head !== undefined, "面板里找不到 .ul-head");
	const labels = findAll(
		head,
		(element) => element.props?.className === "ul-muted" && element.props?.style?.fontSize === "11px" && textOf(element) !== "更新中…",
	);
	assert.ok(labels.length <= 1, `范围标签至多一条，实际 ${labels.length} 条`);
	return labels.length === 0 ? "" : textOf(labels[0]);
}

/** 点面板上的范围标签页（`今日` / `近 7 天` / `本月` / `累计`）。 */
function clickTab(node, label) {
	const found = findAll(node, (element) => element.type === "button" && element.props?.className === "ul-tab" && textOf(element) === label);
	assert.equal(found.length, 1, `找不到范围标签页「${label}」`);
	return found[0];
}

/** 面板里的「更新中…」提示条（有则返回它的文本，没有返回 null）。 */
function refreshingNote(node) {
	const head = findAllByClass(node, "ul-head")[0];
	assert.ok(head !== undefined, "面板里找不到 .ul-head");
	const found = findAll(head, (element) => textOf(element) === "更新中…");
	return found.length === 0 ? null : textOf(found[0]);
}

test("A8：切到无缓存的范围时，范围标签与卡片数字都不得复用上一个范围的陈旧载荷", async (t) => {
	const net = deferredFetch();
	const harness = statefulReact();
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });
	const render = () => {
		harness.begin();
		return exports.Panel({ onClose: () => {} });
	};

	// 第一帧：默认范围是 month，请求挂起 → 加载态。
	const first = render();
	assert.match(textOf(first), /正在读取本地会话日志/, "首次渲染应当是加载态");
	assert.deepEqual(net.requests, ["range=month"], "首帧应当只请求 month");

	// month 的载荷回来（组件已卸载，但模块级缓存被填好，这正是徽章预热的时序）。
	net.resolve("range=month", { ...payloadWith({ priced: false }), range: { label: "本月" } });
	await flush();

	// 第二帧：同一范围、缓存命中 → 立即出画面，标签与数字都属于 month。
	const cached = render();
	assert.equal(rangeLabel(cached), "本月", "缓存命中时应当直接显示 month 的范围标签");
	assert.equal(cardValue(cached, "消耗总量"), "1234.6 万", "缓存命中时应当显示 month 的数字");

	// 第三帧：点「近 7 天」（无缓存、fetch 永久挂起）。
	clickTab(cached, "近 7 天").props.onClick();
	const node = render();

	assert.equal(net.requests.at(-1), "range=week", "切范围必须发出 week 的请求");
	assert.notEqual(
		rangeLabel(node),
		"本月",
		"范围标签读的是上一个范围的旧载荷：标签与数字会「自洽地错」，用户看到的是「近 7 天」选中但数字是本月",
	);
	assert.equal(rangeLabel(node), "", "week 还没有数据：范围标签必须为空，不能借用 month 的标签");
	assert.match(textOf(node), /正在读取本地会话日志/, "无缓存的范围必须显示加载态");
	assert.equal(
		findAllByClass(node, "ul-card").length,
		0,
		"无缓存的范围不得渲染上一个范围的汇总卡片：那张卡片的数字属于另一个查询",
	);
});

test("A8：同一范围的静默刷新必须保留旧数据，不能被加载态顶掉", async (t) => {
	const net = deferredFetch();
	const harness = statefulReact();
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });
	const render = () => {
		harness.begin();
		return exports.Panel({ onClose: () => {} });
	};

	render();
	net.resolve("range=month", { ...payloadWith({ priced: false }), range: { label: "本月" } });
	await flush();

	// 点「刷新」：同一 query 的静默刷新。
	const reloading = render();
	findAll(reloading, (element) => element.type === "button" && element.props.title === "刷新")[0].props.onClick();
	const during = render();

	assert.equal(rangeLabel(during), "本月", "同范围刷新期间范围标签必须保留");
	assert.equal(cardValue(during, "消耗总量"), "1234.6 万", "同范围刷新期间旧数据必须继续显示，不能闪回骨架屏");
	assert.equal(refreshingNote(during), "更新中…", "同范围刷新期间应当明确显示「更新中…」");

	// 刷新成功：新数字替换旧数字。
	net.resolve("range=month", { ...payloadWith({ priced: false }), range: { label: "本月" }, totals: { ...payloadWith({}).totals, tokens: 999 } });
	await flush();
	const after = render();
	assert.equal(cardValue(after, "消耗总量"), "999", "刷新成功后必须换成新数据");
	assert.equal(refreshingNote(after), null, "刷新成功后「更新中…」必须消失");
});

test("A8：刷新持续失败不得永久显示「更新中…」，但已有数据必须留在画面上", async (t) => {
	const net = deferredFetch();
	const harness = statefulReact();
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });
	const render = () => {
		harness.begin();
		return exports.Panel({ onClose: () => {} });
	};

	render();
	net.resolve("range=month", { ...payloadWith({ priced: false }), range: { label: "本月" } });
	await flush();
	const loaded = render();
	assert.equal(cardValue(loaded, "消耗总量"), "1234.6 万", "前置条件：第一次必须成功拿到数据");

	// 点刷新，然后让请求失败（HTTP 500，不是 AbortError）。
	findAll(loaded, (element) => element.type === "button" && element.props.title === "刷新")[0].props.onClick();
	render();
	net.reject("range=month");
	await flush();

	const failed = render();
	assert.equal(
		refreshingNote(failed),
		null,
		"刷新已经失败、也没有请求在飞，却还在说「更新中…」：文案是假的，且会永久挂在那里",
	);
	assert.equal(cardValue(failed, "消耗总量"), "1234.6 万", "刷新失败不得把已有数据换成错误页");
	assert.equal(rangeLabel(failed), "本月", "刷新失败后范围标签必须还在");
	assert.equal(findAllByClass(failed, "ul-err").length, 0, "有数据的刷新失败不是致命错误：不能整块换成错误页");
	const warn = findAllByClass(failed, "ul-warn");
	assert.equal(warn.length, 1, "刷新失败必须有一条可见文案，否则用户以为数字是最新的");
	assert.match(textOf(warn[0]), /刷新失败/, `刷新失败文案里必须说清是「刷新」失败：${textOf(warn[0])}`);
	assert.match(textOf(warn[0]), /仍在显示|上一次/, "刷新失败文案必须告诉用户画面上的数字是旧的");
});

test("未定价提示只报比例：明细清单与「去 pricing.json 手改」的指引不再重复出现", async (t) => {
	// 规格 §8.1 第 456 行：`UnpricedNotice` 只保留已被钉住的两句（占比 + share>=20 后缀），
	// `ranked` 明细段与「在 $DSH_HOME/usage-ledger-pricing.json 里…」那句指引**由
	// `UnpricedSection` 承担**。
	//
	// 两块都画会在同一帧里出现两遍同样的行与**两条互斥的指引**——一句让人去手改 JSON、
	// 一句提供面板内认领，用户不知道该听谁的。这条用例把「不再重复」钉住。
	const payload = payloadWithRows();
	payload.models[0].cost = null;
	payload.cost = { priced: true, total: 1, currency: "CNY", unpriced: ["m-one"] };
	const unpricedPayload = {
		ok: true,
		currency: "CNY",
		range: { from: null, to: null, label: "本月" },
		items: [
			{
				id: "relay-a/m-one",
				provider: "relay-a",
				model: "m-one",
				tokens: 200,
				requests: 2,
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				cacheHitRate: 10,
				cause: "no-price",
				suggestions: [],
			},
		],
		candidates: [],
		overrides: { path: "/home/u/.dsh/usage-ledger-overrides.json", exists: false, version: null, enabled: true },
	};

	const harness = statefulReact();
	const { exports } = await load(t, {
		react: harness.stub,
		fetch: async (url) => ({
			ok: true,
			status: 200,
			json: async () => (String(url).includes("/unpriced") ? unpricedPayload : payload),
		}),
	});
	const render = () => {
		harness.begin();
		return exports.Panel({ onClose: () => {} });
	};
	// 三帧：主载荷 → enabled 翻真后发 /unpriced → 区块拿到 items。
	render();
	await flush();
	render();
	await flush();
	const node = render();
	const text = textOf(node);

	assert.match(text, /未定价：1 个模型，占 \d+% 的 token 量/, "已被钉住的占比那句必须保留（test/client.test.js 的 #9 占比用例依赖它）");
	assert.doesNotMatch(
		text,
		/在 \$DSH_HOME\/usage-ledger-pricing\.json 里按每百万 token 填价格即可/,
		"「去 pricing.json 手改」那句指引仍在：它与面板内认领是两条互斥的路径，同时出现会让用户不知道该听谁的（规格 §8.1）",
	);

	// 「同一行只出现一次」：`relay-a/m-one` 在整棵树里只能有一处——既有的提示区不再
	// 列明细，明细只由未定价区块提供。先确认区块确实渲染了，否则「只出现一次」也可能
	// 只是因为它压根没渲染。
	assert.equal(findAllByClass(node, "ul-unpriced").length, 1, "前置条件：未定价区块必须渲染出来");
	const occurrences = findAll(node, (element) => textOf(element) === "relay-a/m-one");
	assert.equal(
		occurrences.length,
		1,
		`\`relay-a/m-one\` 在树里作为独立文本出现了 ${occurrences.length} 处（应为 1）：` +
			"提示区与未定价区块同时列了同一行，用户会以为是两条不同的记录。",
	);
});

test("Panel 把 /unpriced 接进「未定价」区块，且只在该有未定价模型时才请求它", async (t) => {
	// 这条守的是**装配**：区块自己（client-unpriced.test.js）与接口（unpriced.test.js）
	// 都各有一整套断言，但「Panel 到底有没有把两边接起来」只有这里能看见。
	// 接不上的话，`UnpricedSection` 永远拿不到 `items`，面板上那一块**永远不渲染**，
	// 而所有单元断言照样全绿。
	const requests = [];
	const unpricedPayload = {
		ok: true,
		currency: "CNY",
		range: { from: null, to: null, label: "本月" },
		items: [
			{
				id: "relay-a/brand-new",
				provider: "relay-a",
				model: "brand-new",
				tokens: 5000,
				requests: 7,
				inputTokens: 5000,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				cacheHitRate: 0,
				cause: "no-price",
				suggestions: [{ model: "deepseek-flash", score: 0.9, reason: "去掉命名空间前缀后与 deepseek-flash 同名" }],
			},
		],
		candidates: [{ id: "deepseek-flash", input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0, currency: "CNY", vendor: "DeepSeek", modelName: "DeepSeek Flash", context: 1000, source: "file", aliasTarget: null }],
		overrides: { path: "/home/u/.dsh/usage-ledger-overrides.json", exists: false, version: null, enabled: true },
	};
	const fetchStub = async (url) => {
		const text = String(url);
		requests.push(text);
		return { ok: true, status: 200, json: async () => (text.includes("/unpriced") ? unpricedPayload : payloadWith({ priced: true, total: 1, currency: "CNY", unpriced: ["relay-a/brand-new"] })) };
	};

	const harness = statefulReact();
	const { exports } = await load(t, { fetch: fetchStub, react: harness.stub });
	const render = () => {
		harness.begin();
		return exports.Panel({ onClose: () => {} });
	};

	// 三帧，而不是两帧：第一帧还没有主载荷（`enabled` 为 false，不发 /unpriced 请求）；
	// 主载荷回来后 `enabled` 翻真，effect 才发那次请求；请求回来后还要再渲染一帧。
	// 真实 React 里这三帧由 setState 自动驱动，这里的桩要手动走一遍。
	render();
	await flush();
	render();
	await flush();
	const node = render();

	assert.ok(
		requests.some((url) => url.includes("/unpriced")),
		"Panel 从未请求 /unpriced：未定价区块永远拿不到 items，那一块在面板上**永远不渲染**，而所有单元断言照样全绿",
	);
	const text = textOf(node);
	assert.match(text, /relay-a\/brand-new/, "未定价清单里的行必须真的渲染出来");
	assert.equal(findAll(node, (element) => element.type === "button" && textOf(element) === "自定义价格").length, 1, "每行都要有动作入口");

	// 反向对照：主载荷说「没有未定价模型」时**不该**发这个请求。
	const clean = statefulReact();
	const cleanRequests = [];
	const cleanLoad = await load(t, {
		fetch: async (url) => {
			cleanRequests.push(String(url));
			return { ok: true, status: 200, json: async () => payloadWith({ priced: true, total: 1, currency: "CNY", unpriced: [] }) };
		},
		react: clean.stub,
	});
	clean.begin();
	cleanLoad.exports.Panel({ onClose: () => {} });
	await flush();
	clean.begin();
	const cleanNode = cleanLoad.exports.Panel({ onClose: () => {} });
	assert.equal(
		cleanRequests.some((url) => url.includes("/unpriced")),
		false,
		"主载荷说「没有未定价模型」时不该再发一次请求——接口的不变式保证那次答案一定是空清单，区块反正不渲染",
	);
	assert.equal(findAllByClass(cleanNode, "ul-unpriced").length, 0, "没有未定价模型时不该渲染区块");
});

test("A8：无数据时的失败是致命错误，必须显示错误页而不是永远「加载中」", async (t) => {
	const net = deferredFetch();
	const harness = statefulReact();
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });

	harness.begin();
	const node = exports.Panel({ onClose: () => {} });
	assert.match(textOf(node), /正在读取本地会话日志/, "前置条件：首帧是加载态");
	net.reject("range=month");
	await flush();

	harness.begin();
	const failed = exports.Panel({ onClose: () => {} });
	assert.equal(findAllByClass(failed, "ul-err").length, 1, "没有任何数据可用时，失败必须变成可见的错误页");
	assert.match(textOf(failed), /读取失败/, "错误页必须说清是读取失败");
	assert.equal(findAllByClass(failed, "ul-card").length, 0, "没有数据时不该渲染出数字");
});

test("A8：徽章拉取持续失败时不得永久停在「…」，必须给出可区分的失败态", async (t) => {
	const net = deferredFetch();
	const harness = statefulReact({ deferCleanup: true });
	// 推迟清理意味着徽章的 setInterval 还在跑：用例失败也必须收尾，否则进程不退出。
	t.after(() => harness.dispose());
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });

	// 徽章挂载即预热 today 与上次范围；让两个请求都失败。
	harness.begin();
	exports.Badge({});
	net.reject("range=month");
	net.reject("range=today");
	// 清理被推迟到下一次 begin()，所以失败回调执行时 mounted 仍为 true——那条分支真的跑到了。
	await flush();

	harness.begin();
	const node = exports.Badge({});
	const text = textOf(node);

	assert.doesNotMatch(text, /…/, "徽章 fetch 失败后永远停在「…」：加载中与失败不可区分，用户会以为它一直在加载");
	assert.match(text, /用量账本/, "失败态不能把徽章标题弄丢");
	const badge = findAllByClass(node, "ul-badge")[0];
	assert.equal(badge.props.title, "用量账本（今日数据读取失败）", `失败态必须有可区分的 title，实际是「${badge.props.title}」`);
	harness.dispose();
});

test("A8：徽章已有数字后刷新失败，旧数字必须保留（不能退回「…」）", async (t) => {
	const net = deferredFetch();
	const harness = statefulReact({ deferCleanup: true });
	// 推迟清理意味着徽章的 setInterval 还在跑：用例失败也必须收尾，否则进程不退出。
	t.after(() => harness.dispose());
	const { exports } = await load(t, { fetch: net.fetch, react: harness.stub });

	// 第一轮：成功拿到今日数字。
	harness.begin();
	exports.Badge({});
	net.resolve("range=month", { ...payloadWith({ priced: false }), range: { label: "本月" } });
	net.resolve("range=today", { ...payloadWith({ priced: false }), range: { label: "今日" } });
	await flush();

	harness.begin();
	const ok = exports.Badge({});
	assert.match(textOf(ok), /1234\.6 万/, "前置条件：徽章必须显示今日数字");

	// 第二轮：再次挂载并让这一轮请求失败——旧数字必须留着，失败要看得见。
	harness.begin();
	exports.Badge({});
	net.reject("range=month");
	net.reject("range=today");
	await flush();

	harness.begin();
	const after = exports.Badge({});
	assert.match(textOf(after), /1234\.6 万/, "徽章刷新失败时必须保留旧数字，不能退回「…」");
	const badge = findAllByClass(after, "ul-badge")[0];
	assert.equal(badge.props.title, "用量账本（今日数据读取失败）", "刷新失败必须可见：否则用户以为这个数字是刚才拉到的");
	harness.dispose();
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
