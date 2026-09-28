#!/usr/bin/env node
/**
 * 变异检查：证明「测试真的在守行为」，而不是「碰巧全绿」。
 *
 * ## 这个脚本为什么存在
 *
 * 本仓库有过两次「测试全绿但缺陷仍在」的记录：
 *
 * 1. 把 `screenRequest` 的判据改成 `const ok = true`（无条件放行），整个测试套件
 *    依然全绿——因为 `grep -rn screenRequest test/` 当时零命中。局域网里的任何机器
 *    都能读到本机全部会话的用量画像。
 * 2. 删掉 `src/client.js` 里真正的 `tabIndex: -1`，`/tabIndex:\s*-1/` 会先命中上一行
 *    的**注释**，断言照样通过——守的是注释，不是实现。
 *
 * 变异检查就是把这类「断言测不到真问题」暴露出来的手段：故意把源码改坏（变异），
 * 如果测试**没有**变红，说明这条行为根本没人守。本脚本把散落在 `/tmp` 里的一次性
 * 检查落成一条可复现的命令，不依赖会话记忆，也不依赖 `/tmp` 残留。
 *
 * ## 三种结果
 *
 * - `KILLED`：变异后测试失败。变异体被杀死，说明这条行为真的有测试在守。
 * - `SURVIVED`：变异后测试**依然全绿**。这是缺陷，说明存在无人看守的行为，
 *   脚本以非 0 退出，由人来决定「补测试」还是「记为已知缺口」。
 * - `INVALID`：变异体本身是坏的（语法错误）。**绝不能**把它当成 KILLED——那会
 *   制造虚假安全感：测试失败的原因可能是整批文件都 `SyntaxError`，而不是断言生效。
 *
 * ## 零依赖、零构建（ADR-0004）
 *
 * 只用 `node:` 内置模块。刻意不引入 stryker 之类的变异测试框架：本仓库没有构建
 * 步骤，也不该为一个辅助脚本背上依赖树。
 *
 * ## 不污染工作区
 *
 * 变异发生在 `mkdtemp` 出来的临时副本里（复制仓库时排除 `.git`），工作区始终只读。
 *
 * ## 为什么显式排除 `test/viewport.test.js`
 *
 * 那个文件要驱动真实 Chrome，在拿不到浏览器的机器上只能 `skip`。
 *
 * 实测（Node 24.19.0）：`skip` **不会**让 `node --test` 非 0 退出——2 条用例里
 * 1 条 `skip` 时退出码仍是 `0`，`# skipped 1` 与 `# fail 0` 并列。所以 `skip`
 * 不会被算成「测试失败」，也就不会把变异体误判成 KILLED。
 *
 * 危险恰好相反：变异体本该让测试变红，若守它的用例被 `skip` 掉，整批测试依然全绿，
 * 这个变异体就被判成 **SURVIVED**——脚本报「这条行为无人看守」，而事实是用例**根本
 * 没运行**。那是假警报，会把人引向「补一条其实已经存在的测试」。
 * （实测复现：摘掉下面的守卫、再把宿主主题包弄丢，`panel-shadow-none` 与
 * `root-color-unknown-token` 两个变异体就会从 KILLED 变成 SURVIVED。）
 *
 * 所以这里用**显式文件列表**排除它，并在基线阶段与每个变异体阶段都断言
 * `skipped === 0`——有任何 skip 就报错退出，绝不猜。
 *
 * 注意：给 `node --test` 传「测试通配符 + 否定通配符」在 Node 24 上**静默无效**
 * （否定 glob 不被支持，viewport 照跑）。所以这里在 JS 里直接算出文件数组，
 * 不依赖 shell 也不依赖 glob 否定。
 *
 * @module usage-ledger/scripts/mutation-check
 */

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录（本脚本位于 `<root>/scripts/`）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 不参与变异检查的测试文件。
 *
 * `test/viewport.test.js` 依赖真实 Chrome：缺浏览器时它只能 `skip`。skip 不会让
 * `node --test` 非 0 退出（实测 Node 24.19.0 下退出码为 0），但被 skip 掉的用例
 * **没有运行**——变异体于是会以「全绿」通过，被判成 SURVIVED（假警报）。它有自己的
 * CI job，在那里 Chrome 缺失才算失败。理由见文件头注释。
 */
const EXCLUDED_TESTS = new Set(["viewport.test.js"]);

