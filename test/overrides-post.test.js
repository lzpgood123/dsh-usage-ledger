/**
 * overrides 写入校验 `validateOverride` / `applyOverride` 的直接测试
 * （ADR-0008 §4 / 规格 D6）。
 *
 * ## 为什么校验必须是**纯函数**
 *
 * 「前端不可信」这句话只有在服务端真的独立判过一遍时才有意义。把校验写在 HTTP handler
 * 里，它就只能在「构造一个请求、发出去、看状态码」这一层被断言——而这类断言看不见
 * 边界：`"1.5"`（字符串价格）与 `1.5` 在 JSON 里长得几乎一样，`__proto__` 与普通键
 * 也一样。所以校验抽成纯函数，每条规则各一个用例，前端只管照着同一套判据给提示。
 *
 * ## 三条容易写错、且错了不会报错的规则
 *
 * 1. **V10 不做字符串强转**：`Number("1.5")` 是 1.5，于是「前端传了字符串」也能通过——
 *    代价是面板显示的 `"1.5"` 与写进文件的 `"1.5"` 之间没有任何保证（`"1.5abc"` 也过）。
 * 2. **V15 的硬规则只有「目标是合并后 models 的自有键」**：ADR 字面还要求「不能是另一个
 *    别名」，但实测运行时表 27 条别名里 23 条的目标同时是别名键，按字面实现会让
 *    `deepseek-flash` 这类最常用的目标全部不可写。见 ADR-0008 的勘误。
 * 3. **缺省的 cacheRead / cacheWrite / currency 不写这个键**：写 0 是「伪造免费」，
 *    写币种是「伪造一个用户没选的币种」。主表自己就有 11 个模型没写 cacheRead。
 *
 * @module usage-ledger/test/overrides-post
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyOverride,
	MAX_BODY_BYTES,
	MAX_ID_LENGTH,
	MAX_TEXT_LENGTH,
	OVERRIDES_VERSION,
	PROTOTYPE_KEYS,
	validateOverride,
} from "../src/index.js";

/** 一个典型的上下文：显示币种 CNY、rates 里有 USD。 */
const CONTEXT = {
	models: { "deepseek-flash": { input: 2, output: 8 }, "glm-5.3": { input: 1, output: 3 } },
	rates: { USD: 7.3, CNY: 1 },
	currency: "CNY",
	version: OVERRIDES_VERSION,
};

/**
 * 断言一条请求体被拒并给出指定错误码。
 *
 * @param body - 请求体。
 * @param detail - 期望的错误码。
 * @param context - 覆盖默认上下文。
 */
function assertRejected(body, detail, context = CONTEXT) {
	const result = validateOverride(body, context);
	assert.equal(result.ok, false, `${JSON.stringify(body)} 应当被拒`);
	assert.equal(result.detail, detail, `期望 detail = ${detail}，实得 ${result.detail}`);
}

test("校验常量：规格 §12 自定的数字与保留键", () => {
	assert.equal(OVERRIDES_VERSION, 1);
	assert.equal(MAX_BODY_BYTES, 65536);
	assert.equal(MAX_ID_LENGTH, 200);
	assert.equal(MAX_TEXT_LENGTH, 200);
	assert.deepEqual(PROTOTYPE_KEYS, ["__proto__", "constructor", "prototype"]);
});

test("校验 V5：顶层必须是能被 JSON.parse 成非数组对象的形状", () => {
	for (const body of [null, 42, "x", true, [], [1, 2], undefined]) {
		assertRejected(body, "invalid-body");
	}
});

test("校验 V6/V8：未列出的键、以及跨 op 的键都 400 unknown-field", () => {
	// 未列出的键（含一切路径字段——这就是防目录穿越的实现方式）。
	for (const key of ["path", "file", "overridesFile", "source", "origin", "addedAt", "rates", ""]) {
		assertRejected({ op: "setModel", model: "m", input: 1, output: 2, [key]: "x" }, "unknown-field");
	}
	// 跨 op 的键：setModel 不许出现 alias，setAlias 不许出现 input。
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, alias: "a" }, "unknown-field");
	assertRejected({ op: "setAlias", alias: "a", model: "deepseek-flash", input: 1 }, "unknown-field");
	assertRejected({ op: "remove", target: "model", id: "x", model: "m" }, "unknown-field");
});

