/**
 * 外观回归测试：宿主 token 存在性、色阶可辨性、键盘可达性。
 *
 * ## 为什么必须存在这个文件
 *
 * 面板曾经引用两个宿主**根本没有**的 token（`--dsw-alias-text-primary`、
 * `--dsw-alias-border-1`）。CSS 里写错 token 名**不会报错**：`var()` 找不到变量时
 * 静默使用 fallback，而那两个 fallback 是照着深色模式写死的（`#e6e6e6`、
 * `rgba(255,255,255,.12)`）。宿主默认外观是「跟随系统」，于是在浅色系统上正文对比度
 * 只有 1.25:1（WCAG AA 要求 4.5:1），卡片与分隔线直接消失。
 *
 * 全程 `npm test` 全绿——因为**没有任何测试能看见颜色或 token 名**。这个文件就是
 * 为了让这一类缺陷再也无法静默出厂：它把「token 必须存在」「色阶必须可辨」
 * 「键盘必须可达」从口头约定变成会失败的断言。
 *
 * ## 为什么又是「读源码 + 正则」
 *
 * `src/client.js` 是传统 `<script src>` 加载的 `__ModuleLoader__` bundle，不能
 * `import`（原因见 `docs/adr/0005-cross-end-contract-by-test.md`），而 ADR-0004 禁止
 * 引入构建步骤。所以这里沿用 `test/contract.test.js` 的手法：把源码当**文本**读进来
 * 再断言。区别在于 `contract.test.js` 盯跨端常量，本文件盯**外观**。
 *
 * 本文件只读文件，不改任何东西：`src/client.js` 与宿主主题包都是只读输入。
 *
 * @module usage-ledger/test/appearance
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** `src/client.js` 的绝对 URL（不拼字符串路径，跨平台）。 */
const CLIENT_URL = new URL("../src/client.js", import.meta.url);

/**
 * 宿主主题包的候选绝对路径，按优先级排列。
 *
 * 这个路径是**机器相关**的：宿主主题包由全局安装的 DSH 提供，不在本仓库的依赖里。
 * 它必须与运行测试的 Node 可执行文件同源，所以从 `process.execPath` 反推，而不是
 * 写死 `/home/...`（写死会让换机器的 CI 直接读不到文件）。
 *
 * 之所以是**候选列表**而不是一条路径：全局装的是哪个包决定主题包落在哪里。
 * - 装完整的 `@deepseek-ai/dsh` → 主题包是它自己的依赖，落在**嵌套**目录；
 * - 只装 `@deepseek-ai/dsh-client-ui-theme` → 落在**扁平**目录。
 * 两种都是合法的宿主安装，只认其中一种会让另一种布局下的 16 条外观断言静默 skip。
 *
 * 若候选**全部**不存在，token 存在性断言必须 `t.skip()` 并说明原因，**绝不**让它假装通过：
 * 「读不到宿主 token 定义」与「token 都存在」是两回事，后者才是安全的。
 */
const THEME_CANDIDATES = [
	// 1. 显式覆盖：CI（只装主题包）与非常规安装布局用它指路，优先级最高。
	process.env.UL_THEME_PATH,
	// 2. 嵌套：全局装了完整的 DSH，主题包在 dsh 自己的 node_modules 里。
	join(
		dirname(process.execPath),
		"..",
		"lib",
		"node_modules",
		"@deepseek-ai",
		"dsh",
		"node_modules",
		"@deepseek-ai",
		"dsh-client-ui-theme",
		"lib",
		"client.js",
	),
	// 3. 扁平：只单独全局装了主题包（5 个包，比装完整 DSH 轻得多）。
	join(
		dirname(process.execPath),
		"..",
		"lib",
		"node_modules",
		"@deepseek-ai",
		"dsh-client-ui-theme",
		"lib",
		"client.js",
	),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

/** 第一个真实存在的候选路径；一个都没有时为 `null`。 */
const THEME_PATH = THEME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

/**
 * 本机是否装有宿主主题包。
 *
 * 提前算出来，好让每个用例自己决定是断言还是 skip——两条路径都必须是**显式**的。
 */
const THEME_PRESENT = THEME_PATH !== null;

/** 源码与主题包都只读一次。 */
let cachedSource;
let cachedTheme;

/**
 * 读取 `src/client.js` 源码文本。
 *
 * @returns 源码字符串。
 */
async function clientSource() {
	if (cachedSource === undefined) cachedSource = await readFile(CLIENT_URL, "utf8");
	return cachedSource;
}

/**
 * 读取宿主主题包文本。
 *
 * 调用前必须已经确认 {@link THEME_PRESENT}；否则 `readFile` 会抛 ENOENT。
 *
 * @returns 主题包源码字符串。
 */
async function themeSource() {
	if (cachedTheme === undefined) cachedTheme = await readFile(THEME_PATH, "utf8");
	return cachedTheme;
}

/**
 * 取出 `src/client.js` 里的样式模板字符串。
 *
 * 只取 `const CSS = \`...\`;` 这一段：源码里其余部分的注释（比如解释为什么不用
 * `color-mix` 的那段中文注释）也含同样的关键字，若对整个文件做断言，注释本身会把
 * 断言喂饱——**注释不是实现**。热力图色值只可能出现在这个模板里。
 *
 * @param source - `src/client.js` 源码文本。
 * @returns 样式模板字符串内容。
 */
function cssText(source) {
	const match = source.match(/const CSS = `([\s\S]*?)`;/);
	assert.ok(
		match !== null,
		"src/client.js 里找不到 `const CSS = `...`;` 样式模板；提取正则需要同步更新，否则本文件所有外观断言都在测空气。",
	);
	return match[1];
}

/**
 * 剥掉源码里的注释，只留**代码**。
 *
 * `src/client.js` 里就有现成的反例：注释写着 `// tabIndex:-1 让容器可被程序化聚焦`，
 * 真正的实现 `tabIndex: -1,` 在下一行。对整份源码做 `/tabIndex:\s*-1/` 会先命中注释
 * ——于是**删掉实现**这条断言依然全绿。凡是「源码里必须出现某字符串」的断言，都必须
 * 先过这一层，否则守的是注释而不是行为。
 *
 * 只处理本 bundle 实际存在的两种注释形态：块注释与行首行注释（全文的行注释都从行首
 * 开始，字符串与模板里没有双斜杠）。将来若出现行内行注释，
 * 这里会漏掉它——所以 `外观：注释剥离器自身有效` 那条自检会把「剥不动」直接报出来。
 *
 * @param source - 源码文本。
 * @returns 去掉注释的代码文本。
 */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");
}

/**
 * 读取 `src/client.js` 的**代码**（已剥注释）。
 *
 * 所有「源码里出现某字符串」的断言都该用这个，而不是 {@link clientSource}。
 *
 * @returns 去注释后的源码。
 */
async function codeSource() {
	return stripComments(await clientSource());
}

/**
 * 把一段 CSS 声明列表拆成「自定义属性 → 值」的映射。
 *
 * 只按第一个 `:` 切分，因为值里可能含 `:`（例如 `url(...)` 或 `color-mix(...)`）。
 *
 * @param block - 花括号内部、分号分隔的声明文本。
 * @returns 自定义属性名到其原始值（未去引号、未解析）的映射。
 */
function declarations(block) {
	const map = new Map();
	for (const declaration of block.split(";")) {
		const colon = declaration.indexOf(":");
		if (colon <= 0) continue;
		const name = declaration.slice(0, colon).trim();
		if (name.startsWith("--")) map.set(name, declaration.slice(colon + 1).trim());
	}
	return map;
}

/**
 * 从主题包里收集某类 `body` 选择器块中定义的全部自定义属性。
 *
 * 多个同名选择器的块按出现顺序合并，后者覆盖前者（与浏览器层叠一致）。
 *
 * @param theme - 主题包源码文本。
 * @param pattern - 匹配目标选择器块的全局正则，第 1 个捕获组是花括号内容。
 * @returns 自定义属性名到定义值的映射。
 */
function collectDeclarations(theme, pattern) {
	const map = new Map();
	for (const match of theme.matchAll(pattern)) {
		for (const [name, value] of declarations(match[1])) map.set(name, value);
	}
	return map;
}

/**
 * 主题包里**任意位置**出现的自定义属性。
 *
 * `--dsw-elevation-*` 与 `--dsw-static-*` 不在 `body{}` 也不在
 * `body[data-ds-dark-theme]{}` 里——它们挂在 `body,body *{}` 这种通配规则上，两种主题
 * 共用。只看那两个块会把它们误判成「不存在」，制造假红。
 *
 * @param theme - 主题包源码文本。
 * @returns 自定义属性名到（首次出现的）定义值的映射。
 */
function collectAllDeclarations(theme) {
	const map = new Map();
	for (const match of theme.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
		if (!map.has(match[1])) map.set(match[1], match[2].trim());
	}
	return map;
}

/**
 * 顺着 `var()` 链把 token 解析成最终字面值。
 *
 * 宿主 token 大量是 `--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000)`，
 * 直接拿 alias 的值去比色是比不出来的，必须一路解到 `#0f1115` 这样的字面量。
 *
 * @param themeMap - 当前主题下生效的 token 映射。
 * @param globals - 主题包全量 token（`--dsw-static-*` 等落在这里）。
 * @param name - 起始 token 名。
 * @param seen - 已经访问过的 token（防自引用死循环）。
 * @returns 解析出的字面值；解析不动或成环时返回 `null`。
 */
function resolveToken(themeMap, globals, name, seen = new Set()) {
	if (seen.has(name)) return null;
	seen.add(name);
	const value = themeMap.get(name) ?? globals.get(name);
	if (value === undefined) return null;
	const reference = value.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)$/);
	if (reference === null) return value;
	return resolveToken(themeMap, globals, reference[1], seen) ?? (reference[2]?.trim() ?? null);
}

/**
 * 把 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` 解析成 `[r,g,b]`。
 *
 * 8 位形式是**带 alpha 的 hex**（宿主大量使用 `#0000000a` 这类极淡边框），
 * 这里只取 RGB 通道：alpha 与底色合成留给调用方，本函数的契约就是「颜色通道」。
 *
 * @param hex - 形如 `#abc` / `#abcd` / `#aabbcc` / `#aabbccdd` 的字符串。
 * @returns `[r,g,b]`；不是可识别的 hex 时返回 `null`。
 */
