/**
 * 推荐规则 `suggestModels` 的测试（ADR-0008 §3 / 规格 D5）。
 *
 * ## 这个文件存在的理由
 *
 * 「推荐」是本次功能里**唯一会诱导用户改数据**的东西：点一下「认领为 X」，写进
 * overrides 的就是一个价格。所以推荐错一次，代价是**静默算错钱**。而错的形态很具体：
 *
 * - `claude-opus-5-5`（4/20）与 `claude-opus-5`（5/25）名字极像，输入输出**都贵 25%**；
 * - `qwen3.8-max-0902` 与 `qwen3.8-max` 在运行时表里是**两行**；
 * - `qwen3.8-max-prime`（24/72）与 `qwen3.8-max`（12/36）只差一个词，价差 100%。
 *
 * 任何「去日期后缀」「剥尾部数字」「编辑距离」的实现都会把前两组并成一行，而面板
 * 不会有任何提示。下面每条禁止项都配了**实测反例**的断言，不是文档性注释。
 *
 * ## 为什么 runtime 表用内联构造而不是读 `$DSH_HOME`
 *
 * 规格里若干断言引用运行时表才有的行（`qwen3.8-max-*`、`Doubao-Seed-2.1-Pro`）。
 * 那份表是**本机数据**：CI 上没有它，读它就等于让这些断言静默变成「跳过」——
 * 而「没跑」与「通过了」是两回事。所以需要的行显式写进下面的 `runtimeLike*`。
 * 仓库表（`usage-ledger-pricing.json`）在仓库里，可以放心读：它是分发用的底表。
 *
 * @module usage-ledger/test/suggest
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MAX_SUGGESTIONS, suggestModels } from "../src/index.js";

/** 仓库底表（在仓库里，不是本机数据）。 */
const REPO_TABLE = JSON.parse(await readFile(new URL("../usage-ledger-pricing.json", import.meta.url), "utf8"));
const REPO_MODELS = REPO_TABLE.models ?? REPO_TABLE;
const REPO_ALIASES = REPO_TABLE.aliases ?? {};

/**
 * 一份「形状与运行时表一致」的内联 fixture。
 *
 * 只写断言真正需要的那几行。行内容照抄实测值（`qwen3.8-max` 12/36/1.5/15 CNY、
 * `-prime` 24/72、`doubao-seed-2.1-pro`），这样反例的价格差是真的。
 */
const RUNTIME_LIKE_MODELS = {
	"qwen3.8-max": { input: 12, output: 36, cacheRead: 1.5, cacheWrite: 15, currency: "CNY" },
	"qwen3.8-max-0902": { input: 12, output: 36, cacheRead: 1.5, cacheWrite: 15, currency: "CNY" },
	"qwen3.8-max-prime": { input: 24, output: 72, cacheRead: 3, cacheWrite: 30, currency: "CNY" },
	"doubao-seed-2.1-pro": { input: 1, output: 2, currency: "CNY" },
	"deepseek-flash": { input: 2, output: 8, currency: "CNY" },
	"deepseek-v4-flash": { input: 2, output: 8, currency: "CNY" },
};

/**
 * 运行时表的别名 fixture。
 *
 * 关键是那两组**折叠撞键**：`deepseek-v4.1-flash` / `DeepSeek-V4.1-Flash` 与
 * `deepseek-v4-flash` / `DeepSeek-V4-Flash`（实测运行时表里各有一组，仓库表 0 组）。
 * 它们证明「取遍历到的第一个」这种实现会给出依赖键序的结果。
 */
const RUNTIME_LIKE_ALIASES = {
	"DeepSeek-V4.1-Flash": "deepseek-flash",
	"deepseek-v4.1-flash": "deepseek-flash",
	"deepseek-v4.1-flash-sg": "deepseek-flash",
	"Doubao-Seed-2.1-Pro": "doubao-seed-2.1-pro",
	"deepseek-v4-flash-0731": "deepseek-v4-flash",
};

