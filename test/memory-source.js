/**
 * 内存 source adapter：`createScanner` 的测试替身。
 *
 * 放在 `test/` 而不是 `src/`，因为 `package.json` 的 `files` 只发布 `src/`，
 * 而这个 adapter 只服务于测试。
 *
 * 它实现 `src/scan.js` 里 {@link Source} 的四个成员。`list()` 直接返回现成
 * 的路径列表——文件名规范与跨代消解属于磁盘 adapter，不在扫描策略的测试面内。
 *
 * @module usage-ledger/test/memory-source
 */

/**
 * 构造一个内存 adapter。
 *
 * @param entries - 初始 `{path: {bytes, mtimeMs}}`。
 * @returns {@link Source} 加上几个便于编排的写方法。
 */
export function memorySource(entries = {}) {
	/** @type {Map<string, {bytes: Buffer, mtimeMs: number}>} */
	const store = new Map();
	for (const [path, value] of Object.entries(entries)) store.set(path, normalize(value));

	/** 存在于 `list()` 但读不到的路径，用来模拟扫描中途文件消失。 */
	const ghosts = new Set();

	return {
		store,
		ghosts,

		/**
		 * 写入或覆盖一个文件。
		 *
		 * @param path - 路径。
		 * @param bytes - 字节。
		 * @param mtimeMs - 修改时间，默认递增，便于制造「文件变了」。
		 * @returns 写入后的 mtime。
		 */
		write(path, bytes, mtimeMs = Date.now()) {
			store.set(path, normalize({ bytes, mtimeMs }));
			ghosts.delete(path);
			return mtimeMs;
		},

		/**
		 * 删除一个文件。
		 *
		 * @param path - 路径。
		 */
		remove(path) {
			store.delete(path);
			ghosts.delete(path);
		},

		/**
		 * 让一个路径出现在 `list()` 里但没有字节，模拟 `stat` 失败。
		 *
		 * @param path - 路径。
		 */
		addGhost(path) {
			ghosts.add(path);
		},

		/**
		 * 只改 mtime，不改内容。
		 *
		 * @param path - 路径。
		 * @param mtimeMs - 新的修改时间。
		 */
		touch(path, mtimeMs) {
			store.get(path).mtimeMs = mtimeMs;
		},

		list: async () => [...new Set([...store.keys(), ...ghosts])].sort(),
		stat: async (path) => {
			const entry = store.get(path);
			if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return { mtimeMs: entry.mtimeMs, size: entry.bytes.length };
		},
		read: async (path) => {
			const entry = store.get(path);
			if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return entry.bytes;
		},
		compressed: (path) => path.endsWith(".zstd"),
	};
}

/**
 * 把 `Buffer` 或字符串统一成 `{bytes, mtimeMs}`。
 *
 * @param value - `{bytes, mtimeMs}` 或裸字节。
 * @returns 规范化条目。
 */
function normalize(value) {
	const mtimeMs = value.mtimeMs ?? 1000;
	const bytes = Buffer.isBuffer(value.bytes) ? value.bytes : Buffer.from(value.bytes ?? value);
	return { bytes, mtimeMs };
}
