/**
 * usage-ledger 宿主端。
 *
 * 职责只有三件：扫描本地会话日志、按范围聚合、把结果交给浏览器。
 *
 * 设计上刻意**不碰网络、不读凭据、不做中转站归属推断**——数据源本身就是
 * 权威的：每条 `assistant/message` 都带着计费用量和实际服务该请求的渠道。
 * 这消除了前一版插件依赖宿主 `settings.get(ns)` 才发现不了中转站的那类问题。
 *
 * @module usage-ledger
 */

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { aggregate, createScanner, diskSource, localDayKey } from "./scan.js";

/** Cordis 插件名。 */
export const name = "usage-ledger";

/** 面板读取的接口前缀。 */
export const BASE_PATH = "/api/usage-ledger";

/**
 * 未定价探测接口的路径（ADR-0008 §2）。
 *
 * 宿主 webserver 的 `register()` 以 `(kind, path)` 建键、重复注册抛错，所以
 * 「复用现有 handler 注册第二个路径」在宿主端做不到——它必须是**独立的**一条路由，
 * 因而也必须有**自己的**方法闸门（现有那条只覆盖 `BASE_PATH` 这一个 pathname）。
 */
export const UNPRICED_PATH = `${BASE_PATH}/unpriced`;

/**
 * overrides 写入接口的路径（ADR-0008 §4）。
 *
 * 只接受 `POST`：读 overrides 的内容走 `GET ${UNPRICED_PATH}`，这里只负责写。
 */
export const OVERRIDES_PATH = `${BASE_PATH}/overrides`;

/** overrides 文件格式版本；本插件只写这个值（规格 §12）。 */
export const OVERRIDES_VERSION = 1;

/** POST body 上限（字节）。超过立即 400 `body-too-large`。 */
export const MAX_BODY_BYTES = 65536;

/** 模型 id / 别名长度上限。 */
export const MAX_ID_LENGTH = 200;

/** `note` / `reason` 长度上限。 */
export const MAX_TEXT_LENGTH = 200;

/** 每个未定价模型的建议条数上限。 */
export const MAX_SUGGESTIONS = 3;

/**
 * 「未定价」的两种成因（规格 §3 的 `cause`）。
 *
 * 这是**跨端枚举**：宿主端只产出这两个值，浏览器端按它们决定显示哪句话
 * （`no-rate` 的行会标注「缺汇率」）。两端各写一份字面量，所以它必须是导出常量，
 * 由 `test/contract.test.js` 逐字比对——`cause` 改名或加值而客户端没跟上时，
 * 面板上那句提示会**静默消失**（不报错，只是不再出现），这正是契约测试要挡的。
 */
export const UNPRICED_CAUSE_KINDS = ["no-price", "no-rate"];

/**
 * `GET ${UNPRICED_PATH}` 响应里、浏览器端会按名读取的字段。
 *
 * 与 {@link UNPRICED_CAUSE_KINDS} 同一个理由：字段名两端各写一份，改名后浏览器端
 * 读到 `undefined`——`items` 变成 `[]`（区块整块不渲染）、`overrides.path` 变成空串
 * （「写入路径」那行消失）、`candidate.aliasTarget` 变成 `undefined`（「只做一跳」的
 * 提示消失）。三种都不会报错，只会少一块内容。所以把名字提成常量，让契约测试盯着。
 */
export const UNPRICED_FIELDS = {
	items: "items",
	candidates: "candidates",
	overrides: "overrides",
	overridesPath: "path",
	overridesEnabled: "enabled",
	aliasTarget: "aliasTarget",
	cause: "cause",
};

/**
 * 拒绝写入的原型保留名。
 *
 * 实测（规格 F18）：`obj["__proto__"] = v` 在普通对象上会被原型 setter 吞掉——键数
 * 仍为 0、原型被替换。所以这三个名字既不能当模型 id，也不能当别名。
 */
export const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype"];

/** 控制字符：id 与文案里都不允许出现。 */
const CONTROL_CHARS = /[\u0000-\u001f]/;

/** 默认价格表文件名。 */
const PRICING_FILENAME = "usage-ledger-pricing.json";

/** 默认 overrides 文件名。 */
const OVERRIDES_FILENAME = "usage-ledger-overrides.json";

/**
 * 往普通对象上写一个**任意**键。
 *
 * 不能写 `target[key] = value`：键恰好是 `__proto__` 时那是一次原型赋值，条目会
 * 静默消失（实测键数为 0、原型被换掉，规格 F18）。`defineProperty` 走的是
 * DefineOwnProperty，不会碰原型。
 *
 * @param target - 目标对象。
 * @param key - 键（可能来自用户输入）。
 * @param value - 值。
 */
function setKey(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * 统一的 JSON 响应。
 *
 * 三条路由共用同一个助手：405 也走它，不留两套头（规格 D1）。`cache-control`
 * 不能省——接口内容随价格表热重载变化，缓存住会让面板显示旧数字。
 *
 * @param res - Node 响应。
 * @param status - 状态码。
 * @param value - 可序列化载荷。
 */
function sendJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

/**
 * 界面范围词表。
 *
 * 这是宿主端与浏览器端共用的**唯一**范围口径：客户端据此渲染标签页，宿主端据此
 * 解析 `range` 查询参数。任何一端单独增删都会让另一端静默失效，所以它必须是
 * 导出常量，由契约测试盯着。
 */
export const RANGE_KINDS = ["today", "week", "month", "all", "custom"];

/**
 * 承载 Web 服务的服务名。
 *
 * 两个名字都是真的：不同组合装的是其中哪一个，只问另一个就正好是「面板 404 却
 * 没有任何报错」的成因，所以两个都等。
 */
const WEB_SERVER_NAMES = ["webServer", "httpServer"];

/** 热力图覆盖的天数：一整年整周，避免首尾出现半截列。 */
export const ACTIVITY_DAYS = 371;

/**
 * 解析会话日志根目录。
 *
 * @param config - 插件配置。
 * @returns 绝对路径。
 */
export function resolveSessionsRoot(config = {}) {
	if (typeof config.sessionsRoot === "string" && config.sessionsRoot !== "") return config.sessionsRoot;
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "sessions");
}

/**
 * 把界面选的范围折算成闭区间日期。
 *
 * @param kind - `today` | `week` | `month` | `all` | `custom`。
 * @param from - `custom` 的起始日。
 * @param to - `custom` 的结束日。
 * @param now - 参照时刻（可注入，便于测试）。
 * @returns `{from, to, label}`；`from`/`to` 为 `null` 表示不设边界。
 */
export function resolveRange(kind, from, to, now = new Date()) {
	const today = localDayKey(now.getTime());
	switch (kind) {
		case "today":
			return { from: today, to: today, label: "今日" };
		case "week": {
			const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
			return { from: localDayKey(start.getTime()), to: today, label: "近 7 天" };
		}
		case "month":
			return { from: `${today.slice(0, 8)}01`, to: today, label: "本月" };
		case "custom": {
			const begin = typeof from === "string" && from !== "" ? from : null;
			const end = typeof to === "string" && to !== "" ? to : null;
			return { from: begin, to: end, label: begin === null && end === null ? "自定义（未设范围）" : `${begin ?? "最早"} → ${end ?? "今天"}` };
		}
		default:
			return { from: null, to: null, label: "累计" };
	}
}

/**
 * 按价格表估算一个桶的金额。
 *
 * 价格表按**每百万 token** 计价，键为模型 id。缺少该模型价格时返回
 * `undefined`——宁可不显示，也不拿 0 冒充「免费」。
 *
 * 各家官方价币种不同（DeepSeek/GLM/Kimi 是 CNY，Claude/OpenAI 是 USD），
 * 所以条目可带 `currency`；非目标币种的条目按 `rates` 折算。汇率缺失时
 * **不猜**——宁可返回 undefined 让该行显示「—」，也不拿一个编的汇率算错钱。
 *
 * @param bucket - 含分项 token 数的桶。
 * @param price - `{input, output, cacheRead, cacheWrite, currency?}`。
 * @param options - `{currency, rates}`；`rates` 形如 `{USD: 7.3}`（1 外币 = N 本币）。
 * @returns 金额，或 undefined。
 */
