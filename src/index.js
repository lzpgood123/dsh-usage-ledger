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
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { aggregate, scanSessions } from "./scan.js";

/** Cordis 插件名。 */
export const name = "usage-ledger";

/** 面板读取的接口前缀。 */
export const BASE_PATH = "/api/usage-ledger";

/**
 * 承载 Web 服务的服务名。
 *
 * 两个名字都是真的：不同组合装的是其中哪一个，只问另一个就正好是「面板 404 却
 * 没有任何报错」的成因，所以两个都等。
 */
const WEB_SERVER_NAMES = ["webServer", "httpServer"];

/** 热力图覆盖的天数：一整年整周，避免首尾出现半截列。 */
const ACTIVITY_DAYS = 371;

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
 * 把本地日期折算为 `YYYY-MM-DD`。
 *
 * @param date - 日期对象。
 * @returns 本地日期键。
 */
function dayKey(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
	const today = dayKey(now);
	switch (kind) {
		case "today":
			return { from: today, to: today, label: "今日" };
		case "week": {
			const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
			return { from: dayKey(start), to: today, label: "近 7 天" };
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
 * 让它随范围伸缩会失去意义。
 *
 * @param records - 全部计费记录。
 * @param options - `{range, pricing, currency, stats}`。
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
	} = options;
	const scoped = aggregate(records, range);

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
	const officialIdOf = (model) => {
		const canonical = aliasOf(model);
		return canonical in pricing ? canonical : undefined;
	};

	const unpriced = new Set();
	let totalCost = 0;
	let priced = false;

	const models = scoped.models.map((row) => {
		const officialId = officialIdOf(row.model);
		const price = officialId === undefined ? undefined : pricing[officialId];
		const cost = costOf(row, price, { currency, rates });
		if (cost === undefined) unpriced.add(`${row.provider}/${row.model}`);
		else {
			totalCost += cost;
			priced = true;
		}
		return {
			...row,
			officialModel: officialId ?? null,
			cost: cost === undefined ? null : Math.round(cost * 10000) / 10000,
		};
	});

	const providers = scoped.providers.map((row) => {
		// 渠道成本按它名下各模型相加，逐模型判定是否定价。
		let sum = 0;
		let any = false;
		for (const model of scoped.models) {
			if (model.provider !== row.provider) continue;
			const officialId = officialIdOf(model.model);
			const cost = officialId === undefined ? undefined : costOf(model, pricing[officialId], { currency, rates });
			if (cost !== undefined) {
				sum += cost;
				any = true;
			}
		}
		return { ...row, cost: any ? Math.round(sum * 10000) / 10000 : null };
	});

	const since = new Date();
	since.setDate(since.getDate() - (ACTIVITY_DAYS - 1));
	const activity = aggregate(records, { from: dayKey(since), to: null }).days.map((row) => ({
		day: row.day,
		tokens: row.tokens,
		requests: row.requests,
	}));

	const byDay = new Map(activity.map((row) => [row.day, row]));

	return {
		ok: true,
		generatedAt: Date.now(),
		timeZone: {
			name: Intl.DateTimeFormat().resolvedOptions().timeZone,
			offset: -new Date().getTimezoneOffset() / 60,
		},
		range,
		totals: scoped.totals,
		providers,
		models,
		days: scoped.days,
		activity,
		activityDays: ACTIVITY_DAYS,
		byDay: Object.fromEntries(byDay),
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
 * 挂载插件。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置 `{sessionsRoot?, pricing?, pricingFile?, currency?}`。
 */
export function apply(ctx, config = {}) {
	const sessionsRoot = resolveSessionsRoot(config);
	const inlinePricing = config.pricing ?? {};
	const pricingFile = typeof config.pricingFile === "string" && config.pricingFile !== "" ? config.pricingFile : resolvePricingFile(config);
	const currency = config.currency ?? "CNY";
	const logger = ctx.logger?.("usage-ledger") ?? ctx.logger;
	const cache = new Map();
	const startedAt = Date.now();
	let lastStats = {};
	/**
	 * 当前生效的价格表与别名映射。
	 *
	 * 每 30 秒最多重读一次文件，这样改完价格不必重启，也不会每个请求都去碰磁盘。
	 */
	let pricing = inlinePricing;
	let aliases = config.aliases ?? {};
	let rates = config.rates ?? {};
	let pricingStamp = 0;
	const refreshPricing = async () => {
		const now = Date.now();
		if (pricingFile === undefined || now - pricingStamp < 30_000) return;
		pricingStamp = now;
		const fromFile = await loadPricingFile(pricingFile, logger);
		// 文件里的条目覆盖内联配置；内联配置作为兜底。
		pricing = { ...inlinePricing, ...fromFile.models };
		aliases = { ...(config.aliases ?? {}), ...fromFile.aliases };
		rates = { ...(config.rates ?? {}), ...fromFile.rates };
	};
	// 启动时立刻读一次，别等第一个请求。
	if (pricingFile !== undefined) {
		logger?.info?.("usage-ledger: pricing file %s", pricingFile);
		refreshPricing().catch(() => undefined);
	}

	/**
	 * 扫描一次。
	 *
	 * @returns 统计信息。
	 */
	const scan = async () => {
		const { records, stats } = await scanSessions(sessionsRoot, cache);
		lastStats = stats;
		return { records, stats };
	};

	// 后台预热：首个面板请求不该为 58MB 日志买单。放在 apply 之后，让装配先完成。
	const warm = () => {
		scan()
			.then(({ stats }) => logger?.info?.("usage-ledger: warmed %d files (%d records)", stats.files, stats.records))
			.catch((error) => logger?.warn?.("usage-ledger: warm scan failed: %s", error?.message ?? error));
	};
	if (typeof setImmediate === "function") setImmediate(warm);

	const onRequest = async (req, res) => {
		const refused = screenRequest(req);
		const send = (status, value) => {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(value));
		};
		if (refused !== undefined) return send(refused.status, refused.body);
		try {
			await refreshPricing();
			const url = new URL(req.url ?? "/", "http://localhost");
			const { records, stats } = await scan();
			const range = resolveRange(url.searchParams.get("range") ?? "all", url.searchParams.get("from"), url.searchParams.get("to"));
			send(200, buildPayload(records, { range, pricing, aliases, rates, currency, stats: { ...stats, uptimeMs: Date.now() - startedAt } }));
		} catch (error) {
			logger?.warn?.("usage-ledger: request failed: %s", error?.message ?? error);
			send(500, { ok: false, error: "internal" });
		}
	};

	const attach = (server) => {
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
								const { records, stats } = await scan();
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
