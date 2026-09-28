/**
 * 会话文件发现与跨代去重的测试。
 *
 * `list()` 是 `createScanner` 的 seam，所以磁盘 adapter 里的文件名规范与跨代
 * 消解**不在**扫描策略的测试面内。但 `scan.js` 头注释记着这条规则修掉过两个
 * 真实回归（早期只认 `session.vN` 漏掉 140 个会话；两代全读导致重复计数），
 * 所以它必须有自己的测试，否则就退回到无保护状态。
 *
 * 这里用真实临时目录：测的就是文件系统上的命名事实，内存 adapter 会把这件
 * 事本身测没了。
 *
 * @module usage-ledger/test/list-sessions.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationOf, listSessionFiles } from "../src/scan.js";

/**
 * 建一个临时 sessions 根目录，用后删除。
 *
 * @param build - 在根目录上建结构的回调。
 * @returns 根目录路径。
 */
async function withSessionsRoot(build) {
	const root = await mkdtemp(join(tmpdir(), "usage-ledger-"));
	try {
		await build(root);
		return root;
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

/**
 * 在 `<root>/<group>/<session>/` 下写一个文件。
 *
 * @param root - sessions 根目录。
 * @param group - cwd 编码目录名。
 * @param session - 会话目录名。
 * @param filename - 文件名。
 */
async function writeSession(root, group, session, filename) {
	const dir = join(root, group, session);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, filename), "x");
}

test("generationOf 只认规范名，version 0 是 session.jsonl.zstd", () => {
	assert.equal(generationOf("session.jsonl.zstd"), 0);
	assert.equal(generationOf("session.v4.jsonl.zstd"), 4);
	assert.equal(generationOf("session.v1.jsonl"), 1);
	assert.equal(generationOf("session.v0.jsonl"), undefined, "官方把 v0 判为非规范名");
	assert.equal(generationOf("session.jsonl"), 0, "明文 .jsonl 也是规范名");
	assert.equal(generationOf("notes.jsonl.zstd"), undefined);
	assert.equal(generationOf("session.v4.jsonl.zstd.tmp"), undefined);
});

test("同一会话的两代文件只取最高版本，不重复计数", async () => {
	const root = await withSessionsRoot(async (root) => {
		await writeSession(root, "group-a", "session-1", "session.jsonl.zstd");
		await writeSession(root, "group-a", "session-1", "session.v4.jsonl.zstd");
	});
	try {
		const files = await listSessionFiles(root);
		assert.equal(files.length, 1, "两代只留一个");
		assert.ok(files[0].endsWith("session.v4.jsonl.zstd"), `应取最高版本，实得 ${files[0]}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("version 0 会话不会被漏掉（曾经漏掉 140 个）", async () => {
	const root = await withSessionsRoot(async (root) => {
		await writeSession(root, "group-a", "session-old", "session.jsonl.zstd");
		await writeSession(root, "group-a", "session-new", "session.v4.jsonl.zstd");
	});
	try {
		const files = await listSessionFiles(root);
		assert.equal(files.length, 2, "两个会话都要被发现");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("不同会话目录各自独立取版本，互不干扰", async () => {
	const root = await withSessionsRoot(async (root) => {
		await writeSession(root, "group-a", "session-1", "session.v3.jsonl.zstd");
		await writeSession(root, "group-a", "session-1", "session.v9.jsonl.zstd");
		await writeSession(root, "group-b", "session-2", "session.v1.jsonl.zstd");
	});
	try {
		const files = await listSessionFiles(root);
		assert.equal(files.length, 2);
		assert.ok(files.some((file) => file.endsWith("session.v9.jsonl.zstd")));
		assert.ok(files.some((file) => file.endsWith("session.v1.jsonl.zstd")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("非会话文件被忽略", async () => {
	const root = await withSessionsRoot(async (root) => {
		await writeSession(root, "group-a", "session-1", "session.v4.jsonl.zstd");
		await writeSession(root, "group-a", "session-1", "README.md");
		await writeSession(root, "group-a", "session-1", "session.v4.jsonl.zstd.tmp");
	});
	try {
		const files = await listSessionFiles(root);
		assert.equal(files.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("根目录不存在时返回空列表而不是抛错", async () => {
	const files = await listSessionFiles(join(tmpdir(), "usage-ledger-does-not-exist-xyz"));
	assert.deepEqual(files, []);
});

test("diskSource 在真实临时目录上按 seam 契约工作", async () => {
	const root = await withSessionsRoot(async (root) => {
		await writeSession(root, "group-a", "session-1", "session.v4.jsonl.zstd");
	});
	try {
		const { diskSource } = await import("../src/scan.js");
		const source = diskSource(root);
		const files = await source.list();
		assert.equal(files.length, 1);

		const info = await source.stat(files[0]);
		assert.equal(typeof info.mtimeMs, "number");
		assert.equal(typeof info.size, "number");

		const bytes = await source.read(files[0]);
		assert.ok(Buffer.isBuffer(bytes));
		assert.equal(source.compressed(files[0]), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
