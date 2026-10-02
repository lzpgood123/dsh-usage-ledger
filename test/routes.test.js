/**
 * 路由注册、方法闸门、overrides 写入的测试（ADR-0008 §2/§4 / 规格 D1+D6）。
 *
 * ## 为什么要把 `apply()` 真跑起来
 *
 * 前几个文件断言的都是**纯函数**。但本次改动里最容易静默出错的恰恰是装配层：
 *
 * 1. **路由注册**：宿主 webserver 的 `register()` 以 `(kind, path)` 建键、重复注册
 *    直接抛错。所以「复用现有 handler 注册第二个路径」在宿主端**做不到**——新路径
 *    必须是独立的一条，也就必须有**自己的**方法闸门。写漏一条，`POST /overrides`
 *    会返回 405 而面板只显示「写入失败」，没有人知道为什么。
 * 2. **回环闸门**：现有那条路由的 `screenRequest` 在 `onRequest` 里。新路由若照抄
 *    「先闸门后 screen」的顺序而漏掉 screen，局域网里的机器就能**写**本机的定价表。
 * 3. **早退条件**：`refreshPricing` 原来写的是 `if (pricingFile === undefined || …) return;`
 *    ——`{pricingFile: false}` 时连 overrides 都不读，用户的手工修正全部静默失效。
 *
 * 这些都不是纯函数能覆盖的，所以这里用假 ctx + 假 server 把 `apply()` 装起来，
 * 直接驱动注册进去的 handler。
 *
 * ## 为什么不用真实 HTTP server
 *
 * `screenRequest` 读的是 `req.socket.remoteAddress`，而真实 server 上的 peer 一定是
 * 回环，**测不到 403 那条路**。假请求对象反而能精确控制 peer。
 *
 * @module usage-ledger/test/routes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, BASE_PATH, classifyOverridesReadError, OVERRIDES_PATH, OVERRIDES_VERSION, probeOverridesFile, UNPRICED_PATH } from "../src/index.js";
import { billedEvent, sessionBytes, sessionEvent } from "./fixtures.js";

/** 回环 peer：默认放行。 */
const LOOPBACK = "127.0.0.1";

/**
 * 造一个记录 `warn` 的 logger。
 *
 * 注意形状：`apply()` 里写的是 `ctx.logger?.("usage-ledger") ?? ctx.logger`——宿主传进来的
 * `ctx.logger` 是一个**函数**（按 scope 取子日志器），不是日志器对象本身。用对象当
 * `ctx.logger` 会立刻抛 `ctx.logger is not a function`，所以这里复刻真实形状。
 *
 * @returns `{warned, logger}`；`logger` 既是可调用的作用域工厂，也带 warn/info/error。
 */
function makeLogger() {
	const warned = [];
	const scoped = {
		info() {},
		warn(...args) {
			warned.push(args);
		},
		error() {},
	};
	const logger = () => scoped;
	Object.assign(logger, scoped);
	return { warned, logger };
}

/**
 * 把 `apply()` 装起来，交出注册项与驱动 handler 的助手。
 *
 * @param options - `{config, peer}`；`config` 透传给 `apply`，`peer` 是默认的 remoteAddress。
 * @returns `{registered, effects, invoke, requests}`。
 */
function mount(options = {}) {
	const registered = [];
	const effects = [];
	const requests = [];
	const { logger } = makeLogger();
	const server = {
		register(route) {
			// 复刻宿主契约：同 (kind, path) 重复注册抛错。少了这一条，
			// 「复用 handler 注册两个路径」的实现会在这里静默通过。
			if (registered.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
				throw new Error(`duplicate route registration: ${route.kind} ${route.path}`);
			}
			registered.push(route);
			return route;
		},
	};
	const ctx = {
		logger,
		effect(factory, label) {
			effects.push(label);
			return factory();
		},
		inject(names, callback) {
			// 只回调 webServer 一次，避免同一批路由被注册两遍（宿主实际只会装其中一个）。
			if (names.includes("webServer")) callback({ webServer: server });
		},
	};
	apply(ctx, options.config ?? { sessionsRoot: join(tmpdir(), "usage-ledger-routes-none"), pricingFile: false, overridesFile: false });

	/**
	 * 驱动某条已注册路由。
	 *
	 * @param path - 路由 path。
	 * @param request - `{method, url, body, peer, chunks}`。
	 * @returns `{status, headers, body}`。
	 */
	const invoke = async (path, request = {}) => {
		const route = registered.find((entry) => entry.path === path);
		assert.ok(route !== undefined, `没有注册 ${path} 这条路由`);
		const chunks = request.chunks ?? (request.body === undefined ? [] : [Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body))]);
		// 默认带上 `content-type: application/json`——真实客户端就是这么发的，而
		// `onOverrides` 现在要求它（见「content-type 闸门」那条用例）。需要显式构造
		// 「类型不对」的请求时传 `contentType: null` 或其它值。
		const contentType = "contentType" in request ? request.contentType : "application/json";
		const reqHeaders = contentType === null ? {} : { "content-type": contentType };
		const req = {
			method: request.method ?? "GET",
			url: request.url ?? path,
			headers: reqHeaders,
			socket: { remoteAddress: request.peer ?? LOOPBACK },
			async *[Symbol.asyncIterator]() {
				for (const chunk of chunks) yield chunk;
			},
		};
		let status = null;
		let headers = null;
		let payload = "";
		const res = {
			writeHead(code, nextHeaders) {
				status = code;
				headers = nextHeaders;
			},
			end(text) {
				payload = text ?? "";
			},
		};
		await route.handler(req, res);
		requests.push({ path, request, status });
		return { status, headers, body: payload === "" ? null : JSON.parse(payload), raw: payload };
	};
	return { registered, effects, invoke, requests };
}

/**
 * 本平台能不能造出「可写不可读」这个真实 ACL 状态。
 *
 * 这个常量决定下面那条端到端用例**注册不注册**——不是「注册后 skip」。
 * 两者在 CI 上的差别是决定性的：`test(name, { skip: cond }, fn)` 与用例内的
 * `t.skip()` 都会让 TAP 记 `skipped=1`，而 CI 主 job 有一道 `skipped == 0` 的硬闸门
 * （`.github/workflows/test.yml`），于是这条**只在 Windows 上跑得了**的用例会把
 * ubuntu 上的整个主 job 判红。那道闸门的用意正是「不允许用环境缺失换绿」，
 * 所以不能为这条用例放宽它，只能让它**在跑不了的平台上不存在**。
 *
 * 这是本仓库既有的处理方式：`test/viewport.test.js` 依赖真实 Chrome，CI 就把整个文件
 * 排除出主 job 的统计范围（见 workflow 里 `grep -v 'test/viewport.test.js$'` 那段注释，
 * 它明确写着「用环境缺失去否决一批本来能跑的用例，是错的」）。
 *
 * 判据本身**不**因此失去保护：三态分类由下面的纯函数用例在**所有平台**逐条钉住
 * （`classifyOverridesReadError`），这里少掉的只是「真实 ACL 下的端到端链路」。
 */
