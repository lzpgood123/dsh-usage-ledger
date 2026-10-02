/**
 * 未定价探测载荷 `buildUnpricedPayload` 的测试（ADR-0008 §2 / 规格 D2）。
 *
 * ## 本文件最重要的一条：跨接口不变式
 *
 * 面板上有**两处**在说未定价：既有的 `UnpricedNotice`（读 `buildPayload().cost.unpriced`）
 * 与新的「未定价」区块（读本接口的 `items`）。两处说的必须是**同一批** id——一旦分叉，
 * 用户会看到「未定价：3 个模型」下面列着 5 行，或者更糟：一句「未定价 0 个」配一块
 * 列了 7 行的清单。这类不一致不会报错，只会让人不再相信任何一个数字。
 *
 * 所以每个用例都在同一组入参上同时调两个函数并断言两个 Set 相等，而不是分别断言
 * 「各自看起来对」。
 *
 * ## `cause` 必须穷尽 costOf 的两条 undefined 路径
 *
 * `costOf` 返回 `undefined` 只有两种可能（实测）：没有价格行，或币种不同且 `rates` 里
 * 没有有限数汇率。面板因此能说清「补价格能修好」与「得先去主表补 rates」——后者靠
 * 「认领成已有模型」是**修不好**的。少一支就会把后者的行错误地引导到认领路径上。
 *
 * @module usage-ledger/test/unpriced
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, buildUnpricedPayload, resolveRange } from "../src/index.js";

/** 测试参照时刻：本地 2026-09-28。 */
const NOW = new Date(2026, 8, 28);

/**
 * 造一条计费记录。
 *
 * @param day - 本地日期键。
 * @param provider - 渠道 id。
 * @param model - 模型 id。
 * @param inputTokens - 输入 token 数（同时充当总量）。
 * @param requests - 请求数。
 * @returns 计费记录。
 */
function rec(day, provider, model, inputTokens, requests = 1) {
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
		requests,
	};
}

/** 一组合成价格表：两个可定价模型 + 一个缺汇率的 USD 模型。 */
const PRICING = {
	"deepseek-flash": { input: 2, output: 8, currency: "CNY" },
	"glm-5.3": { input: 1, output: 3, currency: "CNY" },
	"claude-opus-5": { input: 5, output: 25, currency: "USD" },
};

/**
 * 在一组入参上同时算两份载荷，断言未定价集合逐字相同。
 *
 * @param records - 计费记录。
 * @param options - 传给两个 build 函数的公共选项。
 * @param label - 出现在失败信息里的场景描述。
 * @returns 未定价载荷。
 */
function assertInvariant(records, options, label) {
	const payload = buildPayload(records, options);
	const unpriced = buildUnpricedPayload(records, options);
	assert.deepEqual(
		[...unpriced.items.map((item) => item.id)].sort(),
		[...payload.cost.unpriced].sort(),
		`${label}：/unpriced 的 items 与主载荷的 cost.unpriced 必须是同一批 id。` +
			"两处分叉时面板会同时显示「未定价：N 个模型」与一份对不上的清单，而没有任何报错。",
	);
	return unpriced;
}

test("未定价载荷：恰好七个顶层键，且 range 与主接口同口径", () => {
	const records = [rec("2026-09-20", "relay-a", "unknown-model", 100)];
	const options = { range: resolveRange("all", null, null, NOW), pricing: PRICING, currency: "CNY", rates: { USD: 7.3 }, now: NOW };
	const unpriced = buildUnpricedPayload(records, options);

	assert.deepEqual(
		Object.keys(unpriced).sort(),
		["candidates", "currency", "generatedAt", "items", "ok", "overrides", "range"],
		"顶层恰好七个键：面板按固定形状解析，多一个少一个都会让前端在「字段缺失」与「值为 0」之间出错",
	);
	assert.equal(unpriced.ok, true);
	assert.equal(unpriced.currency, "CNY");
	assert.equal(unpriced.generatedAt, NOW.getTime(), "generatedAt 与主载荷同义（epoch ms）");

	// 缺省 range 时与主接口逐字段相等。
	const bare = buildUnpricedPayload(records, { pricing: PRICING, currency: "CNY", now: NOW });
	const main = buildPayload(records, { pricing: PRICING, currency: "CNY", now: NOW });
	assert.deepEqual(bare.range, main.range, "缺省 range 时两个接口的 range 必须逐字段相等");
	assert.equal(bare.range.label, "累计", "缺省范围是累计");
});

