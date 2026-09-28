/**
 * 窄视口横向溢出回归测试（真实 Chrome，零依赖）。
 *
 * ## 这个文件守的是什么
 *
 * Issue #4：`.ul-panel` 同时有 `width` 与 `padding`，而 `box-sizing` 是默认的
 * `content-box` —— padding 与 border 被**加在** `width` 之外。面板又是
 * `position:fixed`，所以多出来的那 34px：
 *
 * - 不会撑出 `body` 滚动条；
 * - 不会进 `document.documentElement.scrollWidth`；
 * - 它只是被视口**切掉**。页面看起来"没坏"，右侧内容却根本看不到。
 *
 * ## 为什么必须用真实浏览器，而不是读源码断言 CSS
 *
 * `test/appearance.test.js` 那种「读源码 + 正则」的手法在这里**证明不了任何事**：
 * 它能核对 `.ul-panel` 里有没有 `box-sizing:border-box` 这串文本，但核对不了
 * 「480px 视口下面板右边缘到底在不在视口内」。后者是布局引擎算出来的，只有真的
 * 摆一次才知道。本仓库已经吃过一次「断言测不到真问题」的亏（见 `test/payload.test.js`
 * 开头对 `grep -rn buildPayload test/` 零命中的记录），这里不重蹈覆辙。
 *
 * ## 修复前基线（10 列、CSS 未修，真实 Chrome 实测）
 *
 * | 视口 | panel.right | innerWidth | 越界 | panelScrollsX | body.scrollWidth |
 * |------|-------------|------------|------|---------------|------------------|
 * | 480  | 502         | 480        | +22  | false         | 464              |
 * | 768  | 790         | 768        | +22  | false         | 752              |
 * | 900  | 806         | 900        | -94  | false         | 884              |
 * | 1400 | 806         | 1400       | -594 | false         | 1384             |
 *
 * **请特别注意 480 那一行**：`panel.right = 502` 与 `body.scrollWidth = 464`
 * **同时成立**。这正是本 issue 最阴的地方——面板确实越出了视口 22px，但 `body`
 * 的滚动宽度比视口还窄，任何基于 `body.scrollWidth` 的断言都会**放行**这个 bug。
 * 所以本文件的主断言是 `getBoundingClientRect()`，不是滚动宽度。
 *
 * 上表的 502/790 是**完全没有修复**（既无 `box-sizing` 也无 `@media`）时的数字。
 * 还有一个容易与它混淆的数字：**加了 `box-sizing`、把 `width` 改成 `auto`、但
 * `right` 仍不设** 时 480px 的右边缘是 **556**（`fixed` 元素在 `left` 有值、
 * `right:auto`、`width:auto` 时收缩成内容宽，实测 computed width 544px）。
 * 502 与 556 属于两个不同的中间状态，`src/client.js` 的注释里说的正是
 * 556 那个状态——别再把两者当成同一个数（这正是 #4 验收发现的注释错配）。
 * （另注：`right:0` 才是防越界的那条；`left:0` 是为了不在窄屏上白留 12px。
 * 这条区分也写进了 `src/client.js` 的注释。）
 *
 * ## 为什么还要单独守 @media 块
 *
 * 只加 `box-sizing:border-box`（把 `@media` 整块删掉）就已经让四档全部落在视口内
 * —— 主断言无法区分「两处修复都在」与「只有 box-sizing」。而 `@media` 确实改变
 * 了窄视口的几何：480px 下面板从 `left:12/right:468` 变成 `left:0/right:480`、
 * 下边距从 64px 变成 8px。这些行为若无断言守护，`@media` 就是一段测不到的代码
 * ——它哪天被删掉，测试照样全绿。下面的 @media 用例就是为此存在的：
 * 它**刻意与「不越界」无关**（两种状态都不越界），只钉住断点内外的几何差异。
 *
 * ## Chrome 缺失时必须显式 skip
 *
 * 与 `test/appearance.test.js` 一致：读不到浏览器就 `t.skip()` 并说明原因，
 * **绝不**让它假装通过。「这台机器没装 Chrome」与「布局是对的」是两回事。
 *
 * 因此本文件**必须能被单独调用**（`node --test test/viewport.test.js`）：
 * `.github/workflows/test.yml` 的主 job 有一道「skipped 必须为 0」的硬闸门，
 * 浏览器用例在主 job 里 skip 会误杀它。CI 上请用独立 job 跑本文件。
 *
 * @module usage-ledger/test/viewport
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { buildPayload } from "../src/index.js";

/** `src/client.js` 的位置：被测的是**仓库里这一份**，不是任何副本。 */
const CLIENT_URL = new URL("../src/client.js", import.meta.url);