/**
 * 只含 `deepseek-flash` 一行的最小模型表。
 *
 * ## 为什么这几条 R3 用例**不再**用仓库底表
 *
 * 2026-10-03 定价表扩容（76 → 147 模型、20 → 27 别名）后，仓库底表里**也有了**
 * `deepseek-v4.1-flash` / `DeepSeek-V4.1-Flash` / `deepseek-v4.1-flash-sg` /
 * `DeepSeek-V4-Flash` 这几个别名键。于是原先那几条用例的输入从「查无此 id」
 * 变成了「命中真别名」——它们**依赖底表恰好没有这些键**这个偶然事实，一旦底表
 * 变富就集体变红（实测 4 条）。
 *
 * 这与「测试不得读 `$DSH_HOME`」是同一类教训：**fixture 要显式写出来，不能靠
 * 环境的偶然内容**。所以下面这几条改用本表构造，底表只用于「真数据兼容性」那一类
 * 断言（见文件末尾的向后兼容用例）。
 */
const MINIMAL_MODELS = {
	"deepseek-flash": { input: 2, output: 8, currency: "CNY" },
};

/** 与 {@link MINIMAL_MODELS} 配套的别名 fixture，覆盖 R3 与折叠撞键两种形态。 */
const MINIMAL_ALIASES = {
	"deepseek-v4.1-flash": "deepseek-flash",
	"DeepSeek-V4.1-Flash": "deepseek-flash",
};

/**
 * 断言一组建议满足全部结构性不变量（规格 A34）。
 *
 * @param suggestions - {@link suggestModels} 的结果。
 * @param models - 合并后的模型表。
 * @param label - 出现在失败信息里的场景描述。
 */
function assertShape(suggestions, models, label) {
	assert.ok(suggestions.length <= MAX_SUGGESTIONS, `${label}：建议条数不得超过 ${MAX_SUGGESTIONS}`);
	const seen = new Set();
	for (const suggestion of suggestions) {
		assert.ok(
			Object.hasOwn(models, suggestion.model),
			`${label}：建议了 \`${suggestion.model}\`，它不是合并后 models 的自有键。` +
				"面板点一下就会写出一个**死别名**——那个 id 永远算不出钱，且不会有任何报错。",
		);
		assert.ok(
			[0.8, 0.9, 1].includes(suggestion.score),
			`${label}：\`${suggestion.model}\` 的 score 是 ${suggestion.score}，不在 {0.8, 0.9, 1} 里。` +
				"分数只表达**规则的确定性**，不是相似度——出现别的取值说明混进了打分逻辑。",
		);
		assert.ok(
			typeof suggestion.reason === "string" && suggestion.reason !== "",
			`${label}：\`${suggestion.model}\` 没有 reason。ADR-0008 要求每条推荐都能解释自己，` +
				"空理由会让确认框变成一个没有依据的按钮。",
		);
		assert.equal(seen.has(suggestion.model), false, `${label}：\`${suggestion.model}\` 出现了两次`);
		seen.add(suggestion.model);
	}
}

test("推荐：只做可解释的归一化——R2 大小写折叠给出「仅大小写不同」", () => {
	const suggestions = suggestModels("Doubao-Seed-2.1-Pro", { models: RUNTIME_LIKE_MODELS, aliases: RUNTIME_LIKE_ALIASES });

	assert.deepEqual(
		suggestions.map((entry) => entry.model),
		["doubao-seed-2.1-pro"],
		"R2 必须给出折叠后同名的那个模型",
	);
	assert.equal(suggestions[0].score, 1, "R2 的分数是 1");
	assert.equal(suggestions[0].reason, "仅大小写不同（doubao-seed-2.1-pro）", "R2 的理由模板必须逐字一致，面板要原样展示");
	assertShape(suggestions, RUNTIME_LIKE_MODELS, "R2");
});

