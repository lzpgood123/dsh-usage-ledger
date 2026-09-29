/**
 * 价格表读取 `loadPricingFile` 与两个路径解析函数的直接测试。
 *
 * issue #7：`costOf` 由 #5 单独处理，本文件收 `src/index.js` 里剩下的三个
 * `grep -rn <name> test/` **零命中**的导出。其中 `loadPricingFile` 是唯一有非平凡
 * 分支的，而且每个分支方向都是**静默降级**：坏了不报错，只是悄悄少算钱。
 *
 * ## 口径：读不到价格表是常态，绝不能拖垮面板
 *
 * `loadPricingFile` 的既定承诺在 README 里写得很直白：「文件缺失或损坏时按空表处理
 * ——价格是锦上添花，不能因为它读不到就让整个面板挂掉」。这条承诺下有三处容易
 * 被「顺手修正」掉、且修正后无人察觉的行为：
 *
 * 1. 拿不到路径（`undefined` / `""` / 非字符串）→ 空表 + **不 warn**。非字符串
 *    （数字/对象/数组/函数）真去读会立刻出错，而错误会被同一个 catch 吞掉并转成
 *    一次 warn——所以这一支的**判据是「不该 warn」**，不是「不会抛」；
 *    空串那半句则是**不可证伪**的（`readFile("")` 本身就是 ENOENT，与正常吞掉
 *    ENOENT 的结果完全一样）；
 * 2. 文件不存在（ENOENT）→ 空表，且**不 warn**。不存在是常态，把 ENOENT 也拿去
 *    warn 等于每次启动都刷一行日志；
 * 3. 损坏 / 结构不可用 → 空表 + warn。**返回空表**，不是抛错：读价格表失败只该
 *    少算钱，不该让整个 `/api/usage-ledger` 变 500。
 *
 * `loadPricingFile` 又是 `refreshPricing()` 里唯一读盘的地方，所以它的返回形状
 * （恒为 `{models, aliases, rates}` 三个键）也是契约：`apply()` 直接对三者做展开
 * 合并。这三条退化都固化成了 `scripts/mutation-check.mjs` 里的 `pricing-file-*`
 * 变异体，手工自证因此变成常驻护栏。
 *
 * ## 为什么用真实临时目录，而不是注入 readFile
 *
 * `src/index.js` 按名字导入 `readFile`，而 `node:fs/promises` 的模块命名空间是
 * **冻结**的——实测 `t.mock.method(await import("node:fs/promises"), "readFile", …)`
 * 会抛 `TypeError: Cannot redefine property: readFile`。所以这里用真实临时文件，
 * 非 ENOENT 的失败路径则用「拿目录当文件读」（`readFile` 目录抛 `EISDIR`）走真实
 * 错误分支，不靠打桩。
 *
 * 环境变量那几条（`$DSH_HOME` 回退）必须自己改写并**还原** `process.env`：
 * 它是进程级全局，泄漏出去会污染同进程的其它用例。
 *
 * @module usage-ledger/test/pricing-file
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadPricingFile, resolvePricingFile, resolveSessionsRoot } from "../src/index.js";

/** 空价格表：`loadPricingFile` 所有降级路径的返回形状。 */
const EMPTY = { models: {}, aliases: {}, rates: {} };

/**
 * 造一个临时目录。
 *
 * @param label - 目录名前缀，便于失败时辨认残留。
 * @returns 绝对路径。
 */
function tmpDir(label) {
	return mkdtemp(join(tmpdir(), `usage-ledger-${label}-`));
}