/**
 * 变异体清单。
 *
 * 每一项都必须声明 `killer`——「期望被哪条测试杀死」。没有期望杀手的变异体无法
 * 判定 SURVIVED 是不是缺陷，所以这个字段是必填的，不是文档性注释。
 *
 * 字段：
 * - `id`：稳定标识，报告与 CI 日志里用它指代变异体。
 * - `file`：被变异的源文件（仓库相对路径）。
 * - `what`：变异内容的一句话描述。
 * - `killer`：期望杀死它的测试文件与用例名（用于报告与失败时的人工核对）。
 * - `from`：锚点文本，必须在源码里**唯一**出现，且必须是**代码**而非注释。
 * - `to`：替换文本。客户端 CSS 在模板字符串里，所以这里禁止反引号与 `${`
 *   （见 {@link assertTemplateSafe}）。
 *
 * @type {Array<{id: string, file: string, what: string, killer: string, from: string, to: string}>}
 */
const MUTANTS = [
	{
		id: "scan-stamp-drop-size",
		file: "src/scan.js",
		what: "缓存键去掉 size，只留 mtimeMs",
		killer: "test/scan.test.js「同一 mtime 但 size 变大时必须重新解析，不得返回陈旧字节」",
		from: "const stamp = `${info.mtimeMs}:${info.size}`;",
		to: "const stamp = `${info.mtimeMs}`;",
	},
	{
		id: "scan-no-evict",
		file: "src/scan.js",
		what: "删掉缓存淘汰行，消失的文件永远留在 cache 里",
		killer: "test/scan.test.js「文件消失后以相同 mtime 与 size 恢复时，必须重新解析而非命中已删除的条目」",
		from: "\t\tfor (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);\n",
		to: "",
	},
	{
		id: "screen-request-allow-all",
		file: "src/index.js",
		what: "screenRequest 判据改成 true（无条件放行，局域网可读本机画像）",
		killer: "test/screen-request.test.js「回环闸门：局域网地址 192.168.1.9 被拒」等 6 条",
		from: '\tconst ok = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";\n',
		to: "\tconst ok = true;\n",
	},
	{
		id: "level-scale-linear",
		file: "src/client.js",
		what: "makeLevelScale 的分位切点换回线性阈值（峰值比例 0.1/0.33/0.66）",
		killer: "test/client.test.js「Heatmap 按活跃日分位数分档：单日峰值不得把其余活跃日压平（线性分档的回归护栏）」",
		from: "\t\t\tconst cuts = active.length === 0 ? [] : [quantile(active, 0.25), quantile(active, 0.5), quantile(active, 0.75)];\n",
		to: "\t\t\tconst cuts = active.length === 0 ? [] : [0.1 * max, 0.33 * max, 0.66 * max];\n",
	},
	{
		id: "sort-rows-null-branches",
		file: "src/client.js",
		what: "sortRows 删掉三个 null 分支，缺失值参与数值比较",
		killer: "test/client.test.js「未定价行在 cost 列两个方向上都恒排最后，且不与有效的 cost:0 混同」",
		from: "\t\t\t\tif (left === null && right === null) return 0;\n\t\t\t\tif (left === null) return 1;\n\t\t\t\tif (right === null) return -1;\n",
		to: "",
	},
	{
		id: "value-of-null-as-zero",
		file: "src/client.js",
		what: "valueOf 把非数值当成 0（null 缺失与有效 0 纠缠）",
		killer: "test/client.test.js「未定价行在 cost 列两个方向上都恒排最后，且不与有效的 cost:0 混同」",
		from: '\t\t\treturn typeof value === "number" && Number.isFinite(value) ? value : null;\n',
		to: '\t\t\treturn typeof value === "number" && Number.isFinite(value) ? value : 0;\n',
	},
	{
		id: "panel-shadow-none",
		file: "src/client.js",
		what: "box-shadow 改成 none，面板失去宿主 elevation 浮层语义",
		killer: "test/appearance.test.js「面板真的声明了宿主 elevation 阴影（token 存在性断言看不见「被删掉的使用」）」",
		from: "box-shadow:var(--dsw-elevation-panel)",
		to: "box-shadow:none",
	},
	{
		id: "root-color-unknown-token",
		file: "src/client.js",
		what: "正文色换回宿主不存在的 --dsw-alias-text-primary（静默走 fallback）",
		killer: "test/appearance.test.js「client.js 引用的每个 --dsw-alias-* token 都真实存在于宿主主题包」",
		from: ".ul-root{--ul-radius:10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary,currentColor)}",
		to: ".ul-root{--ul-radius:10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-text-primary,currentColor)}",
	},
	{
		id: "muted-opacity-again",
		file: "src/client.js",
		what: "次要文字改回 opacity 调暗（历史上 2.53:1–4.18:1 的那批）",
		killer: "test/appearance.test.js「次要文字不得用 opacity 调暗（显式清单，失败时指出退化选择器）」",
		from: ".ul-muted{color:var(--dsw-alias-label-secondary,currentColor)}",
		to: ".ul-muted{color:inherit;opacity:.6}",
	},
	{
		id: "panel-tabindex-removed",
		file: "src/client.js",
		what: "删掉真正的 tabIndex: -1（上一行注释仍写着 tabIndex:-1）",
		killer: "test/appearance.test.js「焦点进得来也回得去」里的 `/tabIndex:\\s*-1/.test(code)`（已剥注释）",
		from: "\t\t\t\t\t\ttabIndex: -1,\n",
		to: "",
	},
	{
		id: "backdrop-aria-hidden-false",
		file: "src/client.js",
		what: '遮罩的 aria-hidden 改成 "false"，读屏会读到一块无意义的空区域',
		killer: "test/client.test.js「遮罩对辅助技术隐藏、点击可关闭，且不是唯一出口（× 与 Esc 都在）」",
		from: '"aria-hidden": "true", onClick: onClose }',
		to: '"aria-hidden": "false", onClick: onClose }',
	},
];