test("推荐：R2 与 R3 同时命中同一目标时只留一条，且保留 R2 的理由（分高者优先）", () => {
	// `Doubao-Seed-2.1-Pro` 既是模型键的折叠同名（R2，1 分），又是一个别名键
	// （R3，0.8 分，目标同为 `doubao-seed-2.1-pro`）。两条规则指向同一目标时**必须合并**：
	// 面板上出现两行「认领为同一个模型」会让人以为是两个不同的选择。
	const suggestions = suggestModels("Doubao-Seed-2.1-Pro", { models: RUNTIME_LIKE_MODELS, aliases: RUNTIME_LIKE_ALIASES });

	assert.equal(suggestions.length, 1, "同一目标只能有一条建议");
	assert.equal(suggestions[0].score, 1, "合并后取**最高分**那条（R2 的 1 分）");
	assert.equal(suggestions[0].reason, "仅大小写不同（doubao-seed-2.1-pro）", "合并后保留分高那条的 reason");
});

test("推荐：R1 去掉命名空间前缀后同名", () => {
	const suggestions = suggestModels("relay-x/deepseek-flash", { models: RUNTIME_LIKE_MODELS, aliases: {} });

	assert.deepEqual(suggestions.map((entry) => entry.model), ["deepseek-flash"]);
	assert.equal(suggestions[0].score, 0.9, "R1 的分数是 0.9");
	assert.equal(suggestions[0].reason, "去掉命名空间前缀后与 deepseek-flash 同名");
});

test("推荐：R3 走已知别名的反向映射（ADR 自己的例子，但走的是 R3 不是 R1）", () => {
	// ADR-0008 §3 的例子是 `deepseek/DeepSeek-V4.1-Flash → deepseek-v4.1-flash`。
	// 但 `deepseek-v4.1-flash` 是**别名键、不是模型行**（实测两张表都如此），所以照
	// ADR 字面写 R1 会得到**空建议**。正确答案是走 R3、目标是 `deepseek-flash`。
	//
	// 用 MINIMAL_* 而不是仓库底表：底表在 2026-10-03 扩容后**也**含这些键，用它就
	// 测不出「R3 而非 R1」这件事了（两者会同时命中，分不出是哪条规则给的答案）。
	assert.equal(
		Object.hasOwn(MINIMAL_MODELS, "deepseek-v4.1-flash"),
		false,
		"前置事实：`deepseek-v4.1-flash` 不是模型行——否则 R1 也会命中，本条就分不出 R3",
	);

	const suggestions = suggestModels("deepseek/DeepSeek-V4.1-Flash", { models: MINIMAL_MODELS, aliases: MINIMAL_ALIASES });

	assert.deepEqual(suggestions.map((entry) => entry.model), ["deepseek-flash"], "R3 应给出别名 `deepseek-v4.1-flash` 的目标");
	assert.equal(suggestions[0].score, 0.8, "R3 的分数是 0.8（已知别名是最弱的证据）");
	// 输入尾部逐字符等于**大写版**别名键，所以 reason 里必须原样写它——这正是
	// 「折叠撞键取逐字符相等的那个」这条规则在起作用（两条别名指向同一目标，折叠后
	// 无从区分，只有逐字符比较能定下来）。面板要把这个名字原样展示给用户。
	assert.equal(suggestions[0].reason, "已有别名 DeepSeek-V4.1-Flash → deepseek-flash");
	assertShape(suggestions, MINIMAL_MODELS, "R3");
});

test("推荐：只凭「前缀像」不许猜——查无此 id 时返回空数组", () => {
	// `deepseek-v4.1-flash-sg` 在这份 fixture 里既不是模型行也不是别名键。它与
	// `deepseek-v4.1-flash` 共享前缀，但那不是证据：猜错就是把另一个模型的价格套上来。
	//
	// 注意：仓库底表在 2026-10-03 扩容后**确实**含 `deepseek-v4.1-flash-sg` 这个别名
	// （它是新加坡区变体，已确认与主区同价）。所以这条必须用不含它的 fixture 来测
	// 「查无此 id」这个**规则边界**——用底表测的会是另一件事（命中真别名）。
	const suggestions = suggestModels("deepseek-v4.1-flash-sg", { models: MINIMAL_MODELS, aliases: MINIMAL_ALIASES });

	assert.deepEqual(suggestions, [], "前缀相同不是同一模型：不得凭「像」猜一个");
});