export function costOf(bucket, price, options = {}) {
	if (price === undefined || price === null) return undefined;
	const { currency = "CNY", rates = {} } = options;
	let scale = 1;
	const from = price.currency ?? currency;
	if (from !== currency) {
		const rate = rates[from];
		if (typeof rate !== "number" || !Number.isFinite(rate)) return undefined;
		scale = rate;
	}
	const per = (tokens, rate) => (typeof rate === "number" ? (tokens * rate * scale) / 1_000_000 : 0);
	return (
		per(bucket.inputTokens, price.input) +
		per(bucket.outputTokens, price.output) +
		per(bucket.cacheReadTokens, price.cacheRead) +
		per(bucket.cacheWriteTokens, price.cacheWrite)
	);
}

/**
 * 组装面板所需的完整载荷。
 *
 * `activity` 覆盖固定的一年窗口，与所选范围无关——热力图是「全年作息」，
 * 让它随范围伸缩会失去意义。因此这里只做**一次**摊平：取「所选范围」与
 * 「371 天窗口」的并集，同一次 `aggregate` 的结果同时供两者切片使用。
 *
 * @param records - 全部计费记录。
 * @param options - `{range, pricing, aliases, rates, currency, stats, now}`。
 * @returns 可直接序列化的载荷。
 */
export function buildPayload(records, options = {}) {
	const {
		range = { from: null, to: null, label: "累计" },
		pricing = {},
		aliases = {},
		rates = {},
		currency = "CNY",
		stats = {},
		now = new Date(),
	} = options;
	// 用**官方模型定价**当统一标尺，与请求实际走的渠道无关。
	//
	// 这是一个刻意的口径选择：本机的用量散落在官方直连与多个中转站上，同一份
	// token 在不同渠道的成交价相差数倍（有折扣、有加价、有积分制、有免费额度）。
	// 若按渠道计价，跨渠道的用量根本不可比——「今天比昨天贵」可能只是换了条路由。
	// 按官方挂牌价计价，数字回答的是「这些 token 若按官方价买值多少」，也就是
	// **消耗程度**，这才是要看的东西。
	//
	// 渠道专有的模型 id（如 `relay-flash-0731`、`relay-v4-1-flash`）
	// 通过 `aliases` 归一到官方模型 id；归一不了的就如实留空，不硬套一个价格。
	const aliasOf = (model) => aliases[model] ?? model;
	// 判存在必须用**自有键**，不能用 `in`。
	//
	// `in` 会走原型链：模型 id 恰好叫 `constructor`/`toString`/`valueOf` 时，
	// `"constructor" in {}` 是 true，于是 `pricing["constructor"]` 取到一个**函数**，
	// `costOf` 拿它当价格算，返回 0——面板显示 ¥0.00，而未定价集合为空。这与
	// ADR-0001「宁可显示 —，也不拿 0 冒充免费」直接冲突（实测复现，规格 F16/F17）。
	const officialIdOf = (model) => {
		const canonical = aliasOf(model);
		return Object.hasOwn(pricing, canonical) ? canonical : undefined;
	};

	// 371 天窗口的起点。用本地日期做减法（不是固定毫秒），跨夏令时也不会偏一天。
	const since = new Date(now.getTime());
	since.setDate(since.getDate() - (ACTIVITY_DAYS - 1));
	const sinceDay = localDayKey(since.getTime());

	// 并集区间：起点取「范围起点」与「窗口起点」中更早的一个；**上界始终不设**。
	// 上界不能沿用 `range.to`——热力图与所选范围无关，若跟着 `to` 截断，用户把
	// 自定义范围选到过去时，整张全年热力图会凭空缩短。`from === null` 表示不设
	// 下界，此时并集同样不设下界，否则会漏掉范围里更早的日期。
	const unionFrom = range.from === null || range.from < sinceDay ? range.from : sinceDay;
	const union = aggregate(records, { from: unionFrom, to: null });
	// 仅当并集恰好等于所选范围时才复用：即下界相同、且范围本身不设上界。
	// 其余情况（today/week/month、带 `to` 的自定义范围）必须按范围再摊平一次，
	// 否则 totals/providers/models 会把窗口内、范围外的记录也算进去。
	const scoped = unionFrom === range.from && range.to === null ? union : aggregate(records, range);

	const unpriced = new Set();
	let totalCost = 0;
	let priced = false;
	/** 渠道 → 其名下已定价模型的**未舍入**成本之和。 */
	const providerCost = new Map();

	const models = scoped.models.map((row) => {
		const officialId = officialIdOf(row.model);
		const price = officialId === undefined ? undefined : pricing[officialId];
		const cost = costOf(row, price, { currency, rates });
		if (cost === undefined) unpriced.add(`${row.provider}/${row.model}`);
		else {
			totalCost += cost;
			priced = true;
			// 渠道成本在这里一次算清：模型成本只算一遍，按渠道累加。
			providerCost.set(row.provider, (providerCost.get(row.provider) ?? 0) + cost);
		}
		return {
			...row,
			officialModel: officialId ?? null,
			cost: cost === undefined ? null : Math.round(cost * 10000) / 10000,
		};
	});

	const providers = scoped.providers.map((row) => {
		// 渠道成本 = 名下已定价模型的**未舍入**成本之和，最后只舍入一次。
		// 若改成累加已舍入的模型成本，逐项误差会累积，渠道总额随之漂移。
		const sum = providerCost.get(row.provider);
		return { ...row, cost: sum === undefined ? null : Math.round(sum * 10000) / 10000 };
	});

	// 热力图只需要三字段，且只含窗口内的日期——不要直接把 days 塞进去。
	//
	// 这里**只有下界**，没有上界：`sinceDay` 之前的日期被排除，但未来日期会照常
	// 落进网格。这是沿用已久的既有行为（本机 11695 条记录里未来日期为 0 条，所以
	// 从未显现），不是疏漏——热力图表达的是「作息」，而记录本不该出现未来时间。
	// 若将来要加上界，请注意它与 `range.to` 无关：加错地方会让「自定义范围选到
	// 过去」把整张全年热力图截短，那是真实回归。
	const activity = union.days
		.filter((row) => row.day >= sinceDay)
		.map((row) => ({ day: row.day, tokens: row.tokens, requests: row.requests }));

	return {
		ok: true,
		generatedAt: now.getTime(),
		timeZone: {
			name: Intl.DateTimeFormat().resolvedOptions().timeZone,
			offset: -now.getTimezoneOffset() / 60,
		},
		range,
		totals: scoped.totals,
		providers,
		models,
		activity,
		activityDays: ACTIVITY_DAYS,
		cost: {
			currency,
			total: priced ? Math.round(totalCost * 100) / 100 : null,
			priced,
			unpriced: [...unpriced].sort(),
		},
		diagnostics: { ...stats, matched: scoped.matched },
	};
}

/**
 * 解析价格表文件的默认位置。
 *
 * 默认放在 `$DSH_HOME/usage-ledger-pricing.json`，与 `settings.yaml` 同级——
 * 它是一份用户可编辑的数据，不该塞进 profile 的 node_modules 里。
 *
 * @param config - 插件配置。
 * @returns 绝对路径。
 */
export function resolvePricingFile(config = {}) {
	if (typeof config.pricingFile === "string" && config.pricingFile !== "") return config.pricingFile;
	if (config.pricingFile === false) return undefined;
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "usage-ledger-pricing.json");
}

/**
 * 只允许回环地址读取。
 *
 * 接口暴露的是本机全部会话的用量画像（含模型与项目规模），不该被局域网里的
 * 其他机器读到。peer 地址不可伪造，所以它是判据；Host 只作补充。
 *
 * @param req - Node 请求。
 * @returns 允许时 undefined，否则 `{status, body}`。
 */
export function screenRequest(req) {
	const peer = req?.socket?.remoteAddress ?? "";
	const ok = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
	if (ok) return undefined;
	return { status: 403, body: { ok: false, error: "forbidden" } };
}

/**
 * 读取价格表文件。
 *
 * 模型价格写进 `cordis.patch.yml` 会难以维护（改一个数字要动 profile 配置，还要
 * 重启）。所以支持一个独立的 JSON 文件：改完下一次请求即生效。
 *
 * 文件同时携带 `aliases`——本机模型 id → 官方模型 id 的映射。渠道专有的 id
 * （`relay-flash-0731`、`relay-v4-1-flash` 等）靠它归一到官方价，
 * 这样「用官方定价衡量消耗程度」才覆盖得到全部用量。
 *
 * 文件缺失或损坏时返回空表而不是抛错——价格是锦上添花，**绝不能因为它读不到
 * 就让整个用量面板挂掉**。
 *
 * @param file - 绝对路径，或 undefined。
 * @param logger - 可选日志器。
 * @returns `{models, aliases}`；两者都可能是空对象。
 */
