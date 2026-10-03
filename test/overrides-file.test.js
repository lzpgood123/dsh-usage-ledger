/**
 * overrides 文件与三层合并的测试（ADR-0008 §1 / 规格 D3+D4）。
 *
 * ## 三条互不重叠的判据
 *
 * 1. **向后兼容**：主表现有的别名值**全是字符串**（仓库 20 条 / 运行时 27 条，实测）。
 *    规范化把它们统一成对象，但 `aliasOf = aliases[model] ?? model` 要的是字符串——
 *    合并结果因此必须是 `Record<string,string>`。任何一处漏了这一步，主表的别名会
 *    **整批失效**，而面板只是少算钱，不会报错。
 * 2. **容错口径**：读不到、没写过都静默返回空形状；损坏才 warn。判据是 `warned`
 *    必须为空/恰好一次，不是返回值形状——两种坏法的返回值完全一样。
 * 3. **合并顺序**：内联 < 主表 < overrides，后者赢。`sources` 记最终赢的那一层，
 *    面板靠它说清「这一行是你手工写的，还是仓库底表带的」。
 *
 * ## 为什么用真实临时目录
 *
 * 与 `test/pricing-file.test.js` 同样的理由：`node:fs/promises` 的命名空间是冻结的，
 * 没法打桩 `readFile`。非 ENOENT 的失败路径用「拿目录当文件读」（EISDIR）走真实错误分支。
 *
 * @module usage-ledger/test/overrides-file
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadOverridesFile,
	mergePricing,
	normalizeAliasMap,
	resolveOverridesFile,
	resolvePricingFile,
} from "../src/index.js";

/** 空 overrides 形状：所有降级路径的返回。 */
const EMPTY = { version: null, models: {}, aliases: {}, exists: false };

/**
 * 造一个临时目录。
 *
 * @param label - 目录名前缀。
 * @returns 绝对路径。
 */
function tmpDir(label) {
	return mkdtemp(join(tmpdir(), `usage-ledger-${label}-`));
}

/**
 * 造一个记录 `warn` 的日志器。
 *
 * @returns `{warned, logger}`。
 */
function recordingLogger() {
	const warned = [];
	return {
		warned,
		logger: {
			info() {},
			warn(...args) {
				warned.push(args);
			},
			error() {},
		},
	};
}

/**
 * 造一个「碰一下就抛」的路径哨兵。
 *
 * 用途是证明实现**没有**把某个路径当入参去读。它不能单独当判据：真去读它抛出的错误
 * 会被函数自己的 catch 吞掉再转成一次 warn。所以判据是 `warned` 为空。
 *
 * @returns 哨兵对象。
 */
function explodingPath() {
	return new Proxy(
		{},
		{
			get(_target, key) {
				throw new Error(`不得触碰路径属性 ${String(key)}`);
			},
		},
	);
}

/**
 * 在本进程内临时改写环境变量，结束后连「键是否存在」一起还原。
 *
 * @param name - 变量名。
 * @param value - 临时值；`undefined` 表示删键。
 * @param run - 生效期间执行的函数。
 * @returns `run` 的返回值。
 */
async function withEnv(name, value, run) {
	const present = Object.prototype.hasOwnProperty.call(process.env, name);
	const original = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return await run();
	} finally {
		if (present) process.env[name] = original;
		else delete process.env[name];
	}
}

