/**
 * 跨端契约测试：宿主端常量 ↔ 浏览器端字面量。
 *
 * ## 为什么必须用「读源码 + 正则」这种别扭的方式
 *
 * `src/client.js` 是传统 `<script src>` 加载的 `__ModuleLoader__` bundle：它不能写
 * 静态 `import`（不是 ESM），factory 的 `require` 也只认包名与平台 seed，**不认相对
 * 路径**（`require("./index.js")` 会直接抛错）。ADR-0004 又禁止引入构建步骤，所以
 * 「浏览器端的 API 前缀必须等于宿主端的 `BASE_PATH`」这条约束，在运行时是**没有任何
 * 机制保证的**。
 *
 * 于是这里换个方向：把 `src/client.js` 当**文本**读进来，用正则取出它写死的字面量，
 * 再与从 `src/index.js` 导入的导出常量比较。这样「两边必须一致」就从一句注释变成了
 * 一条会失败的断言。
 *
 * 盯住的都是**漂移后静默失败**的地方——面板 404 却不报错、热力图窗口悄悄变短、
 * 标签页少一个而宿主端仍在接受它。
 *
 * @module usage-ledger/test/contract
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ACTIVITY_DAYS, BASE_PATH, MAX_TEXT_LENGTH as HOST_MAX_TEXT_LENGTH, OVERRIDES_PATH, RANGE_KINDS, UNPRICED_CAUSE_KINDS, UNPRICED_FIELDS, UNPRICED_PATH } from "../src/index.js";

/** `src/client.js` 的绝对 URL（跨平台，不拼字符串路径）。 */
const CLIENT_URL = new URL("../src/client.js", import.meta.url);

/** 源码只读一次。 */
let cachedSource;

/**
 * 读取 `src/client.js` 的源码文本。
 *
 * @returns 源码字符串。
 */
async function clientSource() {
	if (cachedSource === undefined) cachedSource = await readFile(CLIENT_URL, "utf8");
	return cachedSource;
}

test("契约：浏览器端 API 前缀与宿主端 BASE_PATH 一致", async () => {
	const source = await clientSource();

	// 第一层：字面量确实出现在源码里（正则提取失败与「值为空」是两种不同的坏法）。
	assert.ok(
		source.includes(`"${BASE_PATH}"`),
		`src/client.js 源码里找不到字面量 "${BASE_PATH}"。宿主端接口前缀改了而浏览器端没跟上（或反之）时，` +
			`面板所有请求会 404，且浏览器控制台不会报任何错——这正是静默失败。`,
	);

	// 第二层：把它取出来逐字比较，失败信息直接说清后果。
	const match = source.match(/const\s+API\s*=\s*"([^"]*)"/);
	assert.ok(
		match !== null,
		"src/client.js 里找不到 `const API = \"...\"` 定义；契约测试的提取正则需要跟着改。",
	);
	assert.equal(
		match[1],
		BASE_PATH,
		`浏览器端 API = "${match[1]}"，宿主端 BASE_PATH = "${BASE_PATH}"：` +
			`改了一处漏了另一处 → 面板 404 且无报错。`,
	);
});

/**
 * 取出源码里每个 `fetch(...)` 调用的**第一个实参**文本。
 *
 * 只按括号深度找第一个实参的结束位置（`,` 或配对的 `)`），所以模板串里的
 * `${...}` 不会干扰——它内部的括号自成一对。这个提取器是刻意的文本级实现：
 * `src/client.js` 不是 ESM，没法 import 进来做行为断言（见文件头）。
 *
 * @param source - `src/client.js` 源码文本。
 * @returns 每个 fetch 第一个实参的源码片段。
 */
