/**
 * 回环地址闸门 `screenRequest` 的直接测试。
 *
 * 这个函数是 `apply()` 里 `onRequest` 的**唯一安全边界**：它放行的接口会吐出本机
 * 全部会话的用量画像（模型、项目规模、成本），所以「谁能读到」这件事全靠这一个
 * 判据。在此之前 `grep -rn screenRequest test/` **零命中**——也就是说把判据改成
 * `const ok = true`（无条件放行）不会有任何测试变红，局域网里的其他机器就能直接
 * 读到本机画像。
 *
 * ## 口径：只放行精确回环地址
 *
 * 判据是三个字面量的**精确匹配**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），
 * 不是 `127.0.0.0/8` 网段匹配，也不是 `startsWith("::ffff:127.")` 这类前缀匹配。
 * 因此 `127.0.0.2` 被拒是**有意为之**，不是漏网之鱼：Linux 上 `127.0.0.0/8` 整个
 * 网段都可路由到本机，但真正会出现在 `socket.remoteAddress` 上的回环取值就是上面
 * 三个；放行整段反而会让「peer 是判据」这句话失去意义。
 *
 * 最危险的边界是 IPv4-mapped 地址：`::ffff:127.0.0.1` 要放行，而
 * `::ffff:192.168.1.9` 必须拒绝。两者只差中间几段，任何「前缀匹配 `::ffff:127.`」
 * 或「包含 `127.0.0.1`」的写法都会把局域网地址误判成本机——下面的用例专门钉死它。
 *
 * 全部用例都是纯函数调用（注入 `{socket:{remoteAddress}}`），零 I/O、零网络、
 * 不起 HTTP server：这样变异 `screenRequest` 的判据就必然改变断言结果。
 *
 * @module usage-ledger/test/screen-request
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { screenRequest } from "../src/index.js";

/**
 * 造一个只带 peer 地址的请求。
 *
 * 真实请求里 `screenRequest` 只读 `req.socket.remoteAddress`，所以这就是它需要的
 * 全部输入。
 *
 * @param remoteAddress - 对端地址，形状与 Node 给出的一致。
 * @returns 最小请求对象。
 */
function reqFrom(remoteAddress) {
	return { socket: { remoteAddress } };
}

/**
 * 断言某个请求被闸门拒绝，并顺带检查 403 载荷的形状。
 *
 * @param req - 待测请求。
 * @param label - 出现在失败信息里的可读描述。
 */
function assertForbidden(req, label) {
	const res = screenRequest(req);
	assert.notEqual(res, undefined, `${label} 必须被拒绝：闸门只放行精确回环地址，放行即等于把本机用量画像暴露出去。`);
	assert.equal(res.status, 403, `${label} 的拒绝状态码必须是 403。`);
	assert.deepEqual(res.body, { ok: false, error: "forbidden" }, `${label} 的拒绝载荷形状必须固定。`);
}

test("回环闸门：三个精确回环地址放行（127.0.0.1 / ::1 / ::ffff:127.0.0.1）", () => {
	for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
		assert.equal(
			screenRequest(reqFrom(peer)),
			undefined,
			`${peer} 是本机回环，必须放行；其中 ::ffff:127.0.0.1 是双栈监听下最常见的回环取值，丢了这一条就会把本机自己也挡在门外。`,
		);
	}
});

test("回环闸门：局域网地址 192.168.1.9 被拒（接口会暴露本机全部会话画像）", () => {
	assertForbidden(reqFrom("192.168.1.9"), "局域网地址 192.168.1.9");
});

test("回环闸门：公网地址 203.0.113.7 被拒", () => {
	assertForbidden(reqFrom("203.0.113.7"), "公网地址 203.0.113.7");
});

test("回环闸门：IPv4-mapped 的非回环地址 ::ffff:192.168.1.9 必须被拒（前缀匹配会误放行）", () => {
	// 这是最容易被写错的一条：它与 ::ffff:127.0.0.1 共享 "::ffff:" 前缀，
	// 任何按前缀/子串判断「是不是回环」的写法都会把局域网地址当成本机。
	assertForbidden(reqFrom("::ffff:192.168.1.9"), "IPv4-mapped 的局域网地址 ::ffff:192.168.1.9");
	// 同理：mapped 的 127.0.0.0/8 内非回环取值也不在放行名单里。
	assertForbidden(reqFrom("::ffff:127.0.0.2"), "IPv4-mapped 的 ::ffff:127.0.0.2");
});

test("回环闸门：127.0.0.2 被拒——只认精确回环地址，不做 127.0.0.0/8 网段匹配（有意为之）", () => {
	// 注意：这条是**拍板结论**，不是缺陷。判据是三个字面量的精确匹配；
	// 一旦有人把它「修正」成网段匹配，本用例就会变红，从而把口径变化摆到台面上。
	assertForbidden(reqFrom("127.0.0.2"), "同网段但非精确回环的 127.0.0.2");
});

test("回环闸门：缺少 peer 信息的请求一律被拒（{} / {socket:{}} / {socket:null} / undefined / null）", () => {
	const missing = [
		[{}, "空对象 {}"],
		[{ socket: {} }, "没有 remoteAddress 的 {socket:{}}"],
		[{ socket: null }, "{socket:null}"],
		[undefined, "undefined"],
		[null, "null"],
	];

	for (const [req, label] of missing) {
		// 取不到 peer 时实现把它当空串，空串不匹配任何回环字面量 → 拒绝。
		// 这里必须「默认拒绝」：拿不准来源时放行，等于把边界交给请求方决定。
		assertForbidden(req, `取不到 peer 的 ${label}`);
	}
});

test("回环闸门：403 载荷形状固定为 {status:403, body:{ok:false, error:\"forbidden\"}}", () => {
	const res = screenRequest(reqFrom("192.168.1.9"));

	// 客户端靠 status 与 body.error 渲染「禁止访问」，形状漂移会让面板静默失败。
	assert.deepEqual(res, { status: 403, body: { ok: false, error: "forbidden" } });
	assert.deepEqual(
		Object.keys(res).sort(),
		["body", "status"],
		"拒绝结果只有 status 与 body 两个字段，不得混入调试信息（peer 地址不该回显给请求方）。",
	);
	assert.deepEqual(
		Object.keys(res.body).sort(),
		["error", "ok"],
		"body 只有 ok 与 error 两个字段。",
	);
});