test("resolveOverridesFile：显式路径优先、false 表示关闭写入、其余走 $DSH_HOME", async () => {
	assert.equal(resolveOverridesFile({ overridesFile: "/tmp/o.json" }), "/tmp/o.json", "配置了 overridesFile 就用它");
	assert.equal(resolveOverridesFile({ overridesFile: "relative.json" }), "relative.json", "原样返回，不做绝对化");
	assert.equal(resolveOverridesFile({ overridesFile: " " }), " ", "空白串是合法路径字面量，只把空串当作「没配」");
	assert.equal(resolveOverridesFile({ overridesFile: false }), undefined, "false 是「显式关闭写入」");
	assert.notEqual(resolveOverridesFile({ overridesFile: false }), resolveOverridesFile({}), "false 与「没配」必须是两种结果");

	for (const [value, label] of [
		["", "空串（**不**当 false 处理）"],
		[undefined, "undefined"],
		[null, "null"],
		[0, "数字 0"],
		[{}, "对象"],
		[[], "数组"],
	]) {
		const got = await withEnv("DSH_HOME", "/tmp/dsh-home", async () => resolveOverridesFile({ overridesFile: value }));
		assert.equal(got, join("/tmp/dsh-home", "usage-ledger-overrides.json"), `overridesFile 是 ${label} 时走默认路径`);
	}

	for (const [value, label] of [
		["", "空串"],
		[undefined, "未设置"],
	]) {
		const got = await withEnv("DSH_HOME", value, async () => resolveOverridesFile({}));
		assert.equal(got, join(homedir(), ".dsh", "usage-ledger-overrides.json"), `$DSH_HOME 是 ${label} 时回退到 ~/.dsh 下`);
	}

	// 两个解析函数共用同一份 $DSH_HOME 口径：默认路径必须落在同一棵树下。
	const [pricing, overrides] = await withEnv("DSH_HOME", "/tmp/shared-home", async () => [resolvePricingFile({}), resolveOverridesFile({})]);
	assert.equal(pricing, join("/tmp/shared-home", "usage-ledger-pricing.json"));
	assert.equal(overrides, join("/tmp/shared-home", "usage-ledger-overrides.json"));
});

test("loadOverridesFile：拿不到路径 → 空形状且不 warn，不得去读任何路径", async () => {
	for (const [file, label] of [
		[undefined, "undefined"],
		[null, "null"],
		["", "空串"],
		[0, "数字 0"],
		[[], "数组"],
		[{}, "对象"],
	]) {
		const { warned, logger } = recordingLogger();
		const out = await loadOverridesFile(file, logger);
		assert.deepEqual(out, EMPTY, `${label} 不是可用路径，必须返回空形状（四个键都要在）`);
		assert.deepEqual(warned, [], `${label} 不是「文件坏了」，拿不到路径不该打扰用户`);
	}

	const { warned, logger } = recordingLogger();
	assert.deepEqual(await loadOverridesFile(explodingPath(), logger), EMPTY, "哨兵路径同样只能拿到空形状");
	assert.deepEqual(warned, [], "哨兵路径不得被拿去读：读它会抛错，错误转成 warn 就说明实现读了它");
});