test("未定价载荷：跨接口不变式——items 与 cost.unpriced 逐字相同", () => {
	const records = [
		rec("2026-09-20", "relay-a", "deepseek-flash", 100),
		rec("2026-09-20", "relay-a", "brand-new-x", 200),
		rec("2026-09-20", "relay-b", "brand-new-x", 300),
		rec("2026-09-20", "relay-c", "claude-opus-5", 400),
	];
	const options = { range: resolveRange("all", null, null, NOW), pricing: PRICING, currency: "CNY", rates: { USD: 7.3 }, now: NOW };
	const unpriced = assertInvariant(records, options, "混合语料");

	assert.equal(unpriced.items.length, 2, "两个渠道的 brand-new-x 各占一行（id 含 provider）");
	assert.deepEqual(
		unpriced.items.map((item) => item.id).sort(),
		["relay-a/brand-new-x", "relay-b/brand-new-x"],
		"id 是 `provider/model`，与 cost.unpriced 的元素逐字相同",
	);
	assert.equal(unpriced.items[0].cause, "no-price", "表里没有这一行 → no-price");
});

test("未定价载荷：cause = no-rate 的行也必须留在 items 里（认领修不好它）", () => {
	// `claude-opus-5` 的价格行是 USD，而显示币种是 CNY、rates 里**没有** USD——
	// `costOf` 因此返回 undefined（不猜汇率，ADR-0001）。这一行有价格行、只是折算不了，
	// 所以 cause 必须是 no-rate：面板要把它引导到「去主表补 rates」而不是「认领成已有模型」。
	const records = [rec("2026-09-20", "relay-c", "claude-opus-5", 400)];
	const options = { range: resolveRange("all", null, null, NOW), pricing: PRICING, currency: "CNY", rates: {}, now: NOW };
	const unpriced = assertInvariant(records, options, "缺汇率的行");

	assert.equal(unpriced.items.length, 1, "缺汇率的行同样是未定价，必须出现在 items 里");
	assert.equal(unpriced.items[0].cause, "no-rate", "有价格行但折算不了 → no-rate（与 no-price 互斥且穷尽）");

	// 反向对照：把汇率补上，它就该离开 items——证明上面那条不是「所有行都算 no-rate」。
	const fixed = buildUnpricedPayload(records, { ...options, rates: { USD: 7.3 } });
	assert.deepEqual(fixed.items, [], "补上汇率后该行可定价，必须离开清单");
});

