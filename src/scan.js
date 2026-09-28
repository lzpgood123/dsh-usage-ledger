/**
 * 会话日志扫描与聚合。
 *
 * 数据源是 DSH 自己的持久化会话日志：
 *
 *   $DSH_HOME/sessions/<cwd 编码>/session-<uuid>/session.v4.jsonl.zstd
 *
 * 每条 `assistant/message` 事件同时携带**计费用量**与**实际服务该请求的路由**：
 *
 *   {"type":"assistant/message","time":1790516405452,
 *    "data":{"message":{"source":{"provider":"example-relay","model":"deepseek-v4.1-flash"}},
 *            "usage":{"inputTokens":1896,"outputTokens":321,"cacheReadTokens":8960}}}
 *
 * 因此「分渠道、分模型、按时间」全部可以从本地记录直接算出，不需要任何网络
 * 请求、凭据或中转站归属推断。
 *
 * ## 为什么逐帧解压
 *
 * 日志容器是**多帧拼接**的 Zstandard（DSH 为了能追加写入而不重压全文）。Node 的
 * `zstdDecompressSync` 只解第一帧，直接丢整个文件给它只会得到一个头行——这一点
 * 是实测确认的，不是推测。所以这里先扫描帧边界，再逐帧解压。
 *
 * ## 为什么不用 assistant/attempt
 *
 * 重试（`llm/retry-started`）会为同一个 (turn, step) 产生 `assistant/attempt`
 * 与最终的 `assistant/message`。实测 `assistant/attempt` **从不携带 usage**
 * （166/166），失败尝试不计费。所以只统计带 usage 的 `assistant/message`，
 * 每个会话内 (turn, step) 唯一，不会重复计费。
 *
 * @module usage-ledger/scan
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** Zstandard 帧魔数（小端 `0xFD2FB528`）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 会话日志的规范文件名与跨代去重规则，见 {@link generationOf} 与
 * {@link listSessionFiles}。要点：
 *
 * - `session.jsonl.zstd` 是 version 0（早期格式），`session.v<N>.jsonl.zstd` 是
 *   version ≥1（当前为 v4）。两者事件结构完全一致，一套解析逻辑通吃。
 * - `session.v0.jsonl` 不是规范名（官方 `parseSessionFormatLogFilename` 判为
 *   `undefined`），所以版本号从 1 开始匹配。
 * - 早期只认 `session.vN` 会漏掉 140 个 version-0 会话，总量少掉一半。
 * - 同一会话可能同时留下两代文件，必须按会话目录取最高版本，否则重复计数。
 */

/**
 * 扫描 buffer 里的完整 Zstandard 帧边界，不解压其内容。
 *
 * 尾部不完整的帧（会话正在写入时很常见）通过 `tornStart` 返回并丢弃，这样
 * 读取一个正在被追加的文件不会抛错。
 *
 * @param buffer - 会话文件当前的全部字节。
 * @returns 完整帧的 `{start,end}` 列表，以及可选的不完整尾帧起点。
 */
export function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start };
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) return { frames, tornStart: start };
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < headerBytes) return { frames, tornStart: start };
		offset += headerBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) return { frames, tornStart: start };
			offset += blockType === 1 ? 1 : blockSize;
			if (offset > buffer.length) return { frames, tornStart: start };
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/**
 * 把一个会话文件解压成 JSONL 文本。
 *
 * 同时接受未压缩的 `.jsonl`（旧版或明文部署），此时原样返回。
 *
 * @param buffer - 文件字节。
 * @param compressed - 是否按 Zstandard 多帧容器处理。
 * @returns JSONL 文本；损坏的尾帧被跳过而不是让整次读取失败。
 */
export function decodeSessionBytes(buffer, compressed = true) {
	if (!compressed) return buffer.toString("utf8");
	const { frames } = scanZstdFrames(buffer);
	const parts = [];
	for (const { start, end } of frames) {
		try {
			parts.push(zstdDecompressSync(buffer.subarray(start, end)));
		} catch {
			// 单帧损坏不该让整个会话消失：跳过它，其余帧照常统计。
		}
	}
	return Buffer.concat(parts).toString("utf8");
}

/**
 * 把一个 token 计数收敛为安全非负整数。
 *
 * @param value - 原始字段值。
 * @returns 合法的计数，否则 undefined。
 */