function fetchFirstArgs(source) {
	const args = [];
	const needle = "fetch(";
	let index = source.indexOf(needle);
	while (index !== -1) {
		// 不匹配 `prefetch(` / `.fetch(` 这类同后缀调用：前一个字符若是标识符
		// 字符，说明这个 `fetch` 是更长的名字的一部分，不是全局 fetch。
		if (index > 0 && /[A-Za-z0-9_$.]/.test(source[index - 1])) {
			index = source.indexOf(needle, index + needle.length);
			continue;
		}
		let depth = 0;
		let end = source.length;
		for (let cursor = index + needle.length - 1; cursor < source.length; cursor += 1) {
			const ch = source[cursor];
			if (ch === "(" || ch === "[" || ch === "{") depth += 1;
			else if (ch === ")" || ch === "]" || ch === "}") {
				depth -= 1;
				if (depth === 0) {
					end = cursor;
					break;
				}
			} else if (ch === "," && depth === 1) {
				end = cursor;
				break;
			}
		}
		args.push(source.slice(index + needle.length, end));
		index = source.indexOf(needle, index + needle.length);
	}
	return args;
}

test("契约：client.js 的 fetch 请求路径确实由 API 常量拼出（常量被使用，不只是存在）", async () => {
	const source = await clientSource();

	// 上面那条只证明 `const API = "..."` 存在且等于 BASE_PATH。**存在不等于被使用**：
	// 保留常量不动、只把真正的 fetch 路径改成别的字符串，面板照样 404，而
	// 「常量比对」型断言全绿。所以这里盯住使用点本身。
	const args = fetchFirstArgs(source);
	assert.ok(
		args.length > 0,
		"src/client.js 里找不到任何 `fetch(...)` 调用；契约测试的提取正则需要跟着改。",
	);

	for (const arg of args) {
		assert.ok(
			arg.includes("API"),
			`client.js 里有一个 fetch 的第一个实参是 \`${arg.trim()}\`，没有引用 API 常量：` +
				`请求路径被硬编码成别的字符串时，宿主端 BASE_PATH 改了这边不会跟着变，面板 404 且无报错。`,
		);
	}
});

test("契约：热力图 fallback 天数与宿主端 ACTIVITY_DAYS 一致", async () => {
	const source = await clientSource();

	// 取 `Number.isFinite(activityDays) ? activityDays : <fallback>` 里的 fallback。
	// 不硬编码 371：期望值来自宿主端导出，写死两次就等于没测。
	const match = source.match(/Number\.isFinite\(activityDays\)\s*\?\s*activityDays\s*:\s*(\d+)/);
	assert.ok(
		match !== null,
		"src/client.js 里找不到 `Number.isFinite(activityDays) ? activityDays : <天数>` 这段 fallback；" +
			"若实现已改写，契约测试的提取正则需要同步更新。",
	);

	assert.equal(
		Number(match[1]),
		ACTIVITY_DAYS,
		`浏览器端 fallback = ${match[1]} 天，宿主端 ACTIVITY_DAYS = ${ACTIVITY_DAYS}：` +
			`宿主端一旦漏发 activityDays，热力图会退回错误窗口（多出/少掉整周）而不报错。`,
	);
});

test("契约：宿主端 RANGE_KINDS 恰好是五个范围词", () => {
	// 这条把「范围词表」钉成规范本身：新增一种范围时，下面那条标签页断言会立刻变红。
	assert.deepEqual(
		RANGE_KINDS,
		["today", "week", "month", "all", "custom"],
		"RANGE_KINDS 是本插件范围口径的唯一真源，被改动就必须同步浏览器端 tabs 与宿主端解析。",
	);
});

