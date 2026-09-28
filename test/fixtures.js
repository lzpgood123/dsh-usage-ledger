/**
 * 会话日志 fixture 构造器。
 *
 * 全部在测试运行时用 `zstdCompressSync` 造，不入库任何二进制。这些字节是按
 * `assistant/message` 事件的记录形状**构造**出来的，不是真实会话文件的拷贝
 * ——真实文件含真实提示词与 cwd，既大又不该进仓库。
 *
 * @module usage-ledger/test/fixtures
 */

import { zstdCompressSync } from "node:zlib";

/**
 * 造一条计费记录事件。
 *
 * @param options - `{time, provider, model, input, output, cacheRead, cacheWrite, reasoning, totalTokens, usage}`。
 * @returns 事件对象。
 */
export function billedEvent(options = {}) {
	const {
		time = 1790516405452,
		provider = "relay-a",
		model = "deepseek-v4.1-flash",
		input = 100,
		output = 20,
		cacheRead = 5,
		cacheWrite = 3,
		reasoning = 7,
		totalTokens,
		usage,
	} = options;
	const event = {
		type: "assistant/message",
		data: {
			message: { source: { provider, model } },
			usage: usage ?? { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: reasoning },
		},
	};
	if (time !== null) event.time = time;
	if (totalTokens !== undefined) event.data.usage.totalTokens = totalTokens;
	return event;
}

/**
 * 造一个会话头事件。
 *
 * @param options - `{id, cwd, createdAt}`。
 * @returns 事件对象。
 */
export function sessionEvent(options = {}) {
	return { type: "session", id: options.id ?? "session-1", cwd: options.cwd ?? "/work", createdAt: options.createdAt ?? 1790000000000 };
}

/**
 * 把事件序列压成会话日志容器。
 *
 * 每个事件一帧，与 DSH 追加写入的形状一致；也可以显式传入多帧来构造多帧容器。
 *
 * @param events - 事件对象数组，或 `Buffer` 数组（按帧原样拼接）。
 * @returns Zstandard 字节。
 */
export function sessionBytes(events) {
	const frames = events.map((event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)));
	return Buffer.concat(frames);
}

/**
 * 造一段可读的 JSONL 字节（不压缩），用于 `.jsonl` 明文路径。
 *
 * @param events - 事件对象数组。
 * @returns UTF-8 字节。
 */
export function plainBytes(events) {
	return Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}