/**
 * 剥掉源码里的注释，只留**代码**。
 *
 * 与 `test/appearance.test.js` 的 `stripComments` 同一手法，目的也相同：
 * `src/client.js` 里真实存在一句 `// tabIndex:-1 让容器可被程序化聚焦` 的注释，
 * 而实现 `tabIndex: -1,` 在下一行。锚点若只按原始文本核对唯一性，`tabIndex` 那条
 * 变异体会锚定注释——删掉注释而不是实现，测试照样绿，却报出一个假的 KILLED。
 *
 * 只处理本仓库实际存在的两种注释形态：块注释与行首行注释。
 *
 * @param source - 源码文本。
 * @returns 去掉注释的代码文本。
 */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");
}

/**
 * 统计 `needle` 在 `haystack` 里出现的次数。
 *
 * @param haystack - 被搜索的文本。
 * @param needle - 待统计的子串（非空）。
 * @returns 出现次数。
 */
function countOf(haystack, needle) {
	return haystack.split(needle).length - 1;
}

/**
 * 锚点防御：锚点必须在**代码**里唯一出现，且替换不得破坏模板字符串。
 *
 * 三道检查，任一不过就抛错（脚本随即失败，不产出任何结果）：
 *
 * 1. 锚点在原始文本里恰好出现 1 次——出现 0 次说明源码漂移，出现多次说明
 *    `String.replace` 会改错地方。
 * 2. 锚点在**剥注释后**的代码里也恰好出现 1 次——挡住「锚定注释」这个历史陷阱。
 * 3. `src/client.js` 的替换文本不得含反引号或 `${`——CSS 活在 JS 模板字符串里，
 *    写进去会提前终止模板字符串，让整批测试 `SyntaxError`（见文件头）。
 *
 * 第 2 条对 `src/client.js` 还有一层额外保护：变异前后反引号与 `${` 的出现次数
 * 必须一致，否则说明替换越过了模板字符串边界。
 *
 * @param mutant - 变异体。
 * @param source - 原始源码文本。
 * @throws {Error} 锚点缺失/不唯一，或替换文本不安全时。
 */