test("契约：client.js 的 tabs 覆盖且只覆盖 RANGE_KINDS", async () => {
	const source = await clientSource();

	const block = source.match(/const\s+tabs\s*=\s*\[([\s\S]*?)\];/);
	assert.ok(block !== null, "src/client.js 里找不到 `const tabs = [ ... ];` 定义；契约测试的提取正则需要同步更新。");

	// tabs 的每一项形如 ["today", "今日"]，只取第一个元素（kind）。
	const kinds = [...block[1].matchAll(/\[\s*"([^"]+)"\s*,/g)].map((item) => item[1]);

	assert.equal(
		kinds.length,
		RANGE_KINDS.length,
		`client.js 的 tabs 有 ${kinds.length} 个范围 [${kinds.join(", ")}]，宿主端 RANGE_KINDS 有 ${RANGE_KINDS.length} 个 ` +
			`[${RANGE_KINDS.join(", ")}]：新增一种范围要改四处（RANGE_KINDS、resolveRange、tabs、解析），漏一处就是静默失效。`,
	);
	assert.equal(
		new Set(kinds).size,
		kinds.length,
		`client.js 的 tabs 里有重复 kind：[${kinds.join(", ")}]。`,
	);
	assert.deepEqual(
		[...kinds].sort(),
		[...RANGE_KINDS].sort(),
		`client.js 的 tabs 范围 [${[...kinds].sort().join(", ")}] 与宿主端 RANGE_KINDS ` +
			`[${[...RANGE_KINDS].sort().join(", ")}] 不一致：标签页点得到而宿主端不认（或反之），请求会静默失败。`,
	);
});

test("契约：client.js 引用了新增的两条接口路径，且仍是模板串形态", async () => {
	const source = await clientSource();

	// 客户端是传统 bundle，不能 import 宿主端常量（见文件头）。所以「两条新路径必须
	// 由 API 常量拼出来」只能靠字面量形态来钉：写死成 "/api/usage-ledger/unpriced"
	// 也能跑，但 BASE_PATH 一改这边不会跟着变——面板 404 且无报错。
	for (const [path, why] of [
		[UNPRICED_PATH, "未定价探测接口"],
		[OVERRIDES_PATH, "overrides 写入接口"],
	]) {
		const suffix = path.slice(BASE_PATH.length);
		assert.ok(
			source.includes("${API}" + suffix),
			`src/client.js 源码里找不到 \`\${API}${suffix}\`（${why}）：` +
				"两条新路径必须由 API 常量拼出，写死字符串会在 BASE_PATH 变更时静默 404。",
		);
	}

	// 上面那条只证明模板串存在。这里连同既有断言一起，保证**每个** fetch 首参都含 API。
	const args = fetchFirstArgs(source);
	for (const arg of args) {
		assert.ok(arg.includes("API"), `fetch 的第一个实参 \`${arg.trim()}\` 没有引用 API 常量`);
	}
});

test("契约：client.js 的 MAX_TEXT_LENGTH 与宿主端同值", async () => {
	const source = await clientSource();

	// `note` / `reason` 的长度上限两端各写一遍（客户端不能 import 宿主端），所以必须
	// 靠契约测试钉住。前端校验比服务端松 → 用户填了能点提交，然后吃一个 400；比服务端
	// 紧 → 一个本来合法的备注被静默拒绝。
	const match = source.match(/const\s+MAX_TEXT_LENGTH\s*=\s*(\d+)/);
	assert.ok(match !== null, "src/client.js 里找不到 `const MAX_TEXT_LENGTH = <数字>`；契约测试的提取正则需要同步更新。");
	assert.equal(
		Number(match[1]),
		HOST_MAX_TEXT_LENGTH,
		`浏览器端 MAX_TEXT_LENGTH = ${match[1]}，宿主端 = ${HOST_MAX_TEXT_LENGTH}：` +
			"两端判据不一致时，用户会要么白填一次、要么被静默拒绝一条合法备注。",
	);
});

test("契约：unpriced 载荷的字段名与 cause 枚举，两端逐字一致", async () => {
	const source = await clientSource();
	/**
	 * 剥掉注释，只留**代码**。
	 *
	 * 本文件里好几处注释**故意**写着字段名（解释「为什么必须叫这个名字」），若对着原始
	 * 文本搜 `.items`，注释自己就能把断言喂饱——**注释不是实现**。`test/appearance.test.js`
	 * 用的是同一手法，原因也相同。
	 *
	 * @param text - 源码文本。
	 * @returns 去掉块注释与行注释的文本。
	 */
	const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");

	// `/unpriced` 的响应是宿主端产、浏览器端按名读的。字段名两端**各写一份**（客户端
	// 不能 import 宿主端，见文件头），所以改名是**静默失败**：客户端读到 `undefined`，
	// 对应的那块内容直接不出现，控制台不报任何错。
	//
	// 判据用的是**限定访问 + 词边界**（`/\bunpriced\.items\b/`）。两点都是承重的：
	//
	// 1. **限定**——裸字段名会误命中无关对象上的同名字段。实测 `\.path\b` 同时命中
	//    `overrides.path`（要盯的）与 `result.payload?.path`（POST 响应的另一个字段），
	//    于是把 `overrides.path` 改名后断言照样全绿。
	// 2. **词边界**——纯 `includes("overrides.path")` 会命中 `overrides.pathRenamed`
	//    （改名的**结果**里仍含原名这个子串），于是「改名」这个最该被抓住的动作反而
	//    全绿。实测如此。`\b` 要求 `path` 后面不是标识符字符，才真的盯住了那一处。
	//
	// 每一条都写明「改名后哪一处提示会静默消失」——这正是失败信息该回答的问题。
	const accesses = [
		[`unpriced.${UNPRICED_FIELDS.items}`, "未定价清单整块不渲染（items 变成 undefined → []）"],
		[`unpriced.${UNPRICED_FIELDS.candidates}`, "「认领为已有模型」的搜索结果永远是空的"],
		[`unpriced.${UNPRICED_FIELDS.overrides}`, "写入路径与「写入已在配置里关闭」都不再显示"],
		[`overrides.${UNPRICED_FIELDS.overridesPath}`, "确认框里的「写入路径：…」那一行消失，且「写入已在配置里关闭」也不再出现"],
		[`overrides.${UNPRICED_FIELDS.overridesEnabled}`, "`overridesFile: false` 时仍会渲染出写不了的按钮"],
		[`candidate.${UNPRICED_FIELDS.aliasTarget}`, "「插件只做一跳解析…」那句提示消失（用户会以为认领会跟随到别名目标）"],
		[`row.${UNPRICED_FIELDS.cause}`, "`no-rate` 行的「缺汇率」标注消失（用户会以为补价格就能修好它）"],
	];

	const code = stripComments(source);
	for (const [access, consequence] of accesses) {
		const pattern = new RegExp(`\\b${access.replace(/\./g, "\\.")}\\b`);
		assert.ok(
			pattern.test(code),
			`src/client.js 的**代码**里找不到限定访问 \`${access}\`（宿主端导出常量说这个字段叫这个名字）：` +
				`${consequence}。改名不会报错，只会少一块内容——请把两端的名字改成一致。`,
		);
	}

	// `cause` 的两个取值同样是跨端枚举：宿主端产出、浏览器端按值分支。逐字比对。
	assert.deepEqual(UNPRICED_CAUSE_KINDS, ["no-price", "no-rate"], "cause 的取值集合是跨端契约的一部分");

	// 客户端**显式分支**的是 `no-rate`（只有它才标注「缺汇率」）；`no-price` 是默认路径，
	// 没有字面量可搜。所以这里分别对待，而不是硬搜两个字面量——后者会逼着实现写一句
	// 只为满足测试的 `=== "no-price"` 死代码。
	assert.ok(
		stripComments(source).includes('"no-rate"'),
		'src/client.js 的代码里找不到 cause 的取值字面量 `"no-rate"`：宿主端产出的枚举值与客户端分支不一致时，' +
			'那一支永远不成立，`no-rate` 行的「缺汇率」标注会**静默消失**——而那一行靠「认领成已有模型」是修不好的，' +
			"用户会被引到一条错误的路径上。",
	);
	// 反向核对：`no-rate` 必须**真的是分支条件**，而不是出现在别处的字符串（例如错误表里）。
	assert.ok(
		/===\s*"no-rate"/.test(stripComments(source)),
		'src/client.js 里 `"no-rate"` 不是比较的右操作数：它可能是注释、也可能只是某段文案里的巧合字符串，' +
			"那样 `cause` 的分支根本没接上，标注同样不会出现。",
	);
	// `no-price` 是默认分支，所以判据是「客户端**没有**把别的值也特殊对待」——若将来有人
	// 给 no-price 也加了分支，说明枚举语义变了，值得回来看一眼。
	assert.equal(
		(stripComments(source).match(/"no-price"/g) ?? []).length,
		0,
		'src/client.js 里出现了 `"no-price"` 字面量：它应当是默认路径（未定价区块对「没有价格行」不做额外标注）。' +
			"若确实需要为它分支，请同步更新这条断言与 UNPRICED_CAUSE_KINDS 的语义说明。",
	);
});