test("校验 V7：op 只认三个值", () => {
	for (const op of ["setmodel", "SETMODEL", "upsert", "", null, 1, undefined]) {
		assertRejected({ op }, "unknown-op");
	}
});

test("校验 V9：id 合法性（空、超长、控制字符、原型保留名）", () => {
	for (const model of ["", "a".repeat(MAX_ID_LENGTH + 1), "a\u0000b", "a\nb", ...PROTOTYPE_KEYS]) {
		assertRejected({ op: "setModel", model, input: 1, output: 2 }, "invalid-id");
	}
	// 恰好等于上限是合法的（上限是「≤」不是「<」）。
	const atLimit = validateOverride({ op: "setModel", model: "a".repeat(MAX_ID_LENGTH), input: 1, output: 2 }, CONTEXT);
	assert.equal(atLimit.ok, true, `${MAX_ID_LENGTH} 个字符的 id 必须合法`);
	// 非字符串 id 也拒。
	assertRejected({ op: "setModel", model: 42, input: 1, output: 2 }, "invalid-id");
});

test("校验 V10/V11：价格必须是有穷且 ≥ 0 的**数字**，不做字符串强转", () => {
	assertRejected({ op: "setModel", model: "m", input: "1.5", output: 2 }, "invalid-price");
	assertRejected({ op: "setModel", model: "m", input: 1, output: "2" }, "invalid-price");
	for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, -0.0001, {}, [], true]) {
		assertRejected({ op: "setModel", model: "m", input: value, output: 2 }, "invalid-price");
		assertRejected({ op: "setModel", model: "m", input: 1, output: value }, "invalid-price");
	}
	// 0 是**合法**的：免费模型是真实存在的（仓库表里 `cacheWrite: 0` 就有）。
	assert.equal(validateOverride({ op: "setModel", model: "m", input: 0, output: 0 }, CONTEXT).ok, true, "0 是合法价格");
	// 可缺的可选项给了就必须满足同一判据。
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, cacheRead: -1 }, "invalid-price");
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, cacheWrite: "0.5" }, "invalid-price");
});

test("校验 V12/V13：币种必须在 rates 里（显示币种例外，与 costOf 口径一致）", () => {
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, currency: "" }, "invalid-currency");
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, currency: 42 }, "invalid-currency");
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, currency: "JPY" }, "unknown-currency");

	// USD 在 rates 里且是有限数 → 通过。
	assert.equal(validateOverride({ op: "setModel", model: "m", input: 1, output: 2, currency: "USD" }, CONTEXT).ok, true);
	// 省略币种 = 显示币种：**根本不查 rates**（与 costOf 的 `price.currency ?? currency` 同义）。
	assert.equal(validateOverride({ op: "setModel", model: "m", input: 1, output: 2 }, { ...CONTEXT, rates: {} }).ok, true, "省略币种时不查 rates");
	// 显式写出显示币种同理不查 rates。
	assert.equal(validateOverride({ op: "setModel", model: "m", input: 1, output: 2, currency: "CNY" }, { ...CONTEXT, rates: {} }).ok, true);
	// rates 里该币种不是有限数 → 同样拒绝（不猜汇率）。
	for (const rate of ["7.3", NaN, Infinity, null, {}]) {
		assertRejected({ op: "setModel", model: "m", input: 1, output: 2, currency: "USD" }, "unknown-currency", { ...CONTEXT, rates: { USD: rate } });
	}
});