/**
 * 造一个记录调用的日志器。
 *
 * 只记 `warn`——本文件里 warn 的有无就是判据（ENOENT 静默、其余失败要 warn）。
 *
 * @returns `{warned, logger}`；`warned` 是每次调用实参列表的数组。
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
 * 用途是**补充**判据：证明实现没有把某个写死的路径当成入参去读。它不能单独当
 * 判据用——真去读它时抛出的错误会被 `loadPricingFile` 自己的 catch 吞掉，再转成
 * 一次 warn，函数照样返回空表（实测：把守卫放宽成 `file === undefined || file ===
 * null`，拿它当入参仍然得到空表）。所以那条用例真正的判据是 `warned` 必须为空，
 * 见 {@link explodingPath} 的调用点。
 *
 * @returns 哨兵对象。
 */
function explodingPath() {
	return new Proxy(
		{},
		{
			get(_target, key) {
				throw new Error(`loadPricingFile 碰了不该碰的路径属性 ${String(key)}：拿不到可用路径时不得去读某个路径。`);
			},
		},
	);
}

/**
 * 在本进程内临时改写一个环境变量，结束后一字不差地还原。
 *
 * `process.env` 是全局状态：`DSH_HOME` 泄漏给后续用例会让它们解析到别的目录，所以
 * 「原来有没有这个键」和「原来的值」都要还原——`undefined` 与 `""` 是两种不同的
 * 状态，删键与赋空串不能混为一谈。
 *
 * @param name - 变量名。
 * @param value - 临时值；`undefined` 表示删除该键。
 * @param run - 在改写生效期间执行的函数。
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

test("loadPricingFile：拿不到路径（undefined / null / \"\" / 非字符串）→ 空表且不 warn，不得去读任何路径", async () => {
	// 哨兵文件是「没读任何文件」的对照：给合法路径时它必须被真的读出来（见下）。
	const dir = await tmpDir("nopath");
	const sentinel = join(dir, "sentinel.json");
	await writeFile(sentinel, JSON.stringify({ models: { m: { input: 1 } } }), "utf8");

	const noPath = [
		[undefined, "undefined"],
		[null, "null"],
		["", "空串"],
		[0, "数字 0"],
		[false, "布尔 false"],
		[NaN, "NaN"],
		[[], "数组"],
		[{ toString: () => sentinel }, "带 toString 的对象"],
		[() => sentinel, "函数"],
		[Symbol("p"), "Symbol"],
	];

	try {
		for (const [file, label] of noPath) {
			const { warned, logger } = recordingLogger();
			const out = await loadPricingFile(file, logger);
			assert.deepEqual(out, EMPTY, `${label} 不是可用路径，必须返回空表；三个键都要在（apply() 直接展开这三个键）。`);
			// 这条才是这一支的**判据**：非字符串真去读会立刻抛错，而那个错会被同一个
			// catch 吞掉、转成一次 warn——所以「不该 warn」正是「没去读」的可观测形式。
			assert.deepEqual(warned, [], `${label} 不是「文件坏了」，拿不到路径不该打扰用户：什么都不用 warn。`);
		}

		// 补充判据：把哨兵当入参。真去读它同样只会转成一次 warn（错误被 catch 吞掉），
		// 所以它证明的是「实现没有拿哨兵去读某个路径」，单独不足以当判据。
		const { warned: sentinelWarned, logger: sentinelLogger } = recordingLogger();
		assert.deepEqual(await loadPricingFile(explodingPath(), sentinelLogger), EMPTY, "哨兵路径同样只能拿到空表。");
		assert.deepEqual(sentinelWarned, [], "哨兵路径不得被拿去读：读它会抛错，错误转成 warn 就说明实现了读了它。");

		// 反向对照：同一个文件、给一条合法路径，就必须读出内容来。否则上面的
		// 「空表」也可能只是因为实现根本没读任何文件。
		const ok = await loadPricingFile(sentinel, undefined);
		assert.deepEqual(ok.models, { m: { input: 1 } }, "合法路径下必须真的把价格表读出来。");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadPricingFile：文件不存在（ENOENT）→ 空表且不 warn——不存在是常态，不该刷日志", async () => {
	const dir = await tmpDir("enoent");
	const missing = join(dir, "does-not-exist.json");

	try {
		const { warned, logger } = recordingLogger();
		assert.deepEqual(await loadPricingFile(missing, logger), EMPTY, "文件不存在时返回空表，绝不抛错。");
		assert.deepEqual(
			warned,
			[],
			"ENOENT 不得 warn：没配价格表是最常见的正常情况，把它当异常刷日志等于每次启动都打扰用户。",
		);

		// 路径中段缺失同样是 ENOENT，同样静默。
		const { warned: deepWarned, logger: deepLogger } = recordingLogger();
		assert.deepEqual(await loadPricingFile(join(dir, "a", "b", "pricing.json"), deepLogger), EMPTY, "目录不存在时同样是空表。");
		assert.deepEqual(deepWarned, [], "目录不存在也是 ENOENT，同样不该 warn。");

		// 不给 logger 也不能抛：apply() 在 ctx 没有 logger 时传的就是 undefined。
		assert.deepEqual(await loadPricingFile(missing, undefined), EMPTY, "没有 logger 时照样静默返回空表。");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadPricingFile：内容不是合法 JSON → 空表 + warn（绝不抛错）", async () => {
	const dir = await tmpDir("badjson");
	const file = join(dir, "pricing.json");

	try {
		for (const [text, label] of [
			["{ not json", "截断的对象"],
			["", "空文件"],
			['{ "models": { "m": } }', "缺值的 JSON"],
			["[1, 2,", "断尾的数组"],
		]) {
			await writeFile(file, text, "utf8");
			const { warned, logger } = recordingLogger();
			assert.deepEqual(await loadPricingFile(file, logger), EMPTY, `内容是「${label}」时必须返回空表而不是抛错——价格读不到不该让整个面板 500。`);
			assert.equal(warned.length, 1, `内容是「${label}」时要 warn 一次，好让用户知道价格表没生效。`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadPricingFile：JSON 合法但不是可用价格表（null / 数组 / 数字 / 字符串 / 布尔）→ 空表 + warn", async () => {
	const dir = await tmpDir("notable");
	const file = join(dir, "pricing.json");

	try {
		for (const [text, label] of [
			["null", "null"],
			["[]", "空数组"],
			['[{"m":{"input":1}}]', "装着条目的数组"],
			["42", "数字"],
			['"models"', "字符串"],
			["true", "布尔"],
		]) {
			await writeFile(file, text, "utf8");
			const { warned, logger } = recordingLogger();
			// 数组尤其危险：`typeof [] === "object"`，少了 Array.isArray 这一条，
			// 数组会被当成价格表返回，之后按模型 id 查价时全部落空。
			assert.deepEqual(await loadPricingFile(file, logger), EMPTY, `顶层是 ${label} 时不是可用价格表，必须返回空表。`);
			assert.equal(warned.length, 1, `顶层是 ${label} 时要 warn：静默吞掉会让「价格表没生效」无从察觉。`);
			assert.match(String(warned[0][0] ?? ""), /pricing file/, "warn 文案要指明是价格表文件，否则用户不知道该去改哪个文件。");
		}

		// `models` 键存在但不是可用表，同样落进这条分支（`parsed?.models ?? parsed`
		// 的结果是数组/数字，而不是回退到顶层）。
		for (const bad of ["[]", "42", '"x"', "true"]) {
			await writeFile(file, `{"models": ${bad}, "deepseek-chat": {"input": 9}}`, "utf8");
			const { warned, logger } = recordingLogger();
			assert.deepEqual(await loadPricingFile(file, logger), EMPTY, `models 是 ${bad} 时不可用：不得把它当价格表，也不得因为顶层还有条目就放行。`);
			assert.equal(warned.length, 1, `models 是 ${bad} 时要 warn。`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadPricingFile：{models:…} 正常解析；无 models 键时把顶层当价格表（parsed?.models ?? parsed 回退）", async () => {
	const dir = await tmpDir("shape");
	const file = join(dir, "pricing.json");

	try {
		// 1. 标准形状：价格表在 models 下，aliases / rates 各归各位。
		await writeFile(
			file,
			JSON.stringify({
				models: { "deepseek-chat": { input: 2, output: 8 } },
				aliases: { "relay-flash-0731": "deepseek-chat" },
				rates: { USD: 7.3 },
			}),
			"utf8",
		);
		const { warned, logger } = recordingLogger();
		const shaped = await loadPricingFile(file, logger);
		assert.deepEqual(shaped.models, { "deepseek-chat": { input: 2, output: 8 } }, "models 下的条目原样返回。");
		assert.deepEqual(shaped.aliases, { "relay-flash-0731": "deepseek-chat" }, "aliases 原样返回。");
		assert.deepEqual(shaped.rates, { USD: 7.3 }, "rates 原样返回。");
		assert.deepEqual(warned, [], "正常解析不该有任何 warn。");

		// 2. 无 models 键：`parsed?.models` 是 undefined，`??` 落到顶层对象——
		//    顶层就是价格表（「直接写模型 id」的简写形式）。这条回退丢了，
		//    简写形式的文件会整个失效（金额一栏全变「—」而没有任何报错）。
		await writeFile(file, JSON.stringify({ "deepseek-chat": { input: 2 } }), "utf8");
		const bare = await loadPricingFile(file, undefined);
		assert.deepEqual(bare.models, { "deepseek-chat": { input: 2 } }, "没有 models 键时顶层对象本身就是价格表。");
		assert.deepEqual(bare.aliases, {}, "顶层简写里没有 aliases，降级为空对象。");
		assert.deepEqual(bare.rates, {}, "顶层简写里没有 rates，降级为空对象。");

		// 3. `models: null`：`??` 同样落到**整个 parsed 对象**，于是那个 `models: null`
		//    键自己也被当成一条模型条目带了出来。这是 `??` 的既定语义（null 与
		//    「没有这个键」在这里合流），不是缺陷——`null` 不是合法模型 id，
		//    `buildPayload` 按 id 查价时永远查不到它；这里把它钉住，免得将来有人
		//    「顺手」改成整表作废，让合法的顶层条目一起消失。
		await writeFile(file, JSON.stringify({ models: null, "deepseek-chat": { input: 3 } }), "utf8");
		const nullModels = await loadPricingFile(file, undefined);
		assert.deepEqual(
			nullModels.models,
			{ models: null, "deepseek-chat": { input: 3 } },
			"models 为 null 时回退到整个顶层对象：顶层条目照常可用，`models` 键本身也留在表里（null 不是合法模型 id，查价时自然落空）。",
		);
		assert.deepEqual(nullModels.models["deepseek-chat"], { input: 3 }, "回退之后顶层里的真实条目必须可用——整表作废是这条回退要避免的退化。");

		// 4. 空对象是**可用**价格表（`typeof {} === "object"`、非数组、非 null），
		//    不该被当成「没有表」而走 warn 分支。
		await writeFile(file, JSON.stringify({ models: {} }), "utf8");
		const { warned: emptyWarned, logger: emptyLogger } = recordingLogger();
		assert.deepEqual((await loadPricingFile(file, emptyLogger)).models, {}, "空对象是可用价格表，不是损坏。");
		assert.deepEqual(emptyWarned, [], "空价格表不该 warn：用户完全可以先放一个空表进来。");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadPricingFile：aliases / rates 各自独立降级为 {}，绝不影响 models", async () => {
	const dir = await tmpDir("aux");
	const file = join(dir, "pricing.json");
	const models = { "deepseek-chat": { input: 2 } };

	try {
		const badAux = [
			[null, "null"],
			["nope", "字符串"],
			[7, "数字"],
			[[], "数组"],
			[["a", "b"], "字符串数组"],
			[true, "布尔"],
		];

		for (const [aux, label] of badAux) {
			for (const key of ["aliases", "rates"]) {
				await writeFile(file, JSON.stringify({ models, [key]: aux }), "utf8");
				const { warned, logger } = recordingLogger();
				const out = await loadPricingFile(file, logger);
				// 关键不是「降级为空」，而是**只降级那一项**：若实现改成整表作废，
				// 价格会静默全部消失（金额一栏变「—」，而没有任何报错）。
				assert.deepEqual(out.models, models, `${key} 是 ${label} 时，models 必须原样保留——只降级这一项，不能把整张价格表作废。`);
				assert.deepEqual(out[key], {}, `${key} 是 ${label} 时该项降级为空对象。`);
				assert.deepEqual(warned, [], `${key} 是 ${label} 时不 warn：附属映射坏了不影响价格表本身可用。`);
			}
		}

		// 反向对照：合法的 aliases / rates 必须原样带出来，说明上面的空对象确实
		// 来自类型判据，而不是实现把这两项一律丢掉。
		await writeFile(file, JSON.stringify({ models, aliases: { "relay-x": "deepseek-chat" }, rates: { USD: 7.3 } }), "utf8");
		const ok = await loadPricingFile(file, undefined);
		assert.deepEqual(ok.models, models);
		assert.deepEqual(ok.aliases, { "relay-x": "deepseek-chat" }, "合法 aliases 原样返回。");
		assert.deepEqual(ok.rates, { USD: 7.3 }, "合法 rates 原样返回。");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadPricingFile：读取抛非 ENOENT 错误（如 EISDIR）→ 空表 + warn", async () => {
	const dir = await tmpDir("eisdir");

	try {
		// 拿目录当文件读：readFile 目录抛 EISDIR，走的是真实错误分支（不是打桩）。
		// 它既不是 ENOENT、也不是 JSON 解析失败，是「ENOENT 静默」的对照面。
		const { warned, logger } = recordingLogger();
		const out = await loadPricingFile(dir, logger);
		assert.deepEqual(out, EMPTY, "读不出来时返回空表，绝不把异常抛给调用方（onRequest 会因此整条路由 500）。");
		assert.equal(warned.length, 1, "非 ENOENT 的失败要 warn 一次——这与 ENOENT 静默是两条相反的判据。");
		assert.match(String(warned[0][0] ?? ""), /unreadable/, "warn 文案要说明是「读不了」，好与「结构不可用」区分。");

		// 没有 logger、或 logger 形状不全时，**ENOENT 路径**照样不能抛：apply()
		// 在没有 logger 的 ctx 上传的就是 undefined。
		assert.deepEqual(await loadPricingFile(join(dir, "missing.json"), undefined), EMPTY, "没有 logger 时文件不存在要静默返回空表。");
		assert.deepEqual(await loadPricingFile(join(dir, "missing.json"), {}), EMPTY, "logger 是空对象时不得抛错。");
		assert.deepEqual(await loadPricingFile(join(dir, "missing.json"), { warn: null }), EMPTY, "logger.warn 是 null 时不得抛错。");

		// 非 ENOENT 的失败会真的去调用 warn：调用点写的是 `logger?.warn?.()`
		// （可选链，不是 `typeof === "function"` 判据），所以只需挡住
		// undefined / null 这两种「没有」的形状。这两条就是那个边界的直接证据。
		assert.deepEqual(await loadPricingFile(dir, undefined), EMPTY, "非 ENOENT 失败、没有 logger 时同样静默返回空表。");
		assert.deepEqual(await loadPricingFile(dir, {}), EMPTY, "非 ENOENT 失败、logger 没有 warn 方法时不得抛错。");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loadPricingFile：返回形状恒为 {models, aliases, rates} 三个键", async () => {
	const dir = await tmpDir("shape-keys");
	const file = join(dir, "pricing.json");

	try {
		// apply() 直接 `{...inline, ...fromFile.models}` / `...fromFile.aliases` /
		// `...fromFile.rates`，三个键少一个就会把 undefined 展开进去。
		const cases = [
			[undefined, "拿不到路径"],
			[join(dir, "missing.json"), "文件不存在"],
			[dir, "读取失败"],
			[file, "损坏内容"],
		];

		for (const [target, label] of cases) {
			await writeFile(file, "{ broken", "utf8");
			const out = await loadPricingFile(target, undefined);
			assert.deepEqual(Object.keys(out).sort(), ["aliases", "models", "rates"], `${label} 时返回对象必须恰好含 models / aliases / rates 三个键。`);
			assert.deepEqual(out, EMPTY, `${label} 时三个键都必须是空对象。`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveSessionsRoot：配置优先，其次 $DSH_HOME/sessions，最后 ~/.dsh/sessions", async () => {
	// 1. 显式配置优先，且原样返回（不做绝对化、不拼 sessions）。
	assert.equal(resolveSessionsRoot({ sessionsRoot: "/tmp/custom-sessions" }), "/tmp/custom-sessions", "配置了 sessionsRoot 就用它。");
	assert.equal(resolveSessionsRoot({ sessionsRoot: "relative/sessions" }), "relative/sessions", "原样返回，不做绝对化。");
	// 空白串算「配置了」——实现只判空串，不 trim（路径里的空格是合法的）。
	assert.equal(resolveSessionsRoot({ sessionsRoot: " " }), " ", "只有空串才算没配，空白串是合法路径字面量。");

	// 2. sessionsRoot 为空串 / 非字符串 → 回退到 $DSH_HOME/sessions。
	for (const [value, label] of [
		["", "空串"],
		[undefined, "undefined"],
		[null, "null"],
		[42, "数字"],
		[{}, "对象"],
		[false, "布尔"],
	]) {
		const got = await withEnv("DSH_HOME", "/tmp/dsh-home", async () => resolveSessionsRoot({ sessionsRoot: value }));
		assert.equal(got, join("/tmp/dsh-home", "sessions"), `sessionsRoot 是 ${label} 时回退到 $DSH_HOME/sessions。`);
	}

	// 3. $DSH_HOME 为空串 / 未设置 → 回退到 ~/.dsh/sessions。
	for (const [value, label] of [
		["", "空串"],
		[undefined, "未设置"],
	]) {
		const got = await withEnv("DSH_HOME", value, async () => resolveSessionsRoot());
		assert.equal(got, join(homedir(), ".dsh", "sessions"), `$DSH_HOME 是 ${label} 时回退到 ~/.dsh/sessions。`);
	}

	// 4. 只看 sessionsRoot 与 $DSH_HOME，config 的其它字段不参与。
	const got = await withEnv("DSH_HOME", "/tmp/only-home", async () => resolveSessionsRoot({ pricingFile: "/tmp/x.json", currency: "USD" }));
	assert.equal(got, join("/tmp/only-home", "sessions"), "config 里其它字段不参与会话根目录解析。");
});

test("resolvePricingFile：显式路径优先，false 表示「显式不要价格表」，空串走默认路径", async () => {
	// 1. 显式路径原样返回。
	assert.equal(resolvePricingFile({ pricingFile: "/tmp/p.json" }), "/tmp/p.json", "配置了 pricingFile 就用它。");
	assert.equal(resolvePricingFile({ pricingFile: "relative.json" }), "relative.json", "原样返回，不做绝对化。");
	assert.equal(resolvePricingFile({ pricingFile: " " }), " ", "空白串是合法路径字面量，只把空串当作「没配」。");

	// 2. false = 显式关闭价格表，返回 undefined；与「没配」是两种结果。
	assert.equal(resolvePricingFile({ pricingFile: false }), undefined, "false 是「显式不要价格表」，返回 undefined。");
	assert.notEqual(
		resolvePricingFile({ pricingFile: false }),
		resolvePricingFile({}),
		"false 与「没配」必须区分：前者是用户明确关掉了价格表，后者要去默认路径找文件。",
	);

	// 3. 空串 / 非字符串 → 默认路径 $DSH_HOME/usage-ledger-pricing.json，与 settings.yaml 同级。
	for (const [value, label] of [
		["", "空串（**不**当 false 处理）"],
		[undefined, "undefined"],
		[null, "null"],
		[0, "数字 0"],
		[{}, "对象"],
		[[], "数组"],
	]) {
		const got = await withEnv("DSH_HOME", "/tmp/dsh-home", async () => resolvePricingFile({ pricingFile: value }));
		assert.equal(got, join("/tmp/dsh-home", "usage-ledger-pricing.json"), `pricingFile 是 ${label} 时走默认路径。`);
	}

	// 4. $DSH_HOME 缺失 / 为空串 → ~/.dsh/usage-ledger-pricing.json。
	for (const [value, label] of [
		["", "空串"],
		[undefined, "未设置"],
	]) {
		const got = await withEnv("DSH_HOME", value, async () => resolvePricingFile({}));
		assert.equal(got, join(homedir(), ".dsh", "usage-ledger-pricing.json"), `$DSH_HOME 是 ${label} 时回退到 ~/.dsh 下。`);
	}

	// 5. 两个解析函数共用同一份 $DSH_HOME 口径：默认路径必须落在同一棵树下。
	const [root, pricing] = await withEnv("DSH_HOME", "/tmp/shared-home", async () => [resolveSessionsRoot(), resolvePricingFile({})]);
	assert.equal(root, join("/tmp/shared-home", "sessions"), "会话根目录在 $DSH_HOME 下。");
	assert.equal(pricing, join("/tmp/shared-home", "usage-ledger-pricing.json"), "价格表默认路径与 settings.yaml 同级。");
});

test("resolveSessionsRoot / resolvePricingFile：不传 config 时走默认参数，不得抛错", () => {
	// `apply(ctx)` 不传 config（或调用方直接省略）时走的是默认参数 `config = {}`。
	// 注意这里**不测 null**：`resolveSessionsRoot(null)` 会抛 TypeError（读 null 的
	// 属性），那是实现的既定行为，不在本 issue 的范围内——补一条断言把它说成
	// 「不得抛错」会是假的。
	assert.equal(typeof resolveSessionsRoot(), "string", "不传 config 时必须有默认值，不能抛错。");
	assert.equal(typeof resolvePricingFile(), "string", "不传 config 时必须有默认值，不能抛错。");
});

test("resolveSessionsRoot / resolvePricingFile：$DSH_HOME 用完即还原，不泄漏给其它用例", async () => {
	// `process.env` 是进程级全局：这里显式验证 withEnv 的还原语义，否则「$DSH_HOME
	// 回退」那几条用例会互相污染，也会污染同进程的其它文件。
	const before = Object.prototype.hasOwnProperty.call(process.env, "DSH_HOME");
	const original = process.env.DSH_HOME;
	const originalRoot = resolveSessionsRoot();

	await withEnv("DSH_HOME", "/tmp/leak-check", async () => {
		assert.equal(resolveSessionsRoot(), join("/tmp/leak-check", "sessions"), "改写期间读到新值。");
	});

	assert.equal(
		Object.prototype.hasOwnProperty.call(process.env, "DSH_HOME"),
		before,
		"用完必须连「键是否存在」一起还原：删键与赋 undefined 在 process.env 里是不同状态。",
	);
	assert.equal(process.env.DSH_HOME, original, "$DSH_HOME 的值要一字不差地还原。");
	assert.equal(resolveSessionsRoot(), originalRoot, "还原后解析结果与改写前一致。");
});