export async function loadPricingFile(file, logger) {
	if (typeof file !== "string" || file === "") return { models: {}, aliases: {}, rates: {} };
	try {
		const text = await readFile(file, "utf8");
		const parsed = JSON.parse(text);
		const models = parsed?.models ?? parsed;
		if (models === null || typeof models !== "object" || Array.isArray(models)) {
			logger?.warn?.("usage-ledger: pricing file %s has no usable table", file);
			return { models: {}, aliases: {}, rates: {} };
		}
		const aliases = parsed?.aliases;
		const rates = parsed?.rates;
		return {
			models,
			aliases: aliases !== null && typeof aliases === "object" && !Array.isArray(aliases) ? aliases : {},
			rates: rates !== null && typeof rates === "object" && !Array.isArray(rates) ? rates : {},
		};
	} catch (error) {
		if (error?.code !== "ENOENT") logger?.warn?.("usage-ledger: pricing file %s unreadable: %s", file, error?.message ?? error);
		return { models: {}, aliases: {}, rates: {} };
	}
}

/**
 * 解析 overrides 文件的默认位置（ADR-0008 §1）。
 *
 * 规则**逐条对齐** {@link resolvePricingFile}，因为两者是同一类东西（用户可编辑的
 * 独立 JSON 数据文件），口径分叉会让「为什么这个 false 关得掉、那个关不掉」变成
 * 靠记忆回答的问题：
 *
 * | `config.overridesFile` | 结果 |
 * |---|---|
 * | 非空字符串 | 原样返回（不做绝对化；测试用的接缝） |
 * | `false` | `undefined`——**显式关闭写入**，POST 一律 403 |
 * | 其它（空串/undefined/null/数字/对象/数组） | `join(home, "usage-ledger-overrides.json")` |
 *
 * @param config - 插件配置。
 * @returns 绝对路径，或 undefined（写入被关闭）。
 */
export function resolveOverridesFile(config = {}) {
	if (typeof config.overridesFile === "string" && config.overridesFile !== "") return config.overridesFile;
	if (config.overridesFile === false) return undefined;
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, OVERRIDES_FILENAME);
}

/**
 * 把任意形态的别名表规范成**对象值**的统一表示。
 *
 * 这是 ADR-0008 §1 那句「字符串或对象」的可执行形式：主表现有的别名值**全是字符串**
 * （仓库 20 条 / 运行时 27 条，实测），新格式是对象。两者都要能用，且**字符串那条
 * 必须一字不改地继续工作**——它是向后兼容的全部内容。
 *
 * 丢弃规则（返回 `{}` 或跳过该项，都**不抛错**，与 `loadPricingFile` 对坏附属段的
 * 降级同源）：
 *
 * - `raw` 不是非数组对象 → 空表；
 * - 值是**非空字符串** → `{model: 值}`（旧格式）；
 * - 值是**对象**且 `model` 是非空字符串 → 原样收下（额外键忽略）；
 * - 键是 `__proto__` / `constructor` / `prototype`，或空串 / 含控制字符 → 丢弃；
 * - 其余（`null` / 数字 / 数组 / 缺 `model` 的对象 / 空串 `model`）→ 丢弃。
 *
 * @param raw - 原始别名表。
 * @param onDrop - 每丢弃一个键调用一次（可缺省）；参数是那个键。
 * @returns `Record<string, {model: string, reason?: string, addedAt?: string, origin?: string}>`。
 */
export function normalizeAliasMap(raw, onDrop) {
	const out = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const key of Object.keys(raw)) {
		if (key === "" || CONTROL_CHARS.test(key) || PROTOTYPE_KEYS.includes(key)) {
			onDrop?.(key);
			continue;
		}
		const value = raw[key];
		if (typeof value === "string") {
			if (value === "") {
				onDrop?.(key);
				continue;
			}
			setKey(out, key, { model: value });
			continue;
		}
		if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.model === "string" && value.model !== "") {
			const entry = { model: value.model };
			if (typeof value.reason === "string") entry.reason = value.reason;
			if (typeof value.addedAt === "string") entry.addedAt = value.addedAt;
			if (typeof value.origin === "string") entry.origin = value.origin;
			setKey(out, key, entry);
			continue;
		}
		onDrop?.(key);
	}
	return out;
}

/**
 * 读取 overrides 文件（ADR-0008 §1 的 schema）。
 *
 * 容错口径**逐条对齐** `loadPricingFile`：读不到、没写过（ENOENT）都返回空形状且
 * **不 warn**；损坏或结构不可用返回空形状 + **一次** warn；`models` / `aliases`
 * 各自独立降级，绝不因为一段坏掉就把另一段作废。
 *
 * 版本策略：无 `version` 键当作 `1`（手写文件是常态，不 warn）；`version === 1` 正常；
 * 整数 `> 1` 仍**尽力合并** `models`/`aliases`（能用的数据不该被丢掉）但记一次
 * `unsupported-version` warn；其余（非整数 / `< 1` / 非数字）当作 `1` 并 warn 一次。
 *
 * @param file - 绝对路径，或 undefined。
 * @param logger - 可选日志器。
 * @returns `{version, models, aliases, exists}`；`version` 为 null 表示「没读到」。
 */
export async function loadOverridesFile(file, logger) {
	const empty = { version: null, models: {}, aliases: {}, exists: false };
	if (typeof file !== "string" || file === "") return empty;
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		// 没写过 overrides 是常态：ENOENT 静默返回空形状，与 `loadPricingFile` 同一口径。
		if (error?.code === "ENOENT") return empty;
		logger?.warn?.("usage-ledger: overrides file %s unreadable: %s", file, error?.message ?? error);
		return empty;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		logger?.warn?.("usage-ledger: overrides file %s is not valid JSON: %s", file, error?.message ?? error);
		return { version: null, models: {}, aliases: {}, exists: true };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		logger?.warn?.("usage-ledger: overrides file %s has no usable table", file);
		return { version: null, models: {}, aliases: {}, exists: true };
	}

	// 版本：缺失当 1；> 1 只 warn 不拒绝读（写才拒绝，见 validateOverride / POST）。
	let version = parsed.version;
	if (version === undefined) version = 1;
	else if (!Number.isInteger(version) || version < 1) {
		logger?.warn?.("usage-ledger: overrides file %s has version %s; treating it as %d", file, JSON.stringify(parsed.version), OVERRIDES_VERSION);
		version = OVERRIDES_VERSION;
	} else if (version > OVERRIDES_VERSION) {
		logger?.warn?.("usage-ledger: overrides file %s has unsupported version %d; reading it best-effort, writing is refused", file, version);
	}

	const rawModels = parsed.models;
	const models = rawModels !== null && typeof rawModels === "object" && !Array.isArray(rawModels) ? { ...rawModels } : {};
	const dropped = [];
	const aliases = normalizeAliasMap(parsed.aliases, (key) => dropped.push(key));
	if (dropped.length > 0) logger?.warn?.("usage-ledger: overrides file %s dropped %d unusable alias entr(ies)", file, dropped.length);
	if (parsed.rates !== undefined) logger?.warn?.("usage-ledger: overrides file %s has a rates section; overrides has no rates, ignoring it", file);

	return { version, models, aliases, exists: true };
}

/**
 * 把「读 overrides 文件时抛出的错误」判成写入侧的三态之一。
 *
 * 抽成纯函数是为了**可测**：真实 ACL 状态（可写不可读）不是每个平台都造得出来，
 * 而这个判据的每一条分支都必须有人守。把它做成错误码 → 判定的纯函数，就能在
 * 任何平台上逐条断言，不依赖能不能 `icacls` / `chmod` 出那个状态。
 *
 * ## 为什么不能只看「读不到就当没内容」
 *
 * 实测（Windows，`icacls <file> /deny <user>:(R)`）：`readFile` 抛 **EPERM**，而
 * `rename` **成功**——`rename` 只替换目录项，**不需要读目标文件**。于是「读不到 →
 * 当作空表 → 写入」会把用户手写的整份 overrides 静默清空（返回 200、无备份）。
 * 这与「损坏 JSON 被当空表」是同一个后果，只是入口不同。
 *
 * @param error - `readFile` 抛出的错误（或任何带 `code` 的对象）。
 * @returns `"absent"` | `"ok"` | `"unreadable"`。
 */
