/**
 * 扫描策略的测试。
 *
 * 全部通过 {@link Source} seam 进入：内存 adapter 回答「有哪几个文件、每个的
 * 字节与 mtime 是什么」，所以缓存失效、淘汰、失败计数这些策略第一次可以被
 * 断言。这些测试不碰真实文件系统。
 *
 * @module usage-ledger/test/scan.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createScanner, diskSource, recordOf, scanZstdFrames } from "../src/scan.js";
import { memorySource } from "./memory-source.js";
import { billedEvent, plainBytes, sessionBytes, sessionEvent } from "./fixtures.js";

const PATH = "/sessions/proj/session-1/session.v4.jsonl.zstd";

/** 造一个只含一条计费记录的会话文件。 */
const oneSession = (options) => sessionBytes([sessionEvent(), billedEvent(options)]);

test("首次扫描解析每个文件，第二次全部命中缓存", async () => {
	const source = memorySource({ [PATH]: { bytes: oneSession(), mtimeMs: 1000 } });
	const scanner = createScanner(source);

	const cold = await scanner.scan();
	assert.deepEqual(cold.stats, { files: 1, scanned: 1, cached: 0, failed: 0, records: 1 });

	const warm = await scanner.scan();
	assert.deepEqual(warm.stats, { files: 1, scanned: 0, cached: 1, failed: 0, records: 1 });
	assert.equal(warm.records.length, 1, "命中缓存仍要交回记录");
});

test("mtime 变化使缓存失效并重新解析", async () => {
	const source = memorySource({ [PATH]: { bytes: oneSession(), mtimeMs: 1000 } });
	const scanner = createScanner(source);
	await scanner.scan();

	source.touch(PATH, 2000);
	const second = await scanner.scan();
	assert.equal(second.stats.scanned, 1);
	assert.equal(second.stats.cached, 0);
});

test("文件内容变化后返回新内容，不返回缓存里的旧记录", async () => {
	const source = memorySource({ [PATH]: { bytes: oneSession({ provider: "relay-a" }), mtimeMs: 1000 } });
	const scanner = createScanner(source);
	await scanner.scan();

	source.write(PATH, oneSession({ provider: "relay-b" }), 2000);
	const second = await scanner.scan();
	assert.equal(second.records.length, 1);
	assert.equal(second.records[0].provider, "relay-b");
});

test("同一 mtime 与 size 的改写会被缓存漏掉（已知盲区，明确记录）", async () => {
	// mtime:size 是缓存键，所以「内容变了但这两个值都没变」无法察觉。这在
	// 追加写的会话日志上不会发生（追加必然改 size），但盲区是真实存在的，
	// 所以在这里钉住它。
	//
	// 注意：这条测试**故意**让两次载荷字节数相同（见下面的前提断言），因此它
	// 在 size 这一维上没有区分力——缓存键就算退化成只看 mtime，它照样通过。
	// 真正钉住「缓存键必须含 size」的是后面那条「size 变大」的测试，两者不可
	// 互相替代：这里测的是盲区本身，那里测的是缓存键的构造。
	//
	// 用未压缩的 .jsonl 造数据，才能让「字节数相同」成为构造保证，而不是
	// 依赖 zstd 对不同内容恰好压出同样长度。
	const path = "/sessions/proj/session-1/session.jsonl";
	const first = plainBytes([billedEvent({ input: 11 })]);
	const second = plainBytes([billedEvent({ input: 22 })]);
	assert.equal(first.length, second.length, "前提：两次内容的字节数相同");
	assert.notDeepEqual(first, second, "前提：两次内容不同");

	const source = memorySource({ [path]: { bytes: first, mtimeMs: 1000 } });
	const scanner = createScanner(source);
	await scanner.scan();

	source.write(path, second, 1000);
	const result = await scanner.scan();
	assert.equal(result.stats.cached, 1, "缓存命中");
	assert.equal(result.records[0].inputTokens, 11, "仍然是旧内容——这是已知盲区");
});