function count(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 从一条 `assistant/message` 事件提取用量与路由。
 *
 * `totalTokens` 在部分记录里缺失，此时按 DSH 自己的口径补齐：
 * `total = input + output + cacheRead + cacheWrite`。这个口径已用真实数据校验过
 * （见模块测试）。
 *
 * @param data - 事件的 `data` 字段。
 * @returns 记录，或 undefined（缺少路由/用量时）。
 */
export function recordOf(data) {
	const usage = data?.usage;
	if (usage === undefined || usage === null) return undefined;
	const source = data?.message?.source;
	const provider = typeof source?.provider === "string" && source.provider !== "" ? source.provider : "(unknown)";
	const model = typeof source?.model === "string" && source.model !== "" ? source.model : "(unknown)";

	const input = count(usage.inputTokens);
	const output = count(usage.outputTokens);
	if (input === undefined || output === undefined) return undefined;
	const cacheRead = count(usage.cacheReadTokens) ?? 0;
	const cacheWrite = count(usage.cacheWriteTokens) ?? 0;
	const reasoning = count(usage.reasoningTokens) ?? 0;
	const total = count(usage.totalTokens) ?? input + output + cacheRead + cacheWrite;

	return {
		provider,
		model,
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		reasoningTokens: reasoning,
		tokens: total,
		requests: 1,
	};
}

/**
 * 把本地时间戳折算成 `YYYY-MM-DD`（用户所在时区，不是 UTC）。
 *
 * @param milliseconds - epoch 毫秒。
 * @returns 本地日期键。
 */
export function localDayKey(milliseconds) {
	const date = new Date(milliseconds);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 解析一个会话文件的全部计费记录。
 *
 * @param text - 解压后的 JSONL 文本。
 * @returns 逐条记录 `{day, ...recordOf()}` 与文件头信息。
 */
export function parseSessionText(text) {
	const records = [];
	let header;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "session") {
			header = { id: event.id, cwd: event.cwd, createdAt: event.createdAt };
			continue;
		}
		if (event.type !== "assistant/message") continue;
		const record = recordOf(event.data);
		if (record === undefined) continue;
		records.push({ day: localDayKey(event.time ?? event.data?.time ?? Date.now()), ...record });
	}
	return { records, header };
}

/**
 * 从规范文件名解析格式版本；非规范名返回 undefined。
 *
 * @param filename - 文件 basename。
 * @returns 版本号（`session.jsonl.zstd` → 0），或 undefined。
 */
export function generationOf(filename) {
	const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/.exec(filename);
	if (match === null) return undefined;
	return match[1] === undefined ? 0 : Number(match[1]);
}

/**
 * 递归收集会话文件，并按会话 id 消解跨代重复。
 *
 * DSH 的会话日志按「格式代」命名：version 0 是 `session.jsonl.zstd`，version
 * ≥1 是 `session.vN.jsonl.zstd`。同一会话在升级时会**同时留下两代文件**（实测
 * 本机有 1 例：同 id、同 createdAt、43 条记录逐条重复），两代全读会把它算两遍。
 *
 * 因此这里按<会话 id>归组，只保留**最高版本**的那一代——新代是旧代的超集。
 * 这也顺带修正了另一个方向的偏差：早期只认 `session.vN` 会漏掉 140 个 version-0
 * 会话。
 *
 * 版本号取自文件名（官方规范），不读文件头——列表阶段就要决定取舍，为此解压
 * 每个文件是不必要的开销。
 *
 * @param sessionsRoot - `$DSH_HOME/sessions`。
 * @returns 绝对路径列表，每个会话至多一个。
 */