export function classifyOverridesReadError(error) {
	const code = error?.code;
	// 没写过：正常，基于空表写。
	if (code === "ENOENT") return "absent";
	// 目标不是普通文件（目录 / 路径中段不是目录）：写入本身必然失败
	// （实测：对目录 `rename` 抛 EPERM，`readFile` 抛 EISDIR），交给既有路径返回
	// 500「写入失败，文件未改动」。**不要**判成 `unreadable`——那会把「原子写失败」
	// 误报成「文件内容坏了」，把排查方向指错。
	if (code === "EISDIR" || code === "ENOTDIR") return "ok";
	// 其余（EPERM / EACCES / ELOOP / …）：文件在、可能有内容、而我们读不到。
	// `rename` 不需要读目标文件，所以写入会**成功**并覆盖掉那些内容 → 拒绝写。
	return "unreadable";
}

/**
 * 写入前的「这个文件能不能安全覆盖」探测。
 *
 * ## 为什么不复用 `loadOverridesFile` 的返回值
 *
 * 读取侧的口径是「坏了也当空表」——价格读不到不该让面板挂掉（与 `loadPricingFile`
 * 同源）。但那个口径下，`{version:null, models:{}, aliases:{}}` 与「文件真的是空的」
 * 在形状上**完全一样**，于是写入侧无从区分。若照此写入，`applyOverride(空表, op)` +
 * `rename` 会把用户手写的整份 overrides **静默清空**：返回 200、没有备份、条目凭空
 * 消失。用户只看到「写入成功」，然后发现自己几周的手工修正全没了。这是静默丢数据。
 *
 * 所以这里给写入侧一条**独立**的判据，而不是往 `loadOverridesFile` 的返回形状里塞
 * 字段：读与写在「解析失败意味着什么」这件事上要求相反，把两者混在一个返回值里，
 * 迟早有人拿错那一半。独立探测也让「读路径的形状」保持稳定（它已被既有测试钉住）。
 *
 * ## 三态：只有「存在且可能丢内容」才拒绝
 *
 * 判据问的是「**有没有一份我准备丢弃、却没能读出来的内容**」。三种情况必须分开
 * （第二版曾把后两种混为 `"ok"`，留了一个与原始缺陷后果完全相同的洞）：
 *
 * - 读不到且**不存在**（ENOENT）→ `absent`：正常，基于空表写。
 * - 读不到且**写入也会失败**（EISDIR / ENOTDIR，见
 *   {@link classifyOverridesReadError}）→ `ok`：交给既有路径报 500。
 * - 读不到但**写入会成功**（EPERM / EACCES 等）→ `unreadable`：**拒绝写**。
 * - 读得到但解析不了 → `unreadable`：**有内容会被丢掉**，拒绝写。
 *
 * @param file - 绝对路径，或 undefined。
 * @returns `"absent"`（不存在/没配——正常，可基于空表写）、`"ok"`（可安全覆盖，或写入
 *   会自行失败）、`"unreadable"`（**存在可能丢内容的内容却读不出来，或读得出来但解析
 *   不了——拒绝写**）。
 */
export async function probeOverridesFile(file) {
	if (typeof file !== "string" || file === "") return "absent";
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		return classifyOverridesReadError(error);
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
		return "ok";
	} catch {
		return "unreadable";
	}
}

/**
 * 三层合并：内联 config < 主表 < overrides。
 *
 * 后者赢，逐层覆盖。overrides 是用户最新的意图，所以优先级最高；主表可以整份从
 * 仓库替换而不丢手工修正（ADR-0008 §1）。
 *
 * **冲突日志**只记 overrides 覆盖别人（`model-shadow` / `alias-shadow`）：那是
 * 「你写的和表里不一样」的提示。内联被主表覆盖**不记**——那是既有行为，注释里早已
 * 写明「文件里的条目覆盖内联配置」，为它刷日志只会淹没真正的冲突。
 *
 * @param options - `{inline, file, overrides}`；`inline`/`file` 是 `{models, aliases, rates}`，
 *   `overrides` 是 `{models, aliases}`（aliases 可含字符串值，会被规范化）。
 * @returns `{models, aliases, rates, sources, warnings}`；`aliases` 是**字符串值**表
 *   （`aliasOf = aliases[model] ?? model` 要求字符串），`sources[modelId]` 记最终赢的那一层。
 */
export function mergePricing(options = {}) {
	const inline = options.inline ?? {};
	const file = options.file ?? {};
	const overrides = options.overrides ?? {};
	const warnings = [];

	const models = {};
	const sources = {};
	for (const [layer, table] of [
		["inline", inline.models],
		["file", file.models],
		["overrides", overrides.models],
	]) {
		if (table === null || typeof table !== "object" || Array.isArray(table)) continue;
		for (const key of Object.keys(table)) {
			// 只有 overrides 覆盖别人要记日志（见函数头）。
			if (layer === "overrides" && Object.hasOwn(models, key)) warnings.push({ code: "model-shadow", key, layer });
			setKey(models, key, table[key]);
			setKey(sources, key, layer);
		}
	}

	const aliasEntries = {};
	const rawLayers = [
		["inline", inline.aliases],
		["file", file.aliases],
		["overrides", overrides.aliases],
	];
	for (const [layer, table] of rawLayers) {
		const normalized = normalizeAliasMap(table);
		for (const key of Object.keys(normalized)) {
			if (layer === "overrides" && Object.hasOwn(aliasEntries, key)) warnings.push({ code: "alias-shadow", key, layer });
			setKey(aliasEntries, key, normalized[key]);
		}
	}
	if (overrides.rates !== undefined) warnings.push({ code: "rates-ignored" });

	const aliases = {};
	for (const key of Object.keys(aliasEntries)) setKey(aliases, key, aliasEntries[key].model);

	return { models, aliases, rates: { ...(inline.rates ?? {}), ...(file.rates ?? {}) }, sources, warnings };
}

/**
 * 把合并后的价格表摊成候选清单（供面板搜索选择）。
 *
 * 可空性必须**写死**，否则前端会在「字段缺失」与「值为 0」之间出错：
 * `cacheRead`/`cacheWrite` 表里没写 → `null`（不是 0——0 是「真的免费」，缺失是
 * 「不知道」）；`context` 缺失或不是有限数（表里有字面量 `"unknown"`）→ `null`；
 * `vendor`/`modelName` 缺失 → `null`；`input`/`output` 缺失同样 → `null`（价格表
 * 是人工维护的，缺列是真实可能的，硬凑 0 会让面板显示「免费」）。
 *
 * @param models - 合并后的模型表。
 * @param sources - {@link mergePricing} 的 `sources`。
 * @param currency - 显示币种；条目没写 `currency` 时按 `costOf` 的口径等价于它。
 * @param aliases - 合并后的**字符串值**别名表。用来告诉面板「这个候选本身也是一个别名键、
 *   且它的目标不是它自己」——那时插件只做**一跳**，不会跟随到那个目标，确认框必须说出来。
 * @returns 按 `id` 升序的候选数组。
 */
export function buildCandidates(models, sources = {}, currency = "CNY", aliases = {}) {
	const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
	const stringOrNull = (value) => (typeof value === "string" ? value : null);
	return Object.keys(models)
		.sort((a, b) => a.localeCompare(b))
		.map((id) => {
			const entry = models[id] ?? {};
			const target = aliases[id];
			return {
				id,
				input: finiteOrNull(entry.input),
				output: finiteOrNull(entry.output),
				cacheRead: finiteOrNull(entry.cacheRead),
				cacheWrite: finiteOrNull(entry.cacheWrite),
				currency: stringOrNull(entry.currency) ?? currency,
				context: finiteOrNull(entry.context),
				vendor: stringOrNull(entry.vendor),
				modelName: stringOrNull(entry.modelName),
				source: sources[id] ?? "file",
				// 自映射（`A → A`）不算「跟随到别处」，所以也报 null。
				aliasTarget: typeof target === "string" && target !== id ? target : null,
			};
		});
}

/** 归一化只做两步：折叠大小写、剥掉到最后一个 `/` 为止的命名空间前缀。 */
function fold(value) {
	return String(value).toLowerCase();
}

/** 尾部：最后一个 `/` 之后的部分；没有 `/` 时等于原串。 */
function tail(value) {
	const text = String(value);
	return text.slice(text.lastIndexOf("/") + 1);
}

/**
 * 在折叠撞键时确定性地挑一个键。
 *
 * `fold` 是多对一：实测运行时表的别名键里就有 2 组折叠撞键
 * （`deepseek-v4.1-flash` / `DeepSeek-V4.1-Flash`）。若取「遍历到的第一个」，结果
 * 依赖对象键序——同一份数据换个插入顺序就会给出不同的建议，而 `reason` 里的别名名
 * 是要原样展示给用户的。所以规则写死：① 与原始串**逐字符相等**的优先；② 否则取
 * `localeCompare` 最小的。
 *
 * @param candidates - 折叠后相等的键。
 * @param wanted - 用户输入的原始串。
 * @returns 唯一的键。
 */