function parseHex(hex) {
	let body = String(hex).trim().replace(/^#/, "");
	if (body.length === 3 || body.length === 4) body = body.slice(0, 3).split("").map((char) => char + char).join("");
	else if (body.length === 8) body = body.slice(0, 6);
	if (body.length !== 6 || !/^[0-9a-f]{6}$/i.test(body)) return null;
	return [0, 2, 4].map((offset) => Number.parseInt(body.slice(offset, offset + 2), 16));
}

/**
 * 单个 sRGB 通道的线性化（WCAG 2.x 相对亮度公式的第一步）。
 *
 * @param channel - 0–255 的通道值。
 * @returns 0–1 的线性值。
 */
function linearize(channel) {
	const scaled = channel / 255;
	return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

/**
 * WCAG 相对亮度。
 *
 * @param rgb - `[r,g,b]`。
 * @returns 0（黑）–1（白）的相对亮度。
 */
function relativeLuminance(rgb) {
	return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

/**
 * 两个颜色的 WCAG 对比度（1:1 至 21:1）。
 *
 * 亮者作分子，所以与参数顺序无关。
 *
 * @param a - 颜色（hex 字符串或 `[r,g,b]`）。
 * @param b - 颜色（hex 字符串或 `[r,g,b]`）。
 * @returns 对比度比值；任一颜色不可解析时抛错（静默返回 1 会让断言假绿）。
 */
function contrastRatio(a, b) {
	const first = Array.isArray(a) ? a : parseHex(a);
	const second = Array.isArray(b) ? b : parseHex(b);
	assert.ok(first !== null, `对比度计算拿到了不可解析的颜色 \`${a}\`；色阶提取正则可能已失效，这条断言不能当通过。`);
	assert.ok(second !== null, `对比度计算拿到了不可解析的颜色 \`${b}\`；色阶提取正则可能已失效，这条断言不能当通过。`);
	const high = Math.max(relativeLuminance(first), relativeLuminance(second));
	const low = Math.min(relativeLuminance(first), relativeLuminance(second));
	return (high + 0.05) / (low + 0.05);
}

/**
 * 从 CSS 里取热力图某一档在某一主题下的背景色，按**层叠顺序**解析。
 *
 * 只认**真实格子**（`.ul-heat i[data-l="N"]`）那一条规则：图例（`.ul-legend`）与格子
 * 共用同一声明，但断言必须钉在格子上——图例只是装饰，用户读的是格子。
 *
 * 层叠规则与浏览器一致：深色主题下先找带 `body[data-ds-dark-theme]` 前缀的变体，
 * 找不到就落回**不带主题前缀**的那条规则（它本身是主题无关的，颜色随主题映射变）。
 * 档位 `0` 正是这种写法：它只有一条 `bg-layer-2` 规则，两种主题共用。
 *
 * @param css - 样式模板字符串。
 * @param level - 档位 `"0".."4"`。
 * @param dark - 是否取深色主题下的生效值。
 * @returns 该档生效的背景值原文；找不到规则时返回 `null`。
 */
function heatBackground(css, level, dark) {
	const pick = (selector) => {
		const match = css.match(new RegExp(`${selector}[^{}]*\\{([^}]*)\\}`, "m"));
		if (match === null) return null;
		const background = match[1].match(/(?:^|;)\s*background\s*:\s*([^;}]+)/);
		return background === null ? null : background[1].trim();
	};
	if (dark) {
		const scoped = pick(`body\\[data-ds-dark-theme\\][^{}]*\\.ul-heat i\\[data-l="${level}"\\]`);
		if (scoped !== null) return scoped;
	}
	return pick(`(?:^|,)[ \\t]*\\.ul-heat i\\[data-l="${level}"\\]`);
}

/**
 * 把热力图某档的颜色解析成 RGB。
 *
 * 档位 `0` 故意复用 `bg-layer-2`（空单元格＝「这天没有用量」），所以它需要主题映射
 * 来解 token；其余档位是静态 hex。
 *
 * @param css - 样式模板字符串。
 * @param themeMap - 当前主题的 token 映射。
 * @param globals - 主题包全量 token。
 * @param level - 档位 `"0".."4"`。
 * @param dark - 是否取深色主题下的生效值。
 * @returns `[r,g,b]`；规则缺失或颜色不可解析时抛错（否则后面的比值会算成 NaN 假绿）。
 */
function heatRgb(css, themeMap, globals, level, dark) {
	const background = heatBackground(css, level, dark);
	const themeLabel = dark ? "深色" : "浅色";
	assert.ok(
		background !== null,
		`样式里找不到${themeLabel}主题下热力图档位 data-l="${level}" 的背景色规则：这一档会退回到 .ul-heat i 的默认底色，` +
			`用户看到的色阶少一档且与相邻档位同色——热力图不再能表达用量强弱。`,
	);
	const resolved = background.startsWith("var(")
		? resolveToken(themeMap, globals, background.match(/var\(\s*(--[a-z0-9-]+)/)[1])
		: background;
	const rgb = parseHex(resolved);
	assert.ok(
		rgb !== null,
		`热力图档位 data-l="${level}"（${themeLabel}）的色值 \`${resolved}\`（原始声明 \`${background}\`）不是可解析的颜色：` +
			`色阶提取正则或 token 链已经失效，这条断言不能当通过。`,
	);
	return rgb;
}

/**
 * 从主题包建立「浅色 / 深色 / 全量」三份 token 映射。
 *
 * 块结构是宿主约定：`body{...}` 是浅色集，`body[data-ds-dark-theme]{...}` 是深色集。
 * 前缀 `(?:^|[},;])` 用来排除 `html[data-platform=darwin] body{...}` 这类平台覆盖块
 * （它不是主题 token 集）；`--dsw-elevation-*`、`--dsw-static-*` 不在两个块里，
 * 由「全量」兜底。
 *
 * @param theme - 主题包源码文本。
 * @returns `{light, dark, globals}` 三份映射。
 */
function themeMaps(theme) {
	return {
		light: collectDeclarations(theme, /(?:^|[},;])body\{([^{}]*)\}/g),
		dark: collectDeclarations(theme, /body\[data-ds-dark-theme\]\{([^{}]*)\}/g),
		globals: collectAllDeclarations(theme),
	};
}

/**
 * 跳过当前用例，并说明「跳过了什么、为什么、代价是什么」。
 *
 * 刻意不返回 `assert.ok(true)` 之类的东西：跳过必须是显式的，且 `t.skip` 会让
 * 用例计入 skipped 而不是 pass——这样 `npm test` 的数字能如实反映「宿主包缺失，
 * 存在性没有被验证过」。
 *
 * @param t - `node:test` 的用例上下文。
 * @returns 无。
 */
function skipMissingTheme(t) {
	t.skip(
		`读不到宿主主题包，已试过的路径：\n${THEME_CANDIDATES.map((candidate) => `  - ${candidate}`).join("\n")}\n` +
			"本机没有全局安装 DSH 主题包（或 Node 版本目录不同），token 存在性**未被验证**。" +
			"这条用例被记为 skipped 而不是 passed，请勿把它当成「token 都存在」——" +
			"面板引用不存在的 token 时 var() 会静默落到 fallback，浅色模式下文字不可读。",
	);
}

//#region 1. token 存在性

test("外观：client.js 引用的每个 --dsw-alias-* token 都真实存在于宿主主题包", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark } = themeMaps(theme);

	// 源码里的注释也会出现 token 名（例如解释为什么不用 warn-label 的那段），
	// 所以只扫样式模板字符串——**注释不是实现**，引用一处注释不能算引用。
	const css = cssText(source);
	const references = [...new Set([...css.matchAll(/var\(\s*(--dsw-alias-[a-z0-9-]+)/g)].map((match) => match[1]))].sort();

	assert.ok(
		references.length >= 8,
		`只从样式里提取到 ${references.length} 个 --dsw-alias-* 引用（预期至少 8 个）：` +
			"提取正则需要同步更新，否则下面逐 token 的存在性核对是在核对一个空集合，必然全绿。",
	);

	for (const name of references) {
		assert.ok(
			light.has(name),
			`token \`${name}\` 在宿主主题包的**浅色** token 集（body{...}）里没有定义。` +
				"写错 token 名不会报错：var() 会静默使用 fallback，而 fallback 若是照深色模式写死的，" +
				"浅色系统上这段文字/边框就会变成不可读（或完全消失），且控制台不报任何错。",
		);
		assert.ok(
			dark.has(name),
			`token \`${name}\` 在宿主主题包的**深色** token 集（body[data-ds-dark-theme]{...}）里没有定义。` +
				"深色模式下该处会静默落到 fallback，与浅色下的取值不一致，主题切换时会出现「一种主题可读、另一种不可读」。",
		);
	}
});

test("外观：宿主主题包解析出的浅色/深色 token 集规模合理（提取器自检）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);

	// 这条不是为了核对 token，而是为了核对**提取器**：上面所有存在性断言的结论都建立在
	// 「body{...} 与 body[data-ds-dark-theme]{...} 被正确解析」之上。若宿主改了块结构
	// （例如换成 :root 或加一层包装），提取器会返回空/残缺的映射，那时每个 token 都会被
	// 报成「不存在」——错误信息会误导人去改 token 名，而真正要改的是这里。规模下限先把
	// 这种情况区分开。
	assert.ok(
		light.size >= 80,
		`从 body{...} 解析出 ${light.size} 个 token（预期 ≥80）：宿主主题包的块结构可能变了，` +
			"token 存在性核对会因此把**每一个** token 都误报成不存在。请先修提取正则，不要改 token 名。",
	);
	assert.ok(
		dark.size >= 80,
		`从 body[data-ds-dark-theme]{...} 解析出 ${dark.size} 个 token（预期 ≥80）：宿主深色块结构可能变了。`,
	);
	assert.ok(
		globals.size > light.size,
		`主题包全量 token（${globals.size}）不大于浅色集（${light.size}）：` +
			"说明 --dsw-elevation-* / --dsw-static-* 这类两个主题块之外的定义没被收集到，" +
			"它们会被误判成「不存在」，制造假红。",
	);
});

//#endregion

//#region 2. 禁止深色专用 fallback