/** 四档视口宽度。480 与 768 是修复前真正越界的两档，900/1400 用来防「修窄了撑宽」。 */
const VIEWPORTS = [480, 768, 900, 1400];

/**
 * 找可用的 Chrome。
 *
 * 先看显式环境变量（CI 或非常规安装布局用它指路），再扫常见绝对路径，最后扫
 * `PATH`。全程 `existsSync`，不依赖 `which`，也不装任何包。
 *
 * @returns 可执行文件路径；一个都没有时为 `null`。
 */
function findChrome() {
	const explicit = [process.env.CHROME_BIN, process.env.CHROME_PATH];
	const absolute = [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/opt/google/chrome/chrome",
		"/snap/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	];
	const onPath = (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => entry.length > 0)
		.flatMap((entry) => ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((name) => join(entry, name)));
	for (const candidate of [...explicit, ...absolute, ...onPath]) {
		if (typeof candidate === "string" && candidate.length > 0 && existsSync(candidate)) return candidate;
	}
	return null;
}

/** 本机的 Chrome；为 `null` 时所有用例显式 skip。 */
const CHROME = findChrome();

/** 源码只读一次。 */
const clientSource = () => readFileSync(CLIENT_URL, "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 找一个空闲端口给 Chrome 的调试端口。
 *
 * @returns 端口号。
 */
async function freePort() {
	const { createServer: netServer } = await import("node:net");
	return await new Promise((resolve, reject) => {
		const probe = netServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

/**
 * 起一个极小的 HTTP 源。
 *
 * **这一步不能省。** Chrome 直接起在 `about:blank` 上时，页面处于**不透明源**，
 * 读 `window.localStorage` 会抛 `SecurityError`；而 `Panel` 挂载时会走
 * `loadRange()` 读上次选择的范围，于是整个渲染在装桩阶段就崩了。
 * 先起一个 http 源、再 `Page.navigate` 过去，才有可用的 `localStorage`。
 *
 * @returns `{url, close}`。
 */
async function startOriginServer() {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<!doctype html><html><head><meta charset='utf-8'><title>ul-viewport</title></head><body></body></html>");
	});
	await new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * 极简 CDP 客户端。
 *
 * Node 22+ 自带全局 `WebSocket`，所以驱动 Chrome 不需要 puppeteer：
 * 连上 `webSocketDebuggerUrl`，发 `Runtime.evaluate` 就够了。
 */
class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 0;
		this.pending = new Map();
		this.onEvent = () => {};
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined && this.pending.has(message.id)) {
				const { resolve, reject } = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.error) reject(new Error(`CDP ${message.error.message}`));
				else resolve(message.result);
				return;
			}
			if (message.method) this.onEvent(message);
		});
	}

	/**
	 * 连上调试端点。
	 *
	 * @param url - `webSocketDebuggerUrl`。
	 * @returns `Cdp` 实例。
	 */
	static async connect(url) {
		const socket = new WebSocket(url);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", () => reject(new Error("无法连接 Chrome 调试端点")), { once: true });
		});
		return new Cdp(socket);
	}

	/**
	 * 发一条 CDP 命令。
	 *
	 * @param method - 命令名。
	 * @param params - 参数。
	 * @returns 命令结果。
	 */
	send(method, params = {}) {
		const id = (this.nextId += 1);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP 命令超时：${method}`));
				}
			}, 20_000);
		});
	}

	/**
	 * 在页面里求值。
	 *
	 * @param expression - 表达式文本。
	 * @returns 求值结果（按值返回）。
	 */
	async eval(expression) {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
		if (result.exceptionDetails) {
			const description = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
			throw new Error(`页面内异常：${description}`);
		}
		return result.result.value;
	}

	/** 关掉 WebSocket。 */
	close() {
		try {
			this.socket.close();
		} catch {
			// 关不掉不影响用例结果。
		}
	}

	/**
	 * 等一条 CDP 事件，超时则放弃等待。
	 *
	 * @param method - 事件名。
	 * @param timeoutMs - 超时毫秒数。
	 * @returns 是否在超时前收到。
	 */
	waitForEvent(method, timeoutMs) {
		return new Promise((resolve) => {
			const previous = this.onEvent;
			const timer = setTimeout(() => {
				this.onEvent = previous;
				resolve(false);
			}, timeoutMs);
			this.onEvent = (message) => {
				previous(message);
				if (message.method === method) {
					clearTimeout(timer);
					this.onEvent = previous;
					resolve(true);
				}
			};
		});
	}
}

/**
 * 浏览器侧的宿主桩：`__ModuleLoader__` + `require("react")` + `fetch`。
 *
 * 这些与 `test/client-harness.js` 在 Node 里做的是同一件事，区别是这里跑在
 * 真浏览器里、产出**真实 DOM**，才能让布局引擎去算几何。
 */
const HOST_STUB = String.raw`
window.__ulHost = {
	install(payload) {
		window.__ulReg = null;
		window.__ModuleLoader__ = { load(entry) { window.__ulReg = entry; } };
		window.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) });
		window.localStorage.clear();
	},
	require(spec) {
		if (spec === "react") return window.__ul.react;
		throw new Error('require 桩不认识 "' + spec + '"：src/client.js 只允许 require("react")');
	},
	factory() {
		return window.__ulReg.factory((spec) => window.__ulHost.require(spec));
	},
};
`;

/**
 * 浏览器侧的渲染桩：手写渲染器 + 单趟 hook。
 *
 * 刻意**不用真实 React**：本仓库零依赖（ADR-0004），而 React 的运行时映射版本
 * 不可控，测试会因为一个与被测承诺无关的版本漂移而红。这里只需要把 `Panel`
 * 交给的元素树摆成 DOM，`useState` 返回初值即可——几何与状态无关。
 *
 * 注：本模板字符串里不能出现反引号（外层是 String.raw 模板）。
 */
const RENDERER_STUB = String.raw`
window.__ul = (() => {
	let cursor = 0;
	const slots = [];
	const cleanups = [];
	let exportsRef = null;

	const react = {
		createElement: (type, props, ...children) => ({ $$typeof: Symbol.for("react.element"), type, props: { ...(props ?? {}), children } }),
		useState(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
			const cell = slots[index];
			return [cell.value, (next) => { cell.value = typeof next === "function" ? next(cell.value) : next; }];
		},
		useRef(initial) {
			const index = cursor++;
			if (!(index in slots)) slots[index] = { value: { current: initial } };
			return slots[index].value;
		},
		useEffect(effect) {
			const cleanup = effect();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		},
		useCallback: (callback) => callback,
	};

	function applyProps(el, props) {
		for (const [key, value] of Object.entries(props ?? {})) {
			if (key === "children" || value === null || value === undefined) continue;
			if (key === "style" && typeof value === "object") { Object.assign(el.style, value); continue; }
			if (key === "className") { el.setAttribute("class", value); continue; }
			if (key === "ref") { if (value && typeof value === "object") value.current = el; continue; }
			if (key === "key" || key === "$$typeof") continue;
			if (key.startsWith("on") && typeof value === "function") { el.addEventListener(key.slice(2).toLowerCase(), value); continue; }
			if (key === "tabIndex") { el.setAttribute("tabindex", String(value)); continue; }
			el.setAttribute(key, String(value));
		}
	}

	function mount(node, parent) {
		if (node === null || node === undefined || typeof node === "boolean") return;
		if (Array.isArray(node)) { for (const child of node) mount(child, parent); return; }
		if (typeof node === "string" || typeof node === "number") { parent.append(document.createTextNode(String(node))); return; }
		if (typeof node.type === "function") { mount(node.type(node.props ?? {}), parent); return; }
		const el = document.createElement(node.type);
		applyProps(el, node.props);
		parent.append(el);
		mount(node.props?.children ?? null, el);
	}

	const round = (value) => Math.round(value * 100) / 100;

	return {
		react,
		setExports(value) { exportsRef = value; },
		render(props) {
			cursor = 0;
			while (cleanups.length > 0) cleanups.shift()();
			document.body.innerHTML = "";
			mount(exportsRef.Panel(props), document.body);
			return true;
		},
		measure() {
			const panel = document.querySelector(".ul-panel");
			const wrap = document.querySelector(".ul-tablewrap");
			const rect = panel.getBoundingClientRect();
			const viewport = window.innerWidth;
			return {
				// 主指标：fixed 浮层有没有被切出视口。body/document 的滚动宽度都测不到它。
				panelLeft: round(rect.left),
				panelRight: round(rect.right),
				// @media 行为断言的指标。面板是 bottom:<n>px 定位的，所以「bottom 收到 8px」
				// 体现为「面板下边缘距视口下边缘 8px」，而不是一个绝对坐标——必须量 gap。
				panelBottom: round(rect.bottom),
				innerHeight: window.innerHeight,
				// 只用于自检「视口模拟真的生效了」：matchMedia 是拿查询文本对**视口**求值，
				// 完全不读注入的样式表，所以它**证明不了** @media 块存在。命中与否由几何断言负责，
				// 这里只排除「Emulation 没把宽度改掉，断言在错误的视口上跑」这一种事故。
				narrowQueryMatches: window.matchMedia("(max-width:760px)").matches,
				panelClipped: rect.left < -0.5 || rect.right > viewport + 0.5,
				// 次要指标：面板**自身**内部是否横向滚动（与下面两条一起构成完整画面）。
				panelScrollsX: panel.scrollWidth > panel.clientWidth,
				// 辅助指标：修复不得把 body 撑出滚动条。
				bodyScrollWidth: document.body.scrollWidth,
				docScrollWidth: document.documentElement.scrollWidth,
				innerWidth: viewport,
				// 自检：面板真的渲染出内容了，否则「不越界」可能只是因为什么都没画。
				tables: document.querySelectorAll(".ul-table").length,
				// 只数**第一张**表：两张表各有一行表头，全局数会翻倍。
				cols: (() => {
					const head = document.querySelector(".ul-table thead");
					return head === null ? 0 : head.querySelectorAll("th").length;
				})(),
				rows: document.querySelectorAll(".ul-table tbody tr").length,
				wrapScrollsX: wrap === null ? null : wrap.scrollWidth > wrap.clientWidth,
				styleInjected: document.getElementById("usage-ledger-style") !== null,
			};
		},
	};
})();
`;

/**
 * 造一份**真实形状**的载荷。
 *
 * 用 `buildPayload`（宿主端真货）而不是手写对象：手写的载荷会随契约漂移，
 * 而载荷字段一少，面板就不渲染表格，「不越界」也就失去了意义。
 *
 * 记录刻意造得**宽**：长模型名 + 十列数值，这是让表格与面板承压的输入。
 *
 * @returns 可序列化的载荷。
 */
function realisticPayload() {
	const models = [
		["deepseek-v4.1-flash-thinking-preview", "relay-a-official"],
		["claude-sonnet-4-6-20260101", "relay-b-discount"],
		["gpt-5.2-codex-high", "relay-a-official"],
		["gemini-3.0-pro-exp", "anthropic-direct"],
	];
	const records = [];
	const now = new Date(2026, 8, 28);
	for (let dayOffset = 0; dayOffset < 60; dayOffset += 1) {
		const day = new Date(now.getTime() - dayOffset * 86_400_000);
		const pad = (value) => String(value).padStart(2, "0");
		const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
		models.forEach(([model, provider], index) => {
			const input = 120_000 + index * 41_000 + dayOffset * 900;
			records.push({
				day: key,
				provider,
				model,
				inputTokens: input,
				outputTokens: Math.round(input / 5),
				cacheReadTokens: Math.round(input * 1.7),
				cacheWriteTokens: Math.round(input / 9),
				reasoningTokens: Math.round(input / 12),
				tokens: input + Math.round(input / 5) + Math.round(input * 1.7) + Math.round(input / 9) + Math.round(input / 12),
				requests: 3 + index,
			});
		});
	}
	return buildPayload(records, {
		range: { from: null, to: null, label: "累计" },
		pricing: { "deepseek-v4.1-flash": { input: 1, output: 2 }, "claude-sonnet-4-6": { input: 3, output: 15 } },
		aliases: { "deepseek-v4.1-flash-thinking-preview": "deepseek-v4.1-flash" },
		currency: "CNY",
		stats: { files: 214, scanned: 9, cached: 205, failed: 0 },
		now,
	});
}

/** 一次测量会话的收尾动作。 */
let teardown = async () => {};

/** 测量结果只算一次：起一次 Chrome 量四档，两条用例共用。 */
let measurementPromise = null;

/**
 * 起 Chrome、注入 bundle、在四档视口下量几何。
 *
 * @returns 每档视口的测量结果数组。
 */
function measureAll() {
	measurementPromise ??= (async () => {
		const origin = await startOriginServer();
		const port = await freePort();
		const userDataDir = mkdtempSync(join(tmpdir(), "ul-viewport-"));
		const chrome = spawn(
			CHROME,
			[
				"--headless=new",
				// 以下四个开关缺一不可：本机默认参数下 Chrome 会 core dump。
				"--no-sandbox",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--disable-crash-reporter",
				`--user-data-dir=${userDataDir}`,
				`--remote-debugging-port=${port}`,
				"--remote-allow-origins=*",
				"--no-first-run",
				"--no-default-browser-check",
				origin.url,
			],
			// detached 让 Chrome 独占一个进程组：它自己会 fork 出 zygote / GPU 等子进程，
			// 只 kill 父进程会留下一群孤儿继续往 user-data-dir 里写，随后 rmSync 要么
			// 删不掉、要么删掉又被重建。
			{ stdio: ["ignore", "ignore", "pipe"], detached: true },
		);
		let chromeStderr = "";
		chrome.stderr.on("data", (chunk) => (chromeStderr += chunk.toString()));

		teardown = async () => {
			// 整组杀：负 pid 表示「这个进程组」。ESRCH 说明已经退出了。
			try {
				process.kill(-chrome.pid, "SIGKILL");
			} catch {
				try {
					chrome.kill("SIGKILL");
				} catch {
					// 已经退出了。
				}
			}
			// 等父进程真的退出再删目录，否则是与仍在收尾的 Chrome 抢文件。
			if (chrome.exitCode === null && chrome.signalCode === null) {
				await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), sleep(5_000)]);
			}
			await origin.close();
			// 临时 profile 必须收干净：留着会污染 /tmp，且可能让下一次运行读到脏状态。
			// 子进程收尾可能有极短延迟，所以重试几次而不是一次放弃。
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					rmSync(userDataDir, { recursive: true, force: true });
					break;
				} catch {
					await sleep(100);
				}
			}
		};

		// 等调试端点起来并拿到页面目标的 webSocketDebuggerUrl。
		const deadline = Date.now() + 20_000;
		let target = null;
		while (Date.now() < deadline) {
			try {
				const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
				target = list.find((entry) => entry.type === "page" && typeof entry.webSocketDebuggerUrl === "string");
				if (target) break;
			} catch {
				// 还没监听。
			}
			await sleep(120);
		}
		if (target === null) throw new Error(`Chrome 调试端点未就绪：${chromeStderr.slice(-600)}`);

		const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
		try {
			await cdp.send("Runtime.enable");
			await cdp.send("Page.enable");

			// **必须显式导航到 http 源。** Chrome 的页面目标初始停在 `about:blank`，
			// 那是不透明源，`window.localStorage` 会抛 SecurityError；而 `Panel` 挂载时
			// 会走 `loadRange()` 读上次范围，于是注入阶段就崩。命令行里的 URL 只保证
			// 有一个页面目标存在，不保证它就是那个 URL——这里自己导航一次才作数。
			const loaded = cdp.waitForEvent("Page.loadEventFired", 8_000);
			await cdp.send("Page.navigate", { url: origin.url });
			await loaded;
			assert.equal(await cdp.eval("location.origin"), new URL(origin.url).origin, "页面没有落在预期的 http 源上");

			await cdp.eval(HOST_STUB);
			await cdp.eval(RENDERER_STUB);

			// 装桩 → 注入 bundle → 物化 factory。
			await cdp.eval(`window.__ulHost.install(${JSON.stringify(realisticPayload())});`);
			await cdp.eval(clientSource());
			const registered = await cdp.eval("window.__ulReg === null ? null : window.__ulReg.id");
			assert.equal(registered, "dsh-usage-ledger", "bundle 没有注册到 __ModuleLoader__，注入链路已断");
			await cdp.eval("window.__ul.setExports(window.__ulHost.factory());");

			// 首帧只有加载态；等预取的 fetch 落进模块级缓存，第二帧才是真实数据。
			await cdp.eval("window.__ul.render({ onClose: () => {} }); true");
			await sleep(300);
			await cdp.eval("window.__ul.render({ onClose: () => {} }); true");
			await sleep(150);

			const results = [];
			for (const width of VIEWPORTS) {
				await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
				await sleep(250);
				results.push({ width, ...JSON.parse(await cdp.eval("JSON.stringify(window.__ul.measure())")) });
			}
			return results;
		} finally {
			cdp.close();
		}
	})();
	return measurementPromise;
}

/** 用例收尾：无论成败都收掉 Chrome、HTTP 源与临时 profile。 */
after(async () => {
	await teardown();
});

/**
 * Chrome 缺失时的显式跳过。
 *
 * `t.skip()` 会让用例计入 skipped 而**不是** passed——这正是要的：
 * `npm test` 的数字必须如实反映「这台机器没跑浏览器断言」。
 *
 * @param t - 用例上下文。
 * @returns 是否已跳过。
 */
function skipWithoutChrome(t) {
	if (CHROME !== null) return false;
	t.skip(
		"未找到 Chrome（可用 CHROME_BIN 指定）：真实浏览器的布局断言无法执行，本条记为 skipped 而不是 passed。" +
			"「这台机器没装 Chrome」与「面板没有越界」是两回事，请不要把它当成通过。" +
			"CI 请用独立 job 跑 `node --test test/viewport.test.js`，不要放进「skipped 必须为 0」的主 job。",
	);
	return true;
}

test("视口：480/768/900/1400 四档下面板都不越出视口边界（真实 Chrome 几何）", async (t) => {
	if (skipWithoutChrome(t)) return;
	const results = await measureAll();

	// 先自检：面板真的把表格画出来了。否则「不越界」可能只是因为什么都没渲染。
	for (const result of results) {
		assert.ok(result.styleInjected, `${result.width}px：样式没有注入，量到的是无样式 DOM，几何断言无意义`);
		assert.ok(result.tables >= 2, `${result.width}px：只渲染出 ${result.tables} 张表，载荷或渲染桩已失效`);
		assert.equal(result.cols, 10, `${result.width}px：明细表应有 10 列，实际 ${result.cols} 列`);
	}

	// 主断言：fixed 浮层的左右边缘必须落在视口内。
	//
	// 修复前 480/768 的右边缘在 502/790（越界 22px），而同期 body.scrollWidth
	// 只有 464/752——**比视口还窄**。所以这条断言必须基于 getBoundingClientRect：
	// 任何滚动宽度指标都会放行这个 bug。
	for (const result of results) {
		assert.ok(
			result.panelLeft >= -0.5,
			`${result.width}px：面板左边缘在 ${result.panelLeft}px，超出视口左边界；残留的 left 偏移没有在窄视口归零`,
		);
		assert.ok(
			result.panelRight <= result.innerWidth + 0.5,
			`${result.width}px：面板右边缘在 ${result.panelRight}px，超出视口 ${result.innerWidth}px ` +
				`（越界 ${Math.round((result.panelRight - result.innerWidth) * 100) / 100}px）。` +
				"面板是 fixed 定位，这段越界不会出现在 body.scrollWidth 里，用户只会看到右侧被切掉。",
		);
	}

	// 辅助断言：修面板不能把 body 撑出横向滚动条。
	// 这条守的是**另一条**承诺（页面整体不横向滚动），修复前就已经成立，不是本 issue 的探测器。
	for (const result of results) {
		assert.ok(
			result.bodyScrollWidth <= result.innerWidth,
			`${result.width}px：body.scrollWidth=${result.bodyScrollWidth} 超过了 innerWidth=${result.innerWidth}，修复把整页撑出了横向滚动条`,
		);
	}
});

test("视口：面板自身不出现横向滚动（次要断言，守 .ul-tablewrap 的 overflow-x:auto）", async (t) => {
	if (skipWithoutChrome(t)) return;
	const results = await measureAll();

	// ⚠️ 这条**抓不到** Issue #4 的 bug：修复前后它四档恒为 false。
	//
	// 原因：.ul-panel 的横向溢出由 .ul-tablewrap{overflow-x:auto} 吸收，面板自身的
	// scrollWidth 因此始终等于 clientWidth；而被切出视口的是**面板这个盒子**，
	// 不是面板内部的内容。两者是不同性质，不要把它误读成主防线。
	//
	// 它守的是：`.ul-tablewrap` 的 overflow-x:auto 一旦被删/被挪回 .ul-panel，
	// 表格就会把面板内部撑出横向滚动 —— 那时这条会变红。
	for (const result of results) {
		assert.equal(
			result.panelScrollsX,
			false,
			`${result.width}px：面板自身出现横向滚动（scrollWidth > clientWidth）。` +
				"表格应当由 .ul-tablewrap{overflow-x:auto} 自己滚动，而不是把面板内部撑宽。",
		);
	}

	// 480px 下表格确实超出面板内宽，所以它**必须**由 tablewrap 承担滚动——
	// 这是「面板自身不滚动」这条断言成立的前提，一并钉住，免得上面那条变成空气。
	const narrow = results.find((result) => result.width === 480);
	assert.equal(
		narrow.wrapScrollsX,
		true,
		"480px：表格没有超出面板内宽，说明载荷不够宽或 tablewrap 失效；" +
			"此时「面板自身不横向滚动」是一条恒真的空断言，无法守住任何承诺。",
	);
});

/**
 * 断点内外的期望几何。
 *
 * 这些数字是**实测**出来的（真实 Chrome，Chrome 147），不是从 CSS 反推的：
 *
 * | 视口 | 命中 @media | left | right | 下边距 |
 * |------|-------------|------|-------|--------|
 * | 480  | 是          | 0    | 480   | 8      |
 * | 768  | 否          | 12   | 756   | 64     |
 *
 * 关键点：`@media (max-width:760px)` 是**排他**的，768 不命中。两条分支的
 * `left` 与下边距互不相同，所以断言能真正区分「命中了」与「没命中」。
 */
const NARROW_VIEWPORT = { width: 480, left: 0, right: 480, bottomGap: 8 };
const WIDE_VIEWPORT = { width: 768, left: 12, right: 756, bottomGap: 64 };

test("视口：@media (max-width:760px) 在 480px 命中（left 归零、right 贴边、bottom 收到 8px）、768px 不命中", async (t) => {
	if (skipWithoutChrome(t)) return;
	const results = await measureAll();
	const at = (width) => results.find((result) => result.width === width);

	// 自检：Emulation.setDeviceMetricsOverride 真的把视口宽度改掉了。若这条不成立，
	// 下面的几何断言是在**错误的视口**上求的值，结论无意义。
	// 注意它**不**校验 @media 块是否存在：matchMedia 只对视口求值，不读注入的样式表。
	for (const expected of [NARROW_VIEWPORT, WIDE_VIEWPORT]) {
		const result = at(expected.width);
		assert.equal(result.innerWidth, expected.width, `Emulation 没有生效：请求 ${expected.width}px，实际 innerWidth=${result.innerWidth}`);
	}

	// ---- 480px：断点内，必须命中 ----
	//
	// 这三条合起来把 @media 块钉死。它们**不是**在重复「不越界」那条主断言：
	// 只加 box-sizing、删掉整个 @media 时，480px 的几何是 left:12/right:468/
	// 下边距 64——同样不越界，但 left/right/bottom 三条断言全红。
	const narrow = at(NARROW_VIEWPORT.width);
	assert.equal(
		narrow.narrowQueryMatches,
		true,
		"480px：`(max-width:760px)` 没有命中，断点被改小或写错了（下面的几何断言会在错误的媒体条件下求值）",
	);
	assert.equal(
		narrow.panelLeft,
		NARROW_VIEWPORT.left,
		`480px：面板左边缘在 ${narrow.panelLeft}px，应当是 ${NARROW_VIEWPORT.left}px（@media 里 left 归零）。` +
			"残留的 left:12px 说明断点没命中或 @media 块被删——它不会让面板越界，但窄屏下白白吃掉 12px 宽度。",
	);
	assert.equal(
		narrow.panelRight,
		NARROW_VIEWPORT.right,
		`480px：面板右边缘在 ${narrow.panelRight}px，应当是 ${NARROW_VIEWPORT.right}px（right:0 贴到视口右边界）。` +
			"若为 468，说明 @media 块整个没生效（right 没归零）。",
	);
	assert.equal(
		Math.round((narrow.innerHeight - narrow.panelBottom) * 100) / 100,
		NARROW_VIEWPORT.bottomGap,
		`480px：面板下边缘距视口下边缘 ${Math.round((narrow.innerHeight - narrow.panelBottom) * 100) / 100}px，应当是 ${NARROW_VIEWPORT.bottomGap}px。` +
			"若为 64，说明 @media 里 bottom 没有从 64px 收到 8px——窄屏上那 64px 是白吃的可视高度。",
	);

	// ---- 768px：恰在断点之外，不得命中 ----
	//
	// 768 > 760，所以 `max-width:760px` 不成立，面板应保持基准几何。
	// 这条防的是「把断点放宽/写错，连 768 也一并命中」——那种情况下 480px 的三条
	// 断言仍然全绿，只有这里会红。
	const wide = at(WIDE_VIEWPORT.width);
	assert.equal(
		wide.narrowQueryMatches,
		false,
		"768px：`(max-width:760px)` 竟然命中，断点被放宽到了 768 以上",
	);
	assert.equal(
		wide.panelLeft,
		WIDE_VIEWPORT.left,
		`768px：面板左边缘在 ${wide.panelLeft}px，应当是 ${WIDE_VIEWPORT.left}px——768 已超出 max-width:760px，不该命中 @media`,
	);
	assert.equal(
		wide.panelRight,
		WIDE_VIEWPORT.right,
		`768px：面板右边缘在 ${wide.panelRight}px，应当是 ${WIDE_VIEWPORT.right}px——768 已超出 max-width:760px，不该命中 @media`,
	);
	assert.equal(
		Math.round((wide.innerHeight - wide.panelBottom) * 100) / 100,
		WIDE_VIEWPORT.bottomGap,
		`768px：面板下边缘距视口下边缘 ${Math.round((wide.innerHeight - wide.panelBottom) * 100) / 100}px，应当是 ${WIDE_VIEWPORT.bottomGap}px——768 已超出 max-width:760px，bottom 不该被收到 8px`,
	);
});
