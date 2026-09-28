/**
 * 成本口径 `costOf` 的直接测试。
 *
 * issue #5：`src/index.js` 的 `costOf` 承载着一条**口径**，但在此之前
 * `grep -rn "costOf" test/` **零命中**——`payload.test.js` 只看 `buildPayload` 的
 * 整体结果，从没直接验过边界。
 *
 * ## 口径：宁可显示「—」，也不猜汇率（ADR-0001）
 *
 * ADR-0001 的推论是「归一不了官方模型 id 的条目如实留空，不拿 0 冒充『免费』；
 * 缺少汇率也不猜，宁可显示『—』」。落到 `costOf` 上就是两处 `return undefined`：
 *
 * 1. `price` 缺失（`undefined` / `null`）→ `undefined`，**不是 0**；
 * 2. 条目币种与目标币种不同、而 `rates` 里没有该币种的**有限数**汇率 → `undefined`，
 *    不拿 1、也不拿 0 顶上。
 *
 * 第 2 条最危险：一旦有人把它改成 `?? 0` 或少写一个 `Number.isFinite`，未定价的
 * 渠道会被静默算成 ¥0——正是 ADR-0001 要避免的「0 冒充免费」。下面的用例把
 * 「缺失」与「显式给出的 0」明确分开，两种退化的写法都会变红。
 *
 * ## 为什么全是纯函数调用
 *
 * `costOf` 是纯函数：零 I/O、零网络、零时钟。所以用例直接喂构造出来的桶与价格表，
 * 不起 HTTP server、不读会话日志——这样任何一处口径变异都必然改变断言结果，
 * 而不是被 fixture 的形状盖住。
 *
 * @module usage-ledger/test/cost-of
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, costOf, resolveRange } from "../src/index.js";

/**
 * 造一个桶。
 *
 * 四个 token 分项默认都给 0：`aggregate` 产出的行形状固定含这四项（见
 * `src/scan.js` 的桶初始化与累加），所以这里按同一前提造桶，缺 token 字段
 * 不是 `costOf` 需要处理的输入。
 *
 * @param overrides - 逐项覆盖的 token 数。
 * @returns 桶对象。
 */
function bucket(overrides = {}) {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		...overrides,
	};
}

/**
 * 造一个「碰一下就抛」的汇率表。
 *
 * 用途：证明币种相同时 `costOf` **根本不查 `rates`**。若实现退化成「先查一眼
 * 再说」，这里的 get 陷阱会立刻抛错把用例打红——比断言「结果恰好等于 1」更直接，
 * 后者在 rates 里刚好放着 1 时会被蒙混过去。
 *
 * @param label - 出现在抛错信息里的场景描述。
 * @returns 带 get 陷阱的代理。
 */
function explodingRates(label) {
	return new Proxy(
		{},
		{
			get(_target, key) {
				throw new Error(`${label}：币种已经与目标币种相同，costOf 不该去读 rates[${String(key)}]。`);
			},
		},
	);
}

/**
 * 造一条计费记录（形状与 `parseSessionText` / `recordOf` 的产物一致）。
 *
 * 只用于本文件最后一条「舍入属于调用方」的跨层用例。
 *
 * @param day - 本地日期键 `YYYY-MM-DD`。
 * @param inputTokens - 输入 token 数，同时充当总量（其余分项为 0）。
 * @returns 计费记录。
 */
function rec(day, inputTokens) {
	return {
		day,
		provider: "relay-a",
		model: "m",
		inputTokens,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		tokens: inputTokens,
		requests: 1,
	};
}

test("costOf：price 为 undefined / null → undefined（不是 0，也不是 NaN）", () => {
	for (const [price, label] of [
		[undefined, "price = undefined"],
		[null, "price = null"],
	]) {
		const got = costOf(bucket({ inputTokens: 1_000_000 }), price);
		assert.equal(got, undefined, `${label} 必须返回 undefined：价格表里查不到模型时，宁可不显示，也不拿 0 冒充「免费」。`);
		// 显式排除 0：`?? 0` 式的退化写在这里必然暴露。
		assert.notEqual(got, 0, `${label} 不得退化成 0——ADR-0001 明确「不拿 0 冒充免费」。`);
	}
	// 即使桶里用量很大、或明确给了汇率，price 缺失也不能变成数字。
	assert.equal(costOf(bucket({ inputTokens: 1_000_000, outputTokens: 500_000 }), undefined, { currency: "CNY", rates: { USD: 7.3 } }), undefined);
});