test("推荐：折叠撞键时取逐字符相等的键，而不是「遍历到的第一个」", () => {
	// 实测运行时表的别名键里有 2 组折叠撞键。若实现取「遍历到的第一个」或「localeCompare
	// 最小的那个」，结果就与用户输入脱钩：同一份数据换个顺序、或换一个平台的大小写排序，
	// 就会给出不同的别名名——而那个名字要**原样展示**给用户（`reason` 里的 `<aliasKey>`）。
	//
	// 两个方向都断言，是本条**不依赖平台 ICU 排序**的关键：`localeCompare` 对大小写
	// 的先后在 Windows 与 Linux 上未必一致，但无论它偏向哪一边，「逐字符相等的那个」
	// 只有一个；所以只要输入大写版与大写版之外的那个，至少有一个方向会抓住退化实现。
	const aliases = { "DeepSeek-V4.1-Flash": "deepseek-flash", "deepseek-v4.1-flash": "deepseek-flash" };

	const upper = suggestModels("relayX/DeepSeek-V4.1-Flash", { models: RUNTIME_LIKE_MODELS, aliases });
	assert.equal(upper.length, 1, "大写版的尾部正好等于一个别名键，应当命中 R3");
	assert.equal(
		upper[0].reason,
		"已有别名 DeepSeek-V4.1-Flash → deepseek-flash",
		"输入 `DeepSeek-V4.1-Flash` 时必须挑出**逐字符相等**的那个别名键，而不是折叠后碰巧排在前面的另一个",
	);

	const lower = suggestModels("relayX/deepseek-v4.1-flash", { models: RUNTIME_LIKE_MODELS, aliases });
	assert.equal(lower.length, 1);
	assert.equal(
		lower[0].reason,
		"已有别名 deepseek-v4.1-flash → deepseek-flash",
		"输入 `deepseek-v4.1-flash` 时必须挑出逐字符相等的那个",
	);

	// 删掉其中一个键后结果必须稳定（同一入参调两次深等）：证明挑选不依赖对象键的插入顺序。
	const onlyLower = { "deepseek-v4.1-flash": "deepseek-flash" };
	const once = suggestModels("relayX/DeepSeek-V4.1-Flash", { models: RUNTIME_LIKE_MODELS, aliases: onlyLower });
	assert.deepEqual(
		suggestModels("relayX/DeepSeek-V4.1-Flash", { models: RUNTIME_LIKE_MODELS, aliases: onlyLower }),
		once,
		"同一入参调两次必须深等",
	);
	assert.equal(once[0].reason, "已有别名 deepseek-v4.1-flash → deepseek-flash", "只剩一个键时就用它");
});

test("推荐：R2 与 R1 同分指向同一目标时只出现一次", () => {
	// 用显式 fixture：`DeepSeek-V4-Flash` 与模型行 `deepseek-v4-flash` 仅大小写不同（R2），
	// 同时它作为别名键的折叠形态也会命中（R1）——两条规则指向同一目标时必须合并成一条。
	//
	// 不用仓库底表：2026-10-03 扩容后底表里 `DeepSeek-V4-Flash` 是**指向 deepseek-flash
	// 的别名**（R3），那时 R2/R1 都命中不了 `deepseek-v4-flash`，本条就测不到合并逻辑了。
	const models = {
		"deepseek-v4-flash": { input: 2, output: 8, currency: "CNY" },
	};
	const aliases = { "DeepSeek-V4-Flash": "deepseek-v4-flash" };

	const suggestions = suggestModels("DeepSeek-V4-Flash", { models, aliases });

	assert.deepEqual(suggestions.map((entry) => entry.model), ["deepseek-v4-flash"], "R2 与 R1 指向同一目标，合并成一条");
	assert.equal(suggestions[0].score, 1, "保留分高的 R2");
	assertShape(suggestions, models, "R2+R1 合并");
});

