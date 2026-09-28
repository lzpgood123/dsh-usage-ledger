/**
 * 宿主端载荷组装的测试。
 *
 * 这里盯的是 `src/index.js` 的 `buildPayload` / `resolveRange` 与 `src/scan.js` 的
 * `recordOf`——在此之前 `grep -rn "buildPayload" test/` **零命中**：T2 的并集摊平、
 * 渠道成本聚合、371 天窗口与时钟注入全都没有提交的测试，正确性只靠一个未提交的
 * 临时脚本，四个变异（M6/M8/M12/M15）因此存活。
 *
 * ## 为什么必须用合成记录，而不是真实语料
 *
 * 真实语料撑不起下面这几条断言，两个变异在真实数据上都是 **no-op**：
 *
 * - 冻结语料只跨 45 天，而活动窗口是 371 天 → 「窗口外记录」= 0/11695。
 *   去掉 `activity` 的 `row.day >= sinceDay` 过滤，真实输出一字不变。
 * - 真实价格的最大舍入漂移是 0.00004824，刚好低于翻转 4 位小数的阈值
 *   0.00005 → 「累加已舍入的模型成本」在真实数据上也一字不变。
 *
 * 所以下面的用例一律用**构造的**记录与价格，让每个变异都必然改变输出。
 *
 * @module usage-ledger/test/payload
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_DAYS, buildPayload, resolveRange } from "../src/index.js";
import { recordOf } from "../src/scan.js";

/** 测试参照时刻：本地 2026-09-28。 */
const NOW = new Date(2026, 8, 28);

/**
 * 造一条计费记录。
 *
 * 字段形状与 `parseSessionText` 的产物一致：`day` 是本地日期键，`tokens` 是总量。
 *
 * @param day - 本地日期键 `YYYY-MM-DD`。
 * @param provider - 渠道 id。
 * @param model - 模型 id。
 * @param inputTokens - 输入 token 数，同时充当总量（其余分项为 0）。
 * @returns 计费记录。
 */
function rec(day, provider, model, inputTokens) {
	return {
		day,
		provider,
		model,
		inputTokens,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		tokens: inputTokens,
		requests: 1,
	};
}

test("载荷：371 天窗口外的记录不进热力图，但仍计入累计 totals（M8）", () => {
	const old = "2020-01-01"; // 远早于 371 天窗口
	const fresh = "2026-09-20"; // 窗口内
	const payload = buildPayload([rec(old, "p", "m", 100), rec(fresh, "p", "m", 100)], {
		range: resolveRange("all", null, null, NOW),
		now: NOW,
	});

	assert.equal(
		payload.activity.some((row) => row.day === old),
		false,
		"窗口外的日期不得进入热力图：activity 是「全年作息」，超过 371 天的记录只会把图拉长。",
	);
	assert.equal(payload.activity.some((row) => row.day === fresh), true, "窗口内的日期必须保留。");
	assert.equal(payload.totals.tokens, 200, "totals 是累计口径，窗口外的旧记录仍要计入。");
});

test("载荷：渠道成本累加未舍入的模型成本，只舍入一次（M6）", () => {
	// 单模型成本 = 2000098 * 0.5 / 1e6 = 1.000049，舍入到 4 位得 1。
	// 两个模型：未舍入求和 = 2.000098 → 2.0001；累加已舍入值则得 2。
	const records = [rec("2026-09-20", "p", "m1", 2000098), rec("2026-09-20", "p", "m2", 2000098)];
	const payload = buildPayload(records, {
		range: resolveRange("all", null, null, NOW),
		pricing: { m1: { input: 0.5 }, m2: { input: 0.5 } },
		currency: "CNY",
		now: NOW,
	});

	assert.deepEqual(
		payload.models.map((row) => row.cost),
		[1, 1],
		"单个模型各自舍入到 1。",
	);
	assert.equal(
		payload.providers[0].cost,
		2.0001,
		"渠道成本必须按未舍入值求和后只舍入一次；累加已舍入的模型成本会得到 2，逐项误差在渠道层累积。",
	);
});

test("载荷：resolveRange(\"week\") 是含当天在内 7 天（M12）", () => {
	const week = resolveRange("week", null, null, NOW);

	assert.deepEqual(week, { from: "2026-09-22", to: "2026-09-28", label: "近 7 天" });

	const days = (new Date(week.to) - new Date(week.from)) / 86400000 + 1;
	assert.equal(days, 7, "「近 7 天」必须真的覆盖 7 个自然日（含当天）；6 天会让面板少一天且不报错。");
});

test("扫描：recordOf 拒绝负数用量（M15）", () => {
	assert.equal(
		recordOf({ message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: -5, outputTokens: 1 } }),
		undefined,
		"负数 token 不是合法计数，必须整条拒绝——否则一条脏记录会凭空抵消真实用量。",
	);
});

test("载荷：不传 now 等价于 new Date()，且注入的 now 决定 371 天窗口（时钟注入）", () => {
	const records = [rec("2026-09-20", "p", "m", 100)];
	const range = resolveRange("all", null, null, NOW);

	// 默认行为等价：不传 now 时内部就是 `new Date()`，两者只该在 generatedAt 上不同。
	const implicit = buildPayload(records, { range });
	const explicit = buildPayload(records, { range, now: new Date() });
	delete implicit.generatedAt;
	delete explicit.generatedAt;
	assert.deepEqual(implicit, explicit, "不传 now 与显式传入 new Date() 的载荷除 generatedAt 外必须一致。");

	// 注入的 now 决定窗口：同一条记录，换一个 now 就落到窗口外。
	const near = buildPayload(records, { range, now: NOW });
	const far = buildPayload(records, { range, now: new Date(2027, 8, 28) });
	assert.equal(near.activity.some((row) => row.day === "2026-09-20"), true, "now = 2026-09-28 时该记录在 371 天窗口内。");
	assert.equal(far.activity.some((row) => row.day === "2026-09-20"), false, "now = 2027-09-28 时同一记录落到窗口外。");
});

test("载荷：自定义范围不截断热力图，activity 仍覆盖完整 371 天窗口", () => {
	const outsideRange = "2026-09-20"; // 在窗口内，但在自定义范围之外
	const beforeWindow = "2020-01-01"; // 窗口之外
	const payload = buildPayload([rec(beforeWindow, "p", "m", 100), rec(outsideRange, "p", "m", 200)], {
		range: resolveRange("custom", "2026-09-01", "2026-09-10", NOW),
		now: NOW,
	});

	assert.equal(payload.totals.tokens, 0, "totals 只算所选范围：两条记录都不在 2026-09-01 → 2026-09-10 内。");
	assert.equal(
		payload.activity.some((row) => row.day === outsideRange),
		true,
		"范围外但窗口内的日期仍要出现在热力图上——热力图是「全年作息」，不能跟着 range.to 截断。",
	);
	assert.equal(payload.activity.some((row) => row.day === beforeWindow), false, "窗口外的日期仍然不得出现。");
	assert.equal(payload.activityDays, ACTIVITY_DAYS, "窗口长度来自宿主端导出的 ACTIVITY_DAYS。");
});