test("未定价载荷：model = \"constructor\" 不得被算成免费（原型链陷阱）", () => {
	// 实测：`officialIdOf` 若用 `in` 判存在，`"constructor" in {}` 是 true，
	// `pricing["constructor"]` 取到一个**函数**，`costOf` 返回 0——面板显示 ¥0.00，
	// 而未定价集合为空。这与 ADR-0001「宁可显示 —，也不拿 0 冒充免费」直接冲突。
	const options = { range: resolveRange("all", null, null, NOW), pricing: {}, aliases: {}, currency: "CNY", rates: {}, now: NOW };

	// 情形 1：日志里的模型 id **本身**就是 `constructor`。
	//
	// 注意这一支单独**杀不掉** `in`：`aliasOf = aliases[model] ?? model` 会先踩同一个
	// 原型链——`{}.constructor` 是 Object 构造函数（真值），于是 aliasOf 返回一个**函数**，
	// 两种判据都查不到它。所以它必须与下面情形 2 一起看。
	const literal = [rec("2026-09-20", "relay-hostile", "constructor", 1000)];
	const unpriced = assertInvariant(literal, options, "原型保留名当模型 id");
	assert.equal(unpriced.items.length, 1, "`constructor` 没有价格行，必须出现在未定价清单里");
	assert.equal(unpriced.items[0].cause, "no-price");
	assert.equal(unpriced.items[0].id, "relay-hostile/constructor");

	// 情形 2（**决定性**的那一支）：日志里的 id 是普通的渠道专有 id，而**别名**把它指向
	// `constructor`。这时 `aliasOf` 走的是别名字符串（不是原型链），`canonical` 就是
	// 字面量 `"constructor"`——`in` 判据会在这里把它当成「有价格行」，`pricing["constructor"]`
	// 拿到 Object 构造函数，`costOf` 返回 0，于是**整行被静默算成免费**：
	//   `cost.total = 0`、`priced = true`、`unpriced = []`
	// 而正确行为是 `total = null`、`priced = false`、`unpriced = ["p/relay-hostile"]`。
	const aliasedRecords = [rec("2026-09-20", "p", "relay-hostile", 1000)];
	const aliased = { ...options, aliases: { "relay-hostile": "constructor" } };

	assert.deepEqual(
		buildPayload(aliasedRecords, aliased).cost,
		{ currency: "CNY", total: null, priced: false, unpriced: ["p/relay-hostile"] },
		"别名指向 `constructor` 时绝不能被算成 ¥0.00：`in` 会走原型链拿到 Object 构造函数，" +
			"costOf 返回 0，于是这一行被静默算成免费、且不进未定价清单（ADR-0001 明确禁止拿 0 冒充免费）",
	);
	const aliasedUnpriced = buildUnpricedPayload(aliasedRecords, aliased);
	assert.deepEqual(aliasedUnpriced.items.map((item) => item.id), ["p/relay-hostile"], "同一批 id 在 /unpriced 里也必须仍是未定价");
	assert.equal(aliasedUnpriced.items[0].cause, "no-price");
});

test("未定价载荷：items 的桶字段与 aggregate 同名同义，含 cacheHitRate", () => {
	const records = [
		{ day: "2026-09-20", provider: "relay-a", model: "brand-new-x", inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 20, reasoningTokens: 7, tokens: 477, requests: 3 },
	];
	const unpriced = buildUnpricedPayload(records, { range: resolveRange("all", null, null, NOW), pricing: {}, currency: "CNY", now: NOW });
	const [item] = unpriced.items;

	assert.equal(item.tokens, 477);
	assert.equal(item.requests, 3);
	assert.equal(item.inputTokens, 100);
	assert.equal(item.outputTokens, 50);
	assert.equal(item.cacheReadTokens, 300);
	assert.equal(item.cacheWriteTokens, 20);
	assert.equal(item.reasoningTokens, 7);
	assert.equal(item.cacheHitRate, 75, "缓存命中率 = 缓存读 / (未缓存输入 + 缓存读) = 300 / 400");
	assert.equal(item.provider, "relay-a");
	assert.equal(item.model, "brand-new-x", "model 是日志里的 id，不是官方 id、也不是复合 id");
});