export async function listSessionFiles(sessionsRoot) {
	let groups;
	try {
		groups = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	/** 会话目录 → 该目录下按版本编号的最优文件。 */
	const best = new Map();
	for (const group of groups) {
		if (!group.isDirectory()) continue;
		const groupDir = join(sessionsRoot, group.name);
		let sessions;
		try {
			sessions = await readdir(groupDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (!session.isDirectory()) continue;
			const sessionDir = join(groupDir, session.name);
			let entries;
			try {
				entries = await readdir(sessionDir);
			} catch {
				continue;
			}
			for (const entry of entries) {
				const version = generationOf(entry);
				if (version === undefined) continue;
				const previous = best.get(sessionDir);
				if (previous === undefined || version > previous.version) {
					best.set(sessionDir, { version, path: join(sessionDir, entry) });
				}
			}
		}
	}
	return [...best.values()].map((entry) => entry.path);
}

/**
 * 增量扫描全部会话日志。
 *
 * 每个文件按 `mtimeMs + size` 缓存解析结果：只有真正变动的文件会被重新解压，
 * 所以面板刷新和定时重扫都是廉价的。会话日志是追加写的，文件一旦变动就整份
 * 重解析——单文件成本很低，而增量合并的复杂度不值得。
 *
 * @param sessionsRoot - `$DSH_HOME/sessions`。
 * @param cache - 可复用的缓存 Map（跨调用保持）。
 * @returns `{records, stats}`，records 为全部计费记录。
 */
export async function scanSessions(sessionsRoot, cache = new Map()) {
	const files = await listSessionFiles(sessionsRoot);
	const records = [];
	const seen = new Set();
	let scanned = 0;
	let skipped = 0;
	let failed = 0;

	for (const file of files) {
		let info;
		try {
			info = await stat(file);
		} catch {
			failed += 1;
			continue;
		}
		const stamp = `${info.mtimeMs}:${info.size}`;
		seen.add(file);
		const hit = cache.get(file);
		if (hit !== undefined && hit.stamp === stamp) {
			records.push(...hit.records);
			skipped += 1;
			continue;
		}
		try {
			const buffer = await readFile(file);
			const { records: parsed } = parseSessionText(decodeSessionBytes(buffer, file.endsWith(".zstd")));
			cache.set(file, { stamp, records: parsed });
			records.push(...parsed);
			scanned += 1;
		} catch {
			failed += 1;
		}
		// 解压是同步 CPU 工作，单帧最大到 MB 级。每扫几个文件主动让出一次事件
		// 循环，宿主在这两秒里仍能响应请求，而不是被一次冷扫描整体卡住。
		if (scanned % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
	}

	for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);

	return {
		records,
		stats: { files: files.length, scanned, cached: skipped, failed, records: records.length },
	};
}

/** 一个空桶。 */
function emptyBucket() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		tokens: 0,
		requests: 0,
	};
}

/**
 * 累加一条记录到桶里。
 *
 * @param bucket - 目标桶。
 * @param record - 计费记录。
 * @returns 同一个桶。
 */
function addInto(bucket, record) {
	bucket.inputTokens += record.inputTokens;
	bucket.outputTokens += record.outputTokens;
	bucket.cacheReadTokens += record.cacheReadTokens;
	bucket.cacheWriteTokens += record.cacheWriteTokens;
	bucket.reasoningTokens += record.reasoningTokens;
	bucket.tokens += record.tokens;
	bucket.requests += record.requests;
	return bucket;
}

/**
 * 给一个桶补上缓存命中率。
 *
 * 命中率 = 缓存读 / (未缓存输入 + 缓存读)。分母只含提示词侧，输出 token 不参与
 * ——把输出算进去会让命中率随回答长度漂移。
 *
 * @param bucket - 已汇总的桶。
 * @returns 带 `cacheHitRate` 的桶。
 */
function withRate(bucket) {
	const prompt = bucket.inputTokens + bucket.cacheReadTokens;
	return { ...bucket, cacheHitRate: prompt === 0 ? 0 : Math.round((bucket.cacheReadTokens / prompt) * 1000) / 10 };
}

/**
 * 按给定时间范围聚合记录。
 *
 * @param records - 全部计费记录。
 * @param range - `{from, to}`，`YYYY-MM-DD` 闭区间；`null` 表示不设边界。
 * @returns 汇总结果：总计、按天、按渠道、按模型。
 */
export function aggregate(records, range = {}) {
	const { from = null, to = null } = range;
	const inRange = records.filter((record) => (from === null || record.day >= from) && (to === null || record.day <= to));

	const totals = emptyBucket();
	const days = new Map();
	const providers = new Map();
	const models = new Map();

	for (const record of inRange) {
		addInto(totals, record);

		let day = days.get(record.day);
		if (day === undefined) days.set(record.day, (day = emptyBucket()));
		addInto(day, record);

		let provider = providers.get(record.provider);
		if (provider === undefined) providers.set(record.provider, (provider = emptyBucket()));
		addInto(provider, record);

		const modelKey = `${record.provider}\0${record.model}`;
		let model = models.get(modelKey);
		if (model === undefined) models.set(modelKey, (model = { provider: record.provider, model: record.model, ...emptyBucket() }));
		addInto(model, record);
	}

	const dayRows = [...days.entries()]
		.map(([day, bucket]) => ({ day, ...withRate(bucket) }))
		.sort((a, b) => a.day.localeCompare(b.day));

	return {
		totals: withRate(totals),
		days: dayRows,
		providers: [...providers.entries()]
			.map(([provider, bucket]) => ({ provider, ...withRate(bucket) }))
			.sort((a, b) => b.tokens - a.tokens),
		models: [...models.values()]
			.map((bucket) => {
				const { provider, model } = bucket;
				const rest = { ...bucket };
				delete rest.provider;
				delete rest.model;
				return { provider, model, ...withRate(rest) };
			})
			.sort((a, b) => b.tokens - a.tokens),
		matched: inRange.length,
	};
}