function pickKey(candidates, wanted) {
	const exact = candidates.find((key) => key === wanted);
	if (exact !== undefined) return exact;
	return [...candidates].sort((a, b) => a.localeCompare(b))[0];
}

/**
 * 推荐规则（ADR-0008 §3）：**只有三条**，每条都能用一句话解释。
 *
 * | 规则 | 触发 | `score` | `reason` |
 * |---|---|---|---|
 * | R1 尾部匹配 | `fold(tail(X))` 等于某个模型键的 `fold` | `0.9` | `去掉命名空间前缀后与 <modelId> 同名` |
 * | R2 大小写折叠 | `fold(X)` 等于某个模型键的 `fold` | `1` | `仅大小写不同（<modelId>）` |
 * | R3 已知别名反向 | `fold(tail(X))` 或 `fold(X)` 等于某个**别名键**的 `fold` | `0.8` | `已有别名 <aliasKey> → <target>` |
 *
 * **明确不做**（每条都有实测反例）：去日期后缀、去尾部数字、编辑距离/相似度打分。
 * `claude-opus-5-5`（4/20）与 `claude-opus-5`（5/25）输入输出**都贵 25%**，一旦被
 * 「剥尾部数字」并成一行，官方价折算会静默高估 25%；`qwen3.8-max-0902` 与
 * `qwen3.8-max` 在运行时表里**并存**。所以这里**没有**任何后缀/数字相关的规则，
 * 也不该有——`test/suggest.test.js` 用反例断言钉住这一点。
 *
 * 另外两条防御：**自指建议必须过滤**（建议指向待定价模型自己时什么也修不了），
 * 以及每个建议的目标都必须是合并后 models 的**自有键**（否则面板点一下就写出一个
 * 永远算不出钱的死别名）。
 *
 * @param modelId - 待定价的模型 id。
 * @param options - `{models, aliases}`；`aliases` 是「别名键 → 目标」的映射。
 * @returns 最多 {@link MAX_SUGGESTIONS} 条建议，按 `score` 降序、`model` 升序。
 */
export function suggestModels(modelId, options = {}) {
	const models = options.models ?? {};
	const rawAliases = options.aliases ?? {};
	const modelKeys = Object.keys(models);
	const aliasKeys = Object.keys(rawAliases);
	const byId = new Map();
	/** 折叠后的模型键 → 真实键们。 */
	const foldedModels = new Map();
	for (const key of modelKeys) {
		const folded = fold(key);
		const bucket = foldedModels.get(folded);
		if (bucket === undefined) foldedModels.set(folded, [key]);
		else bucket.push(key);
	}
	/** 折叠后的别名键 → 真实键们。 */
	const foldedAliases = new Map();
	for (const key of aliasKeys) {
		const folded = fold(key);
		const bucket = foldedAliases.get(folded);
		if (bucket === undefined) foldedAliases.set(folded, [key]);
		else bucket.push(key);
	}

	/**
	 * 记下一条建议；同一目标被多条规则命中时只留最高分那条。
	 *
	 * @param target - 建议的模型键。
	 * @param score - 规则分数。
	 * @param reason - 给用户看的理由。
	 */
	const push = (target, score, reason) => {
		if (!Object.hasOwn(models, target)) return; // 死别名：绝不建议
		if (target === modelId) return; // 自指：认领成自己什么也修不了
		const previous = byId.get(target);
		if (previous === undefined || score > previous.score) byId.set(target, { model: target, score, reason });
	};

	// R2：整体大小写折叠（`X !== modelId` 表示真的只差大小写）。
	const foldedSelf = fold(modelId);
	if (foldedModels.has(foldedSelf)) {
		const target = pickKey(foldedModels.get(foldedSelf), modelId);
		if (target !== modelId) push(target, 1, `仅大小写不同（${target}）`);
	}

	// R1：去掉命名空间前缀后的尾部匹配。
	const foldedTail = fold(tail(modelId));
	if (foldedModels.has(foldedTail)) {
		const target = pickKey(foldedModels.get(foldedTail), tail(modelId));
		push(target, 0.9, `去掉命名空间前缀后与 ${target} 同名`);
	}

	// R3：这个 id（或它的尾部）已经被某条别名指向过。
	for (const probe of [tail(modelId), modelId]) {
		const bucket = foldedAliases.get(fold(probe));
		if (bucket === undefined) continue;
		const aliasKey = pickKey(bucket, probe);
		const entry = rawAliases[aliasKey];
		const target = typeof entry === "string" ? entry : entry?.model;
		if (typeof target !== "string" || target === "") continue;
		push(target, 0.8, `已有别名 ${aliasKey} → ${target}`);
	}

	return [...byId.values()]
		.sort((a, b) => (b.score === a.score ? a.model.localeCompare(b.model) : b.score - a.score))
		.slice(0, MAX_SUGGESTIONS);
}

/**
 * 组装 `GET ${UNPRICED_PATH}` 的响应体（ADR-0008 §2）。
 *
 * 与 `buildPayload` 同口径：同一个 `range`、同一组 `pricing/aliases/rates/currency`
 * 下，`items[].id` 的集合**逐字相同**于 `buildPayload().cost.unpriced`。这条不变式是
 * 本接口的全部价值——面板上的「未定价：N 个模型」与这里列出的行必须是同一批。
 *
 * `cause` 只有两支，且**穷尽**了 `costOf` 返回 `undefined` 的全部路径：没有价格行
 * （`no-price`）与缺汇率（`no-rate`）。面板因此能说清「补价格能修好」与「得先去主表
 * 补 rates」——后者靠「认领成已有模型」是修不好的。
 *
 * @param records - 全部计费记录。
 * @param options - `{range, pricing, aliases, rates, currency, sources, overrides, now}`；
 *   `pricing` 是**合并后**的模型表（内联 < 主表 < overrides），`overrides` 是
 *   `{path, exists, version, enabled}`（写在哪、写没写过、能不能写）。
 * @returns 可直接序列化的载荷。
 */
export function buildUnpricedPayload(records, options = {}) {
	const {
		range = { from: null, to: null, label: "累计" },
		pricing = {},
		aliases = {},
		rates = {},
		currency = "CNY",
		sources = {},
		overrides = {},
		now = new Date(),
	} = options;
	const scoped = aggregate(records, range);
	const aliasOf = (model) => aliases[model] ?? model;

	const items = [];
	for (const row of scoped.models) {
		const canonical = aliasOf(row.model);
		// 与 buildPayload 的 officialIdOf 同一条判据：自有键，不是 `in`。
		const officialId = Object.hasOwn(pricing, canonical) ? canonical : undefined;
		const price = officialId === undefined ? undefined : pricing[officialId];
		const cost = costOf(row, price, { currency, rates });
		if (cost !== undefined) continue;
		items.push({
			id: `${row.provider}/${row.model}`,
			provider: row.provider,
			model: row.model,
			tokens: row.tokens,
			requests: row.requests,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheReadTokens: row.cacheReadTokens,
			cacheWriteTokens: row.cacheWriteTokens,
			reasoningTokens: row.reasoningTokens,
			cacheHitRate: row.cacheHitRate,
			cause: officialId === undefined ? "no-price" : "no-rate",
			suggestions: suggestModels(row.model, { models: pricing, aliases }),
		});
	}
	// 按 **tokens 降序**（规格 §8.1 冻结的口径）。
	//
	// ADR-0008 §5 的字面表述是「按调用次数降序」，但规格 §10 第 1 条把这条列为待裁决点
	// 并**冻结为 tokens**，理由是不能顺手改掉一个已被断言钉住的既有行为：面板上既有的
	// `UnpricedNotice` 就是按 tokens 降序（`src/client.js` 的 `ranked`），两处口径必须
	// 一致——同一个面板里「未定价」出现在两块地方而排序不同，用户会以为是两批数据。
	// 同 tokens 时按 requests 降序、再按 id 升序兜底，让排序**确定**——否则它会随
	// `aggregate` 的 `Map` 插入序漂移，两次请求给出不同的行序。
	items.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.id.localeCompare(b.id));

	return {
		ok: true,
		generatedAt: now.getTime(),
		currency,
		range,
		items,
		candidates: buildCandidates(pricing, sources, currency, aliases),
		overrides: {
			path: typeof overrides.path === "string" ? overrides.path : "",
			exists: overrides.exists === true,
			version: typeof overrides.version === "number" ? overrides.version : null,
			enabled: overrides.enabled !== false,
		},
	};
}