const canDenyRead = process.platform === "win32" && (process.env.USERNAME ?? process.env.USER ?? "") !== "";

/**
 * 造一个临时目录并保证用完删除。
 *
 * @param label - 目录名前缀。
 * @returns 绝对路径。
 */
function tmpDir(label) {
	return mkdtemp(join(tmpdir(), `usage-ledger-${label}-`));
}

/**
 * 给文件加一条「拒绝读取」的 ACL，造出**可写不可读**的状态。
 *
 * 这是本仓库唯一一处需要真实 ACL 的用例：缺陷成立的**唯一**原因是 `rename` 不读目标
 * 文件，所以只有「读失败但写成功」这个真实状态才能证伪那条错误假设。用打桩 `readFile`
 * 做不到——`node:fs/promises` 的模块命名空间是**冻结**的（`test/pricing-file.test.js`
 * 的头注已记录：`Object.defineProperty` 会抛 `Cannot redefine property: readFile`）。
 *
 * 实测各平台状态（本机 Windows + NTFS）：
 * - `icacls <file> /deny <user>:(R)` → `readFile` **EPERM**、`rename` **成功** ← 正是要的
 * - `chmod 0o000` → `readFile` **成功**、`rename` **EPERM** ← 另一种状态，不触发本缺陷
 * - 目标是个目录 → `readFile` EISDIR、`rename` EPERM ← 既有 500 用例覆盖的那条
 *
 * @param file - 目标文件绝对路径。
 * @returns 成功造出该状态时为 true；`icacls` 不可用或调用失败时为 false。
 */
async function denyRead(file) {
	const { execFile } = await import("node:child_process");
	const user = process.env.USERNAME ?? process.env.USER ?? "";
	if (process.platform !== "win32" || user === "") return false;
	return await new Promise((resolve) => {
		execFile("icacls", [file, "/deny", `${user}:(R)`], { windowsHide: true }, (error) => resolve(error === null));
	});
}

/**
 * 撤销 `denyRead` 加的 ACL（并尽量恢复可写位）。
 *
 * 用例无论成败都会调用它：ACL 残留会让临时目录删不掉，进而污染后续用例。
 *
 * @param file - 目标文件绝对路径。
 */
async function allowRead(file) {
	if (process.platform !== "win32") return;
	const { execFile } = await import("node:child_process");
	await new Promise((resolve) => {
		execFile("icacls", [file, "/reset"], { windowsHide: true }, () => resolve());
	});
}

test("路由：三条 exact 路由各自注册，路径常量由 BASE_PATH 派生", () => {
	const { registered, effects } = mount();

	assert.deepEqual(
		registered.map((route) => [route.kind, route.path]),
		[
			["exact", "/api/usage-ledger"],
			["exact", "/api/usage-ledger/unpriced"],
			["exact", "/api/usage-ledger/overrides"],
		],
		"三条独立的 exact 路由：宿主 register() 以 (kind, path) 建键、重复注册抛错，" +
			"所以「复用同一个 handler 注册两个路径」在宿主端做不到——新路径必须自己注册一条",
	);
	assert.equal(UNPRICED_PATH, `${BASE_PATH}/unpriced`, "UNPRICED_PATH 必须由 BASE_PATH 派生，不写死字符串");
	assert.equal(OVERRIDES_PATH, `${BASE_PATH}/overrides`, "OVERRIDES_PATH 必须由 BASE_PATH 派生");

	assert.deepEqual(
		effects,
		["usage-ledger: usage route", "usage-ledger: unpriced route", "usage-ledger: overrides route"],
		"三条路由各用独立的 ctx.effect，标签互不相同（宿主靠标签做清理与排障）",
	);
});

test("路由：方法闸门在三条路由上都生效，新路由的 405 载荷带 cache-control", async () => {
	const { invoke } = mount();

	// 现有那条：GET/HEAD 之外一律 405（行为与改动前一致，头也一字不改）。
	for (const method of ["POST", "DELETE", "PUT", "PATCH"]) {
		const refused = await invoke(BASE_PATH, { method });
		assert.equal(refused.status, 405, `${method} ${BASE_PATH} 必须 405`);
		assert.deepEqual(refused.body, { ok: false, error: "method-not-allowed" });
		assert.equal(
			Object.hasOwn(refused.headers, "cache-control"),
			false,
			"现有路由的 405 只带 content-type——它的头必须保持原样，不能被「统一」进新助手的写法",
		);
	}

	// 新路由各有一条相反的判据：unpriced 只接受 GET/HEAD，overrides 只接受 POST。
	// 它们的 405 走统一助手，所以**带** `cache-control`（有意差异：新代码不留两套头）。
	for (const method of ["POST", "DELETE"]) {
		const refused = await invoke(UNPRICED_PATH, { method });
		assert.equal(refused.status, 405, `${method} ${UNPRICED_PATH} 必须 405`);
		assert.deepEqual(refused.body, { ok: false, error: "method-not-allowed" });
		assert.equal(refused.headers["cache-control"], "no-store", "新路由的 405 走统一助手，头必须齐全");
	}
	for (const method of ["GET", "HEAD", "DELETE", "PUT"]) {
		const refused = await invoke(OVERRIDES_PATH, { method });
		assert.equal(refused.status, 405, `${method} ${OVERRIDES_PATH} 必须 405——写接口只认 POST`);
		assert.deepEqual(refused.body, { ok: false, error: "method-not-allowed" });
		assert.equal(refused.headers["cache-control"], "no-store");
	}

	// 正向对照：闸门放行的那几种方法必须真的走到业务分支（不是「所有方法都 405」）。
	const get = await invoke(UNPRICED_PATH, { method: "GET" });
	assert.equal(get.status, 200, "GET /unpriced 必须 200");
	const post = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "remove", target: "model", id: "x" } });
	assert.equal(post.status, 403, "POST /overrides 在 overridesFile: false 时走 403 write-disabled，而不是 405");
});