test("同一 mtime 但 size 变大时必须重新解析，不得返回陈旧字节", async () => {
	// 上一条盲区测试故意让两次载荷等长，所以它区分不出缓存键里有没有 size。
	// 这条反过来：mtime 钉死不动，只让 size 变大——只有缓存键真的包含 size
	// 才会失效重解析。若 stamp 退化成只看 mtime，这里会命中陈旧缓存并交回
	// inputTokens=11，把「文件明明变了」谎报成没变。
	const withInput = (input) => sessionBytes([sessionEvent(), billedEvent({ input })]);
	const small = withInput(11);
	const big = sessionBytes([sessionEvent(), billedEvent({ input: 222222 }), billedEvent({ input: 333333 })]);
	assert.notEqual(small.length, big.length, "前提：两次内容的字节数不同");

	const source = memorySource({ [PATH]: { bytes: small, mtimeMs: 1000 } });
	const scanner = createScanner(source);
	await scanner.scan();

	source.write(PATH, big, 1000); // mtime 不变，size 变大
	const result = await scanner.scan();
	assert.equal(result.stats.scanned, 1, "size 变了必须重新解析");
	assert.equal(result.stats.cached, 0, "不得走缓存命中路径");
	assert.equal(result.records[0].inputTokens, 222222, "不得返回陈旧字节");
});

test("文件从磁盘消失后，缓存条目被淘汰", async () => {
	const source = memorySource({ [PATH]: { bytes: oneSession(), mtimeMs: 1000 } });
	const scanner = createScanner(source);
	await scanner.scan();

	source.remove(PATH);
	const result = await scanner.scan();
	assert.equal(result.stats.files, 0);
	assert.deepEqual(result.records, []);

	// 缓存必须跟着缩小：重新写回同名文件时应重新解析，而不是命中早已删除的条目。
	source.write(PATH, oneSession(), 3000);
	const third = await scanner.scan();
	assert.equal(third.stats.scanned, 1, "淘汰后重新出现要重新解析");
});

test("文件消失后以相同 mtime 与 size 恢复时，必须重新解析而非命中已删除的条目", async () => {
	// 上一条淘汰测试恢复文件时用了新的 mtime（3000），所以缓存光靠 mtime 就
	// 失效了，即使完全不淘汰也能通过——它对淘汰策略是空转的。这条把 mtime
	// 和 size 都钉死不动，唯一能让缓存失效的机制就是「文件消失时被淘汰」。
	// 若淘汰循环被删掉，旧条目会一直留在 cache 里，恢复后直接命中并交回删除
	// 前的 inputTokens=111111。
	const path = "/sessions/proj/session-1/session.jsonl";
	const first = plainBytes([billedEvent({ input: 111111 })]);
	const second = plainBytes([billedEvent({ input: 999999 })]);
	assert.equal(first.length, second.length, "前提：两次内容的字节数相同");
	assert.notDeepEqual(first, second, "前提：两次内容不同");

	const source = memorySource({ [path]: { bytes: first, mtimeMs: 1000 } });
	const scanner = createScanner(source);
	await scanner.scan();

	source.remove(path); // 消失 → 缓存条目必须被淘汰
	const gone = await scanner.scan();
	assert.equal(gone.stats.files, 0);
	assert.deepEqual(gone.records, []);

	source.write(path, second, 1000); // 以相同 mtime + 相同 size 恢复
	const result = await scanner.scan();
	assert.equal(result.stats.scanned, 1, "恢复的文件必须重新解析");
	assert.equal(result.stats.cached, 0, "不得命中删除前的缓存条目");
	assert.equal(result.records[0].inputTokens, 999999, "不得返回删除前的条目");
});

test("stat 失败的文件计入 failed，不影响其余文件", async () => {
	const ok = "/sessions/proj/session-1/session.v4.jsonl.zstd";
	const gone = "/sessions/proj/session-2/session.v4.jsonl.zstd";
	const source = memorySource({ [ok]: { bytes: oneSession(), mtimeMs: 1000 } });
	source.addGhost(gone);

	const result = await createScanner(source).scan();
	assert.equal(result.stats.failed, 1);
	assert.equal(result.stats.records, 1, "好文件照常统计");
});

test("压缩文件里一帧都没有时计入 failed，而不是静默的 0 条记录", async () => {
	// 这是 C1 修掉的真实缺口：被别的东西覆盖、或格式变了的文件，以前会走
	// 「0 帧 → 空文本 → 0 条记录」并且不抛错，于是算成「读到了」。
	const source = memorySource({ [PATH]: { bytes: Buffer.from("这不是 zstandard 容器"), mtimeMs: 1000 } });
	const result = await createScanner(source).scan();

	assert.equal(result.stats.failed, 1);
	assert.equal(result.stats.scanned, 0);
	assert.equal(result.stats.records, 0);
});

test("0 字节的压缩文件不算失败（会话刚建立时就是空的）", async () => {
	const source = memorySource({ [PATH]: { bytes: Buffer.alloc(0), mtimeMs: 1000 } });
	const result = await createScanner(source).scan();

	assert.equal(result.stats.failed, 0);
	assert.equal(result.stats.scanned, 1);
	assert.equal(result.stats.records, 0);
});