function assertAnchorSafe(mutant, source) {
	const { id, file, from, to } = mutant;

	const rawHits = countOf(source, from);
	if (rawHits !== 1) {
		throw new Error(`[${id}] 锚点在 ${file} 原始文本里出现 ${rawHits} 次（必须恰好 1 次）：${JSON.stringify(from.slice(0, 80))}`);
	}
	const codeHits = countOf(stripComments(source), from);
	if (codeHits !== 1) {
		throw new Error(
			`[${id}] 锚点在 ${file} 的**代码**（已剥注释）里出现 ${codeHits} 次（必须恰好 1 次）：` +
				`${JSON.stringify(from.slice(0, 80))}。锚点很可能锚到了注释——那会守注释而不是守行为。`,
		);
	}
	// 反引号与 `${` 只在 `src/client.js` 被绝对禁止：那里的 CSS 整段活在模板字符串里，
	// 替换文本里多一个反引号就会提前终止它，整批测试 SyntaxError。其余文件（例如
	// `src/scan.js` 的缓存键）本身就在模板字符串**内部**做变异，`${}` 是变异的目的，
	// 不能一刀切禁掉——那里由 `node --check` 与 {@link assertTemplateSafe} 兜底。
	if (file === "src/client.js") {
		if (to.includes("`")) {
			throw new Error(`[${id}] 替换文本含反引号：${file} 的 CSS 在模板字符串里，写进去会提前终止它并让整批测试 SyntaxError。`);
		}
		if (to.includes("${")) {
			throw new Error(`[${id}] 替换文本含 \${：会破坏 ${file} 的 CSS 模板字符串。`);
		}
	}
}

/**
 * 断言变异没有越过模板字符串边界（只对 `src/client.js` 生效）。
 *
 * `src/client.js` 的整段 CSS 活在一个模板字符串里，而模板字符串**可以跨行**：
 * 一旦替换文本让反引号或 `${` 的配对错位，损坏会扩散到整个文件，测试只会报
 * `SyntaxError`——那是 INVALID，不是 KILLED。所以在写文件前先在这里挡一道。
 *
 * 其余文件不做这项检查：`src/scan.js` 的缓存键变异（`${info.mtimeMs}:${info.size}`
 * → `${info.mtimeMs}`）**本来就要**动 `${`，一刀切会误杀合法变异体。那些文件由
 * `node --check` 兜底。
 *
 * @param mutant - 变异体。
 * @param before - 变异前源码。
 * @param after - 变异后源码。
 * @throws {Error} 反引号或 `${` 的出现次数发生变化时。
 */
function assertTemplateSafe(mutant, before, after) {
	if (mutant.file !== "src/client.js") return;
	const beforeTicks = countOf(before, "`");
	const afterTicks = countOf(after, "`");
	if (beforeTicks !== afterTicks) {
		throw new Error(`[${mutant.id}] 变异改变了反引号数量（${beforeTicks} → ${afterTicks}）：模板字符串边界被破坏。`);
	}
	const beforeInterp = countOf(before, "${");
	const afterInterp = countOf(after, "${");
	if (beforeInterp !== afterInterp) {
		throw new Error(`[${mutant.id}] 变异改变了 \${ 数量（${beforeInterp} → ${afterInterp}）：模板字符串插值被破坏。`);
	}
}

/**
 * 计算参与检查的测试文件列表（仓库相对路径，已排除浏览器用例）。
 *
 * 显式算出数组再交给 `node --test`：`!glob` 否定在 Node 24 上被静默忽略，
 * 用 shell 拼接则要依赖 `ls`/`grep` 的可用性，两者都不够硬。
 *
 * @param repoDir - 仓库（或副本）根目录。
 * @returns 形如 `["test/a.test.js", ...]` 的相对路径数组。
 */
async function testFiles(repoDir) {
	const names = await readdir(join(repoDir, "test"));
	const files = names.filter((name) => name.endsWith(".test.js") && !EXCLUDED_TESTS.has(name)).sort();
	if (files.length === 0) throw new Error("test/ 下没有找到任何测试文件：测试列表算错了，后续结论都不可信。");
	return files.map((name) => join("test", name));
}

/**
 * 解析 TAP 汇总与失败用例名。
 *
 * @param output - `node --test --test-reporter=tap` 的 stdout。
 * @returns `{tests, pass, fail, skipped, skips, failedNames}`。
 */