/**
 * 校验一条 overrides 写操作（ADR-0008 §4；前端不可信）。
 *
 * 纯函数，返回**稳定的英文码**而不是给人看的文案——面板负责把码翻成中文。
 * 错误码清单见规格 §7.3 的 V5–V17。
 *
 * @param body - 已 `JSON.parse` 过的请求体。
 * @param context - `{models, rates, currency, version}`；`models` 是**合并后**的模型表。
 * @returns `{ok: true, op, entry}` 或 `{ok: false, detail}`。
 */
export function validateOverride(body, context = {}) {
	const { models = {}, rates = {}, currency = "CNY", version = OVERRIDES_VERSION } = context;
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, detail: "invalid-body" };

	const allowed = new Set(["op", "model", "input", "output", "cacheRead", "cacheWrite", "currency", "note", "alias", "reason", "target", "id"]);
	for (const key of Object.keys(body)) if (!allowed.has(key)) return { ok: false, detail: "unknown-field" };

	const op = body.op;
	if (op !== "setModel" && op !== "setAlias" && op !== "remove") return { ok: false, detail: "unknown-op" };

	// 每个 op 的键集合必须落在自己的必填+可选里：`setModel` 不许出现 `alias`，反之亦然。
	// 这条挡的是「把两个 op 的字段混在一起」——那种请求体看起来能跑，实际有一半字段被静默忽略。
	const perOp = {
		setModel: ["model", "input", "output", "cacheRead", "cacheWrite", "currency", "note"],
		setAlias: ["alias", "model", "reason"],
		remove: ["target", "id"],
	}[op];
	for (const key of Object.keys(body)) if (key !== "op" && !perOp.includes(key)) return { ok: false, detail: "unknown-field" };

	if (version > OVERRIDES_VERSION) return { ok: false, detail: "unsupported-version" };

	/** id 合法性：非空、有上限、无控制字符、不是原型保留名。 */
	const idProblem = (value) =>
		typeof value !== "string" || value === "" || value.length > MAX_ID_LENGTH || CONTROL_CHARS.test(value) || PROTOTYPE_KEYS.includes(value);
	/** 价格合法性：有限数且 ≥ 0（**不做字符串强转**，`"1.5"` 拒绝）。 */
	const priceProblem = (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0;

	if (op === "setModel") {
		if (idProblem(body.model)) return { ok: false, detail: "invalid-id" };
		if (priceProblem(body.input) || priceProblem(body.output)) return { ok: false, detail: "invalid-price" };
		if (body.cacheRead !== undefined && priceProblem(body.cacheRead)) return { ok: false, detail: "invalid-price" };
		if (body.cacheWrite !== undefined && priceProblem(body.cacheWrite)) return { ok: false, detail: "invalid-price" };
		if (body.currency !== undefined && (typeof body.currency !== "string" || body.currency === "")) return { ok: false, detail: "invalid-currency" };
		if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > MAX_TEXT_LENGTH)) return { ok: false, detail: "invalid-note" };
		// 币种可用性：等于显示币种时**根本不查 rates**（与 costOf 的 `price.currency ?? currency` 同义）；
		// 否则必须在 rates 里有**有限数**汇率——查不到汇率的价格写进去也只会让这一行继续显示「—」。
		const target = body.currency ?? currency;
		if (target !== currency && !(Object.hasOwn(rates, target) && typeof rates[target] === "number" && Number.isFinite(rates[target]))) {
			return { ok: false, detail: "unknown-currency" };
		}
		// 缺省的 cacheRead/cacheWrite/currency **不写这个键**：不伪造 0，也不伪造币种。
		// 这与主表的既有惯例一致（运行时表 147 个模型里 11 个没写 cacheRead）。
		const entry = { input: body.input, output: body.output, source: "manual" };
		if (body.cacheRead !== undefined) entry.cacheRead = body.cacheRead;
		if (body.cacheWrite !== undefined) entry.cacheWrite = body.cacheWrite;
		if (body.currency !== undefined) entry.currency = body.currency;
		if (body.note !== undefined) entry.note = body.note;
		return { ok: true, op, id: body.model, entry };
	}

	if (op === "setAlias") {
		if (idProblem(body.alias)) return { ok: false, detail: "invalid-id" };
		if (typeof body.model !== "string" || body.model === "") return { ok: false, detail: "invalid-id" };
		if (body.reason !== undefined && body.reason !== "" && (typeof body.reason !== "string" || body.reason.length > MAX_TEXT_LENGTH)) {
			return { ok: false, detail: "invalid-reason" };
		}
		// 硬规则只有一条：目标必须是**合并后 models 的自有键**。
		//
		// 刻意**不**加 ADR 字面的「目标不能是另一个别名」：解析是精确匹配 + 一跳，写完
		// `A → T` 后插件只看 `pricing[T]` 这个自有键，只要 T 是模型行，一跳就能定价。
		// 而「T 同时是别名键」在现网极其常见（运行时表 27 条别名里 23 条如此，
		// `deepseek-flash` 这类既是模型行又是自映射别名键），按字面实现会让最常用的
		// 目标全部不可写——功能基本不可用。见 ADR-0008 的勘误。
		if (!Object.hasOwn(models, body.model)) return { ok: false, detail: "unknown-model" };
		const entry = { model: body.model, addedAt: new Date().toISOString(), origin: "panel" };
		if (typeof body.reason === "string" && body.reason !== "") entry.reason = body.reason;
		return { ok: true, op, id: body.alias, entry };
	}

	if (body.target !== "model" && body.target !== "alias") return { ok: false, detail: "unknown-target" };
	if (idProblem(body.id)) return { ok: false, detail: "invalid-id" };
	return { ok: true, op, id: body.id, entry: { target: body.target } };
}

/**
 * 把一条写操作应用到当前 overrides 上，返回**新的**内容。
 *
 * 纯函数（不碰磁盘），这样「写什么」与「怎么写」可以分开断言。`remove` 只删 overrides
 * 里的键，**绝不**触碰主表——主表是仓库同步来的目录，改它下次同步就被覆盖
 * （ADR-0008 非目标）。`id` 不存在时也返回成功（幂等）：删一个本来就没有的键，
 * 结果与用户期望一致。
 *
 * @param current - `{models, aliases}`。
 * @param op - {@link validateOverride} 的成功结果。
 * @returns `{version, models, aliases}`。
 */
export function applyOverride(current = {}, op) {
	const models = { ...(current.models ?? {}) };
	const aliases = { ...(current.aliases ?? {}) };
	if (op.op === "setModel") setKey(models, op.id, op.entry);
	else if (op.op === "setAlias") setKey(aliases, op.id, op.entry);
	else if (op.entry.target === "model") delete models[op.id];
	else delete aliases[op.id];
	return { version: OVERRIDES_VERSION, models, aliases };
}

/**
 * 原子写：同目录临时文件 + `rename`。
 *
 * 直接 `writeFile` 到目标会在写入中途留下半截文件——面板下一次读到的就是损坏的 JSON，
 * 而它按空表降级，于是「刚认领的模型又变回未定价」。`rename` 在同盘上是原子的，
 * 所以读到的要么是旧内容、要么是新内容，没有中间态。
 *
 * 任何一步失败都要 `unlink` 临时文件（忽略 ENOENT），目标文件保持原样。
 *
 * @param file - 目标绝对路径。
 * @param value - 待序列化内容。
 * @param seq - 递增序号，只用来让临时文件名唯一。
 */