test("校验 V14：note / reason 必须是字符串且 ≤ 200；reason 空串视为缺省", () => {
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, note: 42 }, "invalid-note");
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2, note: "x".repeat(MAX_TEXT_LENGTH + 1) }, "invalid-note");
	assert.equal(validateOverride({ op: "setModel", model: "m", input: 1, output: 2, note: "x".repeat(MAX_TEXT_LENGTH) }, CONTEXT).ok, true);

	assertRejected({ op: "setAlias", alias: "a", model: "deepseek-flash", reason: 42 }, "invalid-reason");
	assertRejected({ op: "setAlias", alias: "a", model: "deepseek-flash", reason: "x".repeat(MAX_TEXT_LENGTH + 1) }, "invalid-reason");
	assert.equal(validateOverride({ op: "setAlias", alias: "a", model: "deepseek-flash", reason: "" }, CONTEXT).ok, true, "空串 reason 视为缺省");
});

test("校验 V15：别名目标必须是合并后 models 的自有键，但**可以**同时是别名键", () => {
	// 目标不存在 → 拒绝（不能写出死别名）。
	assertRejected({ op: "setAlias", alias: "a", model: "no-such-model" }, "unknown-model");
	// 目标是别名键但**不是**模型行 → 同样拒绝：一跳解析会查 `pricing[目标]`，它没有价格行。
	assertRejected({ op: "setAlias", alias: "a", model: "some-alias-only" }, "unknown-model", {
		...CONTEXT,
		models: { "deepseek-flash": { input: 2 } },
		aliases: { "some-alias-only": "deepseek-flash" },
	});
	// 目标**同时**是模型行与别名键 → 通过。运行时表 27 条别名里 23 条如此；
	// 按 ADR 字面拒绝它们会让最常用的目标全部不可写。
	assert.equal(
		validateOverride({ op: "setAlias", alias: "a", model: "deepseek-flash" }, { ...CONTEXT, aliases: { "deepseek-flash": "glm-5.3" } }).ok,
		true,
		"目标同时是别名键时必须通过：一跳解析只看它自己的价格行",
	);
	// 目标是非字符串 → invalid-id（不是 unknown-model：形状问题先于存在性）。
	assertRejected({ op: "setAlias", alias: "a", model: 42 }, "invalid-id");
	assertRejected({ op: "setAlias", alias: "a", model: "" }, "invalid-id");
});

test("校验 V16：remove 的 target 只认 model / alias", () => {
	for (const target of ["models", "aliases", "", null, 1, undefined]) {
		assertRejected({ op: "remove", target, id: "x" }, "unknown-target");
	}
	for (const target of ["model", "alias"]) {
		assert.equal(validateOverride({ op: "remove", target, id: "x" }, CONTEXT).ok, true, `target: ${target} 必须合法`);
	}
});

test("校验 V17：目标文件 version > 1 时拒绝写入", () => {
	assertRejected({ op: "setModel", model: "m", input: 1, output: 2 }, "unsupported-version", { ...CONTEXT, version: 2 });
	assertRejected({ op: "remove", target: "model", id: "x" }, "unsupported-version", { ...CONTEXT, version: 99 });
	// 版本恰好等于插件版本、或没读到（null 已在调用点折成 1）时必须放行。
	assert.equal(validateOverride({ op: "remove", target: "model", id: "x" }, { ...CONTEXT, version: 1 }).ok, true);
});

test("校验：setModel 缺省的 cacheRead / cacheWrite / currency 不写这个键", () => {
	const full = validateOverride({ op: "setModel", model: "m", input: 1, output: 2 }, CONTEXT);
	assert.deepEqual(full.entry, { input: 1, output: 2, source: "manual" }, "缺省的三个键不得出现在落盘内容里（不伪造 0、不伪造币种）");

	const withCache = validateOverride({ op: "setModel", model: "m", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, currency: "USD", note: "n" }, CONTEXT);
	assert.deepEqual(withCache.entry, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, currency: "USD", note: "n", source: "manual" }, "显式给出的 0 必须写进去——0 是「真的免费」，与缺失不同");
	assert.equal(full.id, "m", "成功结果带 id，供 applyOverride 用");
});