test("loadOverridesFile：文件不存在（ENOENT）→ 空形状且不 warn", async () => {
	const dir = await tmpDir("ov-enoent");
	try {
		const { warned, logger } = recordingLogger();
		assert.deepEqual(await loadOverridesFile(join(dir, "nope.json"), logger), EMPTY);
		assert.deepEqual(warned, [], "没写过 overrides 是最常见的正常情况，不该刷日志");
		assert.deepEqual(await loadOverridesFile(join(dir, "a", "b", "o.json"), undefined), EMPTY, "目录不存在同样是 ENOENT，同样静默");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadOverridesFile：非法 JSON / 顶层不是对象 → 空形状 + 恰好一次 warn", async () => {
	const dir = await tmpDir("ov-bad");
	const file = join(dir, "o.json");
	try {
		for (const [text, label] of [
			["{ not json", "截断的对象"],
			["", "空文件"],
			["null", "null"],
			["[]", "数组"],
			["42", "数字"],
			['"x"', "字符串"],
		]) {
			await writeFile(file, text, "utf8");
			const { warned, logger } = recordingLogger();
			const out = await loadOverridesFile(file, logger);
			assert.deepEqual(out, { version: null, models: {}, aliases: {}, exists: true }, `内容是「${label}」时返回空形状而不是抛错`);
			assert.equal(warned.length, 1, `内容是「${label}」时要 warn 一次`);
			assert.match(String(warned[0][0] ?? ""), /overrides file/, "warn 文案要指明是 overrides 文件");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadOverridesFile：models / aliases 各自独立降级，绝不影响另一段", async () => {
	const dir = await tmpDir("ov-aux");
	const file = join(dir, "o.json");
	const models = { "new-model": { input: 1, output: 2 } };
	const aliases = { "relay-a/new-model": "new-model" };
	try {
		for (const [aux, label] of [
			[null, "null"],
			["nope", "字符串"],
			[7, "数字"],
			[[], "数组"],
			[true, "布尔"],
		]) {
			// models 坏、aliases 好
			await writeFile(file, JSON.stringify({ version: 1, models: aux, aliases }), "utf8");
			const first = await loadOverridesFile(file, undefined);
			assert.deepEqual(first.models, {}, `models 是 ${label} 时降级为空对象`);
			assert.deepEqual(first.aliases, { "relay-a/new-model": { model: "new-model" } }, `models 是 ${label} 时 aliases 必须原样保留——只降级坏的那一段`);

			// aliases 坏、models 好
			await writeFile(file, JSON.stringify({ version: 1, models, aliases: aux }), "utf8");
			const second = await loadOverridesFile(file, undefined);
			assert.deepEqual(second.aliases, {}, `aliases 是 ${label} 时降级为空对象`);
			assert.deepEqual(second.models, models, `aliases 是 ${label} 时 models 必须原样保留——只降级坏的那一段`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadOverridesFile：版本策略——缺失当 1 不 warn；>1 尽力合并但 warn；非整数当 1 并 warn", async () => {
	const dir = await tmpDir("ov-version");
	const file = join(dir, "o.json");
	try {
		// 无 version：手写文件是常态，不 warn。
		await writeFile(file, JSON.stringify({ models: { m: { input: 1 } } }), "utf8");
		const missing = recordingLogger();
		const a = await loadOverridesFile(file, missing.logger);
		assert.equal(a.version, 1, "没有 version 键时当作 1");
		assert.deepEqual(missing.warned, [], "手写文件没有 version 是常态，不该 warn");
		assert.deepEqual(a.models, { m: { input: 1 } });

		// version 1：正常，无 warn。
		await writeFile(file, JSON.stringify({ version: 1, models: { m: { input: 1 } } }), "utf8");
		const one = recordingLogger();
		assert.equal((await loadOverridesFile(file, one.logger)).version, 1);
		assert.deepEqual(one.warned, []);

		// version 2：读的时候**尽力合并**（能用的数据不该被丢掉），但 warn 一次。
		await writeFile(file, JSON.stringify({ version: 2, models: { x: { input: 1 } } }), "utf8");
		const two = recordingLogger();
		const b = await loadOverridesFile(file, two.logger);
		assert.equal(b.version, 2, "version 原样带出来，供写入侧判「比插件新」");
		assert.deepEqual(b.models, { x: { input: 1 } }, "版本比插件新时仍要尽力合并，否则用户的数据会凭空消失");
		assert.equal(two.warned.length, 1, "unsupported-version 要 warn 一次");

		// 非整数 / < 1 / 非数字：当作 1 并 warn。
		for (const [value, label] of [
			[0, "0"],
			[-1, "负数"],
			[1.5, "小数"],
			["1", "字符串"],
			[null, "null"],
			[{}, "对象"],
		]) {
			await writeFile(file, JSON.stringify({ version: value, models: { m: { input: 1 } } }), "utf8");
			const bad = recordingLogger();
			const out = await loadOverridesFile(file, bad.logger);
			assert.equal(out.version, 1, `version 是 ${label} 时当作 1`);
			assert.equal(bad.warned.length, 1, `version 是 ${label} 时要 warn 一次`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadOverridesFile：overrides 没有 rates 段——出现即忽略 + 一次 warn", async () => {
	const dir = await tmpDir("ov-rates");
	const file = join(dir, "o.json");
	try {
		await writeFile(file, JSON.stringify({ version: 1, models: { m: { input: 1 } }, aliases: {}, rates: { USD: 7.3 } }), "utf8");
		const { warned, logger } = recordingLogger();
		const out = await loadOverridesFile(file, logger);
		assert.equal(Object.hasOwn(out, "rates"), false, "overrides 的解析结果**没有** rates 段");
		assert.deepEqual(out.models, { m: { input: 1 } }, "忽略 rates 不得影响 models");
		assert.equal(warned.length, 1, "出现 rates 段要 warn 一次（币种可用性由主表的 rates 决定）");
		assert.match(String(warned[0][0] ?? ""), /rates/, "warn 文案要提到 rates");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadOverridesFile：丢弃不可用别名项时只 warn 一次，且其余项保留", async () => {
	const dir = await tmpDir("ov-drop");
	const file = join(dir, "o.json");
	try {
		await writeFile(
			file,
			JSON.stringify({
				version: 1,
				models: {},
				aliases: { good: { model: "m" }, bad1: null, bad2: 42, bad3: {}, bad4: "", "bad\u0001": "m" },
			}),
			"utf8",
		);
		const { warned, logger } = recordingLogger();
		const out = await loadOverridesFile(file, logger);
		assert.deepEqual(Object.keys(out.aliases), ["good"], "只有可用的项留下");
		assert.equal(warned.length, 1, "整表丢弃 ≥1 项时记**一次** warn，不是每条一次");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("normalizeAliasMap：字符串/对象两形态统一成对象，坏项与原型保留名一律丢弃", () => {
	const out = normalizeAliasMap({
		a: "m1",
		b: { model: "m2", reason: "r", addedAt: "2026-01-01T00:00:00Z", origin: "panel", extra: "忽略" },
		c: null,
		d: {},
		e: "",
		f: 42,
		g: [],
		h: { model: "" },
		i: { model: 7 },
		"": "m3",
		"j\u0001": "m4",
		__proto__: { model: "m5" },
		constructor: "m6",
		prototype: "m7",
	});

	assert.deepEqual(out, { a: { model: "m1" }, b: { model: "m2", reason: "r", addedAt: "2026-01-01T00:00:00Z", origin: "panel" } });
	assert.deepEqual(Object.keys(out).sort(), ["a", "b"], "空键、控制字符键、原型保留名一律丢弃");
	assert.equal(Object.getPrototypeOf(out), Object.prototype, "结果对象仍是普通对象，原型没被替换");
});

test("normalizeAliasMap：非对象入参一律返回空表，不抛错", () => {
	for (const raw of [null, undefined, 42, "x", true, [], Symbol("s")]) {
		assert.deepEqual(normalizeAliasMap(raw), {}, `${String(raw)} 不是非数组对象，返回空表`);
	}
});

test("向后兼容：仓库底表 27 条字符串别名经规范化后逐条可用，且值都变成对象", async () => {
	const table = JSON.parse(await readFile(new URL("../usage-ledger-pricing.json", import.meta.url), "utf8"));
	const raw = table.aliases ?? {};
	const keys = Object.keys(raw);

	// 这个数字**故意写死**：底表变了就必须有人来复核这条兼容性断言的覆盖面。
	// 2026-10-03 由 20 改为 27——定价表扩容（76 → 147 模型）时新增了 7 条渠道专有别名
	// （DeepSeek-V4.1-Flash、Doubao-Seed-2.1-Pro、deepseek-v4.1-flash-sg、deepseek-chat 等），
	// 它们同样是**字符串**值，所以「旧格式继续可用」的覆盖面随之扩大，断言数量同步跟进。
	assert.equal(keys.length, 27, `仓库底表的别名条数变了（${keys.length}），这条兼容性断言的覆盖面要跟着复核`);
	assert.ok(
		keys.every((key) => typeof raw[key] === "string"),
		"仓库底表的别名值必须全是字符串——它正是「旧格式要继续能用」的样本",
	);

	const normalized = normalizeAliasMap(raw);
	assert.equal(Object.keys(normalized).length, keys.length, "27 条一条都不能少：规范化不得丢任何合法项");
	for (const key of keys) {
		assert.equal(typeof normalized[key].model, "string", `别名 \`${key}\` 必须解析出字符串 model`);
		assert.notEqual(normalized[key].model, "", `别名 \`${key}\` 的 model 不得为空`);
		assert.equal(normalized[key].model, raw[key], "字符串别名视为 `{model: <str>}`，目标一字不改");
	}
});

test("向后兼容：任意条数的字符串别名都继续可用（含 147 条这一档）", () => {
	// 验收里写的是「主表 **27 条**字符串格式别名继续可用」。2026-10-03 起仓库底表本身就是
	// 27 条（此前是 20 条，扩容时新增了 7 条），上面那条用例已用真数据覆盖它。
	//
	// 这里再按**条数**构造等价语料把范围扫宽：字符串别名这一支的兼容性不取决于条数，
	// 27 条与 147 条走的是同一条代码路径。这样即便底表将来再变，这一档仍然守着。
	for (const count of [1, 20, 27, 147]) {
		const raw = {};
		for (let index = 0; index < count; index += 1) raw[`relay-${index}/some-model`] = `target-model-${index}`;
		const normalized = normalizeAliasMap(raw);
		assert.equal(Object.keys(normalized).length, count, `${count} 条字符串别名一条都不能丢`);
		for (const [key, entry] of Object.entries(normalized)) {
			assert.deepEqual(entry, { model: raw[key] }, `${key} 必须解析成 {model: <原值>}，一字不改`);
		}
	}

	// 合并之后仍然必须是字符串值（`aliasOf = aliases[model] ?? model` 要的是字符串）。
	const raw = {};
	for (let index = 0; index < 27; index += 1) raw[`relay-${index}/m`] = "deepseek-flash";
	const merged = mergePricing({ inline: { models: { "deepseek-flash": { input: 2 } }, aliases: raw, rates: {} }, file: {}, overrides: {} });
	assert.equal(Object.keys(merged.aliases).length, 27, "27 条别名都要在合并结果里");
	for (const value of Object.values(merged.aliases)) {
		assert.equal(typeof value, "string", "合并后的别名值必须是字符串——对象值会让 aliasOf 把整个对象当成模型 id");
		assert.equal(value, "deepseek-flash");
	}
});

test("mergePricing：三层覆盖——后者赢，sources 记最终赢的那一层", () => {
	const merged = mergePricing({
		inline: { models: { m: { input: 1 }, onlyInline: { input: 9 } }, aliases: { a: "m1" }, rates: { USD: 7 } },
		file: { models: { m: { input: 2 } }, aliases: { a: "m2", b: "m3" }, rates: { USD: 7.3, CNY: 1 } },
		overrides: { models: { m: { input: 3 }, onlyOverrides: { input: 4 } }, aliases: { b: { model: "m4" } } },
	});

	assert.equal(merged.models.m.input, 3, "同名时 overrides 赢");
	assert.equal(merged.sources.m, "overrides", "sources 记最终赢的那一层");
	assert.equal(merged.sources.onlyInline, "inline", "只有内联有的条目记 inline");
	assert.equal(merged.sources.onlyOverrides, "overrides");
	assert.equal(merged.aliases.a, "m2", "主表覆盖内联");
	assert.equal(merged.aliases.b, "m4", "overrides 覆盖主表，且对象形态取 .model");
	assert.equal(typeof merged.aliases.b, "string", "合并后的 aliases 必须是字符串值——aliasOf 要的是字符串");
	assert.deepEqual(merged.rates, { USD: 7.3, CNY: 1 }, "rates 只来自内联与主表");
});

test("mergePricing：冲突日志只记 overrides 覆盖别人；内联被主表覆盖不记", () => {
	const merged = mergePricing({
		inline: { models: { m: { input: 1 } }, aliases: { a: "m1" } },
		file: { models: { m: { input: 2 } }, aliases: { a: "m2" } },
		overrides: { models: { m: { input: 3 } }, aliases: { a: { model: "m3" } } },
	});

	assert.deepEqual(
		merged.warnings,
		[
			{ code: "model-shadow", key: "m", layer: "overrides" },
			{ code: "alias-shadow", key: "a", layer: "overrides" },
		],
		"只记 overrides 的覆盖：内联被主表覆盖是既有行为（注释早已写明），为它刷日志会淹没真正的冲突",
	);

	const noOverrides = mergePricing({
		inline: { models: { m: { input: 1 } }, aliases: { a: "m1" } },
		file: { models: { m: { input: 2 } }, aliases: { a: "m2" } },
		overrides: {},
	});
	assert.deepEqual(noOverrides.warnings, [], "内联与主表冲突不产出任何 warning");
});

test("mergePricing：overrides 里出现 rates 段 → 忽略并记一条 rates-ignored", () => {
	const merged = mergePricing({
		inline: { models: {}, aliases: {}, rates: { USD: 7.3 } },
		file: { models: {}, aliases: {}, rates: { CNY: 1 } },
		overrides: { models: {}, aliases: {}, rates: { JPY: 0.05 } },
	});

	assert.deepEqual(merged.rates, { USD: 7.3, CNY: 1 }, "overrides 的 rates 不影响合并结果");
	assert.ok(
		merged.warnings.some((warning) => warning.code === "rates-ignored"),
		"出现 rates 段要有一条 rates-ignored 警告——静默忽略会让用户以为自己加的汇率生效了",
	);
});

test("mergePricing：字符串别名（旧格式）继续可用，对象别名（新格式）同时可用", () => {
	const merged = mergePricing({
		inline: { models: { t: { input: 1 } }, aliases: { "old-style": "t" }, rates: {} },
		file: { models: {}, aliases: { "file-old": "t" }, rates: {} },
		overrides: { models: {}, aliases: { "new-style": { model: "t", reason: "面板认领" } } },
	});

	assert.equal(merged.aliases["old-style"], "t", "内联的字符串别名继续可用");
	assert.equal(merged.aliases["file-old"], "t", "主表的字符串别名继续可用");
	assert.equal(merged.aliases["new-style"], "t", "overrides 的对象别名取 .model");
	for (const key of Object.keys(merged.aliases)) {
		assert.equal(typeof merged.aliases[key], "string", `合并结果里 \`${key}\` 必须是字符串值`);
	}
});

test("mergePricing：`__proto__` 键不会污染原型，也不会静默消失", () => {
	// 实测：`obj["__proto__"] = v` 在普通对象上被原型 setter 吞掉（键数仍为 0、原型被
	// 替换）。用 `{...table}` 展开一个含 `__proto__` 自有键的表同样会带上它——所以
	// 合并处必须用 defineProperty，且**不得**让原型被换掉。
	const parsed = JSON.parse('{"__proto__":{"input":1},"normal":{"input":2}}');
	const merged = mergePricing({ inline: { models: parsed, aliases: {}, rates: {} }, file: {}, overrides: {} });

	assert.equal(Object.getPrototypeOf(merged.models), Object.prototype, "合并结果的原型必须还是 Object.prototype");
	assert.ok(Object.hasOwn(merged.models, "normal"), "普通键必须正常合并");
	assert.deepEqual(merged.models.normal, { input: 2 });
});