test("外观：client.js 不出现深色专用的 var() 兜底值", async () => {
	const source = await clientSource();
	const css = cssText(source);

	// 这三个值是深色模式专用色：写进 fallback 就等于「token 找不到时按深色渲染」。
	// 宿主默认外观跟随系统，浅色系统上它们会变成不可读的浅灰/近白。
	const forbidden = [
		["#e6e6e6", "浅色背景上的近白文字 → 对比度约 1.25:1，正文几乎不可见"],
		["rgba(255,255,255,.12)", "浅色背景上的白色分隔线 → 完全消失，卡片与表格失去层次"],
		["rgba(255, 255, 255, .12)", "浅色背景上的白色分隔线 → 完全消失，卡片与表格失去层次"],
		["#5b8def", "宿主的 brand-primary 是墨色而非色相，这个 fallback 是永不生效的死代码"],
		["#4ea1ff", "宿主的 brand-primary 是墨色而非色相，这个 fallback 是永不生效的死代码"],
	];

	for (const [literal, consequence] of forbidden) {
		assert.ok(
			!css.includes(literal),
			`样式里仍然出现深色专用兜底 \`${literal}\`：${consequence}。` +
				"fallback 只在 token 缺失时生效，所以它平时看不见——一旦宿主改 token 名，浅色用户会立刻掉进这个坑。",
		);
	}
});

test("外观：所有显式 var() fallback 都是中性值，不得自带主题假设", async () => {
	const source = await clientSource();
	const css = cssText(source);

	// 显式 fallback 的集合：`var(--x, <fallback>)`。嵌套 var() 的括号由正则排除，
	// 因为 fallback 里再套 var() 时这个正则取不完整——当前实现没有这种写法，
	// 一旦出现，下面的数量下限断言会提醒提取器需要升级。
	const fallbacks = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,\s*([^()]+?)\s*\)/g)].map((match) => ({
		token: match[1],
		value: match[2].trim(),
	}));

	assert.ok(
		fallbacks.length >= 4,
		`只从样式里提取到 ${fallbacks.length} 个显式 var() fallback（预期至少 4 个）：` +
			"提取正则需要同步更新，否则下面「fallback 必须中性」的断言在检查空集合。",
	);

	for (const { token, value } of fallbacks) {
		// 中性 = 跟随继承来的颜色。`currentColor` 在两种主题下都等于当前文字色，
		// 不会把深色假设带进浅色模式。
		assert.equal(
			value,
			"currentColor",
			`\`var(${token}, ${value})\` 的 fallback 不是中性值。` +
				"token 缺失时 fallback 就是实际渲染色，写死颜色等于把主题假设埋进兜底：宿主改 token 名后，" +
				"浅色模式会静默按这个颜色渲染。fallback 请用 currentColor。",
		);
	}
});

//#endregion

//#region 3. 禁止 color-mix()

test("外观：client.js 完全不使用 color-mix()", async () => {
	const source = await clientSource();

	// 对整个源码断言（不只是样式）：color-mix 出现在任何位置都是这个决定的反例。
	// 注释同样要剥掉：解释「为什么不用 color-mix」的那段中文注释里就写着这个名字，
	// 不剥的话这条断言会被注释喂饱——**注释不是实现**。
	const occurrences = [...stripComments(source).matchAll(/color-mix/gi)].length;
	assert.equal(
		occurrences,
		0,
		`src/client.js 的代码里出现 ${occurrences} 次 color-mix()。它没有 @supports 回退，不支持该函数的浏览器会把整个声明丢弃，` +
			"热力图五档会整片同色（等于没有色阶）；而且色相随主题反转，浅色下会算出与深色相反的层级。" +
			"色阶请用静态色 + body[data-ds-dark-theme] 分主题给出。",
	);
});

test("外观：热力图色阶是静态色，不靠运行时混色或 shade() 计算", async () => {
	const source = await clientSource();
	const css = cssText(source);

	// 每个档位必须有静态背景声明；若改回运行时计算（shade()/color-mix），这里就找不到规则。
	for (const level of ["0", "1", "2", "3", "4"]) {
		assert.notEqual(
			heatBackground(css, level, false),
			null,
			`浅色主题下找不到 .ul-heat i[data-l="${level}"] 的静态背景色规则：` +
				"热力图会退回默认底色，这一档与相邻档位同色，用户无法从颜色判断当天用量强弱。",
		);
	}

	assert.equal(
		/shade\s*\(/.test(stripComments(source)),
		false,
		"代码里仍存在 shade() 调用：色阶色值又变成运行时算出来的了，图例与真实格子可能算出不同颜色，" +
			"且测试再也无法在无浏览器环境下核对色阶。色阶必须是 CSS 里的静态常量。",
	);
});

//#endregion

//#region 4. 色阶在两种主题下都可见且两两可辨

test("外观：热力图 L1–L4 每一档在浅色主题下都相对面板底色可见（>1.15）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, globals } = themeMaps(theme);
	const css = cssText(source);

	// 面板底色 = .ul-panel 的 bg-layer-1；热力图落在面板里，所以「可见」是相对它而言。
	const panel = parseHex(resolveToken(light, globals, "--dsw-alias-bg-layer-1"));
	assert.ok(panel !== null, "宿主浅色 --dsw-alias-bg-layer-1 解析不出颜色，无法核对热力图可见性。");

	// 只对 L1–L4 断言「可见」，**不含 L0**：L0 按 D2 刻意复用 bg-layer-2（空单元格＝
	// 「这天没有用量」），而浅色下 bg-layer-2 与 bg-layer-1 同为 #fff，比值必然是 1.000。
	// 这不是缺陷而是设计：空档就该与底色融为一体，把「没有用量」画成一个色块反而误导。
	// 空档的可辨性由「相邻档位两两可辨」那条（L0↔L1）负责。下面的 L0 专项断言把它钉死。
	for (const level of ["1", "2", "3", "4"]) {
		const rgb = heatRgb(css, light, globals, level, false);
		const ratio = contrastRatio(rgb, panel);
		assert.ok(
			ratio > 1.15,
			`浅色主题下热力图档位 data-l="${level}"（${heatBackground(css, level, false)}）相对面板底色 #ffffff 的对比度只有 ` +
				`${ratio.toFixed(3)}:1（要求 >1.15）。这一档在白底上等于看不见，热力图会出现空档，` +
				"用户会把「有用量」误读成「没有用量」。",
		);
	}
});

test("外观：热力图 L0 刻意等于空单元格底色，且与 L1 可辨（空档不得变成色块）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);

	// L0 的语义是「这天没有用量」。按 D2 它必须等于空单元格底色 bg-layer-2：
	// 若哪天有人给它单独配色，空档就会看起来像「有一点用量」，而这是最难被发现的一类错误
	// ——热力图上多一格浅色，没人会怀疑它是 bug。所以这里正面钉住它等于 bg-layer-2。
	const lightZero = heatRgb(css, light, globals, "0", false);
	const darkZero = heatRgb(css, dark, globals, "0", true);
	const lightCell = parseHex(resolveToken(light, globals, "--dsw-alias-bg-layer-2"));
	const darkCell = parseHex(resolveToken(dark, globals, "--dsw-alias-bg-layer-2"));
	assert.ok(lightCell !== null && darkCell !== null, "宿主 --dsw-alias-bg-layer-2 解析不出颜色，无法核对空档语义。");

	assert.deepEqual(
		lightZero,
		lightCell,
		`浅色主题下 data-l="0" 解析为 ${lightZero}，但空单元格底色 bg-layer-2 是 ${lightCell}：` +
			"空档与「无数据格」颜色不一致，热力图上会出现两种不同的「没有用量」，用户无法分辨哪一格是真的没数据。",
	);
	assert.deepEqual(
		darkZero,
		darkCell,
		`深色主题下 data-l="0" 解析为 ${darkZero}，但空单元格底色 bg-layer-2 是 ${darkCell}：` +
			"空档与「无数据格」颜色不一致，热力图上会出现两种不同的「没有用量」。",
	);

	// 空档与最低用量档必须可辨：否则「有一点用量」看起来就是「没有用量」。
	for (const [label, map, isDark] of [["浅色", light, false], ["深色", dark, true]]) {
		const ratio = contrastRatio(heatRgb(css, map, globals, "0", isDark), heatRgb(css, map, globals, "1", isDark));
		assert.ok(
			ratio > 1.15,
			`${label}主题下 data-l="0"（空档）与 data-l="1"（最低用量档）的对比度只有 ${ratio.toFixed(3)}:1（要求 >1.15）：` +
				"「有最少用量」看起来与「完全没有用量」一样，用户会漏掉刚起步的那几天。",
		);
	}
});

test("外观：热力图 L1–L4 每一档在深色主题下都相对面板底色可见（>1.15）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { dark, globals } = themeMaps(theme);
	const css = cssText(source);

	const panel = parseHex(resolveToken(dark, globals, "--dsw-alias-bg-layer-1"));
	assert.ok(panel !== null, "宿主深色 --dsw-alias-bg-layer-1 解析不出颜色，无法核对热力图可见性。");

	// 同浅色那条：L0 刻意等于 bg-layer-2，由 L0 专项断言负责，这里只查 L1–L4。
	for (const level of ["1", "2", "3", "4"]) {
		const rgb = heatRgb(css, dark, globals, level, true);
		const ratio = contrastRatio(rgb, panel);
		assert.ok(
			ratio > 1.15,
			`深色主题下热力图档位 data-l="${level}"（${heatBackground(css, level, true)}）相对面板底色 #232324 的对比度只有 ` +
				`${ratio.toFixed(3)}:1（要求 >1.15）。这一档在深色底上等于看不见，热力图会出现空档。`,
		);
	}
});

test("外观：热力图相邻档位在两种主题下都两两可辨（>1.15）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);

	// 这是把「色阶设计」变成可执行断言的核心：相邻两档若同色，五档色阶实际只有四档，
	// 热力图就无法表达用量强弱，而这种退化肉眼极难发现、也不会报错。
	for (const [label, map, isDark] of [["浅色", light, false], ["深色", dark, true]]) {
		for (const level of ["0", "1", "2", "3"]) {
			const next = String(Number(level) + 1);
			const ratio = contrastRatio(
				heatRgb(css, map, globals, level, isDark),
				heatRgb(css, map, globals, next, isDark),
			);
			assert.ok(
				ratio > 1.15,
				`${label}主题下热力图相邻档位 data-l="${level}" 与 data-l="${next}" 的对比度只有 ${ratio.toFixed(3)}:1（要求 >1.15）：` +
					"两档在视觉上无法区分，五档色阶实际退化成更少的档位，用户读不出用量的相对强弱。",
			);
		}
	}
});