function parseTap(output) {
	const summary = (key) => {
		const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
		return matches.length === 0 ? null : Number(matches[matches.length - 1][1]);
	};
	const failedNames = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
	// 汇总行的 `# skipped` **只数被 `t.skip()` 的用例**。被 `describe.skip()` 整体跳过的
	// **套件**不进去：它只让 `# tests` 变少、`# suites` 变多，`# skipped` 仍是 0。
	// 所以额外数一遍 TAP 结果行上的 `# SKIP` 指令——用例级与套件级的跳过都会留下它。
	// 只认 `ok/not ok N - 名称 ... # SKIP` 这种结果行（允许前导缩进，嵌套套件会有），
	// 不去全文搜 `# SKIP`：那会被失败日志里的同样字样误伤。
	//
	// 光锚定结果行还不够——**用例名本身**就可能写着 `# SKIP`。好在 Node 的 TAP 会把
	// 用例名里的 `#` 转义成 `\#`（实测 Node 24.19.0：`test("… # SKIP …")` 输出
	// `ok 1 - … \# SKIP …`），所以用负向后顾 `(?<!\\)` 排除被转义的井号，就只会数到
	// TAP 自己追加的、真正的 `# SKIP` 指令（前面是空格而非反斜杠）。
	//
	// 实测（Node 24.19.0）：整个文件包进 `describe.skip` → `# tests 0 / # skipped 0`；
	// 7 个文件里只跳过 1 个 → `# tests 93 / # skipped 0`，两种都逃过只看 `skipped` 的守卫。
	const skips = [...output.matchAll(/^[ \t]*(?:not )?ok \d+ - .*(?<!\\)# SKIP\b/gm)].length;
	return {
		tests: summary("tests"),
		pass: summary("pass"),
		fail: summary("fail"),
		skipped: summary("skipped"),
		skips,
		failedNames,
	};
}

/**
 * 在指定目录里跑一批测试文件，返回 TAP 解析结果。
 *
 * @param repoDir - 作为 cwd 的仓库（副本）目录。
 * @param files - 仓库相对路径的测试文件数组。
 * @returns `{status, signal, output, tap}`；`tap` 为 null 表示连汇总行都没解析出来。
 */
function runTests(repoDir, files) {
	const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
		cwd: repoDir,
		encoding: "utf8",
		env: process.env,
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return { status: result.status, signal: result.signal, output, tap: parseTap(output) };
}

/**
 * 判断一次测试运行是否「不可信」——即有没有用例被静默跳过。
 *
 * 三种退化都必须挡住，因为它们的共同后果是：变异体本该让测试变红，却因为守它的
 * 用例没运行而全绿通过，最终被判成 SURVIVED（脚本报「这条行为无人看守」，而事实是
 * 用例根本没跑）。实测（Node 24.19.0）：
 *
 * 1. **套件级跳过**（`describe.skip` 整个套件，或整个文件）：TAP 会留下
 *    `# SKIP` 指令，但汇总行 `# skipped` 是 0——它只数被 `t.skip()` 的**用例**，
 *    跳过的**套件**不进这个数。只看 `skipped` 的守卫完全看不见它。
 *    用例数也未必为 0：实测 7 个文件里只跳过 1 个时 TAP 报 `# tests 93 / # skipped 0`，
 *    连 `tests === 0` 都看不见，只有数 `# SKIP` 指令这一条能拦住。
 * 2. **一条用例都没跑**（空 `describe`，即文件根本没声明用例）：TAP 报
 *    `# tests 0 / # skipped 0 / 且没有任何 # SKIP 痕迹`，退出码 0。
 *    这种情况连 `# SKIP` 都没有，只有 `tests === 0` 这一条能看见——所以这个分支
 *    **不是死代码**，实测可达（空 `describe` 即命中）。
 * 3. **用例级 `t.skip()`**（宿主主题包缺失时 appearance 的 16 条）：TAP 报
 *    `# skipped 16`，退出码 0——这条是原先的守卫已经覆盖的。
 *
 * 判定按「能给出最准确原因」的顺序排列：先套件级（有 `# SKIP` 痕迹），再
 * `tests === 0`，最后用例级 `skipped`。三者互不重叠，任一命中都足以拒绝继续。
 *
 * @param tap - {@link parseTap} 的结果。
 * @returns 不可信的原因（可直接放进报错/日志）；一切正常时为 `null`。
 */
function untrustworthyRun(tap) {
	if (tap.skips !== 0 && tap.skipped === 0) {
		// 套件级跳过：`# SKIP` 有痕迹，但 `# skipped` 汇总为 0。整文件 describe.skip
		// 时 tests 可能为 0，也可能只是变少（取决于还有几个文件在跑），所以这条
		// 检查不依赖 tests 的具体值。
		return `TAP 里有 ${tap.skips} 处 \`# SKIP\`（被跳过的用例或整个套件），但汇总行 \`# skipped\` 是 0：有测试被 \`describe.skip\` 之类的套件级跳过静默跳过了`;
	}
	if (tap.tests === 0) {
		// 空 `describe`（没有声明任何用例）走这里：tests 0、skipped 0、也没有 `# SKIP`。
		return "TAP 汇总显示 0 条用例被执行：整批用例被整体跳过，或测试文件其实没声明任何用例，此时 `skipped === 0` 毫无意义";
	}
	if (tap.skipped !== 0) {
		return `${tap.skipped} 条用例被 skip`;
	}
	return null;
}

/**
 * 用 `node --check` 做语法校验。
 *
 * 这是变异检查的地基：语法错误必须记为 INVALID 而不是 KILLED。整批文件
 * `SyntaxError` 时测试当然会失败，但那是「变异体自己坏了」，不是「断言守住了行为」。
 *
 * @param filePath - 待校验文件的绝对路径。
 * @returns `{ok, message}`。
 */
function syntaxCheck(filePath) {
	const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.status === 0) return { ok: true, message: "" };
	const detail = `${result.stderr ?? ""}`.trim().split("\n").slice(0, 4).join("\n");
	return { ok: false, message: detail };
}

/**
 * 把仓库复制到临时目录（排除 `.git`）。
 *
 * @returns 临时副本的绝对路径。
 */
async function makeSandbox() {
	const dir = await mkdtemp(join(tmpdir(), "usage-ledger-mutation-"));
	await cp(ROOT, dir, {
		recursive: true,
		filter: (source) => !source.split(sep).includes(".git"),
	});
	return dir;
}

/**
 * 格式化毫秒为可读的秒数。
 *
 * @param ms - 毫秒。
 * @returns 形如 `12.3s` 的字符串。
 */
function seconds(ms) {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 主流程：复制仓库 → 跑基线 → 逐个变异 → 汇总 → 决定退出码。
 *
 * @returns 进程退出码（0 = 全部 KILLED）。
 */
async function main() {
	const startedAt = Date.now();
	const files = await testFiles(ROOT);
	console.log("变异检查：把源码改坏，看测试会不会红。");
	console.log(`仓库：${ROOT}`);
	console.log(`测试文件（已排除 ${[...EXCLUDED_TESTS].join(", ")}）：${files.join(" ")}`);
	console.log(`变异体：${MUTANTS.length} 个\n`);

	const sandbox = await makeSandbox();
	const results = [];
	let fatal = null;

	try {
		// 基线：未经变异的副本必须 0 失败、0 跳过。若基线就红/就 skip，
		// 后面所有 KILLED/SURVIVED 都无从谈起（skip 不会让退出码非 0，但会让
		// 变异体以「全绿」通过并被判成 SURVIVED，即「无人看守」的假警报）。
		console.log("── 基线（未变异副本） ──");
		const baseline = runTests(sandbox, files);
		if (baseline.tap === null || baseline.tap.tests === null) {
			throw new Error(`基线跑不出 TAP 汇总行，测试根本没跑起来：\n${baseline.output.slice(-2000)}`);
		}
		console.log(
			`   用例 ${baseline.tap.tests}｜通过 ${baseline.tap.pass}｜失败 ${baseline.tap.fail}｜跳过 ${baseline.tap.skipped}\n`,
		);
		if (baseline.tap.fail !== 0) {
			throw new Error(`基线就有 ${baseline.tap.fail} 条失败用例，先修测试再谈变异检查：\n  - ${baseline.tap.failedNames.join("\n  - ")}`);
		}
		const baselineUntrusted = untrustworthyRun(baseline.tap);
		if (baselineUntrusted !== null) {
			throw new Error(
				`基线不可信：${baselineUntrusted}。` +
					"被跳过的用例没有运行，变异体本该变红却会全绿通过，从而被误判成 SURVIVED（假警报——报告说「无人看守」，实则是没跑）。" +
					"skip 本身不会让 `node --test` 非 0 退出（实测退出码为 0），所以这里必须硬断言，脚本拒绝在这种环境下继续。" +
					"\n  最常见的原因：宿主主题包没装上（test/appearance.test.js 读不到就只能 skip）、" +
					"有人把整个测试文件包进了 `describe.skip`，或某个测试文件其实没有声明任何用例" +
					"（空 `describe` 会让 TAP 报 `# tests 0 / # skipped 0`，只有 `tests === 0` 这一条能看见）。",
			);
		}

		for (const mutant of MUTANTS) {
			const filePath = join(ROOT, mutant.file);
			const original = await readFile(filePath, "utf8");
			assertAnchorSafe(mutant, original);
			const mutated = original.replace(mutant.from, mutant.to);
			assertTemplateSafe(mutant, original, mutated);
			if (mutated === original) throw new Error(`[${mutant.id}] 替换后源码没有变化：锚点写错了。`);

			// 临时副本里只改这一个文件；每个变异体开始前都从原始文本重新算起，
			// 所以变异体之间不会互相叠加。
			const sandboxPath = join(sandbox, mutant.file);
			await writeFile(sandboxPath, mutated, "utf8");

			process.stdout.write(`${mutant.id.padEnd(30)} `);
			const syntax = syntaxCheck(sandboxPath);
			if (!syntax.ok) {
				results.push({ mutant, outcome: "INVALID", detail: syntax.message });
				console.log("INVALID（语法错误，不计入 KILLED）");
				console.log(`   ${syntax.message.split("\n")[0]}`);
				await writeFile(sandboxPath, original, "utf8");
				continue;
			}

			const run = runTests(sandbox, files);
			if (run.tap === null || run.tap.tests === null) {
				results.push({ mutant, outcome: "ERROR", detail: "TAP 汇总行缺失，测试没跑起来" });
				console.log("ERROR（TAP 汇总行缺失）");
				console.log(run.output.slice(-1500));
				await writeFile(sandboxPath, original, "utf8");
				continue;
			}
			const untrusted = untrustworthyRun(run.tap);
			if (untrusted !== null) {
				results.push({ mutant, outcome: "ERROR", detail: untrusted });
				console.log(`ERROR（${untrusted}，无法判定）`);
				await writeFile(sandboxPath, original, "utf8");
				continue;
			}

			const killed = run.tap.fail > 0 || run.status !== 0;
			const outcome = killed ? "KILLED" : "SURVIVED";
			results.push({
				mutant,
				outcome,
				detail: killed ? run.tap.failedNames.slice(0, 6).join("；") : "",
				counts: run.tap,
			});
			console.log(`${outcome}（失败 ${run.tap.fail} 条）`);
			if (killed) {
				for (const name of run.tap.failedNames.slice(0, 3)) console.log(`   ✗ ${name}`);
				if (run.tap.failedNames.length > 3) console.log(`   … 另有 ${run.tap.failedNames.length - 3} 条`);
			} else {
				console.log(`   期望杀手：${mutant.killer}`);
				console.log("   没有任何测试变红——这条行为无人看守。");
			}

			await writeFile(sandboxPath, original, "utf8");
		}
	} catch (error) {
		fatal = error;
	} finally {
		if (process.env.UL_MUTATION_KEEP_TEMP === "1") console.log(`\n临时副本保留在：${sandbox}`);
		else await rm(sandbox, { recursive: true, force: true });
	}

	if (fatal !== null) {
		console.error(`\n变异检查未能跑完：${fatal.message}`);
		return 1;
	}

	const killed = results.filter((row) => row.outcome === "KILLED");
	const survived = results.filter((row) => row.outcome === "SURVIVED");
	const invalid = results.filter((row) => row.outcome === "INVALID" || row.outcome === "ERROR");

	console.log("\n── 结果表 ──");
	console.log("结果     变异体                          期望被谁杀死");
	for (const row of results) {
		console.log(`${row.outcome.padEnd(9)}${row.mutant.id.padEnd(32)}${row.mutant.killer}`);
	}

	console.log(
		`\nKILLED ${killed.length}｜SURVIVED ${survived.length}｜INVALID/ERROR ${invalid.length}｜共 ${MUTANTS.length} 个变异体`,
	);
	console.log(`总耗时 ${seconds(Date.now() - startedAt)}`);

	if (survived.length > 0) {
		console.log("\n存活的变异体（测试没变红，说明这条行为没有测试在守）：");
		for (const row of survived) console.log(`  - ${row.mutant.id}：${row.mutant.what}\n    期望杀手：${row.mutant.killer}`);
	}
	if (invalid.length > 0) {
		console.log("\n无法判定的变异体（语法错误/环境问题，绝不算 KILLED）：");
		for (const row of invalid) console.log(`  - ${row.mutant.id}：${row.detail}`);
	}

	const ok = killed.length === MUTANTS.length;
	console.log(ok ? "\n全部变异体被杀死：这些行为真的有测试在守。" : "\n存在未被杀死的变异体：见上。");
	return ok ? 0 : 1;
}

process.exitCode = await main();