test("未定价载荷：items 按 tokens 降序（与既有 UnpricedNotice 同口径），同 tokens 时排序确定", () => {
	// 规格 §10 第 1 条把「按调用次数降序」列为待裁决点并**冻结为 tokens**：面板上既有的
	// `UnpricedNotice` 就是按 tokens 降序，两处口径必须一致——同一个面板里「未定价」
	// 出现在两块地方而排序不同，用户会以为是两批数据。
	const records = [
		rec("2026-09-20", "p", "few-calls-huge-tokens", 10_000_000, 1),
		rec("2026-09-20", "p", "many-calls-small-tokens", 10, 50),
		rec("2026-09-20", "p", "middle", 100, 9),
		rec("2026-09-20", "p", "zzz-same-tokens", 100, 1),
	];
	const unpriced = buildUnpricedPayload(records, { range: resolveRange("all", null, null, NOW), pricing: {}, currency: "CNY", now: NOW });

	assert.deepEqual(
		unpriced.items.map((item) => item.model),
		["few-calls-huge-tokens", "middle", "zzz-same-tokens", "many-calls-small-tokens"],
		"按 **tokens 降序**（与既有 UnpricedNotice 同口径）；同 tokens 时按 requests 降序、再按 id 升序兜底，" +
			"让排序确定——否则它会随 aggregate 的 Map 插入序漂移，两次请求给出不同的行序",
	);
	// 反向对照：请求数最多的那一行**不在**最前——证明排序键真的是 tokens 而不是 requests。
	assert.notEqual(unpriced.items[0].model, "many-calls-small-tokens", "请求数最多的行不该排第一：排序键是 tokens");
});

test("未定价载荷：candidates 是合并后全部模型，可空性写死为 null（不是 0）", () => {
	const pricing = {
		"a-full": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, currency: "CNY", vendor: "V", modelName: "A", context: 1000 },
		"b-missing-cache": { input: 3, output: 4, currency: "CNY" },
		"c-unknown-context": { input: 5, output: 6, context: "unknown" },
	};
	const unpriced = buildUnpricedPayload([], { range: resolveRange("all", null, null, NOW), pricing, currency: "CNY", rates: {}, now: NOW, sources: { "a-full": "overrides" } });

	assert.deepEqual(unpriced.candidates.map((entry) => entry.id), ["a-full", "b-missing-cache", "c-unknown-context"], "按 id 升序");
	for (const entry of unpriced.candidates) {
		assert.ok(Object.hasOwn(pricing, entry.id), `候选 \`${entry.id}\` 必须是合并后 models 的自有键`);
	}
	const [full, missing, unknownCtx] = unpriced.candidates;
	assert.equal(full.cacheRead, 0.1);
	assert.equal(full.context, 1000);
	assert.equal(full.source, "overrides", "source 记该行最终来自哪一层");
	assert.equal(missing.cacheRead, null, "表里没写 cacheRead → null，**不是 0**：0 是「真的免费」，缺失是「不知道」");
	assert.equal(missing.cacheWrite, null);
	assert.equal(missing.vendor, null, "表里缺失 → null");
	assert.equal(missing.modelName, null);
	assert.equal(missing.context, null);
	assert.equal(unknownCtx.context, null, "context 是字面量 \"unknown\"（非有限数）→ null");
	assert.equal(missing.source, "file", "没记 source 时按主表（file）");
	assert.equal(missing.currency, "CNY", "条目没写 currency 时按显示币种（与 costOf 的口径同义）");
});

test("未定价载荷：candidates 带 aliasTarget，供面板说清「只做一跳」", () => {
	// `deepseek-flash` 既是模型行、又是别名键，且它的目标**不是它自己**——这正是
	// 运行时表里 23/27 条别名目标的情形。插件只做一跳，所以面板必须提示「不会跟随过去」。
	const pricing = { "deepseek-flash": { input: 2, output: 8 }, "glm-5.3": { input: 1, output: 3 } };
	const aliases = { "deepseek-flash": "glm-5.3" };
	const unpriced = buildUnpricedPayload([], { range: resolveRange("all", null, null, NOW), pricing, aliases, currency: "CNY", now: NOW });
	const byId = new Map(unpriced.candidates.map((entry) => [entry.id, entry]));

	assert.equal(byId.get("deepseek-flash").aliasTarget, "glm-5.3", "别名键指向别处时带出目标：面板必须提示「不会跟随过去」");
	assert.equal(byId.get("glm-5.3").aliasTarget, null, "不是别名键的候选报 null");

	const selfMapped = buildUnpricedPayload([], {
		range: resolveRange("all", null, null, NOW),
		pricing,
		aliases: { "deepseek-flash": "deepseek-flash" },
		currency: "CNY",
		now: NOW,
	});
	assert.equal(
		new Map(selfMapped.candidates.map((entry) => [entry.id, entry])).get("deepseek-flash").aliasTarget,
		null,
		"自映射（A → A）不算「跟随到别处」，报 null——否则确认框会对每一行都多一句无意义的提示",
	);
});