test("校验：setAlias 的成功结果由服务端强制 addedAt / origin", () => {
	const result = validateOverride({ op: "setAlias", alias: "relay-x/flash", model: "deepseek-flash", reason: "同型号" }, CONTEXT);
	assert.equal(result.ok, true);
	assert.equal(result.id, "relay-x/flash");
	assert.equal(result.entry.model, "deepseek-flash");
	assert.equal(result.entry.reason, "同型号");
	assert.equal(result.entry.origin, "panel", "origin 由服务端强制（不接受客户端传入）");
	assert.match(result.entry.addedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/, "addedAt 由服务端强制，且格式固定");
	// 客户端传 origin / addedAt 一律被 unknown-field 挡住（上面 V6/V8 已覆盖，这里钉住语义）。
	assertRejected({ op: "setAlias", alias: "a", model: "deepseek-flash", origin: "manual" }, "unknown-field");
	assertRejected({ op: "setAlias", alias: "a", model: "deepseek-flash", addedAt: "2020-01-01T00:00:00Z" }, "unknown-field");
});

test("applyOverride：setModel / setAlias / remove 三个 op 的落盘内容", () => {
	const current = { models: { "deepseek-flash": { input: 2, output: 8 } }, aliases: { x: { model: "deepseek-flash" } } };

	const added = applyOverride(current, validateOverride({ op: "setModel", model: "b", input: 2, output: 3 }, CONTEXT));
	assert.equal(added.version, 1, "写回时 version 恒为 1");
	assert.deepEqual(added.models, { "deepseek-flash": { input: 2, output: 8 }, b: { input: 2, output: 3, source: "manual" } }, "setModel 只增不改");
	assert.deepEqual(added.aliases, { x: { model: "deepseek-flash" } }, "setModel 不得碰 aliases");

	const aliased = applyOverride(current, validateOverride({ op: "setAlias", alias: "y", model: "deepseek-flash" }, CONTEXT));
	assert.equal(aliased.aliases.y.model, "deepseek-flash");
	assert.deepEqual(aliased.models, { "deepseek-flash": { input: 2, output: 8 } }, "setAlias 不得碰 models");

	const removedModel = applyOverride(current, validateOverride({ op: "remove", target: "model", id: "deepseek-flash" }, CONTEXT));
	assert.deepEqual(removedModel.models, {}, "remove model 只删 overrides 里的那个键");
	assert.deepEqual(removedModel.aliases, { x: { model: "deepseek-flash" } }, "remove model 不得顺手删别名");

	const removedAlias = applyOverride(current, validateOverride({ op: "remove", target: "alias", id: "x" }, CONTEXT));
	assert.deepEqual(removedAlias.aliases, {});
	assert.deepEqual(removedAlias.models, { "deepseek-flash": { input: 2, output: 8 } });
});

test("applyOverride：删一个不存在的 id 是幂等的，且不改动其它键", () => {
	const current = { models: { a: { input: 1 } }, aliases: {} };
	const result = applyOverride(current, validateOverride({ op: "remove", target: "model", id: "nope" }, CONTEXT));
	assert.deepEqual(result, { version: 1, models: { a: { input: 1 } }, aliases: {} });
});

test("applyOverride：`__proto__` 当 id 写不进去（校验层已挡，这里钉住第二道防线）", () => {
	// 校验层把 `__proto__` 判成 invalid-id，所以这个 op 根本构造不出来。这里直接构造一个
	// 「校验结果」，验证 applyOverride 用的是 defineProperty——若改成 `target[key] = v`，
	// 那条目会被原型 setter 吞掉：键数为 0、原型被替换，而写入仍然返回 200。
	const result = applyOverride({ models: {}, aliases: {} }, { op: "setModel", id: "__proto__", entry: { input: 1 } });
	assert.equal(Object.getPrototypeOf(result.models), Object.prototype, "原型不得被替换");
	assert.ok(Object.hasOwn(result.models, "__proto__"), "键必须真的写进去（用 defineProperty），而不是被原型 setter 吞掉");
});