test("外观：色阶随档位单调变强，且深色主题每档都有专属覆盖（不泄漏浅色色值）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);

	// 这条是变异测试逼出来的：把深色 L2 的覆盖规则删掉后，深色下会**落回浅色色值**
	// #93c5fd。此时 L1→L2→L3 的「相对底色的对比度」变成 1.5 → 8.7 → 6.2——L2 比 L3
	// 还亮。相邻可辨性断言抓不到它（每对仍然可辨），但色阶的**方向**已经错了：
	// 用户看到「用量中等」的那格比「用量较多」的还显眼，读图结论直接反过来。
	// 所以除了「两两可辨」，还必须断言「档位越高越突出」。
	for (const [themeLabel, map, isDark] of [["浅色", light, false], ["深色", dark, true]]) {
		const panel = parseHex(resolveToken(map, globals, "--dsw-alias-bg-layer-1"));
		assert.ok(panel !== null, `宿主${themeLabel}主题 --dsw-alias-bg-layer-1 解析不出颜色。`);

		// 从 L1 起算：L0 是空档，它与底色的关系由 L0 专项断言负责。
		const ramp = ["1", "2", "3", "4"].map((level) => ({
			level,
			ratio: contrastRatio(heatRgb(css, map, globals, level, isDark), panel),
		}));
		for (let index = 1; index < ramp.length; index += 1) {
			assert.ok(
				ramp[index].ratio > ramp[index - 1].ratio,
				`${themeLabel}主题下热力图档位越高反而越不突出：data-l="${ramp[index - 1].level}" 相对底色的对比度是 ` +
					`${ramp[index - 1].ratio.toFixed(3)}:1，而 data-l="${ramp[index].level}" 只有 ${ramp[index].ratio.toFixed(3)}:1。` +
					"色阶方向反了——用户会把「用量中等」读成「用量最多」，整张热力图的结论都是错的。",
			);
		}
	}

	// 深色主题下 L1–L4 每档都必须有**自己的** body[data-ds-dark-theme] 覆盖规则。
	// 缺一条就会静默落回浅色色值（上面的单调性断言会红，但这里给出更直接的原因）。
	for (const level of ["1", "2", "3", "4"]) {
		assert.ok(
			new RegExp(`body\\[data-ds-dark-theme\\][^{}]*\\.ul-heat i\\[data-l="${level}"\\]`).test(css),
			`深色主题缺少 data-l="${level}" 的覆盖规则：深色下这一档会落回浅色主题的色值（浅蓝），` +
				"在深色底上过亮、破坏色阶方向，并且与相邻档位的关系与浅色下完全不同。",
		);
	}
});

test("外观：色阶提取器本身能区分色值（防止正则失效导致假绿）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);

	// 上面的可辨性断言全建立在「提取器真能取到不同颜色」之上。这里自证提取器不是
	// 永远返回同一个值：浅色与深色变体必须不同，且 L1 与 L4 必须明显不同。
	const lightOne = heatRgb(css, light, globals, "1", false);
	const darkOne = heatRgb(css, dark, globals, "1", true);
	assert.notDeepEqual(
		lightOne,
		darkOne,
		"热力图 data-l=\"1\" 在浅色与深色主题下解析出同一个颜色：要么深色变体规则没写（深色下会用浅色色阶），" +
			"要么提取器取错了规则。两种主题必须各自给色。",
	);

	const lightFour = heatRgb(css, light, globals, "4", false);
	assert.ok(
		contrastRatio(lightOne, lightFour) > 1.15,
		"浅色下 data-l=\"1\" 与 data-l=\"4\" 解析出几乎相同的颜色，说明提取器取到的不是各档自己的规则（正则失效），" +
			"上面所有可辨性断言的结论都不可信。",
	);
});

//#endregion

//#region 5. 文字色对比度与警告块的「墨色文字」不变量

/**
 * 从 CSS 里取某条规则的声明体。
 *
 * @param css - 样式模板字符串。
 * @param selector - 要匹配的选择器正则片段（转义由调用方负责）。
 * @returns 声明体原文；找不到时返回 `null`。
 */
function ruleBody(css, selector) {
	const match = css.match(new RegExp(`${selector}[^{}]*\\{([^}]*)\\}`, "m"));
	return match === null ? null : match[1];
}

/**
 * 从声明体里取某个属性的值。
 *
 * @param body - 声明体文本。
 * @param property - 属性名（如 `color`）。
 * @returns 值原文；没有该属性时返回 `null`。
 */
function propertyValue(body, property) {
	if (body === null) return null;
	const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;}]+)`));
	return match === null ? null : match[1].trim();
}

test("外观：正文与次要文字在两种主题下都达到 WCAG AA 4.5:1", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);

	// 正文色由 .ul-root 的 color 决定，子元素靠继承。卡片底色是 bg-layer-2，
	// 面板底色是 bg-layer-1；两者在浅色下同为 #fff、深色下不同，分别核对。
	//
	// token 名**从 CSS 规则里读**，不在这里硬编码：若哪天 .ul-root 的 color 被换成
	// 别的 token，硬编码的期望值会让这条测试继续核对一个「已经不在用」的 token 而全绿。
	const cases = [
		[".ul-root", "正文"],
		[".ul-warn .ul-muted", "警告块内的次要文字"],
	];

	for (const [themeLabel, map] of [["浅色", light], ["深色", dark]]) {
		for (const [selector, role] of cases) {
			const body = ruleBody(css, selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
			const color = propertyValue(body, "color");
			assert.ok(
				color !== null,
				`样式里找不到 ${selector} 的 color 声明：${role}会继承外层颜色，无法保证任何对比度。`,
			);
			const tokenMatch = color.match(/var\(\s*(--dsw-alias-[a-z0-9-]+)/);
			assert.ok(
				tokenMatch !== null,
				`${selector} 的 color 是 \`${color}\`，不是宿主 token：写死的文字色在另一种主题下很可能不可读。`,
			);
			const token = tokenMatch[1];
			const foreground = parseHex(resolveToken(map, globals, token));
			assert.ok(foreground !== null, `宿主${themeLabel}主题的 ${token} 解析不出颜色，无法核对文字对比度。`);
			for (const [surfaceToken, surfaceName] of [
				["--dsw-alias-bg-layer-1", "面板底"],
				["--dsw-alias-bg-layer-2", "卡片底"],
			]) {
				const surface = parseHex(resolveToken(map, globals, surfaceToken));
				assert.ok(surface !== null, `宿主${themeLabel}主题的 ${surfaceToken} 解析不出颜色。`);
				const ratio = contrastRatio(foreground, surface);
				assert.ok(
					ratio >= 4.5,
					`${themeLabel}主题下${role}（${selector} 的 ${token}）在${surfaceName}上的对比度只有 ${ratio.toFixed(2)}:1（WCAG AA 要求 ≥4.5:1）。` +
						"这正是当初的缺陷形态：token 名写错 → var() 静默落到深色专用 fallback → 浅色系统上文字几乎不可见，而没有任何测试或报错提示。",
				);
			}
		}
	}
});

test("外观：警告块文字用正文墨色 token，而不是琥珀文字配琥珀底", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);

	// 这条钉住的**不是**某个具体色值，而是一条不变量：琥珀色只用来表达「这是警告」
	// （底、边），文字必须回到正文墨色。宿主自己的 --dsw-alias-state-warn-label 是给
	// **普通底色**上的琥珀文字用的，铺在 warn-tertiary（amber-100）底上只有约 2.58:1，
	// 比不改更难读——所以「文字是不是墨色 token」才是真正要守的东西。
	const warnBody = ruleBody(css, "\\.ul-warn\\b");
	assert.ok(warnBody !== null, "样式里找不到 .ul-warn 规则：警告块不再有专属样式，未定价提示会退回继承色。");

	const warnColor = propertyValue(warnBody, "color");
	assert.ok(
		warnColor !== null,
		".ul-warn 规则里没有 color：警告文字会继承外层颜色，一旦外层被改成低对比度色（历史上正是如此），" +
			"警告块就成了最难读的地方，而它恰恰是最需要被读到的内容。",
	);

	const inkToken = warnColor.match(/var\(\s*(--dsw-alias-[a-z0-9-]+)/);
	assert.ok(
		inkToken !== null,
		`.ul-warn 的 color 是 \`${warnColor}\`，不是宿主 token：写死颜色的文字在另一种主题下很可能不可读。`,
	);
	assert.ok(
		/^--dsw-alias-label-(primary|secondary)$/.test(inkToken[1]),
		`.ul-warn 的文字色用了 \`${inkToken[1]}\`，不是正文墨色 token（label-primary / label-secondary）。` +
			"琥珀色文字铺在琥珀底上（warn-label 配 warn-tertiary）实测只有约 2.58:1，比不设文字色更难读；" +
			"琥珀色应当只出现在底与边上，文字回到墨色。",
	);

	// 反向核对：警告块的底确实用了 warn 系 token（否则上面这条「墨色文字」可能只是
	// 因为整个警告块被删掉了样式而碰巧成立）。
	const warnBackground = propertyValue(warnBody, "background");
	assert.ok(
		warnBackground !== null && /--dsw-alias-state-warn-/.test(warnBackground),
		`.ul-warn 的背景 \`${warnBackground}\` 不是宿主 warn 语义 token：警告块失去了「这是警告」的视觉信号，` +
			"未定价提示会与普通正文混在一起，用户不会注意到官方价折算偏低。",
	);

	// 警告块内的次要文字也必须显式给色，不能沿用全局 .ul-muted 的低不透明度。
	const mutedBody = ruleBody(css, "\\.ul-warn \\.ul-muted\\b");
	const mutedColor = propertyValue(mutedBody, "color");
	assert.ok(
		mutedColor !== null && mutedColor.startsWith("var(--dsw-alias-"),
		`.ul-warn .ul-muted 没有显式的宿主 token 文字色（当前：\`${mutedColor}\`）：` +
			"它会继承全局 .ul-muted 的低不透明度，在琥珀底上掉回低对比度，警告里的模型清单读不清。",
	);

	// 实际对比度核对：警告块的文字在其琥珀底上必须 ≥4.5:1（两种主题各算一次）。
	for (const [themeLabel, map] of [["浅色", light], ["深色", dark]]) {
		const foreground = parseHex(resolveToken(map, globals, inkToken[1]));
		const background = parseHex(resolveToken(map, globals, warnBackground.match(/var\(\s*(--dsw-alias-[a-z0-9-]+)/)[1]));
		assert.ok(foreground !== null && background !== null, `${themeLabel}主题下警告块的前景/背景解析不出颜色。`);
		const ratio = contrastRatio(foreground, background);
		assert.ok(
			ratio >= 4.5,
			`${themeLabel}主题下警告块文字（${inkToken[1]}）在警告底上的对比度只有 ${ratio.toFixed(2)}:1（要求 ≥4.5:1）。` +
				"未定价提示是用户判断「官方价折算能不能信」的唯一依据，读不清等于这个警告不存在。",
		);
	}
});