test("推荐边界：claude-opus-5-5 绝不推荐给 claude-opus-5（价差 25% 的反例）", () => {
	// 这是 ADR-0008 验收第 2 条。两个模型名字极像，但输入 4/20 vs 5/25 USD——
	// 一旦被「剥尾部数字」并成一行，官方价折算会**静默高估 25%**。
	assert.equal(REPO_MODELS["claude-opus-5-5"].input, 4, "前置事实：opus 5.5 输入价 4");
	assert.equal(REPO_MODELS["claude-opus-5"].input, 5, "前置事实：opus 5 输入价 5");
	assert.equal(REPO_MODELS["claude-opus-5"].input / REPO_MODELS["claude-opus-5-5"].input, 1.25, "前置事实：输入价差 25%");
	assert.equal(REPO_MODELS["claude-opus-5"].output / REPO_MODELS["claude-opus-5-5"].output, 1.25, "前置事实：输出价差也是 25%");

	const fromNewer = suggestModels("claude-opus-5-5", { models: REPO_MODELS, aliases: {} });
	assert.equal(
		fromNewer.some((entry) => entry.model === "claude-opus-5"),
		false,
		"`claude-opus-5-5` 被推荐给了 `claude-opus-5`：这正是「剥尾部数字」的形态，会静默高估 25% 的官方价折算。",
	);

	const fromOlder = suggestModels("claude-opus-5", { models: REPO_MODELS, aliases: {} });
	assert.equal(fromOlder.some((entry) => entry.model === "claude-opus-5-5"), false, "反向同样不得推荐");
});

test("推荐边界：qwen3.8-max 家族三行互不推荐（日期后缀反例）", () => {
	// 实测运行时表里 `qwen3.8-max` 与 `qwen3.8-max-0902` **并存**（当前同价），
	// `qwen3.8-max-prime` 则是 24/72——只差一个词，价差 100%。
	assert.equal(RUNTIME_LIKE_MODELS["qwen3.8-max-prime"].input / RUNTIME_LIKE_MODELS["qwen3.8-max"].input, 2, "前置事实：prime 贵一倍");

	for (const [probe, forbidden] of [
		["qwen3.8-max-0902", "qwen3.8-max"],
		["qwen3.8-max", "qwen3.8-max-0902"],
		["qwen3.8-max-prime", "qwen3.8-max"],
	]) {
		const suggestions = suggestModels(probe, { models: RUNTIME_LIKE_MODELS, aliases: RUNTIME_LIKE_ALIASES });
		assert.equal(
			suggestions.some((entry) => entry.model === forbidden),
			false,
			`\`${probe}\` 被推荐给了 \`${forbidden}\`：任何「去日期后缀 / 剥尾部数字」的实现都会这样并，` +
				"而它们是定价表里**两行**，并起来会掩盖真实价差（prime 与 max 差 100%）。",
		);
	}
});

test("推荐边界：自指建议必须过滤（认领成自己什么也修不了）", () => {
	// 实测仓库表的 `cline-free/muse-spark-1.3-contributor` 既是模型行、又有一个同名别名
	// 指向它自己：R2 与 R3 都会原样建议回它自己。
	const suggestions = suggestModels("cline-free/muse-spark-1.3-contributor", { models: REPO_MODELS, aliases: REPO_ALIASES });

	assert.deepEqual(suggestions, [], "「认领成自己」是一条无操作建议，不该出现在面板上");
});

test("推荐：每个返回值都是合并后 models 的自有键，条数 ≤ 3，分数只有三档", () => {
	const cases = [
		["Doubao-Seed-2.1-Pro", RUNTIME_LIKE_MODELS, RUNTIME_LIKE_ALIASES],
		["deepseek/DeepSeek-V4.1-Flash", REPO_MODELS, REPO_ALIASES],
		["DeepSeek-V4-Flash", REPO_MODELS, REPO_ALIASES],
		["relayX/deepseek-v4.1-flash", RUNTIME_LIKE_MODELS, RUNTIME_LIKE_ALIASES],
		["claude-opus-5-5", REPO_MODELS, REPO_ALIASES],
		["cline-free/muse-spark-1.3-contributor", REPO_MODELS, REPO_ALIASES],
	];

	for (const [probe, models, aliases] of cases) {
		assertShape(suggestModels(probe, { models, aliases }), models, probe);
	}
});