async function writeAtomic(file, value, seq) {
	// 键顺序固定 `version, models, aliases`：这是给人读的文件，稳定的顺序让 diff 可读。
	const text = `${JSON.stringify({ version: OVERRIDES_VERSION, models: value.models, aliases: value.aliases }, null, 2)}\n`;
	const temp = join(dirname(file), `${basename(file)}.${process.pid}.${seq}.tmp`);
	try {
		await writeFile(temp, text, "utf8");
		await rename(temp, file);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

/**
 * 挂载插件。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置 `{sessionsRoot?, pricing?, pricingFile?, overridesFile?, currency?}`。
 */
export function apply(ctx, config = {}) {
	const sessionsRoot = resolveSessionsRoot(config);
	const inlinePricing = config.pricing ?? {};
	const pricingFile = typeof config.pricingFile === "string" && config.pricingFile !== "" ? config.pricingFile : resolvePricingFile(config);
	const overridesFile = typeof config.overridesFile === "string" && config.overridesFile !== "" ? config.overridesFile : resolveOverridesFile(config);
	const currency = config.currency ?? "CNY";
	const logger = ctx.logger?.("usage-ledger") ?? ctx.logger;
	// 扫描器持有缓存，所以整个插件生命周期只建一次：每个请求、每次定时刷新
	// 都复用同一个实例，否则缓存等于没有。
	const scanner = createScanner(diskSource(sessionsRoot));
	const startedAt = Date.now();
	/**
	 * 当前生效的价格表、别名映射与「这一行来自哪一层」。
	 *
	 * 每 30 秒最多重读一次文件，这样改完价格不必重启，也不会每个请求都去碰磁盘。
	 * 两个文件**共用同一个节流戳**：它们在同一趟读盘里被读出来，分两个戳只会让
	 * 「主表已重读、overrides 还没」这种半新半旧的状态有机会被观察到。
	 */
	let pricing = inlinePricing;
	let aliases = config.aliases ?? {};
	let rates = config.rates ?? {};
	let sources = {};
	let overrides = { version: null, models: {}, aliases: {}, exists: false };
	let pricingStamp = 0;
	/**
	 * 正在飞的那一趟读盘。
	 *
	 * 节流窗口内**不能直接返回**：启动时那趟读盘是 fire-and-forget 的，而它已经把
	 * `pricingStamp` 置成了当下——若这时来个请求，`now - pricingStamp < 30_000` 成立，
	 * 直接返回就会让**第一个请求读到空价格表**（金额一栏全「—」、未定价清单列满全部模型），
	 * 而几百毫秒后它又自己好了。这种「开局几帧是错的」是最难排查的一类缺陷：
	 * 本地看起来正常，只在慢盘或冷启动时偶发。
	 */
	let refreshInFlight = null;

	/** 真正读一次盘并合并。 */
	const loadPricingNow = async () => {
		const [fromFile, fromOverrides] = await Promise.all([loadPricingFile(pricingFile, logger), loadOverridesFile(overridesFile, logger)]);
		const merged = mergePricing({
			inline: { models: inlinePricing, aliases: config.aliases ?? {}, rates: config.rates ?? {} },
			file: fromFile,
			overrides: fromOverrides,
		});
		pricing = merged.models;
		aliases = merged.aliases;
		rates = merged.rates;
		sources = merged.sources;
		overrides = fromOverrides;
		for (const warning of merged.warnings) {
			if (warning.code === "model-shadow") logger?.warn?.("usage-ledger: overrides file %s overrides model %s", overridesFile, warning.key);
			else if (warning.code === "alias-shadow") logger?.warn?.("usage-ledger: overrides file %s overrides alias %s", overridesFile, warning.key);
		}
	};

	const refreshPricing = async () => {
		// 早退条件是「两个文件都没配」，不是「主表没配」。
		//
		// 写成只看 `pricingFile` 的话，`{pricingFile: false, overridesFile: <tmp>}` 这个
		// 组合下连 overrides 都不会被读——用户在主表被关掉时写的全部手工修正都会静默
		// 失效，而面板照常显示「未定价」。
		if (pricingFile === undefined && overridesFile === undefined) return;
		if (Date.now() - pricingStamp < 30_000) {
			// 窗口内：等正在飞的那一趟（见 refreshInFlight 的注释）。
			if (refreshInFlight !== null) await refreshInFlight;
			return;
		}
		pricingStamp = Date.now();
		refreshInFlight = loadPricingNow();
		try {
			await refreshInFlight;
		} finally {
			refreshInFlight = null;
		}
	};
	// 启动时立刻读一次，别等第一个请求。
	if (pricingFile !== undefined || overridesFile !== undefined) {
		if (pricingFile !== undefined) logger?.info?.("usage-ledger: pricing file %s", pricingFile);
		if (overridesFile !== undefined) logger?.info?.("usage-ledger: overrides file %s", overridesFile);
		refreshPricing().catch(() => undefined);
	}

	// 写入串行化：同一路径的写用一个 promise 链排队。
	//
	// 并发 POST 若各自「读当前 → 改 → 写回」，后写的那次会覆盖先写的那次（丢更新），
	// 而两次都返回 200。链上排队保证每个 op 读到的都是前一个 op 的结果。
	let writeChain = Promise.resolve();
	let writeSeq = 0;

	// 后台预热：首个面板请求不该为 58MB 日志买单。放在 apply 之后，让装配先完成。
	const warm = () => {
		scanner
			.scan()
			.then(({ stats }) => logger?.info?.("usage-ledger: warmed %d files (%d records)", stats.files, stats.records))
			.catch((error) => logger?.warn?.("usage-ledger: warm scan failed: %s", error?.message ?? error));
	};
	if (typeof setImmediate === "function") setImmediate(warm);

	const onRequest = async (req, res) => {
		const refused = screenRequest(req);
		if (refused !== undefined) return sendJson(res, refused.status, refused.body);
		try {
			await refreshPricing();
			const url = new URL(req.url ?? "/", "http://localhost");
			const { records, stats } = await scanner.scan();
			const range = resolveRange(url.searchParams.get("range") ?? "all", url.searchParams.get("from"), url.searchParams.get("to"));
			sendJson(res, 200, buildPayload(records, { range, pricing, aliases, rates, currency, stats: { ...stats, uptimeMs: Date.now() - startedAt } }));
		} catch (error) {
			logger?.warn?.("usage-ledger: request failed: %s", error?.message ?? error);
			sendJson(res, 500, { ok: false, error: "internal" });
		}
	};

	/**
	 * `GET ${UNPRICED_PATH}`：未定价清单 + 候选模型 + 带 reason 的推荐。
	 *
	 * 与主接口**同口径**的 `range`/`from`/`to`（直接复用 `resolveRange`，零新增语义）：
	 * 面板上的「未定价」区块必须与当前标签页的数字自洽，而现有提示吃的就是按范围摊平
	 * 后的行。
	 *
	 * @param req - Node 请求。
	 * @param res - Node 响应。
	 */
	const onUnpriced = async (req, res) => {
		const refused = screenRequest(req);
		if (refused !== undefined) return sendJson(res, refused.status, refused.body);
		try {
			await refreshPricing();
			const url = new URL(req.url ?? "/", "http://localhost");
			const { records } = await scanner.scan();
			const range = resolveRange(url.searchParams.get("range") ?? "all", url.searchParams.get("from"), url.searchParams.get("to"));
			sendJson(
				res,
				200,
				buildUnpricedPayload(records, {
					range,
					pricing,
					aliases,
					rates,
					currency,
					sources,
					overrides: { ...overrides, path: overridesFile ?? "", enabled: overridesFile !== undefined },
				}),
			);
		} catch (error) {
			logger?.warn?.("usage-ledger: unpriced request failed: %s", error?.message ?? error);
			sendJson(res, 500, { ok: false, error: "internal" });
		}
	};

	/**
	 * 读请求体：只认异步可迭代对象，累计超过 {@link MAX_BODY_BYTES} 立刻放弃。
	 *
	 * 上限不是「优化」：没有它，一个几十 MB 的 body 会把整个进程的内存吃掉，而这个
	 * 接口只允许本机访问——本机上的任何进程都能打它。
	 *
	 * @param req - Node 请求（真实的 `IncomingMessage` 与测试用的假异步可迭代对象都行）。
	 * @returns `{text}`，或 `{tooLarge: true}`。
	 */
	const readBody = async (req) => {
		let size = 0;
		const chunks = [];
		for await (const chunk of req) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += bytes.length;
			if (size > MAX_BODY_BYTES) return { tooLarge: true };
			chunks.push(bytes);
		}
		return { text: Buffer.concat(chunks).toString("utf8") };
	};

	/**
	 * `POST ${OVERRIDES_PATH}`：写 overrides（`setModel` / `setAlias` / `remove`）。
	 *
	 * 校验顺序与错误码见规格 §7.3 的 V1–V18。写盘走 {@link writeAtomic}，并在成功后
	 * 把 `pricingStamp` 归零强制下一趟读盘——不这样做的话，用户刚认领完就会看到同一行
	 * **仍然未定价**，正是本仓库最忌讳的静默失败。
	 *
	 * ⚠️ ADR-0008 §5 早期写的是「30 秒内生效」，那**不是**本实现的行为：`pricingStamp`
	 * 归零后，面板 POST 成功紧跟的那次 `reload()` 就会读到新值，即**立即生效**。
	 * 30 秒只是「不写盘时的重读间隔上限」，与写后可见性无关，不要据此以为存在延迟。
	 * （ADR 该处已勘误，裁决记录见规格第 10 节第 2 条。）
	 *
	 * @param req - Node 请求。
	 * @param res - Node 响应。
	 */
	const onOverrides = async (req, res) => {
		const refused = screenRequest(req);
		if (refused !== undefined) return sendJson(res, refused.status, refused.body);
		if (overridesFile === undefined) return sendJson(res, 403, { ok: false, error: "write-disabled" });
		const bad = (detail) => sendJson(res, 400, { ok: false, error: "bad-request", detail });
		try {
			// 闸门：`content-type` 必须以 `application/json` 开头（在 readBody **之前**）。
			//
			// 这一条不是格式洁癖，是本接口唯一挡得住「本机浏览器里的任意网页」的判据。
			// 宿主 webserver 的 `handle()` 直接 `await route.handler(req, res)`，**没有
			// 鉴权层**；而 `screenRequest` 只查 peer 地址——来自本机网页的请求，peer
			// 同样是 127.0.0.1，闸门照常放行。一个跨站页面只要用 `fetch` 打这个接口，
			// 就能把用户手写的 overrides 改掉。
			//
			// 但 `application/json` 属于 CORS 的**非简单** content-type：浏览器对这类
			// 跨站请求会先发 `OPTIONS` 预检，而本插件**不返回任何 CORS 头**，预检必然
			// 失败，真正的 POST 根本发不出去。于是「要求 JSON content-type」本身就构成
			// 防护，且不需要凭据、不需要第三方依赖（`text/plain` 是简单类型，不会被预检
			// 拦住——所以必须**拒绝**它，不能宽容接受）。
			const mediaType = String(req.headers?.["content-type"] ?? "").trim().toLowerCase();
			if (!mediaType.startsWith("application/json")) return bad("unsupported-media-type");

			const body = await readBody(req);
			if (body.tooLarge === true) return bad("body-too-large");
			let parsed;
			try {
				parsed = JSON.parse(body.text ?? "");
			} catch {
				return bad("invalid-body");
			}
			// 写之前先读一次当前文件：校验要拿**合并后**的模型表判别名目标，写入要基于
			// 当前内容做增量（不是整份替换）。
			await refreshPricing();
			// 文件存在但读不出来 → **拒绝写**，绝不拿空表覆盖。
			//
			// 读取侧把损坏文件当空表是**对**的（价格读不到不该让面板挂掉），但写入侧
			// 沿用同一口径就是灾难：`applyOverride(空表, op)` + `rename` 会把用户手写的
			// 整份 overrides **静默清空**——返回 200、没有备份、条目凭空消失。用户只会
			// 看到「写入成功」，然后发现自己几周的手工修正全没了。所以这里显式拒绝，
			// 让用户先去修文件（错误码是稳定的 `overrides-unreadable`）。
			if ((await probeOverridesFile(overridesFile)) === "unreadable") {
				return sendJson(res, 409, { ok: false, error: "bad-request", detail: "overrides-unreadable" });
			}
			const current = await loadOverridesFile(overridesFile, logger);
			const result = validateOverride(parsed, { models: pricing, rates, currency, version: current.version ?? OVERRIDES_VERSION });
			if (!result.ok) return bad(result.detail);

			// 串行化：把这一次写排在上一次之后，读到的必然是前一个 op 的结果。
			const run = writeChain.then(async () => {
				// 排队期间文件可能被写坏（另一个进程 / 用户手改）：**链内**再探一次。
				// 这一道必须在这里，而不是只在上面——上面那次探测与真正写入之间隔着
				// 整个队列，中间的任何一次外部修改都会绕过它。
				if ((await probeOverridesFile(overridesFile)) === "unreadable") {
					throw Object.assign(new Error("overrides file unreadable"), { code: "OVERRIDES_UNREADABLE" });
				}
				const fresh = await loadOverridesFile(overridesFile, logger);
				const next = applyOverride(fresh, result);
				writeSeq += 1;
				await writeAtomic(overridesFile, next, writeSeq);
			});
			// 链上无论成败都要继续接得住下一个 op：失败不能把整条链变成 rejected。
			writeChain = run.catch(() => undefined);
			try {
				await run;
			} catch (error) {
				if (error?.code === "OVERRIDES_UNREADABLE") return sendJson(res, 409, { ok: false, error: "bad-request", detail: "overrides-unreadable" });
				logger?.warn?.("usage-ledger: overrides write failed: %s", error?.message ?? error);
				return sendJson(res, 500, { ok: false, error: "internal" });
			}
			// 写后可见性：强制下一趟读盘，面板紧跟的那次 GET 就能看到新内容。
			pricingStamp = 0;
			return sendJson(res, 200, { ok: true, op: result.op, path: overridesFile, version: OVERRIDES_VERSION });
		} catch (error) {
			logger?.warn?.("usage-ledger: overrides request failed: %s", error?.message ?? error);
			return sendJson(res, 500, { ok: false, error: "internal" });
		}
	};

	/** 新路由的方法闸门：先闸门、后 screenRequest（与现有路由同序）。 */
	const gate = (methods, handler) => (req, res) => {
		if (!methods.includes(req.method)) return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
		return handler(req, res);
	};

	const attach = (server) => {
		// 现有这条路由与它内部的 405 闸门**一字不改**：它只覆盖 BASE_PATH 这一个
		// pathname，且它的 405 只带 `content-type`（不带 `cache-control`）。把它
		// 「统一」成新助手的形状也是行为变化——`test/routes.test.js` 的回归用例
		// 逐字段钉住了响应形状，包括这个头的有无。
		ctx.effect(
			() =>
				server.register({
					kind: "exact",
					path: BASE_PATH,
					handler: (req, res) => {
						if (req.method !== "GET" && req.method !== "HEAD") {
							res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
							return;
						}
						return onRequest(req, res);
					},
				}),
			"usage-ledger: usage route",
		);
		// 两条新路由各自独立注册：`register()` 的表键是 `(kind, path)`，重复注册抛错，
		// 所以「复用同一个 handler 注册两个路径」在宿主端做不到——新路径必须有自己的
		// 方法闸门与回环闸门（ADR-0008 §2）。
		ctx.effect(
			() =>
				server.register({
					kind: "exact",
					path: UNPRICED_PATH,
					handler: gate(["GET", "HEAD"], onUnpriced),
				}),
			"usage-ledger: unpriced route",
		);
		ctx.effect(
			() =>
				server.register({
					kind: "exact",
					path: OVERRIDES_PATH,
					handler: gate(["POST"], onOverrides),
				}),
			"usage-ledger: overrides route",
		);
		logger?.info?.("usage-ledger: serving %s", BASE_PATH);
	};

	if (typeof ctx.inject === "function") {
		for (const serviceName of WEB_SERVER_NAMES) {
			ctx.inject([serviceName], (scoped) => {
				const server = scoped?.[serviceName];
				if (server === undefined || typeof server.register !== "function") return;
				attach(server);
			});
		}
	}

	// 文本命令：不开浏览器也能看一眼。
	if (typeof ctx.inject === "function") {
		ctx.inject(["commands"], (scoped) => {
			const commands = scoped?.commands;
			if (commands === undefined || typeof commands.register !== "function") return;
			ctx.effect(
				() =>
					commands.register({
						name: "usage",
						description: "本地会话日志的 token 用量（分渠道、分模型）",
						input: { hint: "[today|week|month|all]" },
						handler: async (invocation) => {
							try {
								const range = resolveRange((invocation?.rawInput ?? "").trim() || "month");
								const { records, stats } = await scanner.scan();
								const payload = buildPayload(records, { range, pricing, aliases, rates, currency, stats });
								const lines = [
									`用量 ${range.label}｜tokens ${payload.totals.tokens.toLocaleString()}｜请求 ${payload.totals.requests}｜缓存命中率 ${payload.totals.cacheHitRate}%`,
									"",
									...payload.providers.map((row) => `${row.provider.padEnd(18)} ${row.tokens.toLocaleString().padStart(16)}  请求 ${row.requests}`),
								];
								return { kind: "success", text: lines.join("\n") };
							} catch (error) {
								return { kind: "error", text: `usage: ${error?.message ?? error}` };
							}
						},
					}),
				"usage-ledger: usage command",
			);
		});
	}

	logger?.info?.("usage-ledger: scanning %s", sessionsRoot);
}