test("costOf：币种不同且 rates 缺该币种 → undefined（不猜汇率）", () => {
	const rows = [
		[{ currency: "USD" }, {}, "默认 rates 为空表"],
		[{ currency: "USD" }, { USD: undefined }, "rates 里该键存在但值为 undefined"],
		[{ currency: "USD" }, { CNY: 7.3 }, "只给了别的币种"],
		[{ currency: "USD" }, { EUR: 7.8, JPY: 0.05 }, "给了两个别的币种"],
		[{ currency: "USD" }, { usd: 7.3 }, "键名大小写不一致（只认精确键）"],
	];

	for (const [priceExtra, rates, label] of rows) {
		const got = costOf(bucket({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), { input: 1, output: 2, ...priceExtra }, { currency: "CNY", rates });
		assert.equal(got, undefined, `${label}：汇率缺失时必须返回 undefined，猜一个汇率会把金额算错且无人察觉。`);
		assert.notEqual(got, 0, `${label}：不得用 0 顶上——这正是 ADR-0001 要避免的退化。`);
		assert.equal(Number.isNaN(got), false, `${label}：不得返回 NaN（NaN 会一路污染总额）。`);
	}

	// 反向对照：同一个桶，只要汇率真的给了，就必须算出来（证明上面的 undefined
	// 是「缺汇率」导致的，而不是用例的桶/价格写错了）。
	const okBucket = bucket({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
	assert.equal(costOf(okBucket, { input: 1, output: 2, currency: "USD" }, { currency: "CNY", rates: { USD: 7.3 } }), (1 + 2) * 7.3);
});

test("costOf：rates 的值不是有限数（NaN / ±Infinity / 字符串 / null / 对象 / 函数 / 布尔）→ undefined", () => {
	const badRates = [
		[Number.NaN, "NaN"],
		[Number.POSITIVE_INFINITY, "Infinity"],
		[Number.NEGATIVE_INFINITY, "-Infinity"],
		["7.3", '字符串 "7.3"'],
		["", "空字符串"],
		[null, "null"],
		[true, "布尔 true"],
		[{ rate: 7.3 }, "对象 {rate:7.3}"],
		[() => 7.3, "函数"],
		[7n, "BigInt 7n"],
	];

	for (const [rate, label] of badRates) {
		const got = costOf(bucket({ inputTokens: 1_000_000 }), { input: 1, currency: "USD" }, { currency: "CNY", rates: { USD: rate } });
		assert.equal(got, undefined, `rates.USD 是 ${label} 时不是可用的汇率，必须返回 undefined，而不是拿它去乘。`);
		assert.notEqual(got, 0, `rates.USD 是 ${label} 时也不得退化成 0。`);
		assert.equal(Number.isNaN(got), false, `rates.USD 是 ${label} 时不得返回 NaN：一处 NaN 会污染整张表的总额。`);
	}
});

test("costOf：币种与目标币种相同则不查 rates，scale 恒为 1", () => {
	// rates 是「碰了就抛」的代理：只要实现去读了它就立刻打红。
	const guarded = (label, price, options) => {
		const got = costOf(bucket({ inputTokens: 1_000_000 }), price, { ...options, rates: explodingRates(label) });
		assert.equal(got, 1, `${label}：同币种不做折算，1M token × 单价 1 = 1。`);
	};

	guarded("条目币种显式等于默认目标币种", { input: 1, currency: "CNY" }, {});
	guarded("条目币种显式等于传入的目标币种", { input: 1, currency: "USD" }, { currency: "USD" });
	guarded("条目没写 currency（落到目标币种）", { input: 1 }, { currency: "USD" });
	guarded("条目 currency 为 null（`??` 落到目标币种）", { input: 1, currency: null }, { currency: "USD" });
	guarded("options 完全省略（默认 CNY）", { input: 1, currency: "CNY" }, undefined);
});

test("costOf：显式给出的 0 汇率是有效汇率（返回 0），与「缺失」明确区分", () => {
	// 0 是调用方**给出**的有限数，不是缺失；缺失那条用例要求 undefined。
	// 若有人把判据写成 falsy 判空（`if (!rate) return undefined`），这条会红。
	const got = costOf(bucket({ inputTokens: 1_000_000 }), { input: 5, currency: "USD" }, { currency: "CNY", rates: { USD: 0 } });
	assert.equal(got, 0, "显式 0 汇率下折算结果为 0（金额为 0），而不是 undefined。");
	assert.notEqual(got, undefined, "0 汇率是有效输入，不能与「缺汇率」混同。");
});

test("costOf：四个价格加项缺项时按 0 计，其余项照常累加，且不产生 NaN", () => {
	// price 只给 input：其余三项（output / cacheRead / cacheWrite）按 0 计，
	// 而不是让 undefined 参与乘法产生 NaN。
	const b = bucket({ inputTokens: 1_000_000, outputTokens: 2_000_000, cacheReadTokens: 500_000, cacheWriteTokens: 100_000 });
	assert.equal(costOf(b, { input: 3 }), 3, "只有 input 定价时，输出/缓存读数不得变成 NaN（NaN + 3 = NaN 会把整行成本毁掉）。");
	assert.equal(Number.isFinite(costOf(b, { input: 3 })), true, "结果必须是有限数。");

	// 四个加项全缺：等价于显式定价 0，返回 0（不是 undefined——price 对象本身在）。
	assert.equal(costOf(b, {}), 0, "价格表里给了该模型但没给任何分项价格时，成本是 0 而不是 undefined。");

	// 加项存在但不是数字（undefined / null / 字符串）→ 该项按 0 计。
	assert.equal(costOf(b, { input: 2, output: undefined, cacheRead: null, cacheWrite: "3" }), 2, "非数字加项按 0 计：字符串 \"3\" 不是数字，不得被隐式转成 3。");
	assert.equal(Number.isNaN(costOf(b, { input: 2, output: undefined, cacheRead: null, cacheWrite: "3" })), false);

	// 显式 0 单价的项按 0 计，不影响其余项。
	assert.equal(costOf(b, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), 1, "单价显式为 0 的项按 0 计，其余项照常累加。");
});

test("costOf：per_1_000_000 的量纲——价格是「每百万 token」的单价", () => {
	// 1M token × 单价 1 = 1
	assert.equal(costOf(bucket({ inputTokens: 1_000_000 }), { input: 1 }), 1, "单价按每百万 token 计价：1M token、单价 1 → 1。");
	// 50 万 token × 单价 1 = 0.5
	assert.equal(costOf(bucket({ inputTokens: 500_000 }), { input: 1 }), 0.5, "50 万 token 应当正好是 1M 的一半。");
	// 1 个 token × 单价 1 = 1e-6
	assert.equal(costOf(bucket({ inputTokens: 1 }), { input: 1 }), 0.000001, "1 个 token、单价 1 → 百万分之一。");
	// 负向对照：若把量纲写成 /1000（每千 token 计价），1M token 会算出 1000。
	assert.notEqual(costOf(bucket({ inputTokens: 1_000_000 }), { input: 1 }), 1000, "量纲是 per_1_000_000，不是 per_1000。");
	// 量纲与折算叠加：scale 只乘一次。
	assert.equal(costOf(bucket({ inputTokens: 1_000_000 }), { input: 1, currency: "USD" }, { currency: "CNY", rates: { USD: 7.3 } }), 7.3, "折算只作用一次：1M token × 单价 1 × 汇率 7.3 = 7.3。");
});

test("costOf：汇率折算对四个加项都生效", () => {
	const b = bucket({ inputTokens: 1_000_000, outputTokens: 2_000_000, cacheReadTokens: 500_000, cacheWriteTokens: 100_000 });
	const price = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3, currency: "USD" };
	const got = costOf(b, price, { currency: "CNY", rates: { USD: 7.3 } });
	// (1 + 4 + 0.25 + 0.3) × 7.3 = 40.515；浮点结合律有末位差异，用紧容差比较。
	assert.ok(Math.abs(got - 40.515) < 1e-9, `四项都要乘上汇率：期望 ≈40.515，实际 ${got}。若只有第一项被折算，结果会是 (4.55 + 1×7.3) 一类明显不同的值。`);

	// 精确可表示的对照：汇率 2（二的幂）不引入浮点误差，允许严格相等。
	// 桶：input 1M、output 2M；单价：input 1、output 2 → (1 + 4) × 2 = 10。
	assert.equal(
		costOf(bucket({ inputTokens: 1_000_000, outputTokens: 2_000_000 }), { input: 1, output: 2, currency: "USD" }, { currency: "CNY", rates: { USD: 2 } }),
		10,
		"汇率 2 时 (1 + 4) × 2 = 10，且四项各自折算后相加的结果与整行折算一致。",
	);
});

test("costOf：不自己做舍入——保留完整精度，舍入是调用方的事", () => {
	// 333333 token × 单价 1 = 0.333333（6 位小数），costOf 原样返回。
	const raw = costOf(bucket({ inputTokens: 333_333 }), { input: 1 });
	assert.equal(raw, 0.333333, "costOf 返回未舍入的精确值。");
	assert.notEqual(raw, 0.3333, "costOf 内部不得先舍入到 4 位小数——逐项舍入会让渠道总额漂移（见 payload 用例 M6 的口径）。");
	assert.notEqual(raw, 0, "未舍入不等于 0。");

	// 舍入发生在 buildPayload：模型行成本 = 未舍入值舍入到 4 位小数。
	const NOW = new Date(2026, 8, 28);
	const payload = buildPayload([rec("2026-09-20", 333_333)], {
		range: resolveRange("all", null, null, NOW),
		now: NOW,
		pricing: { m: { input: 1 } },
	});
	assert.equal(payload.models[0].cost, 0.3333, "调用方把 0.333333 舍入到 4 位小数得 0.3333。");
});