//#endregion

//#region 5b. 次要文字不得用 opacity 调暗（同批修复的回归保护）

/**
 * 转义选择器里的正则元字符。
 *
 * @param selector - CSS 选择器片段。
 * @returns 可安全嵌入 `RegExp` 的字符串。
 */
function escapeSelector(selector) {
	return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 规范化选择器：组合符两侧不留空白，连续空白压成一个空格。
 *
 * 规范化之后才能按「选择器相等」比较：源码里写成 `.ul-sec > h4 .hint` 还是
 * `.ul-sec>h4 .hint` 是排版自由，不该决定断言是否命中。
 *
 * @param selector - 原始选择器文本。
 * @returns 规范化后的选择器。
 */
function normalizeSelector(selector) {
	return selector.replace(/\s*([>+~])\s*/g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * 把样式模板拆成「选择器列表 + 声明体」的规则数组。
 *
 * 注释先整体剥掉：解释本次修复的那段中文注释里就写着 `.ul-muted` 这个名字，若不去掉，
 * 注释文字会被并进后一条规则的选择器，匹配结果将无法解释。
 *
 * 本模板没有 `@media` 嵌套。真出现嵌套时，这个正则仍会扫到内层规则（只是丢掉外层
 * 条件），对「禁止用 opacity 调暗文字」而言这是宁可多报、不可漏报的方向。
 *
 * @param css - 样式模板字符串。
 * @returns `[{selectors, body}]`，按文档顺序。
 */
function cssRules(css) {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selectors = match[1].split(",").map(normalizeSelector).filter((selector) => selector.length > 0);
		if (selectors.length > 0) rules.push({ selectors, body: match[2] });
	}
	return rules;
}

/**
 * 判断一条规则的选择器列表里是否有条目命中目标选择器。
 *
 * 按简单选择器边界匹配：目标前必须是开头或组合符/空白，后不能紧跟 `\w` 或 `-`。
 * 于是 `.ul-foot` 不会误命中 `.ul-footer`；而 `.ul-muted` 会命中 `.ul-warn .ul-muted`
 * 与 `.ul-muted:hover`——后代与伪类同样作用在这些文字上，必须一起守。
 *
 * @param selectors - 规则的选择器列表（已规范化）。
 * @param target - 目标选择器（如 `.ul-muted`）。
 * @returns 是否命中。
 */
function matchesSelector(selectors, target) {
	const pattern = new RegExp(`(?:^|[\\s>+~])${escapeSelector(target)}(?![\\w-])`);
	return selectors.some((selector) => pattern.test(selector));
}

/**
 * 取某条规则体里的 opacity 是否**真的调暗**了内容。
 *
 * `opacity:1` 是无操作，`.ul-warn .ul-muted` 正是用 `opacity:1` 覆盖掉全局 `.ul-muted`
 * 的历史低不透明度，不能把它当成缺陷。所以这里解析成数字：只有小于 1 才算调暗；
 * 非数字（例如 `var(...)`）无法静态证明无害，按调暗处理，并交给失败信息解释。
 *
 * @param body - 规则体文本。
 * @returns `{raw, dims}`；没有 opacity 时 `raw` 为 `null`、`dims` 为 `false`。
 */
function opacityDims(body) {
	const raw = propertyValue(body, "opacity");
	if (raw === null) return { raw: null, dims: false };
	const numeric = Number.parseFloat(raw);
	if (!Number.isFinite(numeric)) return { raw, dims: true };
	return { raw, dims: numeric < 1 };
}

/**
 * 取某个选择器按层叠生效的某个属性值。
 *
 * 同一选择器可能有多条规则（`.ul-table th` 就有一条给 color、另一条给 cursor），
 * 后面的声明覆盖前面的——与浏览器一致。只看第一条规则会误报「没有 color」。
 *
 * @param rules - {@link cssRules} 的结果。
 * @param selector - 目标选择器（精确相等）。
 * @param property - 属性名。
 * @returns 生效值；没有任何匹配规则或该属性时返回 `null`。
 */
function cascadedValue(rules, selector, property) {
	let value = null;
	for (const rule of rules) {
		if (!rule.selectors.includes(selector)) continue;
		const declared = propertyValue(rule.body, property);
		if (declared !== null) value = declared;
	}
	return value;
}

/**
 * 取某个选择器按层叠生效的**有效 opacity 数值**。
 *
 * 返回 `null` 表示这条选择器自身没有声明 opacity（即 1，不调暗）。非数值（例如
 * `var(...)`）无法静态求值，按「可能调暗」处理并返回 `0`——宁可让断言在信息里说明
 * 「这里读不出数值」，也不能把它当无害的 1 放过。
 *
 * @param rules - {@link cssRules} 的结果。
 * @param selector - 目标选择器（精确相等）。
 * @returns opacity 数值，或 `null`（未声明）。
 */
function cascadedOpacity(rules, selector) {
	const raw = cascadedValue(rules, selector, "opacity");
	if (raw === null) return null;
	const numeric = Number.parseFloat(raw);
	return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * 按 CSS 选择器里最后一个复合选择器的**祖先链**收集生效 opacity。
 *
 * 关键点：`opacity` 不是继承属性，但它作用在**整个子树**上——父元素设了
 * `opacity:.85`，子元素里的文字也会被一并按 85% 与背景混色。历史上
 * `.ul-sec>h4{opacity:.85}` 就是这样把它的子元素 `.hint` 从 5.80:1 拖到 4.15:1 的，
 * 而测试只读 `.hint` 自己的 color，算出 5.80 判 PASS——**测错了对象**。
 *
 * 因此对每个选择器都要沿祖先链累乘：`.ul-sec>h4 .hint` 要同时看 `.ul-sec`、`.ul-sec>h4`
 * 与 `.ul-sec>h4 .hint` 三层。这里不追求完整的 CSS 选择器引擎，只处理本文件用到的
 * 「后代 / 子代组合」形态；每层用 {@link cascadedValue} 精确相等地取声明。
 *
 * @param rules - {@link cssRules} 的结果。
 * @param selector - 目标选择器（如 `.ul-sec>h4 .hint`）。
 * @returns `{factor, parts}`；`factor` 是累乘后的不透明度（1 表示不调暗），
 *   `parts` 是每个真正调暗的祖先/自身选择器说明，供失败信息使用。
 */
function inheritedOpacity(rules, selector) {
	const parts = [];
	let factor = 1;
	// 逐层拼前缀：`.a > .b .c` → `.a`、`.a>.b`、`.a>.b .c`。
	const segments = selector.split(/\s+/).filter((segment) => segment.length > 0);
	for (let index = 1; index <= segments.length; index += 1) {
		const prefix = segments.slice(0, index).join(" ");
		const opacity = cascadedOpacity(rules, prefix);
		if (opacity === null || opacity >= 1) continue;
		factor *= opacity;
		parts.push(`${prefix} 的 opacity:${opacity}`);
	}
	return { factor, parts };
}

/**
 * 把一个颜色按 `alpha` 与背景色混合，得到屏幕上实际显示的颜色。
 *
 * `opacity` 的语义就是「按背景混色」：浅色底上它把文字拉向白色，深色底上拉向深色。
 * 不做这一步，任何「父元素调暗、子元素文字」的对比度都会被算高一档。
 *
 * @param rgb - 前景色 `[r,g,b]`。
 * @param background - 背景色 `[r,g,b]`。
 * @param alpha - 0..1 的不透明度。
 * @returns 混色后的 `[r,g,b]`。
 */
function compositeOver(rgb, background, alpha) {
	if (alpha >= 1) return rgb;
	return rgb.map((channel, index) => Math.round(channel * alpha + background[index] * (1 - alpha)));
}

/**
 * 把某个选择器的文字色按祖先链 opacity 与背景混色后的**有效色**。
 *
 * @param rgb - 文字自身的颜色 `[r,g,b]`。
 * @param background - 文字所在的背景色 `[r,g,b]`。
 * @param rules - {@link cssRules} 的结果。
 * @param selector - 承载文字的选择器。
 * @returns `{rgb, opacity, parts}`。
 */
function effectiveTextColor(rgb, background, rules, selector) {
	const { factor, parts } = inheritedOpacity(rules, selector);
	return { rgb: compositeOver(rgb, background, factor), opacity: factor, parts };
}

/**
 * 承载文字、因而**不得**被 `opacity` 调暗的元素清单。
 *
 * **这是显式清单，不是「全 CSS 禁 opacity」**：`.ul-sec>h4` 的 `opacity:.85` 是标题
 * （实测 12.3:1，可接受）、`.ul-arrow` 的 `.9` 是装饰箭头、`.ul-warn .ul-muted` 的 `1`
 * 是无操作（专门用来覆盖全局 `.ul-muted` 的历史低不透明度）。全量禁用会把它们一起
 * 误伤，而且失败信息只会说「CSS 里有 opacity」，指不出退化的是谁。
 *
 * 每一项是 `[选择器, 角色说明, 必须自带 token 色]`：
 * - 角色说明进失败信息，让人不用回读 CSS 就知道坏在哪。
 * - 第三项为 `true`：该元素必须**显式**给出宿主 token 文字色，不许退回继承
 *   （它是被刻意调暗到次要层级的文字，退回继承就丢了这个层级）。
 * - 第三项为 `false`：该元素本来就靠继承取色（`.ul-title`、`.ul-table td` 等），
 *   对比度按 `.ul-root` 的正文色核算即可。
 *
 * 前 11 项正是本轮从 `opacity` 改成宿主 token 的那批元素，逐条钉住；
 * 后 4 项是同一批之外、但同样承载文字的元素——它们今天没有 opacity，加进去是为了
 * 「下次有人给标题或单元格加 opacity 调暗」也能变红，而不是等下一轮再补。
 */
const DIM_TEXT = [
	[".ul-muted", "次要文字（图例/说明）", true],
	[".ul-legend", "热力图图例文字", true],
	[".ul-foot", "页脚统计口径文字", true],
	[".ul-heatdays", "热力图星期标签", true],
	[".ul-monthrow", "热力图月份标签", true],
	[".ul-sec>h4 .hint", "小节标题旁的范围提示", true],
	[".ul-sort", "可排序表头按钮文字", false],
	[".ul-card .k", "卡片指标名", true],
	[".ul-table th", "表格表头文字", true],
	[".ul-badge .n", "徽章上的 token 数", true],
	[".ul-load", "加载中提示", true],
	[".ul-title", "面板标题", false],
	[".ul-card .v", "卡片指标值", false],
	[".ul-table td", "表格单元格文字", false],
	[".ul-badge .t", "徽章标题文字", false],
];

test("外观：次要文字不得用 opacity 调暗（显式清单，失败时指出退化选择器）", async () => {
	const source = await clientSource();
	const css = cssText(source);
	const rules = cssRules(css);

	// 提取器自检：规则解析若失效，下面的扫描会对着空集合做断言，必然全绿。
	assert.ok(
		rules.length >= 40,
		`样式模板只解析出 ${rules.length} 条规则（预期 ≥40）：规则提取正则已失效，` +
			"下面「禁止用 opacity 调暗文字」的断言正在扫描一个空集合，它的全绿没有意义。",
	);

	// 清单自检：每个选择器都必须真能匹配到规则。写错一个选择器（例如 `.ul-footer`）
	// 会让它永远匹配不到任何 opacity，于是「没有退化」是全绿——但保护也是零。
	// 这条把「清单本身失效」和「代码真的没退化」区分开。
	const unmatched = DIM_TEXT.filter(([selector]) => !rules.some((rule) => matchesSelector(rule.selectors, selector))).map(
		([selector]) => selector,
	);
	assert.equal(
		unmatched.length,
		0,
		`清单里的选择器在样式模板中匹配不到任何规则：${unmatched.join(", ")}。` +
			"选择器拼写与 CSS 已经脱节（例如改名或删除），这些条目对 opacity 的禁令是空转的。",
	);

	const offenders = [];
	for (const [selector, role] of DIM_TEXT) {
		for (const rule of rules) {
			if (!matchesSelector(rule.selectors, selector)) continue;
			const { raw, dims } = opacityDims(rule.body);
			if (dims) offenders.push(`${selector}（${role}）：规则 \`${rule.selectors.join(", ")}\` 上有 opacity:${raw}`);
		}
	}

	// 反向自检：禁止清单必须**窄**。这三个选择器上的 opacity 是本轮刻意保留的——
	// `.ul-sec>h4` 的 .85 是标题（12.3:1）、`.ul-arrow` 的 .9 是装饰箭头、
	// `.ul-warn .ul-muted` 的 1 是无操作（正是用它覆盖掉全局 .ul-muted 的历史低不透明度）。
	// 若有人图省事把它们塞进清单，测试会开始对无害写法报错，最后被人整体删掉——那才是
	// 真正的失守。所以这里把「窄」本身钉住。
	//
	// 注：任务书里提到的 `.ul-sort:hover` 实际**没有** opacity（它只改背景）。这不影响
	// 上面的禁令——`matchesSelector(".ul-sort", …)` 同样命中 `.ul-sort:hover`，将来谁给
	// 悬停态加 opacity 调暗，一样会红。
	for (const allowed of [".ul-sec>h4", ".ul-arrow", ".ul-warn .ul-muted"]) {
		assert.ok(
			!DIM_TEXT.some(([selector]) => selector === allowed),
			`${allowed} 不该出现在 DIM_TEXT 里：它的 opacity 是无害的（标题/装饰/无操作），` +
				"把它列入禁令会让这条断言开始误伤，最终被整体删除，反而丢掉真正的保护。",
		);
	}
	assert.equal(
		offenders.length,
		0,
		`以下文字元素用 opacity 调暗了自己：\n  - ${offenders.join("\n  - ")}\n` +
			"opacity 不是「换一个颜色」，而是「按背景混色」：浅色底上它把文字拉向白色，实测这批元素只有 2.53:1–4.18:1，" +
			"低于 WCAG AA 的 4.5:1，而且不会报任何错。请改用 color:var(--dsw-alias-label-secondary,currentColor)" +
			"（实测 5.80:1 浅色 / 10.42:1 深色）。本断言只针对上面的显式清单：" +
			"`.ul-sec>h4` 的 opacity:.85（标题，12.3:1）、`.ul-arrow` 的 .9（装饰箭头）、" +
			"`.ul-warn .ul-muted` 的 1（无操作）都刻意不在清单内。",
	);
});

test("外观：次要文字在两种主题下都达到 WCAG AA 4.5:1（token 从 CSS 读，不硬编码）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);
	const rules = cssRules(css);

	// 回退色：color:inherit 或没写 color 时，文字实际继承 .ul-root 的正文色
	// （`.ul-sort` 就是 color:inherit）。回退色同样从 CSS 里读，不硬编码 token 名。
	const rootColor = cascadedValue(rules, ".ul-root", "color");
	assert.ok(
		rootColor !== null,
		"找不到 .ul-root 的 color：`inherit` 的回退无从谈起，下面凡是走回退分支的断言都会静默拿到空值。",
	);

	for (const [themeLabel, map] of [["浅色", light], ["深色", dark]]) {
		for (const [selector, role, requireToken] of DIM_TEXT) {
			const declared = cascadedValue(rules, selector, "color");
			// 「没写 color」与「color:inherit」是同一个意思：文字继承外层颜色。按规格回退到
			// `.ul-root` 的正文色再算对比度——回退分支同样受 ≥4.5:1 保护，不是免检通道。
			const inherited = declared === null || declared === "inherit";
			// 清单自检（不依赖另一条用例）：选择器必须真的存在于样式里。否则上面
			// `inherited` 恒为真，这条断言会拿 `.ul-root` 的正文色为一个不存在的元素背书。
			assert.ok(
				rules.some((rule) => matchesSelector(rule.selectors, selector)),
				`样式模板里找不到 ${selector}（${role}）：清单与 CSS 已脱节，这条对比度断言核对的是一个不存在的元素。`,
			);
			if (requireToken) {
				assert.ok(
					!inherited,
					`样式里找不到 ${selector} 的显式宿主 token 文字色（${role}，当前：\`${declared}\`）：` +
						"它是被刻意降到次要层级的文字，退回继承就丢了这个层级；" +
						"而 `inherit` 只是把对比度的责任推给外层，外层一变它就静默失守。",
				);
			}
			const color = inherited ? rootColor : declared;
			// token 名从 CSS 里读，不在这里硬编码 label-secondary：换 token 时这条断言
			// 仍核对「实际在用的那个」，而不是核对一个已经不在用的名字然后全绿。
			const tokenMatch = color.match(/var\(\s*(--dsw-alias-[a-z0-9-]+)/);
			assert.ok(
				tokenMatch !== null,
				`${selector} 的 color 是 \`${color}\`（${role}），不是宿主 token：` +
					"写死的颜色在另一种主题下很可能不可读，而 var() 找不到 token 时又会静默落到 fallback。" +
					"请用宿主语义 token，并给 currentColor 兜底。",
			);
			const token = tokenMatch[1];
			const foreground = parseHex(resolveToken(map, globals, token));
			assert.ok(foreground !== null, `宿主${themeLabel}主题的 ${token} 解析不出字面色，无法核对 ${selector} 的对比度。`);
			// 祖先链上的 opacity 必须累乘进有效色：`.ul-sec>h4` 一旦调暗，它的子元素
			// `.hint` 里的文字会一起被按背景混色，只读子元素自己的 color 会算出偏高的
			// 比值（历史上 5.80:1 → 实测 4.15:1）。这一步就是「测对对象」。
			const dimming = inheritedOpacity(rules, selector);
			// 面板底与卡片底都算一遍：这批文字两种底上都可能出现（卡片指标名在 layer-2 上）。
			for (const [surfaceToken, surfaceName] of [
				["--dsw-alias-bg-layer-1", "面板底"],
				["--dsw-alias-bg-layer-2", "卡片底"],
			]) {
				const surface = parseHex(resolveToken(map, globals, surfaceToken));
				assert.ok(surface !== null, `宿主${themeLabel}主题的 ${surfaceToken} 解析不出颜色。`);
				const shown = compositeOver(foreground, surface, dimming.factor);
				const ratio = contrastRatio(shown, surface);
				assert.ok(
					ratio >= 4.5,
					`${themeLabel}主题下${role}（${selector} 的 ${token}${inherited ? "，经 .ul-root 继承" : ""}` +
						`${dimming.parts.length > 0 ? `，并被 ${dimming.parts.join(" 与 ")} 一并调暗` : ""}）在${surfaceName}上的对比度` +
						`只有 ${ratio.toFixed(2)}:1（WCAG AA 要求 ≥4.5:1）。这正是缺陷的形态：文字被调暗到 4.5:1 以下，` +
						"在浅色系统上读不清，而没有任何测试或控制台报错提示。",
				);
			}
		}
	}
});

test("外观：.ul-err 用正文墨色文字 + 红色语义底，两种主题都达 AA", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);

	// 这条曾经断言「.ul-err 用 state-error-primary 作文字色」。那个 token 本身没问题，
	// 但它的浅色值 red-600 在面板底上实测 4.4976:1——比 WCAG AA 的 4.5 只差 0.0024，
	// 卡在线上。宿主自己用了 76 处这个 token，所以「宿主也这样」不足以让它达标。
	// 改为与 .ul-warn 同款：红色只表达「这是错误」（底），文字回到正文墨色。
	// 这样两种主题都有充足余量，且不再有一条卡在阈值边缘的断言。
	const body = ruleBody(css, "\\.ul-err\\b");
	assert.ok(body !== null, "样式里找不到 .ul-err 规则：错误提示会继承正文色，用户无法把它与普通文字区分。");

	const color = propertyValue(body, "color");
	assert.ok(color !== null, ".ul-err 没有 color：错误提示与正文同色，「这是错误」这个信号消失。");
	const inkToken = color.match(/var\(\s*(--dsw-alias-[a-z0-9-]+)/);
	assert.ok(
		inkToken !== null,
		`.ul-err 的 color 是 \`${color}\`，不是宿主 token：历史上写的是硬编码 #e46a6a，` +
			"在浅色面板底上只有 3.20:1，低于 WCAG AA 的 4.5:1——错误提示反而是最难读的一行。",
	);
	assert.ok(
		/^--dsw-alias-label-(primary|secondary)$/.test(inkToken[1]),
		`.ul-err 的文字色用了 \`${inkToken[1]}\`，不是正文墨色 token（label-primary / label-secondary）。` +
			"把语义色 token 当文字色用会重演「琥珀字铺琥珀底」那类低对比度：state-error-primary 的浅色值" +
			"在白底上只有 4.4976:1，卡在 AA 线边缘。红色应当只出现在底上。",
	);

	// 反向核对：错误块的底确实用了红色语义 token（否则上面「墨色文字」可能只是因为
	// 整个规则被删掉而碰巧成立）。
	const background = propertyValue(body, "background");
	assert.ok(
		background !== null && /var\(\s*--dsw-alias-/.test(background),
		`.ul-err 的 background 是 \`${background}\`，不是宿主 token：错误提示失去「这是错误」的视觉信号。`,
	);

	// 实测对比度：两种主题下都必须 ≥4.5:1，这次有充足余量（浅 15.80 / 深 14.31），
	// 不再是卡线断言。
	for (const [themeLabel, map] of [["浅色", light], ["深色", dark]]) {
		const foreground = parseHex(resolveToken(map, globals, inkToken[1]));
		assert.ok(foreground !== null, `宿主${themeLabel}主题的 ${inkToken[1]} 解析不出字面色。`);
		const backgroundToken = background.match(/var\(\s*(--dsw-alias-[a-z0-9-]+)/)[1];
		const backgroundRgb = parseHex(resolveToken(map, globals, backgroundToken));
		assert.ok(backgroundRgb !== null, `宿主${themeLabel}主题的 ${backgroundToken} 解析不出字面色。`);
		const ratio = contrastRatio(foreground, backgroundRgb);
		assert.ok(
			ratio >= 4.5,
			`${themeLabel}主题下 .ul-err 文字（${inkToken[1]}）在错误底（${backgroundToken}）上的对比度只有 ` +
				`${ratio.toFixed(2)}:1（WCAG AA 要求 ≥4.5:1）。错误提示是用户唯一能看到的失败原因，读不清等于没报错。`,
		);
	}
});

//#endregion

//#region 5c. 面板细节不变量（选中态药丸 / 进度条强调色 / 面板描边层级）

/**
 * 从一条声明值里取出宿主 token 名。
 *
 * 只认 `var(--dsw-alias-*)` 形态：写死字面色的地方返回 `null`，让调用方把
 * 「用了字面色」这件事显式报出来，而不是静默拿到一个 token 名。
 *
 * @param value - 声明值原文（如 `var(--dsw-alias-brand-primary)`）。
 * @returns token 名；不是宿主 token 引用时返回 `null`。
 */
function aliasToken(value) {
	const match = String(value ?? "").match(/var\(\s*(--dsw-alias-[a-z0-9-]+)/);
	return match === null ? null : match[1];
}

/**
 * 取某个选择器按层叠生效的宿主 token 名，并解析成当前主题下的字面色。
 *
 * @param rules - {@link cssRules} 的结果。
 * @param selector - 目标选择器（精确相等）。
 * @param property - 属性名。
 * @param map - 当前主题的 token 映射。
 * @param globals - 主题包全量 token。
 * @param label - 失败信息里用的说明。
 * @returns `{token, rgb}`。
 */
function tokenRgb(rules, selector, property, map, globals, label) {
	const value = cascadedValue(rules, selector, property);
	const token = aliasToken(value);
	assert.ok(
		token !== null,
		`${label}（${selector} 的 ${property}）当前是 \`${value}\`，不是宿主 token：` +
			"写死的颜色在另一种主题下很可能不可读，而 var() 找不到 token 时又会静默落到 fallback。",
	);
	const rgb = parseHex(resolveToken(map, globals, token));
	assert.ok(rgb !== null, `${label} 的 token \`${token}\` 解析不出字面色，无法核对不变量。`);
	return { token, rgb };
}

/**
 * 一个颜色的「彩度」（最大通道减最小通道）。
 *
 * 宿主的 `brand-primary` 是**墨色**（浅色下 #0f1115、深色下 #f9fafb），彩度只有个位数；
 * 而 `state-business-primary` 是真正的蓝色相（#4176e6 / #7aaaff），彩度 100+。用彩度
 * 区分「强调色相 token」与「墨色 token」比钉字面 token 名更耐久——宿主换一个同样有彩度
 * 的强调 token 时断言仍然成立，而把强调色换成墨色时立刻变红。
 *
 * @param rgb - `[r,g,b]`。
 * @returns 0–255 的彩度。
 */
function chroma(rgb) {
	return Math.max(...rgb) - Math.min(...rgb);
}

test("外观：选中态药丸有专属规则（选择器真的命中 data-on=\"1\"），且前景/背景在两种主题下可读", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);
	const rules = cssRules(css);

	// 面板渲染出的按钮把选中态写成 data-on="1"（见 client.test.js 的行为断言）。
	// 这里钉住「这个属性值真的有一条 CSS 规则接住」——选择器一旦改名，药丸会静默
	// 退回未选中样式（透明底 + 继承色），用户看不出当前在哪个范围，而没有任何报错。
	const SELECTED = '.ul-tab[data-on="1"]';
	assert.ok(
		rules.some((rule) => rule.selectors.includes(SELECTED)),
		`样式里找不到 ${SELECTED} 规则：选中的范围标签会与未选中的长得一样，` +
			"用户无法判断当前看的是「今日」还是「累计」——这正是本轮验证者用改名变异体活捉的盲区。",
	);

	for (const [themeLabel, map] of [["浅色", light], ["深色", dark]]) {
		const panel = parseHex(resolveToken(map, globals, "--dsw-alias-bg-layer-1"));
		assert.ok(panel !== null, `宿主${themeLabel}主题 --dsw-alias-bg-layer-1 解析不出颜色。`);
		const { token: bgToken, rgb: background } = tokenRgb(rules, SELECTED, "background", map, globals, "选中态药丸底色");
		const { token: fgToken, rgb: foreground } = tokenRgb(rules, SELECTED, "color", map, globals, "选中态药丸文字色");

		// 药丸是实心的：它必须与面板底明显不同，否则「选中」这个状态不可见。
		const vsPanel = contrastRatio(background, panel);
		assert.ok(
			vsPanel > 1.15,
			`${themeLabel}主题下选中态药丸底色（${bgToken}）相对面板底色的对比度只有 ${vsPanel.toFixed(3)}:1（要求 >1.15）：` +
				"药丸融进面板背景，「当前选中的范围」这个状态在视觉上消失。",
		);

		// 药丸里的文字必须读得清（它是按钮，字号只有 12px，AA 要求 4.5:1）。
		const textRatio = contrastRatio(foreground, background);
		assert.ok(
			textRatio >= 4.5,
			`${themeLabel}主题下选中态药丸文字（${fgToken}）在药丸底色（${bgToken}）上的对比度只有 ${textRatio.toFixed(2)}:1` +
				"（WCAG AA 要求 ≥4.5:1）：范围标签读不清，用户看不出自己在看哪个范围。",
		);
	}
});

test("外观：进度条填充用强调色相 token，不得用墨色 brand-primary（语义错误）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);
	const rules = cssRules(css);

	// 宿主的 brand-primary 是**墨色/对比色**（浅色下近黑、深色下近白），不是色相。
	// 把它当进度条填充用，条会变成一根黑/白棒：色阶方向随主题反转，而且与宿主强调色
	// 体系脱节——T7 在热力图上抓到的正是同一类错误。强调要用 state-business-primary。
	for (const [themeLabel, map] of [["浅色", light], ["深色", dark]]) {
		const { token: fillToken, rgb: fill } = tokenRgb(rules, ".ul-bar>span", "background", map, globals, "进度条填充");
		const brand = parseHex(resolveToken(map, globals, "--dsw-alias-brand-primary"));
		assert.ok(brand !== null, `宿主${themeLabel}主题 --dsw-alias-brand-primary 解析不出颜色。`);

		// 关系式不变量，而不是钉 token 名：强调色必须**有彩度**，而墨色 token 必须没有。
		assert.ok(
			chroma(fill) >= 40,
			`${themeLabel}主题下进度条填充（${fillToken}）的彩度只有 ${chroma(fill)}：` +
				"它不是一个有色相的强调色，而是一根黑/白棒。宿主的 brand-primary 是墨色 token" +
				"（浅色 #0f1115 / 深色 #f9fafb），彩度个位数——用它当填充会让进度条与主题强调色体系脱节，" +
				"深浅两色下视觉方向还会反转。强调请用有彩度的 state-business-* 系 token。",
		);
		assert.ok(
			chroma(brand) < 20,
			`宿主 brand-primary 的彩度是 ${chroma(brand)}，不再是墨色：` +
				"上面那条「填充必须有彩度」的区分度可能已经失效，请复核这条断言的前提。",
		);
		assert.notEqual(
			fillToken,
			"--dsw-alias-brand-primary",
			`进度条填充直接用了墨色 token --dsw-alias-brand-primary：它表达的是「正文/对比色」，不是「强调」。`,
		);
	}
});

test("外观：面板描边不弱于卡片描边（面板轮廓必须比卡片更强）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { light, dark, globals } = themeMaps(theme);
	const css = cssText(source);
	const rules = cssRules(css);

	// 宿主把描边分成四级：l1 < l2 < l3 < l4（alpha 递增）。面板是浮层、卡片是面板里的
	// 一块，浮层轮廓不能比它包住的卡片还弱，否则面板会「沉」进页面背景，边界消失。
	// 断言的是**层级关系**而不是字面 token：宿主调整 alpha 数值不影响它。
	const tier = (name) => {
		const match = String(name ?? "").match(/border-l([1-4])$/);
		return match === null ? null : Number(match[1]);
	};

	for (const [themeLabel, map] of [["浅色", light], ["深色", dark]]) {
		const panelToken = aliasToken(cascadedValue(rules, ".ul-panel", "border"));
		const cardToken = aliasToken(cascadedValue(rules, ".ul-card", "border"));
		assert.ok(panelToken !== null, `.ul-panel 的 border 不是宿主 token：面板轮廓在另一种主题下可能消失。`);
		assert.ok(cardToken !== null, `.ul-card 的 border 不是宿主 token：卡片边界在另一种主题下可能消失。`);

		const panelTier = tier(panelToken);
		const cardTier = tier(cardToken);
		assert.ok(
			panelTier !== null && cardTier !== null,
			`面板/卡片的描边 token（${panelToken} / ${cardToken}）不在 border-l1..l4 分级里：` +
				"无法比较强弱，这条断言的前提需要复核。",
		);
		assert.ok(
			panelTier >= cardTier,
			`${themeLabel}主题下面板描边是 ${panelToken}（l${panelTier}），卡片描边是 ${cardToken}（l${cardTier}）：` +
				"浮层轮廓比它包住的卡片还弱，面板会沉进页面背景、边界消失。面板应使用不低于卡片的描边层级。",
		);

		// 解析一次，确保 token 真的能落到颜色（防止 token 名写错时这条断言假绿）。
		assert.ok(parseHex(resolveToken(map, globals, panelToken)) !== null, `宿主${themeLabel}主题 ${panelToken} 解析不出颜色。`);
		assert.ok(parseHex(resolveToken(map, globals, cardToken)) !== null, `宿主${themeLabel}主题 ${cardToken} 解析不出颜色。`);
	}
});

test("外观：面板真的声明了宿主 elevation 阴影（token 存在性断言看不见「被删掉的使用」）", async (t) => {
	if (!THEME_PRESENT) {
		skipMissingTheme(t);
		return;
	}

	const source = await clientSource();
	const theme = await themeSource();
	const { globals } = themeMaps(theme);
	const css = cssText(source);
	const rules = cssRules(css);

	// 「token 存在性」那条断言只能证明**出现的** token 名有定义；它看不见**被删掉的**
	// 使用。把 `box-shadow:var(--dsw-elevation-panel)` 换成 `box-shadow:none` 后，
	// 源码里再无该 token 名，存在性检查直接跳过——面板就此变成一块没有阴影的平板，
	// 浮层与页面背景失去层次，而 86 条测试全绿。所以这里正面钉住「面板有 elevation 阴影」。
	const shadow = cascadedValue(rules, ".ul-panel", "box-shadow");
	assert.ok(
		shadow !== null,
		".ul-panel 没有 box-shadow：浮层与页面背景之间失去层次，面板看起来像贴在页面上的普通区块，" +
			"而「面板是浮层」正是它作为 role=dialog 的视觉前提。",
	);
	assert.notEqual(shadow, "none", ".ul-panel 的 box-shadow 被设成 none：等于主动关掉了宿主 elevation，浮层不再浮起来。");

	// 断言的是**宿主 elevation 语义**，而不是某个具体 token 名：宿主换一代 elevation
	// token（prominent/soft）时这条仍然成立，而换成随便一个字面阴影就会红。
	const elevation = shadow.match(/var\(\s*(--dsw-elevation-[a-z0-9-]+)/);
	assert.ok(
		elevation !== null,
		`.ul-panel 的 box-shadow 是 \`${shadow}\`，不是宿主 elevation token：` +
			"写死的阴影无法跟随宿主主题（深色下浅色阴影会变成脏边），也失去了与宿主其它浮层的一致性。",
	);
	assert.ok(
		globals.has(elevation[1]),
		`宿主主题包全量 token 里没有 \`${elevation[1]}\`：阴影 token 名写错时 var() 会静默失效，` +
			"box-shadow 整条声明被丢弃，面板同样失去浮层效果且不报错。",
	);
});

//#endregion

//#region 6. 键盘可达性

test("外观：注释剥离器自身有效（源码里真的存在会被误命中的注释）", async () => {
	const raw = await clientSource();
	const code = await codeSource();

	// 这条是上面所有「源码里必须出现 X」断言的地基。`src/client.js` 里真实存在一句
	// 注释写着 tabIndex:-1，而实现 `tabIndex: -1,` 在下一行；若剥离器失效，
	// 删掉实现也照样全绿——这正是本轮验证者抓到的假实现。
	//
	// 两个方向都钉住：注释**必须**还在源码里（否则剥离器就没有被验证过，
	// 「删掉注释让测试变绿」会变成一条不被发现的捷径），而剥离后的代码里**必须**没有它。
	assert.ok(
		/\/\/\s*tabIndex:\s*-1/.test(raw),
		"源码里找不到 `// tabIndex:-1 …` 这句注释：它正是「正则命中注释而非实现」的反例，" +
			"把它删掉会让下面的自检失去意义（剥离器是否有效不再被验证）。",
	);
	assert.ok(
		!/tabIndex:\s*-1\s*让容器/.test(code),
		"剥离注释后代码里仍残留 `tabIndex:-1 让容器…`：注释剥离器已经失效，" +
			"所有「源码里出现某字符串」的断言都在扫注释，它们全绿不能说明实现存在。",
	);

	// 剥离器不能把代码一起吃掉：真正的实现必须在剥离后的代码里。
	assert.ok(
		/tabIndex:\s*-1/.test(code),
		"剥离注释后代码里找不到 `tabIndex: -1`：要么实现真的没了，要么剥离器吃掉了代码。",
	);
});

test("外观：可排序表头暴露 aria-sort，且真的接到排序状态上", async () => {
	const source = await codeSource();

	assert.ok(
		source.includes('"aria-sort"'),
		"源码里找不到 \"aria-sort\"：屏幕阅读器无法告知「当前按哪一列、哪个方向排序」，" +
			"视觉上的 ↑/↓ 对辅助技术完全不可见，键盘/读屏用户只能靠猜。",
	);

	// 出现字符串不等于接线：必须是三态之一，并且由排序状态驱动。
	// 只写死一个值（例如永远 "none"）会让读屏永远听到「未排序」。
	const ascending = /"ascending"/.test(source);
	const descending = /"descending"/.test(source);
	assert.ok(
		ascending && descending,
		`aria-sort 没有三态接线（ascending=${ascending}, descending=${descending}）：` +
			"读屏软件永远读不到真实排序方向，表头的视觉箭头与无障碍语义不一致。",
	);
	assert.ok(
		/"none"/.test(source),
		"源码里找不到 \"none\"：未激活的列必须显式声明 aria-sort=\"none\"，否则读屏会把旧方向沿用下去。",
	);
});

test("外观：可排序表头是真实 button，键盘可以 Tab 到并回车触发", async () => {
	const source = await codeSource();

	// 只在 th 上挂 onClick 的表头对键盘不可达：Tab 停不上去，回车也没有反应。
	// 原生 <button type="button"> 自带 Tab 与 Enter/Space 语义，不需要任何依赖。
	assert.ok(
		/type:\s*"button"/.test(source),
		"源码里找不到 `type: \"button\"` 的可排序表头按钮：排序只能鼠标点击，键盘用户到不了、也触发不了。" +
			"请把 onClick 放在原生 <button type=\"button\"> 上，而不是 <th> 上。",
	);
});

test("外观：面板是 role=dialog + aria-modal + aria-label", async () => {
	const source = await codeSource();

	assert.ok(
		/role:\s*"dialog"/.test(source),
		"面板容器没有 role=\"dialog\"：读屏软件不会把它当成对话框，背景内容也不会被标记为不可用，" +
			"键盘/读屏用户无法感知「这里打开了一个浮层」。",
	);
	assert.ok(
		/"aria-modal":\s*"true"/.test(source),
		"面板没有 aria-modal=\"true\"：读屏仍会读到面板背后的宿主内容，用户会以为自己没离开页面。",
	);
	assert.ok(
		/"aria-label":\s*"[^"]+"/.test(source),
		"面板没有非空的 aria-label：对话框没有可读名字，读屏只会念出「对话框」而说不出这是「用量账本」。",
	);
});

test("外观：Esc 键真的会关闭面板（keydown 处理接线到关闭回调）", async () => {
	const source = await codeSource();

	assert.ok(
		/event\.key\s*===\s*"Escape"/.test(source),
		"源码里找不到 `event.key === \"Escape\"`：Esc 关不掉面板，键盘用户必须去找鼠标点 ×，" +
			"这对只能用键盘的人等于关不上浮层。",
	);

	// 光判断按键还不够：必须真的调用关闭回调，否则就是「监听器在、什么也不做」。
	const escapeBlock = source.match(/event\.key\s*===\s*"Escape"[\s\S]{0,240}?\n\t{3}\}/);
	assert.ok(
		escapeBlock !== null && /onClose\s*\(/.test(escapeBlock[0]),
		"Esc 的分支里没有调用 onClose()：按键被识别了却什么都不发生，面板依然关不掉——" +
			"这是「写了字符串但没接线」的假实现，正则命中 Escape 并不代表功能可用。",
	);

	assert.ok(
		/onKeyDown/.test(source),
		"源码里找不到 onKeyDown：没有任何元素监听键盘事件，上面的 Esc 分支是死代码。",
	);
});

test("外观：焦点进得来也回得去（打开聚焦面板、关闭归还徽章）", async () => {
	const source = await codeSource();

	assert.ok(
		/panelRef\.current\?\.focus\(\)/.test(source),
		"打开面板时没有把焦点移入面板：键盘用户 Tab 之后仍停在徽章上，面板里的按钮要按很多次 Tab 才能到，" +
			"读屏用户甚至不知道面板已经打开。",
	);

	// 关闭后焦点必须回到触发它的徽章，否则焦点会掉回 <body>，键盘用户丢失位置。
	const focusBack = /badgeRef\.current\?\.focus\(\)/.test(source);
	assert.ok(
		focusBack,
		"关闭面板后没有把焦点归还给徽章：焦点会落回文档根节点，键盘用户丢失当前位置，" +
			"需要从头再 Tab 一遍才能回到刚才的地方。",
	);

	assert.ok(
		/tabIndex:\s*-1/.test(source),
		"面板容器没有 tabIndex: -1：无法被程序化聚焦（focus() 不生效），上面的「打开时移入焦点」实际是空转。",
	);
});

test("外观：键盘焦点可见（:focus-visible 用宿主 token 描边）", async () => {
	const source = await clientSource();
	const css = cssText(source);

	assert.ok(
		/:focus-visible/.test(css),
		"样式里没有 :focus-visible：键盘焦点没有任何视觉反馈，用户看不出当前停在哪个按钮上，" +
			"只能盲按。焦点可见是键盘可达性的前提，不是装饰。",
	);

	const focusRule = css.match(/:focus-visible[^{}]*\{([^}]*)\}/);
	assert.ok(focusRule !== null, "找到了 :focus-visible 选择器但取不到规则体，提取正则需要同步更新。");
	assert.ok(
		/outline\s*:/.test(focusRule[1]),
		`:focus-visible 规则里没有 outline：焦点样式没有实际可见的描边（例如只改了背景色，在两种主题下都可能看不出来）。规则体：\`${focusRule[1].trim()}\``,
	);
});

//#endregion
