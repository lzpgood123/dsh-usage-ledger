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
import { ACTIVITY_DAYS, BASE_PATH, RANGE_KINDS } from "../src/index.js";

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