test("未压缩的 .jsonl 明文照常解析，且不参与帧数判定", async () => {
	const path = "/sessions/proj/session-1/session.jsonl";
	const source = memorySource({ [path]: { bytes: plainBytes([sessionEvent(), billedEvent({ provider: "official" })]), mtimeMs: 1000 } });
	const result = await createScanner(source).scan();

	assert.equal(result.stats.failed, 0);
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0].provider, "official");
});

test("损坏的中间帧被跳过，其余帧照常统计", async () => {
	const good = sessionBytes([billedEvent({ provider: "relay-a" })]);
	const junk = Buffer.from("xxxx");
	const alsoGood = sessionBytes([billedEvent({ provider: "relay-b" })]);
	const source = memorySource({ [PATH]: { bytes: Buffer.concat([good, junk, alsoGood]), mtimeMs: 1000 } });

	const result = await createScanner(source).scan();
	// 首帧之后是垃圾字节，帧扫描在此停止；关键是「不抛错」且首帧的数据还在。
	assert.equal(result.stats.failed, 0);
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0].provider, "relay-a");
});

test("正在追加写入的断尾帧被丢弃，不抛错", async () => {
	const whole = sessionBytes([sessionEvent(), billedEvent()]);
	const torn = Buffer.concat([whole, sessionBytes([billedEvent({ provider: "half" })]).subarray(0, 7)]);
	const source = memorySource({ [PATH]: { bytes: torn, mtimeMs: 1000 } });

	const result = await createScanner(source).scan();
	assert.equal(result.stats.failed, 0, "断尾不算失败：文件正在被写");
	assert.equal(result.records.length, 1);
});

test("缓存命中路径返回的记录与冷路径逐条一致", async () => {
	const source = memorySource({
		"/a/session.v4.jsonl.zstd": { bytes: oneSession({ provider: "relay-a", input: 11 }), mtimeMs: 1000 },
		"/b/session.v4.jsonl.zstd": { bytes: oneSession({ provider: "relay-b", input: 22 }), mtimeMs: 1000 },
	});
	const scanner = createScanner(source);

	const cold = await scanner.scan();
	const warm = await scanner.scan();
	assert.deepEqual(warm.records, cold.records, "缓存必须改变速度，不改变结果");
});

test("recordOf 的总量口径：缺 totalTokens 时按四项相加补齐", async () => {
	const record = recordOf({ message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 } });
	assert.equal(record.tokens, 100);
	assert.equal(record.requests, 1);

	const explicit = recordOf({ message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 999 } });
	assert.equal(explicit.tokens, 999, "显式 totalTokens 优先");
});

test("recordOf 缺用量时拒绝记录；缺路由时落到 (unknown) 哨兵值", () => {
	// 缺用量 = 不计费，没有记录可言。
	assert.equal(recordOf({ message: { source: { provider: "p", model: "m" } } }), undefined, "缺 usage → 没有记录");
	assert.equal(recordOf({ message: { source: { provider: "p", model: "m" } }, usage: { outputTokens: 1 } }), undefined, "缺输入 → 没有记录");

	// 缺路由**不**拒绝，而是记成 (unknown) 渠道。这是当前实现的行为，
	// 也是架构评审 C5 指出的问题：缺失被伪造成一个看起来合法的值，且
	// stats 里没有计数器能暴露它。这里如实钉住现状，等 C5 决定去留。
	const unrouted = recordOf({ usage: { inputTokens: 1, outputTokens: 1 } });
	assert.equal(unrouted.provider, "(unknown)");
	assert.equal(unrouted.model, "(unknown)");
});

test("diskSource 的 compressed 只认 .zstd 后缀", () => {
	const source = diskSource("/nonexistent");
	assert.equal(source.compressed("/x/session.v4.jsonl.zstd"), true);
	assert.equal(source.compressed("/x/session.jsonl"), false);
});

test("真实多帧容器：单次解压会丢帧，逐帧扫描不会", async () => {
	const bytes = sessionBytes([billedEvent({ provider: "frame-1" }), billedEvent({ provider: "frame-2" })]);
	assert.equal(scanZstdFrames(bytes).frames.length, 2, "两帧");

	const source = memorySource({ [PATH]: { bytes, mtimeMs: 1000 } });
	const result = await createScanner(source).scan();
	assert.equal(result.records.length, 2, "两帧的数据都要在——ADR-0003 的实测结论");
});