test("路由：回环闸门覆盖新路由——局域网地址不得读也不得写", async () => {
	const { invoke } = mount({ config: { sessionsRoot: join(tmpdir(), "usage-ledger-none"), pricingFile: false, overridesFile: false } });

	for (const path of [BASE_PATH, UNPRICED_PATH, OVERRIDES_PATH]) {
		for (const peer of ["192.168.1.9", "203.0.113.7", "::ffff:192.168.1.9"]) {
			const refused = await invoke(path, { method: path === OVERRIDES_PATH ? "POST" : "GET", peer, body: { op: "remove", target: "model", id: "x" } });
			assert.equal(refused.status, 403, `${peer} 打 ${path} 必须 403`);
			assert.deepEqual(refused.body, { ok: false, error: "forbidden" });
		}
	}

	// 反向对照：回环地址必须放行（否则上面三条只是「所有请求都被拒」）。
	const allowed = await invoke(UNPRICED_PATH, { method: "GET", peer: "127.0.0.1" });
	assert.equal(allowed.status, 200);
});

test("回归：现有 GET /api/usage-ledger 的响应形状逐字段未变", async () => {
	// ADR-0008 的硬约束之一：只读路径不可破坏。新增两条路由时最容易顺手「统一」
	// 现有那条 handler 的写法（比如把它也改成 `gate([...], onRequest)`、或把 405 的
	// 头补成 `cache-control`）——那都是**行为变化**。这条用例把响应的**顶层字段集合**
	// 与关键语义逐条钉住，任何一处漂移都会立刻变红。
	const dir = await tmpDir("routes-regression");
	const pricingFile = join(dir, "pricing.json");
	const sessions = join(dir, "sessions");
	try {
		await writeFile(pricingFile, JSON.stringify({ models: { "known-model": { input: 1, output: 2, currency: "CNY" } }, aliases: {}, rates: {} }), "utf8");
		// **必须真的放几个会话文件**：否则 `files === 0`，下面那条
		// `scanned + cached + failed === files` 会退化成 `0 === 0` —— 一条恒真的断言，
		// 什么都守不住（我第一版就是这样，注入「缓存命中也算重新解析」的变异体时它
		// 照样全绿）。用**已定价**的模型，这样 `cost.unpriced` 仍是 `[]`，不影响本用例
		// 其余断言。
		for (const [group, session] of [["g1", "s1"], ["g1", "s2"], ["g2", "s3"]]) {
			await mkdir(join(sessions, group, session), { recursive: true });
			await writeFile(
				join(sessions, group, session, "session.v4.jsonl.zstd"),
				sessionBytes([sessionEvent({ id: session }), billedEvent({ provider: "relay-a", model: "known-model", input: 100, output: 20 })]),
			);
		}
		const { invoke } = mount({ config: { sessionsRoot: sessions, pricingFile, overridesFile: false } });

		const response = await invoke(BASE_PATH, { method: "GET", url: `${BASE_PATH}?range=month` });
		assert.equal(response.status, 200);
		assert.deepEqual(
			Object.keys(response.body).sort(),
			["activity", "activityDays", "cost", "diagnostics", "generatedAt", "models", "ok", "providers", "range", "timeZone", "totals"],
			"主接口的顶层字段集合必须逐字段未变——新增两条路由不得顺手动现有那条的形状",
		);
		assert.equal(response.body.ok, true);
		assert.equal(response.body.range.label, "本月");
		assert.equal(response.body.activityDays, 371, "热力图窗口天数不变");
		assert.deepEqual(Object.keys(response.body.cost).sort(), ["currency", "priced", "total", "unpriced"], "cost 段形状不变");
		assert.deepEqual(response.body.cost.unpriced, [], "没有会话日志时未定价清单为空");
		assert.deepEqual(Object.keys(response.body.diagnostics).sort(), ["cached", "failed", "files", "matched", "records", "scanned", "uptimeMs"], "diagnostics 段形状不变");

		// `scanned` / `cached` 的**分布**不作契约，但它们的**和**是。
		//
		// 这两个计数取决于「这一趟扫描有多少文件命中了缓存」，而命中与否又取决于
		// `apply()` 里那次 `setImmediate(warm)` 预热有没有在首个请求之前跑完——后者
		// 与事件循环时序有关（`refreshPricing` 的节流分支里有一处 `await
		// refreshInFlight`，会让出一次事件循环，预热因此多半先跑完）。实测：同一个
		// 实例连发请求会看到 `scanned=4 cached=0` 与 `scanned=0 cached=4` **两种**
		// 分布。所以**不能**断言 `scanned === 1 && cached === 0` 之类的固定值：那会把
		// 一条时序相关的观测误当成契约，在别人的机器上偶发变红。
		//
		// 但有一条**与时序无关**的不变量必须成立：每个文件恰好落进三档之一——
		// 重新解析（`scanned`）、命中缓存（`cached`）、或读失败（`failed`）。三者和
		// 恒等于 `files`。少了这条断言，将来改动预热时序时这两个数字会**静默漂移**
		// 而没人发现（既有断言只看键集合）。
		const { files, scanned, cached, failed } = response.body.diagnostics;
		assert.equal(
			scanned + cached + failed,
			files,
			`diagnostics 的 scanned(${scanned}) + cached(${cached}) + failed(${failed}) 必须等于 files(${files})：` +
				"每个文件恰好落进「重新解析 / 命中缓存 / 读失败」三档之一。这个和与时序无关，" +
				"而两个加项各自会随预热时序漂移——所以契约钉在**和**上，不钉在分布上。",
		);

		// 405 的形状也一字不改：现有那条路由的 405 **不带** `cache-control`
		// （新增两条走统一助手时带了，这是有意的差异，不是遗漏）。
		const refused = await invoke(BASE_PATH, { method: "POST" });
		assert.equal(refused.status, 405);
		assert.deepEqual(refused.body, { ok: false, error: "method-not-allowed" });
		assert.equal(
			Object.hasOwn(refused.headers, "cache-control"),
			false,
			"现有路由的 405 头必须保持原样（只有 content-type）：把它「统一」成新助手的形状也是行为变化",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("GET /unpriced：返回七键载荷，且 items 与主载荷的 cost.unpriced 一致", async () => {
	const dir = await tmpDir("routes-unpriced");
	const pricingFile = join(dir, "pricing.json");
	const sessions = join(dir, "sessions");
	try {
		await writeFile(pricingFile, JSON.stringify({ models: { "known-model": { input: 1, output: 2, currency: "CNY" } }, aliases: {}, rates: {} }), "utf8");
		// 没有会话日志：扫描结果为空，但接口形状与候选清单仍然必须完整。
		const { invoke } = mount({ config: { sessionsRoot: sessions, pricingFile, overridesFile: false } });
		const response = await invoke(UNPRICED_PATH, { method: "GET", url: `${UNPRICED_PATH}?range=month` });

		assert.equal(response.status, 200);
		assert.deepEqual(
			Object.keys(response.body).sort(),
			["candidates", "currency", "generatedAt", "items", "ok", "overrides", "range"],
			"接口形状固定为七键",
		);
		assert.deepEqual(response.body.items, [], "没有会话日志时清单为空");
		assert.deepEqual(response.body.candidates.map((entry) => entry.id), ["known-model"], "候选来自合并后的主表");
		assert.equal(response.body.range.label, "本月", "range 参数交给既有的 resolveRange");
		assert.equal(response.body.overrides.enabled, false, "overridesFile: false → enabled 为 false");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：overridesFile: false 时 POST 一律 403，且不创建任何文件", async () => {
	const dir = await tmpDir("routes-disabled");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile: false } });
		const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "m", input: 1, output: 2 } });

		assert.equal(response.status, 403);
		assert.deepEqual(response.body, { ok: false, error: "write-disabled" });
		assert.deepEqual(await readdir(dir), [], "写入被关闭时不得创建任何文件");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：路径固定——body 里没有路径字段，任何未知键都 400 unknown-field", async () => {
	const dir = await tmpDir("routes-path");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });

		// 目录穿越的实现方式是「请求体里根本没有路径字段可传」。
		for (const body of [
			{ op: "setModel", model: "m", input: 1, output: 2, path: "/etc/passwd" },
			{ op: "setModel", model: "m", input: 1, output: 2, file: "../../evil.json" },
			{ op: "setModel", model: "m", input: 1, output: 2, overridesFile: "/tmp/x.json" },
			{ op: "setModel", model: "m", input: 1, output: 2, source: "official" },
		]) {
			const response = await invoke(OVERRIDES_PATH, { method: "POST", body });
			assert.equal(response.status, 400, `${JSON.stringify(body)} 必须被拒`);
			assert.equal(response.body.detail, "unknown-field", "未列出的键一律 unknown-field（服务端字段不可伪造）");
		}

		assert.deepEqual(await readdir(dir), [], "被拒的请求不得创建任何文件");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：POST setModel 落盘，格式与键顺序固定，临时文件不残留", async () => {
	const dir = await tmpDir("routes-setmodel");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		const response = await invoke(OVERRIDES_PATH, {
			method: "POST",
			body: { op: "setModel", model: "brand-new-x", input: 1.5, output: 6, currency: "CNY", note: "面板手工录入" },
		});

		assert.equal(response.status, 200);
		assert.deepEqual(response.body, { ok: true, op: "setModel", path: overridesFile, version: OVERRIDES_VERSION }, "响应形状固定，且回显写入路径");

		const text = await readFile(overridesFile, "utf8");
		assert.ok(text.startsWith('{\n  "version": 1,'), "键顺序固定 version, models, aliases——给人读的文件，稳定顺序让 diff 可读");
		assert.ok(text.endsWith("\n"), "文件以换行结尾");
		const parsed = JSON.parse(text);
		assert.deepEqual(parsed.models["brand-new-x"], { input: 1.5, output: 6, currency: "CNY", note: "面板手工录入", source: "manual" }, "source 由服务端强制为 manual");
		assert.equal(Object.hasOwn(parsed.models["brand-new-x"], "cacheRead"), false, "缺省的 cacheRead **不写这个键**（不伪造 0）");
		assert.deepEqual(await readdir(dir), ["usage-ledger-overrides.json"], "目录里不得留下 .tmp 残留");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：覆盖既有文件走的是「临时文件 + rename」，不是就地截断", async () => {
	// 这条盯的是**原子性本身**，而不是「目录里没留 .tmp」。
	//
	// 判据是 inode：`rename` 是把临时文件**换到**目标位置，所以目标会指向一个新的
	// inode；而就地 `writeFile` 是截断同一个文件再写，inode 不变（实测 Windows 与
	// Linux 上都是如此）。「目录里没留 .tmp」杀不掉这个变异——就地写同样不会留下
	// 任何临时文件，而它一旦在写入中途失败，用户读到的是半截 JSON，插件按空表降级，
	// 于是「刚认领的模型又变回未定价」，且没有任何报错。
	//
	// **必须带 `{ bigint: true }`**：`stat()` 不带该选项时 `.ino` 是 **Number**，而
	// Windows NTFS 的 inode 是 64 位。实测本机 `ino = 111745565755337970`，远超
	// `Number.MAX_SAFE_INTEGER = 9007199254740991`；在这个量级上 double 的 ulp ≈ 16，
	// 于是两个**真实不同**的 inode 会被舍入成同一个 double —— 实测 2000 对相邻新建
	// 文件里 **14 对**如此。那会让 `assert.notEqual` 在**正确实现**上偶发变红：
	// 报「两侧数值完全相同」，而实现其实是对的。CI 跑 ubuntu-latest（ext4 inode 较小）
	// 永远看不到，只在 Windows 开发机上偶发，所以它是一条只在本地咬人的 flake。
	// 用 bigint 取 inode 就没有任何精度丢失（实测同样 2000 对，0 误判）。
	const dir = await tmpDir("routes-atomic");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "first", input: 1, output: 2 } });
		const before = await stat(overridesFile, { bigint: true });

		// 覆盖同一个文件里的**另一个**键，触发一次真正的「覆盖写」。
		const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "second", input: 3, output: 4 } });
		assert.equal(response.status, 200);
		const after = await stat(overridesFile, { bigint: true });

		// 两侧都必须是 **BigInt**，这一条不能省。
		//
		// 少了它，只把**一侧**的 `{ bigint: true }` 丢掉就会让断言**静默失效**：
		// `BigInt !== Number` 恒为真，于是 `notStrictEqual` 永远通过——包括实现被改成
		// 就地覆写时。那是一个「测试还在、却什么都不检查」的空转状态（实测：把 after
		// 侧的 bigint 去掉，注入就地覆写的变异体照样全绿）。显式断言类型，半吊子改动
		// 会立刻变红并指出原因，而不是悄悄失去保护。
		assert.equal(typeof before.ino, "bigint", "before.ino 必须是 BigInt：用 Number 会在 64 位 inode 上丢精度（见上）");
		assert.equal(typeof after.ino, "bigint", "after.ino 必须是 BigInt：丢了一侧的 { bigint: true } 会让下面的 notStrictEqual 恒真、断言空转");

		assert.notStrictEqual(
			before.ino,
			after.ino,
			"第二次写入后目标文件的 inode 没变：说明实现是**就地截断覆盖**而不是「临时文件 + rename」。" +
				"就地写在写入中途失败会留下半截 JSON，插件按空表降级 → 刚认领的模型又变回未定价，且不报错。" +
				`（before=${before.ino} after=${after.ino}）`,
		);
		assert.deepEqual(Object.keys(JSON.parse(await readFile(overridesFile, "utf8")).models).sort(), ["first", "second"], "两次写入的结果都要在（rename 不得丢掉前一次的内容）");
		assert.deepEqual(await readdir(dir), ["usage-ledger-overrides.json"], "目录里不得留下 .tmp 残留");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：overrides 文件存在但损坏 → 拒绝写，文件字节逐字不变（绝不静默清空）", async () => {
	// 这是**静默丢数据**的护栏。
	//
	// `loadOverridesFile` 对损坏文件返回空表——这个口径对**读**是对的（价格读不到不该
	// 让面板挂掉），但对**写**是灾难：`{version:null, models:{}, aliases:{}}` 与「文件
	// 真的是空的」形状完全一样，于是「读不到内容」被当成「没有内容」，一次
	// `applyOverride` + `rename` 就把用户手写的整份 overrides **清空**、返回 200、
	// 没有备份。用户只看到「写入成功」，然后发现自己几周的手工修正全没了。
	//
	// 判据必须是**文件字节**：只断言状态码挡不住「返回 4xx 但仍然写坏了文件」。
	const dir = await tmpDir("routes-corrupt");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		// 尾逗号：一个非常真实的损坏形态（手改 JSON 时最容易多留一个逗号）。
		const corrupted = '{\n  "version": 1,\n  "models": { "hand-written-important": { "input": 1, "output": 2 } },\n  "aliases": {},\n}\n';
		await writeFile(overridesFile, corrupted, "utf8");

		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		for (const body of [
			{ op: "setModel", model: "new-model", input: 1, output: 2 },
			{ op: "setAlias", alias: "some-alias", model: "new-model" },
			{ op: "remove", target: "model", id: "hand-written-important" },
		]) {
			const response = await invoke(OVERRIDES_PATH, { method: "POST", body });
			assert.equal(response.status, 409, `${body.op} 打在损坏文件上必须被拒（4xx），而不是拿空表覆盖它`);
			assert.deepEqual(response.body, { ok: false, error: "bad-request", detail: "overrides-unreadable" }, "必须给出稳定的 overrides-unreadable 码");
		}
		assert.equal(await readFile(overridesFile, "utf8"), corrupted, "被拒的写入必须让文件**逐字不变**——那里面是用户手写的内容");
		assert.deepEqual(await readdir(dir), ["usage-ledger-overrides.json"], "被拒后不得留下临时文件");

		// 反向对照：把文件修好后同一个 op 必须成功——证明上面的 409 来自「损坏」，
		// 而不是这个 op 本身被别的规则拒了。
		await writeFile(overridesFile, JSON.stringify({ version: 1, models: {}, aliases: {} }), "utf8");
		const ok = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "new-model", input: 1, output: 2 } });
		assert.equal(ok.status, 200, "文件修好后同一个 op 必须通过");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：文件不存在（没写过）仍然正常写入——「读不到」与「没内容」必须分开", async () => {
	// 上面那条的反面。若把「文件不存在」也判成 unreadable，第一次使用就永远写不进去。
	const dir = await tmpDir("routes-absent");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "first-ever", input: 1, output: 2 } });
		assert.equal(response.status, 200, "从没写过 overrides 时第一次写入必须成功");
		assert.deepEqual(JSON.parse(await readFile(overridesFile, "utf8")).models, { "first-ever": { input: 1, output: 2, source: "manual" } });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：content-type 不是 application/json → 400 且不落盘（跨站请求的第一道闸门）", async () => {
	// 宿主 webserver 的 `handle()` 直接 `await route.handler(req, res)`，**没有鉴权层**；
	// `screenRequest` 只查 peer 地址，而来自本机网页的请求 peer 同样是 127.0.0.1。
	// 所以「要求 JSON content-type」是唯一挡得住「本机浏览器里的任意网页」的判据：
	// `application/json` 是 CORS 的**非简单**类型，跨站请求会先发预检，而本插件不返回
	// 任何 CORS 头 → 预检必败 → 真正的 POST 发不出去。`text/plain` 是简单类型、不会
	// 被预检拦住，所以必须**明确拒绝**它。
	const dir = await tmpDir("routes-mediatype");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		const body = { op: "setModel", model: "m", input: 1, output: 2 };

		for (const contentType of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data", "application/xml", null]) {
			const response = await invoke(OVERRIDES_PATH, { method: "POST", body, contentType });
			assert.equal(response.status, 400, `content-type: ${contentType} 必须被拒`);
			assert.deepEqual(response.body, { ok: false, error: "bad-request", detail: "unsupported-media-type" }, "必须给出稳定码，面板才能翻成中文");
		}
		assert.deepEqual(await readdir(dir), [], "被拒的请求不得创建任何文件");

		// 正向对照：带对 content-type 的同一个请求必须通过。大小写与参数（`;charset=…`）
		// 都要容忍——真实浏览器发的是 `application/json;charset=UTF-8`。
		for (const contentType of ["application/json", "application/json;charset=UTF-8", "Application/JSON"]) {
			const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { ...body, model: `ok-${contentType.length}` }, contentType });
			assert.equal(response.status, 200, `content-type: ${contentType} 必须通过`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// **条件注册**，不是「注册后 skip」——见 `canDenyRead` 的注释：在跑不了的平台上这条
// 用例根本不存在，TAP 里也就没有它，CI 的 `skipped == 0` 闸门保持成立。
// 本机 Windows 上照常真跑（`skipped` 里不会多出这一条，它本来就在 `tests` 里）。
if (canDenyRead) {
	test("写入：文件存在、可写、但**读取失败**（EPERM/EACCES）→ 拒绝写，字节逐字未变", async () => {
		// 这是**同一个静默丢数据缺陷的第二个入口**，比损坏 JSON 那个更隐蔽。
		//
		// 实测（Windows，`icacls <file> /deny <user>:(R)`）：`readFile` 抛 **EPERM**，而
		// `rename` **成功**——`rename` 只替换目录项，**不需要读目标文件**。所以
		// 「读不到 → 当作空表 → 写入」会把用户手写的整份 overrides 清空（返回 200、无备份）。
		// 第一版把这种情况判成 `"ok"`，注释里写的「写入会自然失败」是**错的**。
		//
		// 只在 `canDenyRead` 为真时注册（即 Windows + 有用户名）。这不是「跳过」：
		// 跑不了的平台上它不在 TAP 里。判据本身由 `classifyOverridesReadError` 的纯函数
		// 用例在**所有平台**逐条守住，这里少掉的只是真实 ACL 下的端到端链路。
		const dir = await tmpDir("routes-unreadable");
		const overridesFile = join(dir, "usage-ledger-overrides.json");
		const original = '{\n  "version": 1,\n  "models": { "hand-written-important": { "input": 1, "output": 2 } },\n  "aliases": {}\n}\n';
		try {
			await writeFile(overridesFile, original, "utf8");
			// 注册条件保证了平台可用，但 `icacls` 仍可能调用失败（权限、策略）。那时
			// **断言失败**而不是静默放过——注册了就必须真跑，这正是「不许用环境换绿」。
			assert.equal(await denyRead(overridesFile), true, "本平台应当能造出「可写不可读」：icacls 调用失败说明这条用例没测到东西");
			try {
				// 前置条件必须成立：真的读不到、但真的写得动。否则这条用例测的是别的东西。
				let readCode = null;
				try {
					await readFile(overridesFile, "utf8");
				} catch (error) {
					readCode = error?.code;
				}
				assert.notEqual(readCode, null, "前置条件：readFile 必须真的失败（否则 ACL 没生效，这条用例测不到东西）");
				assert.equal(await probeOverridesFile(overridesFile), "unreadable", `读取抛 ${readCode} 时必须判成 unreadable（第一版在这里返回 ok，导致静默清空）`);

				// 前置条件之二：写入路径**确实能**成功——这正是缺陷成立的原因。
				// 用一个独立的空目录证明 rename 不需要读目标文件。
				const probeDir = await tmpDir("routes-rename-proof");
				try {
					const target = join(probeDir, "t.json");
					const temp = join(probeDir, "t.tmp");
					await writeFile(target, "old", "utf8");
					await writeFile(temp, "new", "utf8");
					await rename(temp, target);
					assert.equal(await readFile(target, "utf8"), "new", "rename 不需要读目标文件——所以「读不到」绝不能当成「没有内容」");
				} finally {
					await rm(probeDir, { recursive: true, force: true });
				}

				const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
				for (const body of [
					{ op: "setModel", model: "brand-new", input: 5, output: 6 },
					{ op: "remove", target: "model", id: "hand-written-important" },
				]) {
					const response = await invoke(OVERRIDES_PATH, { method: "POST", body });
					assert.equal(response.status, 409, `${body.op} 在「可写不可读」状态下必须被拒`);
					assert.deepEqual(response.body, { ok: false, error: "bad-request", detail: "overrides-unreadable" });
				}
			} finally {
				await allowRead(overridesFile);
			}

			// 恢复后文件必须逐字未变——那里面是用户手写的内容。
			assert.equal(await readFile(overridesFile, "utf8"), original, "被拒的写入必须让文件**逐字不变**");
			assert.deepEqual(await readdir(dir), ["usage-ledger-overrides.json"], "被拒后不得留下临时文件");
		} finally {
			await allowRead(overridesFile);
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("判据分支：错误码 → 三态，逐条钉住（EISDIR 必须维持 ok，否则 500 那条用例会变红）", () => {
	// 纯函数判据，不依赖平台能不能造出真实 ACL 状态。三条分支各有明确后果：
	//   absent     → 基于空表写（没写过是正常的）
	//   ok         → 放行；写入会自行失败并报 500（目标不是普通文件）
	//   unreadable → 拒绝写（可能有内容会被丢掉）
	assert.equal(classifyOverridesReadError({ code: "ENOENT" }), "absent", "没写过 → 正常写");
	assert.equal(classifyOverridesReadError({ code: "EISDIR" }), "ok", "目标是目录 → 交给写入路径报 500（既有用例依赖这一条）");
	assert.equal(classifyOverridesReadError({ code: "ENOTDIR" }), "ok", "路径中段不是目录 → 同上，写入必然失败");
	for (const code of ["EPERM", "EACCES", "ELOOP", "EBUSY", "EROFS", "UNKNOWN"]) {
		assert.equal(
			classifyOverridesReadError({ code }),
			"unreadable",
			`${code} 必须判成 unreadable：\`rename\` 不需要读目标文件，写入会**成功**并覆盖掉读不到的内容（实测 EPERM 下 rename 成功）`,
		);
	}
	// 没有 code 的错误（或非错误对象）一律从严——宁可拒绝写，也不要静默丢内容。
	assert.equal(classifyOverridesReadError(new Error("boom")), "unreadable", "没有 code 的错误必须从严");
	assert.equal(classifyOverridesReadError(undefined), "unreadable", "undefined 必须从严");
});

test("写入：setAlias 目标必须在合并后 models 里；写成功后 GET /unpriced 立刻把它定价", async () => {
	const dir = await tmpDir("routes-setalias");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	const sessions = join(dir, "sessions");
	try {
		// 一条日志记录：模型 id 是渠道专有的 `relay-x/deepseek-flash`。
		await mkdir(join(sessions, "work", "session-1"), { recursive: true });
		await writeFile(
			join(sessions, "work", "session-1", "session.v4.jsonl.zstd"),
			sessionBytes([sessionEvent({ id: "session-1" }), billedEvent({ provider: "relay-x", model: "relay-x/deepseek-flash", input: 1000, output: 100 })]),
		);

		const { invoke } = mount({ config: { sessionsRoot: sessions, pricingFile: false, overridesFile } });

		// 前置条件：这个 id 现在是未定价的。
		const before = await invoke(UNPRICED_PATH, { method: "GET" });
		assert.deepEqual(before.body.items.map((item) => item.id), ["relay-x/relay-x/deepseek-flash"], "前置条件：该记录当前未定价");

		// 目标不存在 → 400 unknown-model（不能写出死别名）。
		const dead = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setAlias", alias: "relay-x/deepseek-flash", model: "no-such-model" } });
		assert.equal(dead.status, 400);
		assert.equal(dead.body.detail, "unknown-model");

		// 先把目标模型写进 overrides（这样它才是「合并后 models 的自有键」）。
		const model = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "deepseek-flash", input: 2, output: 8, currency: "CNY" } });
		assert.equal(model.status, 200);

		// 目标存在（而且**同时**是别名键）→ 通过。ADR 字面的「不能是另一个别名」会让这类
		// 最常用的目标全部不可写（运行时表 27 条别名里 23 条如此）。
		const ok = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setAlias", alias: "relay-x/deepseek-flash", model: "deepseek-flash", reason: "同型号" } });
		assert.equal(ok.status, 200, "目标是合并后 models 的自有键就应当通过，即使它同时也是别名键");

		const parsed = JSON.parse(await readFile(overridesFile, "utf8"));
		assert.equal(parsed.aliases["relay-x/deepseek-flash"].model, "deepseek-flash");
		assert.equal(parsed.aliases["relay-x/deepseek-flash"].origin, "panel", "origin 由服务端强制");
		assert.equal(typeof parsed.aliases["relay-x/deepseek-flash"].addedAt, "string", "addedAt 由服务端强制");
		assert.match(parsed.aliases["relay-x/deepseek-flash"].addedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

		// 写后可见：紧跟着的 GET /unpriced 必须看到这一行已经可定价。
		// 宿主端在写入成功后把节流戳归零，所以这里**不需要**等 30 秒——不这样做的话，
		// 用户刚认领完就会看到同一行**仍然未定价**，而面板会以为写入没生效。
		const after = await invoke(UNPRICED_PATH, { method: "GET" });
		assert.equal(after.status, 200);
		assert.deepEqual(after.body.items, [], "刚写进去的别名必须立刻让这一行可定价（写后可见性）");
		assert.ok(after.body.candidates.some((entry) => entry.id === "deepseek-flash"), "刚写进去的目标模型必须立刻出现在候选清单里");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：remove 幂等——删不存在的 id 仍 200，且文件内容逐字节不变", async () => {
	const dir = await tmpDir("routes-remove");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "keep-me", input: 1, output: 2 } });
		const before = await readFile(overridesFile, "utf8");

		const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "remove", target: "model", id: "never-existed" } });
		assert.equal(response.status, 200, "删一个本来就没有的键，结果与用户期望一致——幂等");
		assert.deepEqual(response.body, { ok: true, op: "remove", path: overridesFile, version: OVERRIDES_VERSION });
		assert.equal(await readFile(overridesFile, "utf8"), before, "没有实际改动时文件内容不得变化（不得空写）");

		// 真的删掉。
		const removed = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "remove", target: "model", id: "keep-me" } });
		assert.equal(removed.status, 200);
		assert.deepEqual(JSON.parse(await readFile(overridesFile, "utf8")).models, {}, "remove 只删 overrides 里的键");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：remove 只删 overrides，绝不触碰主表", async () => {
	const dir = await tmpDir("routes-main-table");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	const pricingFile = join(dir, "pricing.json");
	try {
		const mainTable = { models: { "main-model": { input: 9, output: 9, currency: "CNY" } }, aliases: { "main-alias": "main-model" }, rates: {} };
		await writeFile(pricingFile, JSON.stringify(mainTable), "utf8");
		const mainBefore = await readFile(pricingFile, "utf8");

		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile, overridesFile } });
		// 删一个**只存在于主表**的键：主表必须一字不动。
		const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "remove", target: "model", id: "main-model" } });
		assert.equal(response.status, 200);
		assert.equal(await readFile(pricingFile, "utf8"), mainBefore, "主表是仓库同步来的目录，绝不能改（下次同步就被覆盖）");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：version > 1 时拒绝写且文件字节不变", async () => {
	const dir = await tmpDir("routes-version");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const original = '{\n  "version": 2,\n  "models": { "x": { "input": 1, "output": 2 } },\n  "aliases": {}\n}\n';
		await writeFile(overridesFile, original, "utf8");

		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "y", input: 1, output: 2 } });

		assert.equal(response.status, 400);
		assert.deepEqual(response.body, { ok: false, error: "bad-request", detail: "unsupported-version" }, "版本比插件新时拒绝写入（避免覆盖用户的新格式）");
		assert.equal(await readFile(overridesFile, "utf8"), original, "被拒的写入必须让文件一字不动");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：并发 8 个 setModel 全部落盘（模块级 promise 链串行化）", async () => {
	const dir = await tmpDir("routes-concurrent");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		const responses = await Promise.all(
			Array.from({ length: 8 }, (_unused, index) =>
				invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: `concurrent-${index}`, input: index, output: index } }),
			),
		);

		for (const response of responses) assert.equal(response.status, 200, "并发写入每一个都必须 200");
		const parsed = JSON.parse(await readFile(overridesFile, "utf8"));
		assert.equal(
			Object.keys(parsed.models).length,
			8,
			"8 个键必须**全部**存在：每个 op 若各自「读当前 → 改 → 写回」，后写的那次会覆盖先写的那次（丢更新），" +
				"而两次都返回 200——这正是串行化要挡的",
		);
		for (let index = 0; index < 8; index += 1) assert.ok(Object.hasOwn(parsed.models, `concurrent-${index}`), `concurrent-${index} 丢了`);
		assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), [], "并发写入不得留下 .tmp 残留");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：落盘失败（目标是个目录）→ 500 internal，且不破坏原文件", async () => {
	const dir = await tmpDir("routes-fail");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		// 目标路径是一个**目录**：rename 覆盖它会失败（EISDIR/EPERM）。
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overridesFile);
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		const response = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "m", input: 1, output: 2 } });

		assert.equal(response.status, 500);
		assert.deepEqual(response.body, { ok: false, error: "internal" }, "落盘失败必须 500，且文件保持原样");
		assert.deepEqual(await readdir(dir), ["usage-ledger-overrides.json"], "失败后不得留下临时文件");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写入：body 校验（V4/V5/V7/V9/V10/V12/V13）逐条给出稳定错误码", async () => {
	const dir = await tmpDir("routes-validate");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile, currency: "CNY", rates: { USD: 7.3 } } });
		const cases = [
			[{ chunks: [Buffer.alloc(70_000, 0x20)] }, "body-too-large"],
			["{ not json", "invalid-body"],
			["null", "invalid-body"],
			["[1,2]", "invalid-body"],
			['"x"', "invalid-body"],
			[{ op: "nope" }, "unknown-op"],
			[{ op: "setModel", model: "m", input: 1, output: 2, alias: "a" }, "unknown-field"],
			[{ op: "setAlias", alias: "a", model: "m", input: 1 }, "unknown-field"],
			[{ op: "setModel", model: "", input: 1, output: 2 }, "invalid-id"],
			[{ op: "setModel", model: "m", input: "1.5", output: 2 }, "invalid-price"],
			[{ op: "setModel", model: "m", input: 1, output: -1 }, "invalid-price"],
			[{ op: "setModel", model: "m", input: 1, output: 2, cacheRead: null }, "invalid-price"],
			[{ op: "setModel", model: "m", input: 1, output: 2, currency: "" }, "invalid-currency"],
			[{ op: "setModel", model: "m", input: 1, output: 2, currency: "JPY" }, "unknown-currency"],
			[{ op: "setModel", model: "m", input: 1, output: 2, note: "x".repeat(201) }, "invalid-note"],
			[{ op: "setAlias", alias: "a", model: "m", reason: "x".repeat(201) }, "invalid-reason"],
			[{ op: "remove", target: "nope", id: "x" }, "unknown-target"],
			[{ op: "remove", target: "model", id: "__proto__" }, "invalid-id"],
			[{ op: "remove", target: "model", id: "constructor" }, "invalid-id"],
			[{ op: "setModel", model: "constructor", input: 1, output: 2 }, "invalid-id"],
		];

		for (const [body, detail] of cases) {
			const response = await invoke(OVERRIDES_PATH, { method: "POST", body });
			assert.equal(response.status, 400, `${JSON.stringify(body)} 必须 400`);
			assert.deepEqual(response.body, { ok: false, error: "bad-request", detail }, `期望 detail = ${detail}`);
		}

		// 正向对照：合法请求必须通过（否则上面每条都可能只是「所有请求都被拒」）。
		const ok = await invoke(OVERRIDES_PATH, { method: "POST", body: { op: "setModel", model: "m", input: 1, output: 2, currency: "USD" } });
		assert.equal(ok.status, 200, "currency: USD 在 rates 里有有限数汇率，必须通过");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("装配：{pricingFile:false} 但配了 overridesFile 时仍然读 overrides（早退条件的回归点）", async () => {
	// 原实现写的是 `if (pricingFile === undefined || …) return;`——`pricingFile: false` 时
	// 连 overrides 一起不读，用户在主表被关掉时写的全部手工修正都会静默失效，而面板
	// 照常显示「未定价」。
	const dir = await tmpDir("routes-early-return");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	try {
		await writeFile(overridesFile, JSON.stringify({ version: 1, models: { "hand-written": { input: 1, output: 2, currency: "CNY" } }, aliases: {} }), "utf8");

		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile } });
		const response = await invoke(UNPRICED_PATH, { method: "GET" });

		assert.equal(response.status, 200);
		assert.deepEqual(
			response.body.candidates.map((entry) => entry.id),
			["hand-written"],
			"pricingFile: false 时 overrides **必须**仍然被读——早退条件只看 pricingFile 会让这条手工修正静默消失",
		);
		assert.equal(response.body.candidates[0].source, "overrides", "source 记该行来自 overrides 层");
		assert.equal(response.body.overrides.exists, true);
		assert.equal(response.body.overrides.version, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("装配：两个文件都没配时 refreshPricing 不抛错、不刷日志", async () => {
	const dir = await tmpDir("routes-no-files");
	const { warned, logger } = makeLogger();
	const registered = [];
	const ctx = {
		logger,
		effect: (factory) => factory(),
		inject: (names, callback) => {
			if (names.includes("webServer")) callback({ webServer: { register: (route) => registered.push(route) } });
		},
	};
	try {
		apply(ctx, { sessionsRoot: join(dir, "sessions"), pricingFile: false, overridesFile: false });
		const route = registered.find((entry) => entry.path === UNPRICED_PATH);
		let status = null;
		await route.handler(
			{ method: "GET", url: UNPRICED_PATH, socket: { remoteAddress: LOOPBACK }, async *[Symbol.asyncIterator]() {} },
			{ writeHead(code) { status = code; }, end() {} },
		);
		assert.equal(status, 200, "两个文件都没配时接口照样 200（价格是锦上添花，不能拖垮面板）");
		assert.deepEqual(warned, [], "「没配文件」是常态，不该刷日志");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("装配：主表被整份替换后，overrides 里的手工修正仍然生效", async () => {
	const dir = await tmpDir("routes-replace");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	const pricingFile = join(dir, "pricing.json");
	try {
		await writeFile(overridesFile, JSON.stringify({ version: 1, models: { "manual-fix": { input: 1, output: 2, currency: "CNY" } }, aliases: {} }), "utf8");
		// 先给一份「有别的模型」的主表。
		await writeFile(pricingFile, JSON.stringify({ models: { "other-model": { input: 9, output: 9, currency: "CNY" } }, aliases: {}, rates: {} }), "utf8");
		const { invoke } = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile, overridesFile } });

		const first = await invoke(UNPRICED_PATH, { method: "GET" });
		assert.deepEqual(first.body.candidates.map((entry) => entry.id).sort(), ["manual-fix", "other-model"], "两个文件的内容都在");

		// 整份替换主表（换一份完全没有 manual-fix 的文件）。
		//
		// 这里**重新装一次**插件，而不是在同一个实例上再发一次请求：`refreshPricing`
		// 有 30 秒节流（既有行为，改完价格不必重启、也不必每个请求都碰磁盘），同一个
		// 实例上紧跟的第二次请求读的仍是缓存。重装等于「重启之后」，而 ADR-0008 验收 5
		// 要的正是「主表整份替换**之后**手工修正还在不在」——那是一个跨进程重启的事实。
		await writeFile(pricingFile, JSON.stringify({ models: { "brand-new-table": { input: 1, output: 1, currency: "CNY" } }, aliases: {}, rates: {} }), "utf8");
		const restarted = mount({ config: { sessionsRoot: join(dir, "sessions"), pricingFile, overridesFile } });
		const second = await restarted.invoke(UNPRICED_PATH, { method: "GET" });

		assert.ok(second.body.candidates.some((entry) => entry.id === "manual-fix"), "主表整份替换后手工修正必须仍然生效（ADR-0008 验收 5）");
		assert.ok(second.body.candidates.some((entry) => entry.id === "brand-new-table"), "新主表的内容也在");
		assert.equal(second.body.candidates.some((entry) => entry.id === "other-model"), false, "旧主表的条目必须随整份替换一起消失——否则上面的「还在」可能只是没重读");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("装配：overrides 覆盖主表时记 warn，且每条键最多一条", async () => {
	const dir = await tmpDir("routes-shadow");
	const overridesFile = join(dir, "usage-ledger-overrides.json");
	const pricingFile = join(dir, "pricing.json");
	const { warned, logger } = makeLogger();
	try {
		await writeFile(pricingFile, JSON.stringify({ models: { "shadowed": { input: 1, output: 1, currency: "CNY" } }, aliases: { "shadowed-alias": "shadowed" }, rates: {} }), "utf8");
		await writeFile(
			overridesFile,
			JSON.stringify({
				version: 1,
				models: { shadowed: { input: 2, output: 2, currency: "CNY" } },
				aliases: { "shadowed-alias": { model: "shadowed" } },
			}),
			"utf8",
		);

		const registered = [];
		const { warned, logger } = makeLogger();
		const ctx = {
			logger,
			effect: (factory) => factory(),
			inject: (names, callback) => {
				if (names.includes("webServer")) callback({ webServer: { register: (route) => registered.push(route) } });
			},
		};
		apply(ctx, { sessionsRoot: join(dir, "sessions"), pricingFile, overridesFile });
		await registered.find((entry) => entry.path === UNPRICED_PATH).handler(
			{ method: "GET", url: UNPRICED_PATH, socket: { remoteAddress: LOOPBACK }, async *[Symbol.asyncIterator]() {} },
			{ writeHead() {}, end() {} },
		);

		const modelWarns = warned.filter((args) => String(args[0]).includes("overrides model"));
		const aliasWarns = warned.filter((args) => String(args[0]).includes("overrides alias"));
		assert.equal(modelWarns.length, 1, "overrides 覆盖同名 model 记一条 warn");
		assert.equal(aliasWarns.length, 1, "overrides 覆盖同名 alias 记一条 warn");
		assert.match(String(modelWarns[0][0]), /%s/, "warn 文案用占位符传参（与既有 logger 口径一致）");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