test("推荐：纯函数——同一入参调两次深等，且不修改入参", () => {
	const models = structuredClone(RUNTIME_LIKE_MODELS);
	const aliases = structuredClone(RUNTIME_LIKE_ALIASES);
	const before = JSON.stringify({ models, aliases });

	const first = suggestModels("Doubao-Seed-2.1-Pro", { models, aliases });
	const second = suggestModels("Doubao-Seed-2.1-Pro", { models, aliases });

	assert.deepEqual(first, second, "同一入参必须给出同一结果（否则面板刷新一次建议就变）");
	assert.equal(JSON.stringify({ models, aliases }), before, "suggestModels 不得修改入参");
});

test("推荐：仓库底表的 27 条字符串别名全部能被反向使用（向后兼容）", () => {
	// 仓库表的别名值**全是字符串**（实测 27/27）。规范化的正确形式是「值统一成对象」，
	// 但 `suggestModels` 必须同时吃得下字符串与对象两种形态——否则主表的别名在推荐里
	// 全部失效，而面板会安静地少掉一批最该出现的建议。
	//
	// 这个数字**故意写死**：底表变了就必须有人来复核覆盖面。
	// 2026-10-03 由 20 改为 27——定价表扩容（76 → 147 模型）时新增了 7 条渠道专有别名。
	const keys = Object.keys(REPO_ALIASES);
	assert.equal(keys.length, 27, `仓库底表的别名条数变了（${keys.length}），这条兼容性断言的覆盖面要跟着复核`);
	for (const key of keys) {
		assert.equal(typeof REPO_ALIASES[key], "string", `仓库表别名 \`${key}\` 的值不是字符串`);
	}

	// 反向用法：把别名键当成「新出现的 id」来问，目标应被推出来。
	for (const [aliasKey, target] of [
		// 2026-10-03：`deepseek-v4-flash` 已作为「旧名，已下线」删除（官方说明该 id 的
		// 请求由 V4.1-Flash 接管、按 Flash 价计费），`-0731` 这个快照别名随之重指向
		// `deepseek-flash`。期望值同步跟进。
		["deepseek-v4-flash-0731", "deepseek-flash"],
		["sn-deepseek-v4-1-flash", "deepseek-flash"],
		["gemini-3.7-flash-high", "gemini-3.7-flash"],
		// 2026-10-03 扩容新增的别名也要能被反向使用。
		["deepseek-v4.1-flash-sg", "deepseek-flash"],
		["Doubao-Seed-2.1-Pro", "doubao-seed-2.1-pro"],
	]) {
		const suggestions = suggestModels(`relay-y/${aliasKey}`, { models: REPO_MODELS, aliases: REPO_ALIASES });
		assert.ok(
			suggestions.some((entry) => entry.model === target),
			`带命名空间前缀的别名键 \`${aliasKey}\` 应被 R3 认出来并推荐 \`${target}\`，实得 ${JSON.stringify(suggestions)}`,
		);
	}

	// 对象形态的别名同样要能用（overrides 写的就是对象，`normalizeAliasMap` 之后
	// `suggestModels` 拿到的就是对象）。字符串那一支与对象这一支必须给出同一个答案。
	const asObjects = { "relay-z/deepseek-v4.1-flash": { model: "deepseek-flash" } };
	const fromObject = suggestModels("relay-z/deepseek-v4.1-flash", { models: REPO_MODELS, aliases: asObjects });
	const fromString = suggestModels("relay-z/deepseek-v4.1-flash", { models: REPO_MODELS, aliases: { "relay-z/deepseek-v4.1-flash": "deepseek-flash" } });

	assert.deepEqual(
		fromObject.map((entry) => entry.model),
		["deepseek-flash"],
		"对象形态的别名（overrides 的格式）必须与字符串形态一样能被反向使用",
	);
	assert.deepEqual(fromObject, fromString, "两种别名形态必须给出逐字段相同的结果");
});