test("未定价载荷：每个 suggestions 都有非空 reason，且目标都是合并后 models 的自有键", () => {
	const pricing = { "deepseek-flash": { input: 2, output: 8 } };
	const records = [rec("2026-09-20", "relay-a", "relay-a/deepseek-flash", 100)];
	const unpriced = buildUnpricedPayload(records, { range: resolveRange("all", null, null, NOW), pricing, currency: "CNY", now: NOW });

	assert.equal(unpriced.items.length, 1, "前置条件：这个带前缀的 id 必须真的未定价");
	const [suggestion] = unpriced.items[0].suggestions;
	assert.ok(suggestion !== undefined, "带命名空间前缀的 id 应当有 R1 推荐");
	assert.equal(suggestion.model, "deepseek-flash");
	assert.equal(suggestion.score, 0.9);
	assert.ok(Object.hasOwn(pricing, suggestion.model), `建议 \`${suggestion.model}\` 必须是合并后 models 的自有键`);
	assert.ok(typeof suggestion.reason === "string" && suggestion.reason !== "", "每条推荐都必须带非空 reason（ADR-0008 验收 1）");
});

test("未定价载荷：overrides 段报告路径、存在性与可写性", () => {
	const unpriced = buildUnpricedPayload([], {
		range: resolveRange("all", null, null, NOW),
		pricing: {},
		currency: "CNY",
		now: NOW,
		overrides: { version: 3, exists: true, path: "/home/u/.dsh/usage-ledger-overrides.json", enabled: true },
	});

	assert.equal(unpriced.overrides.path, "/home/u/.dsh/usage-ledger-overrides.json", "面板必须能显示写入路径（写入范围可见）");
	assert.equal(unpriced.overrides.exists, true);
	assert.equal(unpriced.overrides.version, 3);
	assert.equal(unpriced.overrides.enabled, true);

	const disabled = buildUnpricedPayload([], { range: resolveRange("all", null, null, NOW), pricing: {}, currency: "CNY", now: NOW, overrides: { enabled: false } });
	assert.equal(disabled.overrides.enabled, false, "config.overridesFile: false 时 enabled 必须是 false");
	assert.equal(disabled.overrides.exists, false);
	assert.equal(disabled.overrides.version, null, "没读到版本时是 null，不是 0");
});

test("未定价载荷：没有未定价模型时 items 是空数组，而不是缺字段", () => {
	const records = [rec("2026-09-20", "p", "deepseek-flash", 100)];
	const unpriced = buildUnpricedPayload(records, { range: resolveRange("all", null, null, NOW), pricing: PRICING, currency: "CNY", rates: { USD: 7.3 }, now: NOW });

	assert.deepEqual(unpriced.items, [], "空数组是合法值（面板据此整块不渲染），不能省略这个键");
	assert.equal(Array.isArray(unpriced.candidates), true);
});

test("未定价载荷：range 真的按范围摊平，与主载荷在同一范围上一致", () => {
	const records = [rec("2026-09-20", "p", "brand-new-x", 100), rec("2026-08-01", "p", "brand-new-x", 900)];
	const inRange = { range: resolveRange("custom", "2026-09-01", "2026-09-30", NOW), pricing: {}, currency: "CNY", now: NOW };
	const unpriced = assertInvariant(records, inRange, "自定义范围");

	assert.equal(unpriced.items.length, 1);
	assert.equal(unpriced.items[0].tokens, 100, "范围外的记录不得计入——否则区块的数字与当前标签页对不上");

	const outOfRange = buildUnpricedPayload(records, { ...inRange, range: resolveRange("custom", "2026-01-01", "2026-01-31", NOW) });
	assert.deepEqual(outOfRange.items, [], "范围外没有记录时清单为空");
});
